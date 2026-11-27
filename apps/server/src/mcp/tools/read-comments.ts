import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommentDto } from "@knotebook/shared";
import { COMMENT_NOT_FOUND_MESSAGE } from "../../comments/messages.js";
import { AGENT_READ_LAG_SECONDS, decodeCursor, encodeCursor, getComment, listCommentsForAgent, type CommentCursor, type CommentViewer } from "../../comments/queries.js";
import { NOTE_ID } from "../../notes/schemas.js";
import {
  BAD_SINCE_MESSAGE,
  COMMENT_ID,
  COMMENT_LIMIT_DESCRIBE,
  MCP_COMMENT_LIMIT_DEFAULT,
  MCP_COMMENT_LIMIT_MAX,
  SINCE_PAGE_CUT_SHORT_DESCRIBE,
  SINCE_PLACEHOLDER,
  commentForModel,
  commentForModelSchema,
} from "../comment-output.js";
import { resolveRole } from "../../notes/service.js";
import { NOTE_NOT_FOUND_MESSAGE, READ_RATE_LIMITED_MESSAGE, sectionsOfBlocks } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

export const READ_COMMENTS_DESCRIPTION =
  "Read the comments on a note, oldest first. Comments are a conversation about the note, kept apart from its content. " +
  "Pass `nextSince` back as `since` to get only newer ones, or `comment_id` for one comment. " +
  `Without \`comment_id\`, comments from the last ${AGENT_READ_LAG_SECONDS} seconds wait for a later call. ` +
  "A page holds fewer than `limit` when the comments are long.";

export const readCommentsInput = {
  note_id: NOTE_ID.describe("The note's id."),
  since: z.string().min(1).max(200).optional().describe("`nextSince` from a previous call: only comments after it."),
  comment_id: COMMENT_ID.optional().describe("Return just this comment, for example one a notification names."),
  limit: z.number().int().min(1).max(MCP_COMMENT_LIMIT_MAX).optional().describe(COMMENT_LIMIT_DESCRIBE),
};

export const readCommentsOutput = {
  comments: z.array(commentForModelSchema).describe("Oldest first."),
  nextSince: z
    .string()
    .nullable()
    .describe("Pass this as `since` next time. It is your `since` again when nothing new came back; null with `comment_id`, or when the note has no comments yet."),
  truncated: z.boolean().describe("True when more comments already wait after this page."),
  pageCutShort: z.literal(true).optional().describe(SINCE_PAGE_CUT_SHORT_DESCRIBE),
};

export const BOTH_SINCE_AND_COMMENT_MESSAGE = "Pass either `since` or `comment_id`, not both.";

const BASE_COST = wireCost({ comments: [], nextSince: SINCE_PLACEHOLDER, truncated: true }) + PAGE_CUT_RESERVE;

export async function readComments(
  args: { note_id: string; since?: string; comment_id?: string; limit?: number },
  ctx: McpToolCtx,
): Promise<CallToolResult> {
  if (args.since !== undefined && args.comment_id !== undefined) return toolError("invalid_body", BOTH_SINCE_AND_COMMENT_MESSAGE);
  let after: CommentCursor | null = null;
  if (args.since !== undefined) {
    after = decodeCursor(args.since);
    if (after === null) return toolError("invalid_body", BAD_SINCE_MESSAGE);
  }
  // Not `authorizeNoteRead`: reading the thread is not working on the note, so no presence. Role first, so a `none` doesn't spend the limiter.
  if ((await resolveRole(ctx.db, ctx.userId, args.note_id)) === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (!ctx.limiters.contentRead.consume(ctx.userId)) return toolError("too_many_requests", READ_RATE_LIMITED_MESSAGE);
  const viewer: CommentViewer = { userId: ctx.userId, isSiteAdmin: false, canDeleteOthers: false };

  let comments: CommentDto[];
  let cursors: CommentCursor[] = [];
  let hasMore = false;
  if (args.comment_id !== undefined) {
    const one = await getComment(ctx.db, args.comment_id, viewer);
    if (one === null || one.noteId !== args.note_id) return toolError("comment_not_found", COMMENT_NOT_FOUND_MESSAGE);
    comments = [one];
  } else {
    const page = await listCommentsForAgent(ctx.db, { noteId: args.note_id, after, limit: args.limit ?? MCP_COMMENT_LIMIT_DEFAULT, viewer });
    ({ comments, cursors, hasMore } = page);
  }

  const anchors = comments.flatMap(c => (c.anchor === null ? [] : [c.anchor.blockId]));
  const sectionOf = await sectionsOfBlocks(ctx, args.note_id, anchors);
  const items = comments.map(c => commentForModel(c, sectionOf));
  const kept = countWithinWireBudget(items.map(wireCost), BASE_COST);
  const cut = kept < items.length;
  if (args.comment_id !== undefined) return toolResult({ comments: items, nextSince: null, truncated: false });
  const last = cursors[kept - 1];
  return toolResult({
    comments: cut ? items.slice(0, kept) : items,
    nextSince: last === undefined ? (args.since ?? null) : encodeCursor(last),
    truncated: cut || hasMore,
    ...(cut ? { pageCutShort: true as const } : {}),
  });
}
