/**
 * #180 spec §6：`copy_note(note_id, group_id?)`。行為照 REST `POST /api/notes/:id/copy`（共用 `notes/copy-note.ts`）。
 * 在 `register.ts` 的 collab 閘門**外**（REST 複製無條件註冊；`loadNoteDoc` 無 collab 時讀 `note_states`，F35），以 `.strict()` 註冊。
 * 三本節流帳（§6.4）：`tokenWrite`（token 才有，`requireWriteScope`；帶 `group_id` 時改 `requireMoveScope`，#239）→ `edit`（共用函式內）→ `upload`（依附件數，共用函式內）。
 * 配額可見性：`canViewSpaceUsage`；`isAdmin` 照 `create-transfer-token.ts` 的作法只在被拒這一刻讀一次（ctx 沒有它）。
 */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatBytes } from "@knotebook/shared";
import { users } from "../../db/schema.js";
import { UPLOAD_LIMIT } from "../../http/rate-limit.js";
import { resolveFolderAccess } from "../../folders/queries.js";
import { newNoteFolderConsistent } from "../../folders/space.js";
import { copyNote } from "../../notes/copy-note.js";
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
  "title and its current content, and usually its own copies of the images uploaded to that note; from then on the two notes change " +
  "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
  "note's history. The reply is the new note in the shape list_notes returns; in a group, its `role` can be `viewer`.";

export const COPY_GROUP_ID_DESCRIBE =
  "The id of one of your groups where your role lets you create notes; the copy then belongs to the group. Leave it out to copy " +
  "into your personal notes. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";

/** CP-F（資料夾 PR-3d，逐字照 plan「待確認字串」）：讀寫搬移與 session 的版本。 */
export const COPY_FOLDER_ID_DESCRIBE =
  "The id of a folder to put the copy in, from list_folders; leave it out for the top level. One of your personal folders for a copy " +
  "of your own (leave out `group_id`), or one of the folders of the group you pass as `group_id`, where your role must also be able to edit notes.";
/** CP-F0：讀寫無搬移憑證的版本（spec M11 末句：不提群組資料夾）。 */
export const COPY_FOLDER_ID_DESCRIBE_NO_MOVE =
  "The id of one of your personal folders to put the copy in, from list_folders; leave it out for the top level of your personal notes.";

export const copyNoteInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  group_id: GROUP_ID.optional().describe(COPY_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(COPY_FOLDER_ID_DESCRIBE),
};

/**
 * #239 spec §7.5(b)，474 字元：讀寫無搬移憑證（`!canMoveNotes`）的版本，`register.ts` 依 `canMove` 二選一。
 * 與 COPY_NOTE_DESCRIPTION 只差首句與句尾 role 那句。不寫「this credential doesn't have it」：使用者事後升權、
 * client 未重開時快取的仍是這一版，那句會變假；本句任何時候都真。
 */
export const COPY_NOTE_DESCRIPTION_NO_MOVE =
  "Copy a note you can read into a new note of your own; copying into a group needs the notes:move scope (see `group_id`). The copy gets the note's " +
  "title and its current content, and usually its own copies of the images uploaded to that note; from then on the two notes change " +
  "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
  "note's history. The reply is the new note in the shape list_notes returns.";

/** spec §7.5(c)，199 字元。不寫「this credential doesn't have it」：升權未重開時快取的仍是這版（理由同上）。 */
export const COPY_GROUP_ID_DESCRIBE_NO_MOVE =
  "Copying into a group needs a credential with the notes:move scope. Leave this out to copy into your personal notes. " +
  "A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";

/** #239：讀寫無搬移憑證的 input 形——只換 `group_id`（與資料夾 PR-3d 的 `folder_id`）的說明，型別與 `copyNoteInput` 相同。 */
export const copyNoteInputNoMove = {
  ...copyNoteInput,
  group_id: GROUP_ID.optional().describe(COPY_GROUP_ID_DESCRIBE_NO_MOVE),
  folder_id: FOLDER_ID.optional().describe(COPY_FOLDER_ID_DESCRIBE_NO_MOVE),
};

