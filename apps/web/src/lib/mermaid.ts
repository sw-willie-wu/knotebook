/**
 * mermaid（issue #94）的載入與渲染薄層。**唯一** import `mermaid` 的地方。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 為什麼是動態 import
 * ──────────────────────────────────────────────────────────────────────────
 * mermaid 11 連同它的相依（含 dagre-d3、cytoscape、langium、dompurify…）是這個 app 裡
 * 最大的單一相依。靜態 import 會把它整包壓進 `NotePage` 的 lazy chunk，讓每個開筆記的人
 * 都付這個代價，即使整份筆記一張圖都沒有。因此**只在真的要畫圖時才 `import("mermaid")`**，
 * 由 Vite 自動切出獨立 chunk。
 *
 * ⚠ `scripts/check-bundle-size.mjs` 有一條對應的守門：mermaid chunk 必須存在、且不得被
 * inline 回 entry 或 NotePage chunk。哪天有人在別處靜態 import 了 mermaid，那條會紅。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 為什麼不在這一層做 DOM
 * ──────────────────────────────────────────────────────────────────────────
 * `mermaid.render()` 回傳 SVG **字串**，呼叫端自己決定怎麼塞。這一層保持純粹
 * （輸入原始碼＋主題，輸出字串或錯誤），是它能在 jsdom 裡被測到的唯一原因——
 * mermaid 本體在 jsdom 跑不起來（`render()` 會往 `document.body` 插隱藏 div 做文字量測，
 * 而 jsdom 沒有 layout、沒有 `getBBox`），所以單元測試把整個模組 mock 掉、只驗本檔的行為，
 * 真正的渲染由 e2e 覆蓋。
 */

/** `renderMermaid` 的結果。錯誤**不外拋**——語法錯是使用者日常會遇到的狀態，不是例外。 */
export type MermaidRenderResult = { ok: true; svg: string } | { ok: false; message: string };

export type MermaidTheme = "light" | "dark";

/**
 * mermaid 需要一個 id 來當 DOM 元素 id 與 SVG 內部 id 的前綴。
 *
 * ⚠ **刻意不用 `crypto.randomUUID`**：本專案的正當拓撲包含 LAN plain-http
 * （非 secure context，例如 `http://192.168.3.22:8006`），那裡 `crypto.randomUUID`
 * **不存在**，呼叫會直接 TypeError；而 jsdom／Node 有 polyfill，所以單元測試抓不到。
 * `ui/toast.tsx` 已經為同一個原因改用模組層級遞增計數器，這裡沿用同一手法。
 * id 只需要在單一 document 內唯一，無安全需求。
 *
 * 前綴刻意以字母開頭：mermaid 會拿它組 CSS 選擇器，數字開頭是無效選擇器。
 */
let idSeq = 0;
export function nextMermaidId(): string {
  idSeq += 1;
  return `mermaid-${idSeq}`;
}

/** 已經以哪個主題 initialize 過。`null` ＝ 還沒初始化。 */
let initializedTheme: MermaidTheme | null = null;

/** 測試用：把模組層級的初始化狀態歸零（模組層級狀態在測試之間會殘留）。 */
export function resetMermaidForTests(): void {
  initializedTheme = null;
}

/**
 * ⚠ **directive 鎖定清單**。mermaid 允許圖裡用 `%%{init: {...}}%%` 覆寫設定，
 * `secure` 列出的鍵**不可被覆寫**。內建清單是
 * `["secure","securityLevel","startOnLoad","maxTextSize","suppressErrorRendering","maxEdges"]`
 * ——`themeCSS`／`htmlLabels`／`fontFamily` 都不在裡面，於是圖的作者可以自己打開。
 *
 * 鎖它們的目的是**縮小 HTML／CSS 注入面**（讓標籤維持 SVG `<text>`、不讓圖注入任意
 * CSS），不是承諾「圖表不會載入外部資源」——見 `mermaidConfig` 的說明。
 */
const LOCKED_CONFIG_KEYS = [
  // mermaid 內建的六個
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  // 我們補的
  "themeCSS", // 任意 CSS → 渲染當下就會發出網路請求
  "htmlLabels", // 打開就能用 <img srcset>／<foreignObject> 裡的 HTML 拉外部資源
  // ⚠ `fontFamily` 家族看起來人畜無害，其實是**第二條 CSS 注入**：`addDirective` 在
  // `sanitizeDirective()`（管字元集的那支）**跑完之後**才把 `directive.fontFamily` 複製
  // 進 `themeVariables.fontFamily`，於是那個副本繞過了 `themeVariables.*` 的字元集檢查；
  // 值接著直接進 `:root{--mermaid-font-family:…}` 與 `font-family:…`。真瀏覽器實測：
  // `%%{init:{"fontFamily":"monospace; background-image: url(http://…)"}}%%` 會發出請求。
  "fontFamily",
  "altFontFamily",
  // ⚠ **不要**連 `themeVariables` 一起鎖（第 5 輪審查實測）。上面說的複製發生在
  // `sanitizeDirective()` 之後，但**在 `updateCurrentConfig()` 裡那支吃 `secure` 清單的
  // `sanitize()` 之前**——兩句話講的是兩個不同函式，不衝突。因為後者會遞迴進物件，
  // 光鎖 `fontFamily` 就已經把 `themeVariables.fontFamily` 那個副本刪掉了；`themeVariables` 其餘的值另有 mermaid
  // 自己的字元集檢查（`^[\d "#%(),.;A-Za-z]+$`，沒有 `:` 與 `/`，構不出 scheme）。
  // 鎖住只會讓官方文件教的 `%%{init:{"theme":"base","themeVariables":{…}}}%%` 靜默失效。
  // ⚠ 不要把整個 `flowchart` 鎖起來：mermaid 的 `sanitize()` 會**遞迴進物件**用同一份
  // 清單，巢狀的 `flowchart.htmlLabels` 已經被上面的 `htmlLabels` 涵蓋（第 4 輪實測）。
  // 鎖整個物件只會讓 `flowchart.curve`／`nodeSpacing` 這類**合法**的 directive 被靜默忽略。
] as const;

