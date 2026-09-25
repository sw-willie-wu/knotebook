/**
 * #103：群組的查詢建構與交易內輔助。路由在 `routes/groups.ts`（群組管理）與 `routes/notes.ts`
 * （筆記歸屬、`POST /api/notes {groupId}`）。
 *
 * **S1（每個群組至少一位 admin）的紀律**（spec §4.3）：任何會改動 `group_members` 列或其 `role` 的交易，
 * 第一步 `lockGroup()`（`SELECT … FROM groups WHERE id=$g FOR UPDATE`），之後才用**另一條敘述**
 * `countAdmins()` 計數——READ COMMITTED 下後到者取得鎖後，新的敘述才拿得到新快照（spec gate r2 E 實跑）。
 * 不可把鎖與計數併成同一條敘述、不可改用 REPEATABLE READ。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { GroupMemberRole } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groups, notes } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { hasUnstorableChar } from "../oauth/storable.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** 群組路由的 404 `not_found` 訊息——非成員／不存在／id 不合法三者必須逐位元組相同（S4）。 */
export const GROUP_NOT_FOUND_MESSAGE = "找不到此群組";
export const GROUP_NAME_MAX = 80;

/**
 * 群組名稱驗證（D9）：先擋 NUL 與落單代理（重用 `oauth/storable.ts` 的 `hasUnstorableChar`）——NUL
 * 進 `text` 欄是 22021（會 500）；落單代理會被 pg 驅動編 UTF-8 時靜默換成 U+FFFD，擋它是為了不讓
 * 名稱被靜默破壞。再 trim，長度以 **code point** 計（與 DB `length()` 同單位——80 個 emoji 合法，
 * 雖然 UTF-16 長度是 160）。回 trim 後的名稱；不合法回 null。
 */
export function validateGroupName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_NAME_MAX ? name : null;
}

export interface GroupAccess {
  /** 呼叫者在群組裡的角色；非成員（只可能是站台 admin）為 null。 */
  memberRole: GroupMemberRole | null;
  /** 群組 admin，或站台 admin（spec §6.1：站台 admin 視同每個群組的 admin，只在 API 層）。 */
  canAdmin: boolean;
}

/**
 * 呼叫者對群組的可見性（spec §5.6／§6.1）：回 null ＝ 一律 404（id 不合法、群組不存在、非成員且不是
 * 站台 admin）。三者在輸出上不可分辨（S4）。
 */
export async function groupAccess(
  db: DbOrTx,
  groupId: string,
  user: { id: string; isAdmin: boolean },
): Promise<GroupAccess | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [row] = await db
    .select({ id: groups.id, memberRole: groupMembers.role })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, user.id)))
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!row) return null;
  const memberRole = (row.memberRole ?? null) as GroupMemberRole | null;
  if (memberRole === null && !user.isAdmin) return null;
  return { memberRole, canAdmin: memberRole === "admin" || user.isAdmin };
}

/** S1 的鎖（交易第一步）。群組不存在回 false（呼叫端 throw 404）。 */
export async function lockGroup(tx: Tx, groupId: string): Promise<boolean> {
  const rows = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("update");
  return rows.length > 0;
}

/** S1 的計數——**必須是 `lockGroup` 之後的另一條敘述**（見檔頭）。 */
export async function countAdmins(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "admin")));
  return row?.n ?? 0;
}

/** `GET /api/groups`：我所屬的群組，依 name 再依 id（只組不執行——路由與 EXPLAIN 測試共用同一個形）。 */
export function listMyGroupsQuery(db: DbOrTx, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, myRole: groupMembers.role, createdAt: groups.createdAt })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId))
    .orderBy(asc(groups.name), asc(groups.id));
}

/** 群組內所有筆記的 id（移人時的踢線名單；只組不執行）。 */
export function groupNoteIdsQuery(db: DbOrTx, groupId: string) {
  return db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, groupId));
}

/** 群組全體成員的 userId（筆記移出／換群組、改 `group_role` 時的踢線名單）。 */
export async function groupMemberIds(db: DbOrTx, groupId: string): Promise<string[]> {
  const rows = await db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
  return rows.map(r => r.userId);
}
