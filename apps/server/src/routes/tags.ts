// Authorization runs outside the transaction; the note's space is confirmed again inside it with FOR KEY SHARE (tags/tx/note-tags.ts).
// 400s and 404s before authorization don't charge TAG_LIMIT; the 429 comes after it. Cookie-only: no token scope reaches these routes.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canEditNoteTags, normalizeTagName, TAGS_PER_NOTE_MAX, type NoteTagsDto, type SpaceTagDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess } from "../groups/queries.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";
import {
  INVALID_TAG_NAME_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_TAG_LIMIT_MESSAGE,
  SPACE_TAG_LIMIT_MESSAGE,
  TAG_CONFLICT_MESSAGE,
  TAG_FORBIDDEN_MESSAGE,
  TAG_NOT_FOUND_MESSAGE,
  TAGS_FORBIDDEN_MESSAGE,
} from "../tags/messages.js";
import { listSpaceTags } from "../tags/queries.js";
import { addNoteTagInTx, removeNoteTagInTx, type NoteTagsResult } from "../tags/tx/note-tags.js";

export interface TagsRouteDeps {
  db: Db;
  limiters: { tag: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
}

const addBodySchema = z.object({ name: z.string() }).strict();

export function tagsRoutes(deps: TagsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", NOTE_NOT_FOUND_MESSAGE);
    const tooManyRequests = (reply: FastifyReply): FastifyReply =>
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

    const sendResult = (reply: FastifyReply, out: NoteTagsResult): FastifyReply => {
      switch (out.kind) {
        case "ok":
          return reply.send({ tags: out.tags } satisfies NoteTagsDto);
        case "invalid_tag_name":
          return sendError(reply, 400, "invalid_tag_name", INVALID_TAG_NAME_MESSAGE);
        case "tag_limit_reached":
          return sendError(reply, 409, "tag_limit_reached", out.limit === TAGS_PER_NOTE_MAX ? NOTE_TAG_LIMIT_MESSAGE : SPACE_TAG_LIMIT_MESSAGE);
        case "not_found":
          return noteNotFound(reply);
        case "conflict":
          return sendError(reply, 409, "conflict", TAG_CONFLICT_MESSAGE);
      }
    };

    app.get("/api/tags", { preHandler: app.authenticate }, async (request, reply) => {
      const out = await listSpaceTags(deps.db, { kind: "personal", ownerId: request.user!.id });
      return reply.send(out satisfies SpaceTagDto[]);
    });

    app.get("/api/groups/:id/tags", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      if (!(access.role?.permissions.edit ?? false) && !access.manageGroup) return sendError(reply, 403, "forbidden", TAGS_FORBIDDEN_MESSAGE);
      const out = await listSpaceTags(deps.db, { kind: "group", groupId: id });
      return reply.send(out satisfies SpaceTagDto[]);
    });

    app.post("/api/notes/:id/tags", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      const body = addBodySchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const name = normalizeTagName(body.data.name);
      if (name === null) return sendError(reply, 400, "invalid_tag_name", INVALID_TAG_NAME_MESSAGE);

      const access = await resolveNoteAccess(deps.db, user.id, id);
      if (access.role === "none") return noteNotFound(reply);
      if (!canEditNoteTags(access)) return sendError(reply, 403, "forbidden", TAG_FORBIDDEN_MESSAGE);
      if (!deps.limiters.tag.consume(user.id)) return tooManyRequests(reply);
      await deps.groupTestHook?.("tag-note-authorized", { noteId: id });

      const input = { noteId: id, expected: { ownerId: access.ownerId, groupId: access.groupId }, name, createdBy: user.id };
      const out = await deps.db.transaction(tx => addNoteTagInTx(tx, input, deps.groupTestHook));
      return sendResult(reply, out);
    });

    app.delete("/api/notes/:id/tags/:tagId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, tagId: rawTagId } = request.params as { id: string; tagId: string };
      const user = request.user!;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      if (!UUID_RE.test(rawTagId)) return sendError(reply, 404, "tag_not_found", TAG_NOT_FOUND_MESSAGE);
      const tagId = rawTagId.toLowerCase();

      const access = await resolveNoteAccess(deps.db, user.id, id);
      if (access.role === "none") return noteNotFound(reply);
      if (!canEditNoteTags(access)) return sendError(reply, 403, "forbidden", TAG_FORBIDDEN_MESSAGE);
      if (!deps.limiters.tag.consume(user.id)) return tooManyRequests(reply);
      await deps.groupTestHook?.("tag-note-authorized", { noteId: id });

      const input = { noteId: id, expected: { ownerId: access.ownerId, groupId: access.groupId }, tagId };
      const out = await deps.db.transaction(tx => removeNoteTagInTx(tx, input));
      return sendResult(reply, out);
    });
  };
}
