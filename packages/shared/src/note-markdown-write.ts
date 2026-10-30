/**
 * 並排 PR-2：MCP／REST／站內 AI 寫入 markdown 的兩道檢查（spec 2026-10-21 columns-layout §11.3；server 與 web 共用）。
 *
 * **語法檢查**（{@link checkNoteMarkdownSyntax}，第一道）：在 `markdownToHTML` 的 DOM 上做 S1–S10——並排只收 §11.1 的
 * 正規 div 形、圖片寬度只收 `<figure><img … width></figure>`、表格欄寬只收第一列的 `colwidth`；在這些之前先拒帶事件處理屬性的
 * HTML（`unsupported_block`）。不合格整筆拒絕。
 * S1「並排標記獨佔一行」用逐行標記判：`markdownToHTML` 把各 token 的 HTML 直接串接、不留換行，輸出字串上分不出
 * 「同一行」與「另起一行」——所以先在 markdown 上把逐字等於正規行的行換成帶一次性標記屬性的同行版本（行結構不變，
 * 兩次 tokenize 結果相同；程式碼區塊裡的行被 escape、不成元素），DOM 裡帶並排屬性卻沒有標記的元素一律不收。
 * 檢查與剖析在同一片段情境（`createHTMLDocument` 的 div，見 {@link syntaxCheckRoot}）下建樹，才不會「檢查放行、剖析攤平」。
 * **結構檢查**（{@link findStructureError}，第二道）：parse 出的 blocks 上再查一次列／欄的位置、欄數、寬度範圍。
 * parse 後、結構檢查前，呼叫端先跑 {@link normalizeTableWidths} 與 {@link relativizeSiteUploads}。
 *
 * ⚠ blocks 的走訪都是**迭代**的（顯式堆疊）：巢狀深度由呼叫端的 markdown 決定，不能遞迴。
 * `checkNoteMarkdownSyntax` 用全域 `document`（server 由 `EditingRuntime.installGlobals()` 提供、web 是瀏覽器）；import 本檔不碰 DOM。
 */
import { markdownToHTML } from "@blocknote/core";
import { COLUMNS_OPEN_TAG, COLUMNS_STYLE, COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMN_WIDTH_MAX, COLUMN_WIDTH_MIN, COLUMNS_MAX, COLUMNS_MIN } from "./columns.js";
import { SIZE_PX_MAX, SIZE_PX_MIN, isSizePx } from "./note-sizes.js";

export type MarkdownPlacement = "top" | "nested";
export type MarkdownShapeError = "unsupported_columns" | "unsupported_size";
/** 語法檢查多一碼：帶事件處理屬性（`onerror` 等）的 HTML 回 `unsupported_block`（不屬於版面，見 {@link hasEventHandlerAttr}）。 */
export type MarkdownSyntaxError = MarkdownShapeError | "unsupported_block";

/**
 * 元素帶事件處理屬性：屬性名以 `on` 開頭、長度大於 2（`onerror`、`onclick`、`<svg onload>`、`<math onclick>`…）。只看名字、不問執行中的
 * DOM 有沒有這個 IDL 成員——jsdom 少很多處理器（`onanimationstart`、SVG 動畫的 `onbegin`、MathML 全部），問 DOM 會讓 server 與瀏覽器
 * 拒的集合不同（cleanup r2 Minor 1）。代價是 `<span only>` 這類自造屬性也被拒；讀出形不會產生它們。
 * 防線之外的一層（final review Nit 1）：core 剖析 `<details>` 時把子節點 clone 進活文件，瀏覽器裡 `<img onerror>` 會在剖析時觸發
 *（CSP 擋 inline handler）；檢查用的 DOM 本身是惰性的。
 */
const hasEventHandlerAttr = (el: Element): boolean => el.getAttributeNames().some(n => n.length > 2 && n.startsWith("on"));

const COLUMN_LINE_RE = /^<div data-kb-column style="flex:((?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?)">$/;

/** 去掉行尾一個 `\r` 後，逐字等於外層正規行 → "list"；逐字等於欄正規行且 N 合規 → { width }；否則 null。 */
export function canonicalColumnsLine(line: string): "list" | { width: number } | null {
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (s === COLUMNS_OPEN_TAG) return "list";
  const m = COLUMN_LINE_RE.exec(s);
  if (!m) return null;
  const width = Number(m[1]);
  return width >= COLUMN_WIDTH_MIN && width <= COLUMN_WIDTH_MAX ? { width } : null;
}

