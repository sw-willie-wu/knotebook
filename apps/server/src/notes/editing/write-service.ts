/**
 * All write paths for a note must share one `NoteWriteQueue` (`buildApp` creates it once): serialization underpins the #137 corruption fix and the revert idempotency guard (see `queue.ts`). Authorization and rate limiting are deliberately not here: they answer differently on REST and MCP.
 * Presence targets must come from `presenceTargetForWrite(op, afterBlockIds)`, never the request's `section_id` (a heading id that may no longer exist after the write).
 * Test gaps: `applyDeps()`'s throw is unreachable and unguarded (`create_note` skips the deployment-shape gate, so it's the only thing that speaks up); `write-body-limit.test.ts` derives its cases from `WRITE_BODY_LIMIT`, so only the hard-coded 300000 tests in `note-edits.test.ts`/`mcp-endpoint.test.ts` notice the value changing, and only upwards.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { knowledgeWriteProblem, resolveKnowledgeForWrite, type EditOp, type KnowledgeBlockShape, type KnowledgeProblem } from "@knotebook/shared";
import { currentAgentLabel } from "../../auth/agent-label.js";
import type { CollabServer } from "../../collab/server.js";
import type { VersionService } from "../../collab/versions.js";
import type { Db } from "../../db/index.js";
import { noteAiEdits, notes, transferBases, transferCreates } from "../../db/schema.js";
import { isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError, pgErrorSummary } from "../../db/pg-errors.js";
import type { FixedWindowLimiter } from "../../http/rate-limit.js";
import { redactDbError } from "../../lib/redact-db-error.js";
import { hmacOf } from "../../transfer/base-hash.js";
import { diffLines, hashAgentLines } from "../../transfer/line-diff.js";
import { bodyLines } from "../../transfer/normalize.js";
import { fileSyncRows } from "../../transfer/sync-apply.js";
import type { PlanSyncError } from "../../transfer/sync-plan.js";
import { planNewNoteTags, planTagsWrite, type TagsPlan } from "../../transfer/sync-tags.js";
import { recordFileSyncInTx } from "../../transfer/tx/record-file-sync.js";
import { writeSyncTagsInTx, type SyncTagsOutcome } from "../../transfer/tx/sync-tags.js";
import { tagSpaceOf } from "../../tags/space.js";
import { CreateTagsError, createNoteWithTagsInTx } from "../tx/create-with-tags.js";
import { loadCreateTarget } from "../create-target.js";
import { insertNoteWithAutoSlug } from "../create.js";
import { NoteTooLargeError } from "../note-size.js";
import { renameNoteTitle, type RenameOutcome } from "../rename-note.js";
import { resolveNoteAccess, type NoteAccess } from "../service.js";
import type { SlugScope } from "../slug.js";
import type { NoteVersionRow } from "../tx/versions.js";
import { applyEdit, mergeAtBase, recordableAfter, StaleBase, updateNoteLinks, type ApplyDeps, type ApplyResult, type EditingTestHooks, type MergeOutput } from "./apply.js";
import { DOC_TOO_COMPLEX, type AskFn, type SyncApplyDocResult } from "./doc-jobs.js";
import { applyVersionEdit, type ApplyVersionFailureCode, type ApplyVersionInput } from "./apply-version.js";
import { visibleNoteTargets, type VisibleNoteTarget } from "./candidates.js";
import { loadNoteState, titlesAsk } from "./read.js";
import { siteOriginOf, type ParseDetail, type ParsedMarkdown, type ParseError } from "./markdown.js";
import { isEmptyKnowledgeReport, type KnowledgeWriteReport } from "./knowledge-write.js";
import { ParserBusyError, type ParseOutcome } from "./parse-core.js";
import { presenceIdentity, presenceTargetForWrite, type PresenceRegistry, type PresenceTarget } from "./presence.js";
import { NoteWriteQueue, QueueBusyError } from "./queue.js";
import { revertEdit, type RevertResult } from "./revert.js";
import type { EditingRuntime } from "./runtime.js";
import { NoteGoneError, type DirectCtx } from "./session.js";
import { ShownLinkTexts, shownLinkTextsOf } from "./shown-link-texts.js";

export type ApplyOk = Extract<ApplyResult, { ok: true }>;
export type ApplyFailureCode = Extract<ApplyResult, { ok: false }>["code"];
export type RevertOk = Extract<RevertResult, { ok: true }>;
export type RevertFailureCode = Extract<RevertResult, { ok: false }>["code"];

/** Two type parameters because `applyEdit` and `revertEdit` have different failure codes; one shared union would stop revert's codes narrowing (TS2322). */
export type WriteOutcome<T, C> =
  | { ok: true; result: T; agentLabel: string | null }
  | { ok: false; kind: "busy" }
  | { ok: false; kind: "gone" }
  | { ok: false; kind: "apply"; code: C; detail?: ParseDetail; knowledge?: KnowledgeProblem };
export type ParserBusy = { ok: false; kind: "parser_busy" };
export type TooLarge = { ok: false; kind: "too_large"; limitBytes: number };

export type PreparedContent = { ok: true; candidates: readonly VisibleNoteTarget[]; agentLabel: string | null; prepared: ParsedMarkdown };
export type PrepareContentFailure = { ok: false; kind: "parse"; code: ParseError; detail?: ParseDetail; knowledge?: KnowledgeProblem };

