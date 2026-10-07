import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { siteSettings } from "../db/schema.js";

export const REGISTRATION_DISABLED_MESSAGE = "此站台目前不開放註冊新帳號，請聯絡站長";

/** #187 §4.3：讀不到列回 null——呼叫端視同關閉並 `log.error`（r1-M5）。交易內的讀法（`FOR SHARE`）在 `auth/tx/oidc-login.ts`。 */
export async function readRegistrationEnabled(db: DbOrTx): Promise<boolean | null> {
  const [row] = await db.select({ enabled: siteSettings.registrationEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
  return row?.enabled ?? null;
}
