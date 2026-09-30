import { and, eq, isNull } from "drizzle-orm";
import type { NotePermissions, Role } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, noteShares, notes } from "../db/schema.js";

// pg 的 uuid 欄位對「格式不合法的字串」（例如 "not-a-uuid"）會直接 throw
// `invalid input syntax for type uuid`，若讓它一路冒到 app.ts 的全域錯誤 handler，
// 會被歸類成 >=500 內部錯誤（Task 5 備忘：`:id` 這種路徑參數不可信任其格式）。
// 在查 DB 之前先用 regex 擋掉非法格式，直接回 'none'——效果上與「這個 id 找不到
// 對應的 note」一致，也不會洩漏任何額外資訊。
//
// 匯出供 routes/notes.ts 的 DELETE /api/notes/:id/shares/:userId 重用同一套 guard——
// `:userId` 路徑參數同樣不可信任其格式，且需要在觸碰 DB 之前擋掉非法 UUID（否則會
// 遇到同一個 "invalid input syntax for type uuid" 500 問題）。
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 刪除某篇筆記**當下**看得到它的所有 userId（owner ∪ 每一筆分享 ∪ 所屬群組裡角色有閱讀旗標的成員，
 * #175 §5.3）。群組筆記的 `owner_id` 是 NULL——濾掉，不讓 null 混進集合。
 *
 * 只有共編的刪除閘門用它（`CollabServer` 的 `markDeleting`／`releaseDeletingGate`）：閘門要能
 * 對「本來就看得到這篇筆記的人」說「它被刪掉了」，又不能對其他人透露這個 id 曾經存在——
 * 所以必須在刪除交易**之前**、那些列還在的時候，把名單抓下來留著（見 `collab/server.ts` 的
 * `deleting`）。⚠ S14：它走呼叫端給的連線；**不得在任何交易內以 pool 呼叫它**（`beforeNoteDeleted`
 * 一律在交易外）。筆記不存在（或 id 格式非法）時回空集合，`releaseDeletingGate` 也拿這一點當
 * 「筆記到底還在不在」的判準（`audience.size === 0` ⇒ 不收閘門）。個人筆記的 owner 恆在名單上；
 * 群組筆記沒有 owner，「還在 ⇒ 非空」要靠 S1（每個群組至少一位內建管理員，而內建管理員恆持
 * `can_read`）——S1 只在應用層守、DB 不擋；它一旦破裂，刪除失敗後的閘門不會收，要等 `DELETING_GATE_TTL_MS`（兩分鐘）到期。
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
 * #175 §5.2：群組筆記的 `role` 推導（TS 這一側）。SQL 那一側是 `visibleNoteBranches` grouped 支的
 * `CASE WHEN can_edit THEN 'editor' ELSE 'viewer' END`（JOIN 已要求 `can_read`）——兩處等價由
 * `groups-v2-visibility.test.ts` 的「同一組角色 fixture 比對兩者」守（gate r2 M-8）。
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

/** 群組筆記上的權限（§5.1）：`manageShares`／`moveToGroup` 恆 false（S5、W4）；改網址看管理公開連結（Q11）。 */
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

/** `resolveNoteAccess` 的回傳。`role === "none"` 時其餘欄一律 null／全 false（S4）。 */
export interface NoteAccess {
  role: Role;
  ownerId: string | null;
  /**
   * 判定當下讀到的 `notes.group_id`。單篇路徑拿它與「取到的那一列」比對：不一致＝授權與取列之間歸屬
   * 變了（PR2 的移動剛 commit），重讀一次、仍不一致 → 404（Q22）；PATCH 的 T1 拿它當 scope 條件（§4.3）。
   */
  groupId: string | null;
  permissions: NotePermissions;
}

const NO_ACCESS: NoteAccess = Object.freeze({ role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS });

/**
 * `resolveNoteAccess` 的單次 SELECT（只組不執行——EXPLAIN 測試與實作共用同一個形）：`notes`
 * LEFT JOIN `note_shares (note, $u)`（**只在個人筆記上**——群組筆記的殘留分享列不給任何權限，與清單
 * shared 支的 `group_id IS NULL` 一致；plan 規格落差第 2 條）LEFT JOIN `group_members (group, $u)`
 * LEFT JOIN `group_roles`。呼叫前 `noteId` 必須已過 `UUID_RE`。
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
    .where(eq(notes.id, noteId))
    .limit(1);
}

/**
 * #175 §5.2（B2）：取代 `resolveRoleWithOwner`。群組筆記的 `role` 從不是 `owner`；非成員的站台 admin
 * 在筆記上**沒有**任何特權（§5.5）。收 `DbOrTx`，交易內可重用（S14：交易內必須傳 `tx`）。
 */
export async function resolveNoteAccess(db: DbOrTx, userId: string, noteId: string): Promise<NoteAccess> {
  if (!UUID_RE.test(noteId)) return NO_ACCESS;
  const [row] = await accessQuery(db, userId, noteId);
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
 * 簽名凍結（#122 spec §3a M6-3）：collab/server、ai、links 等熱路徑呼叫點都吃這個形——
 * §2.4 的 14 處「不變」呼叫點一行不改就對群組筆記給出正確結果（群組 editor 就是 editor）。
 */
export async function resolveRole(db: DbOrTx, userId: string, noteId: string): Promise<Role> {
  return (await resolveNoteAccess(db, userId, noteId)).role;
}
