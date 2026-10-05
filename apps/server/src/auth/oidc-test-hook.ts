/**
 * #187 的 OIDC 連結測試注入縫（比照 `groups/test-hook.ts`）：生產不注入＝零成本。每個點都在「鎖已取得、判斷尚未發生」或
 * 「驗證之後、交易之前」的窗口，整合測試在那裡讓另一條請求插進來（C21、C22、C23、C24）。
 */
export type OidcRacePoint =
  /** `POST /api/auth/oidc/pending/confirm`：密碼驗過之後、連結交易之前（C23：此時本人改了密碼）。 */
  | "pending-confirm-verified"
  /** `linkPendingIdentityInTx`：目標帳號 users 列鎖（NO KEY UPDATE）取得之後、任何重驗之前（C21／C22）。 */
  | "link-locked";

export type OidcTestHook = (point: OidcRacePoint, ctx: { userId: string }) => Promise<void>;
