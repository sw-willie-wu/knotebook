/**
 * #269 §12：升級後一次性把既有筆記裡的站內一般連結轉成 wikilink（含表格）。每篇整段在 `writes.runExclusive` 內（共用寫入佇列）：
 * 1 fork → 2 預掃（純 Yjs）→ 3 解析（mount 前、可查 DB）→ 4 存版本「連結轉換前」（直接 versions.cutIfDirty，**不得** writes.saveVersion）
 * → 5 headless 只改含可解連結的 block（block id 全數保留）→ 6 mergeDiff（`source:"link-convert"`、不帶 userId、expectFingerprint＝整篇）
 * → 7 `note_links` 只增補寫（每篇標 done 前一律執行）→ 8 UPDATE 標記。
 * signal 已 abort 時任何結果（含例外）都不寫標記（那篇留 pending，下次啟動再來）。日誌不記 href、標題、文字。
 */
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  MAX_LINK_TARGETS,
  YDOC_FRAGMENT,
  convertSiteLinksInContent,
  extractLinkTargets,
  parseSiteNoteHref,
  type SiteLinkTarget,
  type SiteNoteHref,
} from "@knotebook/shared";
import type { VersionService } from "../collab/versions.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { noteLinkConversion, noteLinks, notes } from "../db/schema.js";
import { visibleTitlesByIds } from "./editing/candidates.js";
import { FingerprintMismatch, forkAndCheck, mergeDiff, type ApplyDeps } from "./editing/apply.js";
import { QueueBusyError } from "./editing/queue.js";
import { EditorSession, type LinkConvertCtx } from "./editing/session.js";
import type { NoteWriteService } from "./editing/write-service.js";
import { normalizeLinkTargets } from "./links.js";
import { createSiteLinkResolver, type SiteLinkScope } from "./site-link-resolver.js";

export const LINK_CONVERSION_BATCH = 50;
export const LINK_CONVERSION_QUEUE_WAIT_MS = 1_000;
export const LINK_CONVERSION_MAX_ATTEMPTS = 3;
export const LINK_CONVERSION_START_DELAY_MS = 30_000;
export const LINK_CONVERSION_VERSION_NAME = "連結轉換前";

export interface LinkConversionLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface LinkConversionDeps {
  db: Db;
  writes: Pick<NoteWriteService, "runExclusive">;
  versions: Pick<VersionService, "docFor" | "cutIfDirty">;
  log: LinkConversionLog;
  siteOrigin: string;
}

export interface LinkConversionSummary {
  scanned: number;
  notesConverted: number;
  linksConverted: number;
  unresolved: number;
  retry: number;
  failed: number;
}

type NoteOutcome =
  | { kind: "done"; converted: number; unresolved: number }
  | { kind: "retry" }
  | { kind: "deleted" }
  | { kind: "aborted" };

