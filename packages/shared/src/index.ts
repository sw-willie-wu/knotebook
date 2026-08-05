export const YDOC_FRAGMENT = "knotebook";

export const SESSION_COOKIE = "knotebook_session";

export type Role = "owner" | "editor" | "viewer" | "none";

export interface ApiError {
  error: { code: string; message: string };
}

export interface NoteDto {
  id: string;
  title: string;
  ownerId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

// 分享名單上的角色只會是 'editor'/'viewer'——note_shares 表的 DB check constraint
// 本就不允許存 'owner'/'none'（owner 不會出現在 note_shares 裡；'none' 純粹是
// resolveRole 用來表示「無權限」的哨兵值，從不落地成一筆分享列）。與 NoteDto 的
// `Role`（涵蓋全部四種狀態）刻意分開成獨立型別，讓「這欄位只可能是這兩種角色」
// 這件事在型別層就看得出來。
export type ShareRole = "editor" | "viewer";

export interface ShareDto {
  userId: string;
  email: string;
  displayName: string;
  role: ShareRole;
}