const ROW_ATTR = "data-kb-columns";
const COL_ATTR = "data-kb-column";
const isRowEl = (el: Element): boolean => el.hasAttribute(ROW_ATTR);
const isColEl = (el: Element): boolean => el.hasAttribute(COL_ATTR);
// 只有 HTML 的 ASCII whitespace 算空白（`trim()` 會把 NBSP、全形空白也當空白，PM 卻把它們當內容）
const hasLooseText = (el: Element): boolean => Array.from(el.childNodes).some(n => n.nodeType === 3 && /[^\t\n\f\r ]/.test(n.textContent ?? ""));
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

type Check = (els: readonly Element[], root: Element, mark: string) => boolean;

/** 依序檢查（S10、S1–S7 → columns；S8、S9 → size），回第一個不過的。 */
const COLUMNS_CHECKS: readonly Check[] = [
  // S10：站內形（帶 data-node-type）一律不收
  els => els.some(el => el.hasAttribute("data-node-type")),
  // S1：並排元素必須來自逐字正規、獨佔一行的行（帶標記）；前一行沒關上的開標籤會跟正規行併成同一個標籤，
  // 所以帶標記的元素還要驗標籤名、屬性清單與 style 恰為正規形
  (els, _root, mark) =>
    els.some(el => {
      if (!isRowEl(el) && !isColEl(el)) return false;
      if (!el.hasAttribute(mark)) return true;
      if (el.tagName !== "DIV") return true;
      // 值須為空：前一行的 `<div data-kb-columns=` 會把正規行開頭的 `<div` 吞成這個屬性的值
      if (el.getAttribute(isRowEl(el) ? ROW_ATTR : COL_ATTR) !== "") return true;
      const style = el.getAttribute("style") ?? "";
      if (isRowEl(el)) return !sameList(el.getAttributeNames(), [ROW_ATTR, mark, "style"]) || style !== COLUMNS_STYLE;
      return !sameList(el.getAttributeNames(), [COL_ATTR, mark, "style"]) || typeof canonicalColumnsLine(`<div ${COL_ATTR} style="${style}">`) !== "object";
    }),
  // S2：欄元素沒有非空白的直接文字
  els => els.some(el => isColEl(el) && hasLooseText(el)),
  // S3：欄的父元素是列；列的直接子元素全是欄、沒有非空白的直接文字
  els =>
    els.some(el => (isColEl(el) && !(el.parentElement !== null && isRowEl(el.parentElement))) || (isRowEl(el) && (hasLooseText(el) || Array.from(el.children).some(c => !isColEl(c))))),
  // S4：欄數 2–4
  els => els.some(el => isRowEl(el) && (el.children.length < COLUMNS_MIN || el.children.length > COLUMNS_MAX)),
  // S5：列沒有欄祖先
  els => els.some(el => isRowEl(el) && el.parentElement?.closest(`[${COL_ATTR}]`) != null),
  // S6：列在最外層
  (els, root) => els.some(el => isRowEl(el) && el.parentNode !== root),
  // S7：其他 div 不得用 flex／grid 排版
  els =>
    els.some(el => {
      if (el.tagName !== "DIV" || isRowEl(el) || isColEl(el)) return false;
      const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
      return style.includes("display:flex") || style.includes("display:grid");
    }),
];

const IMG_ATTRS: readonly (readonly string[])[] = [["alt", "src", "width"], ["src", "width"]];
const FIGURE_ATTRS: readonly (readonly string[])[] = [[], ["data-background-color"]];
const FIGURE_CHILDREN: readonly (readonly string[])[] = [["IMG"], ["IMG", "FIGCAPTION"]];
const oneOf = (x: readonly string[], options: readonly (readonly string[])[]): boolean => options.some(o => sameList(x, o));

const SIZE_CHECKS: readonly Check[] = [
  // S8：帶 width 的 img 只收 `<figure[ data-background-color]><img[ alt] src width>[<figcaption>]</figure>`；表格格子內一律不收（Q3）
  els =>
    els.some(el => {
      if (el.tagName !== "IMG" || !el.hasAttribute("width")) return false;
      if (el.closest("td,th") !== null || !isSizePx(el.getAttribute("width") ?? "")) return true;
      const fig = el.parentElement;
      if (fig === null || fig.tagName !== "FIGURE" || !oneOf(el.getAttributeNames(), IMG_ATTRS)) return true;
      return !oneOf(fig.getAttributeNames(), FIGURE_ATTRS) || !oneOf(Array.from(fig.children).map(c => c.tagName), FIGURE_CHILDREN);
    }),
  // S9：colwidth 段數＝colspan、每段空或合法 px；有非空段的只在所屬表格第一列（全空＝沒設寬，任何列都收）
  els =>
    els.some(el => {
      if (!el.matches("td,th") || !el.hasAttribute("colwidth")) return false;
      const segs = (el.getAttribute("colwidth") ?? "").split(",");
      if (segs.length !== Number(el.getAttribute("colspan") ?? "1")) return true;
      if (segs.some(s => s !== "" && !isSizePx(s))) return true;
      if (segs.every(s => s === "")) return false;
      const table = el.closest("table") as HTMLTableElement | null;
      return table === null || el.parentElement !== table.rows[0];
    }),
];