export type CreateWithContentResult =
  | { ok: true; noteId: string; inserted: typeof notes.$inferSelect; unbound: number; knowledge?: KnowledgeWriteReport }
  | PrepareContentFailure
  | ParserBusy
  | TooLarge
  | { ok: false; kind: "internal" };

export type SaveVersionOutcome = { ok: true; row: NoteVersionRow; upgraded: boolean } | { ok: false; kind: "busy" | "note-deleted" };

export const SYNC_MERGE_ATTEMPTS = 3;

export interface SyncFileInput {
  noteId: string;
  userId: string;
  userHandle: string;
  tokenId: string | null;
  access: NoteAccess;
  baseKey: string;
  /** undefined = no title line: don't rename. */
  title: string | undefined;
  /** undefined = no tags line: leave the tags alone. */
  tags: string[] | undefined;
  /** Already `normalizeBody`'d (compared by HMAC). */
  body: string;
  key: Buffer;
  keyId: string;
  limiters: { transferWrite: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
}
export interface SyncFileOk {
  ok: true;
  result: "unchanged" | "applied" | "renamed" | "tagged";
  applied: number;
  same: number;
  editIds: string[];
  unboundWikilinks: number;
  renamed: boolean;
  /** Content was written but the title changed just before the rename (the rename and the unchanged-title check are one UPDATE). */
  renameFailed?: "gone" | "ownership_changed" | "title_changed";
  /** The tags were written. */
  tagsChanged: boolean;
  /** The body or title was written but the tags were not; nothing is rolled back. */
  tagsFailed?: "not_found" | "conflict" | "tag_limit_reached" | "changed_meanwhile" | "failed";
  knowledge?: KnowledgeWriteReport;
  diffOverflow: boolean;
  anchored: number;
  degradedLines: number;
}
/** = transfer token TTL. */
export const CREATE_DEDUPE_MINUTES = 30;
export interface CreateFromFileInput {
  userId: string;
  userHandle: string;
  tokenId: string | null;
  fileSha: Buffer;
  keyId: string;
  title: string | undefined;
  tags: string[] | undefined;
  body: string;
  dest: { scope: SlugScope; folderId: string | null };
  limiters: { transferWrite: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
}
export type CreateFromFileOutcome =
  | { ok: true; created: boolean; noteId: string; unboundWikilinks: number; knowledge?: KnowledgeWriteReport }
  | { ok: false; kind: "invalid_tag_name" | "tags_forbidden" }
  | { ok: false; kind: "tag_limit_reached"; limit: number }
  | PrepareContentFailure
  | ParserBusy
  | TooLarge
  | { ok: false; kind: "rate_limited"; retryAfterMs: number }
  | { ok: false; kind: "folder_gone" | "busy" | "internal" };

export type BaseUnavailableReason = "already_sent" | "other_note" | "expired" | "note_changed" | "reverted";

export type SyncFileOutcome =
  | SyncFileOk
  | { ok: false; kind: "base_unavailable"; reason: BaseUnavailableReason }
  | { ok: false; kind: "not_mergeable" | "busy" | "gone" }
  | { ok: false; kind: "invalid_tag_name" | "tags_forbidden" | "tags_conflict" }
  | { ok: false; kind: "tag_limit_reached"; limit: number }
  | { ok: false; kind: "rate_limited"; retryAfterMs: number }
  | { ok: false; kind: "parse"; code: PlanSyncError; detail?: ParseDetail; fence?: string; knowledge?: KnowledgeProblem }
  | ParserBusy
  | TooLarge
  | { ok: false; kind: "note_too_complex" };

export interface NoteWriteServiceDeps {
  db: Db;
  collab?: CollabServer;
  editing?: EditingRuntime;
  presence?: PresenceRegistry;
  queueWaitMs?: number;
  testHooks?: EditingTestHooks;
  versions?: VersionService;
  renameHook?: (candidate: string) => void | Promise<void>;
  shownLinks?: ShownLinkTexts;
  noteMaxBytes?: () => number;
}

export class NoteWriteService {
  /** The only `new NoteWriteQueue()` in the tree: it must stay a single instance shared by `notesRoutes` and `mcpRoutes`. */
  private readonly queue = new NoteWriteQueue();

  readonly shownLinks: ShownLinkTexts;

  constructor(private readonly deps: NoteWriteServiceDeps) {
    this.shownLinks = deps.shownLinks ?? new ShownLinkTexts();
  }

  get noteMaxBytes(): number | undefined {
    return this.deps.noteMaxBytes?.();
  }

  get available(): boolean {
    return this.deps.collab !== undefined && this.deps.editing !== undefined;
  }

  /** Callers must check `available` first; the throw is unreachable today and exists so a missed check can't degrade into dereferencing undefined. */
  private applyDeps(log: FastifyBaseLogger): ApplyDeps {
    const { collab, editing } = this.deps;
    if (!collab || !editing) throw new Error("NoteWriteService：此部署沒有 collab／editing，呼叫端必須先檢查 available");
    const noteMaxBytes = this.deps.noteMaxBytes?.();
    return { db: this.deps.db, collab, editing, log, testHooks: this.deps.testHooks, versions: this.deps.versions, shownLinks: this.shownLinks, ...(noteMaxBytes !== undefined ? { noteMaxBytes } : {}) };
  }

