/**
 * 儲存空間配額（spec 2026-10-08-storage-quota-design.md §4、§7.4、§8.1）。位元組數一律 JS number（≤ 2^50，安全整數）。
 * 「空間」＝一位使用者的個人筆記全體、或一個群組的筆記全體；用量＝該空間筆記的 `uploads.size` 總和（只計附件，D5）。
 */
export const STORAGE_PLAN_NAME_MAX = 40;
/** 1 PiB＝2^50：DB CHECK `storage_plans_quota_chk` 的上界，JS number 精確。 */
export const STORAGE_QUOTA_MAX_BYTES = 1125899906842624;
/** 內建 Basic 方案在 migration 的初始配額：2 GiB（UI 以 1024 進位標「GB」，Q2）。 */
export const BASIC_STORAGE_QUOTA_BYTES = 2147483648;

/** `GET /api/storage`、`GET /api/groups/:id/storage`（後者實際回 `GroupStorageUsageDto`）。`quotaBytes` null＝無上限。 */
export interface StorageUsageDto {
  usedBytes: number;
  quotaBytes: number | null;
  planName: string;
  /** #247 §9.1。與 `usedBytes` 是兩句查詢、不在同一時點：UI 的佔比分母取這五值之和，不取 `usedBytes`。 */
  byKind: StorageByKind;
}

/**
 * #247 §9.1：上傳媒體依類型的位元組數。五鍵恆在（W30：UI 五列恆顯示，含 0）。
 * 現況上傳只收四種圖片 mime（server `uploads/magic-bytes.ts`），所以只有 image 會非零；版面先為多類型留好。
 */
export interface StorageByKind {
  image: number;
  audio: number;
  video: number;
  document: number;
  other: number;
}
export type StorageKind = keyof StorageByKind;

/** UI「依類型」五列的固定順序。 */
export const STORAGE_KINDS: readonly StorageKind[] = ["image", "audio", "video", "document", "other"];

/** 每次回新物件（呼叫端會就地累加）。 */
export function emptyStorageByKind(): StorageByKind {
  return { image: 0, audio: 0, video: 0, document: 0, other: 0 };
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
]);

/**
 * mime → 類型（spec #247 §9.1）。正規化（取 `;` 前、trim、小寫）是 spec 未寫、刻意加的（總管裁定 5）。分類規則只有這一份：server 以 `GROUP BY uploads.mime` 取各 mime 的總和後在 JS 端歸類，
 * 不在 SQL 重寫一次。先取 `;` 前的部分、trim、轉小寫（`text/plain; charset=utf-8`、`IMAGE/PNG` 照常歸類）。
 */
export function kindOfMime(mime: string): StorageKind {
  const m = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/") || DOCUMENT_MIMES.has(m) || m.startsWith("application/vnd.openxmlformats-officedocument.")) return "document";
  return "other";
}

/** 群組用量的「依成員」一列（#247 §9.2）。`userId` null＝上傳者帳號已刪除（`uploads.uploader_id` on delete set null），全部彙總成一列。 */
export interface GroupStorageMemberUsageDto {
  userId: string | null;
  handle: string | null;
  displayName: string | null;
  bytes: number;
}

/** `GET /api/groups/:id/storage`（#247 §9.2）。`byMember` 只含 bytes > 0 的列，bytes 降冪；同 bytes 依 userId 升冪、null 列最後。 */
export interface GroupStorageUsageDto extends StorageUsageDto {
  byMember: GroupStorageMemberUsageDto[];
}

/** 站台管理的使用者列與群組列上的儲存欄（`AdminUserDto.storage`、`AdminGroupDto.storage`）。 */
export interface SpaceStorageDto {
  planId: string;
  planName: string;
  usedBytes: number;
  quotaBytes: number | null;
}

export interface StoragePlanDto {
  id: string;
  name: string;
  quotaBytes: number | null;
  userCount: number;
  groupCount: number;
  /** 指派到此方案、且用量 > 配額的空間數（使用者＋群組）；配額 null 時恆 0。 */
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

/** `GET /api/admin/storage-plans`。 */
export interface StoragePlansResponse {
  plans: StoragePlanDto[];
  defaults: StoragePlanDefaultsDto;
}

/** `GET /api/admin/groups` 的一列、`PATCH /api/admin/groups/:id/storage-plan` 的回應。 */
export interface AdminGroupDto {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  storage: SpaceStorageDto;
}

/**
 * 409 `storage_quota_exceeded` 回應的頂層 `storage` 欄（§8.1）。`incomingBytes` 恆在（讀 body 之前的預檢為 null）；
 * `usedBytes`／`quotaBytes` 只在呼叫者能檢視該空間用量時帶（owner、群組 manageGroup、站台 admin）。
 */
export interface StorageQuotaErrorDetail {
  incomingBytes: number | null;
  usedBytes?: number;
  quotaBytes?: number | null;
}

/**
 * 位元組數的人類可讀形（儲存配額 spec §8.3-3 MCP 訊息、§9.1 web 顯示共用）。
 * 1024 進位、B／KB／MB／GB／TB；未滿 1 KB 印整數（`512 B`）；其餘四捨五入到一位小數，結果是整數就不帶 `.0`
 * （`2 GB`、`500 MB`；`1.2 GB`——Willie 2026-10-08）；TB 以上仍以 TB 表示。
 * 四捨五入後若恰好進到下一個單位（例：1048575 → 1023.999… KB → 「1024 KB」），改用下一個單位（「1 MB」）。
 */
const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let i = 0;
  while (i < BYTE_UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    i++;
  }
  const fixed = value.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed} ${BYTE_UNITS[i]}`;
}
