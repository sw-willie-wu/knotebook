// Byte counts are JS numbers (≤ 2^50). Usage = the space's uploads.size sum; personal spaces add every avatar
// candidate's original_size + display_size.
export const STORAGE_PLAN_NAME_MAX = 40;
/** 2^50: upper bound of DB CHECK storage_plans_quota_chk. */
export const STORAGE_QUOTA_MAX_BYTES = 1125899906842624;
/** Initial quota of the built-in Basic plan in the migration: 2 GiB (the UI labels it GB, 1024-based). */
export const BASIC_STORAGE_QUOTA_BYTES = 2147483648;

/** Recorded sizes of stored Y.Doc state and of versions plus state backups; neither counts toward the limit. */
export interface ContentUsageDto {
  noteBytes: number;
  historyBytes: number;
}

/** `quotaBytes` null: unlimited. */
export interface StorageUsageDto {
  usedBytes: number;
  quotaBytes: number | null;
  planName: string;
  /** Separate query from `usedBytes`, so the UI uses the sum of kinds as the share denominator. */
  byKind: StorageByKind;
  content: ContentUsageDto;
}

/** All five keys always present. Personal avatars count as `image`. */
export interface StorageByKind {
  image: number;
  audio: number;
  video: number;
  document: number;
  other: number;
}
export type StorageKind = keyof StorageByKind;

export const STORAGE_KINDS: readonly StorageKind[] = ["image", "audio", "video", "document", "other"];

/** A new object each call: callers accumulate into it. */
export function emptyStorageByKind(): StorageByKind {
  return { image: 0, audio: 0, video: 0, document: 0, other: 0 };
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

/** The only classification rule: the server groups by uploads.mime and classifies here, not in SQL. */
export function kindOfMime(mime: string): StorageKind {
  const m = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/") || DOCUMENT_MIMES.has(m) || m.startsWith("application/vnd.openxmlformats-officedocument.")) return "document";
  return "other";
}

/**
 * Grouped by uploads.charged_to_id (who brought the bytes in: uploader, mover or copier). `userId` null: that account was
 * deleted (on delete set null) or none was recorded (no COALESCE with uploader_id); such rows are merged.
 */
export interface GroupStorageMemberUsageDto {
  userId: string | null;
  handle: string | null;
  displayName: string | null;
  bytes: number;
}

export interface GroupStorageUsageDto extends StorageUsageDto {
  /** Only bytes > 0; bytes descending, ties by userId ascending, null last. */
  byMember: GroupStorageMemberUsageDto[];
}

export interface SpaceStorageDto {
  planId: string;
  planName: string;
  usedBytes: number;
  quotaBytes: number | null;
  /** noteBytes + historyBytes; not part of `usedBytes`. */
  contentBytes: number;
}

export interface StoragePlanDto {
  id: string;
  name: string;
  quotaBytes: number | null;
  userCount: number;
  groupCount: number;
  /** Always 0 when quotaBytes is null. */
  overQuotaCount: number;
  isDefaultForUsers: boolean;
  isDefaultForGroups: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoragePlanDefaultsDto {
  userPlanId: string;
  groupPlanId: string;
}

export interface StoragePlansResponse {
  plans: StoragePlanDto[];
  defaults: StoragePlanDefaultsDto;
}

export interface AdminGroupDto {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  storage: SpaceStorageDto;
}

/** `usedBytes`/`quotaBytes` only when the caller may view the space's usage; `incomingBytes` is null for the pre-body check. */
export interface StorageQuotaErrorDetail {
  incomingBytes: number | null;
  usedBytes?: number;
  quotaBytes?: number | null;
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let i = 0;
  // Compare the rounded value so 1048575 bytes (1023.999 KB) prints "1 MB", not "1024 KB".
  while (i < BYTE_UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    i++;
  }
  const fixed = value.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed} ${BYTE_UNITS[i]}`;
}
