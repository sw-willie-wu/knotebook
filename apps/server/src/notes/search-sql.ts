/**
 * #93 §7：全文搜尋的查詢**組裝**（只組不執行）。從 `mcp/queries.ts` 搬來並擴充（plan 裁定 R-builder）：MCP 與 PR2 的
 * REST 都經 `notes/search-query.ts` 的 `searchNotesForUser` 用它。`mcp/queries.ts` 檔頭的三條 drizzle 雷照樣成立：
 * 三支 select 每次現造、集合運算的 ORDER BY 只收輸出欄位名（所以 rank 先 `.as("rank")`）、不用 LIKE。
 *
 * 比對（§7.1）：標題 `position(lower(q) in lower(title)) > 0`；內文 `EXISTS (… note_search_sections … position(lower(q) in
 * lower(body)) > 0)`——兩者 OR 成一個 `extraWhere` 交給 `visibleNoteBranches`，三支各帶同一個相關子查詢。索引列與權限無關，
 * **可見性只來自三支 union**。`body_hit` 與 WHERE 各算一次同一個 EXISTS（各支 WHERE 不能引用自己的輸出別名；§7.2 末）。
 * rank（§7.2）：標題完全相等 0、前綴 1、包含 2、只中內文 3。
 *
 * matches 第二句（§7.3）：只吃第一句回來、`body_hit` 為真的那一頁 id（伺服器自己產生的清單），以 `inArray` 帶入——
 * **不得**寫成 `` sql`= ANY(${ids})` ``（drizzle 把 sql 模板裡的 JS 陣列展開成 `($1, $2, …)`，`ANY(($1,$2))` 報錯）。
 * 每篇最多 `SEARCH_MATCHES_PER_NOTE` 個、按 `ord`；窗口＝命中前 40、命中、命中後 160 個 code point（PG 的字元＝code point），
 * 摘錄在 JS 端選（`notes/search-snippet.ts`）。
 */
import { asc, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../db/tx.js";
import { noteSearchSections, notes } from "../db/schema.js";
import { visibleNoteBranches } from "./list-query.js";

export const SEARCH_MATCHES_PER_NOTE = 3;
export const SNIPPET_LEAD_CP = 40;
export const SNIPPET_TAIL_CP = 160;

export function buildNoteSearchQuery(db: DbOrTx, opts: { userId: string; query: string; limit: number }) {
  const q = opts.query;
  const titleHit = sql`position(lower(${q}) in lower(${notes.title})) > 0`;
  const bodyHit = sql`exists (select 1 from ${noteSearchSections} where ${noteSearchSections.noteId} = ${notes.id} and ${noteSearchSections.sourceKind} = 'note' and position(lower(${q}) in lower(${noteSearchSections.body})) > 0)`;
  const rank = sql<number>`case
    when lower(${notes.title}) = lower(${q}) then 0
    when position(lower(${q}) in lower(${notes.title})) = 1 then 1
    when ${titleHit} then 2
    else 3 end`.as("rank");
  const titleHitCol = sql<boolean>`${titleHit}`.as("title_hit");
  const bodyHitCol = sql<boolean>`${bodyHit}`.as("body_hit");
  const { owned, shared, grouped } = visibleNoteBranches(db, opts.userId, {
    extraWhere: or(titleHit, bodyHit),
    extra: { rank, titleHit: titleHitCol, bodyHit: bodyHitCol },
  });
  return unionAll(owned, shared, grouped)
    .orderBy(asc(rank), desc(notes.updatedAt), desc(notes.id))
    .limit(opts.limit + 1);
}

export type NoteSearchRow = Awaited<ReturnType<typeof buildNoteSearchQuery>>[number];

export type SearchMatchRow = {
  note_id: string;
  section_id: string;
  ord: number;
  heading: string;
  p: number;
  win_start: number;
  win: string;
  body_len: number;
} & Record<string, unknown>;

export function buildSearchMatchesQuery(opts: { query: string; ids: string[] }): SQL {
  const q = opts.query;
  return sql`with hits as (
    select ${noteSearchSections.noteId} as note_id, ${noteSearchSections.sectionId} as section_id, ${noteSearchSections.ord} as ord,
           ${noteSearchSections.heading} as heading, ${noteSearchSections.body} as body,
           position(lower(${q}) in lower(${noteSearchSections.body})) as p
    from ${noteSearchSections}
    where ${inArray(noteSearchSections.noteId, opts.ids)} and ${noteSearchSections.sourceKind} = 'note'
  ), ranked as (
    select *, row_number() over (partition by note_id order by ord) as rn from hits where p > 0
  )
  select note_id, section_id, ord, heading, p,
         greatest(p - ${SNIPPET_LEAD_CP}, 1) as win_start,
         substr(body, greatest(p - ${SNIPPET_LEAD_CP}, 1), ${SNIPPET_LEAD_CP} + char_length(${q}) + ${SNIPPET_TAIL_CP}) as win,
         char_length(body) as body_len
  from ranked where rn <= ${SEARCH_MATCHES_PER_NOTE}
  order by note_id, ord`;
}
