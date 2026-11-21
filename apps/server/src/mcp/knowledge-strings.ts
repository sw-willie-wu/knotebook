/** Sentences shared by several tool descriptions; each appears word for word in `docs/mcp.md` (`test/unit/mcp-knowledge-strings.test.ts`). */

export const READ_SECTION_KNOWLEDGE_SENTENCE =
  "A heading marked as knowledge is followed by a <!-- knotebook:knowledge … --> comment holding its knowledge info, one key: value per line (a colored collapsible heading, which is read as an HTML block, comes without one); edit_note's markdown says how to write it.";

export const WRITE_KNOWLEDGE_SENTENCE =
  "A <!-- knotebook:knowledge comment, as read_note_section returns it, on the lines after a heading that isn't in columns, a list or a quote sets that heading's knowledge info; anywhere else it is ignored and counted in the reply. " +
  "Write it back as it is to keep the info, change a value to change it, and leave out any line other than id to empty that field. " +
  "Keys: id, when, conclusion, evidence (tested, docs, inferred or unconfirmed), verified (YYYY-MM-DD), status (unverified or outdated; leave it out for current) and superseded_by (needed with outdated: a knowledge id, or <note id>#<knowledge id> in another note). " +
  "A value in double quotes is read as a JSON string. " +
  "Leave out id for new knowledge; a comment without id on a heading that keeps its text and level in a replace_section or replace_all keeps that knowledge's id. " +
  "Leave a blank line after the -->. " +
  "With replace_section and replace_all, a heading you send without a comment keeps the knowledge info of a heading with the same text and level in what it replaces; a heading whose text or level you changed, or one added by insert_after or append, has none unless you send a comment.";

export const EDIT_TAG_SENTENCE = "A #name in the markdown is text, not a tag: edit_note doesn't set tags.";

export const CREATE_KNOWLEDGE_SENTENCE = "Knowledge comments work as in edit_note; a #name is text, not a tag.";

export const OUTLINE_TAGS_DESCRIBE = "The note's tags, in the order they were added; empty when it has none.";

export const INVALID_KNOWLEDGE_ERROR_SENTENCE =
  "a knowledge comment under a heading isn't written as described under markdown; the message names the heading and what is wrong; nothing was written";
