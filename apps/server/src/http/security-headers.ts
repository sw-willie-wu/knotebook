import { createHash } from "node:crypto";

/**
 * SPA 文件回應的安全標頭（issue #101）。
 *
 * ⚠ **hash 一律從「當下要送出的那份 HTML」推導**，不是啟動時算一次、更不是寫死常數：
 * `index.html` 有一段**同步的** inline script（深色／主題色首屏防閃，見 web 端的
 * `index.html` 註解與 `theme.test.tsx`），被 CSP 擋掉的症狀是**每次開頁閃白**——那是
 * 沒有任何測試會紅的失效形。從送出的內容推導，drift 在結構上就不可能發生。
 */

/** `<script>` 開標籤沒有 `src=` 的那些（＝內文會被瀏覽器執行的 inline script）。 */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * ⚠ **換行要先正規化成 LF 再算 hash**。HTML 解析規範要求把輸入串流裡的 CR 與 CRLF
 * 一律轉成 LF **之後**才進 tokenizer，所以 script 元素的 textContent（＝瀏覽器拿去算
 * hash 的東西）永遠只有 LF；對原始位元組算就會與瀏覽器對不上。
 *
 * 這不是理論問題：Windows checkout 的 `index.html` 帶 CRLF，第一版對原始字串算，e2e
 * 首跑就抓到 `script-src-elem` violation（blockedURI `inline`、sourceFile 是 index.html
 * 本身）——症狀是首屏防閃 script 每次都被擋＝**深色模式每次開頁閃白**，而 server 端
 * 所有測試都會是綠的。
 */
function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)].map((match) => {
    const source = match[1]!.replace(/\r\n?/g, "\n");
    return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
  });
}

/**
 * 政策的**放寬**那半是 issue #101 的定案，不是疏漏——收緊會讓已出貨的功能靜默變破圖：
 *
 * - `img-src`：外部圖片以 URL 內嵌是支援行為（圖片 block 的 Embed 分頁、從網頁直接拖圖），
 *   mermaid 的 `A@{ img: … }` 同理——#94 的安全政策定案就是「與筆記內容對齊」，當時為此
 *   移除整套「不得外連」機制。CSP 分不出「使用者自己貼的圖」與「被注入的
 *   `themeCSS: url(…)`」，所以這是政策選擇而不是技術調參。
 * - `media-src`：audio／video block **只有** embed-by-URL（沒有上傳路徑，見
 *   `docs/known-limitations.md`），收緊等於那些 block 全滅。
 *
 * 對照：HackMD／CodiMD 自架版的預設是 `img-src *`、`connect-src *`、`object-src *`、
 * `script-src` 還帶 `'unsafe-eval'`——本檔比它嚴得多。要同時拿到「功能」與「緊的
 * img-src」只有 Notion 那條路（自架圖片代理），已裁示不做。
 */
const STATIC_DIRECTIVES: readonly (readonly [string, string])[] = [
  ["default-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob: https:"],
  ["media-src", "'self' https:"],
  ["font-src", "'self' data:"],
  // 共編 WebSocket 是同源（`collabUrl()` 由 window.location 推導成 ws(s)://<same host>/collab），
  // `'self'` 涵蓋得到；AI provider 由 server 端轉發，瀏覽器不直連。
  ["connect-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["frame-ancestors", "'none'"],
  // SSO 是純 `<a href="/api/auth/oidc/login">` 全頁跳轉（不是表單送出），不受此限。
  ["form-action", "'self'"],
];

/** 回傳要掛在 HTML 回應上的標頭（key 一律小寫）。 */
export function securityHeaders(html: string): Record<string, string> {
  const directives = [
    `script-src ${["'self'", ...inlineScriptHashes(html)].join(" ")}`,
    ...STATIC_DIRECTIVES.map(([name, value]) => `${name} ${value}`),
  ];
  return {
    "content-security-policy": directives.join("; "),
    "x-content-type-options": "nosniff",
    // 外部圖片仍載入，但外部主機不再看到「讀者正在看哪一篇筆記」的網址
    // （`docs/known-limitations.md` 的 hotlink 條目提到的洩漏面，這條收掉其中的 referrer）。
    "referrer-policy": "no-referrer",
  };
}
