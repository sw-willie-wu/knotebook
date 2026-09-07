// #108：`GET /api/notes` 與 MCP 的 `list_notes`／`search_notes` 共用的「呼叫者看得見的
// 筆記」查詢形狀。可見性語意（owned ∪ shared，含 shared 分支那條防禦縱深的
// `ne(owner_id, $u)`）**只能有一份**——抄第二份的漂移沒有任何測試抓得到
// （`shares.test.ts` 的「GET /api/notes 清單去重」只守 REST 那一條）。
// ⚠ 刻意不動的第三份：`notes/editing/candidates.ts` 的 `visibleNoteTitles()`（欄位集不同、
// 無 join，吃這支工廠會改變它的 SQL，而它在 wikilink 重綁路徑上）——列為誠實缺口。
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/index.js";
import { noteShares, notes, users } from "../db/schema.js";

/** `users` 的第二個別名：JOIN 的是**編輯者**（`notes.last_edited_by`），與 owner 那次 JOIN
 * 同表不同人，不取別名 drizzle 產不出兩個 FROM 項。一律 LEFT JOIN——沒編輯過（欄位 null）
 * 或編輯者帳號已刪（FK `set null`）時，那一列仍要出現在結果裡。 */
export const editor = alias(users, "editor");
/** 三欄一組，`ownedSelect`／`sharedSelect`／`noteWithOwnerSelection` 共用同一份定義——union
 * 兩支的 select shape 必須逐欄同形，抄兩次遲早分岔。 */
export const lastEditedSelection = {
  lastEditedAt: notes.lastEditedAt,
  lastEditedAgentLabel: notes.lastEditedAgentLabel,
  editorHandle: editor.handle,
};

/** 固定的基礎欄位集＝`GET /api/notes` 今天那一組（MCP 端只取其中一部分，多取幾欄不影響
 *  它自己的 DTO）。 */
const baseColumns = {
  id: notes.id,
  title: notes.title,
  ownerId: notes.ownerId,
  slug: notes.slug,
  slugIsCustom: notes.slugIsCustom,
  prevSlug: notes.prevSlug,
  ownerHandle: users.handle,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
  ...lastEditedSelection,
};

/** 呼叫者看得見的筆記＝owned ∪ shared。**每次呼叫現造兩支全新的 select builder**（drizzle 的
 *  builder 可變且單次使用，重用會產出多一段 `union all` 的畸形查詢且不報錯）；`extraWhere`
 *  由呼叫端提供，內部用 `and()` 合進去——**不要在回傳值上再 `.where()`**（drizzle 的
 *  `.where()` 是取代不是 AND，而且污染是回溯的）。`extra` 只收**額外的輸出欄**
 *  （`SQL.Aliased`，例如 search 的 `rank`）——**不要拿它去換掉基礎欄位集**。
 *  ⚠ `and(cond, undefined)` 是安全的：drizzle 會濾掉 `undefined`，渲染出的字串與裸條件
 *  逐字相同、也不多出參數槽（`GET /api/notes` 改吃這支之後 `.toSQL()` 逐位元組不變）。 */
export function visibleNoteBranches<E extends Record<string, SQL.Aliased>>(
  db: Db,
  userId: string,
  opts: { extraWhere?: SQL; extra?: E } = {},
) {
  const extra = (opts.extra ?? {}) as E;
  const owned = db
    .select({ ...baseColumns, ...extra, role: sql<string>`'owner'`.as("role") })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(eq(notes.ownerId, userId), opts.extraWhere));
  const shared = db
    .select({ ...baseColumns, ...extra, role: noteShares.role })
    .from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(ne(notes.ownerId, userId), opts.extraWhere));
  return { owned, shared };
}
