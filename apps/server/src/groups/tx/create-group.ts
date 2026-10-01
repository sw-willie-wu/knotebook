/**
 * #175 T8（§6.7、S2）：建群組。同一交易建群組、兩個內建角色（管理員七旗標全真；一般成員 read／create／edit——
 * 與 0012 步驟 2 同一組旗標）、建立者掛管理員。本檔不 import `Db`、不接 `deps`（S14）。
 */
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups } from "../../db/schema.js";

export async function createGroupInTx(tx: Tx, input: { name: string; userId: string }) {
  const [group] = await tx.insert(groups).values({ name: input.name, createdBy: input.userId }).returning();
  const [admin] = await tx
    .insert(groupRoles)
    .values({
      groupId: group!.id,
      builtin: "admin",
      canRead: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canManagePublicLink: true,
      canManageMembers: true,
      canManageGroup: true,
    })
    .returning();
  await tx.insert(groupRoles).values({ groupId: group!.id, builtin: "member", canRead: true, canCreate: true, canEdit: true });
  await tx.insert(groupMembers).values({ groupId: group!.id, userId: input.userId, roleId: admin!.id });
  return { group: group!, adminRole: admin! };
}
