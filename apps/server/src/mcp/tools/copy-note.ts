/** Outside the collab gate (`loadNoteDoc` reads `note_states` without collab). Limiters in order: `tokenWrite` (`requireMoveScope` with `group_id`) → `edit` → `upload` (per copied attachment). `isAdmin` is read only on rejection (ctx doesn't carry it), like `create-transfer-token.ts`. */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatBytes } from "@knotebook/shared";
import { users } from "../../db/schema.js";
import { UPLOAD_LIMIT } from "../../http/rate-limit.js";
import { resolveFolderAccess } from "../../folders/queries.js";
import { newNoteFolderConsistent } from "../../folders/space.js";
import { copyNote } from "../../notes/copy-note.js";
import { noteTooLargeMessage } from "../../notes/note-size.js";
import { GROUP_ID, NOTE_ID } from "../../notes/schemas.js";
import { roleFromGroupFlags } from "../../notes/service.js";
import type { StorageSpace } from "../../storage/space.js";
import { StorageQuotaExceeded } from "../../storage/tx/quota.js";
import { canViewSpaceUsage } from "../../storage/usage.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { FOLDER_ID } from "../folder-fields.js";
import { FOLDER_NEEDS_EDIT_MESSAGE, FOLDER_NOT_FOUND_MESSAGE, NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE } from "../folder-messages.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../note-read.js";
import { insertedRow } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { GROUP_NO_CREATE_MESSAGE, WRITE_RATE_LIMITED_MESSAGE } from "../write-messages.js";
import { requireMoveScope, requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const COPY_NOTE_DESCRIPTION =
  "Copy a note you can read into a new note — yours, or in one of your groups when you pass `group_id`. The copy gets the note's " +
  "title and its current content, and usually its own copies of the files uploaded to that note; from then on the two notes change " +
  "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
  "note's history. The reply is the new note in the shape list_notes returns; in a group, its `role` can be `viewer`.";

export const COPY_GROUP_ID_DESCRIBE =
  "The id of one of your groups where your role lets you create notes; the copy then belongs to the group. Leave it out to copy " +
  "into your personal notes. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";

export const COPY_FOLDER_ID_DESCRIBE =
  "The id of a folder to put the copy in, from list_folders; leave it out for the top level. One of your personal folders for a copy " +
  "of your own (leave out `group_id`), or one of the folders of the group you pass as `group_id`, where your role must also be able to edit notes.";
export const COPY_FOLDER_ID_DESCRIBE_NO_MOVE =
  "The id of one of your personal folders to put the copy in, from list_folders; leave it out for the top level of your personal notes.";

export const copyNoteInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  group_id: GROUP_ID.optional().describe(COPY_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(COPY_FOLDER_ID_DESCRIBE),
};

/** No "this credential doesn't have it": after an upgrade a client that cached this version would show a false sentence. */
export const COPY_NOTE_DESCRIPTION_NO_MOVE =
  "Copy a note you can read into a new note of your own; copying into a group needs the notes:move scope (see `group_id`). The copy gets the note's " +
  "title and its current content, and usually its own copies of the files uploaded to that note; from then on the two notes change " +
  "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
  "note's history. The reply is the new note in the shape list_notes returns.";

export const COPY_GROUP_ID_DESCRIBE_NO_MOVE =
  "Copying into a group needs a credential with the notes:move scope. Leave this out to copy into your personal notes. " +
  "A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";

export const copyNoteInputNoMove = {
  ...copyNoteInput,
  group_id: GROUP_ID.optional().describe(COPY_GROUP_ID_DESCRIBE_NO_MOVE),
  folder_id: FOLDER_ID.optional().describe(COPY_FOLDER_ID_DESCRIBE_NO_MOVE),
};

/** Reachable over HTTP (copy_note is listed for read-write credentials). Ends "then try again", not "reconnect": the tool is listed and the scope is re-read per request. */
export const COPY_NEEDS_MOVE_MESSAGE =
  "Copying a note into a group needs the notes:move scope, and this credential doesn't have it, so nothing was copied. " +
  'Leave out group_id to copy into your personal notes, or ask the user to turn on "Move to groups (can\'t be undone)" (notes:move) for this ' +
  "credential via the pencil on its row in Settings → Authorization, then try again.";
export const copyNoteOutput = { note: noteSummarySchema.describe("The new copy, in the same shape list_notes returns.") };

/** The limit is the one of the limiter that rejected (`currentLimit()`); the window comes from `UPLOAD_LIMIT`. */
export function copyUploadLimitMessage(limit: number): string {
  return (
    `Copying this note's files would go over your upload limit (${limit} files per ${UPLOAD_LIMIT.windowMs / 60_000} minutes, ` +
    "copies included), so nothing was copied. Wait a few minutes and try again."
  );
}
export const COPY_BUSY_MESSAGE = "The server was busy, so no copy was made. Try again in a moment.";
/** Only a group space can be invisible (a personal space is always visible to its owner). */
export const COPY_QUOTA_HIDDEN_MESSAGE =
  "The group's storage space has no room for this note's files, so the note was not copied. Ask a site admin for more space.";

export function copyQuotaVisibleMessage(space: StorageSpace, usedBytes: number, quotaBytes: number, incomingBytes: number | null): string {
  const who = space.kind === "user" ? "Your" : "The group's";
  const need = incomingBytes === null ? "" : `; they need ${formatBytes(incomingBytes)}`;
  return (
    `${who} storage space has no room for this note's files (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used${need}), ` +
    "so the note was not copied. A site admin can assign a larger storage plan; deleting notes that have files also frees space."
  );
}

async function quotaError(ctx: McpToolCtx, space: StorageSpace, usedBytes: number, quotaBytes: number, incomingBytes: number | null): Promise<CallToolResult> {
  const [me] = await ctx.db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, ctx.userId));
  if (await canViewSpaceUsage(ctx.db, { id: ctx.userId, isAdmin: me?.isAdmin === true }, space)) {
    return toolError("storage_quota_exceeded", copyQuotaVisibleMessage(space, usedBytes, quotaBytes, incomingBytes), {
      usedBytes,
      quotaBytes,
      ...(incomingBytes === null ? {} : { incomingBytes }),
    });
  }
  return toolError("storage_quota_exceeded", COPY_QUOTA_HIDDEN_MESSAGE);
}