/**
 * 安全設定。**這裡擋的是「圖表讓瀏覽器執行程式碼」，不是「圖表載入外部資源」**——
 * 後者跟筆記裡用網址嵌入的圖片是同一個等級的能力（`lib/media-url.ts` 的政策就是
 * 放行 http(s)），只擋 mermaid 沒有意義。要對整個 app 關掉那一類，是 #101（CSP）的事。
 *
 * - `securityLevel: "strict"` —— mermaid 內建的 DOMPurify 淨化。11.17 在
 *   `securityLevel !== "loose"` 時會把整份輸出 SVG 再過一次，`<script>`／`onload=`／
 *   `javascript:` 都會被剝掉。這是擋「執行」的主防線。
 * - `secure: LOCKED_CONFIG_KEYS` ＋ `htmlLabels: false` —— 標籤用 SVG `<text>` 而不是
 *   `<foreignObject>` 包 HTML，**縮小注入面**（不是承諾）。鎖定讓圖裡的 `%%{init}%%`
 *   覆寫不掉這個選擇。⚠ 仍有已知缺口：label 含 `$$` 時 mermaid 會自己把 htmlLabels
 *   打開來畫 KaTeX（`if (hasKatex(textContent)) useHtmlLabels = true;`），那條路 directive
 *   鎖不到——擋執行的仍是上面那層 DOMPurify。
 *
 * 另外呼叫端**不得**呼叫 `render()` 回傳的 `bindFunctions`：那支是把圖裡宣告的
 * `click X callback` 綁成真的 DOM handler 用的，不呼叫就等於這個能力不存在。
 *
 * ⚠ **這裡曾經有一整套「不讓圖表發出任何跨源請求」的機制**（攔 `new Image()`／
 * `setAttribute`／`insertBefore`、輸出端清洗、render 序列化與逾時），八輪審查、六種
 * 繞法之後拆掉了。拆掉的理由不是「擋不完」，是**這個 app 本來就允許筆記嵌入任意
 * 遠端圖片**——同一個能力用圖片 block 三秒就做得到，只對 mermaid 立更嚴的規矩既擋不到
 * 攻擊者，還讓 `click X href` 的圖畫不出來、合法的多行 label 被誤擋。要加回來之前，
 * 先確認產品政策真的改了（而且改在 app 層，不是 block 層）。
 */
function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    secure: [...LOCKED_CONFIG_KEYS],
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    htmlLabels: false, // mermaid 11 的新位置
    flowchart: { htmlLabels: false }, // 舊位置，保留相容
  };
}

/**
 * 把 mermaid 原始碼畫成 SVG 字串。
 *
 * @param code  mermaid 原始碼。空白／純空白直接回 `ok:false`，不載入 mermaid——
 *              新建的空 block 是常態，不該為它拉進一整包相依。
 * @param theme `resolvedTheme`（`"light" | "dark"`）。換主題會重新 initialize。
 */
export async function renderMermaid(code: string, theme: MermaidTheme): Promise<MermaidRenderResult> {
  if (code.trim().length === 0) {
    return { ok: false, message: "" }; // 空 block：呼叫端顯示提示而非錯誤
  }

  try {
    const { default: mermaid } = await import("mermaid");

    // 同一主題只 initialize 一次；換主題才重來（initialize 是全域設定，重複呼叫無害但沒必要）。
    if (initializedTheme !== theme) {
      mermaid.initialize(mermaidConfig(theme));
      initializedTheme = theme;
    }

    // ⚠ **必須先 parse 再 render，順序不可調換。**
    // `render()` 在語法錯誤時會把一張「Syntax error in text」的炸彈圖**直接注入
    // `document.body`**（它會在 body 插一個暫時容器做文字量測，拋錯路徑不清理），
    // 那張圖因此逃出元件邊界、掛在整個頁面底部，重繪一次就多一張。
    // `parse()` 是純語法驗證、**完全不碰 DOM**，無效時 throw 並帶訊息——先過這一關，
    // 錯誤就由我們自己的錯誤態呈現（訊息 ＋ 可編輯的原始碼），不讓 mermaid 自己畫。
    //
    // 這個 bug 單元測試抓不到（mermaid 在測試中被 mock 掉，副作用不會發生），
    // 是 2026-08-27 用瀏覽器實際看畫面才發現的。改動這段前請以 headed 瀏覽器複驗。
    await mermaid.parse(code);

    // 回傳值裡的 `bindFunctions` 刻意不解構、不呼叫——見 `mermaidConfig` 的說明。
    const { svg } = await mermaid.render(nextMermaidId(), code);
    return { ok: true, svg };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
