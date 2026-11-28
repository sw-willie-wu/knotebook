// Callers run normalizeTableWidths and relativizeSiteUploads after parsing and before findStructureError.
// markdownToHTML drops line structure, so canonical columns lines get a one-off marker attribute first and
// column elements without it are rejected. The marked line keeps the line structure, so it tokenizes the same;
// inside code blocks it is escaped text, not an element. Traversal is iterative: nesting depth comes from the caller's markdown.
// Uses global `document` (server: EditingRuntime.installGlobals()); importing this file doesn't touch the DOM.
import { markdownToHTML } from "@blocknote/core";
import { COLUMNS_OPEN_TAG, COLUMNS_STYLE, COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMN_WIDTH_MAX, COLUMN_WIDTH_MIN, COLUMNS_MAX, COLUMNS_MIN } from "./columns.js";
import { SIZE_PX_MAX, SIZE_PX_MIN, isSizePx } from "./note-sizes.js";

export type MarkdownPlacement = "top" | "nested";
export type MarkdownShapeError = "unsupported_columns" | "unsupported_size";
export type MarkdownSyntaxError = MarkdownShapeError | "unsupported_block";

// Name-only: jsdom lacks many handlers (SVG onbegin, all of MathML), so asking the DOM would make server and browser disagree.
// Core clones <details> children into the live document while parsing, where <img onerror> would fire in a browser (CSP blocks inline
// handlers); the DOM used for this check is inert. Cost: made-up attributes like <span only> are rejected too; read output never has them.
const hasEventHandlerAttr = (el: Element): boolean => el.getAttributeNames().some(n => n.length > 2 && n.startsWith("on"));

const COLUMN_LINE_RE = /^<div data-kb-column style="flex:((?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?)">$/;

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
// Only HTML ASCII whitespace: trim() would also drop NBSP and ideographic spaces, which PM treats as content.
const hasLooseText = (el: Element): boolean => Array.from(el.childNodes).some(n => n.nodeType === 3 && /[^\t\n\f\r ]/.test(n.textContent ?? ""));
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

type Check = (els: readonly Element[], root: Element, mark: string) => boolean;

