/**
 * #334 最愛的查詢。
 *
 * 清單的可見性只經 `visibleNoteBranches`（`notes/list-query.ts`）：三支各帶「呼叫者有這篇的最愛紀錄」的 `exists`，
 * 本身已濾掉垃圾桶與讀不到的筆記。失去讀取權或進垃圾桶的紀錄不刪，只在這裡讀不出來；之後還原或重新拿到權限，
 * 會以原本的加入時間回到原位置。
 */
import { desc, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { FavoriteDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { noteFavorites, notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";

/**
 * 呼叫者此刻看得見、不在垃圾桶的最愛，依加入時間新到舊；同一毫秒加入的依 note id 由大到小，兩次讀取順序一致。
 *
 * 加入時間用相關純量子查詢取：`exists` 裡的別名 `f` 在外層拿不到。raw `sql` 選出來的時間戳要 `.mapWith`，
 * 否則拿到的是 pg 的原始字串，`toISOString()` 會 throw。三支的 select 每次呼叫現造（builder 只能用一次）。
 */
export async function listFavorites(db: DbOrTx, userId: string): Promise<FavoriteDto[]> {
  const favoritedAt = sql<Date>`(select f.created_at from ${noteFavorites} f where f.user_id = ${userId} and f.note_id = ${notes.id})`
    .mapWith(noteFavorites.createdAt)
    .as("favorited_at");
  const { owned, shared, grouped } = visibleNoteBranches(db, userId, {
    extraWhere: sql`exists (select 1 from ${noteFavorites} f where f.user_id = ${userId} and f.note_id = ${notes.id})`,
    extra: { favoritedAt },
  });
  // 集合運算的 ORDER BY 只收輸出欄名：`favorited_at` 是具名輸出欄，`notes.id` 在 union 上渲染成裸欄名 id。
  const rows = await unionAll(owned, shared, grouped).orderBy(desc(favoritedAt), desc(notes.id));
  return rows.map(row => ({ noteId: row.id, favoritedAt: row.favoritedAt.toISOString() }));
}
