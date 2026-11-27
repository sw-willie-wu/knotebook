// Input is always doc-state bytes and output plain data: no DB here (needs go through `ask`). Worker and main thread run the same `executeDocOp`, so results are identical. Returned fingerprints and outline are those of base + this write (without concurrent changes).
// Without a watch the main thread compares snapshots, not just state vectors: an update that only deletes doesn't change the state vector.
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import {
  MAX_LINK_TARGETS,
  YDOC_FRAGMENT,
  extractLinkTargets,
  keptIdRenames,
  knowledgeMemberIdsIn,
  knowledgeMemberTokensIn,
  knowledgeRefsIn,
  normalizeKnowledgeRefs,
  resolveKnowledgeForWrite,
  sanitizeKnowledgeForWrite,
  topLevelBlocks,
  topLevelIdsOf,
  type EditOp,
  type KnowledgeBlockShape,
  type KnowledgeFieldView,
  type KnowledgeHeadingRef,
  type KnowledgeIgnoredItem,
  type KnowledgeInfo,
  type KnowledgeMemberMaps,
  type KnowledgeProblem,
  type NoteContentDto,
  type NoteOutlineEntry,
  type NoteSectionDto,
} from "@knotebook/shared";
import type { TransferSegment } from "../../db/schema.js";
import { hmacOf } from "../../transfer/base-hash.js";
import { isLoneEmptyParagraph, matchesBase } from "../../transfer/decide.js";
import { exportNoteBody, exportNoteForTransfer, type ExportedNote } from "../../transfer/export-note.js";
import type { LineDiff } from "../../transfer/line-diff.js";
import { exportedLinkTextOf, linkTextHash } from "../../transfer/link-texts.js";
import { normalizeBody } from "../../transfer/normalize.js";
import { applySync, type Applied } from "../../transfer/sync-apply.js";
import { planSync, type PlanSyncError, type SyncPlan } from "../../transfer/sync-plan.js";
import type { Decision } from "../../transfer/decide.js";
import { measureTrial, type SizeMeasure } from "../note-size.js";
import { versionFingerprint } from "../version-fingerprint.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { fingerprintForIds, fingerprintsOfGroups, outlineOf, topLevelSnapshot, type OutlineEntry } from "./fingerprint.js";
import type { ParseDetail, ParseError } from "./markdown.js";
import { KnowledgeWriteError, createdKnowledge, knowledgeIdsByBlock, knowledgeInfoById, type KnowledgeEditReport, type KnowledgeRenewal, type KnowledgeWriteReport } from "./knowledge-write.js";
import { readNoteContentFromDoc } from "./read.js";
import { editRevertable, isDeleteShape, prepareRevertOnFork, removedIds, topLevelIds, type RevertRow } from "./revert-core.js";
import { containerItems, type MergeGuard } from "./live-watch.js";
import type { EditingRuntime } from "./runtime.js";
import { pickBlocks, topLevelBlocksById, withForkEditor } from "./session.js";
import type { ShownLinks } from "./shown-link-texts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
type AnyPartialBlock = PartialBlock<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyBlock = Block<any, any, any>;
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };

/** Doc state below this size (for apply, plus the length of the content to write) converts on the main thread: one conversion stalls it ~10 ms, comparable to a worker round trip, while a worker job can queue for seconds or 503 when all workers are busy. */
export const DOC_INLINE_MAX_BYTES = 16 * 1024;

/** A conversion job's time limit = this × `PARSE_TIMEOUT_MS`: reading a big note needs mount + export; apply needs mount + write + post-merge values. */
export const DOC_TIMEOUT_FACTOR = 3;

export const DOC_TOO_COMPLEX = "too_complex" as const;
export type DocTooComplex = typeof DOC_TOO_COMPLEX;

export type DocAsk = { kind: "titles"; ids: string[] } | { kind: "charge" } | { kind: "members"; tokens: string[]; ids: string[] };
export type AskFn = (q: DocAsk) => Promise<unknown>;
export type TitlePairs = Array<[string, string]>;
export interface MemberPairs {
  idOf: Array<[string, string]>;
  handleOf: Array<[string, string]>;
}

