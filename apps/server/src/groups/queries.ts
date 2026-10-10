/**
 * #103／#175：群組的查詢建構與交易內輔助。路由在 `routes/groups.ts`；交易本體在 `groups/tx/*`（S14）。
 *
 * **S1（每個群組至少一位成員持內建管理員角色）的紀律**（spec §4.4、§5.1）：任何會改動 `group_members` 列或其
 * `role_id` 的交易，第一步 `lockGroup()`（`SELECT … FROM groups WHERE id=$g FOR UPDATE`），之後才用**另一條敘述**
 * `countAdmins()` 計數——READ COMMITTED 下後到者取得鎖後，新的敘述才拿得到新快照（gate r1 B-7：拿掉鎖、同交易計數 →
 * 兩邊都降級、最終 0 位管理員）。不可把鎖與計數併成同一條敘述、不可改用 REPEATABLE READ。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  GROUP_ROLE_NAME_MAX, normalizeRoleName, type BuiltinGroupRole, type GroupDto, type GroupRoleDto, type GroupRoleFlags,
} from "@knotebook/shared";
import type { DbOrTx, Tx } from "../db/tx.js";
import { groupMembers, groupRoles, groups, notes } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { hasUnstorableChar } from "../oauth/storable.js";

export type { DbOrTx, Tx } from "../db/tx.js";

/** 群組路由的 404 `not_found` 訊息——非成員／不存在／id 不合法三者必須逐位元組相同（S4）。 */
export const GROUP_NOT_FOUND_MESSAGE = "找不到此群組";
/** #175 PR4 刪群組・轉移的 409 `not_admin` 訊息——非 UUID／非成員／非內建管理員三者必須逐位元組相同（spec 疑點 Q2）。 */
export const NOT_ADMIN_MESSAGE = "轉移對象必須是這個群組的管理員";
export const GROUP_NAME_MAX = 80;

/**
 * 群組名稱驗證（D9）：先擋 NUL 與落單代理（重用 `oauth/storable.ts` 的 `hasUnstorableChar`）——NUL
 * 進 `text` 欄是 22021（會 500）；落單代理會被 pg 驅動編 UTF-8 時靜默換成 U+FFFD，擋它是為了不讓
 * 名稱被靜默破壞。再 trim，長度以 **code point** 計（與 DB `length()` 同單位——80 個 single-code-point
 * emoji，例如 😀，可以剛好塞滿；組合式 emoji（國旗、膚色修飾、ZWJ 序列）是多個 code point，塞不滿 80
 * 個，見 `docs/api.md`）。回 trim 後的名稱；不合法回 null。
 */
export function validateGroupName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_NAME_MAX ? name : null;
}

/** 角色欄位（每次呼叫現造——drizzle builder 單次使用）＋掛這個角色的成員數（correlated subquery）。 */
function roleColumns() {
  return {
    roleId: groupRoles.id,
    builtin: groupRoles.builtin,
    roleName: groupRoles.name,
    canRead: groupRoles.canRead,
    canCreate: groupRoles.canCreate,
    canEdit: groupRoles.canEdit,
    canDelete: groupRoles.canDelete,
    canManagePublicLink: groupRoles.canManagePublicLink,
    canManageMembers: groupRoles.canManageMembers,
    canManageGroup: groupRoles.canManageGroup,
    memberCount: sql<number>`(select count(*)::int from ${groupMembers} as gm2 where gm2.role_id = ${groupRoles.id})`,
  };
}

interface RoleColumnsRow {
  roleId: string | null;
  builtin: string | null;
  roleName: string | null;
  canRead: boolean | null;
  canCreate: boolean | null;
  canEdit: boolean | null;
  canDelete: boolean | null;
  canManagePublicLink: boolean | null;
  canManageMembers: boolean | null;
  canManageGroup: boolean | null;
  memberCount: number | null;
}

/** 角色欄 → DTO；LEFT JOIN 落空（非成員）回 null。 */
export function toGroupRoleDto(r: RoleColumnsRow): GroupRoleDto | null {
  if (r.roleId === null) return null;
  return {
    id: r.roleId,
    builtin: (r.builtin ?? null) as BuiltinGroupRole | null,
    name: r.roleName,
    permissions: {
      read: r.canRead === true,
      create: r.canCreate === true,
      edit: r.canEdit === true,
      delete: r.canDelete === true,
      managePublicLink: r.canManagePublicLink === true,
      manageMembers: r.canManageMembers === true,
      manageGroup: r.canManageGroup === true,
    },
    memberCount: r.memberCount ?? 0,
  };
}

/** `GroupDto`：兩個 `canManage*`＝角色旗標 OR 站台 admin（§5.5，不論是否成員——gate r2 M-3）。 */
export function toGroupDto(row: { id: string; name: string; createdAt: Date; autoVersions: boolean } & RoleColumnsRow, isSiteAdmin: boolean): GroupDto {
  const myRole = toGroupRoleDto(row);
  return {
    id: row.id,
    name: row.name,
    myRole,
    canManageMembers: (myRole?.permissions.manageMembers ?? false) || isSiteAdmin,
    canManageGroup: (myRole?.permissions.manageGroup ?? false) || isSiteAdmin,
    createdAt: row.createdAt.toISOString(),
    autoVersions: row.autoVersions,
  };
}

export interface GroupAccess {
  /** 呼叫者在群組裡的角色；非成員（只可能是站台 admin）為 null。 */
  role: GroupRoleDto | null;
  manageMembers: boolean;
  manageGroup: boolean;
}

/** 單一群組＋呼叫者的角色（只組不執行）：`groupAccess` 與 `POST`／`PATCH /api/groups…` 的回應共用。 */
export function groupWithMyRoleQuery(db: DbOrTx, groupId: string, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, autoVersions: groups.autoVersions, ...roleColumns() })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(groups.id, groupId))
    .limit(1);
}

