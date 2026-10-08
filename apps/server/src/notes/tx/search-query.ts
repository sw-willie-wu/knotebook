/**
 * #93 §7.3：搜尋的交易本體（S14：只收 `tx` 與純資料）。兩句在同一個 `REPEATABLE READ READ ONLY` 交易（M6）：第二句看到的
 * 可見性與索引狀態與第一句是同一個快照（撤分享、索引替換都不會落在兩句之間）。
 * **第一句是 `tx.setTransaction(...)`**（drizzle 發 `set transaction …`；PG 要求它在交易內任何查詢之前，這裡成立）——隔離等級
 * 因此寫在本體內，呼叫端 `db.transaction(tx => runNoteSearchInTx(tx, input))` 不帶第二引數（S14 ④）。S18 釘住。
 * 儲存配額 spec 的守衛 ⑥ 正縮限到它自己的檔案範圍，本檔的 `setTransaction` 不在其禁止之列（spec §7.3）。
 * 第二句只在 id 清單非空時發出；id 清單取自第一句的前 `limit` 列（第 `limit + 1` 列只用來判 truncated）。
 */
import type { Tx } from "../../db/tx.js";
import { buildNoteSearchQuery, buildSearchMatchesQuery, type NoteSearchRow, type SearchMatchRow } from "../search-sql.js";

export interface NoteSearchInput {
  userId: string;
  query: string;
  limit: number;
}

export interface NoteSearchResult {
  rows: NoteSearchRow[];
  matches: SearchMatchRow[];
}

export async function runNoteSearchInTx(tx: Tx, input: NoteSearchInput): Promise<NoteSearchResult> {
  await tx.setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" });
  const rows = await buildNoteSearchQuery(tx, input);
  const ids = rows.slice(0, input.limit).filter(r => r.bodyHit).map(r => r.id);
  const matches = ids.length === 0 ? [] : (await tx.execute<SearchMatchRow>(buildSearchMatchesQuery({ query: input.query, ids }))).rows;
  return { rows, matches };
}
