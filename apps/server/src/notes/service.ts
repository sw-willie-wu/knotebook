import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { NotePermissions, Role } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, noteShares, notes } from "../db/schema.js";

// pg 的 uuid 欄位對「格式不合法的字串」（例如 "not-a-uuid"）會直接 throw
// `invalid input syntax for type uuid`，若讓它一路冒到 app.ts 的全域錯誤 handler，
// 會被歸類成 >=500 內部錯誤（`:id` 這種路徑參數不可信任其格式）。
// 在查 DB 之前先用 regex 擋掉非法格式，直接回 'none'——效果上與「這個 id 找不到
// 對應的 note」一致，也不會洩漏任何額外資訊。
//
// 匯出供 routes/notes.ts 的 DELETE /api/notes/:id/shares/:userId 重用同一套 guard——
// `:userId` 路徑參數同樣不可信任其格式，且需要在觸碰 DB 之前擋掉非法 UUID（否則會
// 遇到同一個 "invalid input syntax for type uuid" 500 問題）。
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 刪除某篇筆記**當下**看得到它的所有 userId（owner ∪ 每一筆分享 ∪ 所屬群組裡角色有閱讀旗標的成員，
 * #175）。群組筆記的 `owner_id` 是 NULL——濾掉，不讓 null 混進集合。
 *
 * 只有共編刪除閘門的 `markDeleting`（`CollabServer`）用它：閘門要能對「本來就看得到這篇筆記的人」
 * 說「它被刪掉了」，又不能對其他人透露這個 id 曾經存在——所以必須在移入交易**之前**把名單抓下來
 * 留著（見 `collab/server.ts` 的 `deleting`）。⚠ S14：它走呼叫端給的連線；**不得在任何交易內以 pool
 * 呼叫它**（`beforeNoteDeleted` 一律在交易外）。筆記不存在（或 id 格式非法）時回空集合；**不濾
 * `deleted_at`**（垃圾桶筆記照回名單）。`releaseDeletingGate` 判「筆記還在不在」改用 `noteIsLive`
 * （#181：垃圾桶裡的筆記名單非空，拿名單判會收掉別人成功移入的閘門）。
 */
export async function loadNoteAudience(db: DbOrTx, noteId: string): Promise<Set<string>> {
  if (!UUID_RE.test(noteId)) return new Set();

  const [note] = await db
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(eq(notes.id, noteId))
    .limit(1);
  if (!note) return new Set();

  const shares = await db
    .select({ userId: noteShares.userId })
    .from(noteShares)
    .where(eq(noteShares.noteId, noteId));
  const members =
    note.groupId === null
      ? []
      : await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
          .where(eq(groupMembers.groupId, note.groupId));
  const ids = [note.ownerId, ...shares.map(one => one.userId), ...members.map(one => one.userId)];
  return new Set(ids.filter((id): id is string => id !== null));
}

/** 群組角色中參與筆記權限的四個旗標（另三個——新建、管理成員、管理角色與群組——不作用在單篇筆記上）。 */
export interface NoteGroupFlags {
  canRead: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManagePublicLink: boolean;
}

/**
 * #175：群組筆記的 `role` 推導（TS 這一側）。SQL 那一側是 `visibleNoteBranches` grouped 支的
 * `CASE WHEN can_edit THEN 'editor' ELSE 'viewer' END`（JOIN 已要求 `can_read`）——兩處等價由
 * `groups-v2-visibility.test.ts` 的「同一組角色 fixture 比對兩者」守。
 * `can_edit ⇒ can_read` 由 DB `group_roles_read_implied_chk` 保證，所以先看 edit 不會給出「能寫不能讀」。
 */
export function roleFromGroupFlags(r: { canRead: boolean; canEdit: boolean }): Role {
  if (r.canEdit) return "editor";
  if (r.canRead) return "viewer";
  return "none";
}

export const NO_PERMISSIONS: NotePermissions = Object.freeze({
  read: false, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false,
});
export const OWNER_PERMISSIONS: NotePermissions = Object.freeze({
  read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true,
});

/** 逐人分享者在個人筆記上的權限（只有讀／寫；刪除、分享、公開連結、改網址都只屬於 owner）。 */
export function sharePermissions(role: "editor" | "viewer"): NotePermissions {
  return { ...NO_PERMISSIONS, read: true, edit: role === "editor" };
}

/** 群組筆記上的權限：`manageShares`／`moveToGroup` 恆 false；改網址看管理公開連結。 */
export function groupNotePermissions(f: NoteGroupFlags): NotePermissions {
  if (!f.canRead) return NO_PERMISSIONS;
  return {
    read: true,
    edit: f.canEdit,
    delete: f.canDelete,
    manageShares: false,
    managePublicLink: f.canManagePublicLink,
    changeSlug: f.canManagePublicLink,
    moveToGroup: false,
  };
}

/** `resolveNoteAccess` 的回傳。`role === "none"` 時其餘欄一律 null／全 false。 */
export interface NoteAccess {
  role: Role;
  ownerId: string | null;
  /**
   * 判定當下讀到的 `notes.group_id`。單篇路徑拿它與「取到的那一列」比對：不一致＝授權與取列之間歸屬
   * 變了（例如移動剛 commit），重讀一次、仍不一致 → 404；PATCH 的 T1 拿它當 scope 條件。
   */
  groupId: string | null;
  permissions: NotePermissions;
}