  /** Runs on this service's queue (serialized with MCP writes, version apply and manual save); the caller sets the wait (conversions use 1 s) and a timeout throws `QueueBusyError`. `fn` must not call a method that enters the same note's `queue.run` (e.g. `saveVersion`): it would wait for itself. */
  async runExclusive<T>(log: ApplyDeps["log"], noteId: string, waitMs: number, fn: (deps: ApplyDeps) => Promise<T>): Promise<T> {
    const { collab, editing } = this.deps;
    if (!collab || !editing) throw new Error("NoteWriteService：此部署沒有 collab／editing，呼叫端必須先檢查 available");
    const deps: ApplyDeps = { db: this.deps.db, collab, editing, log, testHooks: this.deps.testHooks, versions: this.deps.versions };
    return this.queue.run(noteId, () => fn(deps), waitMs);
  }

  /** Condition copied from REST's `tokenId && agentLabel`. No test fails if it's removed (a cookie write has null tokenId and agentLabel); `tsc` enforces it (`touch` takes `string`). Don't change it to `?.` or add `!`. */
  private touch(noteId: string, tokenId: string | null, userHandle: string, agentLabel: string | null, target: PresenceTarget): void {
    if (tokenId && agentLabel) {
      this.deps.presence?.touch(noteId, tokenId, presenceIdentity(userHandle, agentLabel), target);
    }
  }

  async applyToNote(
    log: FastifyBaseLogger,
    input: {
      noteId: string;
      userId: string;
      userHandle: string;
      tokenId: string | null;
      op: EditOp;
      sectionId?: string;
      markdown?: string;
      ifMatch?: string;
    }
  ): Promise<WriteOutcome<ApplyOk, ApplyFailureCode> | ParserBusy | TooLarge> {
    // Prefetch the writer's visible notes before the lease so parsing needs no DB while it is held.
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    // Parse before entering the note's queue: parsing can take seconds and must not block other writes to the note; the merge's fingerprint check still covers edits made meanwhile.
    let preparsed: ParseOutcome | undefined;
    if (input.op !== "delete_section" && input.markdown !== undefined) {
      try {
        preparsed = await applyDeps.editing.parser.parse({ owner: input.userId, markdown: input.markdown, candidates, siteOrigin: siteOriginOf(applyDeps.editing.baseUrl) });
      } catch (err) {
        if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
        throw err;
      }
    }
    let result: ApplyResult;
    try {
      result = await this.queue.run(
        input.noteId,
        () =>
          applyEdit(applyDeps, {
            noteId: input.noteId,
            userId: input.userId,
            tokenId: input.tokenId,
            agentLabel,
            op: input.op,
            sectionId: input.sectionId,
            markdown: input.markdown,
            ifMatch: input.ifMatch,
            candidates,
            ...(preparsed !== undefined ? { preparsed } : {}),
          }),
        this.deps.queueWaitMs
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code, ...(result.detail ? { detail: result.detail } : {}), ...(result.knowledge ? { knowledge: result.knowledge } : {}) };
    // Target from post-edit `afterBlockIds`, not `sectionId` (a heading id that replace_section/delete_section may have replaced).
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, presenceTargetForWrite(input.op, result.afterBlockIds));
    return { ok: true, result, agentLabel };
  }

