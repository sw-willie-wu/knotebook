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
 * 安全設定。**三層都是必要的，不是保險**：
 * - `securityLevel: "strict"` —— mermaid 內建的 dompurify 淨化路徑（`dompurify` 確實在相依樹裡，
 *   不是設定檔上的空話）。mermaid 11.17 在 `securityLevel !== "loose"` 時會把**整份輸出 SVG**
 *   再過一次 DOMPurify，`<script>`／`onload=`／`javascript:` 都會被剝掉。
 * - `htmlLabels: false`（全域鍵）＋ `flowchart.htmlLabels: false`（舊版位置，相容用）——
 *   標籤改用 SVG `<text>` 而不是 `<foreignObject>` 包 HTML，**降低**攻擊面。
 *   ⚠ 不是密不透風：mermaid 11.17 的 `secure` 清單（`["secure","securityLevel","startOnLoad",
 *   "maxTextSize","suppressErrorRendering","maxEdges"]`）**不含 `htmlLabels`**，所以圖裡的
 *   `%%{init:{"htmlLabels":true}}%%` 可以把它打開；那時的防線是上面那層 DOMPurify。
 * - `stripExternalResources()` —— DOMPurify **不擋外部資源載入**，理由見該函式說明。
 *
 * 另外呼叫端**不得**呼叫 `render()` 回傳的 `bindFunctions`：那支是用來把圖裡宣告的
 * `click X callback` 綁成真的 DOM handler 的，不呼叫就等於這個能力不存在。
 */
function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    htmlLabels: false, // mermaid 11 的新位置
    flowchart: { htmlLabels: false }, // 舊位置，保留相容
  };
}

/** 會發出網路請求的 URL：`https:`／`http:`／protocol-relative `//host`。 */
const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
/** CSS 裡的遠端 `url(…)`。**不含** `url(#id)` 與 `url(data:…)`——mermaid 的箭頭 marker／mask 全靠前者。 */
const REMOTE_CSS_URL = /url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi;
const CSS_IMPORT = /@import[^;]*;?/gi;
/** 字串層的最後手段（見下方 fail-closed 說明）：帶遠端網址的屬性整條拔掉。 */
const REMOTE_URL_ATTRIBUTE = /\s(?:[\w-]+:)?(?:href|src)\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']*\1/gi;
/** CSS（`<style>` 內容或 `style=` 屬性）裡的遠端參照清掉。`url(#id)`／`url(data:…)` 保留。 */
function scrubRemoteUrlsInCss(css: string): string {
  return css.replace(CSS_IMPORT, "").replace(REMOTE_CSS_URL, "none");
}

/**
 * 移除 SVG 裡指向**外部主機**的資源參照。
 *
 * ⚠ mermaid 的 DOMPurify 只擋「執行」，**不擋「載入」**。實測有兩條可達的外連路徑：
 * 1. flowchart 的 image shape（`A@{ shape: image, img: "https://…" }`）產出
 *    `<image href="https://…">`，URL 完全未經 mermaid 的 `sanitizeUrl`；
 * 2. `%%{init:{"themeCSS":"* { background: url(https://…) }"}}%%` 會被原樣寫進 SVG 內的
 *    `<style>`——`sanitizeCss()` 只檢查大括號配對，`url(…)` 一律放行。
 *
 * 兩者都會讓**每一位開這篇筆記的人**的瀏覽器對圖表作者指定的主機發請求（IP、User-Agent、
 * 開啟時間外洩），而筆記是可共編的——寫圖的人不必是讀圖的人。這正是 #43 對檔案類 block 套
 * `withGuardedExternalHTML` 的同一種風險，只是從渲染端進來。
 *
 * **fail closed**：SVG 解析不出來時不原樣放行，退回字串層清洗（比對屬性與 CSS）。
 */
export function stripExternalResources(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  let out = svg;

  if (parsed.getElementsByTagName("parsererror").length === 0) {
    let changed = false;
    for (const element of Array.from(parsed.querySelectorAll("*"))) {
      // 逐個屬性看 `localName`，不是比對完整名稱：`xlink:href` 用什麼前綴宣告都算數。
      for (const attribute of Array.from(element.attributes)) {
        const isUrlAttribute = attribute.localName === "href" || attribute.localName === "src";
        if (isUrlAttribute && REMOTE_URL.test(attribute.value)) {
          element.removeAttributeNode(attribute);
          changed = true;
        }
      }
      const inlineStyle = element.getAttribute("style");
      if (inlineStyle !== null && scrubRemoteUrlsInCss(inlineStyle) !== inlineStyle) {
        element.setAttribute("style", scrubRemoteUrlsInCss(inlineStyle));
        changed = true;
      }
      if (element.tagName.toLowerCase() === "style") {
        const css = element.textContent ?? "";
        if (scrubRemoteUrlsInCss(css) !== css) {
          element.textContent = scrubRemoteUrlsInCss(css);
          changed = true;
        }
      }
    }
    // 沒東西要拔就原樣回傳：重新序列化會改寫引號/自閉合標籤，沒必要動 mermaid 的輸出。
    if (changed) out = new XMLSerializer().serializeToString(parsed);
  }

  // 字串層再掃一次。**解析失敗時這是唯一一道**（fail closed，不原樣放行）；
  // 解析成功時它是 no-op（沒有匹配的 replace 回傳同一個字串）。
  return scrubRemoteUrlsInCss(out).replace(REMOTE_URL_ATTRIBUTE, "");
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
    // DOMPurify 擋不住外部資源載入——見 `stripExternalResources` 的說明。
    return { ok: true, svg: stripExternalResources(svg) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
