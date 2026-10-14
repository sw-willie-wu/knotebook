/**
 * 筆記版本歷史：每篇載入中筆記的版本狀態與切版（spec 2026-10-09-note-versions-design.md §4.5、§5、§7-2d、§9、§10.2；
 * #272 spec 2026-10-13-version-autosave-idle-design.md §4–§7）。
 * 自動版本只有一條規則（#272 D1）：落盤時內容有變就寫 `notes` 的待切三欄（`noteStored` → `markPending`），
 * 行程內掃描器（`scanDue`，app.ts 定時呼叫）切「最後一次變動後 X 分鐘沒有新變動」的筆記；不分人、框選 AI、MCP／REST 直寫。
 * 沒有 idle 計時器、沒有卸載時切、沒有 AI 寫入前後立刻切（D2）。手動儲存與改名轉手動照舊；套用永不切版（套用的落盤清待切）。
 * hook 接線在 `collab/server.ts`；套用在 `notes/editing/apply-version.ts`。⚠ 記憶體狀態只在這個 process（同 `NoteWriteQueue`）；
 * 待切狀態在 DB，重啟後掃描器接手。
 *
 * 狀態來源（`resolve`）：Map 有條目 → 用它（必須 `initialized`）；Map 沒有但文件已載入（§9 空窗期）→ uninitialized；
 * 文件沒載入 → 呼叫端給的 `transient` doc 建暫時狀態，用完即丟、不進 Map。兩者沒有基底時的比對對象（`loadFingerprint`）
 * 都由 `loadFingerprintOf` 決定：沒有基底且待切中＝待切段的參考指紋，否則＝當下內容的指紋。
 */
import { and, asc, eq, gt, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  VERSION_AUTO_WAIT_MINUTES_DEFAULT, VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_KEEP_ALL_DAYS_DEFAULT, YDOC_FRAGMENT,
  type VersionCurrentDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groups, noteStates, noteVersions, notes, siteSettings, users } from "../db/schema.js";
import type { DirectCtx } from "../notes/editing/session.js";
import { UUID_RE } from "../notes/service.js";
import {
  PENDING_CLEARED, VersionCutAbort, cutVersionInTx, dedupeEditors, notBaseVersionSql, spaceKeyOf,
  type CutVersionInput, type NoteVersionRow, type VersionEditorJson,
} from "../notes/tx/versions.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../notes/version-fingerprint.js";
import { selectVersionsToDelete } from "./version-policy.js";

const DAY_MS = 86_400_000;
export const VERSION_SWEEP_BATCH = 100;
export const VERSION_SWEEP_INTERVAL_MS = 60 * 60_000;
export const VERSION_SWEEP_FIRST_DELAY_MS = 5 * 60_000;
/** #272 §7.1：自動切版掃描每 30 s 一輪、每輪至多 100 篇（先舊後新）；單篇丟錯後 10 分鐘內不重試、不佔批次名額。 */
export const VERSION_AUTO_SCAN_INTERVAL_MS = 30_000;
export const VERSION_AUTO_SCAN_BATCH = 100;
export const VERSION_AUTO_SCAN_BACKOFF_MS = 10 * 60_000;
/**
 * #272 §7.4：關機時等自動切版掃描停下（`stopScan`）的上限——卡在列鎖或 DB 的那一篇不得吃掉 docker stop 的寬限期（比照 #269 的有界停止）。
 * `app.ts` 的 onClose 與 `index.ts` 的 `stopGrace()` 共用這一個常數。
 */
export const SCAN_STOP_GRACE_MS = 2_000;
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
  /** 文件沒載入時呼叫端自己讀出的 doc（`docFor` 讀 note_states 的 doc）。 */
  transient?: Y.Doc;
}
/** #272 §7.3：切版的完整結果。公開的 `cutIfDirty` 把 clean／stale／not-due 收成 `null`（契約不變）。 */
export type CutOutcome =
  | { kind: "cut"; row: NoteVersionRow; upgraded: boolean }
  | { kind: "clean" }
  | { kind: "stale" }
  | { kind: "not-due" }
  | { kind: "skipped"; reason: CutSkip };
