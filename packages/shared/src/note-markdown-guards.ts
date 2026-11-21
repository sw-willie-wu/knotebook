// Traverse with firstElementChild/nextElementSibling and an explicit stack: jsdom's `children` is O(children) per read,
// and nesting depth comes from user markdown. Importing this file must not touch the DOM.
// Run after checkNoteMarkdownSyntax and before tryParseHTMLToBlocks, on its syntaxCheckRoot DOM
// (shared by the server's parseMarkdownForNote and the web AI's prepareAiResult).
import { syntaxCheckRoot } from "./note-markdown-write.js";

/**
 * In element levels below the syntax-check root (its children are depth 1).
 * BlockNote re-parses the whole subtree of every nested blockquote, so depth costs time. 128 still allows ~60 nested list levels (`<ul>` + `<li>` each).
 */
export const MAX_HTML_DEPTH = 128;

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

export type ParseGuardFailure = "too_deep" | "nested_paragraph";

/** BlockNote merges nested `<p>` (reachable via `<button>`, `<marquee>`, SVG foreignObject, MathML mtext) quadratically and duplicates text. */
export function findParseGuardFailure(root: Element): ParseGuardFailure | null {
  if (htmlDepth(root) > MAX_HTML_DEPTH) return "too_deep";
  if (root.querySelector("p p") !== null) return "nested_paragraph";
  return null;
}

/** Must match where BlockNote merges all descendant `<p>`: blockquotes, headings, and the first direct `<summary>` of a `<details>`. */
const MERGE_ROOT_TAGS = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "SUMMARY"]);
const MERGE_ROOT_TAG = /<(?:blockquote|h[1-6]|summary)\b/i;
/** After `<plaintext>` everything is text, so serializing and re-parsing doesn't round-trip; premerging would change the result. */
export const PLAINTEXT_TAG = /<plaintext\b/i;
const isMergeRoot = (el: Element): boolean =>
  MERGE_ROOT_TAGS.has(el.tagName) &&
  (el.tagName !== "SUMMARY" || (el.parentElement?.tagName === "DETAILS" && el.parentElement.querySelector(":scope > summary") === el));

// BlockNote 0.52's `mergeParagraphs` is quadratic (`innerHTML +=` in a loop); merging here in one pass leaves it one `<p>`.
// Removed `<p>`s become empty comments so the whitespace text nodes around them don't join on re-parse.
// Equivalence with BlockNote's own merge is checked by the server's editing-paragraph-merge.test.ts.
// Skipped subtrees: data-content-type elements (the editor-internal form; its parse rule uses contentElement and does not merge
// paragraphs) and <figcaption> (own text extraction). Quotes inside them are left to BlockNote: possibly slow, bounded by the server worker's time limit.
// Stops at a merge root (the outer merge already takes the inner <p>s); <pre> is still walked.
// Assumes findParseGuardFailure already rejected "p p"; such content is outside the tested equivalence.
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

/** `html` is checkNoteMarkdownSyntax's output and `root` its syntaxCheckRoot. Mutates `root`; run other checks on it first. */
export function premergedHtml(html: string, root: Element): string {
  if (!MERGE_ROOT_TAG.test(html) || PLAINTEXT_TAG.test(html)) return html;
  return premergeInto(root) ? root.innerHTML : html;
}

export function premergeParagraphs(html: string): string {
  if (!MERGE_ROOT_TAG.test(html)) return html;
  return premergedHtml(html, syntaxCheckRoot(html));
}

// Lower bound on the block count (a line starting with a letter after a blank line always starts a block): past the
// limit, a full parse would be too. Fence-like input is skipped: BlockNote 0.52's `markdownToHTML` isn't CommonMark there.
// Server only (web AI has no block limit). A file that also has another error may report too_many_blocks instead.
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

/** Below this many characters a full parse is cheap, so the DOM count is skipped. */
export const BLOCK_PRECHECK_MIN_CHARS = 16 * 1024;
/** Each counted element parses to at least one block; nested ones may be merged (e.g. paragraphs in a table cell). */
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
