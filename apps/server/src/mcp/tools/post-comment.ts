/**
 * Order: scope (charges `tokenWrite`) → role → `comment` limiter → section lookup → write transaction, which checks access again under
 * its locks → live signal. The limiter comes after the role so a `none` not-found doesn't consume it. A comment is not note content:
 * no `edit` charge, no write queue, no undo record.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { COMMENT_BODY_MAX, COMMENT_QUOTE_MAX } from "@knotebook/shared";
import { currentAgentLabel } from "../../auth/agent-label.js";
import { broadcastCommentChange } from "../../comments/broadcast.js";
import { COMMENT_NOT_FOUND_MESSAGE } from "../../comments/messages.js";
import { getComment } from "../../comments/queries.js";
import { postCommentInTx } from "../../comments/tx/write.js";
import { TxAbort } from "../../http/tx-abort.js";
import { NOTE_ID, SEC } from "../../notes/schemas.js";
import { resolveRole } from "../../notes/service.js";
import { COMMENT_ID, commentForModel, commentForModelSchema } from "../comment-output.js";
import { NOTE_NOT_FOUND_MESSAGE, SECTION_NOT_FOUND_MESSAGE, readOutlineForTool } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const POST_COMMENT_DESCRIPTION =
  "Add a comment to a note you can see, posted as you (with this credential's agent label, if any). " +
  "Write `@handle` to notify a person who can see the note, or `@handle/label` for one of their agents (an unknown label notifies the person instead); any other mention stays plain text. " +
  "A comment doesn't change the note, and no tool here edits or deletes one.";

export const postCommentInput = {
  note_id: NOTE_ID.describe("The note's id."),
  body: z.string().describe(`The comment, at most ${COMMENT_BODY_MAX} characters.`),
  reply_to: COMMENT_ID.optional().describe("The id of the comment you answer; its author is notified if they can still see the note and aren't you."),
  anchor_section_id: SEC.optional().describe(
    "A `sectionId` from read_note_outline: the comment is about that section and points at its heading (for `_top`, at the note's first block).",
  ),
  quote: z.string().optional().describe(`With \`anchor_section_id\`: the text you comment on, at most ${COMMENT_QUOTE_MAX} characters.`),
};

export const postCommentOutput = {
  comment: commentForModelSchema.describe("The comment as read_comments returns it."),
};

export const QUOTE_NEEDS_SECTION_MESSAGE = "`quote` goes with `anchor_section_id`; pass both or neither.";
export const EMPTY_TOP_SECTION_MESSAGE = "This note starts with a heading, so `_top` has no block to point at. Pass that heading's section id instead.";
export const COMMENT_RATE_LIMITED_MESSAGE = "Too many comments right now. Wait a moment before posting again.";
/** The REST wording says "Reload", which means nothing to an agent. */
export const COMMENT_CONFLICT_TOOL_MESSAGE = "The note's owner or group changed while the comment was being saved, so nothing was posted. Try again.";

export async function postCommentTool(
  args: { note_id: string; body: string; reply_to?: string; anchor_section_id?: string; quote?: string },
  ctx: McpToolCtx,
): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied) return denied;
  if (args.quote !== undefined && args.anchor_section_id === undefined) return toolError("invalid_body", QUOTE_NEEDS_SECTION_MESSAGE);
  if ((await resolveRole(ctx.db, ctx.userId, args.note_id)) === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (!ctx.limiters.comment.consume(ctx.userId)) return toolError("too_many_requests", COMMENT_RATE_LIMITED_MESSAGE);

  let anchor: { blockId: string; quote: string | null } | null = null;
  let sectionId: string | null = null;
  if (args.anchor_section_id !== undefined) {
    const read = await readOutlineForTool(ctx, args.note_id);
    if ("error" in read) return read.error;
    const section = read.outline.find(s => s.sectionId === args.anchor_section_id);
    if (section === undefined) return toolError("section_not_found", SECTION_NOT_FOUND_MESSAGE);
    const blockId = section.blockIds[0];
    if (blockId === undefined) return toolError("invalid_body", EMPTY_TOP_SECTION_MESSAGE);
    anchor = { blockId, quote: args.quote ?? null };
    sectionId = section.sectionId;
  }

  const actor = {
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    agentLabel: ctx.tokenId === null ? null : await currentAgentLabel(ctx.db, ctx.tokenId),
    isSiteAdmin: false,
  };
  const replyToId = args.reply_to ?? null;
  let out;
  try {
    out = await ctx.db.transaction(tx => postCommentInTx(tx, { noteId: args.note_id, actor, body: args.body, replyToId, anchor }, ctx.groupTestHook));
  } catch (err) {
    if (!(err instanceof TxAbort)) throw err;
    // The tool's own not-found wording, so a note deleted after the role check reads the same as one never seen.
    if (err.errCode === "not_found") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    if (err.errCode === "conflict") return toolError("conflict", COMMENT_CONFLICT_TOOL_MESSAGE);
    return toolError(err.errCode, err.message);
  }
  broadcastCommentChange(ctx.collab, out.noteId, "created", out.comment.id);
  ctx.notifications?.notify(out.newNotificationUserIds);
  const dto = await getComment(ctx.db, out.comment.id, { userId: ctx.userId, isSiteAdmin: false, canDeleteOthers: false });
  // Deleted again between the commit and this read.
  if (dto === null) return toolError("comment_not_found", COMMENT_NOT_FOUND_MESSAGE);
  return toolResult({ comment: commentForModel(dto, sectionId === null ? null : new Map([[anchor!.blockId, sectionId]])) });
}
