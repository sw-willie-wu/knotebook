import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";

/**
 * #247 §9.5：記一次登入（`UPDATE users SET last_login_at = now()`）。在每個「新簽一張登入 session」的地方、`signSession` 之前呼叫：
 * 帳密登入、OIDC 登入與首登建帳、SSO 證明連結、密碼證明連結、註冊。改密碼／加上密碼後的重簽是同一次登入換 token，不呼叫；
 * 已登入時連結第二個身分不簽 session，也不呼叫。
 * 交易外的獨立單句（OIDC 登入交易刻意不寫 users，C24）。可能短暫等待他交易的 `users` 列鎖（例如 SSO 證明交易 A2），本身不持其他鎖、無循環等待，登入只會晚到對方 commit（C24 測試守）。顯示用欄位：失敗只記 warn、照常完成登入——
 * 這裡自己吞錯，因為 OIDC callback 的外層 catch 會把任何例外變成 `oidc_exchange_failed`。
 * `last_login_at` 不在 `UserDto` 裡，gate 快取不含它，不需 invalidate。
 */
export async function touchLastLogin(db: Db, userId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, userId));
  } catch (err) {
    log.warn({ err, userId }, "last_login_at 寫入失敗（不影響登入）");
  }
}
