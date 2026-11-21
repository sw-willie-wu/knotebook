// Accepts only knbt_ bulk tokens, no cookie fallback. Reads have zero side effects (loadNoteDoc only: no direct connection, no presence, notes.* untouched); their only writes are
// transfer_bases and self-revocation. Logs never contain content, titles, filenames or tokens.
import { eq } from "drizzle-orm";
import { publicUrlIssuer } from "../config.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createTransferAuth } from "../auth/transfer-auth.js";
import type { UserGate } from "../auth/session.js";
import type { CollabServer } from "../collab/server.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError, sendNoteTooLarge } from "../http/errors.js";
import { NOTE_WRITE_TOO_COMPLEX_MESSAGE, parseErrorMessage, sendDocReadError, sendParserBusy } from "../http/parse-errors.js";
import { retryAfterSeconds, type FixedWindowLimiter } from "../http/rate-limit.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { resolveNoteAccess } from "../notes/service.js";
import type { ErrorCode, KnowledgeProblem } from "@knotebook/shared";
import { knowledgeProblemMessage } from "../notes/editing/knowledge-messages.js";
import { FOLDER_NOT_FOUND_MESSAGE } from "../folders/messages.js";
import type { BaseUnavailableReason, NoteWriteService, SyncFileOk } from "../notes/editing/write-service.js";
import { fileShaOf, resolveCreateDest } from "../transfer/create-file.js";
import { readNoteFile } from "../transfer/frontmatter.js";
import { normalizeBody } from "../transfer/normalize.js";
import { unclosedFenceMessage } from "../transfer/regions.js";
import { MAX_BLOCKS, MAX_HTML_DEPTH, type ParseDetail } from "../notes/editing/markdown.js";
import { deriveTransferKey, transferKeyId } from "../transfer/base-hash.js";
import { insertBases, pruneBases } from "../transfer/bases.js";
import { buildNoteFile } from "../transfer/note-file.js";
import { sanitizeTitle } from "../transfer/paths.js";
import { ExportSlot } from "../transfer/export-slot.js";
import { EXPORT_BUSY_RETRY_AFTER_S, TRANSFER_EXPORT_MAX_NOTES, streamExport, type ExportTestHooks } from "../transfer/export-stream.js";
import { inRangeIds, layoutOf, rangeGone, visibleNotes, visibleTree } from "../transfer/range.js";

export const RANGE_GONE_MESSAGE = "The group or folder this transfer token covers is no longer visible to you.";
export const NOT_IN_RANGE_MESSAGE = "This note isn't in this transfer token's range.";
export const TRANSFER_NOTE_NOT_FOUND_MESSAGE = "No note with that id.";
export const TRANSFER_RATE_LIMITED_MESSAGE = "Too many requests. Wait a moment and try again.";
// curl doesn't print response headers, so the wait is in the message (minutes, rounded up, at least 1). The limiter key is userId, so a new token doesn't reset it; the wait may outlast the token (≤ 30 min).
export function exportRateLimitedMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `You've reached your hourly limit for full downloads; it counts per person, so a new token won't reset it. Download again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, with a new token if this one has expired by then; until then, fetch the notes you need one by one with the note command, which doesn't count toward this limit.`;
}
export const EXPORT_BUSY_MESSAGE = `Another export is already running. Try again in ${EXPORT_BUSY_RETRY_AFTER_S} seconds.`;
export const TOO_MANY_NOTES_MESSAGE = `The range has more than ${TRANSFER_EXPORT_MAX_NOTES} notes. Ask for a token with a smaller range.`;
export const INVALID_UTF8_MESSAGE = "The file isn't valid UTF-8.";

export interface WriteTestHooks {
  /** First line of the PUT reply.raw close handler. */
  onWriteClientClose?(): void;
  /** Awaited first in the PUT handler, before the close listener is attached. */
  beforeWriteHandler?(): Promise<void>;
}
export type TransferTestHooks = ExportTestHooks & WriteTestHooks;

