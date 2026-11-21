/**
 * The raw shape only flattens fields for the model: never pass the discriminatedUnion as `inputSchema` (the advertised
 * JSON Schema silently becomes `properties: {}`). The object fed to the schema must be
 * spread key by key: `.strict()` rejects `{section_id: undefined}` as `unrecognized_keys`.
 * `outline` carries fingerprints only on success (REST parity: `docs/ai-editing.md` promises
 * consecutive writes need no re-read); error responses never do: the view is stale and a fresh
 * token would invite a blind retry. The `fingerprint_mismatch` outline uses `loadNoteDoc` +
 * `outlineOf`, not `readNoteContent`, so the response structurally contains no markdown.
 * `section_id` never reaches SQL (an in-memory `find`), so only the format and NUL checks
 * apply, both in `SEC`.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { canonicalNotePath, PALETTE_COLORS } from "@knotebook/shared";
import { users } from "../../db/schema.js";
import { fingerprintOf } from "../../notes/editing/fingerprint.js";
import { noteTooLargeMessage } from "../../notes/note-size.js";
import { renameNoteTitle } from "../../notes/rename-note.js";
import { editBodySchema, FP, MD, NOTE_ID, SEC, TITLE } from "../../notes/schemas.js";
import { resolveNoteAccess, resolveRole } from "../../notes/service.js";
import { KNOWLEDGE_OUTPUT_DESCRIBE, knowledgeForModel, knowledgeOutputSchema } from "../knowledge-output.js";
import { EDIT_TAG_SENTENCE, WRITE_KNOWLEDGE_SENTENCE } from "../knowledge-strings.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, truncateText } from "../limits.js";
import { WRITE_NOTE_LINK_SENTENCE } from "../note-link-strings.js";
import { NOTE_NOT_FOUND_MESSAGE, SECTION_NOT_FOUND_MESSAGE, readOutlineForTool } from "../note-read.js";
import { buildOutlinePage, outlineEntryWithFingerprintSchema } from "../outline-page.js";
import { toolError, toolResult } from "../tool-result.js";
import { NOTE_WRITE_TOO_COMPLEX_TOOL_MESSAGE, PARSER_BUSY_TOOL_MESSAGE, WRITE_RATE_LIMITED_MESSAGE, writeFailureMessage } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const EDIT_NOTE_DESCRIPTION =
  "Change one note. Six operations: `replace_all` rewrites the whole note, `replace_section` " +
  "and `delete_section` act on one section, `insert_after` puts new markdown after a section, " +
  "`append` adds to the end, and `rename` changes its title. Every operation except " +
  "`append` needs `if_match`, the " +
  "fingerprint of what you are replacing — a section's from read_note_section (once you have " +
  "read to its end) or from a previous edit_note reply; the whole note's from a previous " +
  // Revert is allowed for editors, not only the owner (`routes/note-content.ts`). The subject is
  // "a change to the content" so rename isn't included. Rename needs `if_match` too, so
  // "last title written wins" no longer applies to MCP (web title edits are still last-write-wins;
  // that isn't this tool's behavior). Don't make "can undo it" unconditional: the full conditions
  // are in `editId`'s `.describe()`.
  "edit_note reply; the title's (`titleFingerprint`) from read_note_outline or a previous rename's reply. " +
  "A change to the content is recorded in the note's history, where anyone who can edit the " +
  "note can usually undo it. A rename is not recorded: to undo it, rename the " +
  "note back. Unless the note has a custom URL, its URL follows the new title and the old URL usually stops " +
  "working. A rename's reply has `title`, `titleFingerprint` and `url` instead of `editId`, `fingerprint`, `outline` and `unboundWikilinks`.";

/** `op` is a `z.enum` because a raw shape can't express the per-op required matrix; the string sets are compared in `test/unit/mcp-write-schemas.test.ts`. Other fields reuse the `notes/schemas.ts` bases as `BASE.optional().describe()`. */
export const editNoteInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  op: z
    .enum(["replace_all", "replace_section", "insert_after", "append", "delete_section", "rename"])
    .describe("What to do. `replace_section`, `insert_after` and `delete_section` need `section_id`; `append` may omit `if_match`; `rename` takes `title` and `if_match` and nothing else."),
  section_id: SEC.optional()
    .describe("Which section to act on, from read_note_outline. Required for replace_section, insert_after and delete_section."),
  markdown: MD.optional().describe(
    "The new markdown. Required for every operation except delete_section and rename. Colors are HTML, as read_note_section " +
      `returns them: colored text is <span style="color:red">…</span> inside the markdown; a block's own color is ` +
      `e.g. <p data-background-color="yellow">…</p>. For a color, use one of these names: ${PALETTE_COLORS.join(", ")}, or a hex color such as #ff6600 (written #rgb or #rrggbb). ` +
      // "Writes take 2 to 4" speaks of writes only (reads may show more); the size sentence doesn't mention images in table cells (widths there aren't supported yet); images with showPreview off read back no width.
      `Side-by-side columns are HTML, exactly as read_note_section returns them: <div data-kb-columns style="display:flex;gap:16px"> holding ` +
      `<div data-kb-column style="flex:N"> columns (N is the relative width, 0.1 to 10, at most two decimals), each of these tags and its </div> ` +
      "on a line of its own, each column with markdown inside, a blank line after its opening tag and another before its </div>. " +
      "Writes take 2 to 4 columns. Rewriting a section that holds columns means sending the whole <div> block back. " +
      `Sizes are HTML too: an image shown at a set width reads as <figure><img … width="W">…</figure>, and a table with set column widths ` +
      "reads as an HTML table with colwidth on its first row's cells. Widths are whole pixels from 32 to 4000; write them back the same way to keep them. " +
      // `\<` is a literal `<` (a patch to the BlockNote parser); in code and HTML blocks a backslash is not an escape.
      "HTML in the markdown is read as HTML; to keep a `<` that would start a tag or comment as text, write `\\<` " +
      "(as read_note_section returns it), except inside code or a block written as HTML. " +
      WRITE_NOTE_LINK_SENTENCE +
      ` ${WRITE_KNOWLEDGE_SENTENCE} ${EDIT_TAG_SENTENCE}`
  ),
  // Rename needs it too, so the failure clause doesn't say "the note changed": title and body fingerprints don't cover each other.
  if_match: FP.optional().describe(
    "The fingerprint of what you are replacing. Required for every operation except append; the write fails if what you " +
      "are replacing changed since you got that fingerprint. For rename it is the title's `titleFingerprint`, from " +
      "read_note_outline or a previous rename's reply. A title change does not change the content's fingerprints, and a " +
      "content change does not change `titleFingerprint`."
  ),
  title: TITLE.optional().describe("The note's new title. Only rename takes it."),
};

