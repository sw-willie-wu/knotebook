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
  restoreFenceBlocks,
  syntaxCheckRoot,
  targetFromList,
  applyKnowledgeComments,
  findStrayKnowledgeProps,
  knowledgeMemberIdsIn,
  knowledgeMemberTokensIn,
  normalizeKnowledgeRefs,
  readKnowledgeInfo,
  resolveKnowledgeForWrite,
  restoreKnowledgeProps,
  sanitizeKnowledgeForWrite,
  DEFAULT_KNOWLEDGE_FIELD_VIEW,
  KNOWLEDGE_ATTR_IN_TAG,
  PLAINTEXT_TAG,
  type KnowledgeBlockShape,
  type KnowledgeFieldView,
  type KnowledgeIgnoredItem,
  type KnowledgeInfo,
  type KnowledgeMemberMaps,
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

/**
 * `replaced`: the top-level blocks the result will replace; `current`: the first knowledge heading of each id in the whole note.
 * `fields` must be the settings the request's markdown was written with: a field left out of it reads as cleared.
 */
export interface AiKnowledgeContext {
  noteId: string;
  replaced: readonly AnyBlock[];
  current: ReadonlyMap<string, KnowledgeInfo>;
  fields: KnowledgeFieldView;
  /** `handleOf` as the request was written with; `idOf` for the member tokens in the result. Without it only the stored member is kept. */
  members?: KnowledgeMemberMaps;
}

export function aiKnowledgeContext(
  editor: Pick<AnyEditor, "document" | "getBlock">,
  noteId: string,
  anchorBlockIds: readonly string[],
  fields: KnowledgeFieldView,
  members?: KnowledgeMemberMaps,
): AiKnowledgeContext {
  const current = new Map<string, KnowledgeInfo>();
  for (const b of editor.document) {
    const info = b.type === "heading" ? readKnowledgeInfo(b.props) : null;
    if (info !== null && !current.has(info.id)) current.set(info.id, info);
  }
  const replaced = anchorBlockIds.map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
  return { noteId, replaced, current, fields, ...(members ? { members } : {}) };
}

export function aiRequestMemberIds(blocks: readonly AnyBlock[], fields: KnowledgeFieldView): string[] {
  const infos = blocks.flatMap((b) => {
    const info = b.type === "heading" ? readKnowledgeInfo(b.props) : null;
    return info ? [info] : [];
  });
  return knowledgeMemberIdsIn(infos, fields);
}

export function replacesKnowledge(replaced: readonly AnyBlock[]): boolean {
  return replaced.some((b) => b.type === "heading" && readKnowledgeInfo(b.props) !== null);
}

