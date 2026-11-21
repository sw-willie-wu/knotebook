// Markdown for MCP/REST reads and the web AI (#222). `blocksToMarkdownLossy` drops all colors, so each top-level node is
// classified: block or cell colors and sized images or tables become HTML the write side accepts; column rows keep the
// canonical div lines and each column's content is classified the same way; inline-only
// colors stay markdown with `<span style>` (less HTML for weak models). Working per top-level node keeps BlockNote's
// flattening, so read → write → read is stable; with nothing to change the output is byte-identical to the lossy export.
// Uses global `document`/`Element` (server: `EditingRuntime.installGlobals()`); importing this file doesn't touch the DOM.
import { cleanHTMLToMarkdown } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMNS_OPEN_TAG, columnOpenTag, parseColumnFlex } from "./columns.js";
import { stripKnowledgeDataAttrs } from "./knowledge-html.js";
import { formatKnowledgeComment } from "./knowledge-markdown.js";
import { readKnowledgeInfo, type KnowledgeInfo } from "./knowledge.js";
import { isShownColor } from "./note-colors.js";
import { clampSizePx } from "./note-sizes.js";
import { unescapeAttributeAngles } from "./serialized-html.js";
import { escapeLinkText, lessThanOpensMarkup } from "./site-link.js";

const STYLE_CSS = { textColor: "color", backgroundColor: "background-color" } as const;
const BLOCK_COLOR_ATTRS = ["data-text-color", "data-background-color"] as const;
// Editor-only: style is an rgb copy of the canonical colors; data-level/url/start duplicate the tag, src and <ol start>,
// so dropping them still round-trips.
const NOISE_ATTRS = ["class", "classname", "style", "data-editable", "data-nesting-level", "data-inline-content-type", "target", "rel", "data-level", "data-url", "data-start"];
const INLINE_TAGS = new Set(["SPAN", "STRONG", "EM", "S", "U", "CODE", "A", "B", "I", "DEL", "MARK", "SUB", "SUP"]);
/** Unicode Po punctuation, so the converter treats them like the `<`/`>` that replace them. */
const TOKEN_OPEN = "⸀";
const TOKEN_CLOSE = "⸁";

const colorStyleType = (el: Element): keyof typeof STYLE_CSS | null => {
  if (el.tagName !== "SPAN") return null;
  const t = el.getAttribute("data-style-type");
  return t === "textColor" || t === "backgroundColor" ? t : null;
};
/** File blocks export as links and HTML can't restore them, so their background color is dropped. */
const isFileBlock = (el: Element): boolean => el.hasAttribute("data-url") && (el.tagName === "A" || el.tagName === "DIV");
const isDisplayableColor = (v: string | null): v is string => v !== null && isShownColor(v);
/** The parser drops empty `<p>`, so a color on an empty block can't round-trip; empty table cells are kept. */
const hasContent = (el: Element): boolean => el.matches("td,th") || (el.textContent ?? "").trim() !== "" || el.matches("img,video,audio,table") || el.querySelector("img,video,audio,table") !== null;
const blockColorShown = (el: Element, a: (typeof BLOCK_COLOR_ATTRS)[number]): boolean => !isFileBlock(el) && isDisplayableColor(el.getAttribute(a)) && hasContent(el);

const elementsOf = (root: Element): Element[] => [root, ...Array.from(root.querySelectorAll("*"))];
const hasBlockColor = (root: Element): boolean => elementsOf(root).some(el => !colorStyleType(el) && BLOCK_COLOR_ATTRS.some(a => blockColorShown(el, a)));
const colorSpans = (root: Element): Element[] => elementsOf(root).filter(el => colorStyleType(el) && isDisplayableColor(el.getAttribute("data-value")));

