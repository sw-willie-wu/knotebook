import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { oneTimeLinks, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { pendingPasswordResetsOf } from "../one-time-link.js";

/**
 * #286 重設密碼連結的交易本體（spec §4.2）。
 *
 * ⚠ 鎖序（spec §3.5）：一律先鎖 `users` 列（`FOR NO KEY UPDATE`），再動連結列——產生、取消、完成、停用
 * （`disable-user.ts`）四條路徑同序，不會 40P01。`NO KEY UPDATE` 彼此互斥、也與停用的 UPDATE 互斥，但不擋 FK 的
 * `KEY SHARE`（該使用者同時建筆記之類的交易不必排隊）。
 */

/** 把某人所有「未用、未撤銷」的重設連結標為撤銷（含已過期者，spec §4.2 N-3）。回撤銷的列數。呼叫端須已鎖 `users` 列。 */
export async function revokePendingPasswordResetsInTx(tx: Tx, targetUserId: string): Promise<number> {
  const rows = await tx
    .update(oneTimeLinks)
    .set({ revokedAt: sql`now()` })
    .where(pendingPasswordResetsOf(targetUserId))
    .returning({ id: oneTimeLinks.id });
  return rows.length;
}

async function lockTargetUser(tx: Tx, targetUserId: string): Promise<{ disabledAt: Date | null; hasPassword: boolean }> {
  const [row] = await tx
    .select({ disabledAt: users.disabledAt, hasPassword: sql<boolean>`${users.passwordHash} is not null` })
    .from(users)
    .where(eq(users.id, targetUserId))
    .for("no key update");
  if (!row) throw new TxAbort(404, "user_not_found", "找不到此使用者");
  return row;
}

/** 產生：鎖 `users` → 停用 409 → 沒有密碼 409 → 撤掉前一支（`replaced`）→ INSERT。 */
export async function issuePasswordResetInTx(
  tx: Tx,
  input: { targetUserId: string; createdById: string; tokenHash: string; expiresInHours: number },
): Promise<{ linkId: string; expiresAt: Date; replaced: number }> {
  const target = await lockTargetUser(tx, input.targetUserId);
  if (target.disabledAt !== null) throw new TxAbort(409, "user_disabled", "這個帳號已停用");
  if (!target.hasPassword) throw new TxAbort(409, "password_not_set", "這個帳號沒有密碼");
  const replaced = await revokePendingPasswordResetsInTx(tx, input.targetUserId);
  const [row] = await tx
    .insert(oneTimeLinks)
    .values({
      kind: "password_reset",
      tokenHash: input.tokenHash,
      targetUserId: input.targetUserId,
      createdById: input.createdById,
      expiresAt: sql`now() + make_interval(hours => ${input.expiresInHours}::int)`,
    })
    .returning({ id: oneTimeLinks.id, expiresAt: oneTimeLinks.expiresAt });
  return { linkId: row!.id, expiresAt: row!.expiresAt, replaced };
}

/** 取消：鎖 `users`（查無 404）→ 撤銷。不看帳密開關、不看停用（spec §4.2）。 */
export async function cancelPasswordResetsInTx(tx: Tx, input: { targetUserId: string }): Promise<{ revoked: number }> {
  await lockTargetUser(tx, input.targetUserId);
  return { revoked: await revokePendingPasswordResetsInTx(tx, input.targetUserId) };
}
