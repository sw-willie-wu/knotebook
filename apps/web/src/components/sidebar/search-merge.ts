import type { NoteDto, NoteSearchHitDto, NoteSearchMatchDto } from "@knotebook/shared";

/** 合併後的一列：一篇筆記只出現一次。`matches` 是 server 回的內文片段（至多 3 個）；只有標題命中的為 `[]`。 */
export interface MergedRow {
  note: NoteDto;
  titleHit: boolean;
  matches: NoteSearchMatchDto[];
}

/**
 * #93 PR2：把「標題符合」（client 對 `useNotes()` 清單算的）與「內文符合」（server hits）合成一個列表，**同一篇只出現一次**（以 id 去重）。
 * 排序：標題有命中的在前（照清單順序，與合併前的標題區相同），其餘照 server 順序。
 * - 連結與標題一律用清單裡那筆 `NoteDto`（hit 與清單交叉比對：不在清單的 hit 不顯示——被改名／搬走／進垃圾桶的舊結果不會連到舊路徑）。
 * - `matchedOn: "title"` 的 hit 不帶片段，也不單獨成列（標題命中以清單為準）。
 */
export function mergeSearchRows(titleNotes: NoteDto[], hits: NoteSearchHitDto[], notes: NoteDto[]): MergedRow[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows = new Map<string, MergedRow>();
  for (const note of titleNotes) rows.set(note.id, { note, titleHit: true, matches: [] });
  for (const h of hits) {
    if (h.matchedOn === "title") continue;
    const listNote = byId.get(h.note.id);
    if (!listNote) continue;
    const existing = rows.get(listNote.id);
    if (existing) existing.matches = h.matches;
    else rows.set(listNote.id, { note: listNote, titleHit: false, matches: h.matches });
  }
  return Array.from(rows.values());
}

/**
 * 側欄實際列出的一項（沒有「筆記一層」）：`match` ＝一個含查詢字的段落（server 每個段落只取第一個命中，所以一個段落裡出現好幾次還是一項，
 * 點了跳到第一個；每篇最多 3 個段落）。三行：標題、位置標籤、片段；
 * `title` ＝這篇只有標題命中（兩行：標題、路徑；點了開筆記、不帶查詢字）。
 */
export type ResultItem =
  | { kind: "match"; note: NoteDto; match: NoteSearchMatchDto }
  | { kind: "title"; note: NoteDto };

/**
 * 把 `mergeSearchRows` 的一篇一列攤平：有內文片段的篇，每個片段（＝一個段落）一項（同篇連在一起、照 server 回來的 matches 順序）；
 * 沒有片段的（只有標題命中）一項 `title`。同一篇標題與內文都命中時只列內文各項，不另外再列一項「只有標題」。
 * 篇與篇之間的順序照 `mergeSearchRows`（標題命中的篇在前，其餘照 server 順序）。
 */
export function flattenRows(rows: MergedRow[]): ResultItem[] {
  return rows.flatMap((row): ResultItem[] =>
    row.matches.length === 0 ? [{ kind: "title", note: row.note }] : row.matches.map((match) => ({ kind: "match", note: row.note, match })),
  );
}
