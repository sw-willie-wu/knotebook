/**
 * #93 PR2 §9.1：`GET /api/search?q=&limit=&match=&cursor=`——網頁側欄（與 token 使用者）的全文搜尋。
 *
 * - **不開交易**（S14）：只呼叫 `notes/search-query.ts` 的 `searchNotesForUser`（它在 S14 的 `ROUTE_FILES`），與 MCP
 *   `search_notes` 同一支查詢、同一個 REPEATABLE READ READ ONLY 交易。可見性只來自 `visibleNoteBranches`，這裡不另做權限判斷。
 * - `q` **會 trim**（MCP 不 trim，照收原字串）；trim 後 1–`SEARCH_QUERY_MAX` 個 UTF-16 code unit、不得含 NUL。
 * - 不套 MCP 的 wire 預算（REST 沒有鏡像）：片段以 code unit 計（`REST_SNIPPET_MAX`），段落標題截到 `REST_HEADING_MAX`。
 * - `match=body`（D3）：只回內文有命中的筆記。查常見字時，標題命中排在前面（rank 0–2），只中內文的（rank 3）會被擠出
 *   頁面；web 的標題區是 client 端自己算的，只需要內文命中。預設 `match=all`＝標題或內文（與 MCP 同）。
 * - 分頁（D12）：keyset `(rank, updated_at 微秒, id)`，`nextCursor` 原樣帶回 `cursor`。游標只帶排序值與查詢指紋（`q`＋`match`
 *   的 sha256 前 16 hex），**不帶任何授權資訊**——拿別人的游標只會得到自己看得到、排在那個位置之後的列。翻頁之間被改過的筆記
 *   可能漏掉（被推到前面）或重複一次（rank 變大）；web 端以 id 去重（`notes/search-sql.ts` 與 `test/search-query.test.ts` Q7）。
 * - 順序：所有驗證（含游標）失敗 → 400 `invalid_body`，**不扣桶** → `search` 桶（與 MCP 共用，每人每分 60 次）→ 429。
 * - 錯誤訊息是 HTTP 層，中文（`sendError`）。
 */
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

/** 片段與段落標題的上限（UTF-16 code unit）。只有 REST 用，不放 shared。 */
export const REST_SNIPPET_MAX = 160;
export const REST_HEADING_MAX = 200;

const INVALID_QUERY = "搜尋字串須為 1 到 200 字，且不能含無法處理的字元";
const INVALID_LIMIT = `limit 須為 1 到 ${SEARCH_LIMIT_MAX} 的整數`;
const INVALID_CURSOR = "游標無效，請從第一頁重新搜尋";
const RATE_LIMITED = "搜尋過於頻繁，請稍後再試";

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
  })
  .strict();

type Match = "all" | "body";

/** 查詢指紋：游標只對同一個（trim 後的）`q` 與同一個 `match` 有效。 */
function fingerprintOf(match: Match, q: string): string {
  return createHash("sha256").update(`${match}\0${q}`, "utf8").digest("hex").slice(0, 16);
}

const RANK_RE = /^[0-3]$/;
/** pg `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 的形；前 23 字（毫秒）＋`Z` 交給 `parseCursorTimestamp` 驗日期本身。 */
const UPDATED_AT_KEY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

function encodeSearchCursor(fp: string, key: SearchPageKey): string {
  return encodeKeysetCursor("s", [fp, String(key.rank), key.updatedAtKey, key.id]);
}

/** 不是本站對這個 `q`＋`match` 發的游標 → null。 */
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
    app.get("/api/search", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { q } = parsed.data;
      const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;
      const match: Match = parsed.data.match ?? "all";
      const fp = fingerprintOf(match, q);
      let after: SearchPageKey | null = null;
      if (parsed.data.cursor !== undefined) {
        after = decodeSearchCursor(parsed.data.cursor, fp);
        if (after === null) return sendError(reply, 400, "invalid_body", INVALID_CURSOR);
      }
      const userId = request.user!.id;
      if (!deps.limiters.search.consume(userId)) return sendError(reply, 429, "too_many_requests", RATE_LIMITED);

      const { rows, matches } = await searchNotesForUser(deps.db, { userId, query: q, limit, bodyOnly: match === "body", page: { after } });
      const page = rows.slice(0, limit);
      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = page.at(-1)!;
        // page 模式一定有這欄（search-sql.ts）；沒有是內部錯誤，不是使用者輸入。
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
