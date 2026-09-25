import { and, eq } from "drizzle-orm";
import type { Role } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, noteShares, notes } from "../db/schema.js";

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
 * 刪除某篇筆記**當下**看得到它的所有 userId（owner ＋ 每一筆分享 ＋ 所屬群組的全體成員，#103 §5.4）。
 *
 * 只有共編的刪除閘門用它（`CollabServer` 的 `markDeleting`／`releaseDeletingGate`）：閘門要能
 * 對「本來就看得到這篇筆記的人」說「它被刪掉了」，又不能對其他人透露這個 id 曾經存在——
 * 所以必須在刪除交易**之前**、那些列還在的時候，把名單抓下來留著（見 `collab/server.ts` 的
 * `deleting`）。漏掉群組成員的話，他們重連時聽到的會是「你已失去存取權」而不是「筆記已刪除」。
 * 筆記不存在（或 id 格式非法）時回空集合，`releaseDeletingGate` 也拿這一點當「筆記到底還在不在」的判準。
 */
export async function loadNoteAudience(db: Db, noteId: string): Promise<Set<string>> {
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
      : await db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, note.groupId));
  return new Set([note.ownerId, ...shares.map(one => one.userId), ...members.map(one => one.userId)]);
}

/**
 * 解析使用者對某篇 note 的角色：note 不存在（或 noteId 非合法 UUID 格式）→ 'none'；否則取三個
 * 來源的最大值（#103 spec §5.1：owner > editor > viewer > none）——① `notes.owner_id`；
 * ② `note_shares` 的逐人分享；③ 筆記有所屬群組且使用者是該群組成員時的 `notes.group_role`。
 *
 * 簽名凍結（#122 spec §3a M6-3）：collab/server、ai、links 等熱路徑呼叫點都吃這個形——需要
 * 其他欄位的呼叫端改用 `resolveRoleWithOwner`，不動這裡。
 */
export async function resolveRole(db: Db, userId: string, noteId: string): Promise<Role> {
  const { role } = await resolveRoleWithOwner(db, userId, noteId);
  return role;
}

/** `resolveRoleWithOwner` 的回傳。`role === "none"` 時其餘三欄一律是 null／false（S4：無權限者什麼都拿不到）。 */
export interface RoleResolution {
  role: Role;
  ownerId: string | null;
  /** 呼叫者是不是**判定當下**這篇所屬群組的成員（`notes.group_id` 為 null 時恆 false）。 */
  isGroupMember: boolean;
  /**
   * 判定當下讀到的 `notes.group_id`。單篇路徑拿它與「取到的那一列」的 `group_id` 比對，不一致就不採用
   * `isGroupMember`（授權與取列是兩次查詢，中間筆記可能換了群組——spec §6.5，S4）。
   */
  groupId: string | null;
}

const ROLE_RANK: Record<Role, number> = { none: 0, viewer: 1, editor: 2, owner: 3 };

function maxRole(candidates: readonly Role[]): Role {
  return candidates.reduce<Role>((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best), "none");
}

function noRole(): RoleResolution {
  return { role: "none", ownerId: null, isGroupMember: false, groupId: null };
}

/**
 * `resolveRoleWithOwner` 的單次 SELECT（只組不執行——EXPLAIN 測試與實作共用同一個形）：`notes`
 * LEFT JOIN `note_shares (note_id, $u)` 與 LEFT JOIN `group_members (notes.group_id, $u)`，三者都是
 * 主鍵查找。呼叫前 `noteId` 必須已過 `UUID_RE`。
 */
export function roleQuery(db: Db, userId: string, noteId: string) {
  return db
    .select({
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      groupRole: notes.groupRole,
      shareRole: noteShares.role,
      memberUserId: groupMembers.userId,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .where(eq(notes.id, noteId))
    .limit(1);
}

/**
 * `resolveRole` 的姊妹函式：同一次 SELECT 帶出 owner_id（auto slug 的 owner 範圍探測要它）、
 * 成員資格與判定當下的 `group_id`（`NoteDto.group` 的可見性判定要它，spec §6.5）。
 * **加欄位不改既有欄位**：既有的 `{ role }`／`{ role, ownerId }` 解構照常成立。
 * `group_members.role`（admin／member）不參與筆記權限。
 */
export async function resolveRoleWithOwner(db: Db, userId: string, noteId: string): Promise<RoleResolution> {
  if (!UUID_RE.test(noteId)) return noRole();

  const [row] = await roleQuery(db, userId, noteId);
  if (!row) return noRole();

  const isGroupMember = row.groupId !== null && row.memberUserId !== null;
  const candidates: Role[] = [];
  if (row.ownerId === userId) candidates.push("owner");
  if (row.shareRole !== null) candidates.push(row.shareRole as Role);
  if (isGroupMember) candidates.push(row.groupRole as Role);
  const role = maxRole(candidates);
  if (role === "none") return noRole();
  return { role, ownerId: row.ownerId, isGroupMember, groupId: row.groupId };
}
