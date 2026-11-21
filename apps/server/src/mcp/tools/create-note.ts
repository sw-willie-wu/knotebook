/**
 * Without `content` this never touches the live doc, so it sits outside the deployment gate;
 * `content` without collab returns `invalid_body` (as REST 400). Check `ctx.writes.available`
 * first: `applyDeps()` throws for callers that forgot. No presence touch: nobody can have a
 * just-created note open. A queue timeout is `internal`, not `server_busy` (as REST 500):
 * `createWithContent`'s catch deliberately doesn't distinguish exception types, deletes the
 * just-created row and returns internal. With `title` it runs scope-limited slug probes (worst
 * case 20 per round, at most 5 rounds). `group_id` (snake_case) vs REST `groupId` is a
 * deliberate key difference; `url` comes from `canonicalNotePath`, like list/search.
 * The `edit` limiter is charged only with `content`; `tokenWrite` always.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError } from "../../db/pg-errors.js";
import { resolveFolderAccess } from "../../folders/queries.js";
import { newNoteFolderConsistent } from "../../folders/space.js";
import { insertNoteWithAutoSlug } from "../../notes/create.js";
import { loadCreateTarget } from "../../notes/create-target.js";
import { roleFromGroupFlags } from "../../notes/service.js";
import type { SlugScope } from "../../notes/slug.js";
import { GROUP_ID, MD, TITLE } from "../../notes/schemas.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { FOLDER_ID } from "../folder-fields.js";
import {
  CREATE_BUSY_MESSAGE,
  FOLDER_NEEDS_EDIT_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE,
} from "../folder-messages.js";
import { CREATE_KNOWLEDGE_OUTPUT_DESCRIBE, knowledgeForModel, knowledgeOutputSchema } from "../knowledge-output.js";
import { CREATE_KNOWLEDGE_SENTENCE } from "../knowledge-strings.js";
import { WRITE_NOTE_LINK_SENTENCE } from "../note-link-strings.js";
import { insertedRow, rereadVisibleNote } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { PARSER_BUSY_TOOL_MESSAGE, WRITE_RATE_LIMITED_MESSAGE, writeFailureMessage } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import { noteTooLargeMessage } from "../../notes/note-size.js";
import type { McpToolCtx } from "../context.js";

// Verbatim from `docs/mcp.md` with small joins changed. The edit_note promise is limited to
// when `role` allows: a note created by a create-only group role is `viewer`, and edit_note is always forbidden there.
export const CREATE_NOTE_DESCRIPTION =
  "Create a new note — yours, or in one of your groups when you pass `group_id`. Pass `content` to fill it in at the same time, " +
  "or leave it out for an empty note, which edit_note can fill in later if the reply's `role` is `owner` or `editor`. " +
  // Only the parse-failure path leaves no note: on an apply failure cleanup is best-effort and an empty note may remain.
  "Bad markdown is rejected before anything is stored, so a call that fails to parse leaves no " +
  "note behind. The reply carries the new note's `id` — pass it to read_note_outline, or to edit_note when its `role` allows writing " +
  // `url` is site-relative (no scheme/host). Limited to the `content` path: a note created without content leaves no `note_ai_edits` row, so nothing is undoable; claiming otherwise would mislead the model about whether creating an empty note and then editing is safe.
  "— and its `url`, the note's page as a site-relative path: put this site's own address in front " +
  "of it before handing it to anyone. Filling it in with `content` is recorded like any other write " +
  "that changes a note's content, and can usually be undone.";

export const CN_FOLDER =
  "The id of a folder to create the note in, from list_folders; leave it out for the top level. One of your personal folders makes a " +
  "personal note, so leave out `group_id`; one of a group's folders needs that group's id as `group_id` and a role there that can both " +
  "create and edit notes. Your folders for notes shared with you can't hold new notes.";

export const createNoteInput = {
  title: TITLE.optional()
    // Verbatim from `docs/mcp.md`. Don't shorten: "no title → untitled-…" would suggest a
    // given title always wins, but punctuation-only/reserved/uuid-shaped titles fall back to plain `untitled`. "Same place" is the slug scope: your own notes or that group's, never notes shared with you.
    .describe(
      "The note's title. Leave it out and the note is called \"Untitled\" and keeps a " +
        "database-assigned `untitled-<8 hex characters>` URL. A title you pass here is also what " +
        "the note's URL is derived from, de-duplicated against the other notes in the same place — " +
        "your personal notes, or that group's notes — with a numeric suffix (`meeting-notes`, " +
        "then `meeting-notes-2`). Some titles have no usable URL form " +
        "and fall back to `untitled`, numbered the same way — punctuation on its own, a reserved " +
        "word, or a uuid, or a title ending in one. Pass a title if you know it; edit_note's `rename` can change it later " +
        "when the reply's `role` is `owner` or `editor`.",
    ),
  // Verbatim from `docs/mcp.md`; `GROUP_ID` is the same object as REST's.
  group_id: GROUP_ID.optional().describe(
    "The id of one of your groups where your role lets you create notes. The note then belongs to the group, " +
      "not to you. Leave it out for a personal note. If your role there can create notes but not edit them, " +
      "the note is read-only for you: the reply's `role` is `viewer`.",
  ),
  content: MD.optional()
    .describe(
      "Markdown for the new note. Leave it out to create an empty note. Some deployments cannot store content this way and answer `invalid_body`; create the note without it and the note still exists. Colors, side-by-side columns and sizes work as in edit_note. " +
        WRITE_NOTE_LINK_SENTENCE +
        ` ${CREATE_KNOWLEDGE_SENTENCE}`,
    ),
  folder_id: FOLDER_ID.optional().describe(CN_FOLDER),
};

export const createNoteOutput = {
  note: noteSummarySchema.describe("The note that was created, in the same shape list_notes returns."),
  knowledge: knowledgeOutputSchema.optional().describe(CREATE_KNOWLEDGE_OUTPUT_DESCRIBE),
};

export interface CreateNoteArgs {
  title?: string;
  content?: string;
  group_id?: string;
  folder_id?: string;
}

/** Must not reuse `NOTE_NOT_FOUND_MESSAGE` (that one is about notes, this about groups); the two 404s (non-member / nonexistent) must be byte-identical. */
const GROUP_NOT_FOUND_MESSAGE = "No group with that id among the groups you belong to.";
const CREATE_IN_GROUP_FORBIDDEN_MESSAGE = "Your role in that group can't create notes. Leave out `group_id` to create a personal note.";

