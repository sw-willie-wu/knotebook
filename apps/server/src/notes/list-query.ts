// #108：`GET /api/notes` 與 MCP 的 `list_notes`／`search_notes` 共用的「呼叫者看得見的筆記」查詢形狀。
// 可見性語意（owned ∪ shared ∪ grouped）**只能有一份**——抄第二份的漂移沒有任何測試抓得到。
// ⚠ 其餘四份可見性查詢刻意不吃這支工廠（欄位集不同）：`notes/editing/candidates.ts` 的
// `visibleNoteTitles()`、`notes/service.ts` 的 `loadNoteAudience()`、`notes/links.ts` 的 `fetchBacklinks()`、
// `notes/tx/write-links.ts` 的 `writeLinksInTx()`——各自手寫群組分支（#175 §5.3；連同本檔共五份，
// 不統一列在 spec §15 第 6 條）。
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, groups, noteShares, notes, users } from "../db/schema.js";
import { OWNER_PERMISSIONS, groupNotePermissions, roleFromGroupFlags, sharePermissions, type NoteAccess } from "./service.js";

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

/**
 * 固定的基礎欄位集＝`GET /api/notes` 今天那一組（MCP 端只取其中一部分，多取幾欄不影響它自己的 DTO）。
 * `ownerHandle` 包成 `sql<string | null>`（#175 §5.3）：drizzle 的 set operator 要求後面各支的列型別可指派給
 * **第一支**（owned），而 grouped 支 LEFT JOIN users 輸出 NULL——第一支的型別必須是可為 null 的那個。
 * 每次呼叫現造（不提成模組常數：builder 單次使用）。
 */
function baseColumns() {
  return {
    id: notes.id,
    title: notes.title,
    ownerId: notes.ownerId,
    slug: notes.slug,
    slugIsCustom: notes.slugIsCustom,
    prevSlug: notes.prevSlug,
    ownerHandle: sql<string | null>`${users.handle}`.as("owner_handle"),
    createdAt: notes.createdAt,
    updatedAt: notes.updatedAt,
    ...lastEditedSelection,
  };
}

/**
 * 群組四欄：owned／shared 兩支恆 NULL（`owner_id = $u` 與 `group_id IS NULL` 結構上排除群組筆記；S5 破了時
 * 非成員也不該拿到群組名，S4）；grouped 支輸出群組 id／名稱與呼叫者角色的兩個筆記旗標（`accessFromListRow`
 * 組 `permissions` 用——read／edit 由 `role` 推得，不另帶）。`sql<… | null>` 的理由同 `ownerHandle`。
 */
function nullGroupColumns() {
  return {
    groupId: sql<string | null>`null::uuid`.as("group_id"),
    groupName: sql<string | null>`null::text`.as("group_name"),
    groupCanDelete: sql<boolean | null>`null::boolean`.as("group_can_delete"),
    groupCanManagePublicLink: sql<boolean | null>`null::boolean`.as("group_can_manage_public_link"),
  };
}
function groupColumns() {
  return {
    groupId: sql<string | null>`${notes.groupId}`.as("group_id"),
    groupName: sql<string | null>`${groups.name}`.as("group_name"),
    groupCanDelete: sql<boolean | null>`${groupRoles.canDelete}`.as("group_can_delete"),
    groupCanManagePublicLink: sql<boolean | null>`${groupRoles.canManagePublicLink}`.as("group_can_manage_public_link"),
  };
}

/**
 * 呼叫者看得見的筆記＝owned ∪ shared ∪ grouped，三支**結構性互斥**（#175 §5.3）：owned＝`owner_id = $u`；
 * shared＝`group_id IS NULL` 且有 `note_shares(note, $u)` 且 `owner_id <> $u`；grouped＝`group_id IS NOT NULL`
 * （INNER JOIN `group_members` 已隱含）且角色 `can_read`。群組筆記上若有殘留分享列（S5 破裂），shared 支
 * 以 `group_id IS NULL` 明寫排除——不靠 `owner_id <> $u` 對 NULL 求值剛好為假。群組筆記沒有 owner：
 * grouped 支的 users 是 LEFT JOIN（`ownerHandle` 為 NULL）。
 * grouped 支的 `role`＝`CASE WHEN can_edit THEN 'editor' ELSE 'viewer' END`，與 `roleFromGroupFlags` 同規則
 * （`groups-v2-visibility.test.ts` 的「TS／SQL 兩處推導等價」案逐列比對兩者）。
 *
 * ⚠ 三支的 select 物件**欄位順序必須一致**（基礎欄位 → 群組四欄 → `extra` → `role`）：union 按位置對欄。
 * **每次呼叫現造三支全新的 select builder**（drizzle 的 builder 可變且單次使用，重用會產出畸形
 * 查詢且不報錯）；`extraWhere` 由呼叫端提供，內部用 `and()` 合進去——**不要在回傳值上再
 * `.where()`**（是取代不是 AND，而且污染是回溯的）。`extra` 只收**額外的輸出欄**（`SQL.Aliased`，
 * 例如 search 的 `rank`）——**不要拿它去換掉基礎欄位集**。
 * ⚠ `and(cond, undefined)` 是安全的：drizzle 會濾掉 `undefined`，渲染出的字串與裸條件逐字相同。
 */
export function visibleNoteBranches<E extends Record<string, SQL.Aliased>>(
  db: DbOrTx,
  userId: string,
  opts: { extraWhere?: SQL; extra?: E } = {},
) {
  const extra = (opts.extra ?? {}) as E;
  const owned = db
    .select({ ...baseColumns(), ...nullGroupColumns(), ...extra, role: sql<string>`'owner'`.as("role") })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(eq(notes.ownerId, userId), opts.extraWhere));
  const shared = db
    .select({ ...baseColumns(), ...nullGroupColumns(), ...extra, role: noteShares.role })
    .from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(isNull(notes.groupId), sql`${notes.ownerId} <> ${userId}`, opts.extraWhere));
  const grouped = db
    .select({
      ...baseColumns(),
      ...groupColumns(),
      ...extra,
      role: sql<string>`case when ${groupRoles.canEdit} then 'editor' else 'viewer' end`.as("role"),
    })
    .from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .innerJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .where(and(sql`${notes.groupId} is not null`, opts.extraWhere));
  return { owned, shared, grouped };
}

/**
 * 清單一列的 `role`／`permissions`（`GET /api/notes` 的 `toNoteDto` 用）。grouped 支的 `role` 已由 SQL `CASE` 推得，
 * 這裡把它與兩個旗標欄還原成 `NoteGroupFlags` 再走 `groupNotePermissions`——與單篇路徑的 `resolveNoteAccess`
 * 同一份規則（`groups-v2-visibility.test.ts` 的等價案逐列比對兩者）。
 */
export function accessFromListRow(row: {
  role: string;
  groupId: string | null;
  groupCanDelete: boolean | null;
  groupCanManagePublicLink: boolean | null;
}): Pick<NoteAccess, "role" | "permissions"> {
  if (row.groupId !== null) {
    const flags = {
      canRead: true,
      canEdit: row.role === "editor",
      canDelete: row.groupCanDelete === true,
      canManagePublicLink: row.groupCanManagePublicLink === true,
    };
    return { role: roleFromGroupFlags(flags), permissions: groupNotePermissions(flags) };
  }
  if (row.role === "owner") return { role: "owner", permissions: OWNER_PERMISSIONS };
  const share = row.role === "editor" ? "editor" : "viewer";
  return { role: share, permissions: sharePermissions(share) };
}
