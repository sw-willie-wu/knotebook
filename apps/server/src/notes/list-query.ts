// #108：`GET /api/notes` 與 MCP 的 `list_notes`／`search_notes` 共用的「呼叫者看得見的筆記」查詢形狀。
// 可見性語意（owned ∪ shared ∪ grouped，#103 加第三支）**只能有一份**——抄第二份的漂移沒有任何
// 測試抓得到。
// ⚠ 其餘三份可見性查詢刻意不吃這支工廠（欄位集不同）：`notes/editing/candidates.ts` 的
// `visibleNoteTitles()`、`notes/service.ts` 的 `loadNoteAudience()`、`notes/links.ts` 的兩支——
// 各自手寫群組分支（#103 spec §5.3–§5.5；五份不統一列在 spec §12 第 6 條）。
import { and, eq, ne, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/index.js";
import { groupMembers, groups, noteShares, notes, users } from "../db/schema.js";

/** `users` 的第二個別名：JOIN 的是**編輯者**（`notes.last_edited_by`），與 owner 那次 JOIN
 * 同表不同人，不取別名 drizzle 產不出兩個 FROM 項。一律 LEFT JOIN——沒編輯過（欄位 null）
 * 或編輯者帳號已刪（FK `set null`）時，那一列仍要出現在結果裡。 */
export const editor = alias(users, "editor");
/** 三欄一組，三支 select 與 `noteWithOwnerSelection` 共用同一份定義——union 各支的 select shape
 * 必須逐欄同形，抄兩次遲早分岔。 */
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

/**
 * #103 §5.2：owned 與 grouped 兩支輸出的群組三欄——owner 一律看得到自己筆記的群組（含 A1：已退出
 * 群組的 owner）；grouped 的呼叫者由 INNER JOIN `group_members` 保證是成員。
 * `groupRole`／`groupName` 包成 `sql<string | null>`：drizzle 的 set operator 要求後面各支的列型別可
 * 指派給**第一支**（owned），而 shared 支這兩欄輸出 NULL——第一支的型別必須是可為 null 的那個。
 * 每次呼叫現造（不提成模組常數）。
 */
function groupColumns() {
  return {
    groupId: notes.groupId,
    groupRole: sql<string | null>`${notes.groupRole}`.as("group_role"),
    groupName: sql<string | null>`${groups.name}`.as("group_name"),
  };
}

/** shared 支的群組三欄一律 NULL：S5 下逐人分享的筆記沒有群組；S5 破了時非成員也不該拿到群組名（S4）。 */
function nullGroupColumns() {
  return {
    groupId: sql<string | null>`null::uuid`.as("group_id"),
    groupRole: sql<string | null>`null::text`.as("group_role"),
    groupName: sql<string | null>`null::text`.as("group_name"),
  };
}

/**
 * 呼叫者看得見的筆記＝owned ∪ shared ∪ grouped，三支**兩兩不重疊**（spec §5.2）：owned 與其餘兩支
 * 靠 `ne(owner_id, $u)`；shared 與 grouped 靠 grouped 的 `NOT EXISTS note_shares(note, $u)`——S5 成立時
 * 它恆真，S5 破了時它讓那一列只從 shared 支出來（role 取逐人分享的值；實際授權仍由
 * `resolveRoleWithOwner` 取 max）。
 *
 * ⚠ 三支的 select 物件**欄位順序必須一致**（基礎欄位 → 群組三欄 → `extra` → `role`）：union 按位置對欄。
 * **每次呼叫現造三支全新的 select builder**（drizzle 的 builder 可變且單次使用，重用會產出畸形
 * 查詢且不報錯）；`extraWhere` 由呼叫端提供，內部用 `and()` 合進去——**不要在回傳值上再
 * `.where()`**（是取代不是 AND，而且污染是回溯的）。`extra` 只收**額外的輸出欄**（`SQL.Aliased`，
 * 例如 search 的 `rank`）——**不要拿它去換掉基礎欄位集**。
 * ⚠ `and(cond, undefined)` 是安全的：drizzle 會濾掉 `undefined`，渲染出的字串與裸條件逐字相同。
 */
export function visibleNoteBranches<E extends Record<string, SQL.Aliased>>(
  db: Db,
  userId: string,
  opts: { extraWhere?: SQL; extra?: E } = {},
) {
  const extra = (opts.extra ?? {}) as E;
  const owned = db
    .select({ ...baseColumns, ...groupColumns(), ...extra, role: sql<string>`'owner'`.as("role") })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .where(and(eq(notes.ownerId, userId), opts.extraWhere));
  const shared = db
    .select({ ...baseColumns, ...nullGroupColumns(), ...extra, role: noteShares.role })
    .from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(ne(notes.ownerId, userId), opts.extraWhere));
  const grouped = db
    .select({ ...baseColumns, ...groupColumns(), ...extra, role: notes.groupRole })
    .from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groups, eq(groups.id, notes.groupId))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(
      and(
        ne(notes.ownerId, userId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(noteShares)
            .where(and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId))),
        ),
        opts.extraWhere,
      ),
    );
  return { owned, shared, grouped };
}
