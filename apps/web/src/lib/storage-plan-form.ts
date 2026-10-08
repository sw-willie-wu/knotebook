import { STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES } from "@knotebook/shared";

/** 方案名稱的前端預檢（與 server `routes/admin-storage.ts:40-45` 同規則，除了 NUL／落單代理——那兩種交給 server 回 invalid_name）。 */
export function validPlanName(raw: string): string | null {
  const name = raw.trim();
  const n = [...name].length;
  return n >= 1 && n <= STORAGE_PLAN_NAME_MAX ? name : null;
}

export type QuotaUnit = "MB" | "GB";
const UNIT_BYTES: Record<QuotaUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 };

/** 「數字＋單位」→ bytes（1024 進位，spec Q2）。只收無號十進位（`12`、`1.5`）；其餘（空、負、指數、逗號）與超過 2^50 一律 null。 */
export function quotaBytesFromInput(raw: string, unit: QuotaUnit): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const bytes = Math.round(Number(s) * UNIT_BYTES[unit]);
  if (!Number.isSafeInteger(bytes) || bytes > STORAGE_QUOTA_MAX_BYTES) return null;
  return bytes;
}

/** bytes → 對話框初值：整 GiB（且 > 0）用 GB，其餘用 MB（最多 6 位小數、去尾零）。 */
export function quotaInputFromBytes(bytes: number): { value: string; unit: QuotaUnit } {
  if (bytes > 0 && bytes % UNIT_BYTES.GB === 0) return { value: String(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { value: String(Number((bytes / UNIT_BYTES.MB).toFixed(6))), unit: "MB" };
}
