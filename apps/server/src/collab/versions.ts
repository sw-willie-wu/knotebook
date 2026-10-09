/**
 * 筆記版本歷史：每篇載入中筆記的切版狀態與切版（spec 2026-10-09-note-versions-design.md §4.5、§5、§7-2d、§9、§10.2）。
 * hook 接線在 `collab/server.ts`（Task 6）；AI 寫入前切版在 `notes/editing/apply.ts` 的 `preWriteCut`（Task 7）；套用在
 * `notes/editing/apply-version.ts`（Task 8）。⚠ 狀態只在這個 process 的記憶體（同 `NoteWriteQueue`）。
 *
 * 狀態來源（`resolve`）：Map 有條目 → 用它（必須 `initialized`）；Map 沒有但文件已載入（§9 空窗期）→ uninitialized；
 * 文件沒載入 → 呼叫端給的 `transient` doc 建暫時狀態（`loadFingerprint` 就是它自己的指紋），用完即丟、不進 Map。
 */
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_IDLE_MS, VERSION_KEEP_ALL_DAYS_DEFAULT, YDOC_FRAGMENT, type VersionCurrentDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groups, noteStates, noteVersions, notes, siteSettings, users } from "../db/schema.js";
import type { DirectCtx } from "../notes/editing/session.js";
import { UUID_RE } from "../notes/service.js";
import { VersionCutAbort, cutVersionInTx, notBaseVersionSql, spaceKeyOf, type CutVersionInput, type NoteVersionRow, type VersionEditorJson } from "../notes/tx/versions.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../notes/version-fingerprint.js";
import { selectVersionsToDelete } from "./version-policy.js";

const DAY_MS = 86_400_000;
export const VERSION_SWEEP_BATCH = 100;
export const VERSION_SWEEP_INTERVAL_MS = 60 * 60_000;
export const VERSION_SWEEP_FIRST_DELAY_MS = 5 * 60_000;
const PRUNE_DELETE_CHUNK = 1000;
/** 從 onLoadDocument 進來的 noteLoaded 比對失敗時重來的上限（只有 §9 的 forget 會造成失敗，r7 實跑）。 */
const NOTE_LOADED_MAX_ATTEMPTS = 5;

export interface VersionEditor {
  userId: string;
  agentLabel: string | null;
}
export type CutSkip = "uninitialized" | "applying" | "auto-disabled" | "fingerprint-failed" | "note-deleted";
export type CutResult = { row: NoteVersionRow; upgraded: boolean } | null | { skipped: CutSkip };
export interface CutOptions {
  kind: "auto" | "manual";
  name?: string | null;
  extraEditors?: VersionEditor[];
  /** 文件沒載入時呼叫端自己讀出的 doc（§5.4 的 fork、§6.1／§6.3 讀 note_states 的 doc）。 */
  transient?: Y.Doc;
}
/** Hocuspocus 實例結構上符合（`documents` 是 `Map<string, Document>`）；測試注入假 host。 */
export interface VersionDocsHost {
  documents: { get(name: string): Y.Doc | undefined; has(name: string): boolean };
}
export interface VersionTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export interface VersionServiceDeps {
  db: Db;
  log: { warn(obj: object, msg: string): void };
  now?: () => Date;
  /** A12：預設 `VERSION_IDLE_MS`（5 分鐘）。 */
  idleMs?: number;
  /** 測試注入手動觸發的計時器；預設 setTimeout（unref）。 */
  timers?: VersionTimers;
  /**
   * 測試注入縫（生產不注入＝零成本）。`afterMetaRead`：`resolve()` 的「文件沒載入」路徑讀完 `readVersionMeta`、回傳暫時狀態之前
   * （即 `cutIfDirty` 進 `cutVersionInTx` 之前）——`versions-matrix.test.ts` 在這裡設 barrier，讓並發切版全部帶同一份舊基底進交易。
   */
  testHooks?: { afterMetaRead?: (noteId: string) => Promise<void> };
}
export interface VersionMeta {
  baseSeq: number | null;
  baseFingerprint: string | null;
  counter: number;
  spaceKey: string;
  autoEnabled: boolean;
}
export interface VersionStateSnapshot {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  editors: VersionEditor[];
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
  hasTimer: boolean;
}

