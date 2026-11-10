// #181 垃圾桶 DTO。垃圾桶 DTO 只增不改；資料夾已加 `folderPath`。
import type { NoteDto } from "./index.js";

export const TRASH_RETENTION_DAYS_DEFAULT = 7;
export const TRASH_RETENTION_DAYS_MIN = 1;
export const TRASH_RETENTION_DAYS_MAX = 3650;
/** restore／purge 每請求的 id 上限。 */
export const TRASH_BATCH_MAX = 200;
/** GET /api/trash 一次最多列幾筆（超過 → truncated）。 */
export const TRASH_LIST_LIMIT = 1000;

export type TrashSkipReason = "not_found" | "not_in_trash";

export interface TrashItemDto {
  id: string;
  title: string;
  deletedAt: string; // ISO
  purgeAt: string | null; // 保留天數 NULL 時 null
  deletedBy: { handle: string; displayName: string } | null; // 帳號已刪 → null
  group: { id: string; name: string } | null; // 個人筆記 null
  /** 原資料夾路徑（根 → 葉）：資料夾還在 → 即時路徑，否則刪除當下的快照；根層 → []。 */
  folderPath: string[];
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
