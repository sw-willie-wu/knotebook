import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { AI_EDITS_RETENTION, YDOC_FRAGMENT, topLevelBlocks, type EditOp, type KnowledgeProblem, type NoteOutlineEntry } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { VersionService } from "../../collab/versions.js";
import { docClock } from "../../collab/store.js";
import type { Db } from "../../db/index.js";
import { noteAiEdits } from "../../db/schema.js";
import { syncLinksFromDoc } from "../links.js";
import { capBlocks, NoteTooLargeError } from "../note-size.js";
import { versionFingerprint } from "../version-fingerprint.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { checkExpectations, fingerprintForIds, fingerprintsOfGroups, outlineOf, type OutlineEntry } from "./fingerprint.js";
import { siteOriginOf, type ParseDetail, type ParseError } from "./markdown.js";
import { DOC_TOO_COMPLEX, editOnFork, stateEquals, type DocPost } from "./doc-jobs.js";
import { isEmptyKnowledgeReport, type KnowledgeWriteReport } from "./knowledge-write.js";
import type { LiveWatch } from "./live-watch.js";
import { ParserBusyError, type ParseOutcome } from "./parse-core.js";
import { loadNoteDoc, loadNoteState } from "./read.js";
import type { EditingRuntime } from "./runtime.js";
import { directTarget, withDirectConnection, type DirectConnectionCtx, type DirectCtx } from "./session.js";
import { shownLinkTextsOf, type ShownLinks, type ShownLinkTexts } from "./shown-link-texts.js";

