/**
 * #175 T5（§6.7、B9）：PR1–PR3 只允許刪**空**群組。`lockGroup` 之後數筆記：之後才到的建立（PR2 起還有移入）都卡在 FK 的
 * KEY SHARE（與 FOR UPDATE 衝突），刪除 commit 後得 23503（→ 404 `group_not_found`，RF4）；鎖之前已 commit 的會被數到 → 409。
 * 角色與成員由 FK CASCADE 帶走。本檔不 import `Db`、不接 `deps`（S14）。PR4 換成轉移／全刪（§6.8）。
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groups, notes } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { GROUP_NOT_FOUND_MESSAGE, lockGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

export async function deleteEmptyGroupInTx(tx: Tx, input: { groupId: string }, hook?: GroupTestHook): Promise<void> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(notes).where(eq(notes.groupId, input.groupId));
  if ((row?.n ?? 0) > 0) throw new TxAbort(409, "group_not_empty", "群組內還有筆記，無法刪除");
  await hook?.("group-delete-locked", { groupId: input.groupId });
  await tx.delete(groups).where(eq(groups.id, input.groupId));
}
