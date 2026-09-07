/**
 * Origin／Host 比對的葉節點模組（`app.ts` 與 `routes/mcp.ts` 共同依賴，不依賴任何一方）。
 *
 * ⚠ **這裡有兩種比較語意，不可互換**：
 * - `app.ts` 的 `isOriginAllowed`（multipart 豁免路由的 CSRF 防線）比的是 `Origin` 對
 *   **`request.host`**——兩側都來自請求，它防的是 CSRF 不是 DNS rebinding。
 * - `mcpOriginAllowed`（`/api/mcp`，#108 §7.4 D10／M3）比的另一側**恆為 `PUBLIC_URL`
 *   推導的 host**，`Origin` 與 `request.host` 兩者都要對上它。
 *
 * `stripDefaultPort` 是兩者共用的那一半（下方註解逐字自 `app.ts` 搬過來）。
 */

/**
 * 兩側 `:80`/`:443` 預設 port 消去後再比對（spec §12.4：scheme 忽略、IPv6 方括號原樣）。
 *
 * 手寫 regex 而非借用 `new URL().host` 的內建預設 port 消去，是刻意選擇，不是偷懶：
 * 1. 比對的另一側（`request.host`）根本不是 URL——它是裸的 `Host`/`X-Forwarded-Host`
 *    header 值（例如 `example.com:443`），沒有 `URL` 物件可用，沒有 scheme 可言。
 * 2. `URL.host` 的預設 port 消去是 **scheme-bound** 的（`https://x:443` 消去、
 *    `http://x:443` 不會——443 不是 http 的預設 port）；但 spec 明文「scheme 忽略」——
 *    若真要湊出一個 `URL` 來讓內建消去生效，得先幫 `request.host` 那側**假造一個
 *    scheme**（例如硬套 `https://`）才能餵給 `new URL()`，這個假造的 scheme 會跟
 *    「scheme 忽略」的契約直接打架（相當於偷偷把 scheme 又塞回比對邏輯裡）。
 * 手寫、對稱地在兩側字面字串上剝 `:80`/`:443` 後綴，才是唯一不引入假 scheme 的作法。
 */
export function stripDefaultPort(host: string): string {
  return host.replace(/:(?:80|443)$/, "");
}

/**
 * #108 §7.4 D10／M3：`/api/mcp` 的 DNS-rebinding 守衛。比較的另一側**恆為 `PUBLIC_URL`
 * 推導的 host**，永遠不是 `request.host` 自己——兩個都來自請求的值互比是無效守衛
 * （攻擊者把 `evil.com` 重綁到 LAN IP 時 `Origin` 與 `Host` 兩者相等，就這樣放行了）。
 *
 * `Origin: "null"`（referrer policy 降級後瀏覽器字面送出的規定值）與任何不可解析的值
 * 一律不放行——少一層 try/catch 就是 500 而不是 403，直接違反規格那條 MUST。
 *
 * 呼叫端負責「不帶 `Origin` → 放行」（D10 刻意的放行面）；`undefined` 不該被硬塞進來
 * 解讀成某種「值」，比照既有的 `isOriginAllowed`。
 */
export function mcpOriginAllowed(origin: string, requestHost: string, publicHost: string): boolean {
  // 這其實是死分支：`new URL("null")` 本來就會 throw（實測 `TypeError`），下面的
  // try/catch 已經涵蓋同樣的結果。這一行單獨顯式判斷，只是為了與 `app.ts` 的
  // `isOriginAllowed` 對齊寫法一致——不是擋住 "null" 的唯一防線。
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const want = stripDefaultPort(publicHost);
  return stripDefaultPort(originHost) === want && stripDefaultPort(requestHost) === want;
}