/**
 * spec §7.5(d)，#247 §12 改寫後 319 字元（原 331）。HTTP 上可達（讀寫憑證的清單上有 copy_note，帶 group_id 呼叫）；守衛＝`test/mcp-copy.test.ts` 的 #239 M3。
 * 處置＝在「設定 → 授權」的 token 列上以鉛筆開啟搬移權。結尾是「then try again」不是「reconnect」：copy_note 已在清單上、
 * scope 每請求重讀（`requireMoveScope`），開啟後下一發帶 group_id 就會過，不必重連。
 */
export const COPY_NEEDS_MOVE_MESSAGE =
  "Copying a note into a group needs the notes:move scope, and this credential doesn't have it, so nothing was copied. " +
  'Leave out group_id to copy into your personal notes, or ask the user to turn on "Move or copy notes into groups" for this ' +
  "credential via the pencil on its row in Settings → Authorization, then try again.";
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
  folder_id?: string;
}

export async function copyNoteTool(args: CopyNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // 資料夾 PR-3d（spec M11，plan 讀碼發現 7）：帶 folder_id 時，交易外先判資料夾可見性與空間一致性（純讀、不扣任何桶），
  // 排在下面的 scope 檢查**之前**，也在查筆記（copyNote 的 resolveNoteAccess）**之前**——看不到的群組資料夾對讀寫無搬移憑證回
  // not_found＋FM1，不是 insufficient_scope；看不到的筆記＋看不到的資料夾回的是資料夾句。所以帶 folder_id 時的錯誤優先序與 REST
  // `POST /api/notes/:id/copy` 不同（REST 先判筆記、再判資料夾，且沒有 scope 檢查）。copyNote 內部照 PR-3a 順序重判一次。
  if (args.folder_id !== undefined) {
    const folder = await resolveFolderAccess(ctx.db, ctx.userId, args.folder_id);
    if (folder === null) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!newNoteFolderConsistent(folder.space, args.group_id)) return toolError("invalid_body", NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE);
  }
  // #239：帶 group_id ＝複製進群組，要 notes:move；檢查在 copyNote 之前（不建任何東西、不扣任何桶），
  // 也在查筆記之前（不存在的 note_id 同樣先回 insufficient_scope，不成存在性 oracle）。
  const denied = args.group_id === undefined ? requireWriteScope(ctx) : requireMoveScope(ctx, COPY_NEEDS_MOVE_MESSAGE);
  if (denied !== null) return denied;
  const out = await copyNote(
    {
      db: ctx.db, collab: ctx.collab, log: ctx.log, uploadsDir: ctx.uploadsDir, storageLockTimeoutMs: ctx.storageLockTimeoutMs,
      limiters: { edit: ctx.limiters.edit, upload: ctx.limiters.upload },
      groupTestHook: ctx.groupTestHook, noteCreateHooks: ctx.noteCreateHooks, searchIndexHooks: ctx.searchIndexHooks,
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
      return toolError("too_many_requests", COPY_UPLOAD_LIMIT_MESSAGE);
    case "space_full":
      return quotaError(ctx, out.space, out.usage.usedBytes, out.usage.quotaBytes, null);
    case "aborted": {
      const err = out.err;
      if (err instanceof StorageQuotaExceeded) return quotaError(ctx, err.space, err.usedBytes, err.quotaBytes, err.incomingBytes);
      if (err.errCode === "not_found") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
      if (err.errCode === "group_not_found") return toolError("group_not_found", GROUP_NO_CREATE_MESSAGE);
      // 資料夾 PR-3a 起 copyNote 另以 aborted 回三碼（交易外預判與 `notes/tx/copy.ts` 的重判；plan 讀碼發現 10）。
      if (err.errCode === "folder_not_found") return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
      if (err.errCode === "folder_cross_space") return toolError("invalid_body", NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE);
      if (err.errCode === "forbidden") return toolError("forbidden", FOLDER_NEEDS_EDIT_MESSAGE);
      throw err; // 未列的碼是接線錯，交給 runTool 的 internal。
    }
    case "busy":
      return toolError("server_busy", COPY_BUSY_MESSAGE);
    case "copied": {
      const personal = out.target === null;
      const row = insertedRow(out.note, { ownerHandle: personal ? ctx.userHandle : null, groupName: out.target?.name ?? null });
      const [note] = await noteSummariesForModel(ctx.db, [{ ...row, role: out.target === null ? "owner" : roleFromGroupFlags(out.target) }]);
      return toolResult({ note });
    }
  }
}