/**
 * 語法檢查看的 DOM：與 BlockNote `tryParseHTMLToBlocks` 同一個片段情境（`createHTMLDocument` 的 `div`，body 情境）。
 * 不用 `template`（"in template" 模式下開頭一個 `<col>` 會丟掉其後所有內容，檢查看不到、剖析卻照收），也不用活文件的
 * `document.createElement`（瀏覽器裡 `<img onerror>` 會載入並觸發）。export 給對照測試用。
 */
export function syntaxCheckRoot(html: string): Element {
  const root = document.implementation.createHTMLDocument("").createElement("div");
  root.innerHTML = html;
  return root;
}

/**
 * 通過時回 `html`＝`markdownToHTML(markdown)`（未標記的原文），呼叫端拿它 `tryParseHTMLToBlocks`。
 * 順序：事件處理屬性（`unsupported_block`）→ 並排（S10、S1–S7）→ 尺寸（S8、S9）。
 */
export function checkNoteMarkdownSyntax(markdown: string, placement: MarkdownPlacement): { ok: true; html: string } | { ok: false; error: MarkdownSyntaxError } {
  // 標記屬性名避開原文裡出現過的字串（不分大小寫：HTML 屬性名不分大小寫），模型偽造不出來
  const lower = markdown.toLowerCase();
  let mark = "data-kb-line";
  while (lower.includes(mark)) mark += "x";
  const marked = markdown
    .split("\n")
    .map(line => {
      const c = canonicalColumnsLine(line);
      if (c === null) return line;
      const cr = line.endsWith("\r") ? "\r" : "";
      if (c === "list") return `<div ${ROW_ATTR} ${mark} style="${COLUMNS_STYLE}">${cr}`;
      const n = /flex:([^"]*)"/.exec(line)![1];
      return `<div ${COL_ATTR} ${mark} style="flex:${n}">${cr}`;
    })
    .join("\n");
  const root = syntaxCheckRoot(markdownToHTML(marked));
  const els = Array.from(root.querySelectorAll("*"));
  if (els.some(hasEventHandlerAttr)) return { ok: false, error: "unsupported_block" };
  if (placement === "nested" && els.some(el => isRowEl(el) || isColEl(el))) return { ok: false, error: "unsupported_columns" };
  if (COLUMNS_CHECKS.some(check => check(els, root, mark))) return { ok: false, error: "unsupported_columns" };
  if (SIZE_CHECKS.some(check => check(els, root, mark))) return { ok: false, error: "unsupported_size" };
  return { ok: true, html: markdownToHTML(markdown) };
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * 對每個 block（含任何深度的 children）套 `fix`，copy-on-write：`fix` 回原物件＝沒改；有改到的 block 的祖先
 * 一路複製成新物件，其餘沿用原物件；整棵沒改到就回同一個陣列。迭代：先序收集，再倒序（子孫先於祖先）組回。
 */
function mapBlocksCow<B>(blocks: B[], fix: (b: Rec) => Rec): B[] {
  const nodes: Rec[] = [];
  const parent: number[] = [];
  const slot: number[] = [];
  const stack: Array<[unknown, number, number]> = [];
  for (let i = blocks.length - 1; i >= 0; i--) stack.push([blocks[i], -1, i]);
  while (stack.length > 0) {
    const [n, p, s] = stack.pop()!;
    if (!isRec(n)) continue;
    const idx = nodes.length;
    nodes.push(n);
    parent.push(p);
    slot.push(s);
    const ch = n.children;
    if (Array.isArray(ch)) for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], idx, i]);
  }
  const newChildren: Array<unknown[] | undefined> = new Array(nodes.length);
  let out: unknown[] | undefined;
  for (let idx = nodes.length - 1; idx >= 0; idx--) {
    const orig = nodes[idx]!;
    let cur = fix(orig);
    const nc = newChildren[idx];
    if (nc !== undefined) cur = { ...cur, children: nc };
    if (cur === orig) continue;
    const p = parent[idx]!;
    if (p === -1) (out ??= blocks.slice())[slot[idx]!] = cur;
    else (newChildren[p] ??= (nodes[p]!.children as unknown[]).slice())[slot[idx]!] = cur;
  }
  return (out ?? blocks) as B[];
}

