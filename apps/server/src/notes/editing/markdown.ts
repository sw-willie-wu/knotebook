import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  BLOCK_PRECHECK_MIN_CHARS,
  KNOWLEDGE_ATTR_IN_TAG,
  MAX_HTML_DEPTH,
  PLAINTEXT_TAG,
  applyKnowledgeComments,
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findParseGuardFailure,
  findStrayKnowledgeProps,
  findStructureError,
  htmlDepth,
  isBlankParseResult,
  normalizeNoteColors,
  normalizeTableWidths,
  plainParagraphFloor,
  premergeParagraphs,
  premergedHtml,
  rebindWikilinks,
  restoreKnowledgeProps,
  relativizeSiteUploads,
  restoreFenceBlocks,
  syntaxCheckRoot,
  targetFromList,
  topLevelBlockFloor,
  type KnowledgeIgnoredItem,
  type KnowledgeProblem,
  type KnowledgeProps,
} from "@knotebook/shared";
import type { VisibleNoteTarget } from "./candidates.js";

export const MAX_BLOCKS = 2000;
export type ParseError = "unsupported_block" | "unsupported_color" | "unsupported_columns" | "unsupported_size" | "empty_content" | "too_many_blocks" | "invalid_knowledge";
/** Causes beyond the error code, used only to pick HTTP file write-back messages, except `too_complex`, which MCP and REST edit messages also read. `too_deep`: HTML or quote nesting beyond `MAX_HTML_DEPTH` (4). `too_complex` is decided by the worker pool (`parse-pool.ts`), not returned by this function. */
export type ParseDetail = "event_attr" | "editor_internal" | "unknown_block" | "dropped_element" | "unclosed_comment" | "nested_paragraph" | "too_deep" | "too_complex" | "knowledge_attr";
/** `knowledge` names the heading and the reason when `error` is `invalid_knowledge`. */
export type ParseFailure = { error: ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem };
/**
 * Elements the parser drops along with their content: rejected anywhere rather than silently removed. Detected on the DOM, so a `<script>` inside an HTML comment or escaped in code doesn't count. `<embed>` isn't listed: it parses to a file block. Single source for the selector and the prefilter.
 */
export const DROPPED_TAGS = ["script", "style", "iframe", "object", "noscript", "title", "template"] as const;
export const DROPPED_SELECTOR = DROPPED_TAGS.join(", ");
/** Prefilter: DOM elements always come from a start tag in the string, so no `<name` means no DOM is needed (entities can't create elements). Matches any case; false hits like `<script-x>` are left to the DOM. */
const DROPPED_PREFILTER = new RegExp(`<(?:${DROPPED_TAGS.join("|")})\\b`, "i");
export function hasDroppedElement(html: string): boolean {
  return DROPPED_PREFILTER.test(html) && syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
}
const UNCLOSED_COMMENT = /<!--(?![\s\S]*?-->)/;

export { BLOCK_PRECHECK_MIN_CHARS, MAX_HTML_DEPTH, htmlDepth, plainParagraphFloor, premergeParagraphs, topLevelBlockFloor };

export interface ParsedMarkdown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
  blocks: PartialBlock<any, any, any>[];
  unbound: number;
  /** Knowledge comments that sit where a heading's comment can't (not right under a top-level heading), left out of the blocks. */
  ignoredKnowledgeComments: number;
  /** Lines of knowledge comments whose key is unknown; the rest of each comment was applied. */
  ignoredKnowledge: KnowledgeIgnoredItem[];
}

export function siteOriginOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

