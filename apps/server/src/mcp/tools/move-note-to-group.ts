/**
 * #180 spec §5：`move_note_to_group(note_id, group_id)`。行為照 REST `POST /api/notes/:id/move`（共用 `notes/move-note.ts`）。
 * collab 閘門**外**（只碰 DB；踢線經 collabHooks，無 collab 時 no-op，F30）；`.strict()` 註冊；annotations
 * `{destructiveHint: true, idempotentHint: false}`（W11，兩值等於 SDK 預設，寫出來讓 client 不必依賴預設）。不加 `confirm` 參數。
 * 不扣 `edit` 桶（REST 移動不扣，F26）；不 touch presence；`updated_at` 不動（F27）。
 */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  "note's per-person shares, its public link and its version history, and gives it the group's URL (the old one forwards to it for a " +
  "month); your own access becomes what your group role allows, which can be read-only — see the reply's `role`.";

const MOVE_GROUP_ID_DESCRIBE =
  "The id of one of your groups where your role lets you create notes. A group's id is the `id` in the `owner` of its notes in " +
  "list_notes or search_notes.";

/** MG_FOLDER（資料夾 PR-3d，逐字照 plan「待確認字串」）。 */
export const MOVE_TO_GROUP_FOLDER_ID_DESCRIBE =
  "The id of one of that group's folders to put the note in, from list_folders with `group_id`; your role there must also be able to " +
  "edit notes. Leave it out to put the note at the group's top level.";

export const moveNoteToGroupInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  group_id: GROUP_ID.describe(MOVE_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(MOVE_TO_GROUP_FOLDER_ID_DESCRIBE),
};
export const moveNoteToGroupOutput = { note: noteSummarySchema.describe("The note after the move, in the same shape list_notes returns.") };

export const MOVE_FORBIDDEN_MESSAGE =
  "Only the owner of a personal note can move it into a group; this note is someone else's, or it is already in a group.";
export const MOVE_CONFLICT_MESSAGE = "This note stopped being your personal note after your access was checked, so it was not moved.";
export const MOVE_BUSY_MESSAGE = "The server was busy, so the note was not moved. Try again in a moment.";
/** spec §7.5(e)，#247 §12 改寫後 261 字元（原 273；處置＝在「設定 → 授權」的 token 列上以鉛筆開啟搬移權，結尾「then try again」理由同 `COPY_NEEDS_MOVE_MESSAGE`）。HTTP 上是死碼（沒 notes:move 時這支不註冊；唯一的守衛＝`test/unit/mcp-write-scope.test.ts` 的 #239 U3）。 */
export const MOVE_NEEDS_MOVE_MESSAGE =
  "Moving a note into a group needs the notes:move scope, and this credential doesn't have it, so nothing was moved. " +
  'Ask the user to turn on "Move or copy notes into groups" for this credential via the pencil on its row in ' +
  "Settings → Authorization, then try again.";
const MOVE_QUOTA_HIDDEN_MESSAGE =
  "The group's storage space has no room for this note's images, so the note was not moved. Ask a site admin for more space.";

function moveQuotaVisibleMessage(usedBytes: number, quotaBytes: number, incomingBytes: number): string {
  return (
    `The group's storage space has no room for this note's images (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used; ` +
    `they need ${formatBytes(incomingBytes)}), so the note was not moved. A site admin can assign a larger storage plan; deleting notes ` +
    "that have images also frees space."
  );
}

export interface MoveNoteToGroupArgs {
  note_id: string;
  group_id: string;
  folder_id?: string;
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
        // `isAdmin` 只在被拒這一刻讀一次（同 create-transfer-token.ts，ctx 沒有它）。
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
      // 資料夾 PR-3a 起 moveNoteToGroup 另以 aborted 回三碼（交易外預判與 `tx/move.ts` 的重判；plan 讀碼發現 10）。
      if (err.errCode === "folder_not_found") return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
      if (err.errCode === "folder_cross_space") return toolError("invalid_body", MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE);
      if (err.errCode === "forbidden") return toolError("forbidden", FOLDER_NEEDS_EDIT_MESSAGE);
      throw err; // 未列的碼是接線錯。
    }
    case "moved": {
      // 交易外重讀（grouped 分支，role 由群組旗標算）。落空＝commit 之後、重讀之前被移出群組或筆記被刪——與 REST 同窗回 404 對齊。
      const row = await rereadVisibleNote(ctx, args.note_id.toLowerCase(), { groupId: args.group_id.toLowerCase() });
      if (!row) return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      const [note] = await noteSummariesForModel(ctx.db, [row]);
      return toolResult({ note });
    }
  }
}
