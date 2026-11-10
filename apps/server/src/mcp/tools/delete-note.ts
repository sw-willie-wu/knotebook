/**
 * #181 `delete_note(note_id)`：移到垃圾桶（同 REST `DELETE /api/notes/:id` 的權限與服務函式）。
 * 移入只能經 `trash/service.ts` 的 `trashNote`（唯一寫 deleted_at 的是 `trashNotesInTx`）；本檔不得出現 deleted_at 字面（守衛二）。
 * 流程順序是契約：`requireDeleteScope`（第一個動作，拒絕時什麼都沒做）→ `resolveNoteAccess`（none → not_found、無刪除權 → forbidden）
 * → `readTrashRetentionDays`（只當存在性守衛，排在扣桶之前）→ edit 桶（REST 不扣）→ `trashNote`
 * （可重試的交易錯誤 → server_busy）→ `loadTrashedMeta`（commit 後一讀；落空 → not_found）。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../../auth/tx/admin-site-settings.js";
import { isRetryableTxError } from "../../db/pg-errors.js";
import { NOTE_ID } from "../../notes/schemas.js";
import { resolveNoteAccess } from "../../notes/service.js";
import { loadTrashedMeta, readTrashRetentionDays } from "../../trash/list.js";
import { trashNote, type TrashNoteOutcome } from "../../trash/service.js";
import { MCP_TEXT_MAX, truncateText } from "../limits.js";
import { toolError, toolResult } from "../tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE } from "../write-messages.js";
import { requireDeleteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const DELETE_NOTE_DESCRIPTION =
  "Move a note to the trash. It stops appearing in list_notes and search_notes, reading or editing it answers not_found, its " +
  "per-person shares and public link stop working, and anyone who has it open is disconnected. Nothing is deleted permanently by " +
  "this tool: restore_note can bring it back until it is deleted permanently — automatically once it is due (the reply's `purgeAt` " +
  "is that date under the site's trash setting at the moment, and an admin can change that setting), or sooner if someone deletes " +
  "it permanently in the web app. In a group, bringing it back needs a role that can both edit and delete notes, and without that " +
  "list_trash won't show it either. You can move a personal note of your own, or a group note when your role can delete notes. " +
  "A note that is already in the trash answers not_found — use list_trash to check.";

export const deleteNoteInput = { note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes.") };

export const deleteNoteOutput = {
  id: z.string(),
  title: z.string().max(MCP_TEXT_MAX),
  titleTruncated: z.literal(true).optional(),
  purgeAt: z
    .string()
    .nullable()
    .describe(
      "When the note becomes due to be deleted permanently under the site's current trash setting (an admin can change it; " +
        "list_trash shows the current date for the notes you can restore); null when this site doesn't empty the trash on its own at the moment."
    ),
};

/** 所有 not_found 成因（不存在、看不到、已在垃圾桶、commit 後重讀落空）同一句。 */
export const DELETE_NOT_FOUND_MESSAGE =
  "No note with that id that you can see. For example, it may not exist, may not be shared with you, may belong to a group you " +
  "aren't in or whose notes your role can't see, or may already be in the trash (list_trash shows the ones you can restore).";
export const DELETE_FORBIDDEN_MESSAGE =
  "You can see this note but can't move it to the trash: only the owner of a personal note, or a group role that can delete notes, can do that.";
export const DELETE_BUSY_MESSAGE = "The server was busy, so the note was not moved to the trash. Try again in a moment.";

export async function deleteNoteTool(args: { note_id: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  const denied = requireDeleteScope(ctx);
  if (denied !== null) return denied;

  const access = await resolveNoteAccess(ctx.db, ctx.userId, args.note_id);
  if (access.role === "none") return toolError("not_found", DELETE_NOT_FOUND_MESSAGE);
  if (!access.permissions.delete) return toolError("forbidden", DELETE_FORBIDDEN_MESSAGE);

  // 存在性守衛：列不在是部署壞掉，丟給 runTool 收成 internal——在扣桶與移入之前，什麼都沒做、也不花 edit 額度。值本身不用
  // （回應的 purgeAt 取 commit 後那一刻的設定，見 loadTrashedMeta）。
  if ((await readTrashRetentionDays(ctx.db)) === undefined) throw new Error(SITE_SETTINGS_MISSING_MESSAGE);

  if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

  let out: TrashNoteOutcome;
  try {
    out = await trashNote(
      {
        db: ctx.db,
        collabHooks: ctx.collabHooks,
        uploadsDir: ctx.uploadsDir,
        storageLockTimeoutMs: ctx.storageLockTimeoutMs,
        groupTestHook: ctx.groupTestHook,
      },
      { noteId: args.note_id, by: ctx.userId },
    );
  } catch (err) {
    if (isRetryableTxError(err)) return toolError("server_busy", DELETE_BUSY_MESSAGE);
    throw err;
  }
  if (out === "not_found") return toolError("not_found", DELETE_NOT_FOUND_MESSAGE);
  if (out === "forbidden") return toolError("forbidden", DELETE_FORBIDDEN_MESSAGE);

  const id = args.note_id.toLowerCase();
  // 落空＝commit 之後、這一讀之前被還原或永久刪除（毫秒級窗），同 move_note_to_group 的重讀落空回 not_found。
  const meta = await loadTrashedMeta(ctx.db, id);
  if (meta === undefined) return toolError("not_found", DELETE_NOT_FOUND_MESSAGE);
  const title = truncateText(meta.title);
  return toolResult({
    id,
    title: title.text,
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    purgeAt: meta.purgeAt?.toISOString() ?? null,
  });
}