const COLUMNS_CHECKS: readonly Check[] = [
  els => els.some(el => el.hasAttribute("data-node-type")),
  // An unclosed tag on the previous line can merge with a canonical line into one tag, so marked elements
  // must also have exactly the canonical tag name, attribute list and style.
  (els, _root, mark) =>
    els.some(el => {
      if (!isRowEl(el) && !isColEl(el)) return false;
      if (!el.hasAttribute(mark)) return true;
      if (el.tagName !== "DIV") return true;
      // Must be empty: a preceding `<div data-kb-columns=` would swallow the canonical line's `<div` as this value.
      if (el.getAttribute(isRowEl(el) ? ROW_ATTR : COL_ATTR) !== "") return true;
      const style = el.getAttribute("style") ?? "";
      if (isRowEl(el)) return !sameList(el.getAttributeNames(), [ROW_ATTR, mark, "style"]) || style !== COLUMNS_STYLE;
      return !sameList(el.getAttributeNames(), [COL_ATTR, mark, "style"]) || typeof canonicalColumnsLine(`<div ${COL_ATTR} style="${style}">`) !== "object";
    }),
  els => els.some(el => isColEl(el) && hasLooseText(el)),
  els =>
    els.some(el => (isColEl(el) && !(el.parentElement !== null && isRowEl(el.parentElement))) || (isRowEl(el) && (hasLooseText(el) || Array.from(el.children).some(c => !isColEl(c))))),
  els => els.some(el => isRowEl(el) && (el.children.length < COLUMNS_MIN || el.children.length > COLUMNS_MAX)),
  els => els.some(el => isRowEl(el) && el.parentElement?.closest(`[${COL_ATTR}]`) != null),
  (els, root) => els.some(el => isRowEl(el) && el.parentNode !== root),
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
  els =>
    els.some(el => {
      if (el.tagName !== "IMG" || !el.hasAttribute("width")) return false;
      if (el.closest("td,th") !== null || !isSizePx(el.getAttribute("width") ?? "")) return true;
      const fig = el.parentElement;
      if (fig === null || fig.tagName !== "FIGURE" || !oneOf(el.getAttributeNames(), IMG_ATTRS)) return true;
      return !oneOf(fig.getAttributeNames(), FIGURE_ATTRS) || !oneOf(Array.from(fig.children).map(c => c.tagName), FIGURE_CHILDREN);
    }),
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

// Same fragment context as tryParseHTMLToBlocks. Not `template` (a leading `<col>` drops the rest, which the
// parser keeps) and not the live document (`<img onerror>` would fire).
export function syntaxCheckRoot(html: string): Element {
  const root = document.implementation.createHTMLDocument("").createElement("div");
  root.innerHTML = html;
  return root;
}

const PRE_SPLIT = /(<pre\b[\s\S]*?(?:<\/pre\s*>|$))/i;
const PRE_WHOLE = /^<pre\b/i;
// #386: tryParseHTMLToBlocks turns the `\n` after each `<br>` into a leading space. Remove only that `\n`
// (spaces after `<br>` are the author's) and skip hand-written `<pre>`, where newlines matter.
// A newline after `<br>` doesn't render, so removing it keeps semantics; `<br>` in code blocks is escaped text and can't match.
function dropNewlineAfterBreaks(html: string): string {
  return html
    .split(PRE_SPLIT)
    .map(seg => (PRE_WHOLE.test(seg) ? seg : seg.replace(/(<br\b[^>]*>)\n/gi, "$1")))
    .join("");
}

/**
 * Parse the returned `html` (from the unmarked input), not your own markdownToHTML output: it has the `<br>` fix applied.
 * Checks run event handlers, then columns, then size; the first failure is the reported error.
 */
export function checkNoteMarkdownSyntax(input: string, placement: MarkdownPlacement): { ok: true; html: string } | { ok: false; error: MarkdownSyntaxError } {
  // BlockNote's markdown → HTML keeps `\r`, which would become a space. Web paste normalizes earlier (collab/paste.ts);
  // this is the shared entry for all markdown writes.
  const markdown = input.replace(/\r\n?/g, "\n");
  // Marker name absent from the input (case-insensitive, like HTML attribute names), so the input can't forge it.
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
  return { ok: true, html: dropNewlineAfterBreaks(markdownToHTML(markdown)) };
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => x !== null && typeof x === "object" && !Array.isArray(x);

// Copy-on-write: `fix` returns its input unchanged to mean "no change"; an untouched tree returns the same array.
export function mapBlocksCow<B>(blocks: B[], fix: (b: Rec) => Rec): B[] {
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

/** core parses empty colwidth segments to NaN, 0 or negatives; those become undefined. Copy-on-write: no change returns the same array. */
export function normalizeTableWidths<B>(blocks: B[]): B[] {
  return mapBlocksCow(blocks, b => {
    if (b.type !== "table" || !isRec(b.content) || !Array.isArray(b.content.columnWidths)) return b;
    const ws = b.content.columnWidths as unknown[];
    if (ws.every(v => v === undefined || isPositiveFinite(v))) return b;
    return { ...b, content: { ...b.content, columnWidths: ws.map(v => (isPositiveFinite(v) ? v : undefined)) } };
  });
}

const UPLOAD_PATH_RE = /^\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// core makes upload URLs absolute while parsing. Checked on the parsed URL with the same path rule as the server's copy-doc.ts.
// baseOrigin: pass new URL(document.baseURI).origin, the base of the DOM used for parsing.
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

/** When both a columns and a size rule fail, returns unsupported_columns. */
export function findStructureError(blocks: readonly unknown[], placement: MarkdownPlacement): MarkdownShapeError | null {
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
      // Unreachable (the depth check above catches it); kept to mirror the "no row inside a column" rule.
      if (inColumn) return "unsupported_columns";
      if (children.length < COLUMNS_MIN || children.length > COLUMNS_MAX) return "unsupported_columns";
      if (!children.every(c => isRec(c) && c.type === COLUMN_TYPE)) return "unsupported_columns";
    } else if (n.type === COLUMN_TYPE) {
      if (parentType !== COLUMN_LIST_TYPE) return "unsupported_columns";
      const w = props.width;
      if (typeof w !== "number" || !Number.isFinite(w) || w < COLUMN_WIDTH_MIN || w > COLUMN_WIDTH_MAX) return "unsupported_columns";
    } else if (n.type === "image" || n.type === "video") {
      if (props.previewWidth !== undefined && !isSizeValue(props.previewWidth)) size = true;
    } else if (n.type === "table" && isRec(n.content) && Array.isArray(n.content.columnWidths)) {
      if (!(n.content.columnWidths as unknown[]).every(v => v === undefined || v === null || isSizeValue(v))) size = true;
    }
    const nextInColumn = inColumn || n.type === COLUMN_TYPE;
    for (const c of children) stack.push([c, depth + 1, n.type, nextInColumn]);
  }
  return size ? "unsupported_size" : null;
}
