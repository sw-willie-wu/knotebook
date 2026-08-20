/**
 * 檔案／媒體 block（image・video・audio・file）的 URL 安全判定。
 *
 * **兩個函式、兩種嚴格度，刻意不合併**：
 *
 * - {@link isAllowedEmbedUrl}：**輸入端**（FilePanel 的 Embed tab）。只收完整的
 *   `http(s)://…`，不替使用者補 scheme——貼了 `example.com/a.png` 就是拒收並要求補上
 *   完整網址。這是單一、可預期的行為，不做任何猜測。
 * - {@link isSafeMediaUrl}：**渲染端**。這裡必須放行相對網址：本專案自己上傳的圖片
 *   拿到的就是 `/api/uploads/<id>`（見 `uploads/upload-file.ts`），對它套輸入端那條
 *   規則會把所有上傳的圖片一起擋掉。相對網址解析後必然落在自家 origin（http(s)），
 *   安全性不受影響。
 *
 * 為什麼渲染端也要驗（issue #12）：白名單原本只存在於 UI 路徑，而筆記內容是 Yjs
 * 文件——**任何有 editor 權限的協作者都能直接寫 block props**，完全繞過 UI。別人開
 * 這篇筆記時，那個 URL 會被渲染端直接吃下去。
 */

/** 被判定為不安全時，交給渲染端的替代 URL。 */
export const BLOCKED_MEDIA_URL = "about:blank";

/** 這個字串解析出來的 scheme 是不是 `http:`／`https:`。`base` 為 undefined 時等同「必須是絕對網址」。 */
function resolvesToHttp(raw: string, base?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    // `new URL` 對「沒帶 scheme 的絕對網址」（`example.com/a.png`）也會 throw——它不會
    // 替你猜一個 scheme。一律視為不合法。
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * 輸入端白名單（spec §13.2/§13.5 安全 backlog ④）：`javascript:`、`data:`、`file:`…
 * 一律拒收，沒帶 scheme 的也拒收（**刻意不自動補**）。
 */
export function isAllowedEmbedUrl(raw: string): boolean {
  return resolvesToHttp(raw);
}

/**
 * 渲染端守衛。空字串是 BlockNote 對「這個 block 還沒有檔案」的表示法（它會走自己的
 * placeholder 路徑），不是攻擊面，直接放行。
 */
export function isSafeMediaUrl(raw: string, base: string = window.location.href): boolean {
  if (raw === "") return true;
  return resolvesToHttp(raw, base);
}

/**
 * 渲染前的最後一道關卡：不安全的 URL 換成 {@link BLOCKED_MEDIA_URL}。
 *
 * 為什麼是 `about:blank` 而不是空字串：`img.src = ""` 在瀏覽器裡會被解析成**目前這一頁
 * 的網址**並真的再抓一次，反而多打一個請求；`about:blank` 是惰性的。
 */
export function safeMediaUrl(raw: string, base: string = window.location.href): string {
  return isSafeMediaUrl(raw, base) ? raw : BLOCKED_MEDIA_URL;
}
