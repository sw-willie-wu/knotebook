/**
 * #175 §4.3／§6.4：轉址表的**讀取**側（寫入一律經 `notes/tx/redirects.ts`，只在交易內）。
 * 鍵＝已正規化的完整路徑：handle 已 `normalizeHandle`、slug 已 `normalizeSlug`；群組 id 一律小寫
 * （RF1——uuid 欄的精確比對不分大小寫，這裡的字串比對分）。
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { noteRedirects } from "../db/schema.js";

export function userNotePath(handle: string, slug: string): string {
  return `/n/${handle}/${slug}`;
}

export function groupNotePath(groupId: string, slug: string): string {
  return `/g/${groupId.toLowerCase()}/${slug}`;
}

/**
 * §4.3 查找：述詞**不含** `expires_at`（gate r1 N1）；命中但已過期 → 同一個請求刪掉那一列（懶惰清理 (a)）、當 miss。
 * 刪除帶 `expires_at <= now()` 述詞：同一刻被別的交易 upsert 續命（PR2 的移動）的列不會被誤刪。過期判斷用 DB 的
 * `now()`——與寫入 `now() + interval '1 month'` 同一個時鐘。只把路徑解成 id，**不越過授權**（§5.4）。
 */
export async function lookupRedirect(db: DbOrTx, oldPath: string): Promise<string | null> {
  const [row] = await db
    .select({ noteId: noteRedirects.noteId, live: sql<boolean>`${noteRedirects.expiresAt} > now()` })
    .from(noteRedirects)
    .where(eq(noteRedirects.oldPath, oldPath))
    .limit(1);
  if (!row) return null;
  if (row.live) return row.noteId;
  await db.delete(noteRedirects).where(and(eq(noteRedirects.oldPath, oldPath), sql`${noteRedirects.expiresAt} <= now()`));
  return null;
}
