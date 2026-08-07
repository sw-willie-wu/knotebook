/**
 * 密碼最小長度：`routes/setup.ts`（首次建立 admin）、`routes/auth.ts`（改密碼）、
 * `routes/admin-users.ts`（admin 建立使用者）、`config.ts`（`ADMIN_PASSWORD` env
 * bootstrap，spec rev 5.7）四處共用同一個門檻，唯一真相來源在此。
 */
export const MIN_PASSWORD_LENGTH = 12;
