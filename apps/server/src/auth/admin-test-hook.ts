/**
 * #247 §9.4 站台管理員降級的測試注入縫（比照 `oidc-test-hook.ts`、`groups/test-hook.ts`）：生產不注入＝零成本。
 * 整合測試在「鎖已取得、計數完成、寫入之前」讓另一條降級請求插進來，把併發互降變成決定性的測試。
 */
export type AdminRacePoint =
  /** `demoteSiteAdminInTx`：全部 admin 列 `FOR UPDATE` 取得、啟用中的其他 admin 計數完成之後，寫入之前。 */
  "demote-locked";

export type AdminTestHook = (point: AdminRacePoint, ctx: { targetId: string }) => Promise<void>;
