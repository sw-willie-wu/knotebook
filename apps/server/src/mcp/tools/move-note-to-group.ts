/** Same behavior as REST move (shared `notes/move-note.ts`); outside the collab gate (DB only; kicking goes through collabHooks, a no-op without collab). Both annotations equal the SDK defaults, written out so clients needn't depend on them. No `edit` limiter (REST move has none), no presence, `updated_at` untouched. */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatBytes } from "@knotebook/shared";
import { users } from "../../db/schema.js";
import { moveNoteToGroup } from "../../notes/move-note.js";
import { GROUP_ID, NOTE_ID } from "../../notes/schemas.js";
import { StorageQuotaExceeded } from "../../storage/tx/quota.js";
import { canViewSpaceUsage } from "../../storage/usage.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { FOLDER_ID } from "../folder-fields.js";
import { FOLDER_NEEDS_EDIT_MESSAGE, FOLDER_NOT_FOUND_MESSAGE, MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE } from "../folder-messages.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../note-read.js";
import { rereadVisibleNote } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { GROUP_NO_CREATE_MESSAGE } from "../write-messages.js";
import { requireMoveScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const MOVE_NOTE_TO_GROUP_DESCRIPTION =
  "Move one of your own personal notes into one of your groups, where the group's roles then decide who can read and change it. " +
  "A single note can't be taken out of a group again, here or in the web app — copy_note can copy it out instead. Moving removes the " +
  "note's per-person shares and its public link, and gives it the group's URL (the old one forwards to it for a month); it also removes " +
  "the note's version history unless you pass keep_history: true, which brings the history along and lets the group's editors see the " +
  "earlier versions and who edited them. Your own access becomes what your group role allows, which can be read-only — see the reply's `role`.";

const MOVE_KEEP_HISTORY_DESCRIBE =
  "Set true to bring the note's version history along. Leave it out or set false and the history is removed and can't be restored. " +
  "Kept versions keep their names and still list who edited each one (handle, avatar, agent label); the group's editors can see that list, and it can name people who are not in the group.";

const MOVE_GROUP_ID_DESCRIBE =
  "The id of one of your groups where your role lets you create notes. A group's id is the `id` in the `owner` of its notes in " +
  "list_notes or search_notes.";

export const MOVE_TO_GROUP_FOLDER_ID_DESCRIBE =
  "The id of one of that group's folders to put the note in, from list_folders with `group_id`; your role there must also be able to " +
  "edit notes. Leave it out to put the note at the group's top level.";

export const moveNoteToGroupInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  group_id: GROUP_ID.describe(MOVE_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(MOVE_TO_GROUP_FOLDER_ID_DESCRIBE),
  keep_history: z.boolean().optional().describe(MOVE_KEEP_HISTORY_DESCRIBE),
};
export const moveNoteToGroupOutput = { note: noteSummarySchema.describe("The note after the move, in the same shape list_notes returns.") };

export const MOVE_FORBIDDEN_MESSAGE =
  "Only the owner of a personal note can move it into a group; this note is someone else's, or it is already in a group.";
export const MOVE_CONFLICT_MESSAGE = "This note stopped being your personal note after your access was checked, so it was not moved.";
export const MOVE_BUSY_MESSAGE = "The server was busy, so the note was not moved. Try again in a moment.";
/** Ends "then try again", as `COPY_NEEDS_MOVE_MESSAGE`. Dead over HTTP: the tool isn't registered without notes:move. */
export const MOVE_NEEDS_MOVE_MESSAGE =
  "Moving a note into a group needs the notes:move scope, and this credential doesn't have it, so nothing was moved. " +
  'Ask the user to turn on "Move to groups (can\'t be undone)" (notes:move) for this credential via the pencil on its row in ' +
  "Settings → Authorization, then try again.";
const MOVE_QUOTA_HIDDEN_MESSAGE =
  "The group's storage space has no room for this note's files, so the note was not moved. Ask a site admin for more space.";

function moveQuotaVisibleMessage(usedBytes: number, quotaBytes: number, incomingBytes: number): string {
  return (
    `The group's storage space has no room for this note's files (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used; ` +
    `they need ${formatBytes(incomingBytes)}), so the note was not moved. A site admin can assign a larger storage plan; deleting notes ` +
    "that have files also frees space."
  );
}

export interface MoveNoteToGroupArgs {
  note_id: string;
  group_id: string;
  folder_id?: string;
  keep_history?: boolean;
}

export async function moveNoteToGroupTool(args: MoveNoteToGroupArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireMoveScope(ctx, MOVE_NEEDS_MOVE_MESSAGE);
  if (denied !== null) return denied;
  const out = await moveNoteToGroup(
    { db: ctx.db, collabHooks: ctx.collabHooks, versions: ctx.versions, storageLockTimeoutMs: ctx.storageLockTimeoutMs, groupTestHook: ctx.groupTestHook },
    {
      noteId: args.note_id,
      userId: ctx.userId,
      userHandle: ctx.userHandle,
      groupId: args.group_id,
      ...(args.folder_id === undefined ? {} : { folderId: args.folder_id }),
      keepHistory: args.keep_history === true,
    },
  );
  switch (out.kind) {
    case "not_found":
      return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    case "forbidden":
      return toolError("forbidden", MOVE_FORBIDDEN_MESSAGE);
    case "group_not_found":
      return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
    case "busy":
      return toolError("server_busy", MOVE_BUSY_MESSAGE);
    case "aborted": {
      const err = out.err;
      if (err instanceof StorageQuotaExceeded) {
        // `isAdmin` is read only on rejection (ctx doesn't carry it).
        const [me] = await ctx.db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, ctx.userId));
        return (await canViewSpaceUsage(ctx.db, { id: ctx.userId, isAdmin: me?.isAdmin === true }, err.space))
          ? toolError("storage_quota_exceeded", moveQuotaVisibleMessage(err.usedBytes, err.quotaBytes, err.incomingBytes), {
              usedBytes: err.usedBytes,
              quotaBytes: err.quotaBytes,
              incomingBytes: err.incomingBytes,
            })
          : toolError("storage_quota_exceeded", MOVE_QUOTA_HIDDEN_MESSAGE);
      }
      if (err.errCode === "not_found") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      if (err.errCode === "conflict") return toolError("conflict", MOVE_CONFLICT_MESSAGE);
      if (err.errCode === "group_not_found") return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
      if (err.errCode === "folder_not_found") return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
      if (err.errCode === "folder_cross_space") return toolError("invalid_body", MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE);
      if (err.errCode === "forbidden") return toolError("forbidden", FOLDER_NEEDS_EDIT_MESSAGE);
      throw err; // An unlisted code is a wiring bug.
    }
    case "moved": {
      const row = await rereadVisibleNote(ctx, args.note_id.toLowerCase(), { groupId: args.group_id.toLowerCase() });
      if (!row) return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      const [note] = await noteSummariesForModel(ctx.db, [row]);
      return toolResult({ note });
    }
  }
}
