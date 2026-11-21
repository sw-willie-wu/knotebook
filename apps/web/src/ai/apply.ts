import type { Block, BlockNoteEditor } from "@blocknote/core";
import {
  COLUMN_BLOCK_TYPES,
  COLUMN_TYPE,
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findParseGuardFailure,
  findStructureError,
  isBlankParseResult,
  normalizeNoteColors,
  normalizeTableWidths,
  premergedHtml,
  rebindWikilinks,
  relativizeSiteUploads,
  restoreMermaidBlocks,
  syntaxCheckRoot,
  targetFromList,
  applyKnowledgeComments,
  findStrayKnowledgeProps,
  knowledgeWriteProblem,
  normalizeKnowledgeRefs,
  readKnowledgeInfo,
  resolveKnowledgeForWrite,
  restoreKnowledgeProps,
  KNOWLEDGE_ATTR_IN_TAG,
  PLAINTEXT_TAG,
  type KnowledgeBlockShape,
  type KnowledgeInfo,
  type KnowledgeProps,
  type MarkdownPlacement,
  type MarkdownSyntaxError,
  type SiteLinkCandidate,
  type WikilinkTarget,
} from "@knotebook/shared";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { verifyAnchor, type AiAnchor } from "./anchor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

export type { WikilinkTarget };
export interface ApplyDeps {
  notes: readonly SiteLinkCandidate[];
  siteOrigin?: string;
  /** "nested": the AI result must not contain columns. */
  placement: MarkdownPlacement;
  knowledge?: AiKnowledgeContext;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyBlock = Block<any, any, any>;

/** `replaced`: the top-level blocks the result will replace; `current`: the first knowledge heading of each id in the whole note. */
export interface AiKnowledgeContext {
  noteId: string;
  replaced: readonly AnyBlock[];
  current: ReadonlyMap<string, KnowledgeInfo>;
}

export function aiKnowledgeContext(editor: Pick<AnyEditor, "document" | "getBlock">, noteId: string, anchorBlockIds: readonly string[]): AiKnowledgeContext {
  const current = new Map<string, KnowledgeInfo>();
  for (const b of editor.document) {
    const info = b.type === "heading" ? readKnowledgeInfo(b.props) : null;
    if (info !== null && !current.has(info.id)) current.set(info.id, info);
  }
  const replaced = anchorBlockIds.map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
  return { noteId, replaced, current };
}

/** buildPreview and applyAiResult must use this same blocks array, so what is applied is exactly what was previewed. */
export interface PreparedResult {
  blocks: AnyBlock[];
  unboundCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
function hasColumnBlock(blocks: readonly { type?: string; children?: readonly any[] }[]): boolean {
  return blocks.some((b) => COLUMN_BLOCK_TYPES.has(b.type as string) || (b.children ? hasColumnBlock(b.children) : false));
}

// Same pipeline and order as the server's parseMarkdownForNote. Blank input returns `{ empty: true }`: it
// parses to one empty paragraph, which would otherwise replace the original text.
export function prepareAiResult(
  editor: AnyEditor,
  markdown: string,
  deps: ApplyDeps,
): PreparedResult | { empty: true } | { invalid: MarkdownSyntaxError | "unsupported_color" | "invalid_knowledge" } {
  const syntax = checkNoteMarkdownSyntax(markdown, deps.placement);
  if (!syntax.ok) return { invalid: syntax.error };
  // No block-count precheck: in-app AI has no block limit.
  const root = syntaxCheckRoot(syntax.html);
  if (findParseGuardFailure(root) !== null) return { invalid: "unsupported_block" };
  // Only a comment can set knowledge. After `<plaintext>` the DOM can't be serialized back, so there an attribute is refused and comments are plain text.
  let html = syntax.html;
  let assigned: ReadonlySet<string> = new Set();
  let written: readonly KnowledgeProps[] = [];
  if (PLAINTEXT_TAG.test(html)) {
    if (KNOWLEDGE_ATTR_IN_TAG.test(html)) return { invalid: "unsupported_block" };
  } else {
    const comments = applyKnowledgeComments(root, deps.placement, html);
    if ("error" in comments) return { invalid: "invalid_knowledge" };
    ({ assigned, props: written } = comments);
    // premergedHtml returns its input when nothing merges, so DOM edits have to be serialized first.
    if (comments.changed) html = root.innerHTML;
  }
  let raw: AnyBlock[];
  try {
    raw = editor.tryParseHTMLToBlocks(premergedHtml(html, root));
  } catch {
    // core throws on some internal editor shapes (e.g. `<div data-content-type="paragraph">`); uncaught, it would
    // land in the stream continuation and leave the box streaming.
    return { invalid: "unsupported_block" };
  }
  // Parsing normalizes CR in attribute values, so the comment's values are put back before the id check.
  if (!restoreKnowledgeProps(raw, written) || findStrayKnowledgeProps(raw, assigned)) return { invalid: "unsupported_block" };
  // The parsing DOM's base, not deps.siteOrigin (that one is only for site-link checks).
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const shape = findStructureError(parsed, deps.placement);
  if (shape !== null) return { invalid: shape };
  // Unsupported colors reject the whole result: the editor wouldn't display them, so they must not be stored silently.
  if (normalizeNoteColors(parsed) !== null) return { invalid: "unsupported_color" };
  if (isBlankParseResult(parsed)) return { empty: true };
  const [rebound, unboundCount] = rebindWikilinks(
    parsed,
    [...deps.notes],
    (type) => editor.schema.blockSchema[type]?.content === "inline",
  );
  // Resolved only from the loaded notes cache, with no fallback lookup.
  const [linked] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, deps.notes) ?? null, deps.siteOrigin ?? window.location.origin);
  const blocks = deps.placement === "top" ? resolveKnowledge(linked, written.length > 0, deps.knowledge) : linked;
  if (blocks === null) return { invalid: "invalid_knowledge" };
  return { blocks, unboundCount };
}

