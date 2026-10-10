/**
 * #180 spec §6：`copy_note(note_id, group_id?)`。行為照 REST `POST /api/notes/:id/copy`（共用 `notes/copy-note.ts`）。
 * 在 `register.ts` 的 collab 閘門**外**（REST 複製無條件註冊；`loadNoteDoc` 無 collab 時讀 `note_states`，F35），以 `.strict()` 註冊。
 * 三本節流帳（§6.4）：`tokenWrite`（token 才有，`requireWriteScope`）→ `edit`（共用函式內）→ `upload`（依附件數，共用函式內）。
 * 配額可見性：`canViewSpaceUsage`；`isAdmin` 照 `create-transfer-token.ts` 的作法只在被拒這一刻讀一次（ctx 沒有它）。
 */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatBytes } from "@knotebook/shared";
import { users } from "../../db/schema.js";
import { UPLOAD_LIMIT } from "../../http/rate-limit.js";
import { copyNote } from "../../notes/copy-note.js";
import { GROUP_ID, NOTE_ID } from "../../notes/schemas.js";
import { roleFromGroupFlags } from "../../notes/service.js";
import type { StorageSpace } from "../../storage/space.js";
import { StorageQuotaExceeded } from "../../storage/tx/quota.js";
import { canViewSpaceUsage } from "../../storage/usage.js";
import { noteSummarySchema, toNoteSummary } from "../dto.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../note-read.js";
import { insertedRow } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { GROUP_NO_CREATE_MESSAGE, WRITE_RATE_LIMITED_MESSAGE } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const COPY_NOTE_DESCRIPTION =
  "Copy a note you can read into a new note — yours, or in one of your groups when you pass `group_id`. The copy gets the note's " +
  "title and its current content, and usually its own copies of the images uploaded to that note; from then on the two notes change " +
  "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
  "note's history. The reply is the new note in the shape list_notes returns; in a group, its `role` can be `viewer`.";

const COPY_GROUP_ID_DESCRIBE =
  "The id of one of your groups where your role lets you create notes; the copy then belongs to the group. Leave it out to copy " +
  "into your personal notes. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";

export const copyNoteInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  group_id: GROUP_ID.optional().describe(COPY_GROUP_ID_DESCRIBE),
};
export const copyNoteOutput = { note: noteSummarySchema.describe("The new copy, in the same shape list_notes returns.") };

/** spec §6.6（`too_many_requests`）：數字由 `UPLOAD_LIMIT` 內插，不手抄（U7 守）。 */
export const COPY_UPLOAD_LIMIT_MESSAGE =
  `Copying this note's images would go over your upload limit (${UPLOAD_LIMIT.limit} files per ${UPLOAD_LIMIT.windowMs / 60_000} minutes, ` +
  "copies included), so nothing was copied. Wait a few minutes and try again.";
export const COPY_BUSY_MESSAGE = "The server was busy, so no copy was made. Try again in a moment.";
/** 不可見形只會是群組（個人空間對本人恆可見，F37）。 */
export const COPY_QUOTA_HIDDEN_MESSAGE =
  "The group's storage space has no room for this note's images, so the note was not copied. Ask a site admin for more space.";

export function copyQuotaVisibleMessage(space: StorageSpace, usedBytes: number, quotaBytes: number, incomingBytes: number | null): string {
  const who = space.kind === "user" ? "Your" : "The group's";
  const need = incomingBytes === null ? "" : `; they need ${formatBytes(incomingBytes)}`;
  return (
    `${who} storage space has no room for this note's images (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used${need}), ` +
    "so the note was not copied. A site admin can assign a larger storage plan; deleting notes that have images also frees space."
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
}

export async function copyNoteTool(args: CopyNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireWriteScope(ctx);
  if (denied !== null) return denied;
  const out = await copyNote(
    {
      db: ctx.db, collab: ctx.collab, log: ctx.log, uploadsDir: ctx.uploadsDir, storageLockTimeoutMs: ctx.storageLockTimeoutMs,
      limiters: { edit: ctx.limiters.edit, upload: ctx.limiters.upload },
      groupTestHook: ctx.groupTestHook, noteCreateHooks: ctx.noteCreateHooks, searchIndexHooks: ctx.searchIndexHooks,
    },
    { sourceId: args.note_id, userId: ctx.userId, ...(args.group_id === undefined ? {} : { groupId: args.group_id }) },
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
      return toolError("too_many_requests", COPY_UPLOAD_LIMIT_MESSAGE);
    case "space_full":
      return quotaError(ctx, out.space, out.usage.usedBytes, out.usage.quotaBytes, null);
    case "aborted": {
      const err = out.err;
      if (err instanceof StorageQuotaExceeded) return quotaError(ctx, err.space, err.usedBytes, err.quotaBytes, err.incomingBytes);
      if (err.errCode === "not_found") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      if (err.errCode === "group_not_found") return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
      throw err; // `copyNoteInTx` 只 abort 上面兩種碼（`notes/tx/copy.ts:82-103`）；其他是接線錯，交給 runTool 的 internal。
    }
    case "busy":
      return toolError("server_busy", COPY_BUSY_MESSAGE);
    case "copied": {
      const personal = out.target === null;
      const row = insertedRow(out.note, { ownerHandle: personal ? ctx.userHandle : null, groupName: out.target?.name ?? null });
      return toolResult({ note: toNoteSummary(row, out.target === null ? "owner" : roleFromGroupFlags(out.target)) });
    }
  }
}