export function transferParseMessage(code: ErrorCode, detail?: ParseDetail, fence?: string, knowledge?: KnowledgeProblem): string {
  if (code === "unsupported_block") {
    if (detail === "knowledge_attr") return "The file has knowledge info this editor cannot store, so nothing was written. Knowledge info is set only by a <!-- knotebook:knowledge … --> comment on the lines right after a heading, as a download shows it.";
    if (detail === "event_attr") return "The file has HTML with an event attribute (such as onerror or onclick), which can't be stored in a note, so nothing was written.";
    if (detail === "editor_internal") return "The file has HTML the editor uses internally (such as an element with data-content-type), which can't be stored in a note, so nothing was written.";
    if (detail === "dropped_element") return "The file has an element the editor drops along with its content (such as <script>, <style> or <iframe>), which can't be stored in a note, so nothing was written.";
    if (detail === "nested_paragraph") return "The file has a paragraph inside another paragraph (HTML such as a <p> inside a <button>, <marquee>, <svg> or <math> that is itself in a <p>), which can't be stored in a note, so nothing was written.";
    if (detail === "too_deep") return `The file is nested more than ${MAX_HTML_DEPTH} HTML elements deep, counting the paragraph inside (quotes nested 128 levels deep or lists nested 64 levels deep), which can't be stored in a note, so nothing was written.`;
    if (detail === "too_complex") return "The file is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller files or simplify its formatting.";
    return "The file has an element the editor doesn't support, which can't be stored in a note, so nothing was written.";
  }
  if (code === "empty_content") {
    if (detail === "unclosed_comment") return "A `<!--` has no closing `-->`, so everything after it counts as a comment and there is nothing to store. Add the `-->` and send the file again. Nothing was written.";
    return "A part of the file has no content once parsed (for example, only HTML comments or blank space), so nothing was written.";
  }
  if (code === "too_many_blocks") return `The content is over a note's limit of ${MAX_BLOCKS} blocks (nested blocks count too), so nothing was written.`;
  if (code === "invalid_body" && fence !== undefined) return unclosedFenceMessage(fence);
  if (code === "invalid_knowledge") return knowledge === undefined ? "A knowledge comment in the file is not valid, so nothing was written." : knowledgeProblemMessage(knowledge);
  return parseErrorMessage(code, "Couldn't apply the file.");
}

export const BASE_UNAVAILABLE_MESSAGES: Record<BaseUnavailableReason, string> = {
  already_sent: "Can't write back with this copy: it has already been sent back with different content. Download the note again and make your changes there.",
  other_note: "Can't write back with this copy: its base belongs to another note or another user. Download the note again and make your changes there.",
  expired: "Can't write back with this copy: the server no longer has its base (it is too old or no longer valid). Download the note again and make your changes there.",
  note_changed: "Can't write back with this copy: the note has changed (its title or text) since you downloaded it. Download this note again (the note command), redo your changes in the new copy and send that.",
  reverted: "Can't write back with this copy: the changes it wrote back have been reverted. Download the note again and make your changes there.",
};
export const NOT_MERGEABLE_MESSAGE = "This note can't be written back from a file. Change it with edit_note instead.";

export interface TransferRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  collab: CollabServer;
  editing: EditingRuntime;
  limiters: {
    bearerMiss: FixedWindowLimiter;
    contentRead: FixedWindowLimiter;
    transferExport: FixedWindowLimiter;
    /** Charged inside the queue after the file is known to differ, before parsing. */
    transferWrite: FixedWindowLimiter;
    /** Same limiter as MCP/REST Bearer reads: zero regions, identical resends and dedupe hits charge it. */
    tokenRead: FixedWindowLimiter;
  };
  writes: NoteWriteService;
  testHooks?: TransferTestHooks;
}

