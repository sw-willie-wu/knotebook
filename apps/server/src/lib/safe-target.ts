/**
 * 取 URL 的 `origin + pathname` 供稽核日誌使用（#46；#187 PR2 起登入服務的 issuer 稽核也用）。
 *
 * **刻意不記完整 URL**：`base_url` 可能帶 `user:pass@`（`origin` 不含 userinfo）或把憑證放在
 * query（`pathname` 不含 query），整條寫進日誌等於把另一種憑證留在那裡。但也不能只記 host
 * ——`http://x` → `https://x`、或 `https://gw/tenant-a` → `/tenant-b` 這類變更會記成前後
 * 完全相同，一行看起來像沒發生事（審查指出）。解析不出來回 undefined（pino 會略過該欄位）。
 */
export function safeTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}
