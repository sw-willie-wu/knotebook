import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { oneTimeLinks, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { activeOneTimeLink, pendingPasswordResetsOf } from "../one-time-link.js";

/** 410 `reset_link_invalid` 的訊息：無登入端點與完成交易共用，不區分原因（spec §4.3）。 */
export const RESET_LINK_INVALID_MESSAGE = "重設密碼連結無效、已使用或已過期";

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

/**
 * 完成（spec §4.3 第 6 步）：鎖 `users` → 連結列 `FOR UPDATE` 重判有效且屬於此人 → 防禦性看停用 → 寫新密碼、
 * `token_version + 1`、清 `must_change_password` → 標 `used_at`。三種拒絕都是 410（都只在並發下可達）。
 * 只動 `users` 與 `one_time_links`（I4）：PAT、OAuth、transfer token 一律不碰（spec §4.4）。
 */
export async function completePasswordResetInTx(
  tx: Tx,
  input: { linkId: string; targetUserId: string; passwordHash: string },
) {
  const [target] = await tx
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .for("no key update");
  if (!target) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  const [link] = await tx
    .select({ targetUserId: oneTimeLinks.targetUserId })
    .from(oneTimeLinks)
    .where(and(eq(oneTimeLinks.id, input.linkId), activeOneTimeLink("password_reset")))
    .for("update");
  if (!link || link.targetUserId !== input.targetUserId) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  if (target.disabledAt !== null) throw new TxAbort(410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
  const [updated] = await tx
    .update(users)
    .set({ passwordHash: input.passwordHash, tokenVersion: sql`${users.tokenVersion} + 1`, mustChangePassword: false })
    .where(eq(users.id, input.targetUserId))
    .returning({
      id: users.id,
      email: users.email,
      handle: users.handle,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword,
      autoVersions: users.autoVersions,
      tokenVersion: users.tokenVersion,
    });
  await tx.update(oneTimeLinks).set({ usedAt: sql`now()` }).where(eq(oneTimeLinks.id, input.linkId));
  return updated!;
}
