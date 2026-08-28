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
 * ⚠ **directive 鎖定清單**（第 3 輪審查 I-A／I-B）。mermaid 允許圖裡用
 * `%%{init: {...}}%%` 覆寫設定，`secure` 列出的鍵**不可被覆寫**。內建清單是
 * `["secure","securityLevel","startOnLoad","maxTextSize","suppressErrorRendering","maxEdges"]`
 * ——`themeCSS`／`htmlLabels`／`flowchart` 都不在裡面，於是圖的作者可以自己打開。
 *
 * 為什麼一定要鎖在**輸入端**：`mermaid.render()` 會把圖（含 `<style>`）插進**活的
 * document** 做文字量測，瀏覽器當場套用 CSS 並發出請求——等我們拿到 SVG 字串再清洗，
 * IP／User-Agent／開啟時間**早就送出去了**（審查者用 Playwright 實測：即使渲染後完全
 * 不把 SVG 插進頁面，themeCSS 裡的 `url(https://…)` 照樣命中）。輸出端清洗擋不了這條，
 * 只有不讓 mermaid 收下這個 directive 才擋得住。
 */
const LOCKED_CONFIG_KEYS = [
  // mermaid 內建的六個
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  // 我們補的三個
  "themeCSS", // 任意 CSS → 渲染當下就會發出網路請求
  "htmlLabels", // 打開就能用 <img srcset>／<foreignObject> 裡的 HTML 拉外部資源
  "flowchart", // htmlLabels 的舊位置也在這裡面
] as const;

/**
 * 安全設定。**四層，缺一不可**：
 * - `securityLevel: "strict"` —— mermaid 內建的 DOMPurify 淨化（`dompurify` 確實在相依樹裡）。
 *   mermaid 11.17 在 `securityLevel !== "loose"` 時會把整份輸出 SVG 再過一次，`<script>`／
 *   `onload=`／`javascript:` 都會被剝掉。**但它只擋「執行」，不擋「載入」。**
 * - `secure: LOCKED_CONFIG_KEYS` —— 見該常數說明。這是擋「載入」的**主**防線。
 * - `htmlLabels: false`（全域）＋ `flowchart.htmlLabels: false`（舊位置）—— 標籤用 SVG
 *   `<text>` 而不是 `<foreignObject>` 包 HTML。因為上一條把這兩個鍵鎖住了，圖裡的
 *   directive 現在真的覆寫不掉。
 * - `stripExternalResources()` —— 輸出端的縱深防禦，見該函式說明。
 *
 * 另外呼叫端**不得**呼叫 `render()` 回傳的 `bindFunctions`：那支是把圖裡宣告的
 * `click X callback` 綁成真的 DOM handler 用的，不呼叫就等於這個能力不存在。
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

// ── SVG 外部資源清洗（issue #94 審查 I-1／I-B～I-D）────────────────────────────
//
// 這一層是**縱深防禦**，主防線是上面的 `secure` 鎖定。留著的理由：mermaid 的 DOMPurify
// 只擋「執行」不擋「載入」，而我們無法逐版追蹤 mermaid 未來會不會多出新的「把 URL 寫進
// 輸出」的功能。
//
// ⚠ **用 HTML parser 解析，不是 XML parser。** 三輪審查踩到的坑都在這裡：
// 1. 真的 mermaid 輸出裡有 `xlink:href` **卻沒宣告 `xmlns:xlink`**，XML parser 對含
//    `click X href` 的圖必定 parsererror ⇒ 舊版永遠落到字串 fallback，`<a>` 連結被整條
//    拔掉、圖表文字裡的 `url(…)` 被改成 `none`（審查者用真輸出實測）。
// 2. 字串 fallback 用 regex 比對原文，`href="&#104;ttps://evil"` 這種 HTML entity 直接
//    繞過——而輸出是用 `dangerouslySetInnerHTML` 插進頁面的，entity 會被解碼。
// 3. `XMLSerializer` 會把 `<style>` 裡的 `>` 轉成 `&gt;`，但 `<style>` 是 HTML 的 raw text
//    element，不會還原 ⇒ 子代選擇器靜默失效。
// HTML parser 三件事都天然沒有：不會解析失敗、entity 在解析時就被解碼、序列化用
// `innerHTML` 與插入端（同樣是 HTML parser）對稱。

/** 會讓瀏覽器**自動**去抓東西的屬性（比對 `localName`，所以 `xlink:href` 也算）。 */
const LOADING_ATTRIBUTES = new Set(["href", "src", "srcset", "poster", "background", "data"]);

