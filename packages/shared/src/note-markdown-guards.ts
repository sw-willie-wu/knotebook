/**
 * markdown 寫入解析的保護（#398；server 的 `parseMarkdownForNote` 與網頁站內 AI 的 `prepareAiResult` 共用同一套規則）：
 * 都在 {@link checkNoteMarkdownSyntax} 之後、`tryParseHTMLToBlocks` 之前，在同一個片段情境的 DOM（`syntaxCheckRoot`）上做。
 *
 * - {@link findParseGuardFailure}：巢狀深度上限（`too_deep`）與段落裡的段落（`nested_paragraph`），整筆拒絕。
 * - {@link premergedHtml}：引言／標題／摺疊項 summary 底下的多段落先併好（BlockNote 自己併是平方成長）。
 * - {@link plainParagraphFloor}／{@link topLevelBlockFloor}：block 數的便宜下界（只有 server 有 block 上限，網頁的站內 AI 不用）。
 *
 * server 端整條解析在 worker thread 裡跑、有時限與記憶體上限（`apps/server/src/notes/editing/parse-pool.ts`）；這裡的規則
 * 管的是「合法內容要快、要對」，不是最後一道防線。
 * ⚠ 走訪一律用 `firstElementChild`／`nextElementSibling`＋顯式堆疊：server 端 DOM（jsdom）的 `children` 每讀一次是 O(子數)，
 * 而巢狀深度由 markdown 決定，不能遞迴。import 本檔不碰 DOM。
 */
import { syntaxCheckRoot } from "./note-markdown-write.js";

/**
 * HTML 巢狀深度上限（從語法檢查的根算起，元素一層算一層）。BlockNote 解析巢狀引言時每層各自複製、各自剖析底下整棵，深度越深越慢
 * （實測 1 600 層 9 秒）。正常內容實測：清單巢 20 層＝41、100 層＝201（每層 `<ul>`＋`<li>`）；並排欄裡巢 10 層清單、details、表格、
 * 粗斜體連結色字＝23；引言裡清單裡引言三層＝10。128 讓清單巢到 60 多層都還能寫。
 */
export const MAX_HTML_DEPTH = 128;

/** DOM 的巢狀深度（`root` 的子元素算 1）。用堆疊、走 `firstElementChild`／`nextElementSibling`（不遞迴，也不碰 O(子數) 的 `children`）。 */
export function htmlDepth(root: Element): number {
  let max = 0;
  const stack: Array<[Element, number]> = [];
  for (let c = root.firstElementChild; c !== null; c = c.nextElementSibling) stack.push([c, 1]);
  while (stack.length > 0) {
    const [el, d] = stack.pop()!;
    if (d > max) max = d;
    for (let c = el.firstElementChild; c !== null; c = c.nextElementSibling) stack.push([c, d + 1]);
  }
  return max;
}

/** 解析前保護擋下的成因。 */
export type ParseGuardFailure = "too_deep" | "nested_paragraph";

/**
 * 深度超過 {@link MAX_HTML_DEPTH} → `too_deep`；段落裡又有段落（經 `<button>`、`<marquee>`、`<svg>` 的 foreignObject、`<math>` 的
 * mtext 之類）→ `nested_paragraph`（BlockNote 解析段落時也會把底下的 `<p>` 併起來，同樣平方成長，而且併法會讓文字重複）。都沒有 → null。
 */
export function findParseGuardFailure(root: Element): ParseGuardFailure | null {
  if (htmlDepth(root) > MAX_HTML_DEPTH) return "too_deep";
  if (root.querySelector("p p") !== null) return "nested_paragraph";
  return null;
}

/**
 * BlockNote 解析時會把底下所有 `<p>` 併成一個的元素：引言、標題（`createSpec.ts` 的預設 inline 解析），與 `<details>` 的第一個直屬
 * `<summary>`（`getDetailsContent.ts`：摺疊清單項、摺疊標題的那一行）。
 */
const MERGE_ROOT_TAGS = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "SUMMARY"]);
const MERGE_ROOT_TAG = /<(?:blockquote|h[1-6]|summary)\b/i;
/**
 * `<plaintext>`：它之後的所有字（含標籤）都變成純文字，序列化（`innerHTML`）後再剖析不會回到同一棵樹——預先併好再交給 BlockNote
 * 會與不併的結果不同（全分支審查 ffrv3），所以有它就不預先併。
 */
const PLAINTEXT_TAG = /<plaintext\b/i;
/** 會被併的元素；`<summary>` 只有是 `<details>` 的第一個直屬 summary 時才算（`details.querySelector(":scope > summary")`）。 */
const isMergeRoot = (el: Element): boolean =>
  MERGE_ROOT_TAGS.has(el.tagName) &&
  (el.tagName !== "SUMMARY" || (el.parentElement?.tagName === "DETAILS" && el.parentElement.querySelector(":scope > summary") === el));

