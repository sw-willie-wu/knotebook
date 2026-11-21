// Write side of the knowledge comments, on the HTML that markdown parsing produced.
// Operates on the DOM it is given; importing this file doesn't touch the DOM.
import { isKnowledgeCommentData, parseKnowledgeComment, type KnowledgeCommentFields, type KnowledgeProblem } from "./knowledge-markdown.js";
import { EMPTY_KNOWLEDGE_PROPS, KNOWLEDGE_PROP_NAMES, type KnowledgePropName } from "./knowledge-schema.js";
import type { MarkdownPlacement } from "./note-markdown-write.js";

export type KnowledgeProps = Record<KnowledgePropName, string>;

const kebab = (name: string): string => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
const dataAttrOf = (name: KnowledgePropName): string => `data-${kebab(name)}`;

/** `data-knowledge-id` … `data-knowledge-superseded-by`: how BlockNote writes the knowledge props into HTML. */
export const KNOWLEDGE_DATA_ATTRS: readonly string[] = KNOWLEDGE_PROP_NAMES.map(dataAttrOf);

const KNOWLEDGE_ATTR_PREFIX = "data-knowledge-";

/** Removes every `data-knowledge-*` attribute under `root` (and on `root` itself when it is an element). True when any was removed. */
export function stripKnowledgeDataAttrs(root: ParentNode): boolean {
  let removed = false;
  const strip = (el: Element): void => {
    for (const name of el.getAttributeNames()) {
      // Case-insensitive: the parser lowercases names, but a hand-built DOM may not.
      if (name.toLowerCase().startsWith(KNOWLEDGE_ATTR_PREFIX)) {
        el.removeAttribute(name);
        removed = true;
      }
    }
  };
  if ((root as Node).nodeType === 1) strip(root as Element);
  for (const el of Array.from(root.querySelectorAll("*"))) strip(el);
  return removed;
}

/** The id of a comment that left out its `id` line; resolved in the write step and never stored (it doesn't match `KNOWLEDGE_ID_RE`). */
export const KNOWLEDGE_PENDING_ID_PREFIX = "k_new:";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const SHOW_COMMENT = 0x80;
const HEADING_TAG = /^H[1-6]$/;
const NON_BLANK = /[^\t\n\f\r ]/;
const QUICK_CHECK = /data-knowledge|knotebook:knowledge/i;

/** The heading a comment sits under: the nearest element before it, with only blank text and other comments between. */
function headingBefore(comment: Comment, root: Element, placement: MarkdownPlacement): Element | null {
  if (placement !== "top" || comment.parentNode !== root) return null;
  for (let n = comment.previousSibling; n !== null; n = n.previousSibling) {
    if (n.nodeType === COMMENT_NODE) continue;
    if (n.nodeType === TEXT_NODE) {
      if (NON_BLANK.test((n as Text).data)) return null;
      continue;
    }
    return n.nodeType === ELEMENT_NODE && HEADING_TAG.test((n as Element).tagName) ? (n as Element) : null;
  }
  return null;
}

// The DOM can't tell a closed comment from one the parser ran to the end of the input, and an unclosed one would swallow
// the rest of the note. NUL is replaced while tokenizing, so the data can't be found in the source then.
function isClosedInSource(data: string, html: string): boolean {
  if (html.includes("\u0000")) return true;
  const open = `<!--${data}`;
  return html.includes(`${open}-->`) || html.includes(`${open}--!>`);
}

const FIELD_PROPS: ReadonlyArray<readonly [Exclude<keyof KnowledgeCommentFields, "id">, KnowledgePropName]> = [
  ["when", "knowledgeWhen"],
  ["conclusion", "knowledgeConclusion"],
  ["evidence", "knowledgeEvidence"],
  ["verified", "knowledgeVerified"],
  ["status", "knowledgeStatus"],
  ["supersededBy", "knowledgeSupersededBy"],
];

/**
 * Only a comment can set knowledge: every `data-knowledge-*` attribute is removed first, then each comment right under a
 * top-level heading is written onto that heading. Only the structure is checked here (the write step has the current
 * document to compare against). Comments anywhere else are left alone and counted. `html` is the markup `root` was parsed
 * from; without it an unclosed comment can't be told apart.
 */
