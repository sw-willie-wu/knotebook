/**
 * #175 刪群組的兩支交易本體：`transferGroupInTx`（轉移給內建管理員）、
 * `deleteGroupWithNotesInTx`（連筆記一起刪）。角色與成員由 FK CASCADE 帶走。
 * S14：本檔只收 `tx`／純資料／測試縫，不 import `Db`、不接 `deps`；全刪的 gate（`beforeNoteDeleted`）、commit 後的刪檔與踢線都在路由。
 *
 * 鎖序（全域序 ① groups → ② 結構鎖 → ③ 資料夾列 → ④ 筆記列 → ⑤ 容量鎖）：
 * - 轉移：`lockGroup`（groups FOR UPDATE）→ 群組與接收者個人空間的結構鎖（依鍵）→ 群組筆記 FOR UPDATE（**依 id 升冪**，與垃圾桶的
 *   移入／還原／永久刪除、`deleteNotesInTx` 同序；#181）→ 接收者個人空間的容量鎖 → 新頂層 INSERT、`UPDATE folders`、逐篇改歸屬。
 *   資料夾寫入在筆記鎖之後是有理由的偏離：群組資料夾的 FOR UPDATE 只有刪資料夾會取，而它先要 groups KS（被 `lockGroup` 擋）；
 *   接收者空間的結構寫入（建立、改名、搬移、照路徑重建）都要先拿接收者的結構鎖。
 * - 全刪：`lockGroup` → 群組結構鎖 → 群組筆記 FOR UPDATE（依 id）→ `deleteNotesInTx` → `DELETE groups`（群組資料夾 CASCADE）；
 *   不取容量鎖（儲存配額）。
 * 所有觸及群組空間資料夾的交易第一步都取 groups KS，與 `lockGroup` 互斥；鎖之後才到的建立／移入／複製進群組也卡在 groups 的
 * KEY SHARE，commit 後得 23503 或讀到群組不在 → 404。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders, groupMembers, groupRoles, groups, notes, uploads } from "../../db/schema.js";
import { normalizeFolderNameLoose } from "../../folders/names.js";
import { lockFolderSpacesInTx } from "../../folders/tx/lock.js";
import { createSystemTopFolderInTx } from "../../folders/tx/system-top.js";
import { TxAbort } from "../../http/tx-abort.js";
import { groupNotePath } from "../../notes/redirects.js";
import { deleteNotesInTx } from "../../notes/tx/delete-notes.js";
import { recordRedirectsInTx } from "../../notes/tx/redirects.js";
import { resetNoteVersionsInTx } from "../../notes/tx/versions.js";
import { writeSlugInTx } from "../../notes/tx/write-slug.js";
import { sumUploadSizeSql } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, lockGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

export interface TransferGroupInput {
  groupId: string;
  /** 已過 UUID_RE、已轉小寫（路由在交易前做）。 */
  transferTo: string;
  /** 發動刪群組的使用者（新頂層的 `created_by`）。 */
  by: string;
  /** 群組名經正規化後是空字串時的新頂層名（路由依 `Accept-Language` 給）。 */
  fallbackFolderName: string;
  /** 結構鎖與空間鎖的等待上限（ms）。 */
  lockTimeoutMs: number;
}

export interface GroupDeletionResult {
  /** 交易內以群組述詞鎖住並處理的筆記（轉移＝轉走的、全刪＝刪掉的）。 */
  noteIds: string[];
  /** `DELETE groups`（CASCADE）**之前**以 tx 取的全體成員。 */
  memberIds: string[];
}