// Same steps as the server's write path. Skipped when the result sets no knowledge and nothing in the replaced range had any, so such a selection is written exactly as before.
function resolveKnowledge(blocks: AnyBlock[], hasComments: boolean, context: AiKnowledgeContext | undefined): AnyBlock[] | null {
  const replaced = context?.replaced ?? [];
  if (!hasComments && !replaced.some((b) => b.type === "heading" && readKnowledgeInfo(b.props) !== null)) return blocks;
  const shaped = blocks as unknown as readonly KnowledgeBlockShape[];
  const resolved = resolveKnowledgeForWrite({
    before: replaced as unknown as readonly KnowledgeBlockShape[],
    after: context === undefined ? shaped : normalizeKnowledgeRefs(shaped, context.noteId),
    keep: context !== undefined,
    taken: new Set(context?.current.keys()),
  });
  if (knowledgeWriteProblem(resolved.blocks, context?.current ?? new Map(), context?.noteId ?? null) !== null) return null;
  return resolved.blocks as unknown as AnyBlock[];
}

export type ApplyOutcome =
  | { ok: true; insertedIds: string[]; replacedSnapshot: AnyBlock[] }
  | { ok: false; reason: "missing" | "changed" };

// Also true when the first and last blocks are in different columns; the list is contiguous and a span over a whole
// row includes the row (caught above), so checking the ends suffices.
export function selectionTouchesColumns(editor: Pick<AnyEditor, "getParentBlock">, blocks: readonly AnyBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (hasColumnBlock(blocks)) return true;
  const columnOf = (id: string): string | null => {
    for (let parent = editor.getParentBlock(id); parent; parent = editor.getParentBlock(parent.id)) {
      if (parent.type === COLUMN_TYPE) return parent.id;
    }
    return null;
  };
  return columnOf(blocks[0].id) !== columnOf(blocks[blocks.length - 1].id);
}

export function expandAnchorForColumns(editor: Pick<AnyEditor, "getParentBlock">, blocks: readonly AnyBlock[]): string[] {
  if (!selectionTouchesColumns(editor, blocks)) return blocks.map((b) => b.id);
  const ids = new Set<string>();
  for (const block of blocks) {
    let top = block.id;
    for (let parent = editor.getParentBlock(top); parent; parent = editor.getParentBlock(parent.id)) top = parent.id;
    ids.add(top);
  }
  return [...ids];
}

export function anchorPlacement(editor: Pick<AnyEditor, "getParentBlock">, blockIds: readonly string[]): MarkdownPlacement {
  return blockIds.every((id) => editor.getParentBlock(id) === undefined) ? "top" : "nested";
}

const NON_TEXT_TYPES = new Set(["image", "audio", "video", "file"]);

export function hasNonTextBlock(editor: AnyEditor, blockIds: string[]): boolean {
  const stack: AnyBlock[] = blockIds.map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (NON_TEXT_TYPES.has(b.type)) return true;
    stack.push(...(b.children as AnyBlock[]));
  }
  return false;
}

/** Must stay synchronous (no await) from check to replace. Writes `prepared.blocks`, the array the preview showed. */
export function applyAiResult(editor: AnyEditor, anchor: AiAnchor, prepared: PreparedResult): ApplyOutcome {
  const verdict = verifyAnchor(editor, anchor);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  // The check compares content, not position: if the anchor was indented or moved into a column during preview,
  // recheck structure where it is now, else it would write nested rows and break ids.
  if (findStructureError(prepared.blocks, anchorPlacement(editor, anchor.blockIds)) !== null) return { ok: false, reason: "changed" };
  // verifyAnchor already returned "missing" for absent ids, so getBlock is non-null here.
  const replacedSnapshot = anchor.blockIds.map((id) => editor.getBlock(id)!);
  const { insertedBlocks } = replaceBlocksKeepColumns(editor, anchor.blockIds, prepared.blocks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- insertedBlocks hold BlockNote's generic Block
  return { ok: true, insertedIds: insertedBlocks.map((b: any) => b.id), replacedSnapshot };
}

export type RevertOutcome = "ok" | "stale";

/** Staleness is decided only here, so a panel can't forget the check and overwrite others' edits. insertedAnchor must
 * be captured with captureAnchor of its returned insertedIds right after applyAiResult succeeds. */
export function revertAiResult(
  editor: AnyEditor,
  insertedAnchor: AiAnchor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, as in ApplyOutcome
  replacedSnapshot: Block<any, any, any>[],
): RevertOutcome {
  if (verifyAnchor(editor, insertedAnchor) !== "ok") return "stale";
  replaceBlocksKeepColumns(editor, insertedAnchor.blockIds, replacedSnapshot);
  return "ok";
}
