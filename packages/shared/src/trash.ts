// Trash DTOs only gain fields; never change their shape.
import type { NoteDto } from "./note-dto.js";

export const TRASH_RETENTION_DAYS_DEFAULT = 7;
export const TRASH_RETENTION_DAYS_MIN = 1;
export const TRASH_RETENTION_DAYS_MAX = 3650;
/** Ids per restore/purge request. */
export const TRASH_BATCH_MAX = 200;
/** More items than this: the list is cut and `truncated` is true. */
export const TRASH_LIST_LIMIT = 1000;

export type TrashSkipReason = "not_found" | "not_in_trash";

export interface TrashItemDto {
  id: string;
  title: string;
  deletedAt: string; // ISO
  purgeAt: string | null; // null when retention is unlimited
  deletedBy: { handle: string; displayName: string } | null; // null: account deleted
  group: { id: string; name: string } | null; // null for personal notes
  /** Root to leaf. Live path while the folder exists, else the snapshot at deletion; [] at root. */
  folderPath: string[];
}

export interface TrashPreviewDto extends TrashItemDto {
  /** Base64-encoded Yjs update (`EMPTY_YDOC_UPDATE_B64` when the note was never opened in the editor). */
  ydoc: string;
}

export interface TrashListDto {
  retentionDays: number | null;
  items: TrashItemDto[];
  truncated: boolean;
}

export interface TrashSkipDto {
  id: string;
  reason: TrashSkipReason;
}

export interface TrashRestoreResultDto {
  restored: NoteDto[];
  skipped: TrashSkipDto[];
}

export interface TrashPurgeResultDto {
  purged: string[];
  skipped: TrashSkipDto[];
}

export interface TrashSettingsDto {
  retentionDays: number | null;
}