interface NoteVersionState {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  editors: Map<string, VersionEditor>;
  idleTimer: unknown;
  timerCut: Promise<unknown> | null;
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
}

export interface VersionService {
  bind(host: VersionDocsHost): void;
  noteLoaded(noteId: string, doc: Y.Doc, opts?: { rerun?: boolean }): Promise<void>;
  noteChanged(noteId: string, who: VersionEditor): void;
  forget(noteId: string): void;
  relocated(noteIds: string[]): void;
  isDirty(noteId: string, doc: Y.Doc, transient?: Y.Doc): Promise<boolean>;
  cutIfDirty(noteId: string, doc: Y.Doc, opts: CutOptions): Promise<CutResult>;
  beginApply(noteId: string): void;
  endApply(noteId: string, r?: { seq: number; fingerprint: string } | { reset: true }): void;
  docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }>;
  currentOf(noteId: string): Promise<VersionCurrentDto | null>;
  pruneNote(noteId: string, now?: Date): Promise<number>;
  sweep(now: Date): Promise<number>;
  debugState(noteId: string): VersionStateSnapshot | undefined;
  /** §5.2：onStoreDocument 之後（server.ts await 它，受 saveMutex 保護）。 */
  noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void>;
  /** §5.2：beforeUnloadDocument。先等進行中的計時器切版（起草裁定 6）。 */
  beforeUnload(noteId: string, doc: Y.Doc): Promise<void>;
  /** 關機：清掉所有計時器。 */
  close(): void;
}

const realTimers: VersionTimers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** A13 生效值與基底；筆記不存在回 null。noteId 非 UUID 也回 null（documentName 由 client 指定）。 */
export async function readVersionMeta(db: Db, noteId: string): Promise<VersionMeta | null> {
  if (!UUID_RE.test(noteId)) return null;
  const [r] = await db
    .select({
      baseSeq: notes.versionBaseSeq,
      baseFingerprint: notes.versionBaseFingerprint,
      counter: notes.versionCounter,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      userAuto: users.autoVersions,
      groupAuto: groups.autoVersions,
      siteAuto: siteSettings.autoVersionsEnabled,
    })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(eq(notes.id, noteId))
    .limit(1);
  if (!r) return null;
  const spaceAuto = r.ownerId !== null ? r.userAuto : r.groupAuto;
  return { baseSeq: r.baseSeq, baseFingerprint: r.baseFingerprint, counter: r.counter, spaceKey: spaceKeyOf(r), autoEnabled: r.siteAuto !== false && spaceAuto === true };
}

/** §7-2d：套用成功後把基底指向該版——只在那一版還在時（`EXISTS`）。回 true＝1 列。 */
export async function setVersionBase(db: Db, noteId: string, seq: number, fingerprint: string): Promise<boolean> {
  const updated = await db
    .update(notes)
    .set({ versionBaseSeq: seq, versionBaseFingerprint: fingerprint })
    .where(and(eq(notes.id, noteId), sql`exists (select 1 from note_versions v where v.note_id = ${noteId} and v.seq = ${seq})`))
    .returning({ id: notes.id });
  return updated.length === 1;
}

/** §7-2d 的 0 列／指紋算不出來分支：基底清空。 */
export async function clearVersionBase(db: Db, noteId: string): Promise<void> {
  await db.update(notes).set({ versionBaseSeq: null, versionBaseFingerprint: null }).where(eq(notes.id, noteId));
}

const editorKey = (e: VersionEditor): string => JSON.stringify([e.userId, e.agentLabel]);