export interface DocPost {
  baseSnapshot: Uint8Array;
  /** Pre-merge live doc clock, for the links CAS. */
  clock: number;
  diff: Uint8Array;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  afterFingerprint: string | null;
  afterSectionIndex: number | null;
  versionFingerprint: string | null;
  afterFingerprints?: (string | null)[];
  /** Untruncated; `syncLinksFromDoc` truncates. */
  linkTargets: string[];
  size: SizeMeasure;
  guard: MergeGuard;
}

export type ReadDocOp = { kind: "read"; state: Uint8Array; section?: string; wantShown: boolean; fields: KnowledgeFieldView };
/** `locate`: block ids (at any depth) whose top-level block the result reports in `located`. */
export type OutlineDocOp = { kind: "outline"; state: Uint8Array; locate?: string[] };
export type ExportFileDocOp = { kind: "exportFile"; state: Uint8Array; key: Uint8Array; salt: Uint8Array; forceUnmergeable?: boolean; fields: KnowledgeFieldView };
export type EditDocOp = {
  kind: "edit";
  state: Uint8Array;
  op: EditOp;
  sectionId?: string;
  ifMatch?: string;
  blocks?: AnyPartialBlock[];
  parseError?: { error: ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem };
  noteId: string;
  fields: KnowledgeFieldView;
};
export type RevertDocOp = { kind: "revert"; state: Uint8Array; row: RevertRow; othersShareAnchor: boolean };
/** Plan and apply are separate jobs because parsing a dense section can use hundreds of MiB; stacked with mount + apply it would exhaust the worker's memory, and split the pool can recycle the worker in between. Both jobs use the same doc state. */
export type SyncPlanDocOp = {
  kind: "syncPlan";
  state: Uint8Array;
  owner: string;
  segments: TransferSegment[] | null;
  baseLineCount: number;
  body: { agentLines: string[]; diff: LineDiff } | null;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  key: Uint8Array;
  salt: Uint8Array;
  baseBodySha: Uint8Array;
  budgetMs: number;
  fields: KnowledgeFieldView;
};
export type SyncApplyDocOp = { kind: "syncApply"; state: Uint8Array; plan: SyncPlan; normalizedId: string | null; noteId: string; fields: KnowledgeFieldView };
export type SizeTrialDocOp = { kind: "sizeTrial"; state: Uint8Array; update: Uint8Array };
export type DocOp = ReadDocOp | OutlineDocOp | ExportFileDocOp | EditDocOp | RevertDocOp | SyncPlanDocOp | SyncApplyDocOp | SizeTrialDocOp;

export interface ReadDocResult {
  result: Omit<NoteContentDto, "lastEdited"> | Omit<NoteSectionDto, "lastEdited"> | "section_not_found";
  shown?: ShownLinks;
}
export interface OutlineDocResult {
  outline: OutlineEntry[];
  whole: string;
  /** [block id, top-level block id] for each `locate` id still in the document. */
  located?: Array<[string, string]>;
}
export type EditDocResult =
  | { ok: true; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; post: DocPost; knowledge: KnowledgeEditReport }
  | { ok: false; code: "section_not_found" | "fingerprint_mismatch" | "empty_section" | ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem };
export type RevertDocResult = { ok: true; reinsertedIds: string[]; removedSnapshot: AnyBlock[]; post: DocPost } | { ok: false; code: "stale" };
export type SyncPlanDocResult = { budgetLeft: number } & (
  | { kind: "note_changed" }
  | { kind: "body_checked" }
  | { kind: "rate_limited" }
  | { kind: "parse"; code: PlanSyncError; detail?: ParseDetail; fence?: string; knowledge?: KnowledgeProblem }
  | { kind: "zero_region"; same: number }
  | { kind: "planned"; plan: SyncPlan; normalizedId: string | null }
);
export interface SyncApplyDocResult {
  decisions: Decision[];
  unbound: number;
  perRegion: Applied["perRegion"];
  post: DocPost;
  knowledge: KnowledgeWriteReport;
}
export type SyncApplyDocFailure = { kind: "invalid_knowledge"; knowledge: KnowledgeProblem };
export interface DocResults {
  read: ReadDocResult;
  outline: OutlineDocResult;
  exportFile: ExportedNote;
  edit: EditDocResult;
  revert: RevertDocResult;
  syncPlan: SyncPlanDocResult;
  syncApply: SyncApplyDocResult | SyncApplyDocFailure;
  sizeTrial: SizeMeasure;
}
export type DocOpOf<K extends DocOp["kind"]> = Extract<DocOp, { kind: K }>;

