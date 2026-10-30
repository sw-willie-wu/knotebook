/**
 * 資料夾 PR-3d（spec §5.12 錯誤形、M10）：資料夾相關的模型面英文句，與 `FolderFailure`（folders/service.ts）→ MCP 錯誤結果的映射。
 * 服務層的訊息是中文、同一碼可能有多句，所以這裡依「工具＋碼」映射，不比對中文字面（plan 讀碼發現 11）。
 * 字面逐字照 plan「待確認字串」；改字前讀 memory g:model-facing-string-claims。
 */
import { FOLDER_DEPTH_MAX, FOLDER_NAME_MAX, FOLDERS_PER_SPACE_MAX, type ErrorCode } from "@knotebook/shared";
import { NOTE_NOT_FOUND_MESSAGE } from "./note-read.js";
import { toolError, type ToolErrorResult } from "./tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE } from "./write-messages.js";

/** FM1：每支工具同一句（AG-F3：看不到＝不存在）。 */
export const FOLDER_NOT_FOUND_MESSAGE =
  "No folder with that id that you can use here. For example, it may not exist, may have been deleted, or may be someone else's or in a group whose notes your role can't read; list_folders shows the folders you can see.";
/** FM2 */
export const FOLDER_GROUP_NOT_FOUND_MESSAGE = "No group with that id among your groups where your role can read notes.";
/** FM3 */
export const FOLDER_MANAGE_FORBIDDEN_MESSAGE =
  "Your role in that group can't change its folders — creating, renaming, moving and deleting them needs a role that can edit notes — so nothing was changed.";
/** FM4（unstorable） */
export const FOLDER_NAME_UNSTORABLE_MESSAGE =
  "That folder name contains a character that can't be stored (a NUL or an unpaired surrogate), so nothing was changed.";
/** FM5（control） */
export const FOLDER_NAME_CONTROL_MESSAGE =
  "Folder names can't contain line breaks, tabs, or other control or text-direction characters, so nothing was changed.";
/** FM6（length） */
export const FOLDER_NAME_LENGTH_MESSAGE = `Folder names must be 1 to ${FOLDER_NAME_MAX} characters once surrounding whitespace is removed, so nothing was changed.`;
/** FM7（name taken） */
export const FOLDER_NAME_TAKEN_MESSAGE =
  "There is already a folder with that name in that place — names that differ only in letter case can count as the same — so nothing was changed.";
/** FM8（too deep） */
export const FOLDER_TOO_DEEP_MESSAGE = `That would put a folder more than ${FOLDER_DEPTH_MAX} levels deep (a top-level folder is level 1), so nothing was changed.`;
/** FM9（cycle） */
export const FOLDER_CYCLE_MESSAGE = "A folder can't be moved into itself or into one of its own subfolders, so nothing was changed.";
/** FM10（limit） */
export const FOLDER_LIMIT_MESSAGE = `That space already has the most folders it can hold (${FOLDERS_PER_SPACE_MAX}), so the folder was not created.`;
/** FM11（busy） */
export const FOLDER_BUSY_MESSAGE = "The server was busy, so nothing was changed. Try again in a moment.";
/** FM12（放置被拒） */
export const NOTE_FILE_FORBIDDEN_MESSAGE =
  "Your access to this note doesn't allow filing it, so nothing was changed. Filing a group's notes into folders needs a role in that group that can edit notes.";
/** FM13（D13，建立／複製／移入） */
export const FOLDER_NEEDS_EDIT_MESSAGE =
  "Your role in that group can create notes but not edit them, so it can't put a note in one of the group's folders. Leave out `folder_id` to put it at the group's top level.";
/** FM14（建立／複製跨空間） */
export const NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE =
  "That folder can't hold this note: a personal folder takes a note without `group_id`, a group's folder needs that group's id as `group_id`, and your folders for notes shared with you don't hold new notes.";
/** FM15（移入群組跨空間） */
export const MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE =
  "That folder isn't one of the folders of the group you're moving the note into. Use one of that group's folders — list_folders with `group_id` shows them — or leave out `folder_id` for the group's top level.";
/** FM16（放置跨空間） */
export const NOTE_FOLDER_CROSS_SPACE_MESSAGE =
  "That folder isn't in this note's space. A note can only be filed among your personal folders if it is yours, its group's folders if it is a group note, or your folders for notes shared with you if someone shared it with you. Moving a personal note into a group is what move_note_to_group does; it needs the notes:move scope.";
