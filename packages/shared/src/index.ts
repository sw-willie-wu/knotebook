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