export function decodeState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc;
}

/** Local copy of `collab/store.ts` `docClock` so the worker needn't load the collab layer. */
function clockOf(doc: Y.Doc): number {
  let total = 0;
  for (const seq of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) total += seq;
  return total;
}

/** Computed before mount (mount normalizes an empty doc). */
function baseOf(doc: Y.Doc, state: Uint8Array): { sv: Uint8Array; snapshot: Uint8Array; clock: number; size: number; state: Uint8Array } {
  return { sv: Y.encodeStateVector(doc), snapshot: Y.encodeSnapshot(Y.snapshot(doc)), clock: clockOf(doc), size: state.byteLength, state };
}

/** Applied to a fresh doc rather than encoding the edited fork: the editor's undo manager keeps deleted content alive, so the fork stays as large as before; the live doc reclaims it. */
export function measureDiff(state: Uint8Array, diff: Uint8Array): SizeMeasure {
  return measureTrial(state, diff);
}

export function stateEquals(doc: Y.Doc, baseSnapshot: Uint8Array): boolean {
  return Y.equalSnapshots(Y.snapshot(doc), Y.decodeSnapshot(baseSnapshot));
}

const stripIds = (outline: OutlineEntry[]): NoteOutlineEntry[] => outline.map(({ blockIds: _b, ...e }) => e);

function postOf(fork: Y.Doc, base: ReturnType<typeof baseOf>, diff: Uint8Array, afterIds: string[], guard: MergeGuard, afterGroups?: string[][]): DocPost {
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  let versionFp: string | null = null;
  try {
    versionFp = versionFingerprint(fragment);
  } catch {
    versionFp = null;
  }
  const merged = outlineOf(fragment);
  const firstAfter = afterIds[0];
  const afterIndex = firstAfter === undefined ? -1 : merged.outline.findIndex(s => s.blockIds.includes(firstAfter));
  const post: DocPost = {
    baseSnapshot: base.snapshot,
    clock: base.clock,
    diff,
    fingerprint: merged.whole,
    outline: stripIds(merged.outline),
    afterFingerprint: afterIds.length === 0 ? null : fingerprintForIds(fragment, afterIds),
    afterSectionIndex: afterIndex === -1 ? null : afterIndex,
    versionFingerprint: versionFp,
    linkTargets: extractLinkTargets(fork),
    size: measureDiff(base.state, diff),
    guard,
  };
  if (afterGroups !== undefined) post.afterFingerprints = fingerprintsOfGroups(fragment, afterGroups);
  return post;
}

async function titlesFor(doc: Y.Doc, ask: AskFn): Promise<Map<string, string>> {
  const ids = extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS);
  if (ids.length === 0) return new Map();
  return new Map((await ask({ kind: "titles", ids })) as TitlePairs);
}

/** `tokens`: written member values, resolved within the writer's reach. `ids`: stored members, named for export and for comparing with what is written. */
async function membersFor(ask: AskFn, tokens: string[], ids: string[]): Promise<KnowledgeMemberMaps> {
  if (tokens.length === 0 && ids.length === 0) return { idOf: new Map(), handleOf: new Map() };
  const a = (await ask({ kind: "members", tokens, ids })) as MemberPairs;
  return { idOf: new Map(a.idOf), handleOf: new Map(a.handleOf) };
}

async function storedMemberHandles(ask: AskFn, current: ReadonlyMap<string, KnowledgeInfo>, fields: KnowledgeFieldView): Promise<ReadonlyMap<string, string>> {
  return (await membersFor(ask, [], knowledgeMemberIdsIn(current.values(), fields))).handleOf;
}