// Rows with data-nesting-level (indented under a paragraph) are invalid and flatten like ordinary nodes.
const isRow = (el: Element): boolean => el.matches("div[data-kb-columns]") && !el.hasAttribute("data-nesting-level");
/** The exact width is `data-preview-width` (on the `img`, or on the `figure` when captioned); `width` is truncated. */
function imageWidth(el: Element): number | null {
  if (el.tagName !== "IMG" || el.closest("td,th")) return null;
  const fig = el.parentElement?.tagName === "FIGURE" ? el.parentElement : null;
  const src = el.getAttribute("data-preview-width") ?? fig?.getAttribute("data-preview-width") ?? el.getAttribute("width");
  return src === null ? null : clampSizePx(Number(src));
}
// Unparseable segments (empty, NaN, <= 0) become "" so the commas and segment count survive (merged cells: "120,", ",").
const clampColwidth = (v: string): string => v.split(",").map(s => String(clampSizePx(Number(s)) ?? "")).join(",");
/** Core emits `colwidth=","` on merged cells without a width, so the attribute alone doesn't count. */
const isSizedTable = (el: Element): boolean =>
  el.tagName === "TABLE" &&
  Array.from((el as HTMLTableElement).rows[0]?.cells ?? []).some(c => (c.getAttribute("colwidth") ?? "").split(",").some(s => clampSizePx(Number(s)) !== null));
const hasSizes = (root: Element): boolean => elementsOf(root).some(el => imageWidth(el) !== null || isSizedTable(el));

function normalizeSizes(box: Element): void {
  for (const table of Array.from(box.querySelectorAll("table"))) {
    const sized = isSizedTable(table);
    Array.from(table.rows).forEach((tr, i) => {
      for (const cell of Array.from(tr.cells)) {
        const v = cell.getAttribute("colwidth");
        if (v === null) continue;
        if (sized && i > 0) cell.removeAttribute("colwidth");
        else cell.setAttribute("colwidth", clampColwidth(v));
      }
    });
  }
  for (const img of Array.from(box.querySelectorAll("img"))) {
    const w = imageWidth(img);
    if (w === null) continue;
    const fig = img.parentElement?.tagName === "FIGURE" ? img.parentElement : null;
    const cap = fig ? Array.from(fig.children).find(c => c.tagName === "FIGCAPTION") : undefined;
    const figure = document.createElement("figure");
    const bg = [img, fig].map(e => e?.getAttribute("data-background-color") ?? null).find(isDisplayableColor);
    if (bg) figure.setAttribute("data-background-color", bg);
    const out = document.createElement("img");
    const alt = img.getAttribute("alt") ?? "";
    if (alt !== "" && alt !== cap?.textContent) out.setAttribute("alt", alt);
    out.setAttribute("src", img.getAttribute("src") ?? "");
    out.setAttribute("width", String(w));
    figure.append(out);
    if (cap) {
      const fc = document.createElement("figcaption");
      fc.append(...Array.from(cap.childNodes));
      figure.append(fc);
    }
    (fig ?? img).replaceWith(figure);
  }
}