/** ASCII 空白與控制字元。URL parser 會把它們丟掉，我們判斷前必須做同一件事。 */
const URL_IGNORED_CHARS = /[\u0000-\u0020]/g;

/** 允許的資源目標：本頁片段（`url(#arrowhead)`）、`data:`、同源。其餘一律視為外連。 */
function isSafeResourceUrl(raw: string): boolean {
  // 不先去掉控制字元的話，`ht<TAB>tps://evil` 會從「看起來不像網址」的縫溜過去，
  // 瀏覽器卻照樣連得出去。反斜線在 WHATWG URL 規則裡等同 `/`，一律視為可疑
  // ——`\68ttps://…` 這種「我們解一次、瀏覽器再解一次」的 double-escape 形靠這條收斂。
  const cleaned = raw.replace(URL_IGNORED_CHARS, "");
  if (cleaned.length === 0) return true;
  if (cleaned.includes("\\")) return false;
  if (cleaned.startsWith("#")) return true;
  if (/^data:/i.test(cleaned)) return true;
  try {
    return new URL(cleaned, window.location.href).origin === window.location.origin;
  } catch {
    return false; // 解析不出來就當作不安全（fail closed）
  }
}

/** 使用者**主動點擊**才會連出去的連結（mermaid 的 `click X href "…"`）允許的 scheme。 */
function isSafeLinkUrl(raw: string): boolean {
  const cleaned = raw.replace(URL_IGNORED_CHARS, "");
  // `data:` 刻意**不**放行：資源用的 `data:` 不連外所以安全，但 `<a href="data:text/html,…">`
  // 是導航目標，現代瀏覽器雖然擋 top-level data: 導航，沒有理由自己留著這條（審查 M-7）。
  if (/^data:/i.test(cleaned)) return false;
  return isSafeResourceUrl(cleaned) || /^(?:https?|mailto):/i.test(cleaned);
}

/** `srcset` 是候選清單（`a.png 1x, b.png 2x`）：任何一個候選不安全就整條拿掉。 */
function isSafeSrcset(raw: string): boolean {
  return raw
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .every((url) => url.length === 0 || isSafeResourceUrl(url));
}

/** 會自動抓資源的 CSS 函式名。 */
const CSS_RESOURCE_FN = /(?:^|[^\w-])(url|image-set|-webkit-image-set|cross-fade|element)\(/gi;
/** CSS escape（`\68` → `h`）與註解——**只用於判斷**，不寫回去（寫回去等於幫瀏覽器多解一層）。 */
const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6})[ \t\n]?/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
/** `@import`（也可能被寫成 escape 過的 `\40 import`）。 */
const CSS_IMPORT = /(?:@|\\0{0,4}40[ \t]?)import[^;}]*;?/gi;