/** Rename needs `if_match` (the title fingerprint). */
export const RENAME_BRANCH = z.object({ op: z.literal("rename"), title: TITLE, if_match: FP }).strict();
/** The first five branches are the same objects as `editBodySchema.options`; REST is unchanged and still rejects `op:"rename"` and `title`. */
export const mcpEditBodySchema = z.discriminatedUnion("op", [...editBodySchema.options, RENAME_BRANCH]);

export const editNoteOutput = {
  // Revert conditions (`editRevertable` in `revert.ts`, `RETENTION` (`AI_EDITS_RETENTION`, 100, trimmed in the same
  // transaction) in `apply.ts`), kept here because `.describe()` has no length budget. Two
  // branches: non-delete ops need the written blocks to still exist with the same fingerprint;
  // `delete_section` (which also returns an `editId`, so both must be described) needs the
  // anchor still at top level and `before_blocks` not restored (browser Ctrl-Z restores the
  // blocks with their original ids → 409 stale).
  editId: z
    .string()
    .optional()
    .describe(
      "Id of this change in the note's history. Anyone who can edit the note can undo it with this, while the " +
        "blocks it wrote are unchanged and it is still among the at most 100 history entries a note keeps; a " +
        "`delete_section` wrote no blocks, so it is judged instead by the neighbouring block it would be restored " +
        "next to, and stops being undoable once the blocks it removed are back in the note — which is what a person " +
        "pressing undo in the browser does. The exact rule is in docs/ai-editing.md, under Revert."
    ),
  fingerprint: z
    .string()
    .optional()
    .describe(
      "The whole note's fingerprint as your write left it. It does not include changes other people made to other parts of the note while " +
        "your write was being applied, so when someone is editing the note, passing it as `if_match` to a following replace_all can answer " +
        "fingerprint_mismatch: read the note again then."
    ),
  outline: z
    .object({
      sections: z.array(outlineEntryWithFingerprintSchema).describe("One page of the note's sections, in document order."),
      truncated: z.boolean().describe("True when the note has more sections than this page shows."),
    })
    .optional()
    .describe(
      `The note's sections after your change, at most ${MCP_PAGE_MAX}. For replace_section and insert_after the page ` +
        "starts at the section that now holds what you wrote — which may be the preceding section, if your markdown " +
        "did not begin with a heading. For replace_all, append and delete_section it starts at the beginning of the " +
        "note, so on a note with more than 100 sections an append will not show you the end you just wrote; read it " +
        "back with read_note_outline."
    ),
  // Unbound = not exactly one title match among own ∪ shared ∪ group notes (`hits.length === 1` in `note-markdown.ts`): duplicates and different case count too.
  unboundWikilinks: z
    .number()
    .optional()
    .describe(
      "How many `[[wikilinks]]` in what you wrote were left as plain text because no note you can see has that " +
        "exact title, or more than one does."
    ),
  knowledge: knowledgeOutputSchema.optional().describe(KNOWLEDGE_OUTPUT_DESCRIBE),
  // Optional so a successful rename (title/url only) passes the SDK's `validateToolOutput`; the five content ops still return all four.
  title: z.string().max(MCP_TEXT_MAX).optional().describe("After a rename, the note's new title."),
  titleTruncated: z.literal(true).optional(),
  titleFingerprint: z
    .string()
    .optional()
    .describe("After a rename, the fingerprint of the new title. Pass it as `if_match` to a following rename."),
  url: z.string().optional().describe("After a rename, the note's page as a site-relative path, as in list_notes."),
};