  async revert(
    log: FastifyBaseLogger,
    input: { noteId: string; editId: string; userId: string; userHandle: string; tokenId: string | null }
  ): Promise<WriteOutcome<RevertOk, RevertFailureCode> | ParserBusy | TooLarge> {
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    let result: RevertResult;
    try {
      result = await this.queue.run(
        input.noteId,
        () => revertEdit(applyDeps, { noteId: input.noteId, editId: input.editId, userId: input.userId, tokenId: input.tokenId, agentLabel }),
        this.deps.queueWaitMs
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    // `RevertResult` carries no sectionId and the reverted section may be gone: land on doc start.
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, { kind: "doc-start" });
    return { ok: true, result, agentLabel };
  }

  async applyVersion(log: FastifyBaseLogger, input: ApplyVersionInput): Promise<WriteOutcome<{ applied: true }, ApplyVersionFailureCode> | TooLarge> {
    const versions = this.deps.versions;
    if (!versions) throw new Error("NoteWriteService：沒有版本服務（app.ts 一定會注入；直接 new 本 service 的測試要自己帶）");
    const deps = { ...this.applyDeps(log), versions };
    let result: Awaited<ReturnType<typeof applyVersionEdit>>;
    try {
      result = await this.queue.run(input.noteId, () => applyVersionEdit(deps, input), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    return { ok: true, result: { applied: true }, agentLabel: null };
  }

  async saveVersion(log: FastifyBaseLogger, input: { noteId: string; userId: string; name: string | null }): Promise<SaveVersionOutcome> {
    const versions = this.deps.versions;
    if (!versions) throw new Error("NoteWriteService：沒有版本服務");
    try {
      return await this.queue.run(
        input.noteId,
        async (): Promise<SaveVersionOutcome> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const { doc, transient } = await versions.docFor(input.noteId);
            const r = await versions.cutIfDirty(input.noteId, doc, { kind: "manual", name: input.name, extraEditors: [{ userId: input.userId, agentLabel: null }], transient });
            if (r === null) continue;
            if ("skipped" in r) return r.skipped === "note-deleted" ? { ok: false, kind: "note-deleted" } : { ok: false, kind: "busy" };
            return { ok: true, row: r.row, upgraded: r.upgraded };
          }
          log.warn({ noteId: input.noteId }, "手動儲存版本：兩次都撞到基底或空間變動");
          return { ok: false, kind: "busy" };
        },
        this.deps.queueWaitMs,
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      throw err;
    }
  }

  /**
   * Once the note was touched since download (title or body) the result is always 409 `note_changed`: no three-way merge. Everything runs inside one `queue.run(noteId)`. Copies that already wrote back are checked first (`already_sent`/`reverted`): the note was changed by that copy itself, so `note_changed` would be wrong. "Touched" is a content comparison, not `updated_at`: per-block fingerprints against the base segment table (a linked note being renamed or made invisible doesn't count); a base with 0 blocks and now exactly one empty paragraph (browser normalization) counts as untouched. A zero-region result is treated as unchanged and the write quota is refunded. A copy that already wrote its body accepts no further change, title-only included (`already_sent`). `unchanged` charges `tokenRead` regardless of whether others touched the note. A body change with null segments → `not_mergeable`. A parse failure → 400 and the charge is kept. A fingerprint mismatch retries up to 3 times. Tags are written last, in their own transaction; once the body or title is written, a tags failure is reported as `tagsFailed` and nothing is rolled back. "The tags are still what the copy had" is checked when the file is read and again inside that transaction, which can't see a tags change committed at the same moment: the later write wins. DB calls carrying content go through `redactDbError`.
   * Known gaps (not fixed): for title-only changes the body check and the rename aren't one transaction (body in Yjs, title in the DB), and a title change landing between reading the title and the merge goes undetected when the file didn't change the title.
   */
  async syncFile(log: FastifyBaseLogger, input: SyncFileInput): Promise<SyncFileOutcome> {
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    try {
      return await this.queue.run(input.noteId, () => this.syncFileInQueue(log, applyDeps, input, candidates, agentLabel), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
  }

  private async syncFileInQueue(
    log: FastifyBaseLogger,
    applyDeps: ApplyDeps,
    input: SyncFileInput,
    candidates: readonly VisibleNoteTarget[],
    agentLabel: string | null,
  ): Promise<SyncFileOutcome> {
    const db = this.deps.db;
    const hooks = this.deps.testHooks;
    const [base] = await db
      .select()
      .from(transferBases)
      .where(and(eq(transferBases.key, input.baseKey), eq(transferBases.userId, input.userId), eq(transferBases.noteId, input.noteId)))
      .limit(1);
    if (!base) {
      const [other] = await db.select({ key: transferBases.key }).from(transferBases).where(eq(transferBases.key, input.baseKey)).limit(1);
      return { ok: false, kind: "base_unavailable", reason: other ? "other_note" : "expired" };
    }
    if (base.keyId !== input.keyId) return { ok: false, kind: "base_unavailable", reason: "expired" };
    const salt = Buffer.from(base.salt);
    const bodySha = hmacOf(input.key, salt, input.body);
    const applied = base.appliedBodySha === null ? null : Buffer.from(base.appliedBodySha);
    const copyTitle = Buffer.from(base.appliedTitleSha ?? base.titleSha);
    const fileTitleSha = input.title === undefined ? null : hmacOf(input.key, salt, input.title);
    const titleChanged = fileTitleSha !== null && !fileTitleSha.equals(copyTitle);
    const copyTags = base.appliedTagsSha ?? base.tagsSha;
    let tagsPlan: TagsPlan | undefined;
    const planTags = async (): Promise<TagsPlan> =>
      (tagsPlan ??= await planTagsWrite(db, { noteId: input.noteId, fileTags: input.tags, access: input.access, copySha: copyTags === null ? null : Buffer.from(copyTags), key: input.key, salt }));
    let bodyChanged: boolean;
    if (applied === null) bodyChanged = !bodySha.equals(Buffer.from(base.bodySha));
    else if (bodySha.equals(applied)) {
      const ids = base.appliedEditIds ?? [];
      if (ids.length > 0) {
        const [rev] = await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(and(inArray(noteAiEdits.id, ids), isNotNull(noteAiEdits.revertedAt))).limit(1);
        if (rev) return { ok: false, kind: "base_unavailable", reason: "reverted" };
      }
      if (titleChanged || (await planTags()).kind !== "unchanged") return { ok: false, kind: "base_unavailable", reason: "already_sent" };
      bodyChanged = false;
    } else return { ok: false, kind: "base_unavailable", reason: "already_sent" };

    const plan = await planTags();
    if (plan.kind === "note_changed") return { ok: false, kind: "base_unavailable", reason: "note_changed" };
    if (plan.kind === "invalid_tag_name" || plan.kind === "tags_forbidden") return { ok: false, kind: plan.kind };
    if (plan.kind === "tag_limit_reached") return { ok: false, kind: "tag_limit_reached", limit: plan.limit };

    const out: SyncFileOk = {
      ok: true, result: "unchanged", applied: 0, same: 0, editIds: [], unboundWikilinks: 0, renamed: false, tagsChanged: false, diffOverflow: false, anchored: 0, degradedLines: 0,
    };
    const tokenReadKey = `token:${input.userId}`;
    if (!bodyChanged && !titleChanged && plan.kind !== "change") {
      if (!input.limiters.tokenRead.consume(tokenReadKey)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(tokenReadKey) };
      return out;
    }
    if (bodyChanged && base.segments === null) return { ok: false, kind: "not_mergeable" };
    // Unchanged files don't touch the quota. Body changed: charge before parsing (a failed parse counts), refunded for a zero region; title-only and tags-only: charge before the rename or the tags write. Once the quota is exhausted a body-changed file always gets 429, zero-region ones too, since telling needs a parse.

    const noteChanged: SyncFileOutcome = { ok: false, kind: "base_unavailable", reason: "note_changed" };
    // A tags-only file changes nothing that the copy's body or title describe, so it isn't held to them.
    const tagsOnly = !bodyChanged && !titleChanged;
    let currentTitle = "";
    if (!tagsOnly) {
      const [row] = await db.select({ title: notes.title }).from(notes).where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt))).limit(1);
      if (!row) return { ok: false, kind: "gone" };
      if (!hmacOf(input.key, salt, row.title).equals(copyTitle)) return noteChanged;
      currentTitle = row.title;
    }

    let charged = false;
    let chargeTicket: number | null = null;
    let firstWritten: string | null = null;
    let contentWritten = false;

    const editing = applyDeps.editing;
    const baseBodySha = Buffer.from(base.bodySha);
    let diffIn: { agentLines: string[]; diff: Awaited<ReturnType<typeof diffLines>> } | null = null;
    if (bodyChanged) {
      const agentLines = bodyLines(input.body);
      const agent = await hashAgentLines(input.key, salt, agentLines);
      const diff = await diffLines({ hashes: Buffer.from(base.lineHashes), kinds: Buffer.from(base.lineKinds) }, agent);
      out.diffOverflow = diff.overflow;
      out.anchored = diff.anchored;
      out.degradedLines = diff.degradedLines;
      diffIn = { agentLines, diff };
    }
    let merged: MergeOutput | null = null;
    let syncApplied: SyncApplyDocResult | null = null;
    const fileBudget = applyDeps.editing.parser.fileBudget();
    let zeroRegion = false;
    let bodyChecked = tagsOnly;
    // The worker's two questions are answered here; the write quota is charged before parsing (a 400 parse failure still counts, like `edit_note` charging first) and not again on retries.
    const titles = titlesAsk(db, input.userId);
    let rateLimited = false;
    const ask: AskFn = async q => {
      if (q.kind === "titles") return titles(q);
      if (charged) return true;
      chargeTicket = input.limiters.transferWrite.consumeTicket(input.userId);
      if (chargeTicket === null) {
        rateLimited = true;
        return false;
      }
      charged = true;
      return true;
    };
    for (let attempt = 0; attempt < SYNC_MERGE_ATTEMPTS && merged === null && !zeroRegion && !bodyChecked; attempt++) {
      const { state, watch } = await loadNoteState(applyDeps, input.noteId, { watch: true });
      try {
        const budgetMs = fileBudget.remainingMs;
        const r = await editing.runDoc(
          input.userId,
          {
            kind: "syncPlan", state: new Uint8Array(state), owner: input.userId, segments: base.segments, baseLineCount: base.lineKinds.length,
            body: diffIn === null ? null : { agentLines: diffIn.agentLines, diff: diffIn.diff },
            candidates, siteOrigin: siteOriginOf(editing.baseUrl), key: new Uint8Array(input.key), salt: new Uint8Array(salt), baseBodySha: new Uint8Array(baseBodySha), budgetMs,
          },
          // Remaining budget + one time limit for the whole-export comparison (segments null); the "+ 1×" must match QUEUE_WAIT_TIMEOUT_FACTOR (4 = 3 + 1).
          { ask, extraWeight: input.body.length, timeoutMs: Math.max(0, budgetMs) + editing.parser.timeoutMs() },
        );
        if (r === DOC_TOO_COMPLEX) {
          fileBudget.remainingMs = 0;
          return { ok: false, kind: "parse", code: "unsupported_block", detail: "too_complex" };
        }
        fileBudget.remainingMs = r.budgetLeft;
        if (r.kind === "note_changed") return noteChanged;
        if (r.kind === "rate_limited" || rateLimited) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
        if (r.kind === "body_checked") {
          bodyChecked = true;
          break;
        }
        if (r.kind === "parse") return { ok: false, kind: "parse", code: r.code, ...(r.detail ? { detail: r.detail } : {}), ...(r.fence ? { fence: r.fence } : {}), ...(r.knowledge ? { knowledge: r.knowledge } : {}) };
        if (r.kind === "zero_region") {
          // Zero regions (e.g. only blank lines added): refund, and don't write `applied_body_sha`, so a later title-only change from this copy is a normal rename, not `already_sent`.
          if (chargeTicket !== null) input.limiters.transferWrite.refund(input.userId, chargeTicket);
          charged = false;
          out.same = r.same;
          zeroRegion = true;
          break;
        }
        const a = await editing.runDoc(input.userId, { kind: "syncApply", state, plan: r.plan, normalizedId: r.normalizedId, noteId: input.noteId }, { extraWeight: input.body.length });
        if (a === DOC_TOO_COMPLEX) return { ok: false, kind: "note_too_complex" };
        if ("kind" in a) return { ok: false, kind: "parse", code: "invalid_knowledge", knowledge: a.knowledge };
        if (hooks?.beforeMerge) await hooks.beforeMerge();
        const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel, applied: false };
        try {
          merged = await mergeAtBase(applyDeps, input.noteId, ctx, a.post, watch);
        } catch (err) {
          if (err instanceof StaleBase) continue;
          throw err;
        }
        syncApplied = a;
      } finally {
        watch?.stop();
      }
    }
    if (!bodyChecked && !zeroRegion && merged === null) return { ok: false, kind: "busy" };
    if (syncApplied !== null && merged !== null) {
      if (hooks?.beforeRecord) await hooks.beforeRecord();
      const { rows } = fileSyncRows({
        noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel,
        decisions: syncApplied.decisions, perRegion: syncApplied.perRegion, afterFingerprints: merged.afterFingerprints ?? [],
        recordable: (ids, fp) => recordableAfter(applyDeps, input.noteId, ids, fp),
      });
      const recordInput = { noteId: input.noteId, baseKey: base.key, appliedBodySha: bodySha, rows };
      try {
        out.editIds = await db.transaction(tx => recordFileSyncInTx(tx, recordInput));
      } catch (err) {
        throw redactDbError(log, err, "寫入檔案同步紀錄");
      }
      if (hooks?.afterRecord) await hooks.afterRecord();
      await updateNoteLinks(applyDeps, { sourceNoteId: input.noteId, userId: input.userId, targets: syncApplied.post.linkTargets, clock: merged.clock });
      out.applied = syncApplied.decisions.filter(d => d.mark === "applied").length;
      out.same = syncApplied.decisions.filter(d => d.mark === "same").length;
      out.unboundWikilinks = syncApplied.unbound;
      if (!isEmptyKnowledgeReport(syncApplied.knowledge)) out.knowledge = syncApplied.knowledge;
      out.result = "applied";
      contentWritten = true;
      const firstIdx = syncApplied.decisions.findIndex(d => d.mark !== "same" && d.kind !== "delete");
      firstWritten = firstIdx === -1 ? null : (syncApplied.perRegion[firstIdx]!.afterIds[0] ?? null);
    }

    if (titleChanged) {
      if (!contentWritten && !charged) {
        if (!input.limiters.transferWrite.consume(input.userId)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
        charged = true;
      }
      let r: RenameOutcome;
      try {
        r = await renameNoteTitle(db, { noteId: input.noteId, access: input.access, title: input.title!, expectTitle: currentTitle }, this.deps.renameHook);
      } catch (err) {
        throw redactDbError(log, err, "檔案寫回改名");
      }
      if (r.kind === "renamed") {
        try {
          await db.update(transferBases).set({ appliedTitleSha: fileTitleSha, lastUsedAt: sql`now()` }).where(eq(transferBases.key, base.key));
        } catch (err) {
          throw redactDbError(log, err, "寫入檔案同步基底");
        }
        out.renamed = true;
        if (!contentWritten) out.result = "renamed";
      } else if (!contentWritten && r.kind === "gone") {
        return { ok: false, kind: "gone" };
      } else if (!contentWritten && r.kind === "title_changed") {
        return noteChanged;
      } else {
        out.renameFailed = r.kind;
      }
    }

    if (plan.kind === "change") {
      const written = contentWritten || out.renamed;
      if (!charged) {
        if (!input.limiters.transferWrite.consume(input.userId)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
        charged = true;
      }
      if (hooks?.beforeTags) await hooks.beforeTags();
      const tagsInput = { noteId: input.noteId, expected: { ownerId: input.access.ownerId, groupId: input.access.groupId }, names: plan.names, createdBy: input.userId, currentKey: plan.currentKey };
      const afterLock = hooks?.afterTagsLock;
      const afterWrite = hooks?.afterTagsWrite;
      let tagsOut: SyncTagsOutcome | "failed";
      let failure: Error | null = null;
      try {
        tagsOut = await db.transaction(tx => writeSyncTagsInTx(tx, tagsInput, afterLock, afterWrite));
      } catch (err) {
        failure = redactDbError(log, err, "檔案寫回改標籤");
        tagsOut = "failed";
      }
      if (tagsOut !== "failed" && tagsOut.kind === "ok") {
        try {
          await db.update(transferBases).set({ appliedTagsSha: plan.fileSha, lastUsedAt: sql`now()` }).where(eq(transferBases.key, base.key));
        } catch (err) {
          throw redactDbError(log, err, "寫入檔案同步基底");
        }
        out.tagsChanged = true;
        if (!written) out.result = "tagged";
      } else if (written) {
        out.tagsFailed = tagsOut === "failed" || tagsOut.kind === "invalid_tag_name" ? "failed" : tagsOut.kind;
      } else if (tagsOut === "failed") {
        throw failure!;
      } else if (tagsOut.kind === "not_found") {
        return { ok: false, kind: "gone" };
      } else if (tagsOut.kind === "conflict") {
        return { ok: false, kind: "tags_conflict" };
      } else if (tagsOut.kind === "changed_meanwhile") {
        return noteChanged;
      } else if (tagsOut.kind === "tag_limit_reached") {
        return { ok: false, kind: "tag_limit_reached", limit: tagsOut.limit };
      } else {
        return { ok: false, kind: "invalid_tag_name" };
      }
    }

    if (!contentWritten && !out.renamed && !out.tagsChanged) {
      if (!charged && !input.limiters.tokenRead.consume(tokenReadKey)) {
        return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(tokenReadKey) };
      }
      return out;
    }
    if (contentWritten) this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, firstWritten === null ? { kind: "doc-start" } : { kind: "block", blockId: firstWritten });
    return out;
  }

