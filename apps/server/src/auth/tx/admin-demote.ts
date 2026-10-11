import { asc, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import type { AdminTestHook } from "../admin-test-hook.js";

export const LAST_SITE_ADMIN_MESSAGE = "站台至少要保留一位啟用中的管理員";

/**
 * #247 §9.4：把站台管理員降為一般使用者。自降由路由先擋（400，不進交易）。
 * ① `FOR UPDATE` 鎖住**全部** admin 列（id 序，選出 `disabled_at` 供計數）——併發互降時後到的交易在這裡排隊，前者 commit 後
 *   PostgreSQL（READ COMMITTED）對被改過的列重評 `WHERE is_admin`，已被降級的那列不再命中，後者計數得 0 → 409。
 * ② 目標不在鎖到的列裡：不存在 → 404；存在但已非 admin → 冪等返回（同 promote 不檢查現值）。
 * ③ 「目標以外、啟用中（`disabled_at IS NULL`）的 admin」為 0 → 409 `last_site_admin`。
 * ⚠ 接受的缺口：`disable` 端點不拿這把鎖、也不守「最後一位啟用中的 admin」，所以這個不變量只在 demote 內成立（spec §9.4）。
 */
export async function demoteSiteAdminInTx(tx: Tx, input: { targetId: string }, hook?: AdminTestHook): Promise<void> {
  const admins = await tx
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .for("update");
  if (!admins.some(a => a.id === input.targetId)) {
    const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.targetId)).limit(1);
    if (exists === undefined) throw new TxAbort(404, "user_not_found", "找不到此使用者");
    return;
  }
  const othersEnabled = admins.filter(a => a.id !== input.targetId && a.disabledAt === null).length;
  await hook?.("demote-locked", { targetId: input.targetId });
  if (othersEnabled === 0) throw new TxAbort(409, "last_site_admin", LAST_SITE_ADMIN_MESSAGE);
  await tx.update(users).set({ isAdmin: false }).where(eq(users.id, input.targetId));
}
