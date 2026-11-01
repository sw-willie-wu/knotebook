/**
 * 刪資料夾的交易本體（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.7.4、§5.8；§5.4 表「刪資料夾」三列）。
 * S14：只收 `tx`／純資料／測試縫。共編閘門由服務層在交易外開、交易後全收（M1）。
 * 順序：（群組空間）groups KS → 結構鎖 → 子樹資料夾 FU（依 id）→ 重判可見性與管理權 →
 * - 共享私人：`DELETE` root（子資料夾 CASCADE、放置 CASCADE），不經垃圾桶；
 * - 個人／群組：**一段式**依 id 鎖子樹全部筆記（不分狀態，m5）→ 活筆記 ⊄ 已開閘門 → 409 → 活筆記每
 *   `DELETE_FOLDER_TRASH_CHUNK` 篇一批 `trashNotesInTx`（`forbidden` → 403、`notFound` → 409，M2；全有全無）→
 *   刷新子樹垃圾桶筆記的路徑快照 → `DELETE` root（子資料夾 CASCADE、筆記 `folder_id` SET NULL）。
 * 子樹一律以述詞（`subtreeFolderIdsSql`）選，不把 id 陣列塞進 `IN`（M15）。失敗一律 throw `TxAbort`。
 * `onlyIfEmpty`（§5.7.4「只刪空資料夾」，鎖序不變、不另取鎖）：重判之後子樹不只 root → 409 `folder_not_empty`；共享私人
 * root 有放置 → 409；個人／群組鎖到的筆記有活的 → 409（排在「活筆記 ⊄ 已開閘門」之前）。垃圾桶筆記不算內容。
 * 呼叫端一律 READ COMMITTED（`lock.ts` 檔頭）。
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { FolderDeleteResultDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders, notePlacements, notes } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { trashNotesInTx } from "../../notes/tx/trash.js";
import {
  FOLDER_CONTENT_CHANGED_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_NOT_EMPTY_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
} from "../messages.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../space.js";
import { folderPathJsonSql, NOTES_FOLDER_ID, subtreeFolderIdsSql } from "../sql.js";
import { folderAccessInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "./lock.js";

export interface DeleteFolderInput {
  by: string;
  /** 交易外預讀的資料夾 id 與空間；id 已小寫。 */
  folderId: string;
  space: FolderSpace;
  /** 交易外預讀並已開閘門的活筆記 id（升冪）。 */
  gatedNoteIds: readonly string[];
  lockTimeoutMs: number;
  /** 只刪空資料夾（§5.7.4）；省略＝false。 */
  onlyIfEmpty?: boolean;
}

/** trashNotesInTx 每批的 id 數（M15：避開協定參數上限）。 */
export const DELETE_FOLDER_TRASH_CHUNK = 1000;

export async function deleteFolderInTx(tx: Tx, input: DeleteFolderInput, hook?: GroupTestHook): Promise<FolderDeleteResultDto> {
  const { space } = input;
  const notFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const changed = (): TxAbort => new TxAbort(409, "conflict", FOLDER_CONTENT_CHANGED_MESSAGE);
  const notEmpty = (): TxAbort => new TxAbort(409, "folder_not_empty", FOLDER_NOT_EMPTY_MESSAGE);
  const onlyIfEmpty = input.onlyIfEmpty === true;
  const hookCtx: GroupHookCtx = { folderId: input.folderId, ...(space.kind === "group" ? { groupId: space.groupId } : {}) };

  if (space.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [space.groupId]);
    if (!present.has(space.groupId)) throw notFound();
  }
  await lockFolderSpacesInTx(tx, [space], { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx });

  const subtree = await tx
    .select()
    .from(folders)
    .where(sql`${folders.id} in (${subtreeFolderIdsSql(input.folderId)})`)
    .orderBy(asc(folders.id))
    .for("update");
  const root = subtree.find(f => f.id === input.folderId);
  if (!root || !sameFolderSpace(folderSpaceOfRow(root), space)) throw notFound();
  const access = await folderAccessInTx(tx, input.by, root);
  if (access === null) throw notFound();
  if (!access.permissions.manage) throw new TxAbort(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  const deletedFolderIds = subtree.map(f => f.id);
  // 放進來的寫入（放置、建／複製進資料夾、照路徑重建）都要先取這些資料夾的 KS 或結構鎖，判空到 DELETE 之間不會變。
  if (onlyIfEmpty && subtree.length > 1) throw notEmpty();

  if (space.kind === "shared") {
    if (onlyIfEmpty) {
      const placed = await tx.select({ one: sql`1` }).from(notePlacements).where(eq(notePlacements.folderId, root.id)).limit(1);
      if (placed.length > 0) throw notEmpty();
    }
    await tx.delete(folders).where(eq(folders.id, root.id));
    return { trashedNoteIds: [], deletedFolderIds };
  }

  // 一段式（m5）：活筆記與垃圾桶筆記同一句、依 id 鎖；等鎖後重評 WHERE，剛被搬出子樹的不會被鎖進來。
  const locked = await tx
    .select({ id: notes.id, live: sql<boolean>`${notes.deletedAt} is null` })
    .from(notes)
    .where(sql`${notes.folderId} in (${subtreeFolderIdsSql(root.id)})`)
    .orderBy(asc(notes.id))
    .for("update");
  await hook?.("folder-delete-notes-locked", hookCtx);

  const gated = new Set(input.gatedNoteIds);
  const live = locked.filter(n => n.live).map(n => n.id);
  if (onlyIfEmpty && live.length > 0) throw notEmpty();
  // 沒開閘門的活筆記（預讀之後才進子樹）：移入會讓連線中的人繼續寫，整筆擋下。
  if (live.some(id => !gated.has(id))) throw changed();

  for (let i = 0; i < live.length; i += DELETE_FOLDER_TRASH_CHUNK) {
    const out = await trashNotesInTx(tx, { ids: live.slice(i, i + DELETE_FOLDER_TRASH_CHUNK), by: input.by });
    if (out.forbidden.length > 0) throw new TxAbort(403, "folder_delete_blocked", FOLDER_DELETE_BLOCKED_MESSAGE);
    // M2：這批已在本交易鎖住，notFound 只剩「重判之後角色才被改掉」；照略過會讓下面的 DELETE 把活筆記 SET NULL 到根層。
    if (out.notFound.length > 0) throw changed();
  }

  // §5.8：子樹裡的垃圾桶筆記（含剛移入的）快照刷新成刪除當下的路徑；之後 `folder_id` 被 SET NULL。
  await tx
    .update(notes)
    .set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) })
    .where(and(sql`${notes.folderId} in (${subtreeFolderIdsSql(root.id)})`, isNotNull(notes.deletedAt)));
  await tx.delete(folders).where(eq(folders.id, root.id));
  return { trashedNoteIds: live, deletedFolderIds };
}