/** 從 `open`（`(` 的位置）開始找配對的 `)`，跳過引號內容。找不到回傳 -1。 */
function findClosingParen(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < css.length; index++) {
    const char = css[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 判斷用的正規化：拆註解、解 escape。**結果不寫回**，只拿來看目標安不安全。 */
function normalizeForJudgement(text: string): string {
  return text.replace(CSS_COMMENT, "").replace(CSS_ESCAPE, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * CSS 裡的外連參照換成 `none`。`url(#id)`（mermaid 的 marker／mask 命脈）與 `data:` 保留。
 *
 * ⚠ 只改真的有問題的那一段，**其餘字元原樣保留**：舊版把整份 CSS 解 escape 後寫回，
 * `content:"\22 hi"` 這種正常 CSS 會被改壞（第 3 輪審查 M-3）。
 */
function scrubCss(css: string): string {
  let result = css.replace(CSS_IMPORT, "");
  const replacements: { start: number; end: number }[] = [];
  CSS_RESOURCE_FN.lastIndex = 0;
  for (let match = CSS_RESOURCE_FN.exec(result); match !== null; match = CSS_RESOURCE_FN.exec(result)) {
    const open = result.indexOf("(", match.index);
    const close = findClosingParen(result, open);
    if (close === -1) break;
    // 括號內**每一個**候選目標都要安全才留：`image-set("ok.png" 1x, "https://evil/x.png" 2x)`
    // 只看第一個就會被繞過。解析度單位（`1x`、`2dppx`）與型別提示不是資源，跳過。
    const targets = normalizeForJudgement(result.slice(open + 1, close)).match(/"[^"]*"|'[^']*'|[^\s,()]+/g) ?? [];
    const unsafe = targets.some((token) => {
      const target = token.replace(/^["']|["']$/g, "");
      if (/^[\d.]+(?:x|dppx|dpi)$/i.test(target)) return false;
      if (/^(?:type|format)$/i.test(target)) return false;
      return !isSafeResourceUrl(target);
    });
    if (unsafe) replacements.push({ start: result.indexOf(match[1]!, match.index), end: close + 1 });
    CSS_RESOURCE_FN.lastIndex = close;
  }
  for (const { start, end } of replacements.reverse()) {
    result = `${result.slice(0, start)}none${result.slice(end)}`;
  }
  return result;
}

/**
 * 移除 SVG 裡指向外部主機的資源參照（輸出端的縱深防禦，主防線是 `secure` 鎖定）。
 *
 * - 自動載入的屬性（`href`／`src`／`srcset`／`poster`／`background`／`data`）：只留同源、
 *   `#片段`、`data:`。
 * - `<a href>`：**保留** http(s)/mailto——那是使用者主動點才連得出去的連結（mermaid 的
 *   `click X href "…"`），拔掉等於靜默弄壞圖表功能；改為補上 `rel="noopener noreferrer"`。
 * - `<style>` 與 `style=` 裡的資源函式：外連的換成 `none`，其餘字元原樣不動。
 */
export function stripExternalResources(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  let changed = false;

  for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
    const isLink = element.localName === "a";
    for (const attribute of Array.from(element.attributes)) {
      if (!LOADING_ATTRIBUTES.has(attribute.localName)) continue;
      const value = attribute.value;
      const allowed =
        attribute.localName === "srcset"
          ? isSafeSrcset(value)
          : isLink && attribute.localName === "href"
            ? isSafeLinkUrl(value)
            : isSafeResourceUrl(value);
      if (!allowed) {
        element.removeAttributeNode(attribute);
        changed = true;
      } else if (isLink && !isSafeResourceUrl(value) && element.getAttribute("rel") !== "noopener noreferrer") {
        element.setAttribute("rel", "noopener noreferrer");
        changed = true;
      }
    }

    const inlineStyle = element.getAttribute("style");
    if (inlineStyle !== null) {
      const scrubbed = scrubCss(inlineStyle);
      if (scrubbed !== inlineStyle) {
        element.setAttribute("style", scrubbed);
        changed = true;
      }
    }

    if (element.localName === "style") {
      const css = element.textContent ?? "";
      const scrubbed = scrubCss(css);
      if (scrubbed !== css) {
        element.textContent = scrubbed;
        changed = true;
      }
    }
  }

  // 沒東西要拔就原樣回傳：沒必要重新序列化 mermaid 的輸出。
  return changed ? parsed.body.innerHTML : svg;
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
