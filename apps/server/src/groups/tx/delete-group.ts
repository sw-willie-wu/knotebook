/**
 * #175 刪群組的兩支交易本體（§6.8，PR4；PR1–PR3 的 T5「只刪空群組」已退場）：T6 `transferGroupInTx`（轉移給內建管理員）、
 * T7 `deleteGroupWithNotesInTx`（連筆記一起刪）。兩支都先 `lockGroup`（groups FOR UPDATE），再以群組述詞 FOR UPDATE 該群組的筆記；
 * 鎖之後才到的建立／移入／複製進群組都卡在 groups 的 KEY SHARE，commit 後得 23503 或讀到群組不在 → 404。角色與成員由 FK CASCADE 帶走。
 * S14：本檔只收 `tx`／純資料／測試縫，不 import `Db`、不接 `deps`；全刪的 gate（`beforeNoteDeleted`）、commit 後的刪檔與踢線都在路由。
 * 與其他交易的鎖序（含會成環而回 409 server_busy 的兩形）見 PR4 plan 的鎖序表。
 */
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, notes } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { groupNotePath } from "../../notes/redirects.js";
import { deleteNotesInTx } from "../../notes/tx/delete-notes.js";
import { recordRedirectsInTx } from "../../notes/tx/redirects.js";
import { writeSlugInTx } from "../../notes/tx/write-slug.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, lockGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

export interface TransferGroupInput {
  groupId: string;
  /** 已過 UUID_RE、已轉小寫（路由在交易前做）。 */
  transferTo: string;
}

export interface GroupDeletionResult {
  /** 交易內以群組述詞鎖住並處理的筆記（T6＝轉走的、T7＝刪掉的）。 */
  noteIds: string[];
  /** `DELETE groups`（CASCADE）**之前**以 tx 取的全體成員。 */
  memberIds: string[];
}

/**
 * #175 T6（spec §6.8 transfer）：群組筆記全數改成 transferTo 的個人筆記，再刪群組。S14：只收 `tx`／純資料／測試縫。
 *   lockGroup（不存在 → 404）→ transferTo 是成員且 builtin='admin'（鎖之後查，C9）→ 否則 409 not_admin
 *   → M（CASCADE 前取）→ 該群組筆記 FOR UPDATE，依 created_at, id（撞名時誰拿較小的 -N 是決定性的，RF1；spec 疑點 Q3）
 *   → 每篇 writeSlugInTx（scope＝transferTo 個人、base＝舊 slug，B6）：同一句 UPDATE 換歸屬、清 prev（B12）
 *     ——同一句清 public_token／public_slug（Willie 2026-10-02 裁決，比照 move.ts；轉移後是未分享的個人筆記；不扣 publicLink 桶）、
 *     slug_is_custom 不動、updated_at 不動（§9.2）
 *   → recordRedirectsInTx：只替現行 slug 寫 `/g/<g>/<舊 slug>`（B12）
 *   → DELETE groups（角色、成員 CASCADE）
 * lockGroup 之後才到的建立／移入／複製進群組都卡在 groups 的 KEY SHARE（FK 或顯式），commit 後讀到群組不在 → 404（C4／C5）。
 */
export async function transferGroupInTx(tx: Tx, input: TransferGroupInput, hook?: GroupTestHook): Promise<GroupDeletionResult> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  const [target] = await tx
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.transferTo)))
    .limit(1);
  if (target?.builtin !== "admin") throw new TxAbort(409, "not_admin", NOT_ADMIN_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });

  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const rows = await tx
    .select({ id: notes.id, slug: notes.slug })
    .from(notes)
    .where(eq(notes.groupId, input.groupId))
    .orderBy(asc(notes.createdAt), asc(notes.id))
    .for("update");

  for (const row of rows) {
    await writeSlugInTx(
      tx,
      { ownerId: input.transferTo },
      { base: row.slug },
      async slug => {
        await tx
          .update(notes)
          .set({ groupId: null, ownerId: input.transferTo, slug, prevSlug: null, publicToken: null, publicSlug: null })
          .where(eq(notes.id, row.id));
      },
      { excludeNoteId: row.id, beforeWrite: slug => hook?.("group-transfer-slug-candidate", { noteId: row.id, groupId: input.groupId, slug }) },
    );
    await recordRedirectsInTx(tx, [groupNotePath(input.groupId, row.slug)], row.id);
  }

  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds: rows.map(r => r.id), memberIds: members.map(m => m.userId) };
}

/**
 * #175 T7（spec §6.8 delete）：連筆記一起刪群組。**gate（`beforeNoteDeleted`，會借連線）由路由在交易之前對 P0 開完**——
 * 本函式不碰 gate（S14；gate r3 C-1）。lockGroup（不存在 → 404）→ L＝該群組筆記 FOR UPDATE（以群組述詞、不比對名單：
 * gate 之後才進群組的也在 L 裡，§6.8 代價）→ M（CASCADE 前取）→ deleteNotesInTx(L)（與單篇 DELETE 同一份）→ DELETE groups。
 */
export async function deleteGroupWithNotesInTx(
  tx: Tx,
  input: { groupId: string },
  hook?: GroupTestHook,
): Promise<GroupDeletionResult & { uploadIds: string[] }> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });
  const rows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.groupId, input.groupId)).for("update");
  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const noteIds = rows.map(r => r.id);
  const uploadIds = await deleteNotesInTx(tx, noteIds);
  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds, memberIds: members.map(m => m.userId), uploadIds };
}
