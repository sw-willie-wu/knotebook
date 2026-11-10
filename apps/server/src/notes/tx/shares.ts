/**
 * #175 S14（T2）：`PUT /api/notes/:id/shares` 的交易本體。只收 `tx`、純資料與型別明示的測試縫——本檔不碰
 * pool，寫不出「交易內向 pool 借連線」。授權（`permissions.manageShares`）、email 查找與
 * FK 23503 → 404 的映射都在路由層、交易之外。
 * `FOR SHARE` 讀 `group_id`——與移動交易的 `FOR UPDATE` 互鎖；讀到非 NULL（授權之後被移進群組）→ 409。
 */
import { and, eq, isNull } from "drizzle-orm";
import type { ShareRole } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { noteShares, notes } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";

export async function upsertShareInTx(
  tx: Tx,
  input: { noteId: string; targetUserId: string; role: ShareRole },
  hook?: GroupTestHook,
): Promise<void> {
  // #181：授權之後被移入垃圾桶＝列消失，同一條 404。
  const [locked] = await tx.select({ groupId: notes.groupId }).from(notes).where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt))).for("share");
  if (!locked) throw new TxAbort(404, "not_found", "No note with that id.");
  if (locked.groupId !== null) throw new TxAbort(409, "note_in_group", "Group notes can't be shared with individual people. Add the person to the group instead.");
  await hook?.("share-group-checked", { noteId: input.noteId });
  await tx
    .insert(noteShares)
    .values({ noteId: input.noteId, userId: input.targetUserId, role: input.role })
    .onConflictDoUpdate({ target: [noteShares.noteId, noteShares.userId], set: { role: input.role } });
}
