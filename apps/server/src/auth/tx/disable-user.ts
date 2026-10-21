import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { LAST_SITE_ADMIN_MESSAGE } from "./admin-demote.js";
import { revokePendingPasswordResetsInTx } from "./password-reset.js";

/**
 * 停用帳號（`POST /api/admin/users/:id/disable`）＋ #286 同交易撤銷重設連結（spec §4.6）。
 *
 * tokenVersion 遞增交給 SQL 端做原子操作（同改密碼路徑），以 `disabled_at IS NULL` 為條件：已停用者重複呼叫時 0 列，
 * 藉此分辨「冪等」與「真的第一次停用」，不重複 bump tv。只 returning id——不讓 passwordHash／tokenVersion 進記憶體。
 * #250：先 `FOR NO KEY UPDATE` 鎖住全部啟用中的 admin 列（id 序，是 demote 鎖全部 admin 列的子集、同序，不成環；與 demote 同級，互斥），目標是其中唯一一位 → 409
 * `last_site_admin`（與 demote 同碼同訊息）。不用 `FOR UPDATE`：它會擋 FK 的 `KEY SHARE`（產生重設連結的 INSERT 帶 created_by_id），與連結交易成環 → 40P01；
 * 併發互停時後到者在鎖上排隊，前者 commit 後重評 `disabled_at IS NULL`，已被停用那列不再命中。
 * 鎖序（spec §3.5）：先是上述守衛的 users 列鎖，再 UPDATE 目標列，最後才動連結列。有命中才撤銷：停用後連結不會在重新啟用時復活。
 */
export async function disableUserInTx(
  tx: Tx,
  input: { id: string },
): Promise<{ disabled: false } | { disabled: true; revokedResetLinks: number }> {
  const enabledAdmins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)))
    .orderBy(asc(users.id))
    .for("no key update");
  if (enabledAdmins.length === 1 && enabledAdmins[0]!.id === input.id) {
    throw new TxAbort(409, "last_site_admin", LAST_SITE_ADMIN_MESSAGE);
  }
  const [updated] = await tx
    .update(users)
    .set({ disabledAt: sql`now()`, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, input.id), isNull(users.disabledAt)))
    .returning({ id: users.id });
  if (!updated) return { disabled: false };
  return { disabled: true, revokedResetLinks: await revokePendingPasswordResetsInTx(tx, input.id) };
}
