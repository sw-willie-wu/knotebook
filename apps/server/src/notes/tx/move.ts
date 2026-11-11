/**
 * #175：個人筆記移進群組的交易本體。S14：只收 `tx`、純資料與型別明示的測試縫。
 *   (0) SELECT … FOR UPDATE 本列；不存在 → 404；已不是呼叫者的個人筆記 → 409 conflict
 *   (1) 目標群組：先對 `groups` 列取 `FOR KEY SHARE`，再讀呼叫者的成員資格與 can_create（走 tx）→ 群組不存在、
 *       非成員、無 can_create → 404 group_not_found。這把鎖與 `lockGroup`（刪群組、成員異動、角色異動
 *       都取 `groups FOR UPDATE`）互斥，所以成員資格從讀到 commit 都成立——前提是所有會改變既有
 *       成員資格、或改變可能已有人持有之角色旗標的寫入，都先 `lockGroup`（`POST …/roles` 只新增無人持有的角色，不在此列；含角色改刪；管理員不變量的紀律 `groups/queries.ts` 只管到
 *       group_members 列與其 role_id，group_roles 的旗標靠各路徑自守）。不擋改群組名（非鍵 UPDATE＝`FOR NO KEY UPDATE`，
 *       groups 只有 PK 一個唯一索引；有測試守著，改成 `FOR SHARE` 會讓它卡住）。它也是 (3) 的 FK
 *       檢查本來就會取的同一把鎖，只是提前；鎖序仍是筆記 → groups（鎖序段），上述路徑都不在持 groups 鎖後再鎖個人筆記，不成環。
 *   (1f) 移入群組帶資料夾：帶 `folderId` 時，群組列不在 → 404 `folder_not_found`（以資料夾 id
 *       進來的入口，n-2）；成員重驗之後另要 `can_edit` → 403；再對目標資料夾取 `FOR KEY SHARE`，不在或不屬於該群組 → 404
 *       `folder_not_found`。這段在 `note-move-locked` 縫**之前**（停在縫上時已持資料夾 KS）。鎖序「來源筆記 FU → groups KS → 資料夾
 *       KS」是全域鎖序的例外：來源必是個人筆記、目標必是群組資料夾，不在任何群組空間資料夾交易要鎖的筆記集合裡，不成環。
 *   (1a) 儲存配額：本篇附件總和（筆記已持 FOR UPDATE）＝移入的位元組 → 目標群組空間鎖＋判定
 *       （`assertSpaceRoomInTx`；在 (0)／(1) 兩把列鎖之後；在 (2) 刪 shares 與 (3) 群組範圍 slug 寫入之前（g）。超過 → `StorageQuotaExceeded`，什麼都沒改；附件總和 0 時不取鎖。來源（個人空間）只會變少，不取鎖
 *   (2) 刪光逐人分享並記下對象（commit 後踢線）
 *   (3) writeSlugInTx：以舊 slug 為基底在群組範圍去重；同一句 UPDATE 清 owner、prev、token、別名，
 *       並明寫 `folder_id`（不給資料夾＝群組根層 NULL，不靠 trigger 自癒）
 *       ——`slug_is_custom` 不動、`updated_at` 不動
 *   (3a) #247：`UPDATE uploads SET charged_to_id = 呼叫者 WHERE note_id = 本篇`——佔用者＝移入者，該篇每一筆附件，不論原上傳者。
 *        在 writeSlugInTx **回傳之後**、callback 之外：callback 撞 slug 唯一索引時會在 savepoint 回滾後以新候選重跑，這句只該跑一次。
 *        空間鎖之後多取的鎖：本筆記（已持 FU）的 uploads 子列、對 users（呼叫者）的 FK KEY SHARE
 *   (4) 只替現行 slug 寫轉址：`/n/<呼叫者 handle>/<舊 slug>`——(0) 已證明呼叫者就是 owner
 *   (5) 版本歷史：清空該篇版本（`resetNoteVersionsInTx`）；commit 後由 `notes/move-note.ts` 的 `moveNoteToGroup` 呼叫 `versions.relocated`
 * 刪群組持 `lockGroup` 時到的移動：(1) 的 KEY SHARE 等刪除 commit → 讀到 0 列 → 404（該案只驗結果，分不出
 * 是這個機制還是 FK 23503 分支；機制由另兩案分辨——拿掉 KEY SHARE 時那兩案紅）。(1) 取得鎖之後群組就刪不掉，
 * (3) 的 UPDATE 不會撞群組 FK 23503；(3a) 對 users 的 FK 只在移入者帳號於交易中被硬刪時才會撞（`src/` 沒有這條路徑）——
 * `notes/move-note.ts` 的 23503 → 404 映射只剩防禦縱深。
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, noteShares, notes, uploads } from "../../db/schema.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../../folders/messages.js";
import { lockFolderInTx } from "../../folders/tx/lock.js";
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
  /** `request.user.handle`（記憶體中、已正規化；同理由——交易內不得查 users）。 */
  userHandle: string;
  /** 已過 UUID_RE、已轉小寫。 */
  groupId: string;
  /** 資料夾：已過 UUID_RE、已轉小寫、交易外判過可見性與群組；null＝群組根層。 */
  folderId: string | null;
  /** 空間鎖等待上限（ms），路由從 deps 帶入。 */
  lockTimeoutMs: number;
}