export interface CopyNoteArgs {
  note_id: string;
  group_id?: string;
  folder_id?: string;
}

export async function copyNoteTool(args: CopyNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // With folder_id, folder visibility is checked before the scope check and the note lookup,
  // so error priority differs from REST (note first, no scope check); copyNote re-checks in REST order.
  if (args.folder_id !== undefined) {
    const folder = await resolveFolderAccess(ctx.db, ctx.userId, args.folder_id);
    if (folder === null) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!newNoteFolderConsistent(folder.space, args.group_id)) return toolError("invalid_body", NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE);
  }
  // Before the note lookup, so a nonexistent note_id also gets insufficient_scope: no existence oracle.
  const denied = args.group_id === undefined ? requireWriteScope(ctx) : requireMoveScope(ctx, COPY_NEEDS_MOVE_MESSAGE);
  if (denied !== null) return denied;
  const out = await copyNote(
    {
      db: ctx.db, collab: ctx.collab, log: ctx.log, uploadsDir: ctx.uploadsDir, storageLockTimeoutMs: ctx.storageLockTimeoutMs,
      limiters: { edit: ctx.limiters.edit, upload: ctx.limiters.upload }, noteMaxBytes: ctx.writes.noteMaxBytes,
      groupTestHook: ctx.groupTestHook, noteCreateHooks: ctx.noteCreateHooks, searchIndexHooks: ctx.searchIndexHooks,
      knowledgeIndexHooks: ctx.knowledgeIndexHooks,
    },
    {
      sourceId: args.note_id,
      userId: ctx.userId,
      ...(args.group_id === undefined ? {} : { groupId: args.group_id }),
      ...(args.folder_id === undefined ? {} : { folderId: args.folder_id }),
    },
  );
  switch (out.kind) {
    case "not_found":
    case "fk_personal":
      return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    case "group_not_found":
      return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
    case "edit_rate_limited":
      return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);
    case "upload_rate_limited":
      return toolError("too_many_requests", copyUploadLimitMessage(ctx.limiters.upload.currentLimit()));
    case "space_full":
      return quotaError(ctx, out.space, out.usage.usedBytes, out.usage.quotaBytes, out.incomingBytes);
    case "aborted": {
      const err = out.err;
      if (err instanceof StorageQuotaExceeded) return quotaError(ctx, err.space, err.usedBytes, err.quotaBytes, err.incomingBytes);
      if (err.errCode === "not_found") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      if (err.errCode === "group_not_found") return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
      if (err.errCode === "folder_not_found") return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
      if (err.errCode === "folder_cross_space") return toolError("invalid_body", NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE);
      if (err.errCode === "forbidden") return toolError("forbidden", FOLDER_NEEDS_EDIT_MESSAGE);
      throw err; // An unlisted code is a wiring bug; leave it to runTool's internal.
    }
    case "busy":
      return toolError("server_busy", COPY_BUSY_MESSAGE);
    case "too_large":
      return toolError("note_too_large", noteTooLargeMessage(out.limitBytes), { limitBytes: out.limitBytes });
    case "copied": {
      const personal = out.target === null;
      const row = insertedRow(out.note, { ownerHandle: personal ? ctx.userHandle : null, groupName: out.target?.name ?? null });
      const [note] = await noteSummariesForModel(ctx.db, [{ ...row, role: out.target === null ? "owner" : roleFromGroupFlags(out.target) }]);
      return toolResult({ note });
    }
  }
}