/**
 * 呼叫者對群組的可見性與管理權（§5.4、§5.5）：回 null ＝ 一律 404（id 不合法、群組不存在、非成員且不是站台 admin），
 * 三者不可分辨（S4）。**無閱讀旗標的成員仍看得到群組本身**（§5.4 末句）。
 */
export async function groupAccess(db: DbOrTx, groupId: string, user: { id: string; isAdmin: boolean }): Promise<GroupAccess | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [row] = await groupWithMyRoleQuery(db, groupId, user.id);
  if (!row) return null;
  const dto = toGroupDto(row, user.isAdmin);
  if (dto.myRole === null && !user.isAdmin) return null;
  return { role: dto.myRole, manageMembers: dto.canManageMembers, manageGroup: dto.canManageGroup };
}

/** S1 的鎖（交易第一步）。群組不存在回 false（呼叫端 throw 404）。 */
export async function lockGroup(tx: Tx, groupId: string): Promise<boolean> {
  const rows = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("update");
  return rows.length > 0;
}

/** S1 的計數：持**內建管理員**角色的成員數（自訂角色勾滿七旗標也不算，§4.1）——**必須是 `lockGroup` 之後的另一條敘述**。 */
export async function countAdmins(tx: Tx, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupRoles.builtin, "admin")));
  return row?.n ?? 0;
}

/** 這個群組的某個角色（`roleId` 已過 UUID_RE）；不屬於該群組回 undefined（→ 404 `role_not_found`）。 */
export async function roleInGroup(db: DbOrTx, groupId: string, roleId: string) {
  const [row] = await db
    .select({ id: groupRoles.id, builtin: groupRoles.builtin })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
  return row;
}

/** 內建角色的 id（S9：每群組恰一個 admin、一個 member；「至少」在應用層——建群組同交易建兩個，§4.4）。 */
export async function builtinRoleId(db: DbOrTx, groupId: string, builtin: BuiltinGroupRole): Promise<string> {
  const [row] = await db
    .select({ id: groupRoles.id })
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.builtin, builtin)))
    .limit(1);
  if (!row) throw new Error(`群組 ${groupId} 缺內建 ${builtin} 角色（S9 被打破）`);
  return row.id;
}

/** `GET /api/groups`：我所屬的群組，依 name 再依 id（只組不執行——路由與 EXPLAIN 測試共用同一個形）。 */
export function listMyGroupsQuery(db: DbOrTx, userId: string) {
  return db
    .select({ id: groups.id, name: groups.name, createdAt: groups.createdAt, autoVersions: groups.autoVersions, ...roleColumns() })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(eq(groupMembers.userId, userId))
    .orderBy(asc(groups.name), asc(groups.id));
}

/**
 * `GET /api/groups/:id/roles`：內建管理員、內建一般成員、其餘依 `lower(name)`、`id`（排序見 spec §6.7）。可見性：任一成員
 * （Q18），加上非成員的站台 admin（plan 規格落差 13，與 `GET …/members` 同一條授權線）。
 */
export function listRolesQuery(db: DbOrTx, groupId: string) {
  return db
    .select(roleColumns())
    .from(groupRoles)
    .where(eq(groupRoles.groupId, groupId))
    .orderBy(
      sql`case ${groupRoles.builtin} when 'admin' then 0 when 'member' then 1 else 2 end`,
      sql`lower(${groupRoles.name})`,
      asc(groupRoles.id),
    );
}

/** 群組內所有筆記的 id（移人／換角色時的踢線名單；只組不執行）。走 `notes_group_slug_idx`（group_id 開頭）。 */
export function groupNoteIdsQuery(db: DbOrTx, groupId: string) {
  return db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, groupId));
}

/**
 * #175 PR3：自訂角色名稱（spec §4.1；gate r1 I6、r2 M-9）。先擋 NUL 與落單代理（`hasUnstorableChar`，比照 `validateGroupName`），
 * 再 trim → NFC，長度以 code point 計 1..40（與 DB `group_roles_name_len_chk` 同單位）。不合法回 null。保留名另由
 * `isReservedRoleName` 判（409，不是 400）。回的是**正規化後**的值——存這個，`' reader '` 與 `Reader` 才會在 `lower()` 索引下撞。
 */
export function validateRoleName(raw: string): string | null {
  if (hasUnstorableChar(raw)) return null;
  const name = normalizeRoleName(raw);
  const length = Array.from(name).length;
  return length >= 1 && length <= GROUP_ROLE_NAME_MAX ? name : null;
}

/** 六個可設旗標 → `group_roles` 欄。`can_read` 恆寫 true（閱讀恆真，plan spec 疑點 10）。 */
export function roleFlagValues(f: GroupRoleFlags) {
  return {
    canRead: true as const,
    canCreate: f.create,
    canEdit: f.edit,
    canDelete: f.delete,
    canManagePublicLink: f.managePublicLink,
    canManageMembers: f.manageMembers,
    canManageGroup: f.manageGroup,
  };
}

/** 單一角色（含 `memberCount`），列形同 `listRolesQuery`；不屬於該群組 → 空陣列（只組不執行）。 */
export function roleByIdQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select(roleColumns())
    .from(groupRoles)
    .where(and(eq(groupRoles.groupId, groupId), eq(groupRoles.id, roleId)))
    .limit(1);
}

/** 掛這個角色的成員（T12／T13 的踢線名單；只組不執行）。 */
export function roleHolderIdsQuery(db: DbOrTx, groupId: string, roleId: string) {
  return db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.roleId, roleId)));
}