export function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function transferRoutes(deps: TransferRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const auth = createTransferAuth({ db: deps.db, gate: deps.gate, authenticate: app.authenticate, limiters: { bearerMiss: deps.limiters.bearerMiss } });
    const requireBulkRead = auth.requireBulk("read");
    const requireBulkWrite = auth.requireBulk("write");
    const key = deriveTransferKey(deps.config.appSecret);
    const fileDeps = { db: deps.db, collab: deps.collab, editing: deps.editing, key, keyId: transferKeyId(key) };
    const slot = new ExportSlot();
    const site = publicUrlIssuer(deps.config.publicUrl);

    // Order is a contract: scope object gone → 403 (no limiter, no slot) → site-wide slot (busy → 429 Retry-After: 30, no charge) → charge transferExport synchronously (no await; short → release slot + 429)
    // → names and range filter; > 3,000 notes → 413 before streaming → hijack. Every exit after taking the slot releases it.
    // `exposeHeadRoute: false`: Fastify 5 adds HEAD for GET, and HEAD would run the full export, charge and take the slot.
    app.get("/api/transfer/export", { preHandler: requireBulkRead, exposeHeadRoute: false }, async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const bt = request.bulkTransfer!;
      const tree = await visibleTree(deps.db, userId);
      if (await rangeGone(deps.db, userId, bt.range, tree)) return sendError(reply, 403, "forbidden", RANGE_GONE_MESSAGE);
      const release = slot.tryAcquire();
      if (release === null) {
        reply.header("retry-after", String(EXPORT_BUSY_RETRY_AFTER_S));
        return sendError(reply, 429, "too_many_requests", EXPORT_BUSY_MESSAGE);
      }
      if (!deps.limiters.transferExport.consume(userId)) {
        release();
        const waitMs = deps.limiters.transferExport.retryAfterMs(userId);
        reply.header("retry-after", String(retryAfterSeconds(waitMs)));
        return sendError(reply, 429, "too_many_requests", exportRateLimitedMessage(waitMs));
      }
      let streaming = false;
      const started = Date.now();
      try {
        const exportedAt = new Date();
        const layout = layoutOf({ notes: await visibleNotes(deps.db, userId), ...tree }, bt.range);
        if (layout.files.size > TRANSFER_EXPORT_MAX_NOTES) return sendError(reply, 413, "too_many_notes", TOO_MANY_NOTES_MESSAGE);
        streaming = true;
        reply.hijack();
        await streamExport({
          db: deps.db,
          gate: deps.gate,
          log: request.log,
          fileDeps,
          reply,
          userId,
          tokenId: bt.id,
          parentTokenId: bt.parentTokenId,
          range: bt.range,
          tree,
          layout,
          site,
          exportedAt,
          release,
          hooks: deps.testHooks,
        });
      } catch (err) {
        if (!streaming) throw err;
        // Only errors thrown before streamExport's try reach here, so its finally didn't run: log and onExportEnd here. After hijack Fastify won't reply for us: destroy the socket.
        request.log.warn({ ...pgErrorSummary(err) }, "整包匯出串流前失敗");
        reply.raw.destroy();
        // Release before onExportEnd (same order as streamExport's finally); the release in finally is idempotent.
        release();
        deps.testHooks?.onExportEnd?.("aborted");
        request.log.info(
          { userId, tokenId: bt.parentTokenId, range: bt.range, notes: 0, skipped: 0, notMergeable: 0, bytes: 0, ms: Date.now() - started, outcome: "aborted" },
          "bulk transfer export",
        );
      } finally {
        release();
      }
    });

    app.delete("/api/transfer/token", { preHandler: requireBulkRead }, async (request: FastifyRequest, reply: FastifyReply) => {
      await deps.db.delete(transferTokens).where(eq(transferTokens.id, request.bulkTransfer!.id));
      return reply.code(204).send();
    });

    // contentRead is charged after the role and range checks.
    app.get("/api/transfer/notes/:id", { preHandler: requireBulkRead, exposeHeadRoute: false }, async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const range = request.bulkTransfer!.range;
      const { id } = request.params as { id: string };
      const access = await resolveNoteAccess(deps.db, userId, id);
      // Same 404 text for nonexistent and invisible notes.
      if (access.role === "none") return sendError(reply, 404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
      const tree = await visibleTree(deps.db, userId);
      if (await rangeGone(deps.db, userId, range, tree)) return sendError(reply, 403, "forbidden", RANGE_GONE_MESSAGE);
      const rows = await visibleNotes(deps.db, userId, { ids: [id] });
      const row = rows[0];
      if (row === undefined || !inRangeIds(rows, tree, range).has(row.id)) return sendError(reply, 403, "forbidden", NOT_IN_RANGE_MESSAGE);
      if (!deps.limiters.contentRead.consume(userId)) {
        reply.header("retry-after", String(retryAfterSeconds(deps.limiters.contentRead.retryAfterMs(userId))));
        return sendError(reply, 429, "too_many_requests", TRANSFER_RATE_LIMITED_MESSAGE);
      }
      let nf: Awaited<ReturnType<typeof buildNoteFile>>;
      try {
        nf = await buildNoteFile(fileDeps, userId, row, { forceUnmergeable: deps.testHooks?.forceUnmergeable?.(row.id) === true });
      } catch (err) {
        const sent = sendDocReadError(reply, err);
        if (sent) return sent;
        throw err;
      }
      await insertBases(deps.db, request.log, [nf.base]);
      pruneBases(deps.db, request.log, userId, [row.id]);
      return reply
        .code(200)
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeRfc5987(sanitizeTitle(row.title) + ".md")}`)
        .header("cache-control", "no-store")
        .send(nf.file);
    });

    // text/markdown 415/Origin 403 are enforced in the global onRequest (TEXT_BODY_EXEMPT_ROUTES); over TRANSFER_WRITE_BODY_LIMIT (256 KiB, same as WRITE_BODY_LIMIT) → 413
    // content_too_large; fatal UTF-8 decoding happens here (non-UTF-8 → 400 invalid_body).
    app.put("/api/transfer/notes", { preHandler: requireBulkWrite, bodyLimit: TRANSFER_WRITE_BODY_LIMIT }, async (request: FastifyRequest, reply: FastifyReply) => {
      await deps.testHooks?.beforeWriteHandler?.();
      const started = Date.now();
      // Only reply.raw's close: on PUT, request.raw's close fires as soon as the body is read. A disconnect changes no flow, it is only logged (clientClosed).
      let clientClosed = false;
      const onClose = () => {
        deps.testHooks?.onWriteClientClose?.();
        if (!reply.raw.writableFinished) clientClosed = true;
      };
      reply.raw.once("close", onClose);
      // Covers a client that left before the listener was attached.
      if (reply.raw.destroyed) onClose();
      const userId = request.user!.id;
      const bt = request.bulkTransfer!;
      let noteId: string | null = null;
      const logLine = (result: string, d?: Partial<Pick<SyncFileOk, "applied" | "same" | "diffOverflow" | "anchored" | "degradedLines">>) =>
        request.log.info(
          {
            userId, tokenId: bt.parentTokenId, noteId, result,
            applied: d?.applied ?? null, same: d?.same ?? null,
            ms: Date.now() - started, diffOverflow: d?.diffOverflow ?? null, anchored: d?.anchored ?? null, degradedLines: d?.degradedLines ?? null, clientClosed,
          },
          "bulk transfer write",
        );
      const fail = (status: number, code: ErrorCode, message: string) => {
        logLine(code);
        return sendError(reply, status, code, message);
      };
      const tooMany = (retryAfterMs: number) => {
        reply.header("retry-after", String(retryAfterSeconds(retryAfterMs)));
        return fail(429, "too_many_requests", TRANSFER_RATE_LIMITED_MESSAGE);
      };
      const parserBusy = () => {
        logLine("server_busy");
        return sendParserBusy(reply);
      };
      const tooLarge = (limitBytes: number) => {
        logLine("note_too_large");
        return sendNoteTooLarge(reply, limitBytes);
      };
      // Unexpected exceptions are logged with the same keys (result "internal", diff keys null) and rethrown unchanged; content-bearing DB errors were already redacted in the service.
      try {
        const raw = request.body;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(raw) ? raw : new Uint8Array(0));
        } catch {
          return fail(400, "invalid_body", INVALID_UTF8_MESSAGE);
        }
        const file = readNoteFile(text);
        if (file.kind === "error") return fail(400, "invalid_body", file.message);
        const limiters = { transferWrite: deps.limiters.transferWrite, tokenRead: deps.limiters.tokenRead };
        const tree = await visibleTree(deps.db, userId);

        if (file.kind === "new") {
          if (await rangeGone(deps.db, userId, bt.range, tree)) return fail(403, "forbidden", RANGE_GONE_MESSAGE);
          const dest = await resolveCreateDest(deps.db, userId, bt.range, file.folderId, tree);
          if (!dest.ok) return fail(dest.status, dest.code, dest.message);
          const out = await deps.writes.createFromFile(request.log, {
            userId, userHandle: request.user!.handle, tokenId: bt.parentTokenId, fileSha: fileShaOf(key, userId, normalizeBody(text)), keyId: fileDeps.keyId,
            title: file.title, body: file.body, dest: { scope: dest.scope, folderId: dest.folderId }, limiters,
          });
          if (!out.ok) {
            if (out.kind === "parse") return fail(400, out.code, transferParseMessage(out.code, out.detail, undefined, out.knowledge));
            if (out.kind === "parser_busy") return parserBusy();
            if (out.kind === "too_large") return tooLarge(out.limitBytes);
            if (out.kind === "rate_limited") return tooMany(out.retryAfterMs);
            if (out.kind === "folder_gone") return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
            if (out.kind === "busy") return fail(503, "server_busy", "The server is busy. Try again in a moment.");
            return fail(500, "internal", "Couldn't create the note.");
          }
          noteId = out.noteId;
          logLine(out.created ? "created" : "unchanged");
          return out.created
            ? reply.code(201).send({ id: out.noteId, created: true, result: "created", base: null, unboundWikilinks: out.unboundWikilinks })
            : reply.code(200).send({ id: out.noteId, created: false, result: "unchanged", base: null });
        }

        noteId = file.id;
        const access = await resolveNoteAccess(deps.db, userId, file.id);
        if (access.role === "none") return fail(404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
        // Order is a contract: visible → range object → range → role → syncFile (which charges transferWrite after the file is known to differ, before parsing).
        if (await rangeGone(deps.db, userId, bt.range, tree)) return fail(403, "forbidden", RANGE_GONE_MESSAGE);
        const rows = await visibleNotes(deps.db, userId, { ids: [file.id] });
        const row = rows[0];
        if (row === undefined || !inRangeIds(rows, tree, bt.range).has(row.id)) return fail(403, "forbidden", NOT_IN_RANGE_MESSAGE);
        if (!access.permissions.edit) return fail(403, "forbidden", "You don't have edit access to this note.");
        const out = await deps.writes.syncFile(request.log, {
          noteId: file.id, userId, userHandle: request.user!.handle, tokenId: bt.parentTokenId, access, baseKey: file.base, title: file.title,
          body: file.body, key, keyId: fileDeps.keyId, limiters,
        });
        if (!out.ok) {
          if (out.kind === "base_unavailable") {
            logLine("base_unavailable");
            return reply.code(409).send({ error: { code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES[out.reason], reason: out.reason } });
          }
          if (out.kind === "not_mergeable") return fail(409, "not_mergeable", NOT_MERGEABLE_MESSAGE);
          if (out.kind === "parser_busy") return parserBusy();
          if (out.kind === "too_large") return tooLarge(out.limitBytes);
          if (out.kind === "note_too_complex") return fail(500, "too_complex", NOTE_WRITE_TOO_COMPLEX_MESSAGE);
          if (out.kind === "busy") return fail(503, "server_busy", "The server is busy. Try again in a moment.");
          if (out.kind === "gone") return fail(404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
          if (out.kind === "rate_limited") return tooMany(out.retryAfterMs);
          if (out.kind === "parse") {
            if (out.code === "unclosed_fence") return fail(400, "invalid_body", transferParseMessage("invalid_body", undefined, out.fence ?? "```"));
            return fail(400, out.code, transferParseMessage(out.code, out.detail, undefined, out.knowledge));
          }
          return fail(500, "internal", "Couldn't write the file back.");
        }
        logLine(out.result, out);
        return reply.code(200).send({
          id: file.id, created: false, result: out.result, applied: out.applied, same: out.same, editIds: out.editIds, renamed: out.renamed,
          ...(out.renameFailed ? { renameFailed: out.renameFailed } : {}), unboundWikilinks: out.unboundWikilinks, base: null,
        });
      } catch (err) {
        logLine("internal");
        throw err;
      }
    });
  };
}