export interface EditNoteArgs {
  note_id: string;
  op: "replace_all" | "replace_section" | "insert_after" | "append" | "delete_section" | "rename";
  section_id?: string;
  markdown?: string;
  if_match?: string;
  title?: string;
}

/** Doesn't name an owner: a group note has none (edit rights come from whoever manages the group's members; for a personal note, the owner), and "whoever manages your access to it" covers both. */
export const FORBIDDEN_MESSAGE =
  "You can read this note but not change it. Ask whoever manages your access to it for editing rights.";
const MISMATCH_MESSAGE =
  "The note changed since you read it, so this write was not applied. The current outline is below; read what you " +
  "want to change again and retry with a fresh `if_match`.";
/** An UPDATE hitting 0 rows while the row exists can only mean ownership changed (moved into a group, or group deleted and transferred). */
export const RENAME_CONFLICT_MESSAGE =
  "The note was moved into a group, or its group was deleted, after your access was checked, so its title was not changed. Try again.";
/** Same code as content ops but no outline: rename doesn't touch the live doc, and the new title's fingerprint can only come from a re-read. "most likely" because a wrong-kind fingerprint (e.g. the body's) lands here too. */
export const RENAME_MISMATCH_MESSAGE =
  "`if_match` is not the fingerprint of the note's current title — most likely the title was changed after you got that " +
  "fingerprint — so the note was not renamed. Call read_note_outline to see the current title and its `titleFingerprint`, " +
  "then retry with that as `if_match` if you still want to rename it.";

const SECTION_SCOPED = new Set(["replace_section", "insert_after", "delete_section"]);

export function invalidBodyMessage(op: string, issues: readonly { path: PropertyKey[] }[]): string {
  const fields = [...new Set(issues.map(i => String(i.path[0] ?? "")).filter(Boolean))];
  const which = fields.length === 0 ? "" : ` Check: ${fields.join(", ")}.`;
  return (
    `This \`${op}\` call does not match what that operation needs.${which} ` +
    "replace_section, insert_after and delete_section need `section_id`; every operation except delete_section and rename needs " +
    "`markdown`; every operation except append needs `if_match` (for rename, the title's `titleFingerprint`); rename needs `title`, " +
    "and no other operation takes it. Fields that do not belong to the operation are rejected."
  );
}

