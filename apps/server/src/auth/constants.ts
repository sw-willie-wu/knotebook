/**
 * 密碼最小長度：`routes/auth.ts`（改密碼）、`routes/account.ts`（註冊、接受邀請）、
 * `config.ts`（`ADMIN_PASSWORD` env-only 實例初始化，spec rev 5.7 / §14.2）等多處共用
 * 同一個門檻，唯一真相來源在此。
 */
export const MIN_PASSWORD_LENGTH = 12;