  /** Serialization key `create:${userId}:${fileSha}` (no note id yet). Dedupe rows outside the TTL, or whose note is in the trash, would collide on the PK, hence upsert. A parse failure leaves no note and no dedupe row. */
  async createFromFile(log: FastifyBaseLogger, input: CreateFromFileInput): Promise<CreateFromFileOutcome> {
    const key = `create:${input.userId}:${input.fileSha.toString("hex")}`;
    try {
      return await this.queue.run(key, () => this.createFromFileInQueue(log, input), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      throw err;
    }
  }

  private async createFromFileInQueue(log: FastifyBaseLogger, input: CreateFromFileInput): Promise<CreateFromFileOutcome> {
    const db = this.deps.db;
    const [hit] = await db
      .select({ noteId: transferCreates.noteId })
      .from(transferCreates)
      .where(and(eq(transferCreates.userId, input.userId), eq(transferCreates.fileSha, input.fileSha), eq(transferCreates.keyId, input.keyId), sql`${transferCreates.createdAt} > now() - make_interval(mins => ${CREATE_DEDUPE_MINUTES}::int)`))
      .limit(1);
    if (hit && (await resolveNoteAccess(db, input.userId, hit.noteId)).role !== "none") {
      const k = `token:${input.userId}`;
      if (!input.limiters.tokenRead.consume(k)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(k) };
      return { ok: true, created: false, noteId: hit.noteId, unboundWikilinks: 0 };
    }
    // Everything that can refuse the tags is decided before the quota is charged or a row exists.
    let tagNames: string[] = [];
    if (input.tags !== undefined && input.tags.length > 0) {
      const scope = input.dest.scope;
      if ("groupId" in scope) {
        const target = await loadCreateTarget(db, input.userId, scope.groupId);
        if (!target?.canEdit) return { ok: false, kind: "tags_forbidden" };
      }
      const planned = await planNewNoteTags(db, { fileTags: input.tags, space: tagSpaceOf({ ownerId: "ownerId" in scope ? scope.ownerId : null, groupId: "groupId" in scope ? scope.groupId : null }) });
      if (planned.kind !== "ok") return planned.kind === "invalid_tag_name" ? { ok: false, kind: "invalid_tag_name" } : { ok: false, kind: "tag_limit_reached", limit: planned.limit };
      tagNames = planned.names;
    }
    // Charge before parsing (a failed parse counts once): otherwise unparseable files cost no quota and every request could make the server parse a whole large file. A parse failure leaves no note and no dedupe row.
    if (!input.limiters.transferWrite.consume(input.userId)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
    const pre = await this.prepareContent(log, { userId: input.userId, tokenId: input.tokenId, content: input.body });
    if (!pre.ok) return pre.kind === "parser_busy" ? pre : { ok: false, kind: "parse", code: pre.code, ...(pre.detail ? { detail: pre.detail } : {}), ...(pre.knowledge ? { knowledge: pre.knowledge } : {}) };
    if (this.deps.testHooks?.beforeCreateFromFile) await this.deps.testHooks.beforeCreateFromFile();
    let r: CreateWithContentResult;
    try {
      r = await this.createWithContent(log, { userId: input.userId, userHandle: input.userHandle, tokenId: input.tokenId, title: input.title, content: input.body, scope: input.dest.scope, folderId: input.dest.folderId, tags: tagNames }, pre);
    } catch (err) {
      if (err instanceof CreateTagsError) return err.kind === "tag_limit_reached" ? { ok: false, kind: "tag_limit_reached", limit: err.limit } : err.kind === "invalid_tag_name" ? { ok: false, kind: "invalid_tag_name" } : { ok: false, kind: "internal" };
      // Same mapping as `mapCreateInsertFailure` (`mcp/tools/create-note.ts`).
      if (isRetryableTxError(err)) return { ok: false, kind: "busy" };
      if (input.dest.folderId !== null && (isNoteFolderSpaceViolation(err) || isForeignKeyViolation(err))) return { ok: false, kind: "folder_gone" };
      if ("groupId" in input.dest.scope && isForeignKeyViolation(err)) return { ok: false, kind: "folder_gone" };
      throw redactDbError(log, err, "檔案新增建列");
    }
    if (!r.ok) return r.kind === "parse" ? { ok: false, kind: "parse", code: r.code, ...(r.detail ? { detail: r.detail } : {}), ...(r.knowledge ? { knowledge: r.knowledge } : {}) } : r.kind === "parser_busy" || r.kind === "too_large" ? r : { ok: false, kind: "internal" };
    try {
      await db
        .insert(transferCreates)
        .values({ userId: input.userId, fileSha: input.fileSha, noteId: r.noteId, keyId: input.keyId })
        .onConflictDoUpdate({ target: [transferCreates.userId, transferCreates.fileSha], set: { noteId: r.noteId, keyId: input.keyId, createdAt: sql`now()` } });
    } catch (err) {
      throw redactDbError(log, err, "寫入新增去重");
    }
    void db
      .execute(sql`delete from ${transferCreates} where ${transferCreates.createdAt} < now() - make_interval(mins => ${CREATE_DEDUPE_MINUTES}::int)`)
      .catch((err: unknown) => log.warn({ ...pgErrorSummary(err) }, "清理 transfer_creates 失敗"));
    return { ok: true, created: true, noteId: r.noteId, unboundWikilinks: r.unbound, ...(r.knowledge ? { knowledge: r.knowledge } : {}) };
  }

  /** A new note has no knowledge yet, so the value checks run here with nothing to compare against: bad values are refused before a note row exists. */
  async prepareContent(log: FastifyBaseLogger, input: { userId: string; tokenId: string | null; content: string }): Promise<PreparedContent | PrepareContentFailure | ParserBusy> {
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const editing = this.applyDeps(log).editing;
    let prepared: Awaited<ReturnType<typeof editing.parser.parse>>;
    try {
      prepared = await editing.parser.parse({ owner: input.userId, markdown: input.content, candidates, siteOrigin: siteOriginOf(editing.baseUrl) });
    } catch (err) {
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if ("error" in prepared) return { ok: false, kind: "parse", code: prepared.error, ...(prepared.detail ? { detail: prepared.detail } : {}), ...(prepared.knowledge ? { knowledge: prepared.knowledge } : {}) };
    const shaped = prepared.blocks as unknown as readonly KnowledgeBlockShape[];
    const problem = knowledgeWriteProblem(resolveKnowledgeForWrite({ before: [], after: shaped, keep: false, taken: new Set() }).blocks, new Map(), null);
    if (problem !== null) return { ok: false, kind: "parse", code: "invalid_knowledge", knowledge: problem };
    return { ok: true, candidates, agentLabel, prepared };
  }

  private async dropCreated(log: FastifyBaseLogger, noteId: string): Promise<void> {
    try {
      await this.deps.db.delete(notes).where(eq(notes.id, noteId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr, noteId }, "帶 content 建立失敗後清除筆記列失敗");
    }
  }

  /** Bad content creates no row (parse comes first); apply gets blocks, not markdown, so content isn't parsed and rebound twice. A failure after the insert deletes the new row: `parser_busy`, `too_large` and a too-complex apply (as a parse error) are returned as such, anything else, a queue timeout included, as `internal` (500, not 503: docs/ai-editing.md; that timeout is unreachable in practice, a fresh id has no concurrent writer). Creation without content doesn't come here. */
  async createWithContent(
    log: FastifyBaseLogger,
    input: {
      userId: string; userHandle: string; tokenId: string | null; title: string | undefined; content: string; scope: SlugScope;
      folderId?: string | null;
      /** Valid names; the note and its tags are inserted in one transaction, so a refusal leaves no note. Empty or left out: no tags. */
      tags?: readonly string[];
    },
    pre?: PreparedContent,
  ): Promise<CreateWithContentResult> {
    const p = pre ?? (await this.prepareContent(log, input));
    if (!p.ok) return p;
    const { candidates, agentLabel, prepared } = p;
    let knowledge: KnowledgeWriteReport | undefined;
    // Bulk creates (`pre` given) skip the #387 link-text tracking: #385 keeps its own base.
    const [blocks, cleared] = pre ? [prepared.blocks, [] as Array<[string, string]>] : this.shownLinks.keepLabelFree(prepared.blocks, input.userId, candidates);
    const applyDeps = this.applyDeps(log);
    // Must stay after parsing: "parse before insert" is the contract.
    const tagInput = { scope: input.scope, folderId: input.folderId ?? null, title: input.title, names: input.tags ?? [], createdBy: input.userId };
    const note = input.tags !== undefined && input.tags.length > 0
      ? await this.deps.db.transaction(tx => createNoteWithTagsInTx(tx, tagInput))
      : await insertNoteWithAutoSlug(this.deps.db, { scope: input.scope, folderId: input.folderId ?? null }, input.title);
    try {
      const result = await this.queue.run(
        note.id,
        () =>
          applyEdit(applyDeps, {
            noteId: note.id,
            userId: input.userId,
            tokenId: input.tokenId,
            agentLabel,
            op: "replace_all",
            sectionId: undefined,
            markdown: undefined,
            ifMatch: undefined,
            candidates,
            blocks,
            unbound: prepared.unbound,
            ignoredKnowledgeComments: prepared.ignoredKnowledgeComments,
            contentLength: input.content.length,
          }),
        this.deps.queueWaitMs
      );
      if (!result.ok && result.code === "unsupported_block" && result.detail === "too_complex") {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "parse", code: "unsupported_block", detail: "too_complex" };
      }
      if (!result.ok && result.code === "invalid_knowledge" && result.knowledge) {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "parse", code: "invalid_knowledge", knowledge: result.knowledge };
      }
      if (!result.ok) throw new Error(`帶 content 建立筆記時套用失敗：${result.code}`);
      knowledge = result.knowledge;
      if (!pre) {
        const written = shownLinkTextsOf(blocks, new Map());
        written.free.push(...cleared);
        this.shownLinks.record(input.userId, written);
      }
      // Deliberately no presence touch: the note was just created, nobody has it open, so `documents.get` always misses.
    } catch (err) {
      if (err instanceof ParserBusyError) {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "parser_busy" };
      }
      if (err instanceof NoteTooLargeError) {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      }
      log.error({ err, noteId: note.id }, "帶 content 建立筆記：套用內容失敗");
      await this.dropCreated(log, note.id);
      return { ok: false, kind: "internal" };
    }
    return { ok: true, noteId: note.id, inserted: note, unbound: prepared.unbound, ...(knowledge ? { knowledge } : {}) };
  }
}