/**
 * #175 `transferGroupInTx`（transfer）：群組筆記全數改成 transferTo 的個人筆記，再刪群組。S14：只收 `tx`／純資料／測試縫。
 *   lockGroup（不存在 → 404）→ transferTo 是成員且 builtin='admin'（鎖之後查）→ 否則 409 not_admin
 *   → M（CASCADE 前取）→ 群組與 transferTo 個人空間的結構鎖（在鎖群組筆記之前）
 *   → 該群組筆記 FOR UPDATE（依 id 鎖），再在 JS 依 created_at, id 排處理順序（撞名時誰拿較小的 -N 是決定性的）
 *   → 儲存配額：附件總和 → transferTo 個人空間鎖＋判定（writeSlugInTx 之前；放不下 → StorageQuotaExceeded，什麼都沒寫）
 *   → 版本歷史：清空版本（`resetNoteVersionsInTx({ groupId })`，以群組述詞一次處理，必須在改 group_id 之前）
 *   → 資料夾（5）：群組有資料夾、或垃圾桶裡有帶快照的根層筆記 → transferTo 個人根層建新頂層（群組名經 loose 正規化、加尾碼）；
 *     群組有資料夾 → **單一一句** `UPDATE folders` 把整棵改成 transferTo 的個人資料夾、群組根層資料夾掛到新頂層下（trigger 2 在句末檢查整棵）
 *   → 每篇 writeSlugInTx（scope＝transferTo 個人、base＝舊 slug）：同一句 UPDATE 換歸屬、清 prev、處理位置
 *     ——同一句清 public_token／public_slug（比照 move.ts；轉移後是未分享的個人筆記；不扣 publicLink 桶）、
 *     slug_is_custom 不動、updated_at 不動
 *   → recordRedirectsInTx：只替現行 slug 寫 `/g/<g>/<舊 slug>`
 *   → DELETE groups（角色、成員 CASCADE；資料夾已不屬於群組）
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
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }, { kind: "personal", ownerId: input.transferTo }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  // 鎖序依 id（見檔頭）；處理順序另在 JS 依 created_at, id 排。created_at 取微秒整數（JS Date 只到毫秒，同毫秒內會排錯）。
  const locked = await tx
    .select({
      id: notes.id,
      slug: notes.slug,
      createdUs: sql<string>`(extract(epoch from ${notes.createdAt}) * 1000000)::bigint`,
      folderId: notes.folderId,
      // 「垃圾桶裡、帶快照」：活筆記上殘留的快照（回滾期間被舊碼還原）不算，照一般根層規則處理。
      trashedWithPath: sql<boolean>`${notes.trashFolderPath} is not null and ${notes.deletedAt} is not null`,
    })
    .from(notes)
    .where(eq(notes.groupId, input.groupId))
    .orderBy(asc(notes.id))
    .for("update");
  const rows = locked
    .map(r => ({ ...r, us: BigInt(r.createdUs) }))
    .sort((x, y) => (x.us < y.us ? -1 : x.us > y.us ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // 儲存配額：群組筆記已全數 FOR UPDATE，incoming＝它們的附件總和（含 gate 開完之後才進群組的——以群組述詞取到即算）。
  // 接收者個人空間鎖在第一個 writeSlugInTx **之前**（`storage-quota-race.test.ts` 釘住）。拒絕 → 什麼都沒寫。
  // 以群組述詞 SUM（rows 已全數 FOR UPDATE，取到的是同一組筆記）——不用 `inArray(…, ids)`：一篇一個綁定參數，
  // 超過協定上限（65535）的大群組會 500。
  const [sumRow] = await tx
    .select({ incoming: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(eq(notes.groupId, input.groupId));
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.transferTo }, sumRow?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { groupId: input.groupId },
  });

  // 版本歷史：在改 group_id **之前**以群組述詞一次清空（rows 已全數 FOR UPDATE；不組 ANY($ids)）。
  await resetNoteVersionsInTx(tx, { groupId: input.groupId });

  // 有資料夾、或有「原資料夾已刪、靠快照重建」的垃圾桶筆記，才建新頂層。
  const [anyFolder] = await tx.select({ id: folders.id }).from(folders).where(eq(folders.groupId, input.groupId)).limit(1);
  const groupHasFolders = anyFolder !== undefined;
  let top: { id: string; name: string } | null = null;
  if (groupHasFolders || rows.some(r => r.folderId === null && r.trashedWithPath)) {
    const [g] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, input.groupId));
    const baseName = normalizeFolderNameLoose(g!.name, input.fallbackFolderName);
    top = await createSystemTopFolderInTx(tx, { ownerId: input.transferTo, baseName, by: input.by });
  }
  // 單一一句改整棵（trigger 2 是 AFTER ROW，句末才檢查父子同空間；拆成多句會在中途看到父子不同空間）。
  if (top !== null && groupHasFolders) {
    await tx
      .update(folders)
      .set({ kind: "personal", ownerId: input.transferTo, groupId: null, parentId: sql`coalesce(${folders.parentId}, ${top.id}::uuid)` })
      .where(eq(folders.groupId, input.groupId));
  }

  for (const row of rows) {
    // 三種列：在資料夾裡 → 保留（資料夾已在接收者空間）；根層、無快照 → 新頂層；根層、有快照（原資料夾已刪）→
    // folder_id 保持 NULL、快照前接新頂層**實際寫入**的名（含尾碼），還原時在它底下照原路徑重建。
    const place = row.folderId !== null || top === null
      ? {}
      : row.trashedWithPath
        ? { trashFolderPath: sql`jsonb_build_array(${top.name}::text) || ${notes.trashFolderPath}` }
        : { folderId: top.id };
    await writeSlugInTx(
      tx,
      { ownerId: input.transferTo },
      { base: row.slug },
      async slug => {
        await tx
          .update(notes)
          .set({ groupId: null, ownerId: input.transferTo, slug, prevSlug: null, publicToken: null, publicSlug: null, ...place })
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
 * #175 `deleteGroupWithNotesInTx`（delete）：連筆記一起刪群組。**gate（`beforeNoteDeleted`，會借連線）由路由在交易之前開完**——
 * 本函式不碰 gate（S14）。lockGroup（不存在 → 404）→ 群組結構鎖（與轉移同位置）→
 * L＝該群組筆記 FOR UPDATE（以群組述詞、不比對名單：gate 之後才進群組的也在 L 裡，這是接受的代價）→ M（CASCADE 前取）→
 * deleteNotesInTx(L)（與永久刪除／到期清理同一份；L 含群組垃圾桶裡的筆記）→ DELETE groups（群組資料夾 CASCADE）。
 * #188 起 `deleteNotesInTx` 第一步也對 L 取 FOR UPDATE（同交易重鎖、不等待）；全刪 × 上傳由兩把鎖任一把守住，
 * 拿掉這裡的 FOR UPDATE 在現有整合測試下等價。保留它：L 以群組述詞「取到即鎖」是全刪的定義，不依賴「沒有路徑能在
 * 不取 lockGroup 的情況下把筆記移出群組」這條今天才成立的前提。
 */
export async function deleteGroupWithNotesInTx(
  tx: Tx,
  input: { groupId: string; lockTimeoutMs: number },
  hook?: GroupTestHook,
): Promise<GroupDeletionResult & { uploadIds: string[] }> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  const rows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.groupId, input.groupId)).orderBy(asc(notes.id)).for("update");
  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const noteIds = rows.map(r => r.id);
  const uploadIds = await deleteNotesInTx(tx, noteIds);
  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds, memberIds: members.map(m => m.userId), uploadIds };
}