export async function editNote(args: EditNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // Before `resolveRole`, like REST (a `none` 404 consumes `tokenWrite` there too).
  const denied = requireWriteScope(ctx);
  if (denied !== null) return denied;

  // `note_id` is not passed in: every branch is `.strict()`.
  const parsed = mcpEditBodySchema.safeParse({
    op: args.op,
    ...(args.section_id === undefined ? {} : { section_id: args.section_id }),
    ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
    ...(args.if_match === undefined ? {} : { if_match: args.if_match }),
    ...(args.title === undefined ? {} : { title: args.title }),
  });
  if (!parsed.success) return toolError("invalid_body", invalidBodyMessage(args.op, parsed.error.issues));

  // Rename is before `resolveRole`, the `edit` limiter and `writes.available`: it doesn't touch the live doc, so it must not throw on a deployment without the write service, and REST title PATCH is unthrottled.
  if (parsed.data.op === "rename") return renameViaMcp(ctx, args.note_id, parsed.data.title, parsed.data.if_match);
  const data = parsed.data;

  const role = await resolveRole(ctx.db, ctx.userId, args.note_id);
  if (role === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (role === "viewer") return toolError("forbidden", FORBIDDEN_MESSAGE);

  // After the role check (a `none` 404 doesn't consume it), before any mount: a 429 must leave nothing behind.
  if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

  // Unreachable (registered only with collab and editing); `runTool()` turns it into `internal`. Chinese is fine: the model never sees it.
  if (!ctx.writes.available) throw new Error("edit_note：寫入 service 不可用（不該被註冊）");

  const out = await ctx.writes.applyToNote(ctx.log, {
    noteId: args.note_id,
    userId: ctx.userId,
    userHandle: ctx.userHandle,
    tokenId: ctx.tokenId,
    op: data.op,
    sectionId: "section_id" in data ? data.section_id : undefined,
    markdown: "markdown" in data ? data.markdown : undefined,
    ifMatch: "if_match" in data ? data.if_match : undefined,
  });

  if (!out.ok) {
    if (out.kind === "busy") return toolError("server_busy", "Another write to this note is in progress. Try again in a moment.");
    if (out.kind === "parser_busy") return toolError("server_busy", PARSER_BUSY_TOOL_MESSAGE);
    if (out.kind === "too_large") return toolError("note_too_large", noteTooLargeMessage(out.limitBytes), { limitBytes: out.limitBytes });
    if (out.kind === "gone") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    if (out.code === "fingerprint_mismatch") return mismatchError(ctx, args);
    if (out.code === "section_not_found") return toolError("section_not_found", SECTION_NOT_FOUND_MESSAGE);
    // The note itself is too large or complex: retrying won't help.
    if (out.code === "too_complex") return toolError("too_complex", NOTE_WRITE_TOO_COMPLEX_TOOL_MESSAGE);
    return toolError(out.code, writeFailureMessage(out.code, out.detail, out.knowledge));
  }

  const sectionOffset = SECTION_SCOPED.has(args.op) ? (out.result.afterSectionIndex ?? 0) : 0;
  const page = buildOutlinePage(out.result.outline, sectionOffset, { withFingerprints: true });
  return toolResult({
    editId: out.result.editId,
    fingerprint: out.result.fingerprint,
    // No `nextSectionOffset`: no tool accepts that cursor here.
    outline: { sections: page.sections, truncated: page.truncated },
    unboundWikilinks: out.result.unboundWikilinks,
    ...(out.result.knowledge ? { knowledge: knowledgeForModel(out.result.knowledge) } : {}),
  });
}

/** No fingerprints. Page = the index of the request's `section_id` in the current outline, else page 0. */
async function mismatchError(ctx: McpToolCtx, args: EditNoteArgs): Promise<CallToolResult> {
  const read = await readOutlineForTool(ctx, args.note_id);
  if ("error" in read) return read.error;
  const { outline } = read;
  const at = args.section_id === undefined ? -1 : outline.findIndex(s => s.sectionId === args.section_id);
  const offset = SECTION_SCOPED.has(args.op) && at !== -1 ? at : 0;
  const page = buildOutlinePage(outline, offset);
  return toolError("fingerprint_mismatch", MISMATCH_MESSAGE, {
    outline: { sections: page.sections, truncated: page.truncated },
  });
}

/**
 * Doesn't write `note_ai_edits` or touch `last_edited_*`/presence/the write queue; `updated_at`
 * does change. The fingerprint comparison and the write are both in `renameNoteTitle` (pre-read
 * compare + conditional UPDATE). A missing owner handle throws (→ `internal`). The owner handle comes from `row.ownerId`, not `ctx.userHandle` (a shared editor renaming
 * someone else's note must get the owner's handle). Authorization comes before the
 * fingerprint comparison, so a user who can't see the note gets not_found.
 */
async function renameViaMcp(ctx: McpToolCtx, noteId: string, title: string, ifMatch: string): Promise<CallToolResult> {
  const access = await resolveNoteAccess(ctx.db, ctx.userId, noteId);
  if (access.role === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (!access.permissions.edit) return toolError("forbidden", FORBIDDEN_MESSAGE);
  const out = await renameNoteTitle(ctx.db, { noteId, access, title, expectTitleFingerprint: ifMatch }, ctx.slugUpdateTestHook);
  if (out.kind === "gone") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (out.kind === "ownership_changed") return toolError("conflict", RENAME_CONFLICT_MESSAGE);
  if (out.kind === "title_changed") return toolError("fingerprint_mismatch", RENAME_MISMATCH_MESSAGE);
  const row = out.row;
  let ownerHandle: string | null = null;
  if (row.ownerId !== null) {
    const [u] = await ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, row.ownerId)).limit(1);
    if (!u) throw new Error(`notes.owner_id ${row.ownerId} 查無對應 users 列（FK 不變量被打破）`);
    ownerHandle = u.handle;
  }
  const t = truncateText(row.title);
  return toolResult({
    title: t.text,
    ...(t.truncated ? { titleTruncated: true as const } : {}),
    titleFingerprint: fingerprintOf(row.title),
    url: canonicalNotePath({ ownerHandle, groupId: row.groupId, slug: row.slug }),
  });
}
