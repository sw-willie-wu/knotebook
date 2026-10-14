/**
 * #269 §9.3：模型面字串——**逐字取自 `docs/mcp.md`**（read_note_outline／read_note_section／Links to notes 三處），先改文件、
 * 再改這裡；`test/mcp-tools-list.test.ts` 的 #269 案逐字釘住。`unboundWikilinks`、EDIT_NOTE_DESCRIPTION、server-info 的
 * instructions 不在本 issue 的改動範圍。
 */
export const OUTLINE_SECTION_ID_DESCRIPTION =
  "Pass this to read_note_section. `_top` is the text before the first heading. Any other sectionId is also the id of that " +
  "heading's block, so `/notes/<note id>#b-<sectionId>` links to that heading.";

export const READ_NOTE_LINK_SENTENCE =
  "A link saved as a link to a note comes back as `[text](/notes/<id>)` (inside a block that comes back as HTML, as " +
  '`<a href="/notes/<id>">`), ending in `#b-<block id>` when it points at a place in that note.';

export const WRITE_NOTE_LINK_SENTENCE =
  "A Markdown link whose URL is a note on this site — `/notes/<id>` or the `url` list_notes gives, relative or this site's full URL, " +
  "optionally ending in `#b-<block id>` — is saved as a link to that note if you can see it; any other link to this site is kept as an ordinary link.";
