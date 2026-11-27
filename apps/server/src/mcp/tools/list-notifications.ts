/**
 * The cursor advances over every scanned row, including rows skipped because the caller can no longer read their note, so a page can
 * be short or empty while `truncated` is true. A token sees only rows addressed to its own label, never the person's or another
 * agent's; a session sees only the person's.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { currentAgentLabel } from "../../auth/agent-label.js";
import { AGENT_READ_LAG_SECONDS, commentBodiesByIds, decodeCursor, encodeCursor, type CommentCursor } from "../../comments/queries.js";
import { scanAgentNotifications } from "../../notifications/queries.js";
import {
  BAD_SINCE_MESSAGE,
  COMMENT_LIMIT_DESCRIBE,
  MCP_COMMENT_LIMIT_DEFAULT,
  MCP_COMMENT_LIMIT_MAX,
  SINCE_PAGE_CUT_SHORT_DESCRIBE,
  SINCE_PLACEHOLDER,
  commentAuthorSchema,
  renderCommentBody,
} from "../comment-output.js";
import { MCP_TEXT_MAX, truncateCodeUnits, truncateText } from "../limits.js";
import { READ_RATE_LIMITED_MESSAGE } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

/** Rows looked at per call, readable or not. */
export const NOTIFICATION_SCAN_MAX = 100;
/** UTF-16 code units. */
export const NOTIFICATION_BODY_MAX = 1000;

export function listNotificationsDescription(canReadComments: boolean): string {
  return (
    "List notifications for you, oldest first: a comment that mentions you or answers yours. " +
    "With an agent's credential, only the ones addressed to its label (`@handle/label`, or answers to comments it wrote). " +
    `Pass \`nextSince\` back as \`since\` to get only newer ones; notifications from the last ${AGENT_READ_LAG_SECONDS} seconds wait for a later call. ` +
    "Notifications on notes you can no longer see are skipped, so a page can be short, even empty, while `truncated` is true. " +
    `The comment's text is cut at ${NOTIFICATION_BODY_MAX} characters, with \`bodyTruncated\`` +
    (canReadComments ? "; read_comments with `comment_id` returns all of it." : ".")
  );
}

export const listNotificationsInput = {
  since: z.string().min(1).max(200).optional().describe("`nextSince` from a previous call: only notifications after it."),
  limit: z.number().int().min(1).max(MCP_COMMENT_LIMIT_MAX).optional().describe(COMMENT_LIMIT_DESCRIBE),
};

const notificationForModelSchema = z.object({
  id: z.string(),
  kind: z.enum(["mention", "reply"]),
  noteId: z.string(),
  noteTitle: z.string().max(MCP_TEXT_MAX),
  noteTitleTruncated: z.literal(true).optional(),
  commentId: z.string(),
  actor: commentAuthorSchema.describe("Who wrote the comment; `agentLabel` is set when one of their agents did."),
  createdAt: z.string(),
  body: z.string().describe("The comment's text as read_comments returns it, as it reads now."),
  bodyTruncated: z.literal(true).optional(),
});
type NotificationForModel = z.infer<typeof notificationForModelSchema>;

export const listNotificationsOutput = {
  notifications: z.array(notificationForModelSchema).describe("Oldest first."),
  nextSince: z.string().nullable().describe("Pass this as `since` next time. It is your `since` again when nothing new came back; null when there are none yet."),
  truncated: z.boolean().describe("True when more notifications already wait after this page."),
  pageCutShort: z.literal(true).optional().describe(SINCE_PAGE_CUT_SHORT_DESCRIBE),
};

const BASE_COST = wireCost({ notifications: [], nextSince: SINCE_PLACEHOLDER, truncated: true }) + PAGE_CUT_RESERVE;

export async function listNotificationsTool(args: { since?: string; limit?: number }, ctx: McpToolCtx): Promise<CallToolResult> {
  let after: CommentCursor | null = null;
  if (args.since !== undefined) {
    after = decodeCursor(args.since);
    if (after === null) return toolError("invalid_body", BAD_SINCE_MESSAGE);
  }
  if (!ctx.limiters.contentRead.consume(ctx.userId)) return toolError("too_many_requests", READ_RATE_LIMITED_MESSAGE);
  const limit = args.limit ?? MCP_COMMENT_LIMIT_DEFAULT;
  const echo = { notifications: [], nextSince: args.since ?? null, truncated: false };

  const label = ctx.tokenId === null ? null : await currentAgentLabel(ctx.db, ctx.tokenId);
  // The token row is gone (revoked mid-request): it must not fall through to the person's rows.
  if (ctx.tokenId !== null && label === null) return toolResult(echo);

  const scan = await scanAgentNotifications(ctx.db, { userId: ctx.userId, agentLabel: label, after, max: NOTIFICATION_SCAN_MAX });
  const readable = scan.rows.filter(r => r.noteTitle !== null);
  const bodies = await commentBodiesByIds(ctx.db, readable.map(r => r.commentId));

  const items: NotificationForModel[] = [];
  const itemCursors: CommentCursor[] = [];
  let consumed = 0;
  for (const r of scan.rows) {
    if (items.length === limit) break;
    consumed += 1;
    const comment = bodies.get(r.commentId);
    if (r.noteTitle === null || comment === undefined) continue;
    const title = truncateText(r.noteTitle);
    const body = truncateCodeUnits(renderCommentBody(comment.body, comment.mentions), NOTIFICATION_BODY_MAX);
    items.push({
      id: r.id,
      kind: r.kind,
      noteId: r.noteId,
      noteTitle: title.text,
      ...(title.truncated ? { noteTitleTruncated: true as const } : {}),
      commentId: r.commentId,
      actor: { handle: r.actorHandle, agentLabel: r.actorAgentLabel },
      createdAt: r.createdAt.toISOString(),
      body: body.text,
      ...(body.truncated ? { bodyTruncated: true as const } : {}),
    });
    itemCursors.push(r.cursor);
  }

  const kept = countWithinWireBudget(items.map(wireCost), BASE_COST);
  if (kept < items.length) {
    return toolResult({ notifications: items.slice(0, kept), nextSince: encodeCursor(itemCursors[kept - 1]!), truncated: true, pageCutShort: true as const });
  }
  const lastScanned = scan.rows[consumed - 1];
  if (lastScanned === undefined) return toolResult(echo);
  return toolResult({ notifications: items, nextSince: encodeCursor(lastScanned.cursor), truncated: consumed < scan.rows.length || scan.hasMore });
}
