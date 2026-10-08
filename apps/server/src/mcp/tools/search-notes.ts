/**
 * #108 §8.5／#93 §8：`search_notes`——標題＋內文、大小寫不敏感的字面子字串比對，範圍＝呼叫者看得見的筆記。
 *
 * - 查詢在 `notes/search-query.ts` 的 `searchNotesForUser`（同一個 REPEATABLE READ READ ONLY 交易兩句：列表＋matches）。
 *   ⚠ 不用 LIKE／ILIKE（`%`／`_` 會變萬用字元）。
 * - **不做游標分頁（D33）**：`ORDER BY` 首鍵是 rank；回一個不可能算錯的 `truncated`。**不得發明 `cursor`／`nextCursor`。**
 * - 輸出兩個變體（I5）：`canRead`＝註冊時的 `ctx.collab && ctx.editing`（與 `register.ts` 讀取工具的閘門同一個判準）——
 *   沒有讀取工具的部署上，description 與 `sectionId` 的說明不提 read_note_section／outline／延遲。
 * - `matchedOn` 在每篇（偏離 D）：頂層一個值對混合清單沒有意義；頂層 `matchedOn` 已刪（破壞性，CHANGELOG Changed）。
 * - 摘錄（§8.3）：`notes/search-snippet.ts`，成本＝JSON 逃脫後（`escapedLength`），上限 `MCP_SNIPPET_MAX`。
 * - wire 預算（§8.4，偏離 E）：50 篇 × 3 個最壞情形約 328 000 > N；依「筆記順序 → ord 順序」加入 match，下一個會超過
 *   `MCP_SEARCH_WIRE_BUDGET` 就停止（不跳過再試）並在頂層放 `matchesTruncated: true`。
 * - 限流（§8.6）：自己的 `search` 桶，查詢之前扣；`contentRead` 不受影響。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { noNul } from "../../notes/schemas.js";
import { groupMatchesByNote, searchNotesForUser } from "../../notes/search-query.js";
import { SEARCH_MATCHES_PER_NOTE, type NoteSearchRow, type SearchMatchRow } from "../../notes/search-sql.js";
import { buildSnippet } from "../../notes/search-snippet.js";
import { noteSummarySchema, toNoteSummary, type NoteSummaryForModel } from "../dto.js";
import { MCP_SEARCH_WIRE_BUDGET, MCP_SNIPPET_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "../limits.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 200;
/** §8.4：`,"matchesTruncated":true` 兩份（structuredContent＋鏡像）的成本約 56，取 64。 */
const MATCHES_TRUNCATED_RESERVE = 64;

// spec §8.7 逐字（模型面字串：只寫各部署形態都為真的話——I5）。守衛：test/mcp-search.test.ts 的 M8 兩案（toBe 整句）。
const DESC_HEAD =
  "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. " +
  "Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body. ";
export const SEARCH_NOTES_DESCRIPTION_READ =
  DESC_HEAD +
  "A body match lists up to 3 sections in document order, each with an excerpt near the first hit; pass a `sectionId` to read_note_section. " +
  "`matches` can be empty for a body match; read the note's outline then. " +
  "Saved changes are usually searchable within seconds, but right after an upgrade older notes may match by title only for a while. " +
  "Attachments are not searched.";
export const SEARCH_NOTES_DESCRIPTION_NO_READ =
  DESC_HEAD +
  "A body match lists up to 3 sections in document order, each with an excerpt near the first hit; `matches` can be empty for a body match. " +
  "Attachments are not searched.";

export function searchNotesDescription(canRead: boolean): string {
  return canRead ? SEARCH_NOTES_DESCRIPTION_READ : SEARCH_NOTES_DESCRIPTION_NO_READ;
}

/** #93 §8.6：search 桶耗盡時的訊息（模型面字串，逐字）。 */
export const SEARCH_RATE_LIMITED_MESSAGE = "Too many searches right now. Wait a moment before searching again.";

