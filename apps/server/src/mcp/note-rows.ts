/**
 * #180 Task 0：`create_note`／`copy_note`／`move_note_to_group` 共用的「回應列」組裝（原在 `tools/create-note.ts`，
 * spec §5.3「`create-note.ts:155-159` 那支 helper 抽到 `mcp/` 共用」）。兩支函式逐字搬家，行為不變。
 */
import { eq } from "drizzle-orm";
import { notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";
import type { SlugScope } from "../notes/slug.js";
import type { NoteSummaryRow } from "./dto.js";
import type { McpToolCtx } from "./context.js";

/**
 * insert 的 `returning()` 那一列 → `toNoteSummary` 收的形。`owner` 由呼叫端依 scope 給——個人＝呼叫者的
 * handle（建立者即 owner，同 REST 的 A12，不必補查 `users`）、群組＝群組名（`ownerHandle` 為 null）；**不得**再無條件填
 * `ctx.userHandle`（gate r1 I3：群組筆記會被組成 `/n/<me>/<slug>`）。`groupId` 取列本身。
 * `editorHandle` 恆為 `null`——這一列的 `last_edited_by` 若已落款，落款人也就是呼叫者本人，而
 * **只有重讀落空的競態**才會走到這裡。
 */
export function insertedRow(
  row: typeof notes.$inferSelect,
  owner: { ownerHandle: string | null; groupName: string | null }
): NoteSummaryRow {
  return {
    id: row.id,
    title: row.title,
    ownerHandle: owner.ownerHandle,
    groupId: row.groupId,
    groupName: owner.groupName,
    slug: row.slug,
    updatedAt: row.updatedAt,
    lastEditedAt: row.lastEditedAt,
    lastEditedAgentLabel: row.lastEditedAgentLabel,
    editorHandle: null,
    // 建立／複製者必是 owner 或群組成員，呼叫者視角＝列本身的 folder_id（plan 讀碼發現 6）。
    viewerFolderId: row.folderId,
  };
}

/**
 * 重讀那一列拿新鮮的落款（理由逐字在 `routes/notes.ts` 建立路徑的長註解裡：insert 的
 * `returning()` 是在合併**之前**取的，四欄還是 null，直接回它就是送出一個恆空的
 * `lastEdited` 假答案）。可見性走 `visibleNoteBranches` 依 scope 選的分支（個人＝owned、群組＝grouped）——
 * 與 `list_notes`／`search_notes` **同一份**可見性語意，不新增第二種查詢形狀。grouped 分支要求 `can_read`：
 * 建立者必在其中（「新建 ⇒ 閱讀」由 `group_roles_read_implied_chk` 保證）；grouped 的 `role` 欄是 SQL
 * `CASE WHEN can_edit THEN 'editor' ELSE 'viewer' END`，與 `roleFromGroupFlags` 同規則。
 * 落空＝回應組裝前這篇又被別的請求刪掉、或呼叫者剛被移出群組的競態；內容已經寫進去了，呼叫端退回 insert
 * 的那一列（與 REST 同一個判斷：回一個過期的 `lastEdited` 比讓外部 AI 重試建出第二篇有內容的筆記好）。
 * ⚠ `visibleNoteBranches` 每次現造、只 await 要的那一支（drizzle select builder 單次使用）。
 */
export async function rereadVisibleNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string,
  scope: SlugScope
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const branches = visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) });
  const [row] = await ("groupId" in scope ? branches.grouped : branches.owned);
  return row;
}

/**
 * #181 restore_note：還原者對個人筆記必是 owner、對群組筆記必有 can_edit（⇒ can_read），先 owned 支、落空再 grouped 支（各自現造）。
 * 兩支都只看活筆記；落空＝還原 commit 之後又被移入、永久刪除或降權的競態。
 */
export async function rereadOwnOrGroupNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const [owned] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).owned;
  if (owned) return owned;
  const [grouped] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).grouped;
  return grouped;
}

/**
 * 資料夾 PR-3d：move_note_to_folder 對共享筆記要讀 shared 支：owned → shared → grouped 依序各自現造（三支結構互斥，至多一支有列）。
 * 不新增查詢形，可見性與 list_notes 同一份。
 */
export async function rereadAnyVisibleNote(
  ctx: Pick<McpToolCtx, "db" | "userId">,
  noteId: string
): Promise<(NoteSummaryRow & { role: string }) | undefined> {
  const [owned] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).owned;
  if (owned) return owned;
  const [shared] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).shared;
  if (shared) return shared;
  const [grouped] = await visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) }).grouped;
  return grouped;
}
