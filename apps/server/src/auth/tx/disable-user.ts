import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { users } from "../../db/schema.js";
import { revokePendingPasswordResetsInTx } from "./password-reset.js";

/**
 * 停用帳號（`POST /api/admin/users/:id/disable`）＋ #286 同交易撤銷重設連結（spec §4.6）。
 *
 * tokenVersion 遞增交給 SQL 端做原子操作（同改密碼路徑），以 `disabled_at IS NULL` 為條件：已停用者重複呼叫時 0 列，
 * 藉此分辨「冪等」與「真的第一次停用」，不重複 bump tv。只 returning id——不讓 passwordHash／tokenVersion 進記憶體。
 * 鎖序（spec §3.5）：UPDATE 本身先取 `users` 列鎖，再動連結列。有命中才撤銷：停用後連結不會在重新啟用時復活。
 */
export async function disableUserInTx(
  tx: Tx,
  input: { id: string },
): Promise<{ disabled: false } | { disabled: true; revokedResetLinks: number }> {
  const [updated] = await tx
    .update(users)
    .set({ disabledAt: sql`now()`, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(and(eq(users.id, input.id), isNull(users.disabledAt)))
    .returning({ id: users.id });
  if (!updated) return { disabled: false };
  return { disabled: true, revokedResetLinks: await revokePendingPasswordResetsInTx(tx, input.id) };
}
