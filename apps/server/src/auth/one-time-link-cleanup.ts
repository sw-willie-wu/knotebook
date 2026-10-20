import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { oneTimeLinks } from "../db/schema.js";

/**
 * #286 spec §3.7：已結束（用掉、撤銷或過期）超過 30 天的一次性連結的清理。**沒有排程**，比照
 * `auth/transfer-cleanup.ts` 的機會性執行：呼叫點是產生連結成功後的 fire-and-forget（失敗只 `log.warn`）。
 *
 * - 30 天：重設本身用不到歷史紀錄，但先定成之後邀請列表也合用的值，日後免改。
 * - 結束時間＝`coalesce(used_at, revoked_at, expires_at)`：用掉或撤銷的列以那個時間起算，而不是到期時間。
 * - ⚠ `for update skip locked` 承重：完成、取消、停用、刪使用者的 cascade 都可能正鎖著同一列；跳過已被鎖的列就沒有
 *   等待、沒有循環。守衛＝`test/one-time-link-cleanup.test.ts` 的 skip locked 案。
 */
export async function deleteEndedOneTimeLinks(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${oneTimeLinks} where ${oneTimeLinks.id} in (select ${oneTimeLinks.id} from ${oneTimeLinks} where coalesce(${oneTimeLinks.usedAt}, ${oneTimeLinks.revokedAt}, ${oneTimeLinks.expiresAt}) < now() - interval '30 days' for update skip locked)`
  );
}