export async function moveNoteToGroupInTx(tx: Tx, input: MoveNoteInput, hook?: GroupTestHook): Promise<{ removedShareUserIds: string[] }> {
  const [row] = await tx
    .select({ ownerId: notes.ownerId, slug: notes.slug })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("update");
  // #181：授權之後被移入垃圾桶＝列消失，同一條 404。
  if (!row) throw new TxAbort(404, "not_found", "No note with that id.");
  // owner 是呼叫者 ⇒ 是個人筆記（`notes_owner_xor_group_chk`）——不必另看 group_id。
  if (row.ownerId !== input.userId) throw new TxAbort(409, "conflict", "The note's owner or group changed. Reload and try again.");

  const [target] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).for("key share");
  const [member] = await tx
    .select({ canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
    .limit(1);
  if (!target && input.folderId !== null) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  if (!target || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "No group with that id.");
  // (1f) 資料夾：can_edit → 資料夾 KS，都在 `note-move-locked` 縫之前。
  if (input.folderId !== null) {
    if (!member.canEdit) throw new TxAbort(403, "forbidden", NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE);
    const folder = await lockFolderInTx(tx, input.folderId, "key share");
    if (!folder || folder.kind !== "group" || folder.groupId !== input.groupId) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  }
  await hook?.("note-move-locked", { noteId: input.noteId, groupId: input.groupId });

  // (1a) 儲存配額：筆記已持 FOR UPDATE，附件總和就是移入的位元組；目標群組空間鎖在 (0)／(1) 之後、刪 shares 與
  // 群組範圍 slug 寫入之前。拒絕時什麼都沒改；來源（個人空間）不取鎖、不需扣。
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
        .set({ ownerId: null, groupId: input.groupId, folderId: input.folderId, slug, prevSlug: null, publicToken: null, publicSlug: null })
        .where(eq(notes.id, input.noteId));
    },
    { excludeNoteId: input.noteId, beforeWrite: slug => hook?.("note-move-slug-candidate", { noteId: input.noteId, groupId: input.groupId, slug }) },
  );

  // (3a) #247：佔用者＝移入者——本篇每一筆附件，不論原上傳者。位置承重：writeSlugInTx 回傳之後、callback 之外
  // （callback 撞 slug 唯一索引時會在 savepoint 回滾後以新候選重跑；這句只該跑一次），此時 notes 列已確定是群組筆記。
  // 移入只允許 owner＝呼叫者（上方 409 檢查），所以佔用者恆為移入前的擁有者本人。
  await tx.update(uploads).set({ chargedToId: input.userId }).where(eq(uploads.noteId, input.noteId));

  await recordRedirectsInTx(tx, [userNotePath(input.userHandle, row.slug)], input.noteId);
  // 版本歷史：個人時期的版本與編輯者名單不隨搬移暴露給群組編輯者——清空、計數歸零、基底清空；不建任何版本。
  await resetNoteVersionsInTx(tx, { noteId: input.noteId });
  return { removedShareUserIds: removed.map(r => r.userId) };
}
