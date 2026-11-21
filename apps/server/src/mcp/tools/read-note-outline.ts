/**
 * The output has no content fingerprints (except `titleFingerprint`: the title is readable in
 * `note.title` unless cut at 200, and it doesn't cover content fingerprints): a smaller
 * response, and this isn't a security boundary: on a note with content, getting a comparison
 * value without reading now costs a recorded, revertable non-empty `append`, not an untraceable
 * read. Don't claim the model "can't" get one.
 * No markdown export, so this path never touches jsdom.
 * Paging is not a snapshot: no edit op is safe, because a new section starts at a heading of
 * the same or higher level (`current.level === 0 || level <= current.level` in
 * `note-sections.ts`; a `#` inside a `##` section counts). `insert_after`/`append` add a
 * section per inserted heading of that level; `replace_section` with two such headings splits
 * into two, and `replace_section` without a heading dissolves into the previous
 * section, `delete_section` removes one, `replace_all` can change any id. The description
 * carries a verbatim sentence for this (pinned in `mcp-content.test.ts`; don't delete).
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../../db/index.js";
import { groups, notes, users } from "../../db/schema.js";
import { fingerprintOf } from "../../notes/editing/fingerprint.js";
import { loadLastEdited } from "../../notes/editing/read.js";
import { loadNoteTagNames } from "../../tags/queries.js";
import { viewerFolderIdFor } from "../../notes/note-dto.js";
import { NOTE_ID } from "../../notes/schemas.js";
import type { DbOrTx } from "../../db/tx.js";
import { noteSummarySchema, ownerForModel } from "../dto.js";
import { loadFolderPath, truncateFolderPath } from "../folder-fields.js";
import { OUTLINE_TAGS_DESCRIBE } from "../knowledge-strings.js";
import { MCP_FOLDER_NAME_MAX, MCP_PAGE_MAX, truncateText } from "../limits.js";
import { NOTE_NOT_FOUND_MESSAGE, authorizeNoteRead, readOutlineForTool } from "../note-read.js";
import { buildOutlinePage, outlineEntrySchema } from "../outline-page.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

export const READ_NOTE_OUTLINE_DESCRIPTION =
  "List a note's sections — id, heading, depth and length — so you can pick what to read with " +
  "read_note_section. Call this first: there is no tool that returns a whole note. " +
  `At most ${MCP_PAGE_MAX} sections per call; page with \`section_offset\` while \`truncated\` is true. ` +
  "To list every section, finish listing all pages before you start editing; editing while you page will skip sections.";

export const RO_FOLDER_DESCRIBE =
  "Where this note is filed for you, with the folder names from the top level down, or null at the top level; " +
  "for a note shared with you, where you filed it, not where its owner did. Long paths are cut from the top, with `pathTruncated`.";

export const readNoteOutlineInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  section_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Where to start in the section list, counted in sections (not characters). " +
        "Use `nextSectionOffset` from the previous call; omit it for the first page."
    ),
};

const noteHeaderSchema = noteSummarySchema.pick({
  id: true,
  title: true,
  titleTruncated: true,
  owner: true,
  role: true,
});

export const readNoteOutlineOutput = {
  note: noteHeaderSchema
    .extend({ tags: z.array(z.string()).describe(OUTLINE_TAGS_DESCRIBE) })
    .describe("Which note this outline belongs to, and your role on it."),
  folder: z
    .object({ id: z.string(), path: z.array(z.string().max(MCP_FOLDER_NAME_MAX)), pathTruncated: z.literal(true).optional() })
    .nullable()
    .describe(RO_FOLDER_DESCRIBE),
  totalChars: z.number().describe("Characters in the whole note — not just this page of sections."),
  sections: z.array(outlineEntrySchema).describe("This page of sections, in document order."),
  truncated: z.boolean().describe("True when more sections follow this page."),
  nextSectionOffset: z
    .number()
    .nullable()
    .describe("Pass this back as `section_offset` for the next page; `null` means this was the last page."),
  lastEdited: noteSummarySchema.shape.lastEdited.describe("Who last changed this note, and when."),
  // Computed over the full title (`note.title` may be cut). Doesn't name edit_note: read-only credentials see this tool too.
  titleFingerprint: z
    .string()
    .describe("The fingerprint of the note's whole title, even when `note.title` is cut. Renaming the note needs it as `if_match`."),
};

/** The caller's folder (group notes and owners: `notes.folder_id`; sharees: their own placement) with its full path; null at the root or if the folder is deleted between the two statements. */
export async function outlineFolderFor(
  db: DbOrTx,
  note: { id: string; ownerId: string | null; groupId: string | null; folderId: string | null },
  userId: string,
): Promise<{ id: string; path: string[]; pathTruncated?: true } | null> {
  const folderId = await viewerFolderIdFor(db, note, userId);
  if (folderId === null) return null;
  const names = await loadFolderPath(db, folderId);
  if (names === null) return null;
  const path = truncateFolderPath(names);
  return { id: folderId, path: path.path, ...(path.truncated ? { pathTruncated: true as const } : {}) };
}

export interface ReadNoteOutlineArgs {
  note_id: string;
  section_offset?: number;
}

/** A row can vanish between `resolveRole` and here. LEFT JOIN users and groups: an INNER JOIN on users would make group notes (no owner) not_found. */
async function loadNoteHeader(
  db: Db,
  noteId: string
): Promise<
  | { id: string; title: string; ownerHandle: string | null; ownerId: string | null; groupId: string | null; groupName: string | null; folderId: string | null }
  | undefined
> {
  const [row] = await db
    .select({
      id: notes.id,
      title: notes.title,
      ownerHandle: users.handle,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      groupName: groups.name,
      folderId: notes.folderId,
    })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .where(eq(notes.id, noteId))
    .limit(1);
  return row;
}

export async function readNoteOutline(args: ReadNoteOutlineArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const access = await authorizeNoteRead(ctx, args.note_id, undefined);
  if (!access.ok) return access.error;
  const header = await loadNoteHeader(ctx.db, args.note_id);
  // Same string as the role path: the three not-founds must be indistinguishable.
  if (header === undefined) return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);

  // Computed in the parse worker (tiny notes on the main thread): all workers busy → server_busy, too large → too_complex. Only `outline` is kept: whole-note and per-section fingerprints are dropped.
  const read = await readOutlineForTool(ctx, args.note_id);
  if ("error" in read) return read.error;
  const { outline } = read;
  const title = truncateText(header.title);
  const page = buildOutlinePage(outline, args.section_offset ?? 0);
  return toolResult({
    note: {
      id: args.note_id,
      title: title.text,
      ...(title.truncated ? { titleTruncated: true as const } : {}),
      owner: ownerForModel(header),
      role: access.role,
      tags: await loadNoteTagNames(ctx.db, args.note_id),
    },
    folder: await outlineFolderFor(ctx.db, header, ctx.userId),
    totalChars: outline.reduce((n, entry) => n + entry.chars, 0),
    ...page,
    lastEdited: await loadLastEdited(ctx.db, args.note_id),
    titleFingerprint: fingerprintOf(header.title),
  });
}
