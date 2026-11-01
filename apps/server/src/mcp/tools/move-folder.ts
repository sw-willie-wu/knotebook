/**
 * 資料夾 PR-3d（folders spec §5.12、§5.7.3）`move_folder`：同空間內搬移（含整棵子樹）。服務層 `updateFolder` 負責入口順序
 * （看不到的父層先回 404，看得到但跨空間才 400）、成環、深度與交易。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";
import { updateFolder } from "../../folders/service.js";
import { FOLDER_ID } from "../folder-fields.js";
import { folderFailureToToolError } from "../folder-messages.js";
import { folderReply, folderServiceDeps } from "../folder-service.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** D-MF（逐字照 plan「待確認字串」）。 */
export const MOVE_FOLDER_DESCRIPTION =
  "Move a folder you can see, with everything in it, into another folder of the same space, or to the top level of its space with `parent_id: null`. " +
  "A folder can't move to another space — out of your personal folders, out of its group, or out of your folders for notes shared with you — " +
  `or into itself or one of its subfolders, and the moved folder and everything under it must end up at most ${FOLDER_DEPTH_MAX} levels deep. ` +
  "In a group, it needs a role that can edit notes. The notes inside stay in their folders; who can see them and their URLs don't change. " +
  "The reply is the folder, in the shape list_folders returns.";

export const MF_FOLDER = "The id of the folder to move, from list_folders.";
export const MF_PARENT = "The id of the folder to move it into, from list_folders, or null for the top level of its space.";

/** 註冊為 `z.object(moveFolderInput).strict()`。 */
export const moveFolderInput = {
  folder_id: FOLDER_ID.describe(MF_FOLDER),
  parent_id: FOLDER_ID.nullable().describe(MF_PARENT),
};

export async function moveFolderTool(args: { folder_id: string; parent_id: string | null }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  const out = await updateFolder(folderServiceDeps(ctx), { by: ctx.userId, folderId: args.folder_id, parentId: args.parent_id });
  if (out.kind === "error") return folderFailureToToolError("move_folder", out);
  return folderReply(ctx, out.folder.id);
}