const NO_CONTENT_SUPPORT_MESSAGE =
  "This deployment cannot create a note with content. Call create_note again without `content`.";
const CREATE_FAILED_MESSAGE = "The note could not be created and nothing was stored. Try again.";

export async function createNote(args: CreateNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // Charged even without `content`, as REST's preHandler does.
  const denied = requireWriteScope(ctx);
  if (denied !== null) return denied;

  // With `content`: `available` gate → charge `edit` → only then any DB write or slug probe,
  // so a rejection has no side effects.

  // Group check → `available` → charge `edit`, as REST: rejections don't consume the
  // limiter. The membership check runs outside the transaction, so a flag revoked between check and insert isn't caught. A non-member (even a site
  // admin) gets the same `group_not_found` as a nonexistent group; `role` follows the create
  // flag (a create-only role is `viewer`). Folder: visibility → space → group → `can_edit`.
  let folderId: string | null = null;
  if (args.folder_id !== undefined) {
    const folder = await resolveFolderAccess(ctx.db, ctx.userId, args.folder_id);
    if (folder === null) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!newNoteFolderConsistent(folder.space, args.group_id)) return toolError("invalid_body", NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE);
    folderId = folder.folder.id;
  }

  let target: { scope: SlugScope; ownerHandle: string | null; groupName: string | null; role: string };
  if (args.group_id !== undefined) {
    const m = await loadCreateTarget(ctx.db, ctx.userId, args.group_id);
    if (!m) return toolError("group_not_found", GROUP_NOT_FOUND_MESSAGE);
    if (!m.canCreate) return toolError("forbidden", CREATE_IN_GROUP_FORBIDDEN_MESSAGE);
    if (folderId !== null && !m.canEdit) return toolError("forbidden", FOLDER_NEEDS_EDIT_MESSAGE);
    await ctx.groupTestHook?.("membership-checked", { groupId: args.group_id });
    target = { scope: { groupId: args.group_id }, ownerHandle: null, groupName: m.name, role: roleFromGroupFlags(m) };
  } else {
    target = { scope: { ownerId: ctx.userId }, ownerHandle: ctx.userHandle, groupName: null, role: "owner" };
  }
  // Same classification as REST `sendCreateInsertFailure`. Retryable errors (40P01/40001/55P03) → server_busy. With a folder: the folder deleted, its space changed (group transferred) or the group deleted after the check (the group FK may fire first) → the folder's not_found. A 23503 is mapped only on the
  // group branch: on the personal branch it can only be `owner_id → users`, which nothing hard-deletes.
  const mapCreateInsertFailure = (err: unknown): CallToolResult => {
    if (isRetryableTxError(err)) return toolError("server_busy", CREATE_BUSY_MESSAGE);
    if (folderId !== null && (isNoteFolderSpaceViolation(err) || isForeignKeyViolation(err))) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (args.group_id !== undefined && isForeignKeyViolation(err)) return toolError("group_not_found", GROUP_NOT_FOUND_MESSAGE);
    throw err;
  };

  if (args.content !== undefined) {
    // Before charging `edit`: this call never reaches the write pipeline.
    if (!ctx.writes.available) return toolError("invalid_body", NO_CONTENT_SUPPORT_MESSAGE);
    if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

    let out;
    try {
      out = await ctx.writes.createWithContent(ctx.log, {
        userId: ctx.userId,
        userHandle: ctx.userHandle,
        tokenId: ctx.tokenId,
        title: args.title,
        content: args.content,
        scope: target.scope,
        folderId,
      });
    } catch (err) {
      return mapCreateInsertFailure(err);
    }
    if (!out.ok) {
      if (out.kind === "parse") return toolError(out.code, writeFailureMessage(out.code, out.detail, out.knowledge));
      if (out.kind === "parser_busy") return toolError("server_busy", PARSER_BUSY_TOOL_MESSAGE);
      if (out.kind === "too_large") return toolError("note_too_large", noteTooLargeMessage(out.limitBytes), { limitBytes: out.limitBytes });
      return toolError("internal", CREATE_FAILED_MESSAGE);
    }
    const fresh = await rereadVisibleNote(ctx, out.noteId, target.scope);
    const [note] = await noteSummariesForModel(ctx.db, [fresh ?? { ...insertedRow(out.inserted, target), role: target.role }]);
    return toolResult({ note, ...(out.knowledge ? { knowledge: knowledgeForModel(out.knowledge) } : {}) });
  }

  // No re-read: the four `last_edited_*` fields are still defaults, so `lastEdited` is null and a JOIN would miss anyway. With `title` the slug follows it at insert, so the returned `url` is final. `beforeInsert` is outside the insert's try, so its error reaches the catch here as-is.
  let created;
  try {
    created = await insertNoteWithAutoSlug(ctx.db, { scope: target.scope, folderId }, args.title, ctx.noteCreateHooks);
  } catch (err) {
    return mapCreateInsertFailure(err);
  }
  const [note] = await noteSummariesForModel(ctx.db, [{ ...insertedRow(created, target), role: target.role }]);
  return toolResult({ note });
}
