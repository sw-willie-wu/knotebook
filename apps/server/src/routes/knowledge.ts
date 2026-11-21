// Every "not found" of a scope is one answer, whether the id is malformed, missing, or just not yours. Index routes are session-only and charge no limiter; `refs` shares the search limiter and charges only after validation.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  KNOWLEDGE_INDEX_TAG_FILTER_MAX,
  KNOWLEDGE_ID_RE,
  SEARCH_QUERY_MAX,
  isKnowledgeIndexEvidenceFilter,
  isKnowledgeIndexStatusFilter,
  type KnowledgeIndexScopeRef,
  type KnowledgeRefsDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { loadKnowledgeIndex } from "../knowledge/index-query.js";
import {
  INVALID_INDEX_EVIDENCE_MESSAGE,
  INVALID_INDEX_STATUS_MESSAGE,
  INVALID_INDEX_TAGS_MESSAGE,
  INVALID_REFS_EXCLUDE_MESSAGE,
  INVALID_REFS_QUERY_MESSAGE,
  KNOWLEDGE_REF_NOT_FOUND_MESSAGE,
  KNOWLEDGE_SCOPE_NOT_FOUND_MESSAGE,
  REFS_RATE_LIMITED_MESSAGE,
} from "../knowledge/messages.js";
import { resolveKnowledgeRef, searchKnowledgeRefs } from "../knowledge/refs.js";
import { resolveKnowledgeScope } from "../knowledge/scope.js";
import { noNul } from "../notes/schemas.js";
import { UUID_RE } from "../notes/service.js";

// A raw tags value is at most 20 ids plus separators; anything longer is refused before it is split.
const TAGS_RAW_MAX = 20 * 40;

const tagsSchema = z
  .string()
  .max(TAGS_RAW_MAX, INVALID_INDEX_TAGS_MESSAGE)
  .transform((raw) => raw.split(",").map((t) => t.trim().toLowerCase()))
  .pipe(z.array(z.string().regex(UUID_RE, INVALID_INDEX_TAGS_MESSAGE)))
  .transform((ids) => [...new Set(ids)])
  .pipe(z.array(z.string()).max(KNOWLEDGE_INDEX_TAG_FILTER_MAX, INVALID_INDEX_TAGS_MESSAGE));

const indexQuerySchema = z
  .object({
    tags: tagsSchema.optional(),
    status: z.string().refine(isKnowledgeIndexStatusFilter, INVALID_INDEX_STATUS_MESSAGE).optional(),
    evidence: z.string().refine(isKnowledgeIndexEvidenceFilter, INVALID_INDEX_EVIDENCE_MESSAGE).optional(),
  })
  .strict();

const refsQuerySchema = z
  .object({
    q: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1, INVALID_REFS_QUERY_MESSAGE).max(SEARCH_QUERY_MAX, INVALID_REFS_QUERY_MESSAGE).refine(noNul, INVALID_REFS_QUERY_MESSAGE)),
    excludeNote: z.string().regex(UUID_RE, INVALID_REFS_EXCLUDE_MESSAGE).optional(),
  })
  .strict();

export interface KnowledgeRouteDeps {
  db: Db;
  limiters: { search: FixedWindowLimiter };
}

export function knowledgeRoutes(deps: KnowledgeRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const scopeNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", KNOWLEDGE_SCOPE_NOT_FOUND_MESSAGE);
    const refNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", KNOWLEDGE_REF_NOT_FOUND_MESSAGE);

    // An unexpected database error must not reach the log with its parameters; the `refs` query carries the search text, so every knowledge route follows the same rule.
    async function serveIndex(request: FastifyRequest, reply: FastifyReply, ref: KnowledgeIndexScopeRef): Promise<FastifyReply> {
      const parsed = indexQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const userId = request.user!.id;
      try {
        const scope = await resolveKnowledgeScope(deps.db, userId, ref);
        if (scope === null) return scopeNotFound(reply);
        const dto = await loadKnowledgeIndex(deps.db, {
          userId,
          scope,
          filters: { tagIds: parsed.data.tags ?? [], status: parsed.data.status ?? null, evidence: parsed.data.evidence ?? null },
        });
        return reply.send(dto);
      } catch (err) {
        throw redactDbError(request.log, err, "knowledge index");
      }
    }

    app.get("/api/knowledge/index/me", { preHandler: app.authenticate }, (request, reply) => serveIndex(request, reply, { kind: "personal" }));

    app.get("/api/knowledge/index/groups/:id", { preHandler: app.authenticate }, (request, reply) =>
      serveIndex(request, reply, { kind: "group", groupId: (request.params as { id: string }).id }),
    );

    app.get("/api/knowledge/index/folders/:id", { preHandler: app.authenticate }, (request, reply) =>
      serveIndex(request, reply, { kind: "folder", folderId: (request.params as { id: string }).id }),
    );

    app.get("/api/knowledge/refs", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = refsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const userId = request.user!.id;
      if (!deps.limiters.search.consume(userId)) return sendError(reply, 429, "too_many_requests", REFS_RATE_LIMITED_MESSAGE);
      try {
        const candidates = await searchKnowledgeRefs(deps.db, { userId, query: parsed.data.q, excludeNoteId: parsed.data.excludeNote ?? null });
        return reply.send({ candidates } satisfies KnowledgeRefsDto);
      } catch (err) {
        throw redactDbError(request.log, err, "knowledge refs search");
      }
    });

    app.get("/api/knowledge/refs/:id/:knowledgeId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, knowledgeId } = request.params as { id: string; knowledgeId: string };
      if (!UUID_RE.test(id) || !KNOWLEDGE_ID_RE.test(knowledgeId)) return refNotFound(reply);
      try {
        const found = await resolveKnowledgeRef(deps.db, { userId: request.user!.id, noteId: id, knowledgeId });
        return found === null ? refNotFound(reply) : reply.send(found);
      } catch (err) {
        throw redactDbError(request.log, err, "knowledge ref lookup");
      }
    });
  };
}
