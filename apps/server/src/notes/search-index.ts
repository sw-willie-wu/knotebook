/**
 * #93 §5.2／§6：全文索引的池層包裝（本檔在 S14 的 `ROUTE_FILES`：`.transaction(` 的 callback 整段就是
 * `replaceNoteSearchIndexInTx(tx, input, hooks)`，引數只准識別字）。
 * - `extractForIndex`：同步抽取（`collab/store.ts` 在 `encodeStateAsUpdate` 的同一 tick 呼叫，§5.3 第 1 點）。
 * - `writeSearchIndex`：開交易；`SearchIndexSkip` → 回 `"gone"`／`"stale"`；FK 違反視同 `"gone"`——**防禦性**：
 *   第 1 步已持 notes KEY SHARE，交易中的刪除會擋在 notes 列上，現行路徑到不了這個分支（沒有測試守著它；刪掉它測試仍全綠）；
 *   其餘例外 rethrow（呼叫端自己決定吞不吞：store 吞、回填記 warn）。
 * - `bumpSearchIndexVersion`：單句 UPDATE，只鎖狀態列、不碰 notes 列（刪除方持 notes 列後等狀態列，本句不等任何別的鎖
 *   ——無環）。WHERE 含 hash 與 extractor 版本：只在「索引內容就是這份」時推進。回更新列數（0＝呼叫端清快取自癒）。
 */
import { and, eq, lt } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteSearchState } from "../db/schema.js";
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