/** Hocuspocus 實例結構上符合（`documents` 是 `Map<string, Document>`）；測試注入假 host。 */
export interface VersionDocsHost {
  documents: { get(name: string): Y.Doc | undefined; has(name: string): boolean };
}
export interface VersionServiceDeps {
  db: Db;
  log: { warn(obj: object, msg: string): void };
  /** 待切時刻與 `scanDue()` 不帶參數時的「現在」。測試注入固定時鐘。 */
  now?: () => Date;
  /** #272 §7.1：測試用——覆寫站台設定的等待 X（毫秒）；未傳＝每輪現讀 `site_settings.version_auto_wait_minutes`。 */
  autoWaitMs?: number;
  /**
   * 測試注入縫（生產不注入＝每個縫點一次可選鏈判斷）。
   * `afterMetaRead`：`resolve()` 的「文件沒載入」路徑讀完 `readVersionMeta`、回傳暫時狀態之前
   * （即 `cutIfDirty`／掃描切版進 `cutVersionInTx` 之前；帶 `transient` 的 `isDirty` 也經 `resolve()` 走到這裡）——
   * `versions-matrix.test.ts` 在這裡設 barrier；`versions-scan.test.ts` 在這裡插一次新落盤（案 12）。
   * `afterPruneRead`：`pruneNote` 讀完、算出要刪的 seq 之後、DELETE 之前（驗 DELETE 自帶述詞的並發保險，起草裁定 14）。
   * `beforeCutDue`：掃描器處理單篇的第一步（`docFor` 之前，#272 §7.3）。丟錯＝模擬單篇失敗（`versions-scan.test.ts` 案 18）。
   */
  testHooks?: {
    afterMetaRead?: (noteId: string) => Promise<void>;
    afterPruneRead?: (noteId: string, doomed: number[]) => Promise<void>;
    beforeCutDue?: (noteId: string) => Promise<void>;
  };
}
export interface VersionMeta {
  baseSeq: number | null;
  baseFingerprint: string | null;
  counter: number;
  spaceKey: string;
  autoEnabled: boolean;
  /** #272 §6.1：待切段最後一次內容變動的落盤時刻（NULL＝沒有待切）。 */
  pendingAt: Date | null;
  /** #272 §5.1：只在待切段開始時沒有基底才有值——段開始前的內容指紋。 */
  pendingRefFingerprint: string | null;
}
/** `currentOf` 的結果：`VersionCurrentDto` 減去由路由層 `withCurrentBase` 補上的 `base`（#272 §9）。 */
export type VersionCurrentCore = Omit<VersionCurrentDto, "base">;
export interface VersionStateSnapshot {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  editors: VersionEditor[];
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
  lastStoredFingerprint: string | null;
}

