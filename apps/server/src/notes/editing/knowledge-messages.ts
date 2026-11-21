import { KNOWLEDGE_CONCLUSION_MAX, KNOWLEDGE_WHEN_MAX, type KnowledgeCommentProblem, type KnowledgeProblem } from "@knotebook/shared";

const HEADING_CHARS = 80;

function quotedHeading(heading: string): string {
  const points = Array.from(heading);
  if (points.length === 0) return "an empty heading";
  const cut = points.length > HEADING_CHARS ? `${points.slice(0, HEADING_CHARS).join("")}…` : heading;
  return `the heading ${JSON.stringify(cut)}`;
}

const key = (p: KnowledgeProblem): string => (p.key === undefined ? "line" : p.key);

const REASONS: Record<KnowledgeCommentProblem, (p: KnowledgeProblem) => string> = {
  not_multiline: () => "must have knotebook:knowledge alone on its first line and each key on a line of its own",
  bad_line: () => "has a line that isn't key: value",
  duplicate_key: p => `has \`${key(p)}\` more than once`,
  bad_value: p => `has a quoted \`${key(p)}\` that isn't one JSON string`,
  unstorable: p => `has a \`${key(p)}\` with a NUL character or an unpaired surrogate`,
  unclosed: () => "has no closing -->",
  too_long: p => `has a \`${key(p)}\` longer than ${p.key === "when" ? KNOWLEDGE_WHEN_MAX : KNOWLEDGE_CONCLUSION_MAX} characters`,
  line_break: p => `has a line break in \`${key(p)}\`: write it on one line`,
  bad_id: () => "has an `id` that isn't k_ followed by 8 lowercase hex digits (leave the id line out for new knowledge)",
  bad_evidence: () => "has an `evidence` other than tested, docs, inferred or unconfirmed",
  bad_status: () => "has a `status` other than unverified or outdated (leave it out for current)",
  bad_date: () => "has a `verified` that isn't a date written YYYY-MM-DD",
  bad_ref: () => "has a `superseded_by` that isn't a knowledge id or <note id>#<knowledge id>",
  blank_line_missing: () => "needs a blank line after its -->",
  two_comments: () => "is the second knowledge comment under that heading",
  empty: () => "sets none of when, conclusion, evidence, verified, status and superseded_by",
  superseded_required: () => "says outdated without a `superseded_by`",
  superseded_self: () => "names itself in `superseded_by`",
};

/** English only: HTTP and MCP messages are. The heading is the one piece of note text allowed into an error message. */
export function knowledgeProblemMessage(p: KnowledgeProblem): string {
  return `The knowledge comment under ${quotedHeading(p.heading)} ${REASONS[p.problem](p)}. Nothing was written.`;
}

export const KNOWLEDGE_ATTR_MESSAGE =
  "That markdown has knowledge info this editor cannot store, so nothing was written. Knowledge info is set only by a <!-- knotebook:knowledge … --> comment on the lines right after a heading, as read_note_section returns it.";

export const INVALID_KNOWLEDGE_FALLBACK_MESSAGE = "A knowledge comment in that markdown is not valid, so nothing was written.";