export async function editOnFork(
  runtime: EditingRuntime,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: { op: EditOp; isEmptyDoc: boolean; section: OutlineEntry | undefined; keepIds?: boolean; knowledge?: { current: ReadonlyMap<string, KnowledgeInfo>; noteId: string; fields: KnowledgeFieldView; members: KnowledgeMemberMaps } },
  blocks: AnyPartialBlock[],
): Promise<{ diff: Uint8Array; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; knowledge: KnowledgeEditReport }> {
  const { op, isEmptyDoc, section } = plan;
  let kept: KnowledgeHeadingRef[] = [];
  let resolvedRenewed: KnowledgeRenewal[] = [];
  let ignored: KnowledgeIgnoredItem[] = [];
  // Without `plan.knowledge` (version apply) the blocks come from a stored version and are written as they are.
  const withKnowledge = (before: readonly AnyBlock[]): AnyPartialBlock[] => {
    const k = plan.knowledge;
    if (k === undefined) return blocks;
    const keep = plan.keepIds === true && (op === "replace_all" || op === "replace_section");
    const r = resolveKnowledgeForWrite({
      before: before as unknown as readonly KnowledgeBlockShape[],
      after: normalizeKnowledgeRefs(blocks as unknown as readonly KnowledgeBlockShape[], k.noteId),
      keep,
      taken: new Set(k.current.keys()),
    });
    const s = sanitizeKnowledgeForWrite({ after: r.blocks, current: k.current, noteId: k.noteId, fields: k.fields, members: k.members });
    if (s.problem !== null) throw new KnowledgeWriteError(s.problem);
    ({ kept } = r);
    ({ ignored } = s);
    resolvedRenewed = r.renewed;
    return s.blocks as unknown as AnyPartialBlock[];
  };
  const w = await withForkEditor(runtime, fork, sv, (ed, edits) => {
    const top = ed.document;
    const keep = (before: readonly AnyBlock[], inserted: readonly AnyBlock[]): void => {
      if (plan.keepIds) edits.rename(keptIdRenames(before, inserted));
    };
    let beforeBlocks: AnyBlock[] = [];
    let afterIds: string[] = [];
    let anchor: Anchor | null = null;
    switch (op) {
      case "replace_all": {
        beforeBlocks = isEmptyDoc ? [] : top;
        const inserted = edits.replace(top.map(b => b.id), withKnowledge(beforeBlocks), top);
        afterIds = inserted.map(b => b.id);
        // On an empty doc the only old block is the paragraph the mount normalized, never part of the note.
        if (!isEmptyDoc) keep(beforeBlocks, inserted);
        break;
      }
      case "replace_section": {
        const sectionIds = section!.blockIds;
        if (sectionIds.length === 0) afterIds = ed.insertBlocks(withKnowledge([]), top[0]!.id, "before").map(b => b.id);
        else {
          beforeBlocks = pickBlocks(topLevelBlocksById(ed), sectionIds);
          const inserted = edits.replace(sectionIds, withKnowledge(beforeBlocks), beforeBlocks);
          afterIds = inserted.map(b => b.id);
          keep(beforeBlocks, inserted);
        }
        break;
      }
      case "insert_after": {
        const sectionIds = section!.blockIds;
        const write = withKnowledge([]);
        afterIds = (sectionIds.length === 0 ? ed.insertBlocks(write, top[0]!.id, "before") : ed.insertBlocks(write, sectionIds[sectionIds.length - 1]!, "after")).map(b => b.id);
        break;
      }
      case "append": {
        afterIds = ed.insertBlocks(withKnowledge([]), top[top.length - 1]!.id, "after").map(b => b.id);
        break;
      }
      case "delete_section": {
        const sectionIds = section!.blockIds;
        beforeBlocks = pickBlocks(topLevelBlocksById(ed), sectionIds);
        const idx = top.findIndex(b => b.id === sectionIds[0]);
        const prev = top[idx - 1];
        const next = top[idx + sectionIds.length];
        // Removing the whole doc leaves one empty paragraph (id not recorded).
        const placeholder = edits.remove(sectionIds);
        anchor = placeholder ? { block_id: placeholder.id, position: "before" } : prev ? { block_id: prev.id, position: "after" } : { block_id: next!.id, position: "before" };
        break;
      }
    }
    return { beforeBlocks, afterIds, anchor };
  });
  const { beforeBlocks } = w.value;
  const surviving = plan.knowledge === undefined ? null : new Set(knowledgeIdsByBlock(fork.getXmlFragment(YDOC_FRAGMENT)).values());
  const resolvedIds = new Set(resolvedRenewed.map(r => r.id));
  const renewed = [...resolvedRenewed, ...w.renewed.filter(x => !resolvedIds.has(x.id))];
  const created = surviving === null ? [] : createdKnowledge(fork.getXmlFragment(YDOC_FRAGMENT), w.knowledgeBefore, renewed);
  const removed = surviving === null ? [] : knowledgeRefsIn(beforeBlocks as unknown as readonly KnowledgeBlockShape[]).filter(r => !surviving.has(r.id));
  return {
    diff: w.diff,
    beforeBlocks,
    afterIds: w.value.afterIds.map(id => w.renamed.get(id) ?? id),
    anchor: w.value.anchor,
    knowledge: { kept, created, removed, renewed, ignored },
  };
}