// No DB transaction spans the merge: merge and persist first, record after (a failed record leaves the content in, the record missing); `before_blocks` is unbounded. Merges retry up to `DOC_MERGE_ATTEMPTS` times, then 503. Version apply and link conversion still use the old `mergeDiff` (the main thread recomputes the fingerprint on the live doc; see known-limitations). `append` without `if_match` skips the check.
// Never acquire a lease while holding one (`runtime.acquire` isn't reentrant): across the rebuild threshold it deadlocks silently.
// Zero-block sections (`_top` of a heading-led note, an empty doc) always fingerprint to `EMPTY_SECTION_FINGERPRINT`, so `if_match` can't detect concurrent inserts there; Yjs keeps both sides, only the AI content's position is up to the CRDT.
export interface EditingTestHooks {
  beforeMerge?: () => Promise<void>;
  beforeRecord?: () => Promise<void>;
  afterRecord?: () => Promise<void>;
  beforeRevertRecord?: () => Promise<void>;
  afterOpenDirect?: () => Promise<void>;
  beforeVersionBase?: () => Promise<void>;
  beforeCreateFromFile?: () => Promise<void>;
}
export interface ApplyDeps {
  db: Db;
  collab: CollabServer;
  editing: EditingRuntime;
  log: { warn(o: object, m: string): void; error(o: object, m: string): void };
  testHooks?: EditingTestHooks;
  versions?: VersionService;
  /** #387: link texts the writer has read; `prepareEdit` uses it so those links aren't frozen as custom text. */
  shownLinks?: ShownLinkTexts;
  noteMaxBytes?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
type AnyPartialBlock = PartialBlock<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type AnyBlock = Block<any, any, any>;
type Anchor = { block_id: string; position: "before" | "after" };

export interface ApplyInput {
  noteId: string; userId: string; tokenId: string | null; agentLabel: string | null; op: EditOp;
  sectionId?: string; markdown?: string; ifMatch?: string; candidates: readonly VisibleNoteTarget[];
  blocks?: AnyPartialBlock[]; unbound?: number;
  /** With `blocks` (the create path, parsed earlier): how many knowledge comments the parse ignored. */
  ignoredKnowledgeComments?: number;
  contentLength?: number;
  /** #398: parsed outside the per-note queue so a slow parse doesn't hold it; errors still come after the section/fingerprint checks. */
  preparsed?: ParseOutcome;
}
export type ApplyResult =
  | {
      ok: true; editId: string; fingerprint: string; outline: NoteOutlineEntry[]; unboundWikilinks: number;
      /** Presence must use post-edit ids: the request's `section_id` is a heading id that `replace_section`/`delete_section` replace. Document order; always `[]` for `delete_section`. */
      afterBlockIds: string[];
      /** #108: index in the post-write outline (`edit_note` uses it to pick the page containing the landing point); null for `delete_section`. No REST consumer; kept because it can only be computed in `mergeDiff`, before `stripIds` drops blockIds. */
      afterSectionIndex: number | null;
      /** Only when the write did something to knowledge info. */
      knowledge?: KnowledgeWriteReport;
    }
  | { ok: false; code: "section_not_found" | "fingerprint_mismatch" | ParseError | "empty_section" | "too_complex"; detail?: ParseDetail; knowledge?: KnowledgeProblem };

export const RETENTION = AI_EDITS_RETENTION;
export class FingerprintMismatch extends Error {}

export interface MergeInput {
  targetIds: string[] | null; expectFingerprint: string | null; anchorId: string | null; diff: Uint8Array; afterIds: string[];
  expectEach?: Array<{ id: string; fp: string }>; anchorIds?: string[]; afterGroups?: string[][];
}
export interface MergeOutput { afterFingerprint: string | null; fingerprint: string; outline: NoteOutlineEntry[]; clock: number; afterSectionIndex: number | null; versionFingerprint: string | null; afterFingerprints?: (string | null)[] }

const stripIds = (o: { outline: Array<NoteOutlineEntry & { blockIds: string[] }> }): NoteOutlineEntry[] =>
  o.outline.map(({ blockIds: _b, ...e }) => e);

export async function mergeDiff(
  deps: ApplyDeps,
  noteId: string,
  ctx: DirectConnectionCtx,
  input: MergeInput,
  opts?: { beforeDisconnect?: (out: MergeOutput) => Promise<void> }
): Promise<MergeOutput> {
  return withDirectConnection(directTarget(deps.collab, deps.db), noteId, ctx, doc => {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const multi = input.expectEach !== undefined || input.anchorIds !== undefined || input.afterGroups !== undefined;
    if (multi) {
      if (input.targetIds !== null) throw new Error("mergeDiff：多期望不收 targetIds（接線錯）");
      if (!checkExpectations(fragment, input.expectEach ?? [], input.anchorIds ?? [])) throw new FingerprintMismatch();
      // expectEach ignores added blocks, so file write-back also requires the whole fingerprint.
      if (input.expectFingerprint !== null && outlineOf(fragment).whole !== input.expectFingerprint) throw new FingerprintMismatch();
    } else if (input.expectFingerprint !== null) {
      const live = input.targetIds === null ? outlineOf(fragment).whole : fingerprintForIds(fragment, input.targetIds);
      if (live === null || live !== input.expectFingerprint) throw new FingerprintMismatch(); // null = id missing or order changed: no fallback to the whole fingerprint
    }
    // Anchor recheck inside transact (revert only). No test fails if removed (`revertEdit` has no injection point for that interleaving); without it `insertBlocks` would target a vanished anchor (benign: nothing lost, the CRDT picks the position, but unguarded).
    if (input.anchorId !== null && !topLevelBlocks(fragment).some(c => c.getAttribute("id") === input.anchorId)) throw new FingerprintMismatch();
    const clock = docClock(doc);
    Y.applyUpdate(doc, input.diff);
    ctx.applied = true;
    let versionFp: string | null = null;
    try {
      versionFp = versionFingerprint(fragment);
    } catch {
      versionFp = null;
    }
    const merged = outlineOf(fragment);
    const afterFingerprint = input.afterIds.length === 0 ? null : fingerprintForIds(fragment, input.afterIds);
    // Must run before `stripIds(merged)` drops `blockIds`. `-1` isn't proven unreachable, so it degrades to `null` (the caller's `?? 0`).
    const firstAfter = input.afterIds[0];
    const afterIndex = firstAfter === undefined ? -1 : merged.outline.findIndex(s => s.blockIds.includes(firstAfter));
    const out: MergeOutput = {
      afterFingerprint,
      fingerprint: merged.whole,
      outline: stripIds(merged),
      clock,
      afterSectionIndex: afterIndex === -1 ? null : afterIndex,
      versionFingerprint: versionFp,
    };
    if (input.afterGroups !== undefined) out.afterFingerprints = fingerprintsOfGroups(fragment, input.afterGroups);
    return out;
  }, opts);
}

export class StaleBase extends Error {
  override name = "StaleBase";
}
export const DOC_MERGE_ATTEMPTS = 3;

export function mergeOutputOf(post: DocPost): MergeOutput {
  const out: MergeOutput = {
    afterFingerprint: post.afterFingerprint, fingerprint: post.fingerprint, outline: post.outline, clock: post.clock,
    afterSectionIndex: post.afterSectionIndex, versionFingerprint: post.versionFingerprint,
  };
  if (post.afterFingerprints !== undefined) out.afterFingerprints = post.afterFingerprints;
  return out;
}

/**
 * Merges only if the live doc didn't touch the blocks this write cares about (`post.guard`); with no watch, or if the doc was unloaded and reloaded meanwhile (a different object), only if its snapshot equals the base. Checked before opening the direct connection (opening and closing would persist an unchanged doc) and again inside transact. The returned fingerprints and outline are the worker's (base + this write, without concurrent typing), so the caller's next `if_match` may mismatch and it rereads; `clock` is the pre-merge live doc's (links CAS).
 */
export async function mergeAtBase(
  deps: ApplyDeps,
  noteId: string,
  ctx: DirectConnectionCtx,
  post: DocPost,
  watch: LiveWatch | undefined,
  opts?: { beforeDisconnect?: (out: MergeOutput) => Promise<void> }
): Promise<MergeOutput> {
  // Size cap is judged on the worker's result. Growth by collaboration during the merge isn't counted: collab updates aren't checked server-side and the web editor guards itself.
  if (deps.noteMaxBytes !== undefined && capBlocks(post.size, deps.noteMaxBytes)) throw new NoteTooLargeError(deps.noteMaxBytes, post.size.stateAfter);
  // Reverting a section delete: if the removed blocks came back to top level meanwhile (e.g. browser Ctrl+Z, same ids), don't merge, or the top level would hold duplicate ids.
  const absent = post.guard.kind === "blocks" ? (post.guard.absent ?? []) : [];
  const stillAbsent = (doc: Y.Doc): boolean => {
    if (absent.length === 0) return true;
    const top = new Set(topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id")));
    return !absent.some(id => top.has(id));
  };
  const mergeable = (doc: Y.Doc): boolean => stillAbsent(doc) && (watch !== undefined && watch.doc === doc ? !watch.conflicts(post.guard) : stateEquals(doc, post.baseSnapshot));
  const live = deps.collab.hocuspocus.documents.get(noteId);
  if (live && !mergeable(live)) throw new StaleBase();
  const afterOpen = deps.testHooks?.afterOpenDirect;
  return withDirectConnection(directTarget(deps.collab, deps.db), noteId, ctx, doc => {
    if (!mergeable(doc)) throw new StaleBase();
    const clock = docClock(doc);
    Y.applyUpdate(doc, post.diff);
    ctx.applied = true;
    return { ...mergeOutputOf(post), clock };
  }, { ...opts, ...(afterOpen ? { afterOpen } : {}) });
}

/**
 * Guards `note_ai_edits_fingerprint_chk`. "Non-empty `afterIds` but null fingerprint" should be unreachable (no test covers it); if it happened, inserting as-is would 500 after the content is persisted, leaving an unrevertable edit with no record. So record it as unrevertable and log an error.
 */
export function recordableAfter(deps: ApplyDeps, noteId: string, afterIds: string[], afterFingerprint: string | null): { afterBlockIds: string[]; afterFingerprint: string | null } {
  if (afterIds.length === 0 || afterFingerprint !== null) return { afterBlockIds: afterIds, afterFingerprint };
  deps.log.error({ noteId, afterIds }, "after_fingerprint 為 null 但 after_block_ids 非空（理論上到不了）——該列記為不可撤回");
  return { afterBlockIds: [], afterFingerprint: null };
}

export async function insertEditRecord(db: Db, row: typeof noteAiEdits.$inferInsert): Promise<string> {
  return db.transaction(async tx => {
    const [inserted] = await tx.insert(noteAiEdits).values(row).returning({ id: noteAiEdits.id });
    const keep = await tx.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, row.noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id)).limit(RETENTION);
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, row.noteId), notInArray(noteAiEdits.id, keep.map(k => k.id))));
    return inserted!.id;
  });
}

