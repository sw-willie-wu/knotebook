import { alignBlocks, alignInlineText, alignItemOf, type AlignSource } from "./block-align.js";
import {
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_ID_RE,
  KNOWLEDGE_WHEN_MAX,
  formatKnowledgeRef,
  generateKnowledgeId,
  isKnowledgeDate,
  knowledgeTextLength,
  parseKnowledgeRef,
  readKnowledgeInfo,
  validateKnowledgeDraft,
  type KnowledgeInfo,
} from "./knowledge.js";
import { KNOWLEDGE_PENDING_ID_PREFIX } from "./knowledge-html.js";
import { knowledgeHeadingText } from "./knowledge-list.js";
import type { KnowledgeCommentKey, KnowledgeProblem } from "./knowledge-markdown.js";
import { KNOWLEDGE_PROP_NAMES, type KnowledgePropName } from "./knowledge-schema.js";

export interface KnowledgeHeadingRef {
  id: string;
  heading: string;
}

/** A heading that wrote an id another heading holds: it got a new id; `from` is the id it wrote. */
export interface KnowledgeRenewedRef extends KnowledgeHeadingRef {
  from: string;
}

export interface KnowledgeBlockShape {
  id?: string;
  type: string;
  props?: Readonly<Record<string, unknown>>;
  content?: unknown;
  children?: readonly unknown[];
}

const asAlign = (blocks: readonly KnowledgeBlockShape[]): AlignSource[] => blocks as unknown as AlignSource[];
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const isPending = (id: string): boolean => id.startsWith(KNOWLEDGE_PENDING_ID_PREFIX);
const knowledgeIdOf = (b: KnowledgeBlockShape): string => (b.type === "heading" ? str(b.props?.knowledgeId) : "");
const hasKnowledgeProps = (b: KnowledgeBlockShape): boolean => KNOWLEDGE_PROP_NAMES.some(n => str(b.props?.[n]) !== "");
const withProps = <B extends KnowledgeBlockShape>(b: B, patch: Partial<Record<KnowledgePropName, string>>): B => ({ ...b, props: { ...b.props, ...patch } });

// Blocks written as plain strings (tests, MCP input) have no inline array.
const textOf = (content: unknown): string => (typeof content === "string" ? content : alignInlineText(content)).trim();

const headingKey = (b: KnowledgeBlockShape): string | null => (b.type === "heading" ? `${String(b.props?.level)}:${textOf(b.content)}` : null);

/** `alignBlocks` pairs by order, so a swapped pair would lose one side: leftovers are then paired by level and text, but only where that key is unique in both lists. The level is not part of the alignment key, so a heading moved to another level would otherwise pair. */
export function knowledgePairs(before: readonly KnowledgeBlockShape[], after: readonly KnowledgeBlockShape[]): Array<[number, number]> {
  const pairs = alignBlocks(asAlign(before).map(alignItemOf), asAlign(after).map(alignItemOf)).filter(([o, n]) => {
    const a = before[o]!;
    const b = after[n]!;
    return a.type === "heading" && b.type === "heading" && a.props?.level === b.props?.level && textOf(a.content) === textOf(b.content);
  });
  const indexByKey = (blocks: readonly KnowledgeBlockShape[]): Map<string, number | null> => {
    const m = new Map<string, number | null>();
    blocks.forEach((b, i) => {
      const key = headingKey(b);
      if (key !== null) m.set(key, m.has(key) ? null : i);
    });
    return m;
  };
  const oldByKey = indexByKey(before);
  const newByKey = indexByKey(after);
  const oldPaired = new Set(pairs.map(([o]) => o));
  const newPaired = new Set(pairs.map(([, n]) => n));
  for (const [key, o] of oldByKey) {
    const n = newByKey.get(key);
    if (o === null || o === undefined || n === null || n === undefined || oldPaired.has(o) || newPaired.has(n)) continue;
    pairs.push([o, n]);
  }
  return pairs.sort((x, y) => x[0] - y[0]);
}