async function readOp(runtime: EditingRuntime, op: ReadDocOp, ask: AskFn): Promise<ReadDocResult> {
  const doc = decodeState(op.state);
  const titles = await titlesFor(doc, ask);
  const handleOf = await storedMemberHandles(ask, knowledgeInfoById(doc.getXmlFragment(YDOC_FRAGMENT)), op.fields);
  let shown: ShownLinks | undefined;
  const result = await readNoteContentFromDoc(runtime, doc, op.section, titles, op.wantShown ? s => (shown = s) : undefined, op.fields, handleOf);
  return shown ? { result, shown } : { result };
}

async function editOp(runtime: EditingRuntime, op: EditDocOp, ask: AskFn): Promise<EditDocResult> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(fragment);
  const isEmptyDoc = topLevelBlocks(fragment).length === 0;
  const section = op.sectionId === undefined ? undefined : outline.find(o => o.sectionId === op.sectionId);
  if (op.sectionId !== undefined && !section) return { ok: false, code: "section_not_found" };
  const expect = op.ifMatch ?? null;
  const targetIds = op.op === "replace_all" || op.op === "append" ? null : section!.blockIds;
  if (expect !== null && (targetIds === null ? whole : section!.fingerprint) !== expect) return { ok: false, code: "fingerprint_mismatch" };
  if (op.op === "delete_section" && (isEmptyDoc || section!.blockIds.length === 0)) return { ok: false, code: "empty_section" };
  if (op.parseError) return { ok: false, code: op.parseError.error, ...(op.parseError.detail ? { detail: op.parseError.detail } : {}), ...(op.parseError.knowledge ? { knowledge: op.parseError.knowledge } : {}) };
  // Empty doc: all three ops behave as replace_all (the normalized leftover paragraph gets replaced).
  const editKind: EditOp = isEmptyDoc ? "replace_all" : op.op;
  const blocks = op.blocks ?? [];
  const guard: MergeGuard = expect === null ? { kind: "none" } : targetIds === null || isEmptyDoc ? { kind: "any" } : { kind: "blocks", items: containerItems(fragment, targetIds), anchors: [] };
  const current = knowledgeInfoById(fragment);
  const members = await membersFor(ask, knowledgeMemberTokensIn(blocks as unknown as readonly KnowledgeBlockShape[], op.fields), knowledgeMemberIdsIn(current.values(), op.fields));
  let r: Awaited<ReturnType<typeof editOnFork>>;
  try {
    r = await editOnFork(runtime, fork, base.sv, { op: editKind, isEmptyDoc, section, keepIds: true, knowledge: { current, noteId: op.noteId, fields: op.fields, members } }, blocks);
  } catch (err) {
    if (err instanceof KnowledgeWriteError) return { ok: false, code: "invalid_knowledge", knowledge: err.problem };
    throw err;
  }
  return { ok: true, beforeBlocks: r.beforeBlocks, afterIds: r.afterIds, anchor: r.anchor, post: postOf(fork, base, r.diff, r.afterIds, guard), knowledge: r.knowledge };
}

