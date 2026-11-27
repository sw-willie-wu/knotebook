import { z } from "zod";
import type { CommentDto } from "@knotebook/shared";
import { encodeCursor, type MentionView } from "../comments/queries.js";
import { UUID_RE } from "../notes/service.js";

export const COMMENT_ID = z.string().regex(UUID_RE).transform(s => s.toLowerCase());

export const MCP_COMMENT_LIMIT_DEFAULT = 20;
export const MCP_COMMENT_LIMIT_MAX = 50;

export const COMMENT_LIMIT_DESCRIBE = `1 to ${MCP_COMMENT_LIMIT_MAX}. Defaults to ${MCP_COMMENT_LIMIT_DEFAULT}.`;

export const SINCE_PAGE_CUT_SHORT_DESCRIBE =
  "Present, and true, when this page was cut short to keep the reply small; more follow, so call again with `nextSince` as `since`.";

export const BAD_SINCE_MESSAGE = "The `since` value is not one this server issued. Omit it to start from the oldest.";

/** Fixed length: the cursor of any row encodes to the same number of characters. */
export const SINCE_PLACEHOLDER = encodeCursor({ ts: "2026-01-01T00:00:00.000000Z", id: "00000000-0000-0000-0000-000000000000" });

/** Each mention span becomes the person's current handle; spans are code-point offsets, as `parseMentionSpans` returns them. */
export function renderCommentBody(body: string, mentions: readonly MentionView[]): string {
  const cps = [...body];
  let out = "";
  let at = 0;
  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    out += cps.slice(at, m.start).join("");
    out += m.agentLabel === null ? `@${m.handle}` : `@${m.handle}/${m.agentLabel}`;
    at = m.start + m.length;
  }
  return out + cps.slice(at).join("");
}

export const commentAuthorSchema = z.object({ handle: z.string(), agentLabel: z.string().nullable() });

export const commentForModelSchema = z.object({
  id: z.string(),
  author: commentAuthorSchema.describe("Who wrote it; `agentLabel` is set when one of their agents did."),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  replyToId: z.string().nullable().describe("The comment this one answers; it may have been deleted since."),
  anchor: z
    .object({ blockId: z.string(), quote: z.string().nullable(), sectionId: z.string().nullable() })
    .nullable()
    .describe(
      "The passage it is about, or null. `sectionId`: the section that holds the block now, for read_note_section; null if the block is gone or the note can't be read now.",
    ),
  body: z.string().describe("The comment's text. A mention reads as the person's current `@handle`, or `@handle/label` for one of their agents."),
});

export type CommentForModel = z.infer<typeof commentForModelSchema>;

export function commentForModel(c: CommentDto, sectionOf: ReadonlyMap<string, string> | null): CommentForModel {
  return {
    id: c.id,
    author: { handle: c.authorHandle, agentLabel: c.agentLabel },
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    replyToId: c.replyToId,
    anchor: c.anchor === null ? null : { blockId: c.anchor.blockId, quote: c.anchor.quote, sectionId: sectionOf?.get(c.anchor.blockId) ?? null },
    body: renderCommentBody(c.body, c.mentions),
  };
}