/**
 * keep=true (agent and AI rewrites): a paired heading without a comment gets the old seven props. Always: a pending id takes
 * the paired old id, else a new one. A comment that writes out an id in full is the author's decision and is never overwritten, but
 * it does not take the id from the heading that holds it: the holder is the heading that got the old id through pairing, else the one
 * paired with the old heading that had it, else the first. Every other heading that wrote it gets a new id, listed in `renewed`.
 * A repeat of an id taken outside the replaced range is left for the caller: the outside heading keeps it. Copy-on-write.
 */
export function resolveKnowledgeForWrite<B extends KnowledgeBlockShape>(input: {
  before: readonly KnowledgeBlockShape[];
  after: readonly B[];
  keep: boolean;
  taken: ReadonlySet<string>;
}): { blocks: B[]; kept: KnowledgeHeadingRef[]; created: KnowledgeHeadingRef[]; renewed: KnowledgeRenewedRef[] } {
  const { before, after, keep } = input;
  const taken = new Set(input.taken);
  for (const b of after) {
    const id = knowledgeIdOf(b);
    if (id !== "" && !isPending(id)) taken.add(id);
  }
  const blocks = [...after];
  const kept: KnowledgeHeadingRef[] = [];
  const holders = new Map<string, number>();
  const heldIndexes = new Set<number>();
  const pairedOldId = new Map<number, string>();
  // Pairing runs the block alignment, which a note without knowledge never needs.
  const pairs = before.some(b => knowledgeIdOf(b) !== "") ? knowledgePairs(before, after) : [];
  for (const [o, n] of pairs) {
    const old = before[o]!;
    const oldInfo = readKnowledgeInfo(old.props);
    if (oldInfo === null) continue;
    const next = blocks[n]!;
    const id = knowledgeIdOf(next);
    pairedOldId.set(n, oldInfo.id);
    if (id === "" && !hasKnowledgeProps(next)) {
      if (!keep) continue;
      blocks[n] = withProps(next, Object.fromEntries(KNOWLEDGE_PROP_NAMES.map(name => [name, str(old.props?.[name])])));
      kept.push({ id: oldInfo.id, heading: knowledgeHeadingText(next.content) });
    } else if (isPending(id)) {
      blocks[n] = withProps(next, { knowledgeId: oldInfo.id });
    } else continue;
    taken.add(oldInfo.id);
    if (!holders.has(oldInfo.id)) holders.set(oldInfo.id, n);
    heldIndexes.add(n);
  }
  const written = new Map<string, number[]>();
  blocks.forEach((b, i) => {
    const id = knowledgeIdOf(b);
    if (id === "" || isPending(id) || heldIndexes.has(i)) return;
    const list = written.get(id);
    if (list) list.push(i);
    else written.set(id, [i]);
  });
  const renewed: KnowledgeRenewedRef[] = [];
  for (const [id, indexes] of written) {
    const holder = holders.get(id);
    if (holder === undefined && indexes.length < 2) continue;
    const keeper = holder !== undefined ? -1 : (indexes.find(i => pairedOldId.get(i) === id) ?? indexes[0]!);
    for (const i of indexes) {
      if (i === keeper) continue;
      const fresh = generateKnowledgeId(taken);
      taken.add(fresh);
      blocks[i] = withProps(blocks[i]!, { knowledgeId: fresh });
      renewed.push({ id: fresh, heading: knowledgeHeadingText(blocks[i]!.content), from: id });
    }
  }
  const created: KnowledgeHeadingRef[] = [];
  blocks.forEach((b, i) => {
    if (!isPending(knowledgeIdOf(b))) return;
    const id = generateKnowledgeId(taken);
    taken.add(id);
    blocks[i] = withProps(b, { knowledgeId: id });
    created.push({ id, heading: knowledgeHeadingText(b.content) });
  });
  return { blocks, kept, created, renewed };
}