function rewrite(box: Element): void {
  normalizeSizes(box);
  for (const el of Array.from(box.querySelectorAll("*"))) {
    if (el.matches("div[data-kb-columns],div[data-kb-column]")) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const st = colorStyleType(el);
    if (st) {
      const v = el.getAttribute("data-value");
      if (!isDisplayableColor(v)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
      el.setAttribute("style", `${STYLE_CSS[st]}:${v}`);
      continue;
    }
    for (const a of BLOCK_COLOR_ATTRS) if (el.hasAttribute(a) && !blockColorShown(el, a)) el.removeAttribute(a);
    for (const a of NOISE_ATTRS) el.removeAttribute(a);
    for (const a of ["colspan", "rowspan"]) if (el.getAttribute(a) === "1") el.removeAttribute(a);
    if (el.tagName === "COLGROUP") el.remove();
    if (el.tagName === "TBODY") el.replaceWith(...Array.from(el.childNodes));
    if (el.tagName === "P" && (el.parentElement?.tagName === "TD" || el.parentElement?.tagName === "TH") && el.parentElement.childNodes.length === 1) el.replaceWith(...Array.from(el.childNodes));
  }
  for (const outer of Array.from(box.querySelectorAll("span")).filter(e => e.getAttribute("style")?.startsWith("color:"))) {
    const inner = outer.firstChild;
    if (
      outer.childNodes.length === 1 &&
      inner instanceof Element &&
      inner.tagName === "SPAN" &&
      inner.attributes.length === 1 &&
      inner.getAttribute("style")?.startsWith("background-color:")
    ) {
      outer.setAttribute("style", `${outer.getAttribute("style")};${inner.getAttribute("style")}`);
      inner.replaceWith(...Array.from(inner.childNodes));
    }
  }
}

/** Markdown HTML blocks end at a blank line, so newlines (only inside `<pre>`) become `&#10;`. Boxed because the node itself may be replaced. */
function toBlockHTML(root: Element): string {
  const box = document.createElement("div");
  box.append(root);
  rewrite(box);
  return unescapeAttributeAngles(box.innerHTML).replace(/\n/g, "&#10;");
}

// Color spans are innermost (`<strong><span>b</span></strong>`); swapped in place, the closing `**` of `**<span>b</span>**`
// wouldn't flank. So placeholders go outside the outermost inline element wrapping only that run: `<span …>**b**</span>`.
function tokenizeInlineColors(root: Element, tokens: Map<string, string>): void {
  const done = new Set<Element>();
  for (const span of colorSpans(root)) {
    if (done.has(span)) continue;
    let top: Element = span;
    while (top !== root && top.parentElement && top.parentElement !== root && INLINE_TAGS.has(top.parentElement.tagName) && top.parentElement.childNodes.length === 1) top = top.parentElement;
    const inner = elementsOf(top).filter(el => colorStyleType(el));
    const css: string[] = [];
    for (const st of ["textColor", "backgroundColor"] as const) {
      const v = inner.find(el => colorStyleType(el) === st && isDisplayableColor(el.getAttribute("data-value")))?.getAttribute("data-value");
      if (v) css.push(`${STYLE_CSS[st]}:${v}`);
    }
    const open = `${TOKEN_OPEN}${tokens.size}${TOKEN_CLOSE}`;
    tokens.set(open, `<span style="${css.join(";")}">`);
    const close = `${TOKEN_OPEN}${tokens.size}${TOKEN_CLOSE}`;
    tokens.set(close, "</span>");
    top.before(document.createTextNode(open));
    top.after(document.createTextNode(close));
    for (const el of inner) {
      done.add(el);
      el.replaceWith(...Array.from(el.childNodes));
    }
  }
}

// BlockNote's HTML → markdown never escapes text, so `[\[Draft\] …]` wouldn't round-trip (#269). Markdown branch only:
// raw HTML blocks aren't unescaped on write, so each round-trip would add a backslash. Run after tokenizeInlineColors
// (its placeholder chars aren't in the escape set).
function escapeNoteLinkText(root: Node): boolean {
  let changed = false;
  const visit = (n: Node, inLink: boolean): void => {
    if (n.nodeType === 3) {
      if (!inLink) return;
      const next = escapeLinkText(n.nodeValue ?? "");
      if (next !== n.nodeValue) {
        n.nodeValue = next;
        changed = true;
      }
      return;
    }
    const here = inLink || (n.nodeType === 1 && (n as Element).tagName === "A" && ((n as Element).getAttribute("href") ?? "").startsWith("/notes/"));
    for (const c of Array.from(n.childNodes)) visit(c, here);
  };
  visit(root, false);
  return changed;
}

const EMPHASIS_TAGS = new Set(["STRONG", "B", "EM", "I", "S", "DEL"]);
const passThrough = (n: Node): boolean => n.nodeType === 1 && (EMPHASIS_TAGS.has((n as Element).tagName) || colorStyleType(n as Element) !== null);
function edgeText(el: Element, first: boolean): Text | null {
  let n = first ? el.firstChild : el.lastChild;
  while (n !== null && passThrough(n)) n = first ? n.firstChild : n.lastChild;
  return n !== null && n.nodeType === 3 ? (n as Text) : null;
}
// `<strong> b</strong>` becomes `** b**`, which the parser doesn't read as emphasis. Moving the whitespace outside
// only loses its styling (strikethrough and background no longer cover it).
function hoistEmphasisWhitespace(root: ParentNode): boolean {
  let changed = false;
  for (const el of Array.from(root.querySelectorAll("strong,b,em,i,s,del"))) {
    for (const first of [true, false]) {
      const t = edgeText(el, first);
      // #398: count instead of `/[ \t]+$/`, which is quadratic on long whitespace runs.
      const ws0 = t === null ? 0 : edgeBlankLength(t.data, first);
      if (t === null || ws0 === 0) continue;
      const wsText = first ? t.data.slice(0, ws0) : t.data.slice(t.data.length - ws0);
      t.data = first ? t.data.slice(ws0) : t.data.slice(0, t.data.length - ws0);
      const ws = document.createTextNode(wsText);
      if (first) el.before(ws);
      else el.after(ws);
      changed = true;
    }
  }
  return changed;
}

function edgeBlankLength(s: string, first: boolean): number {
  const blank = (c: number) => c === 32 || c === 9;
  let n = 0;
  if (first) while (n < s.length && blank(s.charCodeAt(n))) n++;
  else while (n < s.length && blank(s.charCodeAt(s.length - 1 - n))) n++;
  return n;
}

// Run after hoistEmphasisWhitespace: whitespace at the start of a styled run is then already a sibling of the `<br>`.
// A following inline element (code, link, colored span) doesn't count: the whitespace sits inside it and round-trips as is.
// External HTML puts `<br>` outside style elements, so there's no need to look inside them.
function spacedAfter(br: Element): boolean {
  const next = br.nextSibling;
  return next !== null && next.nodeType === 3 && /^[ \t]/.test(next.nodeValue ?? "");
}
// After a `\` break, a line starting with `- `, `1. `, `# `, `> `, `|`, `<div>` etc. would start a new block. Any ASCII
// punctuation matches on purpose: broader, but steadier than mirroring the parser's block rules.
function blockishAfter(br: Element): boolean {
  const next = br.nextSibling;
  return next !== null && next.nodeType === 3 && /^(?:[!-/:-@[-`{-~]|\d+[.)])/.test(next.nodeValue ?? "");
}

// Breaks that can't round-trip as `\` become inline `<br>` (#386): whitespace after the break (the parser strips it),
// breaks in list items, cells and headings (the parser rejects `\` there), and block-like next lines. A placeholder
// stands in because the converter escapes `<`. External HTML never puts `<br>` inside `<code>`/`<pre>` (inline code splits
// at a break; code blocks use a newline character), so no exclusion is needed.
// `<br> L2` keeps the space because dropNewlineAfterBreaks in note-markdown-write.ts removes only the `\n`.
function tokenizeInlineBreaks(root: ParentNode, placeholder: string): number {
  let n = 0;
  for (const br of Array.from(root.querySelectorAll("br"))) {
    const atEdge = br.previousSibling === null || br.nextSibling === null; // the converter drops a `\` break at a paragraph edge
    if (!atEdge && !br.closest("li,td,th,h1,h2,h3,h4,h5,h6") && !spacedAfter(br) && !blockishAfter(br)) continue;
    br.replaceWith(document.createTextNode(placeholder));
    n += 1;
  }
  return n;
}
// Must not occur anywhere in the HTML or text, because breaks are restored by replacing across the whole markdown.
// Repeated to the length of `<br>` because the converter pads table columns by character count.
// Private-use chars because the converter keeps them verbatim; null (all in use) means breaks aren't rewritten.
function uniquePlaceholder(haystack: string): string | null {
  for (let cp = 0xe000; cp <= 0xf8ff; cp += 1) {
    const c = String.fromCharCode(cp);
    if (!haystack.includes(c)) return c.repeat("<br>".length);
  }
  return null;
}
/** Backslash escapes BlockNote's parser accepts; `<` is added by our `@blocknote/core` patch. */
const MD_ESCAPABLE = "\\`*_{}[]()#+-.!~|><";
// The converter escapes nothing. `_` only when not intraword (the parser's rule, so `snake_case` stays); `~` only next
// to `~` or at the ends; `\` only before an escapable char or at the end; `<` only if it may open markup. `&` never:
// the parser keeps entities as text (#379).
function escapeMarkdownText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const prev = i > 0 ? s[i - 1] : undefined;
    const next = i + 1 < s.length ? s[i + 1] : undefined;
    let esc = false;
    if (c === "*" || c === "`" || c === "[" || c === "]") esc = true;
    else if (c === "_") esc = !(prev !== undefined && next !== undefined && /\w/.test(prev) && /\w/.test(next));
    else if (c === "~") esc = prev === undefined || next === undefined || prev === "~" || next === "~";
    else if (c === "<") esc = lessThanOpensMarkup(next);
    else if (c === "\\") esc = next === undefined || MD_ESCAPABLE.includes(next);
    out += esc ? `\\${c}` : c;
  }
  return out;
}
const MD_TEXT_BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
// Skips code/pre (output verbatim), site-link text (escapeNoteLinkText escapes it; don't escape twice), and figure
// text or text outside MD_TEXT_BLOCKS (the converter doesn't treat it as markdown inline text).
function escapeTextNodes(root: ParentNode): boolean {
  let changed = false;
  const walker = document.createTreeWalker(root as Node, 0x4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el === null || el.closest("pre,code,figure,figcaption") || el.closest('a[href^="/notes/"]') || !el.closest(MD_TEXT_BLOCKS)) continue;
    const t = n as Text;
    const next = escapeMarkdownText(t.data);
    if (next !== t.data) {
      t.data = next;
      changed = true;
    }
  }
  return changed;
}

// Only the block markers BlockNote's parser recognizes. `|$` because the next text node may begin with whitespace.
// A list item's child paragraphs are parsed as blocks and get escaped; the item's own inline content doesn't.
// `*`, `_`, backtick, `~` and `<` are absent: escapeMarkdownText already escapes them.
const BLOCK_MARK = /^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$)|-\s*-\s*-[-\s]*$)/;
const ORDERED_NUM = /^\d+(?=[.)](?:\s|$))/;
const isItemInline = (b: Element): boolean =>
  b.closest("td,th,summary") !== null || (b.parentElement?.tagName === "LI" && b.parentElement.querySelector(":scope > p") === b);
