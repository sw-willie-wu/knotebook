// Authorization runs outside the transaction; the note's space is confirmed again inside it with FOR KEY SHARE (tags/tx/note-tags.ts).
// 400s and 404s before authorization don't charge TAG_LIMIT; the 429 comes after it. Cookie-only: no token scope reaches these routes.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { canEditNoteTags, normalizeTagName, TAG_COLORS, TAGS_PER_NOTE_MAX, type AddNoteTagResultDto, type NoteTagsDto, type SpaceTagDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess } from "../groups/queries.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";
import {
  INVALID_TAG_NAME_MESSAGE,
  MERGE_SAME_TAG_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_TAG_LIMIT_MESSAGE,
  SPACE_TAG_LIMIT_MESSAGE,
  TAG_CONFLICT_MESSAGE,
  TAG_FORBIDDEN_MESSAGE,
  TAG_MANAGE_FORBIDDEN_MESSAGE,
  TAG_NAME_TAKEN_MESSAGE,
  TAG_NOT_FOUND_MESSAGE,
  TAGS_FORBIDDEN_MESSAGE,
} from "../tags/messages.js";
import { listSpaceTags, resolveTagManageAccess } from "../tags/queries.js";
import { deleteTagInTx, isTagNameTaken, mergeTagsInTx, updateTagInTx } from "../tags/tx/manage.js";
import { addNoteTagInTx, removeNoteTagInTx, type AddNoteTagResult, type NoteTagsResult } from "../tags/tx/note-tags.js";

export interface TagsRouteDeps {
  db: Db;
  limiters: { tag: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
}

const addBodySchema = z.object({ name: z.string() }).strict();
const patchBodySchema = z
  .object({ name: z.string().optional(), color: z.enum(TAG_COLORS).optional() })
  .strict()
  .refine(b => b.name !== undefined || b.color !== undefined);
const mergeBodySchema = z.object({ into: z.string() }).strict();

export function tagsRoutes(deps: TagsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", NOTE_NOT_FOUND_MESSAGE);
    const tooManyRequests = (reply: FastifyReply): FastifyReply =>
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

    const sendResult = (reply: FastifyReply, out: NoteTagsResult | AddNoteTagResult): FastifyReply => {
      switch (out.kind) {
        case "ok":
          return reply.send("tag" in out ? ({ tags: out.tags, tag: out.tag } satisfies AddNoteTagResultDto) : ({ tags: out.tags } satisfies NoteTagsDto));
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

    const tagNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "tag_not_found", TAG_NOT_FOUND_MESSAGE);
    // Personal tags are the owner's alone and a group's need the manage-group permission; a tag the caller can't see is a 404 like a missing one.
    const manageAccess = async (user: { id: string; isAdmin: boolean }, tagId: string, reply: FastifyReply) => {
      const access = await resolveTagManageAccess(deps.db, tagId, user);
      if (access.kind === "not_found") return tagNotFound(reply);
      if (access.kind === "forbidden") return sendError(reply, 403, "forbidden", TAG_MANAGE_FORBIDDEN_MESSAGE);
      return access.space;
    };

    app.patch("/api/tags/:tagId", { preHandler: app.authenticate }, async (request, reply) => {
      const { tagId: rawTagId } = request.params as { tagId: string };
      const user = request.user!;
      if (!UUID_RE.test(rawTagId)) return tagNotFound(reply);
      const tagId = rawTagId.toLowerCase();
      const body = patchBodySchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const name = body.data.name === undefined ? undefined : normalizeTagName(body.data.name);
      if (name === null) return sendError(reply, 400, "invalid_tag_name", INVALID_TAG_NAME_MESSAGE);

      const space = await manageAccess(user, tagId, reply);
      if ("send" in space) return space;
      if (!deps.limiters.tag.consume(user.id)) return tooManyRequests(reply);

      const input = { tagId, space, name, color: body.data.color };
      let out;
      try {
        out = await deps.db.transaction(tx => updateTagInTx(tx, input));
      } catch (err) {
        if (isTagNameTaken(err)) return sendError(reply, 409, "tag_name_taken", TAG_NAME_TAKEN_MESSAGE);
        throw err;
      }
      switch (out.kind) {
        case "ok":
          return reply.send(out.tag satisfies SpaceTagDto);
        case "not_found":
          return tagNotFound(reply);
        case "invalid_tag_name":
          return sendError(reply, 400, "invalid_tag_name", INVALID_TAG_NAME_MESSAGE);
      }
    });

    app.post("/api/tags/:tagId/merge", { preHandler: app.authenticate }, async (request, reply) => {
      const { tagId: rawTagId } = request.params as { tagId: string };
      const user = request.user!;
      if (!UUID_RE.test(rawTagId)) return tagNotFound(reply);
      const sourceId = rawTagId.toLowerCase();
      const body = mergeBodySchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      if (!UUID_RE.test(body.data.into)) return tagNotFound(reply);
      const targetId = body.data.into.toLowerCase();

      const space = await manageAccess(user, sourceId, reply);
      if ("send" in space) return space;
      // After the source is authorized, so that a tag the caller can't see never answers differently from any other foreign tag.
      if (sourceId === targetId) return sendError(reply, 400, "merge_same_tag", MERGE_SAME_TAG_MESSAGE);
      // A target that isn't in the same space is a 404 before anything is charged; the transaction checks it again.
      if ((await listSpaceTags(deps.db, space, targetId)).length === 0) return tagNotFound(reply);
      if (!deps.limiters.tag.consume(user.id)) return tooManyRequests(reply);

      const input = { sourceId, targetId, space };
      const merged = await deps.db.transaction(tx => mergeTagsInTx(tx, input));
      if (merged.kind === "not_found") return tagNotFound(reply);
      return reply.send(merged.tag satisfies SpaceTagDto);
    });

    app.delete("/api/tags/:tagId", { preHandler: app.authenticate }, async (request, reply) => {
      const { tagId: rawTagId } = request.params as { tagId: string };
      const user = request.user!;
      if (!UUID_RE.test(rawTagId)) return tagNotFound(reply);
      const tagId = rawTagId.toLowerCase();

      const space = await manageAccess(user, tagId, reply);
      if ("send" in space) return space;
      if (!deps.limiters.tag.consume(user.id)) return tooManyRequests(reply);

      const input = { tagId, space };
      const deleted = await deps.db.transaction(tx => deleteTagInTx(tx, input));
      if (!deleted) return tagNotFound(reply);
      return reply.code(204).send();
    });
  };
}