const NO_ACCESS: NoteAccess = Object.freeze({ role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS });

/**
 * `resolveNoteAccess` 的單次 SELECT（只組不執行——EXPLAIN 測試與實作共用同一個形）：`notes`
 * LEFT JOIN `note_shares (note, $u)`（**只在個人筆記上**——群組筆記的殘留分享列不給任何權限，與清單
 * shared 支的 `group_id IS NULL` 一致）LEFT JOIN `group_members (group, $u)`
 * LEFT JOIN `group_roles`。呼叫前 `noteId` 必須已過 `UUID_RE`。
 * #181：只看活筆記（`deleted_at IS NULL`）——垃圾桶裡的筆記對單篇授權一律 none。
 */
export function accessQuery(db: DbOrTx, userId: string, noteId: string) {
  return db
    .select({
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      shareRole: noteShares.role,
      roleId: groupRoles.id,
      canRead: groupRoles.canRead,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId), isNull(notes.groupId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .limit(1);
}

/**
 * #181：與 `accessQuery` 同 select／同 join，只看垃圾桶（`deleted_at IS NOT NULL`）。兩支各自一個完整 builder
 * （守衛分類用，不共用 FROM 片段）；沒有「兩者皆可」的形。呼叫前 `noteId` 必須已過 `UUID_RE`。
 */
export function trashedAccessQuery(db: DbOrTx, userId: string, noteId: string) {
  return db
    .select({
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      shareRole: noteShares.role,
      roleId: groupRoles.id,
      canRead: groupRoles.canRead,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId), isNull(notes.groupId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
}

export type AccessRow = Awaited<ReturnType<typeof accessQuery>>[number];

/**
 * `resolveNoteAccess` 的推導本體（純函式；#181：`tx/` 檔不准寫 `resolveNoteAccess(` 字面，交易內改寫
 * `noteAccessFromRow((await accessQuery(tx, by, id))[0], by)`——同一個查詢形、同一份推導）。row 為 undefined → none。
 */
export function noteAccessFromRow(row: AccessRow | undefined, userId: string): NoteAccess {
  if (!row) return NO_ACCESS;

  if (row.groupId === null) {
    if (row.ownerId === userId) return { role: "owner", ownerId: row.ownerId, groupId: null, permissions: OWNER_PERMISSIONS };
    if (row.shareRole === "editor" || row.shareRole === "viewer") {
      return { role: row.shareRole, ownerId: row.ownerId, groupId: null, permissions: sharePermissions(row.shareRole) };
    }
    return NO_ACCESS;
  }

  if (row.roleId === null) return NO_ACCESS;
  const flags: NoteGroupFlags = {
    canRead: row.canRead ?? false,
    canEdit: row.canEdit ?? false,
    canDelete: row.canDelete ?? false,
    canManagePublicLink: row.canManagePublicLink ?? false,
  };
  const role = roleFromGroupFlags(flags);
  if (role === "none") return NO_ACCESS;
  return { role, ownerId: null, groupId: row.groupId, permissions: groupNotePermissions(flags) };
}

/**
 * #175：取代 `resolveRoleWithOwner`。群組筆記的 `role` 從不是 `owner`；非成員的站台 admin
 * 在筆記上**沒有**任何特權。收 `DbOrTx`，交易內可重用（S14：交易內必須傳 `tx`）。
 */
export async function resolveNoteAccess(db: DbOrTx, userId: string, noteId: string): Promise<NoteAccess> {
  if (!UUID_RE.test(noteId)) return NO_ACCESS;
  return noteAccessFromRow((await accessQuery(db, userId, noteId))[0], userId);
}

/**
 * #181：垃圾桶權（看得到／還原／永久刪除三格一致）。個人筆記＝owner（逐人分享不算）；群組筆記＝成員且角色
 * `can_edit AND can_delete`。row 為 undefined → false。
 */
export function trashRightFromRow(row: AccessRow | undefined, userId: string): boolean {
  if (!row) return false;
  if (row.groupId === null) return row.ownerId === userId;
  if (row.roleId === null) return false;
  return row.canEdit === true && row.canDelete === true;
}

/**
 * #181：**只**回垃圾桶裡的筆記的垃圾桶權（活筆記、不存在、非 UUID 一律 false）。沒有「兩者皆可」的模式——
 * 一般路由一律走 `resolveNoteAccess`。
 */
export async function resolveTrashedNoteAccess(db: DbOrTx, userId: string, noteId: string): Promise<boolean> {
  if (!UUID_RE.test(noteId)) return false;
  return trashRightFromRow((await trashedAccessQuery(db, userId, noteId))[0], userId);
}

/** #181：筆記存在且不在垃圾桶（非 UUID → false，不進 SQL）。 */
export async function noteIsLive(db: DbOrTx, noteId: string): Promise<boolean> {
  if (!UUID_RE.test(noteId)) return false;
  const rows = await db.select({ one: sql`1` }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt))).limit(1);
  return rows.length > 0;
}

/**
 * 簽名凍結（#122-3）：collab/server、ai、links 等熱路徑呼叫點都吃這個形——
 * 14 處「不變」呼叫點一行不改就對群組筆記給出正確結果（群組 editor 就是 editor）。
 */
export async function resolveRole(db: DbOrTx, userId: string, noteId: string): Promise<Role> {
  return (await resolveNoteAccess(db, userId, noteId)).role;
}
