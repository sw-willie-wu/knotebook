import type { FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http/errors.js";
import { MAX_ISSUER_LENGTH } from "./oidc-client.js";

// #187 PR2：管理員輸入的登入服務欄位。**每一條都與 0014 的 CHECK 對齊**（drizzle/0014_auth-providers.sql:16-21），讓 CHECK
// 只當最後防線：zod 放行、CHECK 拒絕的形會從 400 變成 500（RF1）。對齊點：
// - issuer：CHECK 是 `~ '^https?://'`——**大小寫敏感**（`HTTPS://` 被拒），與 PR1 env 匯入的判準同一條（ledger Task 5 Ruling I1）；
//   `new URL` 會把大寫 scheme 正規化掉，不能拿它判 scheme。長度 ≤ 512：JS `.length`（UTF-16）≥ code point 數，用它比較只會更嚴。
// - 顯示名：CHECK 是 `char_length` 1..40——code point 計數；JS `.length` 對 emoji 會算成 2，所以用 `[...s].length`。
// - client id：`char_length` 1..512，同上。
// 另擋 NUL 與落單代理（[[g:pg-unstorable-strings-drizzle-tx]]：NUL 進 text 欄 22021 → 500）。字串一律先 trim 再驗、再存。

const UNSTORABLE = /[\0]|\p{Surrogate}/u;
const ISSUER_SCHEME = /^https?:\/\//;
const codePoints = (s: string): number => [...s].length;
/** NUL 與落單代理進 PG text 欄會 22021／22P05 → 500（[[g:pg-unstorable-strings-drizzle-tx]]）。#187 PR3 註冊的顯示名也用它。 */
export function isStorableText(s: string): boolean {
  return !UNSTORABLE.test(s);
}
const storable = isStorableText;
const UNSTORABLE_MESSAGE = "含有無法儲存的字元";

export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_CLIENT_ID_LENGTH = 512;
/** spec 沒給上限；4096 足以容納任何實際的 client secret，擋住把整包垃圾封進 jsonb。 */
export const MAX_CLIENT_SECRET_LENGTH = 4096;

const displayName = z
  .string()
  .trim()
  .refine(storable, `顯示名稱${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_DISPLAY_NAME_LENGTH, `顯示名稱須為 1 到 ${MAX_DISPLAY_NAME_LENGTH} 個字`);

export const issuerUrlSchema = z
  .string()
  .trim()
  .refine(storable, `issuer 網址${UNSTORABLE_MESSAGE}`)
  .refine(s => ISSUER_SCHEME.test(s), "issuer 網址必須以小寫 http:// 或 https:// 開頭")
  .refine(s => s.length <= MAX_ISSUER_LENGTH, `issuer 網址不得超過 ${MAX_ISSUER_LENGTH} 個字元`)
  .refine(s => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }, "issuer 不是合法網址");

const clientId = z
  .string()
  .trim()
  .refine(storable, `client ID ${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_CLIENT_ID_LENGTH, `client ID 須為 1 到 ${MAX_CLIENT_ID_LENGTH} 個字`);

/** secret 不 trim（原樣送給 IdP）；只擋「全空白」與超長。 */
const clientSecret = z
  .string()
  .refine(storable, `client secret ${UNSTORABLE_MESSAGE}`)
  .refine(s => s.trim().length > 0, "client secret 不得為空（不提供清除 secret 的 API）")
  .refine(s => s.length <= MAX_CLIENT_SECRET_LENGTH, `client secret 不得超過 ${MAX_CLIENT_SECRET_LENGTH} 個字元`);

export const createProviderSchema = z
  .object({
    template: z.enum(["gitlab", "google", "oidc"]),
    displayName,
    issuerUrl: issuerUrlSchema,
    clientId,
    clientSecret: clientSecret.optional(),
  })
  .strict();

/** §5.2：沒帶的欄位＝不改（SQL 端以 `COALESCE(參數, 現值)` 代入）。`template`、`legacyCallback` 不可改。 */
export const patchProviderSchema = z
  .object({
    displayName: displayName.optional(),
    issuerUrl: issuerUrlSchema.optional(),
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, "請求格式錯誤：至少需要一個欄位");

export const discoverSchema = z.object({ issuerUrl: issuerUrlSchema }).strict();

/**
 * 400 `invalid_body`。HTTP 層訊息一律中文：取第一個自訂（refine）issue 的中文訊息；zod 內建的（型別、必填、多餘欄位）是
 * 英文，一律換成固定的「請求格式錯誤」。
 */
export function sendInvalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const custom = error.issues.find(issue => issue.code === "custom");
  return sendError(reply, 400, "invalid_body", custom?.message ?? "請求格式錯誤");
}
