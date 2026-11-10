// 資料夾。
// `NoteDto.folderId`／`sizeBytes`、`TrashItemDto.folderPath` 與 server 的對應欄位同時加（避免 shared 先改、server 編不過）。

export const FOLDER_NAME_MAX = 80;
export const FOLDER_DEPTH_MAX = 5;          // 根層資料夾為第 1 層
export const FOLDERS_PER_SPACE_MAX = 1000;

export type FolderKind = "personal" | "group" | "shared";
export type FolderSpaceDto = { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string };

export interface FolderPermissionsDto {
  manage: boolean;      // 建子資料夾、改名、搬移、刪除（無活筆記時）
  deleteNotes: boolean; // 子樹有活筆記時能不能刪（群組＝can_delete；個人恆真；shared 恆真＝只移除）
  createNote: boolean;  // 在此建立筆記（personal 恆真；group＝create ∧ edit；shared 恆 false）
}

export interface FolderDto { id: string; name: string; parentId: string | null; space: FolderSpaceDto; createdAt: string; permissions: FolderPermissionsDto }
export interface FolderListDto { folders: FolderDto[] }
export interface FolderDeleteResultDto { trashedNoteIds: string[]; deletedFolderIds: string[] }
