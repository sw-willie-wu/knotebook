/**
 * #175 T9／T10／T11（§6.7、S1、§7）：成員異動的交易本體。三支都以 `lockGroup` 開頭、S1 以另一條敘述 `countAdmins`
 * 計數（見 `groups/queries.ts` 檔頭）。本檔不 import `Db`、不接 `deps`；測試縫 `hook` 是型別明示的參數（S14 允許）——
 * S1 的並發測試靠它在「鎖已取得、寫入尚未發生」時讓第二個請求撞上同一把鎖。業務拒絕一律 throw `TxAbort`。
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { GROUP_NOT_FOUND_MESSAGE, builtinRoleId, countAdmins, groupNoteIdsQuery, lockGroup, roleInGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

const notFound = (): TxAbort => new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
const roleNotFound = (): TxAbort => new TxAbort(404, "role_not_found", "找不到此角色");
const lastAdmin = (): TxAbort => new TxAbort(409, "last_admin", "群組至少要有一位管理員");

/** T9：只新增（已是成員 → 409 `already_member`，**不動**既有角色）。`roleId` null＝內建一般成員。回實際掛上的角色。 */
export async function addMemberInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string; roleId: string | null },
  hook?: GroupTestHook,
): Promise<{ roleId: string; builtin: string | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const role =
    input.roleId === null
      ? { id: await builtinRoleId(tx, input.groupId, "member"), builtin: "member" }
      : await roleInGroup(tx, input.groupId, input.roleId);
  if (!role) throw roleNotFound();
  await hook?.("group-members-checked", { groupId: input.groupId });
  const inserted = await tx
    .insert(groupMembers)
    .values({ groupId: input.groupId, userId: input.targetUserId, roleId: role.id })
    .onConflictDoNothing()
    .returning({ userId: groupMembers.userId });
  if (inserted.length === 0) throw new TxAbort(409, "already_member", "此人已經是群組成員");
  return { roleId: role.id, builtin: role.builtin };
}

/**
 * T10：換角色（Q9 不防升權：含授予／收回內建管理員、含自己）。唯一硬限制 S1：目前持內建管理員、要換成別的角色、
 * 而且他是最後一位 → 409。角色沒變 → no-op（不 UPDATE、`noteIds` 為 null＝不踢線，比照 v1 F-1「值沒變就不踢」）。
 */
export async function setMemberRoleInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string; roleId: string },
  hook?: GroupTestHook,
): Promise<{ member: { email: string; displayName: string; roleId: string; builtin: string | null }; noteIds: string[] | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const next = await roleInGroup(tx, input.groupId, input.roleId);
  if (!next) throw roleNotFound();
  const [current] = await tx
    .select({ roleId: groupMembers.roleId, builtin: groupRoles.builtin, email: users.email, displayName: users.displayName })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  if (!current) throw notFound();
  const member = { email: current.email, displayName: current.displayName, roleId: next.id, builtin: next.builtin };
  if (current.roleId === next.id) return { member, noteIds: null };
  if (current.builtin === "admin" && next.builtin !== "admin" && (await countAdmins(tx, input.groupId)) <= 1) throw lastAdmin();
  await hook?.("group-members-checked", { groupId: input.groupId });
  await tx
    .update(groupMembers)
    .set({ roleId: next.id })
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  return { member, noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id) };
}

/** T11：移人／退出（S1）。回群組所有筆記的 id（commit 後踢線：群組所有筆記 × 那一人，§7）。 */
export async function removeMemberInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string },
  hook?: GroupTestHook,
): Promise<string[]> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [row] = await tx
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  if (!row) throw notFound();
  if (row.builtin === "admin" && (await countAdmins(tx, input.groupId)) <= 1) throw lastAdmin();
  await hook?.("group-members-checked", { groupId: input.groupId });
  await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  return (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id);
}
