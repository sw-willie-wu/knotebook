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
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 效能（issue #344）：少畫、晚畫、不重畫
 * ──────────────────────────────────────────────────────────────────────────
 * `render()` 幾乎是一整段同步的 long task（150 節點約 500 ms），而且要用活的 DOM 量文字，
 * 丟不進 Web Worker。所以這一層做的不是讓單張變快，而是：
 * - **自己的序列化佇列**（`enqueue`）：一次只畫一張，每張之前先讓出主執行緒（等一個 frame 再
 *   `setTimeout(0)`，見 `yieldToMain`），使用者的輸入才插得進兩張圖之間、畫好的圖先上螢幕；
 *   被 `AbortSignal` 取消的項目輪到時直接跳過、不畫。
 *   （mermaid 自己也有一條全域 `executionQueue`，但它在兩張之間只走 microtask，整頁的圖會連成
 *   一大段不讓出的工作，期間連一個 frame 都畫不出來。）
 * - **結果快取**（`svgCache`）：同一主題＋同一原始碼第二次出現（切走筆記再回來、進出簡報模式）
 *   直接拿 SVG，不再跑 render。
 * - 「只畫視窗附近的圖」與載入中佔位在呼叫端（`MermaidView`）。
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

/** 測試用：把模組層級的狀態（初始化主題、快取、佇列）歸零（模組層級狀態在測試之間會殘留）。 */
export function resetMermaidForTests(): void {
  initializedTheme = null;
  svgCache.clear();
  queueTail = Promise.resolve();
}

// ──────────────────────────────────────────────────────────────────────────
// 結果快取（#344 B）
// ──────────────────────────────────────────────────────────────────────────

/** 快取上限。一張 SVG 約 80–300 KB，30 張是「一份長筆記＋切走再回來」夠用、記憶體又不失控的量。 */
export const MERMAID_CACHE_LIMIT = 30;

/**
 * `(theme, code)` → 成功的 SVG 與畫它時用的 id。`Map` 保留插入順序，命中時刪掉重插＝移到最新，
 * 超過上限從最舊的開始丟——就是 LRU。
 *
 * **只快取成功的結果**：失敗多半是語法錯（重算只走到 parse，幾 ms），或 chunk 載入失敗這類
 * 暫時性錯誤——後者快取起來，網路恢復之後圖也永遠畫不出來。
 */
const svgCache = new Map<string, { svg: string; id: string }>();

function cacheKey(code: string, theme: MermaidTheme): string {
  return `${theme}\n${code}`;
}

/**
 * 把 SVG 裡的 id 前綴從 `oldId` 換成 `newId`。
 *
 * mermaid 的輸出到處引用這個 id：根 `<svg id>`、`<style>` 裡的 `#mermaid-3 .node…`、marker 的
 * `id="mermaid-3_flowchart-v2-pointEnd"` 與 `marker-end="url(#mermaid-3_…)"`、`aria-labelledby` 等。
 * 同一頁兩張原始碼相同的圖若共用同一份字串，id 就重複——樣式與箭頭會指到另一張圖去。
 *
 * ⚠ 比對**不得吃到後續數字**：`mermaid-1` 不可命中 `mermaid-12`（lookahead `(?![0-9])`）。
 * 前面也要求不是英數字，避免 `xmermaid-1` 這類巧合——用捕獲群組 `(^|[^A-Za-z0-9])` 而**不是**
 * lookbehind `(?<!…)`：後者 Safari 16.4 才支援，而 Vite 的預設 target 含 safari16，寫在 `new RegExp`
 * 字串裡也不會被轉譯，舊 Safari 會在快取命中時丟 SyntaxError、元件直接崩掉。
 *
 * 殘留（審查實測 22 種圖）：
 * - 圖的**文字**裡若剛好寫著同一個 id（例如 label 叫 `mermaid-3`），那段字也會被換掉——只影響顯示文字。
 * - 有幾種圖另有 mermaid **全域計數器**產生、不帶 `mermaid-N` 前綴的 id：sankey 的 `node-N`／
 *   `linearGradient-N`、sequence 的 `actorN`／`root-N`、architecture 的 `IconifyId…`。這些不改寫，
 *   所以「同一頁兩張原始碼相同」時它們會重複（各自獨立 render 時本來每次都不同），副本裡的
 *   `url(#linearGradient-N)` 會解析到頁面上第一個同名元素。兩張內容完全相同，畫面看不出差別；
 *   原圖改了原始碼重畫時會拿到新的計數，舊 id 只剩副本自己的那份。沒有做「收集 SVG 內所有 id 一起
 *   換前綴」：這些 id 是短的通用字（`node-0`、`actor1`），要改寫就得認得每種圖所有引用它們的寫法
 *   （`url()`、`href`、aria 清單、CSS 選擇器……），沒有逐圖種實測就無法確定不會誤換文字或漏換引用。
 */
