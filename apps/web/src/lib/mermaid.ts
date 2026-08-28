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
/**
 * `@import` 整條宣告。`@` 與 **at-rule 名字本身**都可能被 escape
 * （`\40 import`、`@\69 mport`，兩形第 4 輪審查都實測會連出去），所以位移在
 * **normalize 過的副本**上找，再回頭刪原字串的同一段。
 */
const CSS_IMPORT = /@import[^;}]*;?/gi;

/** 在 normalize 副本上找 `@import` 的位移，回頭刪原字串。 */
function removeCssImports(css: string): string {
  const normalized = normalizeForJudgement(css);
  if (normalized === css) return css.replace(CSS_IMPORT, "");
  // 有 escape／註解時兩份字串長度不同，位移對不起來——這種 CSS 不是 mermaid 會產出的
  // 形狀（它的 `<style>` 從不含 escape），一律整段清掉比留著猜安全。
  // ⚠ `CSS_IMPORT` 帶 `g`，`test()` 命中後會**保留** `lastIndex`（`replace()` 才會歸零），
  // 下一次呼叫就會從殘留位移開始掃 → 短字串直接掃不到 → 原樣放行。第 5 輪審查實測到這個
  // 順序相依的 fail-open（同一頁連續呼叫兩次，第二次原封不動）。
  CSS_IMPORT.lastIndex = 0;
  return CSS_IMPORT.test(normalized) ? "" : css;
}

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
  let result = removeCssImports(css);
  const replacements: { start: number; end: number }[] = [];
  CSS_RESOURCE_FN.lastIndex = 0;
  for (let match = CSS_RESOURCE_FN.exec(result); match !== null; match = CSS_RESOURCE_FN.exec(result)) {
    // `(` 就是整個 match 的最後一個字元。用 `indexOf` 找，會在「資源函式前面剛好是 `(`」時
    // 抓到外層那個括號（`background:(url(https://…))` → 吃掉外層 `)`，括號不平衡）。
    const open = match.index + match[0].length - 1;
    const functionStart = open - match[1]!.length;
    const close = findClosingParen(result, open);
    if (close === -1) {
      // 括號沒配對：CSS 規範下 url-token 遇到 EOF 仍然成立，瀏覽器**照樣會連出去**
      // （第 4 輪審查實測）。從這裡到結尾一律視為不安全，不能 fail-open。
      replacements.push({ start: functionStart, end: result.length });
      break;
    }
    // 括號內**每一個**候選目標都要安全才留：`image-set("ok.png" 1x, "https://evil/x.png" 2x)`
    // 只看第一個就會被繞過。解析度單位（`1x`、`2dppx`）與型別提示不是資源，跳過。
    const targets = normalizeForJudgement(result.slice(open + 1, close)).match(/"[^"]*"|'[^']*'|[^\s,()]+/g) ?? [];
    const unsafe = targets.some((token) => {
      const target = token.replace(/^["']|["']$/g, "");
      if (/^[\d.]+(?:x|dppx|dpi)$/i.test(target)) return false;
      if (/^(?:type|format)$/i.test(target)) return false;
      return !isSafeResourceUrl(target);
    });
    if (unsafe) replacements.push({ start: functionStart, end: close + 1 });
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

  // ⚠ 掃**整份文件**不是只掃 `body`：HTML parser 會把開頭的 `<style>`／`<link>` 提到
  // `<head>`，只掃 body 等於靜默 fail-open（第 4 輪審查實測）。mermaid 的輸出一定以
  // `<svg` 開頭所以目前不可達，但這支函式的契約不該依賴呼叫端的輸入形狀。
  for (const element of Array.from(parsed.querySelectorAll("*"))) {
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
  return changed ? parsed.head.innerHTML + parsed.body.innerHTML : svg;
}

/**
 * `renderMermaid` 用來表示「這張圖引用了外部圖片、我們拒絕畫」的訊息碼。
 * 呼叫端（`MermaidView`）看到它就換成使用者看得懂的說明——這一層沒有 i18n。
 */
export const BLOCKED_EXTERNAL_IMAGE = "blocked-external-image";

/** 1x1 透明 GIF。被擋下的 `src` 換成它：`decode()` 仍會成功，mermaid 不會因此拋錯。 */
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * 目前這一張圖的「被擋下的 URL」記錄簿；`null` ＝ 沒有 render 在進行、`Image` 是原版。
 *
 * ⚠ 只會有一個，因為 render 是**序列化**的（見 `enqueueRender`）。`new Image()` 沒有任何
 * 上下文可以告訴我們「這是哪一張圖要的」——若允許並發，一張乾淨的圖會被隔壁那張的外連
 * 記錄連累，變成無辜被擋。序列化把歸屬問題整個消掉，代價只是兩張圖依序畫（各幾十毫秒）。
 */
let activeImageRecorder: ((url: string) => void) | null = null;
let originalImageConstructor: typeof Image | null = null;
let originalSetAttribute: typeof Element.prototype.setAttribute | null = null;
let originalSetAttributeNS: typeof Element.prototype.setAttributeNS | null = null;
let originalInsertBefore: typeof Node.prototype.insertBefore | null = null;
let originalAppendChild: typeof Node.prototype.appendChild | null = null;

/**
 * mermaid 的 render 一次只跑一張。
 *
 * 除了上面的歸屬問題，mermaid 本身也是全域狀態（`initialize` 是全域設定、render 會往
 * `document.body` 插暫時容器做量測），並發本來就不是它設計的用法。前一張失敗不影響下一張。
 */
/**
 * 單張圖的 render 上限。⚠ 這不是效能調校，是**安全帶**：mermaid 的 `imageSquare` 會
 * `await img.decode()`，同源圖片（我們放行的那些）若永遠不回應，`finally` 就永遠不跑
 * ——全 app 的 `setAttribute` 會被我們的判斷永久接管，後面每一張圖也永遠排隊（第 7 輪
 * 審查真瀏覽器實測：兩張圖 6 秒後都還 pending、patch 沒還原）。伺服器重啟或斷線時
 * in-flight 的請求 hang 到瀏覽器逾時可達數分鐘，不需要有人刻意攻擊也會發生。
 */
const RENDER_TIMEOUT_MS = 20_000;
/** 逾時的訊息碼。同 `BLOCKED_EXTERNAL_IMAGE`，由呼叫端換成人看得懂的說明。 */
export const RENDER_TIMED_OUT = "render-timed-out";

let renderQueue: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  // 兩個 handler 都是 `task`：前一張成功或失敗都照樣輪到下一張。真正讓「前一張失敗不
  // 影響下一張」成立的是下面那兩個吞掉結果的 noop——`renderQueue` 因此永遠不會 reject。
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * ⚠ **這是擋「圖表自動抓外部資源」的機制層防線**，也是本檔唯一擋得住**未知形**的東西。
 *
 * mermaid 的 image 節點形狀（`A@{ img: "http://…" }`）在 `render()` **內部**就把圖抓下來：
 * `chunk-4HAMMTFA.mjs:2742-2744` 是逐字的 `const img = new Image(); img.src = node?.img ?? "";
 * await img.decode();`。這代表：
 * - 輸出端清洗（`stripExternalResources`）永遠來不及——請求在我們拿到 SVG 字串前就送出去了；
 * - `secure` 鎖定也管不到——那是**圖表語法**不是 config。
 *
 * 曾經走過的死路：在送進 mermaid 之前**解析原始碼**找 `img:`。三個版本、六輪審查，每一版
 * 都在重新實作 mermaid 的一部分（regex → quote-aware ＋ YAML 實解 → 還要補單引號、
 * `\n`→`<br/>`、`%%` 註解、label 狀態…），而且每一版都被找出新的繞法，最後一版還因為
 * 走訪 YAML 的循環 anchor 造成**分頁永久凍結**（第 6 輪審查真瀏覽器實證：那份原始碼一旦
 * 存進筆記，之後任何人開它都會凍住，連刪掉那個 block 都做不到）。
 *
 * 改成攔**實際要發出去的 URL**，不去理解圖表語法。mermaid 有四條路把資源送出去，
 * 每一條都在 render 期間發生、都必須攔：
 * 1. `new Image()` —— 量圖片尺寸用（`chunk-4HAMMTFA.mjs:2742-2744`）。
 * 2. SVG 元素的 `href`／`src` 屬性 —— 圖被插進活的 document 量測時，`<image href>`／
 *    `<use href>` 一進 DOM 瀏覽器就自己去抓。**第 6 輪只做 (1) 時 e2e 實測：訊息有出來、
 *    請求照樣送出去 4 個。**
 * 3. SVG 元素的 `style` 屬性 —— `stateDiagram-v2`／`block-beta` 的 `style X background-image:
 *    url(//host/x.png)` 會落在這裡（第 7 輪審查真瀏覽器實證，四形；`//host` 是關鍵，帶
 *    `http:` 會被 mermaid 的 `styles2Map` 以 `split(":")` 截掉）。
 * 4. 插進 SVG 的 `<style>` 元素 —— `classDef` 那形走這條：`mermaid.core.mjs:1330-1332` 是
 *    `document.createElement("style"); style1.innerHTML = rules; svg.insertBefore(style1, …)`，
 *    **完全不經過 `setAttribute`**。第 7 輪實測：只補 (3) 的話 classDef 那形照樣外洩。
 *
 * 非同源的目標一律換成透明像素／清成 `none`（不是丟錯——丟錯會讓 mermaid 整張圖失敗，
 * 錯誤訊息也對不上），並記錄下來讓 `renderMermaid` 回報訊息碼。
 *
 * 邊界（刻意接受）：
 * - `fetch`／`XMLHttpRequest`／`FontFace` 沒攔。mermaid 11.17.2 的圖表路徑不走它們，
 *   但這是「我們追得到的入口」而不是「所有入口」——結構性的那道是 #101（server 端 CSP），
 *   `img-src 'self' data:` 一條就把整類關掉。
 * - patch 期間全域的 `setAttribute`／`insertBefore` 都會經過判斷，但**只對 SVG 命名空間的
 *   元素生效**（app 其他地方是 HTML 命名空間，早退）；第 7 輪量過：120 節點的圖 render
 *   期間 8090 次 `setAttribute`、命中 0 次，額外成本佔整張 render 的 0.03%。
 * - render 逾時（`RENDER_TIMEOUT_MS`）是這一層的**安全帶**：一張圖的 render 若永遠不 settle
 *   （同源圖片 hang、伺服器重啟…），`finally` 就永遠不跑，全 app 的 `setAttribute` 會被我們
 *   的判斷永久接管、後面每一張圖也永遠排隊（第 7 輪實測）。
 */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** 會自動抓資源的屬性名（含 `xlink:href` 這種帶前綴的形）。 */
const RESOURCE_ATTRIBUTE = /(^|:)(href|src)$/i;

/**
 * 這個屬性值要不要改寫；回傳實際要寫進去的值。
 *
 * ⚠ SVG `<a href>` **放行且不記錄**：那是使用者主動點才會連出去的連結（mermaid 的
 * `click X href "…"`），不是資源。第 7 輪審查實測：把它一起擋掉會讓**整張圖畫不出來**，
 * 而且顯示的是「這張圖引用了外部圖片」——一張連 img 都沒有的圖，同時打臉 docs／CHANGELOG
 * 明文寫的「連結會保留」。`rel="noopener noreferrer"` 由 `stripExternalResources` 補。
 */
function guardAttributeValue(element: Element, name: string, value: string): string {
  if (typeof value !== "string" || element.namespaceURI !== SVG_NAMESPACE) return value;

  if (element.localName === "a" && RESOURCE_ATTRIBUTE.test(name)) return value;

  if (name.toLowerCase() === "style") {
    const scrubbed = scrubCss(value);
    if (scrubbed !== value) activeImageRecorder?.(value);
    return scrubbed;
  }

  if (!RESOURCE_ATTRIBUTE.test(name) || isSafeResourceUrl(value)) return value;
  activeImageRecorder?.(value);
  return TRANSPARENT_PIXEL;
}

/** 要插進 DOM 的 `<style>` 元素先洗一遍（`classDef` 產生的規則走這條，不經過 setAttribute）。 */
function guardInsertedNode<T extends Node>(node: T): T {
  if (!(node instanceof Element) || node.localName !== "style") return node;
  const css = node.textContent ?? "";
  const scrubbed = scrubCss(css);
  if (scrubbed !== css) {
    activeImageRecorder?.(css);
    node.textContent = scrubbed;
  }
  return node;
}

function beginImageGuard(record: (url: string) => void): () => void {
  // ⚠ 這支**不可重入**：`new Image()` 沒有上下文可以歸屬到哪一張圖，所以 render 是
  // 序列化的（`enqueueRender`）。真的巢狀進來要吵，不要留一個「看起來考慮過」的假象。
  if (activeImageRecorder !== null) {
    throw new Error("mermaid image guard is not re-entrant: renders are serialised");
  }
  activeImageRecorder = record;

  originalImageConstructor = globalThis.Image;
  const Original = originalImageConstructor;
  // ⚠ **不能用 `class extends Image`**：jsdom 的 `Image` 建構子是 `return
  // document.createElement("img")`，回傳物件會蓋掉 `this`，子類別的 accessor 因此
  // 完全不生效（真瀏覽器可以、jsdom 不行 ⇒ 單元測試根本測不到這一層）。改成包住
  // 建構子、在**實例**上定義 `src` 的 own accessor，兩邊行為一致。
  const prototypeSrc = Object.getOwnPropertyDescriptor(globalThis.HTMLImageElement.prototype, "src");
  const guarded = function GuardedImage(...args: ConstructorParameters<typeof Image>): HTMLImageElement {
    const image = new Original(...args);
    Object.defineProperty(image, "src", {
      configurable: true,
      enumerable: false,
      get: () => prototypeSrc?.get?.call(image) as string,
      set: (value: string) => {
        if (isSafeResourceUrl(value)) {
          prototypeSrc?.set?.call(image, value);
          return;
        }
        activeImageRecorder?.(value);
        prototypeSrc?.set?.call(image, TRANSPARENT_PIXEL);
      },
    });
    return image;
  };
  guarded.prototype = Original.prototype; // `instanceof HTMLImageElement` 仍然成立
  globalThis.Image = guarded as unknown as typeof Image;

  originalSetAttribute = Element.prototype.setAttribute;
  originalSetAttributeNS = Element.prototype.setAttributeNS;
  originalInsertBefore = Node.prototype.insertBefore;
  originalAppendChild = Node.prototype.appendChild;
  const setAttribute = originalSetAttribute;
  const setAttributeNS = originalSetAttributeNS;
  const insertBefore = originalInsertBefore;
  const appendChild = originalAppendChild;

  Element.prototype.setAttribute = function (name: string, value: string): void {
    setAttribute.call(this, name, guardAttributeValue(this, name, value));
  };
  Element.prototype.setAttributeNS = function (namespace: string | null, name: string, value: string): void {
    setAttributeNS.call(this, namespace, name, guardAttributeValue(this, name, value));
  };
  Node.prototype.insertBefore = function <T extends Node>(node: T, child: Node | null): T {
    return insertBefore.call(this, guardInsertedNode(node), child) as T;
  };
  Node.prototype.appendChild = function <T extends Node>(node: T): T {
    return appendChild.call(this, guardInsertedNode(node)) as T;
  };

  return () => {
    if (activeImageRecorder !== record) return; // 冪等：重複呼叫不做事
    activeImageRecorder = null;
    if (originalImageConstructor !== null) globalThis.Image = originalImageConstructor;
    if (originalSetAttribute !== null) Element.prototype.setAttribute = originalSetAttribute;
    if (originalSetAttributeNS !== null) Element.prototype.setAttributeNS = originalSetAttributeNS;
    if (originalInsertBefore !== null) Node.prototype.insertBefore = originalInsertBefore;
    if (originalAppendChild !== null) Node.prototype.appendChild = originalAppendChild;
    originalImageConstructor = null;
    originalSetAttribute = null;
    originalSetAttributeNS = null;
    originalInsertBefore = null;
    originalAppendChild = null;
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

    // ⚠ `render()` 期間攔 `new Image()`——見 `beginImageGuard` 的說明。圖片節點形狀是在
    // render **內部**抓圖的，這是唯一擋得住的位置（而且不必去理解圖表語法）。
    let blockedImage: string | null = null;
    const svg = await enqueueRender(async () => {
      const releaseImageGuard = beginImageGuard((url) => {
        blockedImage ??= url;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 回傳值裡的 `bindFunctions` 刻意不解構、不呼叫——見 `mermaidConfig` 的說明。
        const render = mermaid.render(nextMermaidId(), code).then((result) => result.svg);
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(RENDER_TIMED_OUT)), RENDER_TIMEOUT_MS);
        });
        return await Promise.race([render, timeout]);
      } finally {
        clearTimeout(timer);
        releaseImageGuard();
      }
    });

    // 有東西被擋下來就整張不畫：畫出一張缺圖的圖、使用者卻不知道為什麼，比說清楚更糟。
    if (blockedImage !== null) return { ok: false, message: BLOCKED_EXTERNAL_IMAGE };

    // DOMPurify 擋不住外部資源載入——見 `stripExternalResources` 的說明。
    return { ok: true, svg: stripExternalResources(svg) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
