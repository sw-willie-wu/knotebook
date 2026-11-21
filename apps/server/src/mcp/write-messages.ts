/** Shared by `edit_note` and `create_note` (same parse pipeline and `edit` limiter): two copies could drift without any test failing. */
import { PALETTE_COLORS, type KnowledgeProblem } from "@knotebook/shared";
import { INVALID_KNOWLEDGE_FALLBACK_MESSAGE, KNOWLEDGE_ATTR_MESSAGE, knowledgeProblemMessage } from "../notes/editing/knowledge-messages.js";
import type { ParseDetail, ParseError } from "../notes/editing/markdown.js";

export const PARSER_BUSY_TOOL_MESSAGE = "The server is busy processing other writes, so nothing was written. Try again in a moment.";

export const NOTE_WRITE_TOO_COMPLEX_TOOL_MESSAGE = "This note is too large or too complex for the server to change within its time and memory limits, so nothing was written. Retrying won't help.";

export const WRITE_RATE_LIMITED_MESSAGE = "Too many note writes right now. Wait a moment before writing again.";

/** `empty_section` only comes from `edit_note`, but it is the same table. */
export function writeFailureMessage(code: ParseError | "empty_section", detail?: ParseDetail, knowledge?: KnowledgeProblem): string {
  switch (code) {
    case "unsupported_block":
      if (detail === "knowledge_attr") return KNOWLEDGE_ATTR_MESSAGE;
      if (detail === "too_complex") return "That markdown is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller writes or simplify its formatting.";
      return "That markdown contains something this editor cannot store. Plain markdown — headings, text, lists, code, tables — works.";
    case "unsupported_color":
      // Colors come from `PALETTE_COLORS`; #rgb/#rrggbb are normalized to lowercase #rrggbb on write (`canonicalColor` in shared).
      return `That markdown uses a color this editor cannot show, so nothing was written. Use one of: ${PALETTE_COLORS.join(", ")}, or a hex color written #rgb or #rrggbb, such as #ff6600.`;
    case "unsupported_columns":
      // Also returned for flex/grid divs and any `data-node-type` element, hence "layout or editor-internal HTML".
      return "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as read_note_section returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type.";
    case "unsupported_size":
      // A width inside a table cell is rejected even in figure form, so say the figure must be outside the table (else the model loops); `src alt width` order is rejected (IMG_ATTRS order).
      return "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as read_note_section returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width.";
    case "invalid_knowledge":
      return knowledge === undefined ? INVALID_KNOWLEDGE_FALLBACK_MESSAGE : knowledgeProblemMessage(knowledge);
    case "empty_content":
      return "That markdown is empty once parsed. Send at least one non-blank block.";
    case "too_many_blocks":
      return "That markdown is too many blocks for one note. Split it up.";
    case "empty_section":
      return "That would leave the section empty. Use delete_section if you meant to remove it.";
  }
}

/** Deliberately differs from `create_note`'s `GROUP_NOT_FOUND_MESSAGE`, which reports a missing create right as `forbidden`; here it isn't distinguished. Covers nonexistent, non-member, member without `can_create`, and deleted after the check. */
export const GROUP_NO_CREATE_MESSAGE = "No group with that id among your groups where your role can create notes.";
