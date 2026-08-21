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
 * 刪除某篇筆記**當下**看得到它的所有 userId（owner ＋ 每一筆分享）。
 *
 * 只有共編的刪除閘門用它（`CollabServer` 的 `markDeleting`／`releaseDeletingGate`）：閘門要能
 * 對「本來就看得到這篇筆記的人」說「它被刪掉了」，又不能對其他人透露這個 id 曾經存在——
 * 所以必須在刪除交易**之前**、那些列還在的時候，把名單抓下來留著（見 `collab/server.ts` 的
 * `deleting`）。筆記不存在（或 id 格式非法）時回空集合，`releaseDeletingGate` 也拿這一點
 * 當「筆記到底還在不在」的判準。
 */
export async function loadNoteAudience(db: Db, noteId: string): Promise<Set<string>> {
  if (!UUID_RE.test(noteId)) return new Set();

  const [note] = await db.select({ ownerId: notes.ownerId }).from(notes).where(eq(notes.id, noteId)).limit(1);
  if (!note) return new Set();

  const shares = await db
    .select({ userId: noteShares.userId })
    .from(noteShares)
    .where(eq(noteShares.noteId, noteId));
  return new Set([note.ownerId, ...shares.map(one => one.userId)]);
}

/**
 * 解析使用者對某篇 note 的角色：note 不存在（或 noteId 非合法 UUID 格式）→ 'none'；
 * 使用者是 owner → 'owner'；否則查 note_shares 表的 role（'editor'/'viewer'）；
 * 都沒有 → 'none'。
 */
export async function resolveRole(db: Db, userId: string, noteId: string): Promise<Role> {
  if (!UUID_RE.test(noteId)) return "none";

  const [note] = await db.select({ ownerId: notes.ownerId }).from(notes).where(eq(notes.id, noteId)).limit(1);
  if (!note) return "none";
  if (note.ownerId === userId) return "owner";

  const [share] = await db
    .select({ role: noteShares.role })
    .from(noteShares)
    .where(and(eq(noteShares.noteId, noteId), eq(noteShares.userId, userId)))
    .limit(1);
  if (!share) return "none";
  return share.role as Role;
}