async function revertOp(runtime: EditingRuntime, op: RevertDocOp): Promise<RevertDocResult> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { row } = op;
  const isDelete = isDeleteShape({ op: row.op, anchor: row.anchor });
  const beforeIds = row.beforeBlocks.map(b => (b as { id: string }).id);
  // Same predicate as `listEdits` (`editRevertable`) so the list and the revert gate agree.
  const revertable = editRevertable(
    { op: row.op, afterBlockIds: row.afterBlockIds, afterFingerprint: row.afterFingerprint, anchorId: row.anchor?.block_id ?? null, beforeIds },
    fragment,
    topLevelIds(fragment),
  );
  if (!revertable) return { ok: false, code: "stale" };
  const guard: MergeGuard = isDelete
    ? { kind: "blocks", items: [], anchors: containerItems(fragment, row.anchor ? [row.anchor.block_id] : []), absent: beforeIds }
    : { kind: "blocks", items: containerItems(fragment, row.afterBlockIds), anchors: [], absent: removedIds({ afterBlockIds: row.afterBlockIds, beforeIds }) };
  const r = await prepareRevertOnFork(runtime, row, fork, base.sv, op.othersShareAnchor);
  return { ok: true, reinsertedIds: r.reinsertedIds, removedSnapshot: r.removedSnapshot, post: postOf(fork, base, r.diff, r.reinsertedIds, guard) };
}

async function syncPlanOp(runtime: EditingRuntime, op: SyncPlanDocOp, ask: AskFn): Promise<SyncPlanDocResult> {
  const budget = { remainingMs: op.budgetMs };
  const left = () => budget.remainingMs;
  const fork = decodeState(op.state);
  const curFragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const cur = topLevelSnapshot(curFragment);
  const key = Buffer.from(op.key);
  const salt = Buffer.from(op.salt);
  const current = knowledgeInfoById(curFragment);
  const storedIds = knowledgeMemberIdsIn(current.values(), op.fields);
  let loneEmpty = false;
  if (op.segments !== null) {
    loneEmpty = op.segments.length === 0 && isLoneEmptyParagraph(curFragment);
    if (!loneEmpty && !matchesBase(op.segments, cur)) return { kind: "note_changed", budgetLeft: left() };
  } else {
    // No block fingerprints for a title-only change: compare a full export, made on a copy of the fork (mount doesn't touch the fork).
    const titles = await titlesFor(fork, ask);
    const handleOf = (await membersFor(ask, [], storedIds)).handleOf;
    const copy = decodeState(Y.encodeStateAsUpdate(fork));
    const nowBody = normalizeBody(await exportNoteBody(runtime, copy, titles, op.fields, handleOf));
    if (!hmacOf(key, salt, nowBody).equals(Buffer.from(op.baseBodySha))) return { kind: "note_changed", budgetLeft: left() };
  }
  if (op.body === null || op.segments === null) return { kind: "body_checked", budgetLeft: left() };
  // Charge the quota before parsing; retries on the main thread don't charge again.
  if (!((await ask({ kind: "charge" })) as boolean)) return { kind: "rate_limited", budgetLeft: left() };
  const planned = await planSync(runtime, {
    writerId: op.owner,
    fileBudget: budget,
    segments: op.segments,
    baseLineCount: op.baseLineCount,
    agentLines: op.body.agentLines,
    diff: op.body.diff,
    cur,
    curFragment,
    candidates: op.candidates,
    siteOrigin: op.siteOrigin,
    exportedLinkText: exportedLinkTextOf(op.segments, key, salt),
    knowledge: { current, fields: op.fields, members: tokens => membersFor(ask, tokens, storedIds) },
  });
  if (!planned.ok) return { kind: "parse", code: planned.code, ...(planned.detail ? { detail: planned.detail } : {}), ...(planned.fence ? { fence: planned.fence } : {}), ...(planned.knowledge ? { knowledge: planned.knowledge } : {}), budgetLeft: left() };
  const p = planned.plan;
  if (p.decisions.every(d => d.mark === "same")) return { kind: "zero_region", same: p.decisions.length, budgetLeft: left() };
  return { kind: "planned", plan: p, normalizedId: loneEmpty ? cur.ids[0]! : null, budgetLeft: left() };
}