function toEditorsJson(list: VersionEditor[]): VersionEditorJson[] {
  const seen = new Set<string>();
  const out: VersionEditorJson[] = [];
  for (const e of list) {
    const k = editorKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ user_id: e.userId, agent_label: e.agentLabel });
  }
  return out;
}

function safeFingerprint(doc: Y.Doc): string | null {
  try {
    return versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT));
  } catch {
    return null;
  }
}

/** §5.3-2 的 dirty 規則（不看 applying）。 */
function dirtyOf(s: Pick<NoteVersionState, "baseFingerprint" | "loadFingerprint">, fp: string): boolean {
  if (s.baseFingerprint !== null) return fp !== s.baseFingerprint;
  return (s.loadFingerprint === null || fp !== s.loadFingerprint) && fp !== VACUUM_VERSION_FINGERPRINT;
}

export function createVersionService(deps: VersionServiceDeps): VersionService {
  const db = deps.db;
  const now = deps.now ?? ((): Date => new Date());
  const timers = deps.timers ?? realTimers;
  const idleMs = deps.idleMs ?? VERSION_IDLE_MS;
  const states = new Map<string, NoteVersionState>();
  const applyingSet = new Set<string>();
  const warnedUninitialized = new Set<string>();
  let host: VersionDocsHost | null = null;
  let sweepCursor: string | null = null;
  let sweeping = false;

  const blankState = (noteId: string): NoteVersionState => ({
    initialized: false, autoEnabled: false, spaceKey: "", editors: new Map(), idleTimer: null, timerCut: null,
    loadFingerprint: null, baseFingerprint: null, applying: applyingSet.has(noteId),
  });

  function entryFor(noteId: string): NoteVersionState {
    let e = states.get(noteId);
    if (!e) {
      e = blankState(noteId);
      states.set(noteId, e);
    }
    return e;
  }

  function clearTimer(s: NoteVersionState): void {
    if (s.idleTimer !== null) {
      timers.clear(s.idleTimer);
      s.idleTimer = null;
    }
  }

  async function noteLoaded(noteId: string, doc: Y.Doc, opts: { rerun?: boolean } = {}): Promise<void> {
    for (let attempt = 0; attempt < NOTE_LOADED_MAX_ATTEMPTS; attempt += 1) {
      // §4.5：條目本身當令牌——開頭同步取得或建立 E，await 回來只有 Map.get(noteId) === E 才寫進 E（r6 C-1）。
      const e = entryFor(noteId);
      const loadFingerprint = safeFingerprint(doc); // 先同步抓，再 await 讀 DB
      const meta = await readVersionMeta(db, noteId);
      if (states.get(noteId) !== e) {
        if (opts.rerun) return; // §9 重跑那次：丟棄
        continue; // 從 onLoadDocument 進來：重來（r7 M-1）
      }
      if (meta === null) {
        // 筆記已刪（起草裁定 20）：自動一律 auto-disabled；手動在交易內得 note-deleted。
        Object.assign(e, { initialized: true, autoEnabled: false, spaceKey: "", loadFingerprint, baseFingerprint: null });
        return;
      }
      Object.assign(e, {
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, loadFingerprint,
        baseFingerprint: meta.baseFingerprint, applying: applyingSet.has(noteId),
      });
      return;
    }
    deps.log.warn({ noteId }, "版本狀態初始化重試次數用完（這個載入週期不切自動版本）");
  }

  function noteChanged(noteId: string, who: VersionEditor): void {
    const e = entryFor(noteId); // 文件已載入但 Map 沒條目（§9 空窗期）→ 建 initialized:false 條目再記
    const k = editorKey(who);
    if (!e.editors.has(k)) e.editors.set(k, who);
  }

  function forget(noteId: string): void {
    const s = states.get(noteId);
    if (s) clearTimer(s);
    states.delete(noteId);
    warnedUninitialized.delete(noteId);
  }

  function relocated(noteIds: string[]): void {
    for (const id of noteIds) {
      forget(id);
      const doc = host?.documents.get(id);
      if (!doc) continue;
      entryFor(id); // §9：立刻放 initialized:false 條目，空窗期的編輯者仍有地方記（r5 M-2）
      void noteLoaded(id, doc, { rerun: true }).catch(err => deps.log.warn({ err, noteId: id }, "搬移後重建版本狀態失敗"));
    }
  }

  type Resolved = { state: NoteVersionState; live: boolean } | "uninitialized" | "note-deleted";

  async function resolve(noteId: string, transient: Y.Doc | undefined): Promise<Resolved> {
    const s = states.get(noteId);
    if (s) return s.initialized ? { state: s, live: true } : "uninitialized";
    if (host?.documents.has(noteId)) return "uninitialized";
    if (!transient) return "uninitialized";
    const meta = await readVersionMeta(db, noteId);
    if (meta === null) return "note-deleted";
    if (deps.testHooks?.afterMetaRead) await deps.testHooks.afterMetaRead(noteId);
    return {
      live: false,
      state: {
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, editors: new Map(), idleTimer: null, timerCut: null,
        loadFingerprint: safeFingerprint(transient), baseFingerprint: meta.baseFingerprint, applying: applyingSet.has(noteId),
      },
    };
  }

  async function isDirty(noteId: string, doc: Y.Doc, transient?: Y.Doc): Promise<boolean> {
    const r = await resolve(noteId, transient);
    if (typeof r === "string") return true;
    const fp = safeFingerprint(doc);
    return fp === null ? true : dirtyOf(r.state, fp);
  }

  async function cutIfDirty(noteId: string, doc: Y.Doc, opts: CutOptions): Promise<CutResult> {
    const r = await resolve(noteId, opts.transient);
    if (r === "note-deleted") return { skipped: "note-deleted" };
    if (r === "uninitialized") {
      if (!warnedUninitialized.has(noteId)) {
        warnedUninitialized.add(noteId);
        deps.log.warn({ noteId }, "版本狀態尚未初始化，略過切版");
      }
      return { skipped: "uninitialized" };
    }
    const { state, live } = r;
    if (opts.kind === "auto") {
      if (state.applying) return { skipped: "applying" };
      if (!state.autoEnabled) return { skipped: "auto-disabled" };
    }
    const fp = safeFingerprint(doc);
    if (fp === null) {
      deps.log.warn({ noteId }, "版本指紋算不出來，略過切版");
      return { skipped: "fingerprint-failed" };
    }
    if (opts.kind === "auto" && !dirtyOf(state, fp)) return null;
    // 第 5 步只刪寫進這一版的那些鍵（起草裁定 5）。
    const written = [...state.editors.entries()];
    const input: CutVersionInput = {
      noteId,
      kind: opts.kind,
      name: opts.name ?? null,
      editors: toEditorsJson([...written.map(([, v]) => v), ...(opts.extraEditors ?? [])]),
      expectBaseFingerprint: state.baseFingerprint,
      expectSpaceKey: state.spaceKey,
      loadFingerprint: state.loadFingerprint,
      vacuumFingerprint: VACUUM_VERSION_FINGERPRINT,
      capture: () => ({ fp: versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT)), ydoc: Y.encodeStateAsUpdate(doc) }),
    };
    let out: Awaited<ReturnType<typeof cutVersionInTx>>;
    try {
      out = await db.transaction(tx => cutVersionInTx(tx, input));
    } catch (err) {
      if (!(err instanceof VersionCutAbort)) throw err;
      const reason = err.reason;
      if (reason.kind === "note-deleted") return { skipped: "note-deleted" };
      if (reason.kind === "fingerprint-failed") {
        deps.log.warn({ noteId, err: reason.cause }, "版本指紋算不出來，略過切版");
        return { skipped: "fingerprint-failed" };
      }
      if (reason.kind === "stale" && live && states.get(noteId) === state) {
        state.baseFingerprint = reason.baseFingerprint;
        state.spaceKey = reason.spaceKey;
      }
      return null;
    }
    if (live && states.get(noteId) === state) {
      state.baseFingerprint = out.fp;
      for (const [k] of written) state.editors.delete(k);
    }
    // 起草裁定 23：upgraded（基底轉手動、沒有新列）不清除——沒有新增列就沒有新工作。
    if (!out.upgraded) {
      try {
        await pruneNote(noteId);
      } catch (err) {
        deps.log.warn({ err, noteId }, "切版後清除舊版本失敗");
      }
    }
    return { row: out.row, upgraded: out.upgraded };
  }

  function beginApply(noteId: string): void {
    applyingSet.add(noteId);
    const s = states.get(noteId);
    if (s) s.applying = true;
  }

  function endApply(noteId: string, r?: { seq: number; fingerprint: string } | { reset: true }): void {
    applyingSet.delete(noteId);
    const s = states.get(noteId);
    if (!s) return;
    s.applying = false;
    if (r === undefined) return;
    if ("reset" in r) {
      s.baseFingerprint = null;
      s.loadFingerprint = null; // 「非真空就算有改」：下一刀依沒有基底的規則切
      return;
    }
    s.baseFingerprint = r.fingerprint;
    s.editors.clear();
    clearTimer(s);
  }

  async function docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }> {
    const live = host?.documents.get(noteId);
    if (live) return { doc: live };
    const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
    const doc = new Y.Doc();
    if (row) Y.applyUpdate(doc, row.ydoc);
    return { doc, transient: doc };
  }

  async function currentOf(noteId: string): Promise<VersionCurrentDto | null> {
    const meta = await readVersionMeta(db, noteId);
    if (meta === null) return null;
    const { doc, transient } = await docFor(noteId);
    const dirty = await isDirty(noteId, doc, transient);
    const s = states.get(noteId);
    return { baseSeq: meta.baseSeq, dirty, nextSeq: meta.counter + 1, autoEnabled: s?.initialized ? s.autoEnabled : meta.autoEnabled };
  }

  async function readDays(): Promise<{ keepAllDays: number; dailyUntilDays: number }> {
    const [r] = await db
      .select({ keepAllDays: siteSettings.versionKeepAllDays, dailyUntilDays: siteSettings.versionDailyUntilDays })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    return r ?? { keepAllDays: VERSION_KEEP_ALL_DAYS_DEFAULT, dailyUntilDays: VERSION_DAILY_UNTIL_DAYS_DEFAULT };
  }

  /** §10.2：不開交易（起草裁定 14）——DELETE 自帶 `kind='auto'` 與「不是基底」兩個述詞。回刪掉的列數。 */
  async function pruneNote(noteId: string, at: Date = now()): Promise<number> {
    const days = await readDays();
    const [note] = await db.select({ baseSeq: notes.versionBaseSeq }).from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!note) return 0;
    const rows = await db
      .select({ seq: noteVersions.seq, kind: noteVersions.kind, createdAt: noteVersions.createdAt })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const doomed = selectVersionsToDelete(rows, { now: at, keepAllDays: days.keepAllDays, dailyUntilDays: days.dailyUntilDays, baseSeq: note.baseSeq });
    let deleted = 0;
    for (let i = 0; i < doomed.length; i += PRUNE_DELETE_CHUNK) {
      const chunk = doomed.slice(i, i + PRUNE_DELETE_CHUNK);
      const gone = await db
        .delete(noteVersions)
        .where(and(
          eq(noteVersions.noteId, noteId),
          inArray(noteVersions.seq, chunk),
          eq(noteVersions.kind, "auto"),
          notBaseVersionSql(noteId),
        ))
        .returning({ seq: noteVersions.seq });
      deleted += gone.length;
    }
    return deleted;
  }

  /** §10.2：每輪最多 `VERSION_SWEEP_BATCH` 篇、游標續掃、一輪 0 筆就歸零。回「掃到幾篇」。同時只跑一輪。 */
  async function sweep(at: Date): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const days = await readDays();
      const cutoff = new Date(at.getTime() - days.keepAllDays * DAY_MS);
      const candidates = await db
        .selectDistinct({ noteId: noteVersions.noteId })
        .from(noteVersions)
        .where(and(eq(noteVersions.kind, "auto"), lt(noteVersions.createdAt, cutoff), sweepCursor === null ? undefined : gt(noteVersions.noteId, sweepCursor)))
        .orderBy(asc(noteVersions.noteId))
        .limit(VERSION_SWEEP_BATCH);
      if (candidates.length === 0) {
        sweepCursor = null;
        return 0;
      }
      for (const c of candidates) {
        try {
          await pruneNote(c.noteId, at);
        } catch (err) {
          deps.log.warn({ err, noteId: c.noteId }, "版本清除背景掃描：單篇失敗，繼續下一篇");
        }
      }
      sweepCursor = candidates[candidates.length - 1]!.noteId;
      return candidates.length;
    } finally {
      sweeping = false;
    }
  }

  async function noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void> {
    const c = ctx as Partial<DirectCtx> | undefined;
    const s = states.get(noteId);
    if (c?.source === "ai-edit" && c.applied === true) {
      if (s) clearTimer(s);
      if (typeof c.userId === "string") {
        await cutIfDirty(noteId, doc, { kind: "auto", extraEditors: [{ userId: c.userId, agentLabel: c.agentLabel ?? null }] });
      }
      return;
    }
    if (c?.source === "version-apply" && c.applied === true) {
      if (s) clearTimer(s);
      return;
    }
    // 「其他（人）」（spec §5.2）：人的落盤，以及被拒的 ai-edit／version-apply（applied=false；它取代了同一批人待送 store 的
    // lastContext，起草裁定 22）——重設 idle 計時器。
    if (!s?.initialized || !s.autoEnabled) return;
    clearTimer(s);
    s.idleTimer = timers.set(() => {
      s.idleTimer = null;
      if (states.get(noteId) !== s) return;
      const live = host?.documents.get(noteId);
      if (!live) return;
      // 計時器回呼不受 saveMutex 保護、沒有人 await 它：cutIfDirty 對非 VersionCutAbort 的 DB 錯誤會往上拋，一律在這裡吞掉只 warn。
      // 只清自己這一發：這發還沒落地時若已有下一發掛上 timerCut，finally 不得把下一發的引用清掉。
      const p: Promise<unknown> = cutIfDirty(noteId, live, { kind: "auto" })
        .catch(err => deps.log.warn({ err, noteId }, "idle 切版失敗"))
        .finally(() => {
          if (s.timerCut === p) s.timerCut = null;
        });
      s.timerCut = p;
    }, idleMs);
  }

  async function beforeUnload(noteId: string, doc: Y.Doc): Promise<void> {
    const s = states.get(noteId);
    if (s) {
      clearTimer(s);
      if (s.timerCut) await s.timerCut;
    }
    await cutIfDirty(noteId, doc, { kind: "auto" });
  }

  function close(): void {
    for (const s of states.values()) clearTimer(s);
  }

  function debugState(noteId: string): VersionStateSnapshot | undefined {
    const s = states.get(noteId);
    if (!s) return undefined;
    return {
      initialized: s.initialized, autoEnabled: s.autoEnabled, spaceKey: s.spaceKey, editors: [...s.editors.values()],
      loadFingerprint: s.loadFingerprint, baseFingerprint: s.baseFingerprint, applying: s.applying, hasTimer: s.idleTimer !== null,
    };
  }

  return {
    bind: h => {
      host = h;
    },
    noteLoaded, noteChanged, forget, relocated, isDirty, cutIfDirty, beginApply, endApply, docFor, currentOf, pruneNote, sweep, debugState,
    noteStored, beforeUnload, close,
  };
}
