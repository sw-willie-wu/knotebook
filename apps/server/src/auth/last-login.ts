import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/index.js";

/**
 * #247 §9.5：記一次登入（`users.last_login_at = now()`）。在每個「新簽一張登入 session」的地方、`signSession` 之前呼叫：
 * 帳密登入、OIDC 登入與首登建帳、SSO 證明連結、密碼證明連結、註冊、以重設連結設定新密碼（#286）。改密碼／加上密碼後的重簽是同一次登入換 token，不呼叫；
 * 已登入時連結第二個身分不簽 session，也不呼叫。
 * 交易外的獨立單句（OIDC 登入交易刻意不寫 users，C24）。**永不等鎖的 best-effort**：子查詢 `FOR NO KEY UPDATE SKIP LOCKED`
 * 取列，別的交易正持有該 users 列的 NO KEY UPDATE 以上的鎖（例如解除身分 P2、SSO 證明 A2）時整句 0 列、只記 warn——
 * 「SSO 登入不等 users」（C24，`identities.test.ts`、`oidc-prove.test.ts` 守）優先於記錄；代價是併發下偶爾漏記這一次登入。
 * 顯示用欄位：失敗也只記 warn、照常完成登入——這裡自己吞錯，因為 OIDC callback 的外層 catch 會把任何例外變成 `oidc_exchange_failed`。
 * `last_login_at` 不在 `UserDto` 裡，gate 快取不含它，不需 invalidate。
 * #267：同一句也寫 `last_active_at = now()`（登入就是一次活動；不經 `LastActiveTracker` 的節流），同樣不在 `UserDto` 裡。
 */
export async function touchLastLogin(db: Db, userId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const res = await db.execute(
      sql`update users set last_login_at = now(), last_active_at = now() where id = (select id from users where id = ${userId} for no key update skip locked)`,
    );
    if (res.rowCount === 0) log.warn({ userId }, "last_login_at skipped: row locked");
  } catch (err) {
    log.warn({ err, userId }, "last_login_at 寫入失敗（不影響登入）");
  }
}