/** 步 2：走訪 fragment 全部 `Y.XmlText` 的 delta，收集 `attributes.link.href` 能剖析的相異 href（表格也是 XmlElement 子樹，天然涵蓋）。 */
export function scanSiteLinkHrefs(doc: Y.Doc, siteOrigin: string): Map<string, SiteNoteHref> {
  const out = new Map<string, SiteNoteHref>();
  for (const node of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(n => n instanceof Y.XmlText)) {
    if (!(node instanceof Y.XmlText)) continue;
    for (const op of node.toDelta() as Array<{ attributes?: { link?: { href?: unknown } } }>) {
      const href = op.attributes?.link?.href;
      if (typeof href !== "string" || out.has(href)) continue;
      const parsed = parseSiteNoteHref(href, siteOrigin);
      if (parsed) out.set(href, parsed);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote Block 的泛型三元組，走 repo 慣例（同 apply.ts）
type AnyBlock = { id: string; content?: unknown; children?: AnyBlock[] } & Record<string, any>;

/**
 * 步 5：lease 紀律同 `prepareEdit`（持 lease 不再取 lease）。只對「自己的 content 有可解站內連結」的 block 呼叫 `updateBlock(id, { content })`
 * ——block id 全數保留、沒動到的 block 一個 Y 位元組都不變（R1：只動含連結的 block 把正規化範圍壓到最小）。
 */
export async function prepareLinkConversion(
  deps: ApplyDeps,
  fork: Y.Doc,
  sv: Uint8Array,
  resolved: ReadonlyMap<string, SiteLinkTarget>,
  siteOrigin: string,
): Promise<{ diff: Uint8Array; converted: number }> {
  const s = await EditorSession.open(deps.editing, fork);
  try {
    let converted = 0;
    const resolve = (href: string) => resolved.get(href) ?? null;
    const visit = (blocks: AnyBlock[]): void => {
      for (const block of blocks) {
        const stats = { converted: 0, unresolved: 0 };
        const next = convertSiteLinksInContent(block.content, resolve, siteOrigin, stats);
        if (stats.converted > 0 && next !== block.content) {
          s.editor.updateBlock(block.id, { content: next as never });
          converted += stats.converted;
        }
        if (Array.isArray(block.children) && block.children.length > 0) visit(block.children);
      }
    };
    visit(s.editor.document as AnyBlock[]);
    return { diff: s.diffSince(sv), converted };
  } finally {
    s.close();
  }
}

/** 步 7：只增不刪；target ＝ 文件裡的 wikilink 目標去掉自身、經同一解析範圍過濾；ids 為空則不查也不寫。冪等。 */
async function backfillNoteLinks(db: Db, noteId: string, scope: SiteLinkScope, doc: Y.Doc): Promise<void> {
  const norm = normalizeLinkTargets(noteId, extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS));
  if (!norm.ok || norm.targets.length === 0) return;
  const allowed =
    scope.kind === "user"
      ? (await visibleTitlesByIds(db, scope.userId, norm.targets)).map(t => t.id)
      : (await db.select({ id: notes.id }).from(notes).where(and(inArray(notes.id, norm.targets), eq(notes.groupId, scope.groupId)))).map(r => r.id);
  if (allowed.length === 0) return;
  try {
    await db.insert(noteLinks).values(allowed.map(targetNoteId => ({ sourceNoteId: noteId, targetNoteId }))).onConflictDoNothing();
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err; // 目標剛被刪：下次編輯者的全集同步會收斂
  }
}

/** 步 4：存「連結轉換前」。null 重來一次；skipped（uninitialized／fingerprint-failed）⇒ retry；note-deleted ⇒ deleted。 */
async function cutBeforeConversion(deps: LinkConversionDeps, noteId: string): Promise<"ok" | "retry" | "deleted"> {
  for (let i = 0; i < 2; i += 1) {
    const { doc, transient } = await deps.versions.docFor(noteId);
    const r = await deps.versions.cutIfDirty(noteId, doc, { kind: "manual", name: LINK_CONVERSION_VERSION_NAME, keepExistingName: true, extraEditors: [], transient });
    if (r === null) continue;
    if ("skipped" in r) return r.skipped === "note-deleted" ? "deleted" : "retry";
    return "ok";
  }
  return "retry";
}

async function processNote(deps: LinkConversionDeps, applyDeps: ApplyDeps, noteId: string, signal: AbortSignal, stage: { name: string }): Promise<NoteOutcome> {
  if (signal.aborted) return { kind: "aborted" }; // 等佇列期間收到關機：什麼都不做
  stage.name = "scope";
  const [meta] = await deps.db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.id, noteId)).limit(1);
  if (!meta) return { kind: "deleted" };
  const scope: SiteLinkScope = meta.groupId !== null ? { kind: "group", groupId: meta.groupId } : { kind: "user", userId: meta.ownerId! };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    stage.name = "fork";
    const f = await forkAndCheck(applyDeps, noteId);
    if (f.isEmptyDoc) return { kind: "done", converted: 0, unresolved: 0 };
    stage.name = "scan";
    const hrefs = scanSiteLinkHrefs(f.fork, deps.siteOrigin);
    if (hrefs.size === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved: 0 };
    }
    stage.name = "resolve";
    const resolver = createSiteLinkResolver(deps.db, scope);
    const resolved = new Map<string, SiteLinkTarget>();
    let unresolved = 0;
    for (const [href, parsed] of hrefs) {
      const target = await resolver.resolve(href, parsed);
      if (target) resolved.set(href, target);
      else unresolved += 1;
    }
    if (signal.aborted) return { kind: "aborted" };
    if (resolved.size === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved };
    }
    stage.name = "version";
    if (signal.aborted) return { kind: "aborted" };
    const cut = await cutBeforeConversion(deps, noteId);
    if (cut === "deleted") return { kind: "deleted" };
    if (cut === "retry") {
      // spec §12.5（plan gate r1 M3）：非例外的 retry 也記一行 warn；不記 href／標題／文字。
      deps.log.warn({ noteId, stage: stage.name, err: "version-skipped" }, "站內連結轉換：單篇失敗");
      return { kind: "retry" }; // 沒存成版本就不轉換
    }
    stage.name = "prepare";
    const prepared = await prepareLinkConversion(applyDeps, f.fork, f.sv, resolved, deps.siteOrigin);
    if (signal.aborted) return { kind: "aborted" };
    if (prepared.converted === 0) {
      await backfillNoteLinks(deps.db, noteId, scope, f.fork);
      return { kind: "done", converted: 0, unresolved };
    }
    stage.name = "merge";
    if (applyDeps.testHooks?.beforeMerge) await applyDeps.testHooks.beforeMerge();
    const ctx: LinkConvertCtx = { source: "link-convert", applied: false };
    try {
      await mergeDiff(applyDeps, noteId, ctx, { targetIds: null, expectFingerprint: f.whole, anchorId: null, diff: prepared.diff, afterIds: [] });
    } catch (err) {
      if (err instanceof FingerprintMismatch) continue; // 從步 1 重來一次；再不符 ⇒ retry
      throw err;
    }
    stage.name = "links";
    await backfillNoteLinks(deps.db, noteId, scope, f.fork); // 合併成功：用合併後的 fork（同 apply-version.ts）
    return { kind: "done", converted: prepared.converted, unresolved };
  }
  // 指紋兩次不符（spec §12.5，plan gate r1 M3）：非例外的 retry 也記 warn。
  deps.log.warn({ noteId, stage: "merge", err: "fingerprint-mismatch" }, "站內連結轉換：單篇失敗");
  return { kind: "retry" };
}