export async function updateNoteLinks(deps: ApplyDeps, p: { sourceNoteId: string; userId: string; clock: number } & ({ forkDoc: Y.Doc } | { targets: string[] })): Promise<void> {
  const from = "targets" in p ? { targets: p.targets } : { doc: p.forkDoc };
  return syncLinksFromDoc(deps, { sourceNoteId: p.sourceNoteId, userId: p.userId, clock: p.clock, ...from });
}

/** `whole` must be computed before prepare (prepare mounts on the fork and replaces blocks). */
export interface ForkChecked {
  fork: Y.Doc;
  sv: Uint8Array;
  outline: OutlineEntry[];
  whole: string;
  isEmptyDoc: boolean;
}
export async function forkAndCheck(deps: ApplyDeps, noteId: string): Promise<ForkChecked> {
  const { doc: fork } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, noteId);
  const sv = Y.encodeStateVector(fork);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(fragment);
  return { fork, sv, outline, whole, isEmptyDoc: topLevelBlocks(fragment).length === 0 };
}

async function prepareBlocks(
  deps: ApplyDeps,
  input: ApplyInput
): Promise<{ blocks: AnyPartialBlock[]; unbound: number; ignoredKnowledgeComments: number; written?: ShownLinks } | { error: ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem }> {
  if (input.op === "delete_section") return { blocks: [], unbound: 0, ignoredKnowledgeComments: 0 };
  // Create path: `content` was already parsed; don't parse again. No test fails if this reparses (equivalent behaviour).
  if (input.blocks !== undefined) return { blocks: input.blocks, unbound: input.unbound ?? 0, ignoredKnowledgeComments: input.ignoredKnowledgeComments ?? 0 };
  // Parse before opening the editor so no lease is held while waiting on the worker. A parse failure opens and writes nothing.
  const parsed = input.preparsed ?? (await deps.editing.parser.parse({ owner: input.userId, markdown: input.markdown ?? "", candidates: input.candidates, siteOrigin: siteOriginOf(deps.editing.baseUrl) }));
  if ("error" in parsed) return { error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}), ...(parsed.knowledge ? { knowledge: parsed.knowledge } : {}) };
  // #387: keep link texts the writer read as having no custom text, even if the target was renamed since.
  const [kept, cleared] = deps.shownLinks ? deps.shownLinks.keepLabelFree(parsed.blocks, input.userId, input.candidates) : [parsed.blocks, []];
  const ignoredKnowledgeComments = parsed.ignoredKnowledgeComments;
  if (!deps.shownLinks) return { blocks: kept, unbound: parsed.unbound, ignoredKnowledgeComments };
  // Written links are recorded for the writer too (agents write them back as-is using the reply's fingerprint), only after a successful merge. Cleared original texts are recorded too: the stored snapshotTitle is now the current title, so their expiry wouldn't be extended otherwise.
  const written = shownLinkTextsOf(kept, new Map());
  written.free.push(...cleared);
  return { blocks: kept, unbound: parsed.unbound, ignoredKnowledgeComments, written };
}

