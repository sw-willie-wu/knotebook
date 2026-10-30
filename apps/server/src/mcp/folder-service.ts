/**
 * 資料夾 PR-3d：資料夾寫入工具（create／rename／move_folder、move_note_to_folder、delete_folder）共用的服務層 deps，
 * 與 create／rename／move_folder 成功後「以 list_folders 的形重讀」。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listVisibleFoldersPage } from "../folders/queries.js";
import type { FolderServiceDeps } from "../folders/service.js";
import { folderForModel } from "./folder-fields.js";
import { FOLDER_NOT_FOUND_MESSAGE } from "./folder-messages.js";
import { toolError, toolResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

/** 服務層 deps（同 delete_note／restore_note 的組法）。 */
export function folderServiceDeps(ctx: McpToolCtx): FolderServiceDeps {
  return {
    db: ctx.db,
    collabHooks: ctx.collabHooks,
    storageLockTimeoutMs: ctx.storageLockTimeoutMs,
    groupTestHook: ctx.groupTestHook,
    limiters: { edit: ctx.limiters.edit },
  };
}

/**
 * 成功後以 list_folders 的形重讀那一個資料夾（帶路徑與群組名）。重讀落空＝commit 之後、重讀之前被刪的毫秒級競態
 * → `not_found`＋FM1（同 move_note_to_group 的重讀先例）。
 */
export async function folderReply(ctx: McpToolCtx, folderId: string): Promise<CallToolResult> {
  const page = await listVisibleFoldersPage(ctx.db, ctx.userId, { ids: [folderId], limit: 1, after: null });
  const row = page.rows[0];
  if (row === undefined) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
  return toolResult({ folder: folderForModel(row) });
}
