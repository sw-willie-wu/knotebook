import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { replaceUserSessionsInTx } from "./sessions.js";

/**
 * #388：本人改密碼（`POST /api/auth/password`）與加上密碼（`POST /api/auth/password/set`）的交易本體——bump tv 與換 session 列
 * （刪光、為本機建新的一列）在**同一個交易**。
 *
 * 為什麼要同交易：UPDATE 拿到的 users 列鎖一路握到 commit，同一個帳號兩發並發的改密碼因此整段串行——後到那發等前一發 commit
 * 後才 bump、才換列，最後留下的是後寫那台的列與 tv，後寫那台保持登入。分開兩步的話，「A bump、B bump、B 換列、A 換列」這個交錯
 * 會刪掉 B 剛拿到的列，而 A 的 JWT 又帶著已被 B 蓋過的 tv，兩台都被登出。
 * 鎖序：先 users 列（UPDATE），再 session 列——與重設密碼（`password-reset.ts`）、停用（`disable-user.ts`）同序。
 *
 * tokenVersion 在 SQL 端 +1（不是應用層快照 +1，理由見 `routes/auth.ts`）；回傳 DB 算出的真值。
 */
export async function changePasswordInTx(tx: Tx, input: { userId: string; passwordHash: string }): Promise<{ tokenVersion: number; sessionId: string } | null> {
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1`, mustChangePassword: false })
    .where(eq(users.id, input.userId))
    .returning({ tokenVersion: users.tokenVersion });
  if (!updated) return null; // 帳號在請求途中被刪
  return { tokenVersion: updated.tokenVersion, sessionId: await replaceUserSessionsInTx(tx, input.userId) };
}

/** 加上密碼：只在還沒有密碼時命中（C14：雙送出第二次 0 列 → null → 409）；命中才換 session 列。 */
export async function setPasswordInTx(tx: Tx, input: { userId: string; passwordHash: string }): Promise<{ tokenVersion: number; sessionId: string } | null> {
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, input.userId), isNull(users.passwordHash)))
    .returning({ tokenVersion: users.tokenVersion });
  if (!updated) return null;
  return { tokenVersion: updated.tokenVersion, sessionId: await replaceUserSessionsInTx(tx, input.userId) };
}
