// Purge-all is the client sending every listed id: notes trashed after the list loaded are not purged. Callers without trash rights get the same skipped:not_found as for a nonexistent id.
// No transaction here; they live in trash/service.ts.
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TRASH_BATCH_MAX, type NoteDto, type TrashPurgeResultDto, type TrashRestoreResultDto } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import { isRetryableTxError } from "../db/pg-errors.js";
import { uploads } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { loadNoteFields, toNoteDto } from "../notes/note-dto.js";
import { UUID_RE, resolveNoteAccess, resolveTrashedNoteAccess } from "../notes/service.js";
import { listTrash, loadTrashPreview, readTrashRetentionDays } from "../trash/list.js";
import { purgeTrashed, restoreTrashed, type TrashBatchResult, type TrashServiceDeps } from "../trash/service.js";
import { sendUploadFile } from "../uploads/service.js";

/** Counted on raw ids (before dedup). */
const idsBodySchema = z.object({ ids: z.array(z.string()).min(1).max(TRASH_BATCH_MAX) }).strict();
const IDS_INVALID_MESSAGE = `Invalid request body: ids must be 1 to ${TRASH_BATCH_MAX} note ids.`;
/** 40001/40P01/55P03: the transaction rolled back wholesale → 409. */
const SERVER_BUSY_MESSAGE = "The server is busy. Try again in a moment.";

function parseIds(body: unknown): string[] | null {
  const parsed = idsBodySchema.safeParse(body);
  if (!parsed.success || !parsed.data.ids.every(id => UUID_RE.test(id))) return null;
  return [...new Set(parsed.data.ids.map(id => id.toLowerCase()))];
}

export function trashRoutes(deps: TrashServiceDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/trash", { preHandler: app.authenticate }, async (request, reply) => {
      const row = await readTrashRetentionDays(deps.db);
      if (!row) {
        request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
        return sendError(reply, 500, "internal", "Internal server error.");
      }
      return reply.send(await listTrash(deps.db, request.user!.id, row.retentionDays));
    });

    app.get("/api/trash/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
      const row = await readTrashRetentionDays(deps.db);
      if (!row) {
        request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
        return sendError(reply, 500, "internal", "Internal server error.");
      }
      const preview = await loadTrashPreview(deps.db, request.user!.id, id.toLowerCase(), row.retentionDays);
      if (!preview) return sendError(reply, 404, "not_found", "No note with that id.");
      reply.header("cache-control", "private, no-store");
      return reply.send(preview);
    });

    app.get("/api/trash/:id/uploads/:uploadId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, uploadId } = request.params as { id: string; uploadId: string };
      if (!UUID_RE.test(id) || !UUID_RE.test(uploadId)) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }
      const noteId = id.toLowerCase();
      if (!(await resolveTrashedNoteAccess(deps.db, request.user!.id, noteId))) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }
      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, uploadId.toLowerCase())).limit(1);
      // Scoped strictly to this trashed note's own uploads; cross-note upload ids get the same 404.
      if (!row || row.noteId !== noteId) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }
      return sendUploadFile(request, reply, row, deps.uploadsDir);
    });

    app.post("/api/trash/restore", { preHandler: app.authenticate }, async (request, reply) => {
      const ids = parseIds(request.body);
      if (ids === null) return sendError(reply, 400, "invalid_body", IDS_INVALID_MESSAGE);
      const userId = request.user!.id;
      let result: TrashBatchResult;
      try {
        result = await restoreTrashed(deps, { ids, by: userId });
      } catch (err) {
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", SERVER_BUSY_MESSAGE);
        throw err;
      }
      const restored: NoteDto[] = [];
      for (const id of result.done) {
        // Narrow race: trashed, demoted or purged again after the restore commit. It was restored, so not skipped; not listed as restored since the caller can't see it.
        const fields = await loadNoteFields(deps.db, id, userId);
        const access = await resolveNoteAccess(deps.db, userId, id);
        if (fields === undefined || access.role === "none") continue;
        restored.push(toNoteDto(fields, access));
      }
      return reply.send({ restored, skipped: result.skipped } satisfies TrashRestoreResultDto);
    });

    app.post("/api/trash/purge", { preHandler: app.authenticate }, async (request, reply) => {
      const ids = parseIds(request.body);
      if (ids === null) return sendError(reply, 400, "invalid_body", IDS_INVALID_MESSAGE);
      let result: TrashBatchResult;
      try {
        result = await purgeTrashed(deps, { ids, by: request.user!.id }, request.log);
      } catch (err) {
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", SERVER_BUSY_MESSAGE);
        throw err;
      }
      return reply.send({ purged: result.done, skipped: result.skipped } satisfies TrashPurgeResultDto);
    });
  };
}
