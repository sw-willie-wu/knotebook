/**
 * #93 §7.3：搜尋的呼叫端（本檔在 S14 的 `ROUTE_FILES`）。`.transaction(` 的 callback **恰為** `runNoteSearchInTx(tx, input)`，
 * 不帶第二引數——帶設定物件或設定常數都會讓 ④ 紅（隔離等級在本體第一句）。MCP `search_notes` 與 PR2 的 `GET /api/search`
 * 都呼叫它，兩者本身不新增 `.transaction(`。
 */
import type { Db } from "../db/index.js";
import type { SearchMatchRow } from "./search-sql.js";
import { runNoteSearchInTx, type NoteSearchInput, type NoteSearchResult } from "./tx/search-query.js";

export async function searchNotesForUser(db: Db, input: NoteSearchInput): Promise<NoteSearchResult> {
  return db.transaction(tx => runNoteSearchInTx(tx, input));
}

/** 依 note_id 分組；保留 SQL 的 `order by note_id, ord`，所以每組內是文件順序。 */
export function groupMatchesByNote(matches: SearchMatchRow[]): Map<string, SearchMatchRow[]> {
  const out = new Map<string, SearchMatchRow[]>();
  for (const m of matches) {
    const list = out.get(m.note_id);
    if (list) list.push(m);
    else out.set(m.note_id, [m]);
  }
  return out;
}
