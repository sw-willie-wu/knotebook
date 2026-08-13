/**
 * 密碼最小長度：`routes/auth.ts`（改密碼）、`routes/admin-users.ts`（admin 建立使用者）、
 * `config.ts`（`ADMIN_PASSWORD` env-only 實例初始化，spec rev 5.7 / §14.2）三處共用
 * 同一個門檻，唯一真相來源在此。
 */
export const MIN_PASSWORD_LENGTH = 12;