// Pure, no DB. In-site links are matched against a list prefetched before the lease; redirect/prev_slug/legacy slug forms aren't resolved and stay ordinary links. An in-site link that can't be converted doesn't count as unbound. Wikilinks bind only on a unique hit. Unknown block types and off-palette colors reject the whole write rather than being stripped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
export function parseMarkdownForNote(editor: BlockNoteEditor<any, any, any>, markdown: string, candidates: readonly VisibleNoteTarget[], siteOrigin: string): ParsedMarkdown | ParseFailure {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  type AnyPartialBlock = PartialBlock<any, any, any>;
  if (plainParagraphFloor(markdown) > MAX_BLOCKS) return { error: "too_many_blocks" };
  // No string estimate before the syntax check: it's quadratic and wrongly blocked `<T>` in code blocks; deep nesting is bounded by the worker's time and stack limits (→ `too_complex`).
  const syntax = checkNoteMarkdownSyntax(markdown, "top");
  // The shared syntax check returns unsupported_block only for event attributes.
  if (!syntax.ok) return syntax.error === "unsupported_block" ? { error: syntax.error, detail: "event_attr" } : { error: syntax.error };
  // The premerge edits the shared DOM in place, so it goes last.
  const root = syntaxCheckRoot(syntax.html);
  if (DROPPED_PREFILTER.test(syntax.html) && root.querySelector(DROPPED_SELECTOR) !== null) return { error: "unsupported_block", detail: "dropped_element" };
  const guard = findParseGuardFailure(root);
  if (guard !== null) return { error: "unsupported_block", detail: guard };
  if (markdown.length >= BLOCK_PRECHECK_MIN_CHARS && topLevelBlockFloor(root) > MAX_BLOCKS) return { error: "too_many_blocks" };
  // After `<plaintext>` the DOM can't be serialized back, so it can't be edited: knowledge attributes are refused outright and comments are plain text there.
  let html = syntax.html;
  let assigned: ReadonlySet<string> = new Set();
  let written: readonly KnowledgeProps[] = [];
  let ignoredKnowledgeComments = 0;
  let ignoredKnowledge: KnowledgeIgnoredItem[] = [];
  if (PLAINTEXT_TAG.test(html)) {
    if (KNOWLEDGE_ATTR_IN_TAG.test(html)) return { error: "unsupported_block", detail: "knowledge_attr" };
    ignoredKnowledgeComments = html.match(/<!--\s*knotebook:knowledge(?=\s|$)/gi)?.length ?? 0;
  } else {
    const knowledge = applyKnowledgeComments(root, "top", html);
    if ("error" in knowledge) return { error: "invalid_knowledge", knowledge: knowledge.error };
    ({ assigned, props: written, ignored: ignoredKnowledgeComments, unknownKeys: ignoredKnowledge } = knowledge);
    // The premerge below returns its input when nothing merges, so DOM edits have to be serialized first.
    if (knowledge.changed) html = root.innerHTML;
  }
  let raw: AnyPartialBlock[];
  try {
    // BlockNote's own merge of multi-paragraph quotes, headings and summaries is quadratic.
    html = premergedHtml(html, root);
    raw = editor.tryParseHTMLToBlocks(html) as AnyPartialBlock[];
  } catch (err) {
    // core throws on some editor-internal forms: reject as unstorable, not 500. Log only the class and call frames, never the message (PM errors splice content into it) or the markdown. No injected logger here, so console.warn like `version-fingerprint.ts`. Drop the message lines before picking frames so message lines starting with "    at " can't leak in.
    const frames =
      err instanceof Error
        ? (err.stack ?? "").split("\n").slice(err.message.split("\n").length).filter(l => /^\s+at /.test(l))
        : [];
    const e = { name: err instanceof Error ? err.name : typeof err, frames };
    console.warn("parseMarkdownForNote: core parse threw; rejected as unsupported_block", e);
    return { error: "unsupported_block", detail: "editor_internal" };
  }
  // Restore first: parsing normalizes CR in attribute values, so the comment's id only matches `assigned` once put back.
  if (!restoreKnowledgeProps(raw, written) || findStrayKnowledgeProps(raw, assigned)) return { error: "unsupported_block", detail: "knowledge_attr" };
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreFenceBlocks(raw)), new URL(document.baseURI).origin);
  const known = new Set(Object.keys(editor.schema.blockSchema));
  const walk = (bs: AnyPartialBlock[]): boolean => bs.every(b => known.has(b.type as string) && (!b.children || walk(b.children as AnyPartialBlock[])));
  if (!walk(parsed)) return { error: "unsupported_block", detail: "unknown_block" };
  const shape = findStructureError(parsed, "top");
  if (shape !== null) return { error: shape };
  // Accepts built-in color names and hex codes, normalized in place to lowercase #rrggbb; anything else rejects the write.
  if (normalizeNoteColors(parsed) !== null) return { error: "unsupported_color" };
  if (isBlankParseResult(parsed)) {
    return UNCLOSED_COMMENT.test(markdown) ? { error: "empty_content", detail: "unclosed_comment" } : { error: "empty_content" };
  }
  const count = (bs: AnyPartialBlock[]): number => bs.reduce((n, b) => n + 1 + (b.children ? count(b.children as AnyPartialBlock[]) : 0), 0);
  if (count(parsed) > MAX_BLOCKS) return { error: "too_many_blocks" };
  const [rebound, unbound] = rebindWikilinks(parsed, [...candidates], type => editor.schema.blockSchema[type]?.content === "inline");
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, candidates) ?? null, siteOrigin);
  return { blocks, unbound, ignoredKnowledgeComments, ignoredKnowledge };
}