interface NoteVersionState {
  initialized: boolean;
  autoEnabled: boolean;
  spaceKey: string;
  /** 尚未寫進 DB 待切名單的編輯者緩衝（`noteChanged` 零 DB；落盤有變動時併進 `version_pending_editors` 後刪掉）。 */
  editors: Map<string, VersionEditor>;
  loadFingerprint: string | null;
  baseFingerprint: string | null;
  applying: boolean;
  /** #272 §6.1：上一次已記錄的落盤指紋——落盤指紋與它相同＝不是內容變動（零 DB）。 */
  lastStoredFingerprint: string | null;
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
  /**
   * 帶 `r`：套用把基底寫回之後（`apply-version.ts` 的 `writeBaseAfterApply`，在 disconnect＝落盤之前）只更新基底鏡像，**不清 `applying`**；
   * 不帶 `r`：外層 `finally`（disconnect 之後）才清 `applying`——#272 §4.3：reset 到清待切之間，掃描器仍得 `skipped: applying`。
   */
  endApply(noteId: string, r?: { seq: number; fingerprint: string } | { reset: true }): void;
  docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }>;
  currentOf(noteId: string): Promise<VersionCurrentCore | null>;
  pruneNote(noteId: string, now?: Date): Promise<number>;
  sweep(now: Date): Promise<number>;
  debugState(noteId: string): VersionStateSnapshot | undefined;
  /** #272 §6.2：onStoreDocument 之後（server.ts await 它，受 saveMutex 保護）——內容有變就寫待切；套用的落盤清待切。丟錯往上拋。 */
  noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void>;
  /** #272 §7.2：切 `version_pending_at ≤ at − X` 的筆記（每輪至多 100 篇、先舊後新）。同時只跑一輪；`stopScan` 之後恆回 0。回「選到幾篇」。 */
  scanDue(at?: Date): Promise<number>;
  /** #272 §7.4：之後不再開新的一輪；進行中那一輪做完手上那一篇就停。resolve＝那一輪結束（沒有進行中就立刻）。 */
  stopScan(): Promise<void>;
  /** #272 §7.5：e2e 測試縫——覆寫 X（毫秒；null＝取消覆寫）。優先於 `deps.autoWaitMs` 與站台設定。 */
  overrideAutoWaitMs(ms: number | null): void;
}

