/**
 * 資料夾 PR-3d（folders spec §5.12、§5.7.4）`delete_folder`：刪資料夾與其下全部資料夾，子樹的活筆記一起移到垃圾桶（全有全無，F8）；
 * 共享私人樹只刪資料夾、筆記不動（F7）。入口順序、閘門與交易都在服務層 `deleteFolder`，本檔只呼叫它、不得出現 deleted_at 字面（守衛二）。
 * 流程順序是契約：`requireDeleteScope`（第一個動作）→ `readTrashRetentionDays`（只當存在性守衛，排在服務層扣 edit 桶與任何寫入之前，
 * 同 delete_note）→ `deleteFolder`（失敗以 `folderFailureToToolError` 映射）→ ids 依 id 排序取前 `MCP_DELETE_FOLDER_IDS_MAX` 個
 * → `loadTrashedPurgeAt`（commit 後一讀）。MCP 沒有「只刪空資料夾」的選項，也沒有永久刪除（spec D8、PR-2d AG3）。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../../auth/tx/admin-site-settings.js";
import { deleteFolder } from "../../folders/service.js";
import { loadTrashedPurgeAt, readTrashRetentionDays } from "../../trash/list.js";
import { FOLDER_ID } from "../folder-fields.js";
import { folderFailureToToolError } from "../folder-messages.js";
import { folderServiceDeps } from "../folder-service.js";
import { MCP_DELETE_FOLDER_IDS_MAX } from "../limits.js";
import { toolResult } from "../tool-result.js";
import { requireDeleteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** D-DF（逐字照 plan「待確認字串」）。 */
export const DELETE_FOLDER_DESCRIPTION =
  "Delete a folder and every folder inside it. The notes in them all move to the trash, each just as delete_note would move it, " +
  "and all at once: if any of them is a note your role can't move to the trash, nothing is deleted. For one of your folders for " +
  "notes shared with you, only the folders go — the notes stay shared with you, at the top level, and nothing moves to the trash. " +
  "In a group, deleting a folder needs a role that can edit notes, and one that can also delete notes when notes in it would move " +
  "to the trash. Folders don't go to the trash: restore_note usually puts a note back into a folder at the path it had, re-creating " +
  "folders on that path, but folders that held no notes don't come back. The reply counts the notes moved to the trash and the " +
  `folders deleted, with the ids of up to ${MCP_DELETE_FOLDER_IDS_MAX} of those notes; list_trash shows them.`;

export const DF_FOLDER = "The id of the folder to delete, from list_folders.";
export const DF_COUNT = "How many notes were moved to the trash.";
export const DF_IDS = `The ids of the notes moved to the trash, at most ${MCP_DELETE_FOLDER_IDS_MAX}, in id order.`;
export const DF_IDS_TRUNC = "Present when more notes were moved than `trashedNoteIds` lists; list_trash shows them.";
export const DF_FOLDERS = "How many folders were deleted, counting the one you named.";
export const DF_PURGE =
  "When the notes moved to the trash become due to be deleted permanently under the site's current trash setting (an admin can " +
  "change it; list_trash shows the current date for the notes you can restore); null when no note was moved to the trash, or when " +
  "this site doesn't empty the trash on its own at the moment.";

/** 註冊為 `z.object(deleteFolderInput).strict()`；只有 folder_id（不提供「只刪空資料夾」之類的選項）。 */
export const deleteFolderInput = { folder_id: FOLDER_ID.describe(DF_FOLDER) };

export const deleteFolderOutput = {
  trashedNoteCount: z.number().int().describe(DF_COUNT),
  trashedNoteIds: z.array(z.string()).max(MCP_DELETE_FOLDER_IDS_MAX).describe(DF_IDS),
  trashedNoteIdsTruncated: z.literal(true).optional().describe(DF_IDS_TRUNC),
  deletedFolderCount: z.number().int().describe(DF_FOLDERS),
  purgeAt: z.string().nullable().describe(DF_PURGE),
};

export async function deleteFolderTool(args: { folder_id: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireDeleteScope(ctx);
  if (denied !== null) return denied;

  // 存在性守衛：列不在是部署壞掉，丟給 runTool 收成 internal——在服務層扣 edit 桶與移入之前，什麼都沒做。值本身不用
  // （回應的 purgeAt 取 commit 後那一刻的設定，見 loadTrashedPurgeAt）。
  if ((await readTrashRetentionDays(ctx.db)) === undefined) throw new Error(SITE_SETTINGS_MISSING_MESSAGE);

  const out = await deleteFolder(folderServiceDeps(ctx), { by: ctx.userId, folderId: args.folder_id });
  if (out.kind === "error") return folderFailureToToolError("delete_folder", out);

  const all = [...out.result.trashedNoteIds].sort();
  const ids = all.slice(0, MCP_DELETE_FOLDER_IDS_MAX);
  // 同一交易移入、移入時刻相同，任取一篇即可；沒有移入任何筆記、或 commit 後全被還原／永久刪除 → null。
  const purgeAt = await loadTrashedPurgeAt(ctx.db, ids);
  return toolResult({
    trashedNoteCount: all.length,
    trashedNoteIds: ids,
    ...(all.length > MCP_DELETE_FOLDER_IDS_MAX ? { trashedNoteIdsTruncated: true as const } : {}),
    deletedFolderCount: out.result.deletedFolderIds.length,
    purgeAt: purgeAt?.toISOString() ?? null,
  });
}
