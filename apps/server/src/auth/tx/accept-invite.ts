import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { oneTimeLinks } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { activeOneTimeLink } from "../one-time-link.js";
import { insertPasswordUserInTx, type PasswordUserInput, type RegisteredUser } from "./register.js";

/** 410 `invite_invalid` 的訊息：無登入端點與兌換交易共用，不區分原因（#285 spec §5.3）。 */
export const INVITE_INVALID_MESSAGE = "邀請無效、已使用、已撤銷或已過期";

/**
 * #285 接受邀請的交易本體（spec §5.4）：邀請列 `FOR UPDATE` 以單一述詞重判有效 → 建帳（`insertPasswordUserInTx`）→ 標用掉。
 *
 * ⚠ 鎖序：只鎖邀請列，再插新的 `handles`／`users` 列（不鎖任何既有 `users` 列）。停用與重設是「`users` 列 → 重設列」，
 * 不碰邀請列；撤銷是單句 UPDATE；清理是 `SKIP LOCKED`——沒有路徑先鎖別的再等邀請列，不成環（N-2）。
 * 交易內不讀 `site_settings`：不看「允許用帳號密碼自行註冊」（`registration_enabled`，E2），帳密開關在交易外判（spec §5.3 N-3）。
 */
export async function acceptInviteInTx(tx: Tx, input: { linkId: string } & PasswordUserInput): Promise<RegisteredUser> {
  const [link] = await tx
    .select({ id: oneTimeLinks.id })
    .from(oneTimeLinks)
    .where(and(eq(oneTimeLinks.id, input.linkId), activeOneTimeLink("invite")))
    .for("update");
  if (!link) throw new TxAbort(410, "invite_invalid", INVITE_INVALID_MESSAGE);
  const user = await insertPasswordUserInTx(tx, input);
  await tx.update(oneTimeLinks).set({ usedAt: sql`now()`, usedById: user.id }).where(eq(oneTimeLinks.id, input.linkId));
  return user;
}
