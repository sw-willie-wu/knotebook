import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { handles, siteSettings, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { deriveHandle } from "../handle.js";
import { effectivePasswordLogin, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../password-login.js";
import { REGISTRATION_DISABLED_MESSAGE } from "../site-settings.js";

export interface RegisterUserInput {
  id: string;
  /** 已 `normalizeEmail`。 */
  email: string;
  displayName: string;
  /** 交易外 hash 好的（S14）。 */
  passwordHash: string;
  /** 第 4 次嘗試：不再探測，直接用 `user-<uuid8>`（同 admin 代建的重試契約）。 */
  useFallbackHandle: boolean;
  /** env `PASSWORD_LOGIN_FORCE_ENABLE`（純資料，交易外取自 config）。 */
  passwordLoginForced: boolean;
}

export interface RegisteredUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  tokenVersion: number;
}

/**
 * #187 交易表 P1（spec §9.1 第 5 步）。`site_settings` 以 `FOR SHARE` 再讀**兩個**開關（C9、C27：與關閉的 `FOR NO KEY UPDATE`
 * 互斥——快速路徑讀到開、這裡讀到關的那一次會被擋下）；讀不到列＝註冊關（§4.3）。`lower(email)` 先查（r2-M8：`users_email_unique`
 * 大小寫敏感，擋不住 pre-v0.1 的大小寫混合舊列）；並發形的最後防線是唯一鍵（呼叫端在交易外判 constraint）。registry-first 建帳，
 * `must_change_password=false`（本人自己選的密碼，B9）。
 */
export async function registerUserInTx(tx: Tx, input: RegisterUserInput): Promise<RegisteredUser> {
  const [settings] = await tx
    .select({ registrationEnabled: siteSettings.registrationEnabled, passwordLoginEnabled: siteSettings.passwordLoginEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  if (settings?.registrationEnabled !== true) throw new TxAbort(403, "registration_disabled", REGISTRATION_DISABLED_MESSAGE);
  if (!effectivePasswordLogin(settings.passwordLoginEnabled, input.passwordLoginForced)) {
    throw new TxAbort(403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
  }

  const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
  if (taken !== undefined) throw new TxAbort(409, "email_taken", "此 email 已被使用");

  const handle = input.useFallbackHandle ? `user-${input.id.slice(0, 8)}` : await deriveHandle(tx, [input.email.split("@")[0]], input.id);
  await tx.insert(handles).values({ handle, userId: input.id, state: "live" });
  const [row] = await tx
    .insert(users)
    .values({ id: input.id, email: input.email, displayName: input.displayName, passwordHash: input.passwordHash, mustChangePassword: false, handle })
    .returning({ id: users.id, email: users.email, handle: users.handle, displayName: users.displayName, tokenVersion: users.tokenVersion });
  return row!;
}