export function rewriteMermaidId(svg: string, oldId: string, newId: string): string {
  if (oldId === newId) return svg;
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return svg.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, "g"), `$1${newId}`);
}

/**
 * 同步查快取。命中時回傳**已換成新 id** 的 SVG（每次呼叫都是新 id，可以放心同時顯示多份），
 * 並把它移到 LRU 的最新端；沒命中回 `null`。空原始碼不查。
 *
 * `MermaidView` 用它在掛載當下就拿到圖（切回筆記時不閃佔位），`renderMermaid` 也先走它。
 */
export function cachedMermaid(code: string, theme: MermaidTheme): string | null {
  if (code.trim().length === 0) return null;
  const key = cacheKey(code, theme);
  const entry = svgCache.get(key);
  if (entry === undefined) return null;
  svgCache.delete(key);
  svgCache.set(key, entry);
  return rewriteMermaidId(entry.svg, entry.id, nextMermaidId());
}

function storeInCache(code: string, theme: MermaidTheme, svg: string, id: string): void {
  const key = cacheKey(code, theme);
  svgCache.delete(key);
  svgCache.set(key, { svg, id });
  while (svgCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value as string;
    svgCache.delete(oldest);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 序列化佇列（#344 C）
// ──────────────────────────────────────────────────────────────────────────

/** 佇列尾端。每個新項目接在它後面；它永遠 resolve（項目的失敗只回給該項目的呼叫端）。 */
let queueTail: Promise<void> = Promise.resolve();

function abortError(): DOMException {
  return new DOMException("mermaid render aborted", "AbortError");
}

/**
 * 讓出主執行緒一次：先等下一個 frame、再排一個 macrotask。
 *
 * 為什麼不只是 `setTimeout(0)`：e2e 疊上量測（#344，3 次裡 2 次）只用 `setTimeout(0)` 時，瀏覽器在
 * 兩張 long task 之間常常**不畫 frame**——視窗內的圖早就畫好了，卻要等後面預先範圍裡的幾張也畫完
 * 才一起出現在螢幕上；IntersectionObserver 的回報也要等 frame，捲出視窗的項目來不及被取消。
 * 等一個 frame 讓「畫好的先上螢幕、捲走的先取消」，之後的 `setTimeout(0)` 讓等著的輸入事件先跑。
 *
 * 分頁在背景（`requestAnimationFrame` 不跑）或沒有 rAF 的環境只走 `setTimeout(0)`，佇列不會卡住；
 * 100 ms 的保底同理（分頁在等待途中被切到背景）。
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function" || document.visibilityState === "hidden") {
      setTimeout(resolve, 0);
      return;
    }
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
}

/**
 * 把一次渲染排進佇列：前一項做完 → 已被取消就直接跳過（不付讓出的那一個 frame）→ 讓出主執行緒 → 執行。
 * 讓出放在**執行之前**而不是之後，結果做完就交回呼叫端，不必多等一個 tick。
 * 讓出期間被取消的，由 `task` 自己在載入 mermaid 之後、render 之前那道檢查擋下（見 `renderMermaid`）。
 */
function enqueue<T>(task: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const run = queueTail.then(async () => {
    if (signal?.aborted) throw abortError();
    await yieldToMain();
    return task();
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 預先下載並執行 mermaid 主 chunk（#344 E），**不渲染**。`MermaidView` 一掛上就呼叫——
 * 即使那張圖還在視窗外——第一張圖捲進來時就不必從下載開始等。失敗吞掉：真正要畫時
 * `renderMermaid` 會再 import 一次並把錯誤交給錯誤態。仍是動態 import，不會把 mermaid
 * 併進 NotePage chunk。
 */
export function preloadMermaid(): void {
  void import("mermaid").catch(() => undefined);
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
 * 後者跟筆記裡用網址嵌入的圖片是同一個等級的能力（shared `note-schema-config.ts` 的
 * 政策就是放行 http(s)），只擋 mermaid 沒有意義。要對整個 app 關掉那一類，是 #101（CSP）的事。
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
 * （現在檔中的序列化佇列是 #344 的**效能**手段，與那套已拆掉的安全機制無關，也不擋任何請求。）
 */
function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    secure: [...LOCKED_CONFIG_KEYS],
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    htmlLabels: false, // mermaid 11 的新位置
    flowchart: { htmlLabels: false }, // 舊位置，保留相容
    // 語法錯時 `render()` 直接 throw、不畫「Syntax error in text」錯誤圖、並清掉它在 body 插的
    // 暫時容器（見 `renderMermaid`）。已在 `LOCKED_CONFIG_KEYS`，圖裡的 directive 改不掉。
    suppressErrorRendering: true,
  };
}

/**
 * 把 mermaid 原始碼畫成 SVG 字串。
 *
 * @param code  mermaid 原始碼。空白／純空白直接回 `ok:false`，不載入 mermaid——
 *              新建的空 block 是常態，不該為它拉進一整包相依。
 * @param theme `resolvedTheme`（`"light" | "dark"`）。換主題會重新 initialize。
 * @param options.signal 取消。輪到它時、或讓出主執行緒／載入 mermaid 的期間若已取消，
 *              就不畫、promise 以 `AbortError` reject；**已經開始的 `render()` 停不下來**，
 *              它畫完的結果照樣進快取。例外：輪到時佇列裡的快取已命中（前面排的同一張圖剛畫完），
 *              即使已取消也照常 resolve 出 `ok:true`——不花成本，呼叫端本來就會丟掉作廢的結果。
 *              沒給 signal 的呼叫（簡報模式）永遠不會 reject。
 *
 * 快取命中直接回傳、不排隊；沒命中才進序列化佇列。
 */
export async function renderMermaid(
  code: string,
  theme: MermaidTheme,
  options: { signal?: AbortSignal } = {},
): Promise<MermaidRenderResult> {
  if (code.trim().length === 0) {
    return { ok: false, message: "" }; // 空 block：呼叫端顯示提示而非錯誤
  }

  const cached = cachedMermaid(code, theme);
  if (cached !== null) return { ok: true, svg: cached };

  const { signal } = options;
  return enqueue(async () => {
    // 排在前面的同一張圖可能剛畫完（同頁兩張相同原始碼）：輪到自己時再查一次快取。
    const cachedNow = cachedMermaid(code, theme);
    if (cachedNow !== null) return { ok: true, svg: cachedNow } as const;

    let mermaid: Awaited<typeof import("mermaid")>["default"];
    try {
      ({ default: mermaid } = await import("mermaid"));
    } catch (err) {
      return failure(err); // chunk 載入失敗（離線、部署換版）：錯誤態，下次重畫再試
    }
    // 唯一的「開始之後」取消檢查：讓出主執行緒那一個 frame、第一次下載 mermaid 都可能很久，
    // 這段期間被取消（捲走、卸載、原始碼又改了）就不畫。過了這裡 render 就停不下來了。
    if (signal?.aborted) throw abortError();

    try {
      // 同一主題只 initialize 一次；換主題才重來（initialize 是全域設定，重複呼叫無害但沒必要）。
      // 佇列一次只跑一項，所以 initialize 與緊接著的 render 之間不會插進別的主題。
      if (initializedTheme !== theme) {
        mermaid.initialize(mermaidConfig(theme));
        initializedTheme = theme;
      }

      // ⚠ **不必（也不再）先 `parse()`**——靠的是 `mermaidConfig` 的 `suppressErrorRendering: true`。
      // 預設（false）時 `render()` 語法錯會把一張「Syntax error in text」的錯誤圖**留在
      // `document.body`**，逃出元件邊界、掛在頁面底部，重繪一次多一張（2026-08-27 在瀏覽器上
      // 才看到；當時的修法是先 `parse()` 擋掉）。開了 `suppressErrorRendering` 之後，mermaid
      // 11.17 在 parse 失敗與 draw 失敗兩條路徑上都先移除它插在 body 的暫時容器再 throw，
      // 錯誤由我們自己的錯誤態呈現（訊息 ＋ 原始碼）。`render()` 內部本來就會 parse 一次，
      // 先 `parse()` 等於每張圖 parse 兩次（#344 實測佔 5–8%）。
      // 這件事單元測試抓不到（mermaid 被 mock 掉），由 e2e `06-mermaid.spec.ts` 在真瀏覽器
      // 檢查 body 沒有殘留；改動這段或升級 mermaid 時以那條複驗。
      //
      // 回傳值裡的 `bindFunctions` 刻意不解構、不呼叫——見 `mermaidConfig` 的說明。
      const id = nextMermaidId();
      const { svg } = await mermaid.render(id, code);
      storeInCache(code, theme, svg, id);
      return { ok: true, svg } as const;
    } catch (err) {
      return failure(err);
    }
  }, signal);
}

function failure(err: unknown): MermaidRenderResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}