/** FM17（搬資料夾跨空間） */
export const FOLDER_MOVE_CROSS_SPACE_MESSAGE =
  "A folder can only move within its own space — among your personal folders, within one group, or among your folders for notes shared with you — so nothing was changed. Pass `parent_id: null` to move it to the top level of its space.";
/** FM18（刪除被擋） */
export const FOLDER_DELETE_BLOCKED_MESSAGE =
  "That folder, or one inside it, holds notes your role can't move to the trash, so nothing was deleted.";
/** FM19（內容剛變） */
export const FOLDER_CONTENT_CHANGED_MESSAGE = "The folder's contents changed while it was being deleted, so nothing was deleted. Try again.";
/** FM20（位置參數多給） */
export const FOLDER_POSITION_AMBIGUOUS_MESSAGE = "Pass at most one of `parent_id`, `group_id` and `shared: true`, so nothing was created.";
/** `create_note` 建列遇到可重試錯誤（與 REST 的 409 `server_busy` 對齊）。FM21＝`keyset-cursor.ts` 的 `BAD_CURSOR_MESSAGE`。 */
export const CREATE_BUSY_MESSAGE = "The server was busy, so no note was created. Try again in a moment.";

export type FolderTool = "create_folder" | "rename_folder" | "move_folder" | "move_note_to_folder" | "delete_folder";

const NAME_ERROR_MESSAGES: Record<"unstorable" | "control" | "length", string> = {
  unstorable: FOLDER_NAME_UNSTORABLE_MESSAGE,
  control: FOLDER_NAME_CONTROL_MESSAGE,
  length: FOLDER_NAME_LENGTH_MESSAGE,
};

/** 服務層名稱三因（folders/names.ts 的 `normalizeFolderName`）→ 英文（FM4／FM5／FM6）。 */
export function folderNameErrorMessage(reason: "unstorable" | "control" | "length"): string {
  return NAME_ERROR_MESSAGES[reason];
}

/**
 * `FolderFailure`（folders/service.ts）→ MCP 錯誤結果。未列的碼 → throw（接線錯，交給 runTool → internal）：
 * `invalid_body`（名稱）由呼叫端先以 `normalizeFolderName` 預判，到這裡＝漂移；`folder_cross_space` 只有搬資料夾與放置到得了
 * （`createFolder` 以父層繼承空間、改名不帶 `parentId`、刪除不判空間）。
 */
export function folderFailureToToolError(tool: FolderTool, f: { code: ErrorCode }): ToolErrorResult {
  switch (f.code) {
    case "folder_not_found":
      return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    case "group_not_found":
      return toolError("group_not_found", FOLDER_GROUP_NOT_FOUND_MESSAGE);
    case "forbidden":
      return toolError("forbidden", tool === "move_note_to_folder" ? NOTE_FILE_FORBIDDEN_MESSAGE : FOLDER_MANAGE_FORBIDDEN_MESSAGE);
    case "folder_delete_blocked":
      return toolError("forbidden", FOLDER_DELETE_BLOCKED_MESSAGE);
    case "folder_cross_space":
      if (tool === "move_folder") return toolError("invalid_body", FOLDER_MOVE_CROSS_SPACE_MESSAGE);
      if (tool === "move_note_to_folder") return toolError("invalid_body", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
      break;
    case "folder_name_taken":
      return toolError("conflict", FOLDER_NAME_TAKEN_MESSAGE);
    case "folder_too_deep":
      return toolError("conflict", FOLDER_TOO_DEEP_MESSAGE);
    case "folder_cycle":
      return toolError("conflict", FOLDER_CYCLE_MESSAGE);
    case "folder_limit":
      return toolError("conflict", FOLDER_LIMIT_MESSAGE);
    case "conflict":
      return toolError("conflict", FOLDER_CONTENT_CHANGED_MESSAGE);
    case "not_found":
      return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    case "too_many_requests":
      return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);
    case "server_busy":
      return toolError("server_busy", FOLDER_BUSY_MESSAGE);
  }
  throw new Error(`folderFailureToToolError：${tool} 收到未映射的碼 ${f.code}`);
}