export function applyKnowledgeComments(
  root: Element,
  placement: MarkdownPlacement,
  html?: string,
): { changed: boolean; ignored: number; assigned: ReadonlySet<string>; props: readonly KnowledgeProps[] } | { error: KnowledgeProblem } {
  const assigned = new Set<string>();
  const props: KnowledgeProps[] = [];
  if (html !== undefined && !QUICK_CHECK.test(html)) return { changed: false, ignored: 0, assigned, props };
  let changed = stripKnowledgeDataAttrs(root);
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_COMMENT);
  const mine: Array<{ comment: Comment; heading: Element; fields: KnowledgeCommentFields }> = [];
  const claimed = new Set<Element>();
  let ignored = 0;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const comment = n as Comment;
    if (!isKnowledgeCommentData(comment.data)) continue;
    const heading = headingBefore(comment, root, placement);
    if (heading === null) {
      ignored += 1;
      continue;
    }
    const fail = (problem: KnowledgeProblem["problem"], key?: KnowledgeProblem["key"]): { error: KnowledgeProblem } => ({
      error: { problem, ...(key ? { key } : {}), heading: heading.textContent ?? "" },
    });
    if (claimed.has(heading)) return fail("two_comments");
    claimed.add(heading);
    const parsed = parseKnowledgeComment(comment.data);
    if (!parsed.ok) return fail(parsed.problem, parsed.key);
    if (html !== undefined && !isClosedInSource(comment.data, html)) return fail("unclosed");
    const next = comment.nextSibling;
    if (next !== null && next.nodeType === TEXT_NODE && NON_BLANK.test((next as Text).data)) return fail("blank_line_missing");
    mine.push({ comment, heading, fields: parsed.fields });
  }
  mine.forEach(({ heading, fields }, i) => {
    const id = fields.id ?? `${KNOWLEDGE_PENDING_ID_PREFIX}${i}`;
    const written = { ...EMPTY_KNOWLEDGE_PROPS, knowledgeId: id } as KnowledgeProps;
    for (const [field, prop] of FIELD_PROPS) written[prop] = fields[field];
    for (const prop of KNOWLEDGE_PROP_NAMES) if (written[prop] !== "") heading.setAttribute(dataAttrOf(prop), written[prop]);
    assigned.add(id);
    props.push(written);
    changed = true;
  });
  return { changed, ignored, assigned, props };
}

/**
 * Serializing the DOM and parsing it again normalizes CR in attribute values, so the values the comments carried are put
 * back after parsing: the n-th top-level heading with a knowledge id is the n-th comment's heading. False when the counts
 * differ, which means something other than a comment gave a heading an id.
 */
export function restoreKnowledgeProps(blocks: readonly unknown[], props: readonly KnowledgeProps[]): boolean {
  let n = 0;
  for (const block of blocks) {
    const b = block as { type?: unknown; props?: Record<string, unknown> };
    if (b.type !== "heading" || b.props === undefined || b.props.knowledgeId === undefined || b.props.knowledgeId === "") continue;
    const next = props[n];
    if (next === undefined) return false;
    Object.assign(b.props, next);
    n += 1;
  }
  return n === props.length;
}

/**
 * True when a non-empty knowledge prop sits anywhere but on a top-level heading whose id is in `allowed`: the second line of
 * defense for whatever DOM clean-up missed. Iterative: nesting depth comes from the caller's markdown.
 */
export function findStrayKnowledgeProps(blocks: readonly unknown[], allowed: ReadonlySet<string>): boolean {
  const stack: Array<{ block: unknown; top: boolean }> = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) stack.push({ block: blocks[i], top: true });
  while (stack.length > 0) {
    const { block, top } = stack.pop()!;
    if (typeof block !== "object" || block === null) continue;
    const { type, props, children } = block as { type?: unknown; props?: unknown; children?: unknown };
    if (typeof props === "object" && props !== null) {
      const p = props as Record<string, unknown>;
      const hasKnowledge = KNOWLEDGE_PROP_NAMES.some(name => p[name] !== undefined && p[name] !== "");
      if (hasKnowledge) {
        const id = p.knowledgeId;
        if (!top || type !== "heading" || typeof id !== "string" || !allowed.has(id)) return true;
      }
    }
    if (Array.isArray(children)) for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ block: children[i], top: false });
  }
  return false;
}
