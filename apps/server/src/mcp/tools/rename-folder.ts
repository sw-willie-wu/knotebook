/**
 * 資料夾 PR-3d（folders spec §5.12、§5.7.2）`rename_folder`：只改名，不動位置、筆記與網址。服務層 `updateFolder` 負責入口順序與交易。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOLDER_NAME_MAX } from "@knotebook/shared";
import { normalizeFolderName } from "../../folders/names.js";
import { updateFolder } from "../../folders/service.js";
import { FOLDER_ID } from "../folder-fields.js";
import { folderFailureToToolError, folderNameErrorMessage } from "../folder-messages.js";
import { folderReply, folderServiceDeps } from "../folder-service.js";
import { toolError } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** D-RF（逐字照 plan「待確認字串」）。 */
export const RENAME_FOLDER_DESCRIPTION =
  "Rename a folder you can see; in a group, it needs a role that can edit notes. The name rules are the same as for create_folder. " +
  "Nothing else changes — not where the folder is, not the notes in it, not any URL. The reply is the folder, in the shape list_folders returns.";

export const RF_FOLDER = "The id of the folder to rename, from list_folders.";
export const RF_NAME = `The new name: 1 to ${FOLDER_NAME_MAX} characters, with no line breaks or other control characters.`;

/** 註冊為 `z.object(renameFolderInput).strict()`。 */
export const renameFolderInput = {
  folder_id: FOLDER_ID.describe(RF_FOLDER),
  name: z.string().max(1000).describe(RF_NAME),
};

export async function renameFolderTool(args: { folder_id: string; name: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  const name = normalizeFolderName(args.name);
  if (!name.ok) return toolError("invalid_body", folderNameErrorMessage(name.reason));
  const out = await updateFolder(folderServiceDeps(ctx), { by: ctx.userId, folderId: args.folder_id, name: args.name });
  if (out.kind === "error") return folderFailureToToolError("rename_folder", out);
  return folderReply(ctx, out.folder.id);
}
