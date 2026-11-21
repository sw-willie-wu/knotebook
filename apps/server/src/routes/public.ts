import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeHandle, normalizeSlug, validateHandle, validateSlug, type NoteWidth } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { Db } from "../db/index.js";
import { noteStates, notes, uploads, users } from "../db/schema.js";
import { preparePublicDoc } from "../notes/public-doc.js";
import { publicLinksFor } from "../notes/public-links.js";
import { UUID_RE } from "../notes/service.js";
import { uploadFilePath } from "../uploads/service.js";

// All four routes go through the single resolvePublicNote (token and alias forms): the step order and identical 404s must exist once. The lookup must include `public_token IS NOT NULL` so unpublishing kills both forms.
// The response never includes the token (an alias page would turn a guessable URL into an unrevocable handle). Tokens are kept out of logs by redactPublicTokens in app.ts; this file must not log request URLs.
// Misses share one per-IP limiter across both forms. Hits use one limiter (publicNote or publicUpload) for both forms, keyed ${ip}:${token} and ${ip}:path:${noteId}, which can't collide
// (base64url has no ':'), so a note reachable both ways gets twice the hit quota (docs/known-limitations.md).

const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_RE.test(token);
}

// Deliberately over-broad: masks the first segment even when it isn't a 43-char token (the alias form's handle too); acceptable since handle/slug aren't secret.
export function redactPublicTokens(url: string): string {
  // ⚠ Collapse leading slashes and match case-insensitively: the SPA fallback serves `//p/<token>`, `/P/<token>` and `//api/public/…`, which an anchored case-sensitive match would
  // write to the log in the clear. The logged URL may then differ slightly from the request; accepted.
  const collapsed = url.replace(/^\/{2,}/, "/");
  return collapsed
    .replace(/^\/p\/[^/?#]+/i, "/p/:token")
    .replace(/^\/api\/public\/notes\/[^/?#]+/i, "/api/public/notes/:token");
}

// Shared with the noindex check (spa.ts): fixing only one side would leak variants.
export { isPublicSharePath } from "@knotebook/shared";

export interface PublicRoutesDeps {
  db: Db;
  uploadsDir: string;
  limiters: { publicMiss: FixedWindowLimiter; publicNote: FixedWindowLimiter; publicUpload: FixedWindowLimiter };
}

function sendLinkNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, "not_found", "This link doesn't exist or no longer works.");
}

type PublicNoteRow = { id: string; title: string; publicWidth: NoteWidth };

// Don't fold the guard into lookup: that would silently break "format guard touches neither limiters nor DB".
interface PublicRefSpec<Q> {
  guard: () => Q | null;
  lookup: (q: Q) => Promise<PublicNoteRow | undefined>;
  hitKey: (q: Q, ip: string, noteId: string) => string;
}

export function publicRoutes(deps: PublicRoutesDeps) {
  async function resolvePublicNote<Q>(
    request: FastifyRequest,
    reply: FastifyReply,
    hitBucket: FixedWindowLimiter,
    spec: PublicRefSpec<Q>,
  ): Promise<PublicNoteRow | null> {
    // Format guard first: keeps long strings out of BoundedMap keys.
    const q = spec.guard();
    if (q === null) {
      sendLinkNotFound(reply);
      return null;
    }
    const ip = request.ip;
    // The pre-check applies to hits and misses alike, so a 429 is not an existence oracle.
    if (deps.limiters.publicMiss.isBlocked(ip)) {
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      return null;
    }
    const note = await spec.lookup(q);
    if (!note) {
      deps.limiters.publicMiss.consume(ip);
      sendLinkNotFound(reply);
      return null;
    }
    if (!hitBucket.consume(spec.hitKey(q, ip, note.id))) {
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      return null;
    }
    return note;
  }

  /** Trashed notes miss (#181), identical to a missing link. */
  function tokenSpec(token: string): PublicRefSpec<string> {
    return {
      guard: () => (isValidPublicToken(token) ? token : null),
      lookup: (t) =>
        deps.db
          .select({ id: notes.id, title: notes.title, publicWidth: notes.publicWidth })
          .from(notes)
          .where(and(eq(notes.publicToken, t), isNull(notes.deletedAt)))
          .limit(1)
          .then((rows) => rows[0]),
      hitKey: (t, ip) => `${ip}:${t}`,
    };
  }

  function pathSpec(rawHandle: string, rawSlug: string): PublicRefSpec<{ handle: string; slug: string }> {
    return {
      guard: () => {
        const handle = normalizeHandle(rawHandle);
        const slug = normalizeSlug(rawSlug);
        if (validateHandle(handle) !== null || validateSlug(slug) !== null) return null;
        return { handle, slug };
      },
      // Only public_slug is matched: private slug/prev/legacy are not public.
      lookup: (q) =>
        deps.db
          .select({ id: notes.id, title: notes.title, publicWidth: notes.publicWidth })
          .from(notes)
          .innerJoin(users, eq(users.id, notes.ownerId))
          .where(and(eq(users.handle, q.handle), eq(notes.publicSlug, q.slug), sql`${notes.publicToken} is not null`, isNull(notes.deletedAt)))
          .limit(1)
          .then((rows) => rows[0]),
      hitKey: (_q, ip, noteId) => `${ip}:path:${noteId}`,
    };
  }

  return function register(app: FastifyInstance) {
    async function sendPublicNote(request: FastifyRequest, reply: FastifyReply, note: PublicNoteRow) {
      // A note never opened in the editor has no note_states row: a legitimate empty document (EMPTY_YDOC_UPDATE_B64; a zero-length update throws in Y.applyUpdate), not a 404.
      const [state] = await deps.db
        .select({ ydoc: noteStates.ydoc })
        .from(noteStates)
        .where(eq(noteStates.noteId, note.id))
        .limit(1);

      const prepared = preparePublicDoc(state ? state.ydoc : null);
      if (state && prepared.doc === null) request.log.warn({ noteId: note.id }, "Public note state could not be decoded; serving an undecodable payload so the page shows its error card.");
      let links;
      try {
        links = await publicLinksFor(deps.db, note.id, prepared.doc);
      } finally {
        prepared.doc?.destroy();
      }
      // Revocation and regeneration must take effect at once.
      reply.header("cache-control", "no-store");
      return { title: note.title, ydoc: prepared.ydocB64, links, width: note.publicWidth };
    }

    async function sendPublicUpload(request: FastifyRequest, reply: FastifyReply, note: { id: string }, uploadId: string) {
      // A cross-note uploadId is also 404: public authorization covers only this note's blobs (docs/known-limitations.md).
      if (!UUID_RE.test(uploadId)) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }
      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
      if (!row || row.noteId !== note.id) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }

      const filePath = uploadFilePath(deps.uploadsDir, row.id);
      try {
        await stat(filePath);
      } catch {
        request.log.error({ uploadId: row.id }, "DB 有上傳紀錄但磁碟找不到對應檔案");
        return sendError(reply, 404, "not_found", "No file with that id.");
      }

      reply.header("x-content-type-options", "nosniff");
      // Same as the logged-in uploads GET; blobs stay readable from browser caches after revocation (docs/known-limitations.md).
      reply.header("cache-control", "private, max-age=31536000, immutable");
      reply.type(row.mime);
      return reply.send(createReadStream(filePath));
    }

    app.get("/api/public/notes/:token", async (request, reply) => {
      const { token } = request.params as { token: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicNote, tokenSpec(token));
      if (!note) return reply;
      return sendPublicNote(request, reply, note);
    });

    app.get("/api/public/notes/:handle/:slug", async (request, reply) => {
      const { handle, slug } = request.params as { handle: string; slug: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicNote, pathSpec(handle, slug));
      if (!note) return reply;
      return sendPublicNote(request, reply, note);
    });

    app.get("/api/public/notes/:token/uploads/:uploadId", async (request, reply) => {
      const { token, uploadId } = request.params as { token: string; uploadId: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicUpload, tokenSpec(token));
      if (!note) return reply;
      return sendPublicUpload(request, reply, note, uploadId);
    });

    app.get("/api/public/notes/:handle/:slug/uploads/:uploadId", async (request, reply) => {
      const { handle, slug, uploadId } = request.params as { handle: string; slug: string; uploadId: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicUpload, pathSpec(handle, slug));
      if (!note) return reply;
      return sendPublicUpload(request, reply, note, uploadId);
    });
  };
}
