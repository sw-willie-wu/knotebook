/**
 * #93 §5.2／§6：全文索引的池層包裝（本檔在 S14 的 `ROUTE_FILES`：`.transaction(` 的 callback 整段就是
 * `replaceNoteSearchIndexInTx(tx, input, hooks)`，引數只准識別字）。
 * - `extractForIndex`：同步抽取（`collab/store.ts` 在 `encodeStateAsUpdate` 的同一 tick 呼叫，§5.3 第 1 點）。
 * - `writeSearchIndex`：開交易；`SearchIndexSkip` → 回 `"gone"`／`"stale"`；FK 違反視同 `"gone"`——**防禦性**：
 *   第 1 步已持 notes KEY SHARE，交易中的刪除會擋在 notes 列上，現行路徑到不了這個分支（沒有測試守著它；刪掉它測試仍全綠）；
 *   其餘例外 rethrow（呼叫端自己決定吞不吞：store 吞、回填記 warn）。
 * - `bumpSearchIndexVersion`：單句 UPDATE，只鎖狀態列、不碰 notes 列（刪除方持 notes 列後等狀態列，本句不等任何別的鎖
 *   ——無環）。WHERE 含 hash 與 extractor 版本：只在「索引內容就是這份」時推進。回更新列數（0＝呼叫端清快取自癒）。
 * - `backfillSearchIndex`：§6.2 背景回填（見函式上方註解）。
 */
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteSearchState, noteStates } from "../db/schema.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { SEARCH_EXTRACTOR_VERSION, extractSearchSections, type SearchExtract } from "./search-text.js";
import { SearchIndexSkip, replaceNoteSearchIndexInTx, type SearchIndexHooks, type SearchIndexTxResult } from "./tx/search-index.js";

export type SearchIndexOutcome = "written" | "unchanged" | "gone" | "stale";

export interface SearchIndexLogger {
  warn(obj: object, msg: string): void;
}

export function extractForIndex(doc: Y.Doc): SearchExtract {
  return extractSearchSections(doc.getXmlFragment(YDOC_FRAGMENT));
}

export async function writeSearchIndex(
  db: Db,
  noteId: string,
  sourceVersion: number,
  extract: SearchExtract,
  opts: { log?: SearchIndexLogger; hooks?: SearchIndexHooks } = {},
): Promise<SearchIndexOutcome> {
  const input = { noteId, sourceVersion, extract };
  const hooks = opts.hooks;
  let result: SearchIndexTxResult;
  try {
    result = await db.transaction(tx => replaceNoteSearchIndexInTx(tx, input, hooks));
  } catch (err) {
    if (err instanceof SearchIndexSkip) return err.reason;
    if (isForeignKeyViolation(err)) return "gone";
    throw err;
  }
  if (result.regressed) {
    opts.log?.warn({ noteId, ...result.regressed }, "note_states.version 小於索引的 source_version（應用以外的回寫？）——照寫目前落盤的內容");
  }
  return result.outcome;
}

export async function bumpSearchIndexVersion(db: Db, noteId: string, sourceVersion: number, contentHash: string): Promise<number> {
  const updated = await db
    .update(noteSearchState)
    .set({ sourceVersion })
    .where(
      and(
        eq(noteSearchState.noteId, noteId),
        eq(noteSearchState.contentHash, contentHash),
        eq(noteSearchState.extractorVersion, SEARCH_EXTRACTOR_VERSION),
        lt(noteSearchState.sourceVersion, sourceVersion),
      ),
    )
    .returning({ noteId: noteSearchState.noteId });
  return updated.length;
}

/**
 * #93 §6.2：回填既有筆記。`app.listen` 之後背景跑（`index.ts`）；可續、冪等、可中止。
 * 候選＝有 note_states、且（沒有狀態列 ∨ extractor 版本不同 ∨ source_version ≠ note_states.version）；keyset 依 note_id。
 * 與即時落盤任意交錯都收斂到最新落盤版本（§5.1 先鎖再讀版本）；`stale`／`gone`／列已消失記 `skipped`（plan R-skip）。
 * 單篇例外（壞 ydoc 等）warn 後繼續——keyset 已前進，不會卡在同一篇。
 */
const BACKFILL_BATCH = 20;
const BACKFILL_PROGRESS_EVERY = 500;

export interface BackfillLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface BackfillOptions {
  signal?: AbortSignal;
  batchSize?: number;
  /** 測試縫：每篇處理完（不論結果）之後（生產不注入）。 */
  afterEachForTest?: (noteId: string) => void | Promise<void>;
}

export interface BackfillResult {
  candidates: number;
  done: number;
  skipped: number;
  failed: number;
  aborted: boolean;
  ms: number;
}

function backfillCandidate() {
  return or(
    isNull(noteSearchState.noteId),
    ne(noteSearchState.extractorVersion, SEARCH_EXTRACTOR_VERSION),
    ne(noteSearchState.sourceVersion, noteStates.version),
  );
}

export async function backfillSearchIndex(db: Db, log: BackfillLogger, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? BACKFILL_BATCH;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(noteStates)
    .leftJoin(noteSearchState, eq(noteSearchState.noteId, noteStates.noteId))
    .where(backfillCandidate());
  const candidates = count?.n ?? 0;
  log.info({ candidates }, "全文索引回填開始");
  let after: string | null = null;
  let processed = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;
  outer: for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const page = await db
      .select({ noteId: noteStates.noteId })
      .from(noteStates)
      .leftJoin(noteSearchState, eq(noteSearchState.noteId, noteStates.noteId))
      .where(and(after === null ? undefined : gt(noteStates.noteId, after), backfillCandidate()))
      .orderBy(asc(noteStates.noteId))
      .limit(batchSize);
    if (page.length === 0) break;
    for (const { noteId } of page) {
      if (opts.signal?.aborted) {
        aborted = true;
        break outer;
      }
      after = noteId;
      processed += 1;
      try {
        const [row] = await db.select({ ydoc: noteStates.ydoc, version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
        if (!row) {
          skipped += 1;
        } else {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, row.ydoc);
            // 解碼期間可能收到關機訊號：寫入前再看一次，免得 pool 已關時撞出誤導的 failed:1 warn。
            if (opts.signal?.aborted) {
              aborted = true;
              break outer;
            }
            const outcome = await writeSearchIndex(db, noteId, row.version, extractForIndex(doc), { log });
            if (outcome === "written" || outcome === "unchanged") done += 1;
            else skipped += 1;
          } finally {
            doc.destroy();
          }
        }
      } catch (err) {
        failed += 1;
        log.warn({ err, noteId }, "全文索引回填：單篇失敗（略過，繼續）");
      }
      await opts.afterEachForTest?.(noteId);
      if (processed % BACKFILL_PROGRESS_EVERY === 0) log.info({ processed, done, skipped, failed }, "全文索引回填進度");
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const result: BackfillResult = { candidates, done, skipped, failed, aborted, ms: Date.now() - started };
  log.info(result, aborted ? "全文索引回填中止（下次啟動接續）" : "全文索引回填完成");
  return result;
}
