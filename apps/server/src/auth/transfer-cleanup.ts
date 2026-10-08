import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";

/**
 * #200 spec §4.6：過期 transfer token 的清理。**沒有排程**，比照 `oauth/cleanup.ts` 的機會性執行：唯一呼叫點是
 * `create_transfer_token` 簽發成功、交易提交後的 fire-and-forget（失敗只 `log.warn`）。
 *
 * ⚠ `for update skip locked` 承重：撤銷母憑證、OAuth 清理、刪筆記的 cascade 以 parent／note 索引的順序刪同一批過期列，
 * 與這裡以 `expires_at` 順序取鎖相反，可能 40P01 並讓使用者面那一方被選為犧牲者。跳過已被鎖的列就沒有等待、沒有循環；
 * 被跳過的列正在被 cascade 刪掉。守衛＝`transfer-token-issue.test.ts` 的 skip locked 案（拿掉 → 清理卡在別人的鎖上）。
 */
export async function deleteExpiredTransferTokens(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${transferTokens} where ${transferTokens.id} in (select ${transferTokens.id} from ${transferTokens} where ${transferTokens.expiresAt} < now() for update skip locked)`
  );
}