/**
 * BlockNote 0.52 解析引言、標題與摺疊項的 summary 時，用 `mergeParagraphs`（`blocks/defaultBlockHelpers.ts`）把元素底下（任何深度）
 * 所有 `<p>` 併進第一個、以 `<br>` 相接——寫法是迴圈裡 `first.innerHTML += "<br>" + p.innerHTML`，每輪重新序列化、重新剖析越來越長的
 * 第一段，所以是平方成長：一個引言裡 1 000 段約 5 秒、2 000 段約 21 秒（實測，在 `tryParseHTMLToBlocks` 裡）。
 *
 * 這裡在交給 BlockNote 之前，用同一個規則先把 `root` 底下的併好（就地改 `root`），一次串完、一次設 `innerHTML`（線性）；BlockNote 再處理
 * 時只剩一個 `<p>`，什麼都不做。拿掉的 `<p>` 換成一個空註解、不直接刪：BlockNote 刪 `<p>` 時，前後的空白文字節點仍是兩個分開的節點，
 * 直接刪掉再序列化、重新剖析會黏成一個，空白的處理就不同（多行 HTML 會少一格空白）；隔一個註解就保持分開。
 *
 * 走訪：自己用堆疊做深度優先，遇到會被併的元素就整棵處理、不再往下（外層併的時候本來就把裡面那層的 `<p>` 一起收走）；跳過的只有
 * 帶 `data-content-type` 的元素（編輯器內部形，那條 parse 規則用 `contentElement`，不併段落）與 `<figcaption>`（圖說走自己的文字擷取）
 * 的整棵子樹——這兩處底下的引言仍交給 BlockNote 自己併（可能慢；server 端由 worker 的時限兜住）。`<pre>` 照樣往下走。
 *
 * 等價範圍：server 的 `editing-paragraph-merge.test.ts` 逐案比對併過與沒併過的 blocks（拿掉 id）；段落裡又有段落（`p p`）的內容在這之前
 * 已整筆拒絕（{@link findParseGuardFailure}），不在等價範圍內。回傳有沒有改。
 */
export function premergeInto(root: Element): boolean {
  const doc = root.ownerDocument;
  let changed = false;
  const stack: Element[] = [];
  for (let c = root.lastElementChild; c !== null; c = c.previousElementSibling) stack.push(c);
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el.hasAttribute("data-content-type") || el.tagName === "FIGCAPTION") continue;
    if (isMergeRoot(el)) {
      const ps = Array.from(el.querySelectorAll("p"));
      if (ps.length >= 2) {
        const parts = ps.map(p => p.innerHTML);
        for (const p of ps.slice(1)) p.replaceWith(doc.createComment(""));
        ps[0]!.innerHTML = parts.join("<br>");
        changed = true;
      }
      continue;
    }
    for (let c = el.lastElementChild; c !== null; c = c.previousElementSibling) stack.push(c);
  }
  return changed;
}

/**
 * 要交給 `tryParseHTMLToBlocks` 的 HTML：`html` 是語法檢查回的那份、`root` 是它的 `syntaxCheckRoot`（會就地改）。沒有要併的
 * （沒有引言／標題／summary、或有 `<plaintext>`）回原字串。⚠ 呼叫之後 `root` 可能已被改，其他檢查要排在它之前。
 */
export function premergedHtml(html: string, root: Element): string {
  if (!MERGE_ROOT_TAG.test(html) || PLAINTEXT_TAG.test(html)) return html;
  return premergeInto(root) ? root.innerHTML : html;
}

/** {@link premergedHtml} 的字串版（測試用）：沒有要併的回傳同一個字串。 */
export function premergeParagraphs(html: string): string {
  if (!MERGE_ROOT_TAG.test(html)) return html; // 沒有要併的元素就不建 DOM
  return premergedHtml(html, syntaxCheckRoot(html));
}

/**
 * block 上限的便宜預判（全分支審查 I2(b)）：完整解析遠比算數貴，所以先估一個**下界**——下界超過上限時真解析一定也超過，直接回
 * `too_many_blocks`，結果與不預判相同（只有同時還有別種錯的檔，回的碼可能從那種錯變成 `too_many_blocks`）。估不準只會估少。
 *
 * 第一層（解析前、逐行，毫秒級）：全文沒有 `<`（沒有任何 HTML）、也沒有任何 ``` 或 ~~~（不管在哪：像 code fence 的都算）時才估——
 * 數「空行之後、以字母開頭」的行。這種行一定開始一個頂層段落（或標題、表格），至少一顆 block。縮排的、`-`／`>`／`#`／數字開頭的都
 * 不算。fence 一律不估、交給第二層：BlockNote 0.52 的 `markdownToHTML` 不是 CommonMark，哪一行開 fence、哪一行收尾都跟規格不同。
 */
const FENCE_LIKE = /`{3,}|~{3,}/;
const BLANK = /^[ \t]*$/;
const STARTS_WITH_LETTER = /^\p{L}/u;
export function plainParagraphFloor(markdown: string): number {
  if (markdown.includes("<") || FENCE_LIKE.test(markdown)) return 0;
  let n = 0;
  let afterBlank = true;
  for (const line of markdown.split(/\r\n?|\n/)) {
    if (BLANK.test(line)) {
      afterBlank = true;
      continue;
    }
    if (afterBlank && STARTS_WITH_LETTER.test(line)) n++;
    afterBlank = false;
  }
  return n;
}

/** 第二層的門檻：短於這個長度的 markdown 完整解析本來就便宜（不數 DOM）。 */
export const BLOCK_PRECHECK_MIN_CHARS = 16 * 1024;
/**
 * 第二層（語法檢查的 DOM 上）：數頂層有字的 `<p>`、`<h1>`–`<h6>`、`<pre>`，與頂層清單裡有字的 `<li>`——每個都一定 parse 成至少一顆
 * block。巢在別的元素裡的不算（表格儲存格之類會把裡面的段落併成一顆）。`Array.from(root.children)` 在 2.7 萬個子元素上實測 6.7 s，
 * 走兄弟 3 ms。
 */
export function topLevelBlockFloor(root: Element): number {
  const hasText = (el: Element) => (el.textContent ?? "").trim() !== "";
  let n = 0;
  for (let el = root.firstElementChild; el !== null; el = el.nextElementSibling) {
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      for (let li = el.firstElementChild; li !== null; li = li.nextElementSibling) if (li.tagName.toLowerCase() === "li" && hasText(li)) n++;
    } else if ((tag === "p" || tag === "pre" || /^h[1-6]$/.test(tag)) && hasText(el)) n++;
  }
  return n;
}
