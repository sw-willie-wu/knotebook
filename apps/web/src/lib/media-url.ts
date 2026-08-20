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
 *   規則會把所有上傳的圖片一起擋掉。相對網址解析後 scheme 必然是 http(s)，這就是這道
 *   守衛要的全部——**它不保證同源**：protocol-relative 的 `//evil.com/x.png` 也是「相對
 *   網址」，會解析成別人的 origin 並通過。這不是破口：外部 `https://…` 圖片本來就放行
 *   （hotlink 已列在 `docs/known-limitations.md`），同源從來不是這裡的目標。別把這句話
 *   當成「只會打自家 origin」的前提去放寬別的東西（CSP、credentials…）。
 *
 * **範圍（誠實揭露）**：`resolveFileUrl` 只掛在 BlockNote 的 `render` 上。`toExternalHTML`
 * （複製到剪貼簿的 `text/html`、`blocksToMarkdownLossy` 的 markdown 匯出）拿的是 raw
 * `props.url`，**不經過這道守衛**——那條路是「把內容帶出這個應用程式」，落到對方的
 * sanitizer 手上，危害等級低一階，要修得覆寫四個 block spec 的 `toExternalHTML`（另開
 * issue 追）。這裡守的是**所有進到本應用程式 DOM／導航的 sink**。
 *
 * ⚠ **失效模式**：這道守衛依賴 `@blocknote/core` 的 render 會呼叫 `resolveFileUrl`，而那是
 * 一個條件分支（`editor.resolveFileUrl ? … : el.src = url`，已對 0.52.1 的 dist 核實）。
 * 升級 BlockNote 時要回頭確認這個關係還在——`NoteEditor.test.ts` 有一條測試直接拿
 * `defaultBlockSpecs.image` 跑真正的 render 來釘住它，那條紅了就是這件事發生了。
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
 * 為什麼是 `about:blank` 而不是空字串：`@blocknote/react` 的 `useResolveUrl` 在解析結果是
 * falsy 時會 `throw Error("Finished fetching file but did not get download URL.")`——回傳
 * 空字串會在 React 版檔案 block 上直接炸掉 render。`about:blank` 則是惰性的：`<img>`／
 * `<video>`／`<audio>` 拿到它只會顯示失敗，不導航也不執行。`data:,` 同樣不考慮——我們
 * 剛把 `data:` 判成不安全，再拿一個 `data:` 當替代值只會自相矛盾。
 */
export function safeMediaUrl(raw: string, base: string = window.location.href): string {
  return isSafeMediaUrl(raw, base) ? raw : BLOCKED_MEDIA_URL;
}
