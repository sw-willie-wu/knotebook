import { and, eq } from "drizzle-orm";
import type { Role } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteShares, notes } from "../db/schema.js";

// pg 的 uuid 欄位對「格式不合法的字串」（例如 "not-a-uuid"）會直接 throw
// `invalid input syntax for type uuid`，若讓它一路冒到 app.ts 的全域錯誤 handler，
// 會被歸類成 >=500 內部錯誤（Task 5 備忘：`:id` 這種路徑參數不可信任其格式）。
// 在查 DB 之前先用 regex 擋掉非法格式，直接回 'none'——效果上與「這個 id 找不到
// 對應的 note」一致，也不會洩漏任何額外資訊。
//
// 匯出供 routes/notes.ts 的 DELETE /api/notes/:id/shares/:userId 重用同一套 guard——
// `:userId` 路徑參數同樣不可信任其格式，且需要在觸碰 DB 之前擋掉非法 UUID（否則會
// 遇到同一個 "invalid input syntax for type uuid" 500 問題）。
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `resolveAccess` 的結果：角色，外加「這篇筆記到底還在不在」。
 *
 * 兩者分開回報是為了 issue #35：`role === 'none'` 混了「你沒有權限」與「筆記已經被刪掉
 * 了」兩件事，共編握手若只看 role，對後者會告訴使用者「你已失去存取權」——說錯話。
 * 只有共編的 `onAuthenticate` 需要分辨，其餘呼叫端照舊用 `resolveRole`。
 */
export interface NoteAccess {
  role: Role;
  /** noteId 格式非法一律視同不存在（效果與「查不到這一列」相同，也不洩漏額外資訊）。 */
  noteExists: boolean;
}

/**
 * 解析使用者對某篇 note 的角色與該筆記的存在性：note 不存在（或 noteId 非合法 UUID
 * 格式）→ `{ role: 'none', noteExists: false }`；使用者是 owner → 'owner'；否則查
 * note_shares 表的 role（'editor'/'viewer'）；都沒有 → 'none'。
 */
export async function resolveAccess(db: Db, userId: string, noteId: string): Promise<NoteAccess> {
  if (!UUID_RE.test(noteId)) return { role: "none", noteExists: false };

  const [note] = await db.select({ ownerId: notes.ownerId }).from(notes).where(eq(notes.id, noteId)).limit(1);
  if (!note) return { role: "none", noteExists: false };
  if (note.ownerId === userId) return { role: "owner", noteExists: true };

  const [share] = await db
    .select({ role: noteShares.role })
    .from(noteShares)
    .where(and(eq(noteShares.noteId, noteId), eq(noteShares.userId, userId)))
    .limit(1);
  if (!share) return { role: "none", noteExists: true };
  return { role: share.role as Role, noteExists: true };
}

/**
 * 解析使用者對某篇 note 的角色：note 不存在（或 noteId 非合法 UUID 格式）→ 'none'；
 * 使用者是 owner → 'owner'；否則查 note_shares 表的 role（'editor'/'viewer'）；
 * 都沒有 → 'none'。
 */
export async function resolveRole(db: Db, userId: string, noteId: string): Promise<Role> {
  const { role } = await resolveAccess(db, userId, noteId);
  return role;
}
