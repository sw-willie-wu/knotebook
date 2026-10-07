import { eq, sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders, siteSettings } from "../db/schema.js";

// #187 W24：「允許帳密登入」開關。兩種值（spec §3.3 名詞）：
// - DB 值＝`site_settings.password_login_enabled`——防自鎖判斷（B19 P1／P2、B24 INV-7、§9.3、§9.5 usersWithoutSso）一律看它；
// - 有效值＝DB 值 OR env `PASSWORD_LOGIN_FORCE_ENABLE`——「受不受理帳密」（login、register、password/set、/api/auth/config、
//   GET /api/auth/identities 的 passwordLoginEnabled）一律看它。運算式只有 `effectivePasswordLogin` 一處（§18.4 單一規則）。
// 每個需要它的請求直讀 DB、不快取（B17）；讀不到列視同**開啟**＋log.error（與註冊的「視同關閉」相反——關閉帳密是組織政策，
// 不是對攻擊者的安全邊界，fail-open 避免全站鎖死）。

export const PASSWORD_LOGIN_DISABLED_MESSAGE = "本站目前只允許透過登入服務登入";
export const PASSWORD_LOGIN_SETTINGS_MISSING_LOG = "site_settings 讀不到列：帳密登入視同開啟（#187 §4.3 B17）";

export const PASSWORD_LOGIN_FORCED_LOG =
  "PASSWORD_LOGIN_FORCE_ENABLE is set: password sign-in is on regardless of the Site admin setting. Remove it once recovery is done.";
export const PASSWORD_LOGIN_FORCED_NOOP_LOG =
  "PASSWORD_LOGIN_FORCE_ENABLE is set but has no effect while the Site admin setting is on. Remove it once recovery is done.";
export const PASSWORD_LOGIN_LOCKOUT_LOG =
  "Password sign-in is disabled and no sign-in provider is enabled: nobody can sign in. Set PASSWORD_LOGIN_FORCE_ENABLE=true and restart.";

/** 有效值的唯一運算式。`dbValue === null`（讀不到列）視同開啟（B17）。 */
export function effectivePasswordLogin(dbValue: boolean | null, forced: boolean): boolean {
  return forced || (dbValue ?? true);
}

/** DB 值（一般讀、不鎖）。讀不到列回 null——呼叫端決定怎麼解讀並 log。 */
export async function readPasswordLoginSetting(q: DbOrTx): Promise<boolean | null> {
  const [row] = await q.select({ enabled: siteSettings.passwordLoginEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
  return row?.enabled ?? null;
}

/**
 * 交易外判「這個請求受不受理帳密」的唯一讀法（有效值）。env 強制時不讀 DB。交易內（註冊）改用 `FOR SHARE` 讀到的值餵
 * `effectivePasswordLogin`（`auth/tx/register.ts`）——同一個運算式。
 */
export async function isPasswordLoginAccepted(
  db: Db,
  config: Pick<AppConfig, "passwordLoginForceEnable">,
  log: { error(obj: object, msg: string): void },
): Promise<boolean> {
  if (config.passwordLoginForceEnable) return true;
  const dbValue = await readPasswordLoginSetting(db);
  if (dbValue === null) log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
  return effectivePasswordLogin(dbValue, false);
}

/**
 * spec §10.4 開機檢查（env 匯入與 §10.3 補登之後、listen 之前；結構守衛在 `test/unit/config.test.ts`）。**不擋啟動**，只寫 log：
 * ① env 強制 → warn（DB 值為真時措辭改為「has no effect」）；② 有效值為關且零個啟用 provider（只可能是手改 DB，INV-8）→ error。
 * 讀不到列在此之前已由 env 匯入擋下（§10.2）；這裡讀不到就當開啟、不另印。
 */
export async function warnPasswordLoginAtBoot(
  db: Db,
  config: Pick<AppConfig, "passwordLoginForceEnable">,
  logger: { warn(msg: string): void; error(msg: string): void },
): Promise<void> {
  const dbValue = await readPasswordLoginSetting(db);
  if (config.passwordLoginForceEnable) {
    logger.warn(dbValue === false ? PASSWORD_LOGIN_FORCED_LOG : PASSWORD_LOGIN_FORCED_NOOP_LOG);
    return;
  }
  if (effectivePasswordLogin(dbValue, false)) return;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authProviders)
    .where(eq(authProviders.enabled, true));
  if (row!.n === 0) logger.error(PASSWORD_LOGIN_LOCKOUT_LOG);
}
