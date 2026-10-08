/**
 * #93 §5.1：全文索引的交易本體（S14：只收 `tx`、純資料與型別明示的測試縫）。呼叫端：`notes/search-index.ts` 的
 * `writeSearchIndex`（即時落盤、回填）與 `notes/tx/copy.ts`（複製，同一交易）。
 *
 * 五步（順序是契約）：
 *   1. 筆記 `FOR KEY SHARE`；0 列 → `SearchIndexSkip("gone")`。**必要**：狀態列已存在時第 2 步不插列、不做 FK 檢查，
 *      少了這一步，本交易先持狀態列鎖；DELETE notes 的 cascade 先鎖住該篇的 sections 列、再等狀態列，本交易到第 5 步
 *      刪舊 sections 列時等 DELETE 的交易——成環（突變 M3 實測：pg log `deadlock detected`（40P01），環閉合在第 5 步的
 *      `delete from note_search_sections`，犧牲者是使用者的 DELETE（回 500）；`search-index-write.test.ts` S5 釘住）。
 *      先取 notes KEY SHARE，DELETE 就在 notes 列上等、碰不到 sections 列，環不成立。
 *   2. 狀態列 `INSERT … ON CONFLICT DO NOTHING`（佔位）＋`SELECT … FOR UPDATE`：同一篇的並發索引交易在這裡排隊
 *      （首建也一樣——只有 FOR UPDATE 的話兩個交易都看到「沒有列」）。
 *   3. **持狀態列鎖之後**才讀 `note_states.version`（READ COMMITTED 每句一個新快照）；沒有列或 ≠ 輸入 → `stale`。
 *      先讀版本再拿鎖會讓回填把較新的索引蓋回舊版（spec §5.1 I1；S12 案 A 釘住）。`state.source_version > version`
 *      只在應用以外把 note_states 往回寫時出現 → 照寫，回傳 `regressed` 給呼叫端記 warn（m1）。
 *   4. hash 與 extractor 版本相同 → 只推進 `source_version`、回 `unchanged`。
 *   5. 否則刪掉該篇 `source_kind='note'` 的列、分批（500 列一句）INSERT、更新狀態列全欄 → `written`。0 列時不發 INSERT。
 * 不寫的兩種情形以**例外**表達，讓 drizzle rollback（不留佔位列）；呼叫端（`writeSearchIndex`）接住轉成回傳值，
 * 複製交易則不接——讓整個複製失敗。
 * 鎖序：notes KEY SHARE → note_search_state 列 → note_search_sections 列。
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteSearchSections, noteSearchState, noteStates, notes } from "../../db/schema.js";
import type { SearchExtract } from "../search-text.js";

export interface SearchIndexInput {
  noteId: string;
  sourceVersion: number;
  extract: SearchExtract;
}

/** 測試縫（生產不注入）：分別在第 2 步之前、第 3 步之後、第 5 步（INSERT 與狀態列 UPDATE）之後 await。 */
export interface SearchIndexHooks {
  beforeStateLockForTest?(): Promise<void>;
  afterVersionReadForTest?(): Promise<void>;
  afterWriteForTest?(): Promise<void>;
}

export class SearchIndexSkip extends Error {
  constructor(readonly reason: "gone" | "stale") {
    super(`search index skipped: ${reason}`);
    this.name = "SearchIndexSkip";
  }
}

export interface SearchIndexTxResult {
  outcome: "written" | "unchanged";
  regressed: { stateSourceVersion: number; noteStateVersion: number } | null;
}

const INSERT_BATCH = 500;

export async function replaceNoteSearchIndexInTx(tx: Tx, input: SearchIndexInput, hooks?: SearchIndexHooks): Promise<SearchIndexTxResult> {
  const { noteId, sourceVersion, extract } = input;
  const [note] = await tx.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId)).for("key share");
  if (!note) throw new SearchIndexSkip("gone");
  await hooks?.beforeStateLockForTest?.();
  await tx
    .insert(noteSearchState)
    .values({ noteId, extractorVersion: 0, sourceVersion: -1, contentHash: "", indexedUnits: 0, capped: false })
    .onConflictDoNothing({ target: noteSearchState.noteId });
  const [state] = await tx
    .select({ sourceVersion: noteSearchState.sourceVersion, contentHash: noteSearchState.contentHash, extractorVersion: noteSearchState.extractorVersion })
    .from(noteSearchState)
    .where(eq(noteSearchState.noteId, noteId))
    .for("update");
  const [current] = await tx.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
  await hooks?.afterVersionReadForTest?.();
  if (!current || current.version !== sourceVersion) throw new SearchIndexSkip("stale");
  const regressed = state!.sourceVersion > current.version ? { stateSourceVersion: state!.sourceVersion, noteStateVersion: current.version } : null;

  if (state!.contentHash === extract.contentHash && state!.extractorVersion === extract.extractorVersion) {
    await tx.update(noteSearchState).set({ sourceVersion, indexedAt: sql`now()` }).where(eq(noteSearchState.noteId, noteId));
    return { outcome: "unchanged", regressed };
  }

  await tx.delete(noteSearchSections).where(and(eq(noteSearchSections.noteId, noteId), eq(noteSearchSections.sourceKind, "note")));
  for (let i = 0; i < extract.rows.length; i += INSERT_BATCH) {
    await tx.insert(noteSearchSections).values(
      extract.rows.slice(i, i + INSERT_BATCH).map(r => ({ noteId, sectionId: r.sectionId, ord: r.ord, heading: r.heading, body: r.body })),
    );
  }
  await tx
    .update(noteSearchState)
    .set({
      extractorVersion: extract.extractorVersion,
      sourceVersion,
      contentHash: extract.contentHash,
      indexedUnits: extract.indexedUnits,
      capped: extract.capped,
      indexedAt: sql`now()`,
    })
    .where(eq(noteSearchState.noteId, noteId));
  await hooks?.afterWriteForTest?.();
  return { outcome: "written", regressed };
}
