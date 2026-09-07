/**
 * #108 §8.5 `search_notes`：**只比標題**、大小寫不敏感的子字串比對，範圍＝呼叫者看得見的筆記。
 *
 * ⚠ **不用 `LIKE`／`ILIKE`**（SQL 形在 `mcp/queries.ts`）：那會把使用者輸入裡的 `%` 與 `_`
 * 當萬用字元，要正確處理就得加 `ESCAPE` 與跳脫——一條容易寫錯、而且寫錯了只會「搜尋結果
 * 怪怪的」不會變紅的路徑。
 *
 * ⚠ **起步不做游標分頁（D33）**：本工具的 `ORDER BY` 首鍵是 rank，而 keyset 分頁的前提是
 * 「cursor 的欄位序＝ORDER BY 的欄位序」——rank 整個缺席就會靜默重複或漏列。回一個
 * **不可能算錯**的 `truncated` 布林，模型的正確處置是把 query 寫得更精確，不是翻頁。
 * **不得發明 `cursor`／`nextCursor` 欄位。**
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { noNul } from "../../notes/schemas.js";
import { noteSummarySchema, toNoteSummary } from "../dto.js";
import { buildNoteSearchQuery } from "../queries.js";
import { toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY = 200;

export const SEARCH_NOTES_DESCRIPTION =
  "Find notes by title among the ones you can see. Searches note titles only — not the body text. " +
  "If you cannot find a note, its title may simply not contain your words. Matching is case-insensitive; " +
  "exact titles rank first, then titles that start with your words, then the rest.";

export const searchNotesInput = {
  // 不變量 S 的第一、二關在 schema 層（`noNul` 與 `routes/notes.ts` 是同一份，M14）：
  // 含 NUL 的字串到不了 handler，也就到不了 SQL。第三關是 drizzle 的參數化。
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY)
    .refine(noNul)
    .describe("Words to look for in note titles. Matched literally — `%` and `_` are not wildcards."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many notes to return, 1 to ${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`),
};

export const searchNotesOutput = {
  notes: z.array(noteSummarySchema).describe("The matching notes, best match first."),
  truncated: z
    .boolean()
    .describe("True when more notes matched than were returned. Narrow the query — there is no next page."),
  matchedOn: z.literal("title").describe("Which part of the note was searched."),
};

export interface SearchNotesArgs {
  query: string;
  limit?: number;
}

export async function searchNotes(args: SearchNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  // 多取一列判斷「還有更多」，不發第二個計數查詢。
  const rows = await buildNoteSearchQuery(ctx.db, { userId: ctx.userId, query: args.query, limit });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return toolResult({
    notes: page.map(row => toNoteSummary(row, row.role)),
    truncated,
    matchedOn: "title" as const,
  });
}
