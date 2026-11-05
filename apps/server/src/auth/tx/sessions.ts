import { eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { sessions } from "../../db/schema.js";
import { SESSION_TTL_SECONDS } from "../session.js";

/**
 * #388 `sessions` 列的交易本體（說明見 `auth/sessions.ts`）。鎖序：呼叫端已先動 `users` 列（UPDATE／`FOR NO KEY UPDATE`），
 * 最後才動 session 列——改密碼與加上密碼（`change-password.ts`，與 bump tv 同一個交易）、重設密碼（`password-reset.ts`）、
 * 停用（`disable-user.ts`）同序。
 */

/** 新的一列：`expires_at` 與 session JWT 的 `exp` 同一個 TTL（`SESSION_TTL_SECONDS`）。非交易的 `insertSession` 也用這支。 */
export function newSessionValues(userId: string): { userId: string; expiresAt: Date } {
  return { userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) };
}

/** 刪光這個使用者的 session 列、為本機建新的一列，回新的 `sid`（改密碼、加上密碼、以重設連結設新密碼）。 */
export async function replaceUserSessionsInTx(tx: Tx, userId: string): Promise<string> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  const [row] = await tx.insert(sessions).values(newSessionValues(userId)).returning({ id: sessions.id });
  return row!.id;
}

/** 停用帳號：刪光這個使用者的 session 列。 */
export async function deleteUserSessionsInTx(tx: Tx, userId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}
