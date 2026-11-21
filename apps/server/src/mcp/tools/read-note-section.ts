/**
 * `fingerprint` comes only with the page that ends the section. This is for correctness, not
 * security: `replace_section` replaces the whole section, so a model that read only the first
 * 4000 UTF-16 code units would eat the unread tail. A huge `offset` also counts as the end page
 * (accepted), so it protects an honest sequential reader only: never describe it as a security
 * boundary; the `truncated` note is explanation, not a guard. `heading` isn't returned: it has
 * no length limit and is the first line of `markdown` anyway. `section_id` never reaches SQL,
 * so only the format and NUL checks (`SEC`) apply.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadLastEdited, readNoteContent } from "../../notes/editing/read.js";
import { NOTE_ID, SEC } from "../../notes/schemas.js";
import { noteSummarySchema } from "../dto.js";
import { MCP_SECTION_CHARS, truncateCodeUnits } from "../limits.js";
import { READ_SECTION_KNOWLEDGE_SENTENCE } from "../knowledge-strings.js";
import { READ_NOTE_LINK_SENTENCE } from "../note-link-strings.js";
import { authorizeNoteRead, docReadToolError, SECTION_NOT_FOUND_MESSAGE } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

export const READ_NOTE_SECTION_DESCRIPTION =
  "Read one section of a note as markdown. Take `section_id` from read_note_outline. " +
  `At most ${MCP_SECTION_CHARS} characters per call: while \`truncated\` is true, call again with \`offset\` ` +
  "set to `nextOffset`. The `fingerprint` you need to replace this section arrives with the page that " +
  "finishes it, so read to the end before you rewrite it. " +
  // "for example": images inside nodes exported wholesale as HTML take that HTML form, and old collapsed-block images have absolute URLs, which is why the main clause says only that the address contains the upload id; table cells aren't mentioned (they hold no width-set images).
  "An uploaded image's address contains its upload id, for example `/api/uploads/<id>` in `![name](/api/uploads/<id>)` or, for an image with " +
  "a caption or shown at a set width, in `<figure><img … src=\"/api/uploads/<id>\" …>…</figure>`; see them with read_note_image. " +
  READ_SECTION_KNOWLEDGE_SENTENCE;

const TRUNCATED_NOTE =
  "This section is longer than one response. Keep reading with `offset` set to `nextOffset` until " +
  "`truncated` is false — the last page carries the `fingerprint` you need to replace this section.";

export const readNoteSectionInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  section_id: SEC.describe("Section id from read_note_outline. `_top` is whatever comes before the first heading."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Where to resume, counted in characters. Use `nextOffset` from the previous call; omit it to start at the beginning."),
};

export const readNoteSectionOutput = {
  section: z.object({
    id: z.string().describe("The section id you asked for."),
    level: z.number().describe("Heading depth; `0` for the `_top` section."),
    // `chars` is plain-text length while `offset` counts markdown code units; unstated, a model would stop early.
    chars: z
      .number()
      .describe(
        "Rough size of the whole section in text characters. This is not the same unit as `offset` — " +
          "to tell whether you have read it all, look at `truncated` and `nextOffset`, not at this number."
      ),
    // Not every page starts with a heading: `_top` has none, and a continuation page is cut midway.
    markdown: z
      .string()
      .max(MCP_SECTION_CHARS)
      .describe(
        "This page of the section, as markdown. The first page starts with the section's heading line — except " +
          "`_top`, which has no heading; a later page resumes where the last one stopped. Colored text and blocks come back as " +
          // A row with 5 or more columns reads fine but is rejected when written back as-is, so the parenthesis gives the write limit.
          "HTML, as do images shown at a set width, tables with set column widths, and the <div> tags around side-by-side columns; " +
          "write it back unchanged to keep them (edit_note takes rows of 2 to 4 columns). " +
          // In colored and wholesale-HTML blocks a `<` in text reads as `&lt;`; in code it is as-is.
          "Outside code and blocks that come back as HTML, a `<` that could start an HTML tag or comment comes back as `\\<`; " +
          "write it back unchanged to keep it as text. " +
          READ_NOTE_LINK_SENTENCE
      ),
    fingerprint: z
      .string()
      .optional()
      .describe("Concurrency token for editing this section. Present only once you have read to the end of it."),
  }),
  truncated: z.boolean().describe("True when this page stopped short of the end of the section."),
  nextOffset: z.number().nullable().describe("Pass this back as `offset`; `null` means you have read the whole section."),
  lastEdited: noteSummarySchema.shape.lastEdited.describe("Who last changed this note, and when."),
  note: z.string().optional().describe("Present only when `truncated` is true: how to finish reading this section."),
};

export interface ReadNoteSectionArgs {
  note_id: string;
  section_id: string;
  offset?: number;
}

export async function readNoteSection(args: ReadNoteSectionArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const access = await authorizeNoteRead(ctx, args.note_id, args.section_id);
  if (!access.ok) return access.error;
  // Unreachable over HTTP (registered only with collab and editing); `ctx.editing` is optional in the types; `runTool()` turns it into `internal`.
  if (ctx.editing === undefined) throw new Error("read_note_section：editing runtime 缺席（不該被註冊）");

  let result: Awaited<ReturnType<typeof readNoteContent>>;
  try {
    result = await readNoteContent({ db: ctx.db, collab: ctx.collab, shownLinks: ctx.writes.shownLinks }, ctx.editing, args.note_id, ctx.userId, args.section_id);
  } catch (err) {
    const error = docReadToolError(err);
    if (error) return error;
    throw err;
  }
  if (result === "section_not_found") return toolError("section_not_found", SECTION_NOT_FOUND_MESSAGE);
  if (!("section" in result)) throw new Error("readNoteContent 帶了 section 卻回整篇形");

  const { id, level, chars, markdown, fingerprint } = result.section;
  const offset = args.offset ?? 0;
  // Slices with `truncateCodeUnits` (raw length, never splitting a surrogate pair; not `truncateText`, see `limits.ts`). `nextOffset` is `offset + length actually returned`, not `+ 4000`: when the cut backed
  // off one unit inside a surrogate pair, a fixed 4000 would give both pages a lone surrogate, silently (serialization doesn't fail).
  const page = truncateCodeUnits(markdown.slice(offset), MCP_SECTION_CHARS);
  return toolResult({
    section: {
      id,
      level,
      chars,
      markdown: page.text,
      ...(page.truncated ? {} : { fingerprint }),
    },
    truncated: page.truncated,
    nextOffset: page.truncated ? offset + page.text.length : null,
    lastEdited: await loadLastEdited(ctx.db, args.note_id),
    ...(page.truncated ? { note: TRUNCATED_NOTE } : {}),
  });
}
