/**
 * #175 §4.3：轉址寫入（`recordRedirects`）。**只在交易內用**——移動（PR2）、轉移（PR4）在同一個交易裡改 slug 並寫轉址。
 * 本檔不 import `Db`、不接 `deps`（S14 結構性守衛掃 `tx/` 目錄）。
 * 先清掉所有已過期的列（懶惰清理 (b)），再 upsert：同鍵再寫入最新者勝（B3），`expires_at = now() + 1 month`（Q20）。
 */
import { sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteRedirects } from "../../db/schema.js";

export async function recordRedirectsInTx(tx: Tx, paths: readonly string[], noteId: string): Promise<void> {
  await tx.delete(noteRedirects).where(sql`${noteRedirects.expiresAt} <= now()`);
  if (paths.length === 0) return;
  await tx
    .insert(noteRedirects)
    .values(paths.map(oldPath => ({ oldPath, noteId, expiresAt: sql`now() + interval '1 month'` })))
    .onConflictDoUpdate({
      target: noteRedirects.oldPath,
      set: { noteId, expiresAt: sql`now() + interval '1 month'`, createdAt: sql`now()` },
    });
}