async function record(deps: LinkConversionDeps, row: { noteId: string; attempts: number }, outcome: NoteOutcome, summary: LinkConversionSummary): Promise<void> {
  const where = eq(noteLinkConversion.noteId, row.noteId);
  if (outcome.kind === "done") {
    await deps.db.update(noteLinkConversion).set({ status: "done", converted: outcome.converted, unresolved: outcome.unresolved, updatedAt: sql`now()` }).where(where);
    if (outcome.converted > 0) summary.notesConverted += 1;
    summary.linksConverted += outcome.converted;
    summary.unresolved += outcome.unresolved;
    return;
  }
  if (outcome.kind === "retry") {
    const failed = row.attempts + 1 >= LINK_CONVERSION_MAX_ATTEMPTS;
    await deps.db
      .update(noteLinkConversion)
      .set({ status: failed ? "failed" : "retry", attempts: sql`${noteLinkConversion.attempts} + 1`, updatedAt: sql`now()` })
      .where(where);
    if (failed) {
      summary.failed += 1;
      deps.log.error({ noteId: row.noteId, attempts: row.attempts + 1 }, "站內連結轉換：第 3 次失敗，標 failed、不再自動重試（手動重跑＝把該列改回 pending）");
    } else summary.retry += 1;
  }
  // deleted：列已隨筆記 cascade 消失（UPDATE 0 列也無妨），不寫；aborted 由呼叫端擋在這之前。
}

type OneResult = "busy" | "aborted" | "recorded";

