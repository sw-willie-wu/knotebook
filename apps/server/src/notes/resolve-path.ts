/**
 * #175 §6.4 的路徑查找序，自 `routes/notes.ts` 的 `resolvePath` 閉包抽出（#269 §6.6：轉換工作要用同一份查找，不得抄第二份）。
 * ① 現行 slug → ② 轉址表（過期 → 刪列、當 miss）→ ③ prev_slug（limit 2；0 或 >1 → miss）。**只解路徑、不授權**（§5.4）。
 * `source` 決定取哪些欄位：routes 要完整列（by-path 首查即整列），轉換工作只要 `{ id, title, groupId }`。
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { notes } from "../db/schema.js";
import { lookupRedirect } from "./redirects.js";

export interface PathRowSource<Row> {
  /**
   * 以 `cond` 取列，最多 `limit` 列（每次呼叫現造 builder——drizzle builder 單次使用）。
   * `cond` 含呼叫端的 `scopeCond`：`/n/` 形是 `eq(users.handle, handle)`，所以任何實作的 FROM 都必須
   * JOIN `users ON users.id = notes.owner_id`（只取 `{ id, title, groupId }` 也一樣）。
   */
  where(cond: SQL, limit: number): PromiseLike<Row[]>;
  byId(noteId: string): PromiseLike<Row | undefined>;
}

export async function resolveNotePath<Row>(db: DbOrTx, source: PathRowSource<Row>, scopeCond: SQL, slug: string, redirectKey: string): Promise<Row | undefined> {
  const [hit] = await source.where(and(scopeCond, eq(notes.slug, slug))!, 1);
  if (hit) return hit;
  const redirected = await lookupRedirect(db, redirectKey);
  if (redirected !== null) return source.byId(redirected);
  const prevHits = await source.where(and(scopeCond, eq(notes.prevSlug, slug))!, 2);
  return prevHits.length === 1 ? prevHits[0] : undefined;
}
