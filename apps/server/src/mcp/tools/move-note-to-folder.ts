/**
 * 資料夾 PR-3d（folders spec §5.12、§5.7.5）`move_note_to_folder`：把一篇筆記放進同空間的資料夾，或 `folder_id: null` 回根層。
 * 服務層（`folders/service.ts` 的 `placeNote`）負責入口順序（筆記先判，再資料夾可見性、空間）、扣 `edit` 桶、縫與交易內重判；
 * 這裡只做 scope、錯誤映射與回應組裝。被分享者的放置只寫自己的 `note_placements`，擁有者的 `notes.folder_id` 不動（AG-F1）。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { placeNote } from "../../folders/service.js";
import { NOTE_ID } from "../../notes/schemas.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { FOLDER_ID } from "../folder-fields.js";
import { folderFailureToToolError } from "../folder-messages.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../note-read.js";
import { rereadAnyVisibleNote } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import { folderServiceDeps } from "./create-folder.js";
import type { McpToolCtx } from "../context.js";

/** D-MNF（逐字照 plan「待確認字串」）。 */
export const MOVE_NOTE_TO_FOLDER_DESCRIPTION =
  "File a note in a folder, or at the top level of its space with `folder_id: null`. The folder must be in the note's own space: " +
  "one of your personal folders for a note of yours; one of the group's folders for a group note, which needs a role that can edit notes; " +
  "or one of your folders for notes shared with you, for a note someone shared with you — that filing is yours alone, and its owner and " +
  "anyone else see nothing change. Filing never changes who can see the note, its URL, its content or its `updatedAt`. It never moves a " +
  "personal note into a group; move_note_to_group does that, and needs the notes:move scope. The reply is the note, in the shape list_notes returns.";

export const MNF_FOLDER = "The id of the folder to file the note in, from list_folders, or null for the top level of the note's space.";

/** 註冊為 `z.object(moveNoteToFolderInput).strict()`。 */
export const moveNoteToFolderInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  folder_id: FOLDER_ID.nullable().describe(MNF_FOLDER),
};
export const moveNoteToFolderOutput = { note: noteSummarySchema.describe("The note after filing, in the same shape list_notes returns.") };

export async function moveNoteToFolderTool(args: { note_id: string; folder_id: string | null }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  const out = await placeNote(folderServiceDeps(ctx), { by: ctx.userId, noteId: args.note_id, folderId: args.folder_id });
  if (out.kind === "error") return folderFailureToToolError("move_note_to_folder", out);
  // 共享筆記要讀 shared 支（呼叫者視角的 folder 是自己的放置）。落空＝commit 之後、重讀之前被撤分享或移走的競態。
  const row = await rereadAnyVisibleNote(ctx, args.note_id);
  if (!row) return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  const [note] = await noteSummariesForModel(ctx.db, [row]);
  return toolResult({ note });
}