async function convertOne(deps: LinkConversionDeps, row: { noteId: string; attempts: number }, signal: AbortSignal, summary: LinkConversionSummary): Promise<OneResult> {
  const stage = { name: "queue" };
  let outcome: NoteOutcome;
  try {
    outcome = await deps.writes.runExclusive(deps.log, row.noteId, LINK_CONVERSION_QUEUE_WAIT_MS, applyDeps =>
      processNote(deps, applyDeps, row.noteId, signal, stage),
    );
  } catch (err) {
    if (signal.aborted) return "aborted";
    if (err instanceof QueueBusyError) return "busy";
    deps.log.warn({ noteId: row.noteId, stage: stage.name, err }, "站內連結轉換：單篇失敗");
    outcome = { kind: "retry" };
  }
  if (signal.aborted || outcome.kind === "aborted") return "aborted";
  summary.scanned += 1;
  await record(deps, row, outcome, summary);
  return "recorded";
}

/** 一輪：候選 `status IN ('pending','retry') AND attempts < 3`、keyset by note_id、每批 batchSize；忙的本輪最後再試一次，仍忙維持 pending。 */
export async function runLinkConversion(deps: LinkConversionDeps, opts: { signal: AbortSignal; batchSize?: number }): Promise<LinkConversionSummary> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? LINK_CONVERSION_BATCH;
  const summary: LinkConversionSummary = { scanned: 0, notesConverted: 0, linksConverted: 0, unresolved: 0, retry: 0, failed: 0 };
  deps.log.info({}, "站內連結轉換：開始");
  const busy: Array<{ noteId: string; attempts: number }> = [];
  let cursor: string | null = null;
  outer: while (!opts.signal.aborted) {
    const rows: Array<{ noteId: string; attempts: number }> = await deps.db
      .select({ noteId: noteLinkConversion.noteId, attempts: noteLinkConversion.attempts })
      .from(noteLinkConversion)
      .where(and(inArray(noteLinkConversion.status, ["pending", "retry"]), lt(noteLinkConversion.attempts, LINK_CONVERSION_MAX_ATTEMPTS), cursor === null ? undefined : gt(noteLinkConversion.noteId, cursor)))
      .orderBy(asc(noteLinkConversion.noteId))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (opts.signal.aborted) break outer;
      await yieldToLoop();
      const r = await convertOne(deps, row, opts.signal, summary);
      if (r === "aborted") break outer;
      if (r === "busy") busy.push(row);
    }
    cursor = rows[rows.length - 1]!.noteId;
  }
  for (const row of busy) {
    if (opts.signal.aborted) break;
    if ((await convertOne(deps, row, opts.signal, summary)) === "aborted") break;
  }
  deps.log.info({ ...summary, ms: Date.now() - started }, "站內連結轉換：結束");
  return summary;
}

export interface LinkConversion {
  start(): void;
  stop(): Promise<void>;
  /** 整合測試直接呼叫 `runLinkConversion(conversion.deps!, …)` 用；沒有 collab 的部署為 null。 */
  readonly deps: LinkConversionDeps | null;
}

export const NOOP_LINK_CONVERSION: LinkConversion = { start() {}, stop: () => Promise.resolve(), deps: null };

/**
 * `start()` 只會啟動一次（第二次 no-op），延遲 `startDelayMs`（unref timer）後跑一輪；`stop()` abort 並回傳「在途那一篇結束（或被放棄）」
 * 的 promise——**永不 reject**（`index.ts` 拿它跟 2 s 計時賽跑；reject 會跳過 `collab.destroy()`、丟掉人的待落盤編輯）。
 */
export function createLinkConversion(deps: LinkConversionDeps, opts: { startDelayMs?: number } = {}): LinkConversion {
  const controller = new AbortController();
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  return {
    deps,
    start() {
      if (started) return;
      started = true;
      timer = setTimeout(() => {
        timer = undefined;
        running = runLinkConversion(deps, { signal: controller.signal }).then(
          () => undefined,
          err => deps.log.error({ err }, "站內連結轉換中止"),
        );
      }, opts.startDelayMs ?? LINK_CONVERSION_START_DELAY_MS);
      timer.unref?.();
    },
    stop() {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      return (running ?? Promise.resolve()).then(() => undefined, () => undefined);
    },
  };
}