/**
 * The editor lives only until the diff is taken; never acquire a lease while holding one. After the merge nothing needs it: `mergeDiff` only touches Yjs structures and `updateNoteLinks` uses the fork `Y.Doc` (`unmount()` leaves doc content alone).
 */
export async function prepareEdit(
  deps: ApplyDeps,
  input: ApplyInput,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: { op: EditOp; isEmptyDoc: boolean; section: OutlineEntry | undefined }
): Promise<{ diff: Uint8Array; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; unbound: number; written?: ShownLinks } | { error: ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem }> {
  const { op, isEmptyDoc, section } = plan;
  const b = await prepareBlocks(deps, input);
  if ("error" in b) return b;
  const { blocks, unbound, written } = b;
  const r = await editOnFork(deps.editing, fork, sv, { op, isEmptyDoc, section }, blocks);
  return { ...r, unbound, ...(written ? { written } : {}) };
}

export async function applyEdit(deps: ApplyDeps, input: ApplyInput): Promise<ApplyResult> {
  const b = await prepareBlocks(deps, input);
  const parseError = "error" in b ? { error: b.error, ...(b.detail ? { detail: b.detail } : {}), ...(b.knowledge ? { knowledge: b.knowledge } : {}) } : undefined;
  const blocks = "error" in b ? undefined : b.blocks;
  for (let attempt = 0; attempt < DOC_MERGE_ATTEMPTS; attempt++) {
    const { state, watch } = await loadNoteState(deps, input.noteId, { watch: true });
    let r: Exclude<Awaited<ReturnType<typeof deps.editing.runDoc<"edit">>>, typeof DOC_TOO_COMPLEX>;
    let merged: MergeOutput;
    try {
      const out = await deps.editing.runDoc(
        input.userId,
        {
          kind: "edit", state, op: input.op, noteId: input.noteId,
          ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
          ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {}),
          ...(blocks !== undefined && input.op !== "delete_section" ? { blocks } : {}),
          ...(parseError ? { parseError } : {}),
        },
        { extraWeight: input.markdown?.length ?? input.contentLength ?? (blocks ? JSON.stringify(blocks).length : 0) }
      );
      if (out === DOC_TOO_COMPLEX) return input.blocks !== undefined ? { ok: false, code: "unsupported_block", detail: "too_complex" } : { ok: false, code: "too_complex" };
      if (!out.ok) return out;
      r = out;
      if (deps.testHooks?.beforeMerge) await deps.testHooks.beforeMerge();
      const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
      try {
        merged = await mergeAtBase(deps, input.noteId, ctx, r.post, watch);
      } catch (err) {
        if (err instanceof StaleBase) continue;
        throw err;
      }
    } finally {
      watch?.stop();
    }
    const { beforeBlocks, afterIds, anchor } = r;
    const unbound = "error" in b ? 0 : b.unbound;
    const knowledge: KnowledgeWriteReport = { ...r.knowledge, ignoredComments: "error" in b ? 0 : b.ignoredKnowledgeComments };
    if (!("error" in b) && b.written) deps.shownLinks?.record(input.userId, b.written);
    if (deps.testHooks?.beforeRecord) await deps.testHooks.beforeRecord();
    const editId = await insertEditRecord(deps.db, {
      noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: input.op,
      sectionId: input.sectionId ?? null, beforeBlocks, anchor,
      ...recordableAfter(deps, input.noteId, afterIds, merged.afterFingerprint),
    });
    if (deps.testHooks?.afterRecord) await deps.testHooks.afterRecord();
    await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, targets: r.post.linkTargets, clock: merged.clock });
    // Use the worker's raw `afterIds`, not `recordableAfter`'s (which empties them in the degenerate case).
    return { ok: true, editId, fingerprint: merged.fingerprint, outline: merged.outline, unboundWikilinks: unbound, afterBlockIds: afterIds, afterSectionIndex: merged.afterSectionIndex, ...(isEmptyKnowledgeReport(knowledge) ? {} : { knowledge }) };
  }
  throw new ParserBusyError();
}