export const searchNotesInput = {
  // 不變量 S 的第一、二關在 schema 層（`noNul` 與 `routes/notes.ts` 是同一份，M14）：
  // 含 NUL 的字串到不了 handler，也就到不了 SQL。第三關是 drizzle 的參數化。MCP 不 trim（照收原字串，§9.1）。
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY)
    .refine(noNul)
    .describe("Text to look for in note titles and body text. Matched literally — `%` and `_` are not wildcards."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many notes to return, 1 to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`),
};

export function searchNotesOutputFor(canRead: boolean) {
  const match = z.object({
    sectionId: z.string().describe(canRead ? "Pass this to read_note_section." : "The section's id."),
    heading: z.string().max(MCP_TEXT_MAX).describe("The section's heading, cut at 200 characters as written in JSON. Empty for `_top`."),
    headingTruncated: z.literal(true).optional().describe("Present only when `heading` was cut."),
    snippet: z.string().max(MCP_SNIPPET_MAX).describe("An excerpt of the section's text near the first hit, cut at 160 characters as written in JSON."),
  });
  const hit = noteSummarySchema.extend({
    matchedOn: z.enum(["title", "body", "both"]).describe("Whether your text was found in the title, the body, or both."),
    matches: z
      .array(match)
      .max(SEARCH_MATCHES_PER_NOTE)
      .describe("Up to 3 sections that contain your text, in document order. Empty when `matchedOn` is `title`, and can be empty for a body match."),
  });
  return {
    notes: z.array(hit).describe("The matching notes, best match first."),
    truncated: z
      .boolean()
      .describe("True when more notes matched than were returned. Narrow the query — there is no next page."),
    matchesTruncated: z
      .literal(true)
      .optional()
      .describe("Present when some matches were left out to keep this reply small. Ask for fewer notes with `limit`."),
  };
}

export interface SearchMatchForModel {
  sectionId: string;
  heading: string;
  headingTruncated?: true;
  snippet: string;
}

type MatchedOn = "title" | "body" | "both";
type SearchHitForModel = NoteSummaryForModel & { matchedOn: MatchedOn; matches: SearchMatchForModel[] };

/** 一個值在 wire 上的成本：structuredContent 一份＋鏡像 text 一份（再被逃脫一次，`mcp/tool-result.ts`）。 */
const wireCost = (v: unknown): number => {
  const j = JSON.stringify(v);
  return j.length + JSON.stringify(j).length;
};

export function assembleSearchPayload(
  notes: SearchHitForModel[],
  candidates: SearchMatchForModel[][],
  truncated: boolean,
  budget: number = MCP_SEARCH_WIRE_BUDGET,
): { notes: SearchHitForModel[]; truncated: boolean; matchesTruncated?: true } {
  let total = wireCost({ notes, truncated }) + MATCHES_TRUNCATED_RESERVE;
  let cut = false;
  outer: for (let i = 0; i < notes.length; i += 1) {
    for (const m of candidates[i] ?? []) {
      const c = wireCost(m) + 2; // 逗號兩份；是上界
      if (total + c > budget) {
        cut = true;
        break outer;
      }
      total += c;
      notes[i]!.matches.push(m);
    }
  }
  return cut ? { notes, truncated, matchesTruncated: true as const } : { notes, truncated };
}

function matchedOnOf(row: NoteSearchRow): MatchedOn {
  if (row.titleHit && row.bodyHit) return "both";
  return row.titleHit ? "title" : "body";
}

function toMatch(m: SearchMatchRow, qlen: number): SearchMatchForModel {
  const heading = truncateText(m.heading);
  const snippet = buildSnippet({ win: m.win, lead: m.p - m.win_start, qlen, winStart: m.win_start, bodyLen: m.body_len }, MCP_SNIPPET_MAX, escapedLength);
  return { sectionId: m.section_id, heading: heading.text, ...(heading.truncated ? { headingTruncated: true as const } : {}), snippet };
}

export interface SearchNotesArgs {
  query: string;
  limit?: number;
}

export async function searchNotes(args: SearchNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  if (!ctx.limiters.search.consume(ctx.userId)) return toolError("too_many_requests", SEARCH_RATE_LIMITED_MESSAGE);
  const limit = args.limit ?? DEFAULT_LIMIT;
  // 多取一列判斷「還有更多」，不發第二個計數查詢。
  const { rows, matches } = await searchNotesForUser(ctx.db, { userId: ctx.userId, query: args.query, limit });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const byNote = groupMatchesByNote(matches);
  const qlen = Array.from(args.query).length;
  const notes: SearchHitForModel[] = page.map(row => ({ ...toNoteSummary(row, row.role), matchedOn: matchedOnOf(row), matches: [] }));
  const candidates = page.map(row => (row.bodyHit ? (byNote.get(row.id) ?? []).map(m => toMatch(m, qlen)) : []));
  return toolResult(assembleSearchPayload(notes, candidates, truncated));
}