/** A reference to a knowledge in this very note is stored as the bare id, so it stays right when the note is copied. Copy-on-write. */
export function normalizeKnowledgeRefs<B extends KnowledgeBlockShape>(after: readonly B[], noteId: string): B[] {
  return after.map(b => {
    const value = str(b.type === "heading" ? b.props?.knowledgeSupersededBy : "");
    if (value === "") return b;
    const ref = parseKnowledgeRef(value);
    if (ref === null || ref.noteId === null || ref.noteId !== noteId.toLowerCase()) return b;
    return withProps(b, { knowledgeSupersededBy: formatKnowledgeRef(ref, noteId) });
  });
}

const EVIDENCE = new Set(["", "tested", "docs", "inferred"]);
const STATUS = new Set(["", "unverified", "outdated"]);
const LINE_BREAK = /[\r\n\u{85}\u{2028}\u{2029}]/u;

type Fields = Pick<KnowledgeInfo, "when" | "conclusion" | "evidence" | "verified" | "status" | "supersededBy">;
const sameFields = (a: Fields, b: Fields): boolean =>
  a.when === b.when && a.conclusion === b.conclusion && a.evidence === b.evidence && a.verified === b.verified && a.status === b.status && a.supersededBy === b.supersededBy;

/**
 * Value checks and the semantic rules for every top-level knowledge heading, in document order. A heading whose id is in
 * `current` with all six fields equal is not checked: what is already stored must be writable back. Run after
 * `resolveKnowledgeForWrite`, so no pending ids are left.
 */
export function knowledgeWriteProblem(
  after: readonly KnowledgeBlockShape[],
  current: ReadonlyMap<string, KnowledgeInfo>,
  noteId: string | null,
): KnowledgeProblem | null {
  for (const b of after) {
    const id = knowledgeIdOf(b);
    if (id === "") continue;
    const heading = knowledgeHeadingText(b.content);
    const fields: Fields = {
      when: str(b.props?.knowledgeWhen),
      conclusion: str(b.props?.knowledgeConclusion),
      evidence: str(b.props?.knowledgeEvidence) as Fields["evidence"],
      verified: str(b.props?.knowledgeVerified),
      status: str(b.props?.knowledgeStatus) as Fields["status"],
      supersededBy: str(b.props?.knowledgeSupersededBy),
    };
    const stored = current.get(id);
    if (stored !== undefined && sameFields(stored, fields)) continue;
    const fail = (problem: KnowledgeProblem["problem"], key?: KnowledgeCommentKey): KnowledgeProblem => ({ problem, ...(key ? { key } : {}), heading });
    if (!KNOWLEDGE_ID_RE.test(id)) return fail("bad_id", "id");
    if (knowledgeTextLength(fields.when) > KNOWLEDGE_WHEN_MAX) return fail("too_long", "when");
    if (LINE_BREAK.test(fields.when)) return fail("line_break", "when");
    if (knowledgeTextLength(fields.conclusion) > KNOWLEDGE_CONCLUSION_MAX) return fail("too_long", "conclusion");
    if (LINE_BREAK.test(fields.conclusion)) return fail("line_break", "conclusion");
    if (!EVIDENCE.has(fields.evidence)) return fail("bad_evidence", "evidence");
    if (!STATUS.has(fields.status)) return fail("bad_status", "status");
    if (fields.verified !== "" && !isKnowledgeDate(fields.verified)) return fail("bad_date", "verified");
    if (fields.supersededBy !== "" && parseKnowledgeRef(fields.supersededBy) === null) return fail("bad_ref", "superseded_by");
    const semantic = validateKnowledgeDraft(fields, { noteId: null, knowledgeId: id }, noteId);
    if (semantic === "empty") return fail("empty");
    if (semantic === "supersededRequired") return fail("superseded_required", "superseded_by");
    if (semantic === "supersededSelf") return fail("superseded_self", "superseded_by");
  }
  return null;
}

export function knowledgeRefsIn(blocks: readonly KnowledgeBlockShape[]): KnowledgeHeadingRef[] {
  const out: KnowledgeHeadingRef[] = [];
  for (const b of blocks) {
    const info = b.type === "heading" ? readKnowledgeInfo(b.props) : null;
    if (info !== null) out.push({ id: info.id, heading: knowledgeHeadingText(b.content) });
  }
  return out;
}
