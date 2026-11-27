// Reads and writes take a session or a Bearer token (read scope to read, `notes:write` to write, charged by the preHandler); the read marker and
// mention candidates are cookie-only. Authorization runs here first so a trashed note answers `in_trash` to the people who may see the trash and a
// plain 404 to everyone else; the write transactions repeat the check under their locks.
// Malformed requests and 404s before authorization charge no limiter; a body the transaction refuses (empty, over the cap, NUL, bad replyToId or anchor) is a 400 that was already charged to `comment`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CommentDto, CommentUnreadCountDto, MentionCandidateDto } from "@knotebook/shared";
import { currentAgentLabel } from "../auth/agent-label.js";
import { broadcastCommentChange } from "../comments/broadcast.js";
import { resolveMentionCandidates } from "../comments/mentions.js";
import { COMMENT_NOT_FOUND_MESSAGE } from "../comments/messages.js";
import {
  COMMENT_PAGE_DEFAULT,
  COMMENT_PAGE_MAX,
  commentNoteId,
  countUnreadComments,
  decodeCursor,
  getComment,
  listComments,
  markCommentsRead,
  type CommentPageRequest,
  type CommentViewer,
} from "../comments/queries.js";
import { deleteCommentInTx, editCommentInTx, postCommentInTx, type CommentActor } from "../comments/tx/write.js";
import type { CollabServer } from "../collab/server.js";
import type { NotificationHub } from "../notifications/hub.js";
import type { Db } from "../db/index.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { COMMENT_BODY_LIMIT } from "../http/body-limits.js";
import { sendError, sendInTrash } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { resolveNoteAccess, resolveTrashedNoteAccess, UUID_RE, type NoteAccess } from "../notes/service.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../tags/messages.js";