async function syncApplyOp(runtime: EditingRuntime, op: SyncApplyDocOp, ask: AskFn): Promise<SyncApplyDocResult | SyncApplyDocFailure> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const cur = topLevelSnapshot(fragment);
  const current = knowledgeInfoById(fragment);
  const written = op.plan.parsed.filter((_, ri) => op.plan.decisions[ri]!.mark !== "same").flat();
  const members = await membersFor(ask, knowledgeMemberTokensIn(written as unknown as readonly KnowledgeBlockShape[], op.fields), knowledgeMemberIdsIn(current.values(), op.fields));
  let a: Awaited<ReturnType<typeof applySync>>;
  try {
    a = await applySync(runtime, fork, base.sv, op.plan, cur, {
      ...(op.normalizedId !== null ? { normalizedId: op.normalizedId } : {}),
      knowledge: { current, noteId: op.noteId, fields: op.fields, members },
    });
  } catch (err) {
    if (err instanceof KnowledgeWriteError) return { kind: "invalid_knowledge", knowledge: err.problem };
    throw err;
  }
  // Write-back requires the whole note unchanged since download.
  const post = postOf(fork, base, a.diff, [], { kind: "any" }, a.perRegion.map(pr => pr.afterIds));
  return { decisions: op.plan.decisions, unbound: op.plan.unbound, perRegion: a.perRegion, post, knowledge: { ...a.knowledge, ignored: [...op.plan.ignoredKnowledge, ...a.knowledge.ignored], ignoredComments: op.plan.ignoredKnowledgeComments } };
}

/** `RangeError` (stack/array/string limits) means too large or complex → `DOC_TOO_COMPLEX`; other errors are bugs and rethrown. */
export async function executeDocOp<K extends DocOp["kind"]>(runtime: EditingRuntime, op: DocOpOf<K>, ask: AskFn): Promise<DocResults[K] | DocTooComplex> {
  try {
    return (await run(runtime, op as DocOp, ask)) as DocResults[K];
  } catch (err) {
    if (err instanceof RangeError) return DOC_TOO_COMPLEX;
    throw err;
  }
}

async function run(runtime: EditingRuntime, op: DocOp, ask: AskFn): Promise<DocResults[DocOp["kind"]]> {
  switch (op.kind) {
    case "read":
      return readOp(runtime, op, ask);
    case "outline": {
      const fragment = decodeState(op.state).getXmlFragment(YDOC_FRAGMENT);
      const result: OutlineDocResult = outlineOf(fragment);
      return op.locate === undefined ? result : { ...result, located: [...topLevelIdsOf(fragment, new Set(op.locate))] };
    }
    case "exportFile": {
      const doc = decodeState(op.state);
      const titles = await titlesFor(doc, ask);
      const handleOf = await storedMemberHandles(ask, knowledgeInfoById(doc.getXmlFragment(YDOC_FRAGMENT)), op.fields);
      const key = Buffer.from(op.key);
      const salt = Buffer.from(op.salt);
      return exportNoteForTransfer(runtime, doc, titles, { ...(op.forceUnmergeable ? { forceUnmergeable: true } : {}), linkHash: (id, text) => linkTextHash(key, salt, id, text), fields: op.fields, handleOf });
    }
    case "edit":
      return editOp(runtime, op, ask);
    case "revert":
      return revertOp(runtime, op);
    case "syncPlan":
      return syncPlanOp(runtime, op, ask);
    case "syncApply":
      return syncApplyOp(runtime, op, ask);
    case "sizeTrial":
      return measureTrial(op.state, op.update);
  }
}

export function docWeight(op: DocOp, extra = 0): number {
  return op.state.byteLength + extra + (op.kind === "sizeTrial" ? op.update.byteLength : 0);
}