/** The parser strips a trailing ` #…` from headings. */
const HEADING_TAIL = /[ \t](#+)[ \t]*$/;
function escapeBlockStarts(root: ParentNode): boolean {
  let changed = false;
  const blocks = [...(root instanceof Element ? [root] : []), ...Array.from(root.querySelectorAll("p,blockquote,h1,h2,h3,h4,h5,h6"))];
  for (const b of blocks) {
    if (/^H[1-6]$/.test(b.tagName)) {
      const last = b.lastChild;
      if (last !== null && last.nodeType === 3) {
        const t = last as Text;
        const m = HEADING_TAIL.exec(t.data);
        if (m) {
          const at = m.index + m[0].indexOf("#");
          t.data = `${t.data.slice(0, at)}\\${t.data.slice(at)}`;
          changed = true;
        }
      }
      continue;
    }
    if (!b.matches("p,blockquote") || isItemInline(b)) continue;
    const first = b.firstChild;
    if (first === null || first.nodeType !== 3) continue;
    const t = first as Text;
    // After leading whitespace (the converter strips it); for ordered lists after the digits, since `\1` isn't an escape.
    const lead = /^\s*/.exec(t.data)![0].length;
    const rest = t.data.slice(lead);
    const num = ORDERED_NUM.exec(rest);
    if (num === null && !BLOCK_MARK.test(rest)) continue;
    const at = lead + (num?.[0].length ?? 0);
    t.data = `${t.data.slice(0, at)}\\${t.data.slice(at)}`;
    changed = true;
  }
  return changed;
}
/** Order matters: breaks are judged on the hoisted text, and escaping, which doesn't affect leading whitespace, comes last. */
function prepareForMarkdown(root: ParentNode, ctx: Ctx): boolean {
  const hoisted = hoistEmphasisWhitespace(root);
  const n = ctx.brToken === null ? 0 : tokenizeInlineBreaks(root, ctx.brToken);
  ctx.breaks += n;
  const escaped = escapeTextNodes(root);
  const starts = escapeBlockStarts(root);
  return hoisted || n > 0 || escaped || starts;
}

type Kind = "row" | "block" | "inline" | "none";
const kindOf = (n: Node): Kind => {
  if (n.nodeType !== 1) return "none";
  const el = n as Element;
  if (isRow(el)) return "row";
  if (hasBlockColor(el) || hasSizes(el)) return "block";
  return colorSpans(el).length > 0 ? "inline" : "none";
};
type Ctx = { tokens: Map<string, string>; inlineOk: boolean; brToken: string | null; breaks: number };

function serializeNodes(nodes: Node[], ctx: Ctx): string {
  const kinds = nodes.map(kindOf);
  const parts: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const box = document.createElement("div");
    box.append(...run);
    parts.push(cleanHTMLToMarkdown(box.innerHTML));
    run = [];
  };
  nodes.forEach((n, i) => {
    if (kinds[i] === "row") {
      flush();
      parts.push(rowMarkdown(n as Element, ctx));
      return;
    }
    if (kinds[i] === "block" || (kinds[i] === "inline" && !ctx.inlineOk)) {
      flush();
      parts.push(toBlockHTML(n as Element));
      return;
    }
    prepareForMarkdown(n as Element, ctx);
    if (kinds[i] === "inline") tokenizeInlineColors(n as Element, ctx.tokens);
    escapeNoteLinkText(n);
    run.push(n);
  });
  flush();
  // #398: count instead of `/\n+$/`, which is quadratic on long newline runs.
  return parts
    .map(p => {
      let end = p.length;
      while (end > 0 && p.charCodeAt(end - 1) === 10) end--;
      return p.slice(0, end);
    })
    .filter(p => p !== "")
    .join("\n\n");
}