/** buildPreview and applyAiResult must use this same blocks array, so what is applied is exactly what was previewed. */
export interface PreparedResult {
  blocks: AnyBlock[];
  unboundCount: number;
  ignoredKnowledge: KnowledgeIgnoredItem[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
function hasColumnBlock(blocks: readonly { type?: string; children?: readonly any[] }[]): boolean {
  return blocks.some((b) => COLUMN_BLOCK_TYPES.has(b.type as string) || (b.children ? hasColumnBlock(b.children) : false));
}

/** A result parsed but not yet checked against the note's knowledge; see finishAiResult. */
export interface ParsedAiResult {
  blocks: AnyBlock[];
  unboundCount: number;
  placement: MarkdownPlacement;
  hasComments: boolean;
  unknownKeys: KnowledgeIgnoredItem[];
}

type AiResultInvalid = { invalid: MarkdownSyntaxError | "unsupported_color" | "invalid_knowledge" };

export function prepareAiResult(editor: AnyEditor, markdown: string, deps: ApplyDeps): PreparedResult | { empty: true } | AiResultInvalid {
  const parsed = parseAiResult(editor, markdown, deps);
  if ("empty" in parsed || "invalid" in parsed) return parsed;
  return finishAiResult(parsed, deps.knowledge);
}

/** Member tokens the result writes, lowercased; resolve them into `idOf` before finishAiResult. */
export function aiResultMemberTokens(parsed: ParsedAiResult, fields: KnowledgeFieldView): string[] {
  if (parsed.placement !== "top" || !parsed.hasComments) return [];
  return knowledgeMemberTokensIn(parsed.blocks as unknown as readonly KnowledgeBlockShape[], fields);
}

export function finishAiResult(parsed: ParsedAiResult, knowledge: AiKnowledgeContext | undefined): PreparedResult | { invalid: "invalid_knowledge" } {
  const { blocks, unboundCount } = parsed;
  if (parsed.placement !== "top") return { blocks, unboundCount, ignoredKnowledge: [] };
  const resolved = resolveKnowledge(blocks, parsed.hasComments, knowledge);
  if (resolved === null) return { invalid: "invalid_knowledge" };
  return { blocks: resolved.blocks, unboundCount, ignoredKnowledge: [...parsed.unknownKeys, ...resolved.ignored] };
}

// Same pipeline and order as the server's parseMarkdownForNote. Blank input returns `{ empty: true }`: it
// parses to one empty paragraph, which would otherwise replace the original text.
export function parseAiResult(editor: AnyEditor, markdown: string, deps: Omit<ApplyDeps, "knowledge">): ParsedAiResult | { empty: true } | AiResultInvalid {
  const syntax = checkNoteMarkdownSyntax(markdown, deps.placement);
  if (!syntax.ok) return { invalid: syntax.error };
  // No block-count precheck: in-app AI has no block limit.
  const root = syntaxCheckRoot(syntax.html);
  if (findParseGuardFailure(root) !== null) return { invalid: "unsupported_block" };
  // Only a comment can set knowledge. After `<plaintext>` the DOM can't be serialized back, so there an attribute is refused and comments are plain text.
  let html = syntax.html;
  let assigned: ReadonlySet<string> = new Set();
  let written: readonly KnowledgeProps[] = [];
  let unknownKeys: KnowledgeIgnoredItem[] = [];
  if (PLAINTEXT_TAG.test(html)) {
    if (KNOWLEDGE_ATTR_IN_TAG.test(html)) return { invalid: "unsupported_block" };
  } else {
    const comments = applyKnowledgeComments(root, deps.placement, html);
    if ("error" in comments) return { invalid: "invalid_knowledge" };
    ({ assigned, props: written, unknownKeys } = comments);
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
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreFenceBlocks(raw)), new URL(document.baseURI).origin);
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
  return { blocks: linked, unboundCount, placement: deps.placement, hasComments: written.length > 0, unknownKeys };
}

// Same steps as the server's write path. Skipped when the result sets no knowledge and nothing in the replaced range had any, so such a selection is written exactly as before.
function resolveKnowledge(
  blocks: AnyBlock[],
  hasComments: boolean,
  context: AiKnowledgeContext | undefined,
): { blocks: AnyBlock[]; ignored: KnowledgeIgnoredItem[] } | null {
  const replaced = context?.replaced ?? [];
  if (!hasComments && !replacesKnowledge(replaced)) return { blocks, ignored: [] };
  const shaped = blocks as unknown as readonly KnowledgeBlockShape[];
  const resolved = resolveKnowledgeForWrite({
    before: replaced as unknown as readonly KnowledgeBlockShape[],
    after: context === undefined ? shaped : normalizeKnowledgeRefs(shaped, context.noteId),
    keep: context !== undefined,
    taken: new Set(context?.current.keys()),
  });
  const sanitized = sanitizeKnowledgeForWrite({
    after: resolved.blocks,
    current: context?.current ?? new Map(),
    noteId: context?.noteId ?? null,
    fields: context?.fields ?? DEFAULT_KNOWLEDGE_FIELD_VIEW,
    ...(context?.members ? { members: context.members } : {}),
  });
  if (sanitized.problem !== null) return null;
  return { blocks: sanitized.blocks as unknown as AnyBlock[], ignored: sanitized.ignored };
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
