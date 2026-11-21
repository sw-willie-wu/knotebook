import type { FastifyReply } from "fastify";
import { PALETTE_COLORS, type ErrorCode, type KnowledgeProblem } from "@knotebook/shared";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { NoteReadTooComplexError } from "../notes/editing/read.js";
import { INVALID_KNOWLEDGE_FALLBACK_MESSAGE, KNOWLEDGE_ATTR_MESSAGE, knowledgeProblemMessage } from "../notes/editing/knowledge-messages.js";
import type { ParseDetail } from "../notes/editing/markdown.js";
import { sendError } from "./errors.js";

export const PARSER_BUSY_RETRY_AFTER_S = 5;
export const PARSER_BUSY_MESSAGE = "The server is busy processing other writes. Try again in a moment.";
export const READ_BUSY_MESSAGE = "The server is busy processing other requests. Try again in a moment.";
export const NOTE_WRITE_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to change within the server's time and memory limits, so nothing was written. Retrying won't help; split the note to keep editing it this way.";
export const READ_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to read within the server's time and memory limits.";

export const TOO_COMPLEX_MESSAGE =
  "The content is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller parts or simplify its formatting.";

export function sendParserBusy(reply: FastifyReply, message = PARSER_BUSY_MESSAGE): FastifyReply {
  reply.header("retry-after", String(PARSER_BUSY_RETRY_AFTER_S));
  return sendError(reply, 503, "server_busy", message);
}

export function sendDocReadError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof ParserBusyError) return sendParserBusy(reply, READ_BUSY_MESSAGE);
  if (err instanceof NoteReadTooComplexError) return sendError(reply, 500, "too_complex", READ_TOO_COMPLEX_MESSAGE);
  return null;
}

const UNSUPPORTED_COLOR_MESSAGE = `That markdown uses a color this editor cannot show, so nothing was written. Use one of: ${PALETTE_COLORS.join(", ")}, or a hex color written #rgb or #rrggbb, such as #ff6600.`;
// Same trigger conditions as MCP `writeFailureMessage`.
const UNSUPPORTED_COLUMNS_MESSAGE =
  "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as GET /api/notes/:id/content returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type.";
const UNSUPPORTED_SIZE_MESSAGE =
  "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as GET /api/notes/:id/content returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width.";
export function parseErrorMessage(code: ErrorCode, fallback: string, detail?: ParseDetail, knowledge?: KnowledgeProblem): string {
  if (code === "unsupported_block" && detail === "too_complex") return TOO_COMPLEX_MESSAGE;
  if (code === "unsupported_block" && detail === "knowledge_attr") return KNOWLEDGE_ATTR_MESSAGE;
  if (code === "invalid_knowledge") return knowledge === undefined ? INVALID_KNOWLEDGE_FALLBACK_MESSAGE : knowledgeProblemMessage(knowledge);
  if (code === "unsupported_color") return UNSUPPORTED_COLOR_MESSAGE;
  if (code === "unsupported_columns") return UNSUPPORTED_COLUMNS_MESSAGE;
  if (code === "unsupported_size") return UNSUPPORTED_SIZE_MESSAGE;
  return fallback;
}
