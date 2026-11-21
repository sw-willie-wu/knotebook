import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NoteContentDto, NoteEditDto, NoteEditResultDto, NoteSectionDto } from "@knotebook/shared";
import { WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError, sendNoteTooLarge } from "../http/errors.js";
import { NOTE_WRITE_TOO_COMPLEX_MESSAGE, parseErrorMessage, sendDocReadError, sendParserBusy } from "../http/parse-errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { loadLastEdited, readNoteContent } from "../notes/editing/read.js";
import { listEdits } from "../notes/editing/revert.js";
import { presenceIdentity, presenceTargetForRead, type PresenceRegistry } from "../notes/editing/presence.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import { editBodySchema, SEC } from "../notes/schemas.js";
import { currentAgentLabel } from "../auth/agent-label.js";
import { resolveRole, UUID_RE } from "../notes/service.js";

const contentQuerySchema = z.object({ section: SEC.optional() }).strict();

export interface NoteContentRouteDeps {
  db: Db;
  collab?: CollabServer;
  editing?: EditingRuntime;
  limiters: { contentRead: FixedWindowLimiter; edit: FixedWindowLimiter };
  /** The single NoteWriteQueue; MCP gets the same object so writes serialize. */
  writes: NoteWriteService;
  presence?: PresenceRegistry;
}

/** Register from notesRoutes on the same instance, so these routes share its encapsulation context. The 404-vs-403 access rule is documented on notesRoutes in notes.ts. */
export function noteContentRoutes(deps: NoteContentRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // Without a live-doc source "read the latest content" has no meaning, so the route isn't registered (404) rather than answering halfway (production always has both).
    if (deps.collab && deps.editing) {
      const collab = deps.collab;
      const editing = deps.editing;
      /**
       * Read-only, zero side effects: loadNoteDoc only forks the live doc or decodes the DB snapshot, never opens a direct connection (exception: #387 remembers shown link text in memory).
       * ⚠ Authorization is complete here: like the direct connection of the AI write path, this path doesn't go through collab's onAuthenticate.
       * The limiter comes after the role check so "none" 404s don't consume (see CONTENT_READ_LIMIT).
       */
      app.get("/api/notes/:id/content", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        // Redundant with resolveRole's guard; kept so "no invalid uuid reaches SQL" doesn't rest on another module's private choice.
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const q = contentQuerySchema.safeParse(request.query ?? {});
        if (!q.success) return sendError(reply, 400, "invalid_body", "Invalid query parameters.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many reads. Wait a moment and try again.");
        // Only token readers show presence (a cookie read is the user's own browser). touch acts only on loaded documents, so with nobody online it is a no-op and the read
        // stays side-effect free.
        if (request.tokenId) {
          const label = await currentAgentLabel(deps.db, request.tokenId);
          if (label) {
            deps.presence?.touch(id, request.tokenId, presenceIdentity(request.user!.handle, label), presenceTargetForRead(q.data.section));
          }
        }
        let result: Awaited<ReturnType<typeof readNoteContent>>;
        try {
          result = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id, q.data.section);
        } catch (err) {
          const sent = sendDocReadError(reply, err);
          if (sent) return sent;
          throw err;
        }
        if (result === "section_not_found") return sendError(reply, 404, "section_not_found", "No section with that id.");
        // `satisfies` pins read.ts's result to the shared DTO so shape drift fails at compile time.
        const body = { ...result, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
        return reply.send(body);
      });

      /** The limiter comes after the role check (404/403 don't consume) but before any mount or direct connection: a 429 must leave nothing written or recorded. bodyLimit (shared with POST /api/mcp) 413 → content_too_large; the same number as MD's .max(262_144) but in bytes, so over-long markdown hits it before zod's 400. */
      app.post("/api/notes/:id/edits", { preHandler: app.authenticateTokenOrSession("notes:write"), bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const parsed = editBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        const out = await deps.writes.applyToNote(request.log, {
          noteId: id,
          userId,
          userHandle: request.user!.handle,
          tokenId: request.tokenId ?? null,
          op: parsed.data.op,
          sectionId: "section_id" in parsed.data ? parsed.data.section_id : undefined,
          markdown: "markdown" in parsed.data ? parsed.data.markdown : undefined,
          ifMatch: "if_match" in parsed.data ? parsed.data.if_match : undefined,
        });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
          if (out.kind === "parser_busy") return sendParserBusy(reply);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          if (out.kind === "gone") return sendError(reply, 404, "not_found", "No note with that id.");
          if (out.code === "fingerprint_mismatch") {
            // Runs outside the transact, after the direct connection has disconnected. Without a section "section_not_found" can't happen, but the sentinel is in the return union; unnarrowed, spreading a string would send {0:"s",1:"e",…}.
            let current: Awaited<ReturnType<typeof readNoteContent>>;
            try {
              current = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id);
            } catch (err) {
              const sent = sendDocReadError(reply, err);
              if (sent) return sent;
              throw err;
            }
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "fingerprint_mismatch", message: "The content changed since you read it, so nothing was written. The response's current field has the content as it is now." }, current: body });
          }
          if (out.code === "too_complex") return sendError(reply, 500, "too_complex", NOTE_WRITE_TOO_COMPLEX_MESSAGE);
          return sendError(reply, out.code === "section_not_found" ? 404 : 400, out.code, parseErrorMessage(out.code, "Couldn't apply the edit.", out.detail, out.knowledge));
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline, unboundWikilinks: result.unboundWikilinks, ...(result.knowledge ? { knowledge: result.knowledge } : {}) } satisfies NoteEditResultDto);
      });

      /** Read path: never opens a direct connection or reloads an unloaded document. */
      app.get("/api/notes/:id/edits", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many reads. Wait a moment and try again.");
        // Deliberately no presence touch: viewing history shouldn't refresh the AI's presence.
        const edits = await listEdits({ db: deps.db, collab }, id) satisfies NoteEditDto[];
        return reply.send({ edits });
      });

      /** No body, so the input check is on editId: a non-uuid is 404 before SQL (pg's cast error would be a 500). Uses the same queue as the /edits write. */
      app.post("/api/notes/:id/edits/:editId/revert", { preHandler: app.authenticateTokenOrSession("notes:write") }, async (request, reply) => {
        const { id, editId } = request.params as { id: string; editId: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        if (!UUID_RE.test(editId)) return sendError(reply, 404, "not_found", "No edit with that id.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        const out = await deps.writes.revert(request.log, { noteId: id, editId, userId, userHandle: request.user!.handle, tokenId: request.tokenId ?? null });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
          if (out.kind === "parser_busy") return sendParserBusy(reply);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          if (out.kind === "gone") return sendError(reply, 404, "not_found", "No note with that id.");
          if (out.code === "stale") {
            // Runs outside the transact, after the direct connection has disconnected. Without a section "section_not_found" can't happen, but the sentinel is in the return union; unnarrowed, spreading a string would send {0:"s",1:"e",…}.
            let current: Awaited<ReturnType<typeof readNoteContent>>;
            try {
              current = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id);
            } catch (err) {
              const sent = sendDocReadError(reply, err);
              if (sent) return sent;
              throw err;
            }
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "stale", message: "The note changed after this edit, so it can't be reverted. The response's current field has the content as it is now." }, current: body });
          }
          if (out.code === "already_reverted") return sendError(reply, 409, "already_reverted", "This edit has already been reverted.");
          if (out.code === "too_complex") return sendError(reply, 500, "too_complex", NOTE_WRITE_TOO_COMPLEX_MESSAGE);
          return sendError(reply, 404, "not_found", "No edit with that id.");
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline });
      });
    }
  };
}
