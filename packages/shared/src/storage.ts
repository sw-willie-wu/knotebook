/**
 * 儲存空間配額（spec 2026-10-08-storage-quota-design.md §4、§7.4、§8.1）。位元組數一律 JS number（≤ 2^50，安全整數）。
 * 「空間」＝一位使用者的個人筆記全體、或一個群組的筆記全體；用量＝該空間筆記的 `uploads.size` 總和（只計附件，D5）。
 */
export const STORAGE_PLAN_NAME_MAX = 40;
/** 1 PiB＝2^50：DB CHECK `storage_plans_quota_chk` 的上界，JS number 精確。 */
export const STORAGE_QUOTA_MAX_BYTES = 1125899906842624;
/** 內建 Basic 方案在 migration 的初始配額：2 GiB（UI 以 1024 進位標「GB」，Q2）。 */
export const BASIC_STORAGE_QUOTA_BYTES = 2147483648;

/** `GET /api/storage`、`GET /api/groups/:id/storage`。`quotaBytes` null＝無上限。 */
export interface StorageUsageDto {
  usedBytes: number;
  quotaBytes: number | null;
  planName: string;
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
