/**
 * 建立／複製進群組的目標檢查——成員資格＋角色新建旗標的判準**只有這一份實作**（#175 §6.2、§6.5、§9.3）。
 * 三個呼叫點：`POST /api/notes {groupId}`、`POST /api/notes/:id/copy {groupId}`（兩者在 `routes/notes.ts`），
 * 以及 MCP `create_note {groupId}`（#175 PR5）。
 *
 * 回呼叫者在該群組的成員列＋角色旗標＋群組名。`undefined`＝群組不存在或不是成員（呼叫端都回同一條 404／
 * `group_not_found`）。交易外查。`POST /api/notes {groupId}` 與 MCP `create_note` 只靠這一次（C8：撤旗標與建立之間
 * 不保證，§15 第 5 條）；複製另在交易內持目標 groups KEY SHARE 重驗（`notes/tx/copy.ts` (g)），這裡對複製只是快速
 * 404（DTO 的角色／群組名取 (g) 交易內讀到的值，review r2 M-2；不得拿這裡的 `m` 組複製的 DTO）。
 *
 * ⚠ 本檔**不是** `tx/` 底下的檔、也不寫入任何列（S14 守衛 ① 只掃 `tx/`；`notes-slug.test.ts` 的 `.insert(notes)`
 * 源碼守衛要求這裡沒有 insert）。
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, groups } from "../db/schema.js";

export interface CreateTarget {
  name: string;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManagePublicLink: boolean;
}

export async function loadCreateTarget(db: DbOrTx, userId: string, groupId: string): Promise<CreateTarget | undefined> {
  const [m] = await db
    .select({
      name: groups.name,
      canRead: groupRoles.canRead,
      canCreate: groupRoles.canCreate,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return m;
}