/** A13 生效值、基底與待切；筆記不存在回 null。noteId 非 UUID 也回 null（documentName 由 client 指定）。 */
export async function readVersionMeta(db: Db, noteId: string): Promise<VersionMeta | null> {
  if (!UUID_RE.test(noteId)) return null;
  const [r] = await db
    .select({
      baseSeq: notes.versionBaseSeq,
      baseFingerprint: notes.versionBaseFingerprint,
      counter: notes.versionCounter,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      pendingAt: notes.versionPendingAt,
      pendingRefFingerprint: notes.versionPendingRefFingerprint,
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
  return {
    baseSeq: r.baseSeq, baseFingerprint: r.baseFingerprint, counter: r.counter, spaceKey: spaceKeyOf(r), autoEnabled: r.siteAuto !== false && spaceAuto === true,
    pendingAt: r.pendingAt, pendingRefFingerprint: r.pendingRefFingerprint,
  };
}

/**
 * #272 §6.1：沒有基底時的比對對象。沒有基底且待切中＝待切段的參考指紋（段開始前的內容）；否則＝`actual`（呼叫端算的當下內容指紋）。
 * 載入（`noteLoaded`）與暫時狀態（`resolve`）同式。
 */
function loadFingerprintOf(meta: Pick<VersionMeta, "baseFingerprint" | "pendingAt" | "pendingRefFingerprint">, actual: string | null): string | null {
  return meta.baseFingerprint === null && meta.pendingAt !== null ? meta.pendingRefFingerprint : actual;
}

/** §7-2d：套用成功後把基底指向該版——只在那一版還在時（`EXISTS`）。回 true＝1 列。#272：同時寫基底 uuid（D12）。 */
export async function setVersionBase(db: Db, noteId: string, seq: number, fingerprint: string, versionId: string): Promise<boolean> {
  const updated = await db
    .update(notes)
    .set({ versionBaseSeq: seq, versionBaseFingerprint: fingerprint, versionBaseVersionId: versionId })
    .where(and(eq(notes.id, noteId), sql`exists (select 1 from note_versions v where v.note_id = ${noteId} and v.seq = ${seq})`))
    .returning({ id: notes.id });
  return updated.length === 1;
}

/** §7-2d 的 0 列／指紋算不出來分支：基底清空（含 uuid）。 */
export async function clearVersionBase(db: Db, noteId: string): Promise<void> {
  await db.update(notes).set({ versionBaseSeq: null, versionBaseFingerprint: null, versionBaseVersionId: null }).where(eq(notes.id, noteId));
}

/**
 * #272 §6.3：一次內容變動——設待切時刻、併入編輯者；段開始（之前沒有待切）且沒有基底時記下參考指紋。單句、不開交易；
 * `SET` 右側讀的是舊值，所以 `CASE` 判的是「這次之前是否已待切」。編輯者兩鍵恆在，`@>` 即完全相等（先在 JS 去重）。
 * 帶空間述詞：`spaceKey` 對不上（搬家／轉移後才落地的舊落盤）→ 0 列，視為完成。回寫入列數。
 */
export async function markPending(
  db: Db,
  input: { noteId: string; at: Date; add: VersionEditorJson[]; ref: string | null; spaceKey: string },
): Promise<number> {
  const sep = input.spaceKey.indexOf(":");
  const kind = sep < 0 ? "" : input.spaceKey.slice(0, sep);
  const id = sep < 0 ? "" : input.spaceKey.slice(sep + 1);
  if ((kind !== "u" && kind !== "g") || id === "") return 0;
  const space = kind === "u" ? sql`notes.owner_id = ${id}` : sql`notes.group_id = ${id}`;
  const add = JSON.stringify(dedupeEditors(input.add));
  const res = await db.execute(sql`
    update notes set
      version_pending_at = ${input.at},
      version_pending_ref_fingerprint = case when notes.version_pending_at is null and notes.version_base_seq is null
                                             then ${input.ref}::text else notes.version_pending_ref_fingerprint end,
      version_pending_editors = notes.version_pending_editors || coalesce((
        select jsonb_agg(n.e order by n.ord) from jsonb_array_elements(${add}::jsonb) with ordinality as n(e, ord)
        where not notes.version_pending_editors @> jsonb_build_array(n.e)), '[]'::jsonb)
    where notes.id = ${input.noteId} and ${space}`);
  return res.rowCount ?? 0;
}

/** #272 §6.2：套用的落盤一律清待切（成功、reset、基底寫回失敗三條路都經過它）。 */
export async function clearPending(db: Db, noteId: string): Promise<void> {
  await db.update(notes).set(PENDING_CLEARED).where(eq(notes.id, noteId));
}

/** #272 §7.3：掃描器的 clean／auto-disabled／fingerprint-failed——只清「仍到期」的那一段（較新的一段留著）。回清掉的列數。 */
export async function clearPendingIfDue(db: Db, noteId: string, dueBy: Date): Promise<number> {
  const cleared = await db
    .update(notes)
    .set(PENDING_CLEARED)
    .where(and(eq(notes.id, noteId), lte(notes.versionPendingAt, dueBy)))
    .returning({ id: notes.id });
  return cleared.length;
}

const editorKey = (e: VersionEditor): string => JSON.stringify([e.userId, e.agentLabel]);

const toEditorsJson = (list: VersionEditor[]): VersionEditorJson[] =>
  dedupeEditors(list.map(e => ({ user_id: e.userId, agent_label: e.agentLabel })));

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
  const states = new Map<string, NoteVersionState>();
  const applyingSet = new Set<string>();
  const warnedUninitialized = new Set<string>();
  let host: VersionDocsHost | null = null;
  let sweepCursor: string | null = null;
  let sweeping = false;
  // #272 §7.2：掃描器狀態。backoff：noteId → 這個時刻（ms，掃描 `at` 的時鐘）之前不重試、不佔批次名額。
  let scanInflight: Promise<number> | null = null;
  let stopping = false;
  let overrideWaitMs: number | null = null;
  const backoff = new Map<string, number>();

  const blankState = (noteId: string): NoteVersionState => ({
    initialized: false, autoEnabled: false, spaceKey: "", editors: new Map(), loadFingerprint: null, baseFingerprint: null,
    applying: applyingSet.has(noteId), lastStoredFingerprint: null,
  });

  function entryFor(noteId: string): NoteVersionState {
    let e = states.get(noteId);
    if (!e) {
      e = blankState(noteId);
      states.set(noteId, e);
    }
    return e;
  }

  async function noteLoaded(noteId: string, doc: Y.Doc, opts: { rerun?: boolean } = {}): Promise<void> {
    for (let attempt = 0; attempt < NOTE_LOADED_MAX_ATTEMPTS; attempt += 1) {
      // §4.5：條目本身當令牌——開頭同步取得或建立 E，await 回來只有 Map.get(noteId) === E 才寫進 E（r6 C-1）。
      const e = entryFor(noteId);
      // 先同步抓，再 await 讀 DB。#272 §6.1：`lastStoredFingerprint` 也取這一刻——relocated 重跑空窗內的落盤，下一次落盤才算得到變動。
      const actual = safeFingerprint(doc);
      const meta = await readVersionMeta(db, noteId);
      if (states.get(noteId) !== e) {
        if (opts.rerun) return; // §9 重跑那次：丟棄
        continue; // 從 onLoadDocument 進來：重來（r7 M-1）
      }
      if (meta === null) {
        // 筆記已刪（起草裁定 20）：自動一律 auto-disabled；手動在交易內得 note-deleted。
        Object.assign(e, { initialized: true, autoEnabled: false, spaceKey: "", loadFingerprint: actual, baseFingerprint: null, lastStoredFingerprint: actual });
        return;
      }
      Object.assign(e, {
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, loadFingerprint: loadFingerprintOf(meta, actual),
        baseFingerprint: meta.baseFingerprint, applying: applyingSet.has(noteId), lastStoredFingerprint: actual,
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
        initialized: true, autoEnabled: meta.autoEnabled, spaceKey: meta.spaceKey, editors: new Map(),
        loadFingerprint: loadFingerprintOf(meta, safeFingerprint(transient)), baseFingerprint: meta.baseFingerprint,
        applying: applyingSet.has(noteId), lastStoredFingerprint: null,
      },
    };
  }

  async function isDirty(noteId: string, doc: Y.Doc, transient?: Y.Doc): Promise<boolean> {
    const r = await resolve(noteId, transient);
    if (typeof r === "string") return true;
    const fp = safeFingerprint(doc);
    return fp === null ? true : dirtyOf(r.state, fp);
  }

  /** §5.3 的本體（`cutIfDirty` 與掃描器共用，#272 §7.3）。`dueBy`：掃描器的到期界線，交易內再比一次（not-due）。 */
  async function cutCore(noteId: string, doc: Y.Doc, opts: CutOptions & { dueBy?: Date }): Promise<CutOutcome> {
    const r = await resolve(noteId, opts.transient);
    if (r === "note-deleted") return { kind: "skipped", reason: "note-deleted" };
    if (r === "uninitialized") {
      if (!warnedUninitialized.has(noteId)) {
        warnedUninitialized.add(noteId);
        deps.log.warn({ noteId }, "版本狀態尚未初始化，略過切版");
      }
      return { kind: "skipped", reason: "uninitialized" };
    }
    const { state, live } = r;
    if (opts.kind === "auto") {
      if (state.applying) return { kind: "skipped", reason: "applying" };
      if (!state.autoEnabled) return { kind: "skipped", reason: "auto-disabled" };
    }
    const fp = safeFingerprint(doc);
    if (fp === null) {
      deps.log.warn({ noteId }, "版本指紋算不出來，略過切版");
      return { kind: "skipped", reason: "fingerprint-failed" };
    }
    if (opts.kind === "auto" && !dirtyOf(state, fp)) return { kind: "clean" };
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
      ...(opts.dueBy !== undefined ? { dueBy: opts.dueBy } : {}),
    };
    let out: Awaited<ReturnType<typeof cutVersionInTx>>;
    try {
      out = await db.transaction(tx => cutVersionInTx(tx, input));
    } catch (err) {
      if (!(err instanceof VersionCutAbort)) throw err;
      const reason = err.reason;
      if (reason.kind === "note-deleted") return { kind: "skipped", reason: "note-deleted" };
      if (reason.kind === "fingerprint-failed") {
        deps.log.warn({ noteId, err: reason.cause }, "版本指紋算不出來，略過切版");
        return { kind: "skipped", reason: "fingerprint-failed" };
      }
      if (reason.kind === "stale") {
        if (live && states.get(noteId) === state) {
          state.baseFingerprint = reason.baseFingerprint;
          state.spaceKey = reason.spaceKey;
        }
        return { kind: "stale" };
      }
      return reason.kind === "not-due" ? { kind: "not-due" } : { kind: "clean" };
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
    return { kind: "cut", row: out.row, upgraded: out.upgraded };
  }

  async function cutIfDirty(noteId: string, doc: Y.Doc, opts: CutOptions): Promise<CutResult> {
    const out = await cutCore(noteId, doc, opts);
    if (out.kind === "cut") return { row: out.row, upgraded: out.upgraded };
    if (out.kind === "skipped") return { skipped: out.reason };
    return null;
  }

  function beginApply(noteId: string): void {
    applyingSet.add(noteId);
    const s = states.get(noteId);
    if (s) s.applying = true;
  }

  function endApply(noteId: string, r?: { seq: number; fingerprint: string } | { reset: true }): void {
    const s = states.get(noteId);
    if (r === undefined) {
      // 外層 finally（disconnect＝落盤之後）：這時才清 applying（#272 §4.3）。
      applyingSet.delete(noteId);
      if (s) s.applying = false;
      return;
    }
    if (!s) return;
    if ("reset" in r) {
      s.baseFingerprint = null;
      s.loadFingerprint = null; // 「非真空就算有改」：下一刀依沒有基底的規則切
      return;
    }
    s.baseFingerprint = r.fingerprint;
    s.editors.clear();
  }

  async function docFor(noteId: string): Promise<{ doc: Y.Doc; transient?: Y.Doc }> {
    const live = host?.documents.get(noteId);
    if (live) return { doc: live };
    const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
    const doc = new Y.Doc();
    if (row) Y.applyUpdate(doc, row.ydoc);
    return { doc, transient: doc };
  }

  async function currentOf(noteId: string): Promise<VersionCurrentCore | null> {
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
    if (deps.testHooks?.afterPruneRead) await deps.testHooks.afterPruneRead(noteId, doomed);
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

  /** #272 §7.2：這一輪的等待 X（毫秒）：測試縫覆寫 → 注入 → 站台設定現值（讀不到列＝預設 5 分鐘）。讀 DB 失敗＝整輪丟錯（呼叫端 warn）。 */
  async function waitMsNow(): Promise<number> {
    if (overrideWaitMs !== null) return overrideWaitMs;
    if (deps.autoWaitMs !== undefined) return deps.autoWaitMs;
    const [r] = await db
      .select({ minutes: siteSettings.versionAutoWaitMinutes })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    return (r?.minutes ?? VERSION_AUTO_WAIT_MINUTES_DEFAULT) * 60_000;
  }

  /**
   * #272 §7.3：單篇。`docFor`（載入中用活文件，否則 note_states）→ `cutCore`（交易內再比「仍到期」）。
   * cut → 交易內已清待切；clean／auto-disabled／fingerprint-failed → 只清「仍到期」的待切；stale／not-due／applying／uninitialized → 下一輪再試；
   * note-deleted → 不動。丟錯往上拋（`scanRound` 記 backoff）。
   */
  async function cutDue(noteId: string, dueBy: Date): Promise<void> {
    if (deps.testHooks?.beforeCutDue) await deps.testHooks.beforeCutDue(noteId);
    const { doc, transient } = await docFor(noteId);
    const out = await cutCore(noteId, doc, { kind: "auto", transient, dueBy });
    const settled = out.kind === "clean" || (out.kind === "skipped" && (out.reason === "auto-disabled" || out.reason === "fingerprint-failed"));
    if (settled) await clearPendingIfDue(db, noteId, dueBy);
  }

  async function scanRound(at: Date): Promise<number> {
    const dueBy = new Date(at.getTime() - (await waitMsNow()));
    for (const [id, until] of backoff) if (until <= at.getTime()) backoff.delete(id);
    const held = [...backoff.keys()];
    const due = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(lte(notes.versionPendingAt, dueBy), held.length > 0 ? notInArray(notes.id, held) : undefined))
      .orderBy(asc(notes.versionPendingAt), asc(notes.id))
      .limit(VERSION_AUTO_SCAN_BATCH);
    // 「每篇 10 分鐘至多 warn 一次」在現行順序下實際由「每輪先刪到期條目＋notInArray 排除未到期的」保證：被處理的那篇不會在
    // backoff 裡。下面的 `!backoff.has(id)` 與成功後的 `backoff.delete(id)` 是 spec §7.2 偽碼的字面、雙保險（突變 X21／X24 等價）。
    for (const { id } of due) {
      if (stopping) break;
      try {
        await cutDue(id, dueBy);
        backoff.delete(id);
      } catch (err) {
        if (!backoff.has(id)) deps.log.warn({ err, noteId: id }, "自動切版：單篇失敗，10 分鐘後再試");
        backoff.set(id, at.getTime() + VERSION_AUTO_SCAN_BACKOFF_MS);
      }
    }
    return due.length;
  }

  function scanDue(at: Date = now()): Promise<number> {
    if (scanInflight !== null || stopping) return Promise.resolve(0);
    const round = scanRound(at).finally(() => {
      scanInflight = null;
    });
    scanInflight = round;
    return round;
  }

  function stopScan(): Promise<void> {
    stopping = true;
    return scanInflight === null ? Promise.resolve() : scanInflight.then(() => undefined, () => undefined);
  }

  async function noteStored(noteId: string, doc: Y.Doc, ctx: unknown): Promise<void> {
    const c = ctx as Partial<DirectCtx> | undefined;
    if (c?.source === "version-apply" && c.applied === true) {
      // §4.3：套用的落盤一律清待切（成功、reset、基底寫回失敗三條路都在這裡）；套用後的內容不算一次變動。
      await clearPending(db, noteId);
      const s = states.get(noteId);
      if (s?.initialized) s.lastStoredFingerprint = safeFingerprint(doc);
      return;
    }
    // 人的落盤、AI／直寫的落盤，以及被拒的直寫（applied=false：同人的落盤，前 spec 起草裁定 22——它取代了同一批人待送 store 的 lastContext）。
    const s = states.get(noteId);
    if (!s?.initialized) return; // 空窗期／載入失敗
    const fp = safeFingerprint(doc);
    if (fp === null || fp === s.lastStoredFingerprint) return; // 不是內容變動：零 DB
    if (!s.autoEnabled) {
      s.lastStoredFingerprint = fp; // 緩衝留給手動儲存
      return;
    }
    const flushed = [...s.editors.entries()];
    const writer = c?.source === "ai-edit" && c.applied === true && typeof c.userId === "string" ? [{ userId: c.userId, agentLabel: c.agentLabel ?? null }] : [];
    const add = toEditorsJson([...flushed.map(([, v]) => v), ...writer]);
    await markPending(db, { noteId, at: now(), add, ref: s.loadFingerprint, spaceKey: s.spaceKey });
    s.lastStoredFingerprint = fp;
    for (const [k] of flushed) s.editors.delete(k);
  }

  function debugState(noteId: string): VersionStateSnapshot | undefined {
    const s = states.get(noteId);
    if (!s) return undefined;
    return {
      initialized: s.initialized, autoEnabled: s.autoEnabled, spaceKey: s.spaceKey, editors: [...s.editors.values()],
      loadFingerprint: s.loadFingerprint, baseFingerprint: s.baseFingerprint, applying: s.applying, lastStoredFingerprint: s.lastStoredFingerprint,
    };
  }

  return {
    bind: h => {
      host = h;
    },
    noteLoaded, noteChanged, forget, relocated, isDirty, cutIfDirty, beginApply, endApply, docFor, currentOf, pruneNote, sweep, debugState,
    noteStored, scanDue, stopScan,
    overrideAutoWaitMs: ms => {
      overrideWaitMs = ms;
    },
  };
}
