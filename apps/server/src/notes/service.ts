import { and, eq } from "drizzle-orm";
import type { Role } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteShares, notes } from "../db/schema.js";

// pg 的 uuid 欄位對「格式不合法的字串」（例如 "not-a-uuid"）會直接 throw
// `invalid input syntax for type uuid`，若讓它一路冒到 app.ts 的全域錯誤 handler，
// 會被歸類成 >=500 內部錯誤（Task 5 備忘：`:id` 這種路徑參數不可信任其格式）。
// 在查 DB 之前先用 regex 擋掉非法格式，直接回 'none'——效果上與「這個 id 找不到
// 對應的 note」一致，也不會洩漏任何額外資訊。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
