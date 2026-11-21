// q is trimmed (MCP isn't). match=body exists because on common words title hits (rank 0–2) push body-only hits (rank 3) off the page, and the web computes title matches itself.
// The cursor carries sort values and a query fingerprint only, no authorization; notes edited between pages can be missed or duplicated, so the web dedupes by id.
// Visibility comes only from visibleNoteBranches. No transaction here: searchNotesForUser runs the same REPEATABLE READ READ ONLY transaction as MCP search_notes.
// Validation failures (including the cursor) don't consume the search limiter (shared with MCP search_notes).
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, type NoteSearchHitDto, type NoteSearchMatchDto, type NoteSearchResultDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { decodeKeysetCursor, encodeKeysetCursor, parseCursorTimestamp } from "../mcp/keyset-cursor.js";
import { truncateCodeUnits } from "../mcp/limits.js";
import { accessFromListRow } from "../notes/list-query.js";
import { toNoteDto } from "../notes/note-dto.js";
import { noNul } from "../notes/schemas.js";
import { groupMatchesByNote, searchNotesForUser } from "../notes/search-query.js";
import type { NoteSearchRow, SearchMatchRow, SearchPageKey } from "../notes/search-sql.js";
import { buildSnippet } from "../notes/search-snippet.js";
import { UUID_RE } from "../notes/service.js";
import { INVALID_SEARCH_TAGS_MESSAGE, resolveSearchTagFilter } from "../tags/search-filter.js";

export const REST_SNIPPET_MAX = 160;
export const REST_HEADING_MAX = 200;

const INVALID_QUERY = "The search text must be 1 to 200 characters and can't contain characters that can't be processed.";
const INVALID_LIMIT = `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}.`;
const INVALID_CURSOR = "The cursor is invalid. Search again from the first page.";
const RATE_LIMITED = "Too many searches. Wait a moment and try again.";

const searchQuerySchema = z
  .object({
    q: z
      .string()
      .transform(s => s.trim())
      .pipe(z.string().min(1, INVALID_QUERY).max(SEARCH_QUERY_MAX, INVALID_QUERY).refine(noNul, INVALID_QUERY)),
    limit: z
      .string()
      .regex(/^\d+$/, INVALID_LIMIT)
      .transform(Number)
      .pipe(z.number().int().min(1, INVALID_LIMIT).max(SEARCH_LIMIT_MAX, INVALID_LIMIT))
      .optional(),
    match: z.enum(["all", "body"]).optional(),
    cursor: z.string().optional(),
    tags: z.string().optional(),
  })
  .strict();

type Match = "all" | "body";

function fingerprintOf(match: Match, q: string, tagIds: readonly string[]): string {
  return createHash("sha256").update(tagIds.length === 0 ? `${match}\0${q}` : `${match}\0${q}\0${[...tagIds].sort().join(",")}`, "utf8").digest("hex").slice(0, 16);
}

const RANK_RE = /^[0-3]$/;
const UPDATED_AT_KEY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

function encodeSearchCursor(fp: string, key: SearchPageKey): string {
  return encodeKeysetCursor("s", [fp, String(key.rank), key.updatedAtKey, key.id]);
}

export function decodeSearchCursor(raw: string, fp: string): SearchPageKey | null {
  const parts = decodeKeysetCursor(raw, "s", 4);
  if (parts === null) return null;
  const [cfp, rank, updatedAtKey, id] = parts as [string, string, string, string];
  if (cfp !== fp || !RANK_RE.test(rank)) return null;
  const m = UPDATED_AT_KEY_RE.exec(updatedAtKey);
  if (m === null || parseCursorTimestamp(`${m[1]}Z`) === null) return null;
  if (!UUID_RE.test(id)) return null;
  return { rank: Number(rank), updatedAtKey, id };
}

function matchedOnOf(row: NoteSearchRow): NoteSearchHitDto["matchedOn"] {
  if (row.titleHit && row.bodyHit) return "both";
  return row.titleHit ? "title" : "body";
}

function toMatchDto(m: SearchMatchRow, qlen: number): NoteSearchMatchDto {
  return {
    sectionId: m.section_id,
    heading: truncateCodeUnits(m.heading, REST_HEADING_MAX).text,
    snippet: buildSnippet({ win: m.win, lead: m.p - m.win_start, qlen, winStart: m.win_start, bodyLen: m.body_len }, REST_SNIPPET_MAX, cp => cp.length),
  };
}

export interface SearchRouteDeps {
  db: Db;
  limiters: { search: FixedWindowLimiter };
}

export function searchRoutes(deps: SearchRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/search", { preHandler: app.authenticateTokenOrSession("notes:read") }, async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { q } = parsed.data;
      const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;
      const match: Match = parsed.data.match ?? "all";
      const userId = request.user!.id;
      let tagIds: string[] = [];
      if (parsed.data.tags !== undefined) {
        const resolved = await resolveSearchTagFilter(deps.db, userId, parsed.data.tags);
        if (resolved === null) return sendError(reply, 400, "invalid_tags", INVALID_SEARCH_TAGS_MESSAGE);
        tagIds = resolved;
      }
      const fp = fingerprintOf(match, q, tagIds);
      let after: SearchPageKey | null = null;
      if (parsed.data.cursor !== undefined) {
        after = decodeSearchCursor(parsed.data.cursor, fp);
        if (after === null) return sendError(reply, 400, "invalid_body", INVALID_CURSOR);
      }
      if (!deps.limiters.search.consume(userId)) return sendError(reply, 429, "too_many_requests", RATE_LIMITED);

      const { rows, matches } = await searchNotesForUser(deps.db, { userId, query: q, limit, bodyOnly: match === "body", tagIds, page: { after } });
      const page = rows.slice(0, limit);
      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = page.at(-1)!;
        if (last.updatedAtKey === undefined) throw new Error("search: updatedAtKey missing in page mode");
        nextCursor = encodeSearchCursor(fp, { rank: last.rank, updatedAtKey: last.updatedAtKey, id: last.id });
      }
      const byNote = groupMatchesByNote(matches);
      const qlen = Array.from(q).length;
      const hits = page.map((row): NoteSearchHitDto => ({
        note: toNoteDto(row, accessFromListRow(row)),
        matchedOn: matchedOnOf(row),
        matches: row.bodyHit ? (byNote.get(row.id) ?? []).map(m => toMatchDto(m, qlen)) : [],
      }));
      const body: NoteSearchResultDto = { hits, nextCursor };
      return reply.send(body);
    });
  };
}
