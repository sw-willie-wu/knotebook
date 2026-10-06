import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { siteSettings, userIdentities, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { canUnlinkIdentity, enabledProvidersWithIssuer, usableIdentityIds } from "../sign-in-methods.js";

export const IDENTITY_NOT_FOUND_MESSAGE = "找不到這個登入方式";

/**
 * #187 交易表 P2（spec §8.2）。鎖序（B16、C28）：①users `FOR NO KEY UPDATE`（序列化同一人的並發解除與加密碼，C10）②**之後**
 * `site_settings FOR SHARE`（與 B27 的站台設定寫入互斥：關閉帳密先拿到鎖 → 這裡讀到關、密碼不算數；這裡先拿到 → 關閉的 P2
 * 看得到身分已刪）。讀不到列＝開（B17），回 `settingsMissing` 讓呼叫端 log。INV-7 的判斷與 GET 的 `unlinkable` 同一組函式。
 * 同交易清掉吻合的 `users.oidc_*`（r1-I2：否則 §10.3 補登會讓已解除的身分復活）。不撤 session。
 */
export async function unlinkIdentityInTx(tx: Tx, input: { userId: string; identityId: string }): Promise<{ settingsMissing: boolean }> {
  const [me] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (me === undefined) throw new TxAbort(404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);
  const settings = await tx
    .select({ passwordLoginEnabled: siteSettings.passwordLoginEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  const settingsMissing = settings.length !== 1;
  const passwordLoginDbValue = settings[0]?.passwordLoginEnabled ?? true;

  const mine = await tx
    .select({ id: userIdentities.id, issuer: userIdentities.issuer, sub: userIdentities.sub })
    .from(userIdentities)
    .where(eq(userIdentities.userId, input.userId))
    .orderBy(asc(userIdentities.createdAt), asc(userIdentities.id));
  const target = mine.find(i => i.id === input.identityId);
  if (target === undefined) throw new TxAbort(404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);

  const usable = usableIdentityIds(mine, await enabledProvidersWithIssuer(tx));
  if (!canUnlinkIdentity(target.id, { hasPassword: me.passwordHash !== null, passwordLoginDbValue, usableIdentityIds: usable })) {
    throw new TxAbort(409, "last_login_method", "這是這個帳號唯一的登入方式，不能解除");
  }

  await tx.delete(userIdentities).where(and(eq(userIdentities.id, target.id), eq(userIdentities.userId, input.userId)));
  await tx
    .update(users)
    .set({ oidcIssuer: null, oidcSub: null })
    .where(and(eq(users.id, input.userId), eq(users.oidcIssuer, target.issuer), eq(users.oidcSub, target.sub)));
  return { settingsMissing };
}
