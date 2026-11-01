/**
 * #181 spec §6.8.1 `restore_note(note_id)`：從垃圾桶還原（同 REST `POST /api/trash/restore` 的權限與服務函式，D-W1a 要 notes:delete）。
 * 只經 `trash/service.ts` 的 `restoreTrashed`（AG2 的預判在服務層；不直呼交易本體）。流程順序是契約：`requireDeleteScope`（第一個動作）
 * → `resolveTrashedNoteAccess`（沒有垃圾桶權、不存在、活筆記 → not_found，同一句）→ edit 桶（REST 不扣，讀碼發現 10）→ `restoreTrashed`
 * （可重試的交易錯誤 → server_busy；沒還原到 → not_found）→ `rereadOwnOrGroupNote`（落空 → not_found，讀碼發現 7）。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isRetryableTxError } from "../../db/pg-errors.js";
import { NOTE_ID } from "../../notes/schemas.js";
import { resolveTrashedNoteAccess } from "../../notes/service.js";
import { restoreTrashed, type TrashBatchResult } from "../../trash/service.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { rereadOwnOrGroupNote } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE } from "../write-messages.js";
import { requireDeleteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const RESTORE_NOTE_DESCRIPTION =
  "Bring a note back from the trash. It appears in list_notes and search_notes again, and the per-person shares and public link it " +
  "kept while in the trash work again. A note whose group was deleted with its notes handed over to one of its admins comes back as " +
  "that admin's personal note, with a different owner and URL — see `url` in the reply. Works on notes in your trash: your own " +
  "personal notes, and notes of groups where your role can both edit and delete notes. " +
  // 資料夾 PR-3d（RN+）：講的是 list_trash 的 folderPath。
  "It usually goes back into the folder that list_trash shows as its `folderPath`, re-creating folders on that path that are missing. " +
  "Replies with the note in the same shape list_notes returns.";

export const restoreNoteInput = {
  note_id: NOTE_ID.describe("The id of a note in the trash, as returned by list_trash or by delete_note's reply."),
};
export const restoreNoteOutput = { note: noteSummarySchema.describe("The note after it was restored, in the same shape list_notes returns.") };

/** AG2：沒有垃圾桶權、不存在、不在垃圾桶、已永久刪除、還原後重讀落空同一句。 */
export const RESTORE_NOT_FOUND_MESSAGE =
  "No note with that id in a trash you can restore from. For example, it may not exist, may not be in the trash, may have been " +
  "deleted permanently, may be someone else's, may belong to a group you aren't in, or may be in the trash of a group where your " +
  "role can't both edit and delete notes; list_trash shows the ones you can restore.";
export const RESTORE_BUSY_MESSAGE = "The server was busy, so the note was not restored. Try again in a moment.";

export async function restoreNoteTool(args: { note_id: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireDeleteScope(ctx);
  if (denied !== null) return denied;

  const id = args.note_id.toLowerCase();
  // 角色檢查＝垃圾桶權的預判（restoreTrashed 內部會再判一次，多一句 SQL，可接受）；它之後才扣 edit 桶。
  if (!(await resolveTrashedNoteAccess(ctx.db, ctx.userId, id))) return toolError("not_found", RESTORE_NOT_FOUND_MESSAGE);

  if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

  let out: TrashBatchResult;
  try {
    out = await restoreTrashed(
      {
        db: ctx.db,
        collabHooks: ctx.collabHooks,
        uploadsDir: ctx.uploadsDir,
        storageLockTimeoutMs: ctx.storageLockTimeoutMs,
        groupTestHook: ctx.groupTestHook,
      },
      { ids: [id], by: ctx.userId },
    );
  } catch (err) {
    if (isRetryableTxError(err)) return toolError("server_busy", RESTORE_BUSY_MESSAGE);
    throw err;
  }
  // skipped 的 not_found／not_in_trash（預判之後被別人先還原、永久刪除或降權）一律同一句。
  if (!out.done.includes(id)) return toolError("not_found", RESTORE_NOT_FOUND_MESSAGE);

  // 落空＝commit 之後、重讀之前又被移入或降權（REST 的同一窗是「不列 restored、也不列 skipped」）。
  const row = await rereadOwnOrGroupNote(ctx, id);
  if (!row) return toolError("not_found", RESTORE_NOT_FOUND_MESSAGE);
  const [note] = await noteSummariesForModel(ctx.db, [row]);
  return toolResult({ note });
}