const isPositiveFinite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Q2：parse 後把每個 table 的 `content.columnWidths` 裡不是正有限數的值（core 對空段 parse 出的 NaN、0、負數）換成 `undefined`。
 *  顯式堆疊走訪 children（含欄），copy-on-write（沒改到就回同一陣列／物件），只動 `columnWidths`。 */
export function normalizeTableWidths<B>(blocks: B[]): B[] {
  return mapBlocksCow(blocks, b => {
    if (b.type !== "table" || !isRec(b.content) || !Array.isArray(b.content.columnWidths)) return b;
    const ws = b.content.columnWidths as unknown[];
    if (ws.every(v => v === undefined || isPositiveFinite(v))) return b;
    return { ...b, content: { ...b.content, columnWidths: ws.map(v => (isPositiveFinite(v) ? v : undefined)) } };
  });
}

const UPLOAD_PATH_RE = /^\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 讀碼發現 15：parse 時被 core 絕對化的站內上傳網址還原成相對形。每個帶字串 `props.url` 的 block（顯式堆疊走訪 children、copy-on-write）：
 *  `url` 能以 `new URL(url)`（不給 base）解析，且以解析後（不是字面）的值判定：`origin === baseOrigin`、`username`／`password`／`search`／`hash` 都空、
 *  `pathname` 符合 `/api/uploads/<uuid>`（同 server `copy-doc.ts`）→ 換成 `pathname`；其餘一律不動。
 *  呼叫端傳 `new URL(document.baseURI).origin`（parse 所用 DOM 的 base）。 */
export function relativizeSiteUploads<B>(blocks: B[], baseOrigin: string): B[] {
  return mapBlocksCow(blocks, b => {
    if (!isRec(b.props) || typeof b.props.url !== "string") return b;
    let u: URL;
    try {
      u = new URL(b.props.url);
    } catch {
      return b;
    }
    if (u.origin !== baseOrigin || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || !UPLOAD_PATH_RE.test(u.pathname)) return b;
    return { ...b, props: { ...b.props, url: u.pathname } };
  });
}

const isSizeValue = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= SIZE_PX_MIN && v <= SIZE_PX_MAX;

/** 結構檢查（第二道）：顯式堆疊走訪，不遞迴。在 normalizeTableWidths 之後跑。並排與尺寸都違反時回 `unsupported_columns`。 */
export function findStructureError(blocks: readonly unknown[], placement: MarkdownPlacement): MarkdownShapeError | null {
  // [block, 深度, 父 block 的型別, 是否在欄內]
  const stack: Array<[unknown, number, unknown, boolean]> = [];
  for (const b of blocks) stack.push([b, 0, undefined, false]);
  let size = false;
  while (stack.length > 0) {
    const [n, depth, parentType, inColumn] = stack.pop()!;
    if (!isRec(n)) continue;
    const props = isRec(n.props) ? n.props : {};
    const children = Array.isArray(n.children) ? (n.children as unknown[]) : [];
    if (n.type === COLUMN_LIST_TYPE) {
      if (placement !== "top" || depth !== 0) return "unsupported_columns";
      // 到不了（欄必在 columnList 下、深度 ≥ 1，欄內的 columnList 深度 ≥ 2，上一行先擋）；留著對應「欄內不得有列」這條
      if (inColumn) return "unsupported_columns";
      if (children.length < COLUMNS_MIN || children.length > COLUMNS_MAX) return "unsupported_columns";
      if (!children.every(c => isRec(c) && c.type === COLUMN_TYPE)) return "unsupported_columns";
    } else if (n.type === COLUMN_TYPE) {
      if (parentType !== COLUMN_LIST_TYPE) return "unsupported_columns";
      const w = props.width;
      if (typeof w !== "number" || !Number.isFinite(w) || w < COLUMN_WIDTH_MIN || w > COLUMN_WIDTH_MAX) return "unsupported_columns";
    } else if (n.type === "image") {
      if (props.previewWidth !== undefined && !isSizeValue(props.previewWidth)) size = true;
    } else if (n.type === "table" && isRec(n.content) && Array.isArray(n.content.columnWidths)) {
      if (!(n.content.columnWidths as unknown[]).every(v => v === undefined || v === null || isSizeValue(v))) size = true;
    }
    const nextInColumn = inColumn || n.type === COLUMN_TYPE;
    for (const c of children) stack.push([c, depth + 1, n.type, nextInColumn]);
  }
  return size ? "unsupported_size" : null;
}