function rowMarkdown(row: Element, ctx: Ctx): string {
  const lines = [COLUMNS_OPEN_TAG];
  for (const col of Array.from(row.children).filter(c => c.matches("div[data-kb-column]"))) {
    lines.push(columnOpenTag(parseColumnFlex(col.getAttribute("style"))), "");
    const inner = serializeNodes(Array.from(col.childNodes), ctx);
    if (inner !== "") lines.push(inner, "");
    lines.push("</div>");
  }
  lines.push("</div>");
  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic params; same as notes/editing/session.ts
type AnyEditor = BlockNoteEditor<any, any, any>;
type Blocks = Parameters<AnyEditor["blocksToHTMLLossy"]>[0];

function convertBlocks(editor: AnyEditor, blocks: Blocks): string {
  const raw = editor.blocksToHTMLLossy(blocks);
  const tpl = document.createElement("template");
  tpl.innerHTML = raw;
  // Comments are the only way knowledge reaches markdown, so whatever the exported HTML carries is dropped no matter how the schema exports it.
  const html = /data-knowledge-/i.test(raw) && stripKnowledgeDataAttrs(tpl.content) ? tpl.innerHTML : raw;
  const text = tpl.content.textContent ?? "";
  // Placeholder chars already in the text: fall back to HTML for inline colors rather than risk a wrong replace.
  const inlineOk = !text.includes(TOKEN_OPEN) && !text.includes(TOKEN_CLOSE);
  const ctx: Ctx = { tokens: new Map(), inlineOk, brToken: uniquePlaceholder(html + text), breaks: 0 };
  const restoreBreaks = (md: string): string => (ctx.breaks === 0 || ctx.brToken === null ? md : md.split(ctx.brToken).join("<br>"));
  const nodes = Array.from(tpl.content.childNodes);
  if (nodes.every(n => kindOf(n) === "none")) {
    const prepared = prepareForMarkdown(tpl.content, ctx);
    const escaped = escapeNoteLinkText(tpl.content);
    return restoreBreaks(cleanHTMLToMarkdown(prepared || escaped ? tpl.innerHTML : html));
  }
  const md = restoreBreaks(serializeNodes(nodes, ctx) + "\n");
  return ctx.tokens.size === 0 ? md : md.replace(new RegExp(`${TOKEN_OPEN}\\d+${TOKEN_CLOSE}`, "g"), t => ctx.tokens.get(t) ?? t);
}

/** Private-use characters from the top down, away from the bottom-up ones `uniquePlaceholder` takes; null when all are in use. */
function freeMarkerChar(haystack: string): string | null {
  for (let cp = 0xf8ff; cp >= 0xe000; cp -= 1) {
    const c = String.fromCharCode(cp);
    if (!haystack.includes(c)) return c;
  }
  return null;
}

export interface NoteMarkdownOptions {
  /** Write a knowledge comment under each top-level knowledge heading in `blocks`. */
  knowledge?: boolean;
}

const propsOf = (b: { props?: unknown }): Record<string, unknown> | undefined => b.props as Record<string, unknown> | undefined;

// A placeholder paragraph becomes the heading's first child so it lands right after the heading line (inside a toggleable
// heading's <details> it follows the <summary>). It is swapped for the comment only after every other placeholder is
// restored, so nothing a comment holds can be mistaken for one.
export function blocksToNoteMarkdown(editor: AnyEditor, blocks: Blocks, opts?: NoteMarkdownOptions): string {
  if (!opts?.knowledge) return convertBlocks(editor, blocks);
  const source = blocks ?? editor.document;
  const isKnowledge = (b: { type?: string; props?: unknown }): boolean => b.type === "heading" && readKnowledgeInfo(propsOf(b)) !== null;
  const mark = source.some(isKnowledge) ? freeMarkerChar(JSON.stringify(source)) : null;
  if (mark === null) return convertBlocks(editor, blocks);
  const infos: KnowledgeInfo[] = [];
  const withTokens = source.map(b => {
    const info = b.type === "heading" ? readKnowledgeInfo(propsOf(b)) : null;
    if (info === null) return b;
    infos.push(info);
    return { ...b, children: [{ type: "paragraph", content: `${mark}${infos.length - 1}${mark}` }, ...(b.children ?? [])] };
  }) as Blocks;
  const md = convertBlocks(editor, withTokens);
  const injected = md.replace(new RegExp(`\n\n${mark}(\\d+)${mark}`, "g"), (_m, i: string) => `\n${formatKnowledgeComment(infos[Number(i)]!)}`);
  // A colored toggleable heading goes out as one raw HTML block that carries the placeholder inside it.
  let lost = 0;
  const out = injected.replace(new RegExp(`(?:<p>)?${mark}\\d+${mark}(?:</p>)?`, "g"), () => {
    lost += 1;
    return "";
  });
  if (lost > 0) console.warn(`${lost} knowledge comment(s) dropped: the heading has no markdown form`);
  return out;
}