export interface CommentsRouteDeps {
  db: Db;
  collab?: CollabServer;
  notifications?: NotificationHub;
  limiters: { comment: FixedWindowLimiter; commentRead: FixedWindowLimiter; userSuggest: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
}

const LIMIT_RE = /^[1-9]\d{0,2}$/;
const MENTION_QUERY_MAX = 64;

const listQuerySchema = z.object({ before: z.string().optional(), after: z.string().optional(), around: z.string().optional(), limit: z.string().optional() }).strict();
const postBodySchema = z
  .object({
    body: z.string(),
    replyToId: z.string().nullable().optional(),
    anchor: z.object({ blockId: z.string(), quote: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();
const editBodySchema = z.object({ body: z.string() }).strict();
const readBodySchema = z.object({}).strict();
const candidatesQuerySchema = z.object({ q: z.string().max(MENTION_QUERY_MAX).optional() }).strict();

export function commentsRoutes(deps: CommentsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", NOTE_NOT_FOUND_MESSAGE);
    const commentNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "comment_not_found", COMMENT_NOT_FOUND_MESSAGE);
    const invalidBody = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_body", "Invalid request body.");
    const invalidQuery = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_body", "Invalid query parameters.");
    const tooManyRequests = (reply: FastifyReply): FastifyReply =>
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

    /**
     * Sends the 404 for a note or comment the caller can't read: `in_trash` for callers with trash rights, otherwise the plain 404.
     * The helpers below resolve to null after sending, never to the reply itself: a Fastify reply is thenable, so awaiting one
     * would hide that it was sent.
     */
    const sendMissing = async (reply: FastifyReply, userId: string, noteId: string, notFound: (r: FastifyReply) => FastifyReply): Promise<null> => {
      if (await resolveTrashedNoteAccess(deps.db, userId, noteId)) sendInTrash(reply, noteId);
      else notFound(reply);
      return null;
    };

    /** A readable live note's access, or null once the reply was sent. */
    async function readableNote(reply: FastifyReply, userId: string, noteId: string): Promise<NoteAccess | null> {
      const access = await resolveNoteAccess(deps.db, userId, noteId);
      return access.permissions.read ? access : sendMissing(reply, userId, noteId, noteNotFound);
    }

    const viewerOf = (request: FastifyRequest, access: NoteAccess): CommentViewer => ({
      userId: request.user!.id,
      isSiteAdmin: request.user!.isAdmin,
      canDeleteOthers: access.permissions.delete,
    });

    async function actorOf(request: FastifyRequest): Promise<CommentActor> {
      const tokenId = request.tokenId ?? null;
      return {
        userId: request.user!.id,
        tokenId,
        agentLabel: tokenId === null ? null : await currentAgentLabel(deps.db, tokenId),
        isSiteAdmin: request.user!.isAdmin,
      };
    }

    /** The comment's note when the caller can read it, or null once the reply was sent. */
    async function readableComment(request: FastifyRequest, reply: FastifyReply, commentId: string): Promise<{ noteId: string; access: NoteAccess } | null> {
      if (!UUID_RE.test(commentId)) {
        commentNotFound(reply);
        return null;
      }
      const noteId = await commentNoteId(deps.db, commentId);
      if (noteId === null) {
        commentNotFound(reply);
        return null;
      }
      const access = await resolveNoteAccess(deps.db, request.user!.id, noteId);
      if (!access.permissions.read) return sendMissing(reply, request.user!.id, noteId, commentNotFound);
      return { noteId, access };
    }

    app.get("/api/notes/:id/comments", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      const q = listQuerySchema.safeParse(request.query ?? {});
      if (!q.success) return invalidQuery(reply);
      const { before, after, around, limit: rawLimit } = q.data;
      if ([before, after, around].filter(v => v !== undefined).length > 1) return invalidQuery(reply);
      if (rawLimit !== undefined && (!LIMIT_RE.test(rawLimit) || Number(rawLimit) > COMMENT_PAGE_MAX)) return invalidQuery(reply);

      let pageRequest: CommentPageRequest = { kind: "newest" };
      if (before !== undefined || after !== undefined) {
        const cursor = decodeCursor((before ?? after)!);
        if (cursor === null) return invalidQuery(reply);
        pageRequest = before !== undefined ? { kind: "before", cursor } : { kind: "after", cursor };
      } else if (around !== undefined) {
        if (!UUID_RE.test(around)) return invalidQuery(reply);
        pageRequest = { kind: "around", commentId: around.toLowerCase() };
      }

      const access = await readableNote(reply, userId, id);
      if (access === null) return reply;
      const list = await listComments(deps.db, {
        noteId: id,
        viewer: viewerOf(request, access),
        request: pageRequest,
        limit: rawLimit === undefined ? COMMENT_PAGE_DEFAULT : Number(rawLimit),
      });
      if (list === null) return commentNotFound(reply);
      return reply.send(list);
    });

    app.get("/api/notes/:id/comments/unread-count", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      const access = await readableNote(reply, userId, id);
      if (access === null) return reply;
      return reply.send({ count: await countUnreadComments(deps.db, { noteId: id, userId }) } satisfies CommentUnreadCountDto);
    });

    app.get("/api/comments/:id", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await readableComment(request, reply, id);
      if (found === null) return reply;
      const comment = await getComment(deps.db, id, viewerOf(request, found.access));
      if (comment === null) return commentNotFound(reply);
      return reply.send(comment satisfies CommentDto);
    });

    app.post("/api/notes/:id/comments", { preHandler: app.authenticateTokenOrSession("notes:write"), bodyLimit: COMMENT_BODY_LIMIT }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      const body = postBodySchema.safeParse(request.body);
      if (!body.success) return invalidBody(reply);
      const access = await readableNote(reply, userId, id);
      if (access === null) return reply;
      if (!deps.limiters.comment.consume(userId)) return tooManyRequests(reply);

      const actor = await actorOf(request);
      const text = body.data.body;
      const replyToId = body.data.replyToId ?? null;
      const anchor = body.data.anchor === undefined ? null : { blockId: body.data.anchor.blockId, quote: body.data.anchor.quote ?? null };
      let out;
      try {
        out = await deps.db.transaction(tx => postCommentInTx(tx, { noteId: id, actor, body: text, replyToId, anchor }, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      broadcastCommentChange(deps.collab, out.noteId, "created", out.comment.id);
      deps.notifications?.notify(out.newNotificationUserIds);
      const dto = await getComment(deps.db, out.comment.id, viewerOf(request, access));
      // Deleted again between the commit and this read.
      if (dto === null) return commentNotFound(reply);
      return reply.code(201).send(dto satisfies CommentDto);
    });

    app.patch("/api/comments/:id", { preHandler: app.authenticateTokenOrSession("notes:write"), bodyLimit: COMMENT_BODY_LIMIT }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return commentNotFound(reply);
      const body = editBodySchema.safeParse(request.body);
      if (!body.success) return invalidBody(reply);
      const found = await readableComment(request, reply, id);
      if (found === null) return reply;
      if (!deps.limiters.comment.consume(userId)) return tooManyRequests(reply);

      const actor = await actorOf(request);
      const text = body.data.body;
      let out;
      try {
        out = await deps.db.transaction(tx => editCommentInTx(tx, { commentId: id, actor, body: text }, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      broadcastCommentChange(deps.collab, out.noteId, "edited", out.comment.id);
      deps.notifications?.notify(out.newNotificationUserIds);
      const dto = await getComment(deps.db, out.comment.id, viewerOf(request, found.access));
      if (dto === null) return commentNotFound(reply);
      return reply.send(dto satisfies CommentDto);
    });

    app.delete("/api/comments/:id", { preHandler: app.authenticateTokenOrSession("notes:write") }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await readableComment(request, reply, id);
      if (found === null) return reply;

      const actor = await actorOf(request);
      let out;
      try {
        out = await deps.db.transaction(tx => deleteCommentInTx(tx, { commentId: id, actor }, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      broadcastCommentChange(deps.collab, out.noteId, "deleted", out.comment.id);
      return reply.code(204).send();
    });

    app.post("/api/notes/:id/comments/read", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      // Only a missing body counts as `{}`.
      if (!readBodySchema.safeParse(request.body === undefined ? {} : request.body).success) return invalidBody(reply);
      const access = await readableNote(reply, userId, id);
      if (access === null) return reply;
      if (!deps.limiters.commentRead.consume(userId)) return tooManyRequests(reply);
      if (!(await markCommentsRead(deps.db, { noteId: id, userId }))) return noteNotFound(reply);
      return reply.code(204).send();
    });

    app.get("/api/notes/:id/mention-candidates", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      const q = candidatesQuerySchema.safeParse(request.query ?? {});
      if (!q.success) return invalidQuery(reply);
      const access = await readableNote(reply, userId, id);
      if (access === null) return reply;
      if (!deps.limiters.userSuggest.consume(userId)) return tooManyRequests(reply);
      const candidates = await resolveMentionCandidates(deps.db, { noteId: id, viewerId: userId, q: q.data.q ?? "" });
      if (candidates === null) return noteNotFound(reply);
      return reply.send({ candidates } satisfies { candidates: MentionCandidateDto[] });
    });
  };
}
