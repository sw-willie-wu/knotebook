/**
 * #175 PR3 T12／T13（spec §6 交易表、§6.7、§7、S14）：自訂角色的修改與刪除。兩支都以 `lockGroup` 開頭——與 T6／T7（刪群組）、T9–T11
 * 同一把 groups 列鎖（spec §11 鎖序「成員／角色變動＝groups 一把」）：刪角色與「把人掛上這個角色」因此序列化，後到者看到
 * 前者的結果（角色已不在 → 404 `role_not_found`；那人已掛上 → 被改掛內建一般成員），不會在 `group_members_role_fk`
 * 撞 23503。本檔不 import 資料庫型別、不碰路由的依賴物件（S14）；測試縫 `hook` 是型別明示的參數。業務拒絕一律 throw `TxAbort`。
 *
 * ⚠ 跨 PR 前提（PR2 的 `notes/tx/move.ts`）：移動路徑讀成員資格與角色旗標之前，只對 groups 列取 `FOR KEY SHARE`；它的正確性
 * 建立在「所有會改變**既有成員資格**，或改變**可能已有人持有之角色**旗標的寫入，都先 `lockGroup`（groups `FOR UPDATE`，
 * 與 KEY SHARE 互斥；T6／T7、T9–T13）」上。`POST …/roles` 只新增一個尚無人持有的角色（要掛上它必須經過 T9／T10 的
 * `lockGroup`），不改變任何人的有效權限，所以不在此列、也不取鎖。日後若新增會刪 `users` 的路徑（`group_members.user_id`
 * 是 ON DELETE CASCADE），必須先對該使用者所屬的每個群組 `lockGroup`。
 * 所以這兩支的第一步必須是 `lockGroup`，不可為了省一次往返拿掉或挪到讀取之後。守衛：
 * `test/groups-v2-roles-race.test.ts` 的「groups FOR KEY SHARE」一案（另一條交易持 KEY SHARE 時，T12／T13 都必須卡住）。
 */
import { and, eq } from "drizzle-orm";
import type { GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import {
  GROUP_NOT_FOUND_MESSAGE, builtinRoleId, groupNoteIdsQuery, lockGroup, roleByIdQuery, roleFlagValues, roleHolderIdsQuery,
  toGroupRoleDto,
} from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

const notFound = (): TxAbort => new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
const roleNotFound = (): TxAbort => new TxAbort(404, "role_not_found", "找不到此角色");

/** commit 後的踢線名單（§7）：群組所有筆記 × 受影響的成員。 */
export interface RoleKick {
  noteIds: string[];
  userIds: string[];
}

/**
 * T12：改自訂角色的名稱與旗標；內建一般成員只准改旗標（Q10）；內建管理員一律 409（S8）。`name` 已正規化、`permissions`
 * 已過形狀檢查（路由先驗）。**`read` 或 `edit` 有變才回踢線名單**（§7：其他五旗標只影響 REST 授權；值沒變就不踢，v1 F-1）。
 */
export async function updateRoleInTx(
  tx: Tx,
  input: { groupId: string; roleId: string; name: string | undefined; permissions: GroupRoleFlags | undefined },
  hook?: GroupTestHook,
): Promise<{ role: GroupRoleDto; kick: RoleKick | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [before] = await roleByIdQuery(tx, input.groupId, input.roleId);
  if (!before) throw roleNotFound();
  if (before.builtin === "admin") throw new TxAbort(409, "builtin_role", "內建管理員角色不能修改");
  if (before.builtin === "member" && input.name !== undefined) throw new TxAbort(409, "builtin_role", "內建一般成員角色不能改名");
  await hook?.("group-roles-checked", { groupId: input.groupId });
  await tx
    .update(groupRoles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions !== undefined ? roleFlagValues(input.permissions) : {}),
    })
    .where(and(eq(groupRoles.groupId, input.groupId), eq(groupRoles.id, input.roleId)));
  const [after] = await roleByIdQuery(tx, input.groupId, input.roleId);
  const readOrEditChanged = after!.canRead !== before.canRead || after!.canEdit !== before.canEdit;
  const kick = readOrEditChanged
    ? {
        noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id),
        userIds: (await roleHolderIdsQuery(tx, input.groupId, input.roleId)).map(r => r.userId),
      }
    : null;
  return { role: toGroupRoleDto(after!)!, kick };
}

/**
 * T13：刪自訂角色。掛著它的成員同交易改掛**內建一般成員**（Q8），再刪角色——FK `group_members_role_fk` 是 NO ACTION，
 * 順序反過來會 23503。內建角色一律 409（S9：每群組恰兩個內建角色）。回（群組所有筆記, 原持有者）；沒有持有者時兩者皆空。
 */
export async function deleteRoleInTx(
  tx: Tx,
  input: { groupId: string; roleId: string },
  hook?: GroupTestHook,
): Promise<RoleKick> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [role] = await roleByIdQuery(tx, input.groupId, input.roleId);
  if (!role) throw roleNotFound();
  if (role.builtin !== null) throw new TxAbort(409, "builtin_role", "內建角色不能刪除");
  await hook?.("group-roles-checked", { groupId: input.groupId });
  const memberRoleId = await builtinRoleId(tx, input.groupId, "member");
  const moved = await tx
    .update(groupMembers)
    .set({ roleId: memberRoleId })
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.roleId, input.roleId)))
    .returning({ userId: groupMembers.userId });
  await tx.delete(groupRoles).where(and(eq(groupRoles.groupId, input.groupId), eq(groupRoles.id, input.roleId)));
  if (moved.length === 0) return { noteIds: [], userIds: [] };
  return { noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id), userIds: moved.map(m => m.userId) };
}
