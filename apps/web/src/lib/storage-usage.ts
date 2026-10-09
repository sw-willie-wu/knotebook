/**
 * 「已達上限」＝用量 >= 上限（Willie 2026-10-08：恰好等於上限時已不能再新增任何 > 0 的附件，也要警示）。
 * 刻意**不**同於 server 的 `overQuotaCount`（`>`，`routes/admin-storage.ts:62-68`，方案表那一欄照它的語意標「超過上限的空間數」）。
 * 上限 `null`＝無上限，恆 false；配額 0 時用量 0 也是 true（確實什麼都加不進去）。
 */
export function isQuotaReached(u: { usedBytes: number; quotaBytes: number | null }): boolean {
  return u.quotaBytes !== null && u.usedBytes >= u.quotaBytes;
}
