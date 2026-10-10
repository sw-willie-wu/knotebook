/**
 * #175 T3（spec §6.3）：個人筆記移進群組的交易本體。S14：只收 `tx`、純資料與型別明示的測試縫。
 *   (0) SELECT … FOR UPDATE 本列；不存在 → 404；已不是呼叫者的個人筆記 → 409 conflict（C1）
 *   (1) 目標群組：先對 `groups` 列取 `FOR KEY SHARE`，再讀呼叫者的成員資格與 can_create（走 tx）→ 群組不存在、
 *       非成員、無 can_create → 404 group_not_found。這把鎖與 `lockGroup`（T6／T7 刪群組、T9–T11 成員異動、PR3 T12／T13
 *       角色異動都取 `groups FOR UPDATE`）互斥，所以成員資格從讀到 commit 都成立（C18a／C18b）——前提是所有會改變既有
 *       成員資格、或改變可能已有人持有之角色旗標的寫入，都先 `lockGroup`（`POST …/roles` 只新增無人持有的角色，不在此列；含 PR3 T12／T13 角色改刪；S1 紀律 `groups/queries.ts` 只管到
 *       group_members 列與其 role_id，group_roles 的旗標靠各路徑自守）。不擋改群組名（非鍵 UPDATE＝`FOR NO KEY UPDATE`，
 *       groups 只有 PK 一個唯一索引；C18d 守著，改成 `FOR SHARE` 會讓它卡住）。它也是 (3) 的 FK
 *       檢查本來就會取的同一把鎖，只是提前；鎖序仍是筆記 → groups（spec §11 鎖序段），上述路徑都不在持 groups 鎖後再鎖個人筆記，不成環。
 *   (1a) 儲存配額（spec 2026-10-08 §6.5）：本篇附件總和（筆記已持 FOR UPDATE）＝移入的位元組 → 目標群組空間鎖＋判定
 *       （`assertSpaceRoomInTx`；在 (0)／(1) 兩把列鎖之後——Q-S2；在 (2) 刪 shares 與 (3) 群組範圍 slug 寫入之前——Q-S6 (g)、
 *       Q-S7）。超過 → `StorageQuotaExceeded`，什麼都沒改；附件總和 0 時不取鎖（A4）。來源（個人空間）只會變少，不取鎖
 *   (2) 刪光逐人分享（S5／D16）並記下對象（commit 後踢線）
 *   (3) writeSlugInTx：以舊 slug 為基底在群組範圍去重（B6）；同一句 UPDATE 清 owner、prev（B12）、token（Q4）、別名（S11）
 *       ——`slug_is_custom` 不動（B6）、`updated_at` 不動（§6.3）
 *   (4) 只替現行 slug 寫轉址（B12 已刪）：`/n/<呼叫者 handle>/<舊 slug>`——(0) 已證明呼叫者就是 owner
 *   (5) 版本歷史 §9：清空該篇版本（`resetNoteVersionsInTx`）；commit 後路由呼叫 `versions.relocated`
 * 刪群組持 `lockGroup` 時到的移動：(1) 的 KEY SHARE 等刪除 commit → 讀到 0 列 → 404（C5a 只驗結果，分不出
 * 是這個機制還是 FK 23503 分支；機制由 C18a／C18b 分辨——拿掉 KEY SHARE 時那兩案紅）。(1) 取得鎖之後群組就刪不掉，
 * (3) 的 UPDATE 不會撞 FK 23503；路由的 23503 → 404 映射只剩防禦縱深。
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, noteShares, notes, uploads } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { sumUploadSizeSql } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { userNotePath } from "../redirects.js";
import { recordRedirectsInTx } from "./redirects.js";
import { resetNoteVersionsInTx } from "./versions.js";
import { writeSlugInTx } from "./write-slug.js";

export interface MoveNoteInput {
  noteId: string;
  userId: string;
  /** `request.user.handle`（記憶體中、已正規化；§4.3 同理由——交易內不得查 users）。 */
  userHandle: string;
  /** 已過 UUID_RE、已轉小寫。 */
  groupId: string;
  /** 空間鎖等待上限（ms），路由從 deps 帶入。 */
  lockTimeoutMs: number;
}

export async function moveNoteToGroupInTx(tx: Tx, input: MoveNoteInput, hook?: GroupTestHook): Promise<{ removedShareUserIds: string[] }> {
  const [row] = await tx
    .select({ ownerId: notes.ownerId, slug: notes.slug })
    .from(notes)
    .where(eq(notes.id, input.noteId))
    .for("update");
  if (!row) throw new TxAbort(404, "not_found", "找不到此筆記");
  // owner 是呼叫者 ⇒ 是個人筆記（`notes_owner_xor_group_chk`，S6）——不必另看 group_id。
  if (row.ownerId !== input.userId) throw new TxAbort(409, "conflict", "筆記的歸屬已變更，請重新整理後再試");

  const [target] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).for("key share");
  const [member] = await tx
    .select({ canCreate: groupRoles.canCreate })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
    .limit(1);
  if (!target || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "找不到此群組");
  await hook?.("note-move-locked", { noteId: input.noteId, groupId: input.groupId });

  // (1a) 儲存配額 §6.5：筆記已持 FOR UPDATE，附件總和就是移入的位元組；目標群組空間鎖在 (0)／(1) 之後（Q-S2）、刪 shares 與
  // 群組範圍 slug 寫入之前（Q-S6 (g)、Q-S7）。拒絕時什麼都沒改；來源（個人空間）不取鎖、不需扣。
  const [sized] = await tx.select({ incoming: sumUploadSizeSql() }).from(uploads).where(eq(uploads.noteId, input.noteId));
  await assertSpaceRoomInTx(tx, { kind: "group", id: input.groupId }, sized?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { noteId: input.noteId, groupId: input.groupId },
  });

  const removed = await tx.delete(noteShares).where(eq(noteShares.noteId, input.noteId)).returning({ userId: noteShares.userId });

  await writeSlugInTx(
    tx,
    { groupId: input.groupId },
    { base: row.slug },
    async slug => {
      await tx
        .update(notes)
        .set({ ownerId: null, groupId: input.groupId, slug, prevSlug: null, publicToken: null, publicSlug: null })
        .where(eq(notes.id, input.noteId));
    },
    { excludeNoteId: input.noteId, beforeWrite: slug => hook?.("note-move-slug-candidate", { noteId: input.noteId, groupId: input.groupId, slug }) },
  );

  await recordRedirectsInTx(tx, [userNotePath(input.userHandle, row.slug)], input.noteId);
  // 版本歷史 §9：個人時期的版本與編輯者名單不隨搬移暴露給群組編輯者（Willie 裁決）——清空、計數歸零、基底清空；不建任何版本（D9）。
  await resetNoteVersionsInTx(tx, { noteId: input.noteId });
  return { removedShareUserIds: removed.map(r => r.userId) };
}
