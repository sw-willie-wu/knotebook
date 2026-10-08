/**
 * 位元組數的人類可讀形（儲存配額 spec §8.3-3：`create_transfer_token` 已滿訊息裡的 `<used>`／`<quota>`）。
 * 1024 進位、B／KB／MB／GB／TB；未滿 1 KB 印整數（`512 B`），其餘一位小數（`2.0 GB`）；TB 以上仍以 TB 表示。
 * 四捨五入後若恰好進到下一個單位（例：1048575 → 1023.999… KB → 「1024.0 KB」），改用下一個單位（「1.0 MB」）。
 */
const UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let i = 0;
  while (i < UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${UNITS[i]}`;
}
