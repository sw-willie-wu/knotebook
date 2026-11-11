import type { FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http/errors.js";
import { MAX_ISSUER_LENGTH } from "./oidc-client.js";

// #187：管理員輸入的登入服務欄位。**每一條都與 0014 的 CHECK 對齊**（drizzle/0014_auth-providers.sql:16-21），讓 CHECK
// 只當最後防線：zod 放行、CHECK 拒絕的形會從 400 變成 500。對齊點：
// - issuer：CHECK 是 `~ '^https?://'`——**大小寫敏感**（`HTTPS://` 被拒），與 env 匯入的判準同一條；
//   `new URL` 會把大寫 scheme 正規化掉，不能拿它判 scheme。長度 ≤ 512：JS `.length`（UTF-16）≥ code point 數，用它比較只會更嚴。
// - 顯示名：CHECK 是 `char_length` 1..40——code point 計數；JS `.length` 對 emoji 會算成 2，所以用 `[...s].length`。
// - client id：`char_length` 1..512，同上。
// 另擋 NUL 與落單代理（NUL 進 text 欄 22021 → 500）。字串一律先 trim 再驗、再存。

const UNSTORABLE = /[\0]|\p{Surrogate}/u;
const ISSUER_SCHEME = /^https?:\/\//;
const codePoints = (s: string): number => [...s].length;
/** NUL 與落單代理進 PG text 欄會 22021／22P05 → 500。#187 註冊的顯示名也用它。 */
export function isStorableText(s: string): boolean {
  return !UNSTORABLE.test(s);
}
const storable = isStorableText;
const UNSTORABLE_MESSAGE = "contains characters that can't be stored.";

export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_CLIENT_ID_LENGTH = 512;
/** 4096 足以容納任何實際的 client secret，擋住把整包垃圾封進 jsonb。 */
export const MAX_CLIENT_SECRET_LENGTH = 4096;

const displayName = z
  .string()
  .trim()
  .refine(storable, `The display name ${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_DISPLAY_NAME_LENGTH, `The display name must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`);

export const issuerUrlSchema = z
  .string()
  .trim()
  .refine(storable, `The issuer URL ${UNSTORABLE_MESSAGE}`)
  .refine(s => ISSUER_SCHEME.test(s), "The issuer URL must start with lowercase http:// or https://.")
  .refine(s => s.length <= MAX_ISSUER_LENGTH, `The issuer URL can be at most ${MAX_ISSUER_LENGTH} characters.`)
  .refine(s => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }, "The issuer is not a valid URL.")
  // 不得帶帳密（`https://user:pass@host`／`user@host`）：issuer 是明文欄位（DB 明文、GET 原樣回傳、進 log），
  // 且 fetch 本來就拒絕這種網址。zod 的 refine 鏈不會短路，所以解析失敗要放行（交給上面那條報「不是合法網址」）。
  .refine(s => {
    try {
      const u = new URL(s);
      return u.username === "" && u.password === "";
    } catch {
      return true;
    }
  }, "The issuer URL can't contain a username or password.");

const clientId = z
  .string()
  .trim()
  .refine(storable, `The client ID ${UNSTORABLE_MESSAGE}`)
  .refine(s => codePoints(s) >= 1 && codePoints(s) <= MAX_CLIENT_ID_LENGTH, `The client ID must be 1 to ${MAX_CLIENT_ID_LENGTH} characters.`);

/** secret 不 trim（原樣送給 IdP）；只擋「全空白」與超長。 */
const clientSecret = z
  .string()
  .refine(storable, `The client secret ${UNSTORABLE_MESSAGE}`)
  .refine(s => s.trim().length > 0, "The client secret can't be empty (there's no API to clear it).")
  .refine(s => s.length <= MAX_CLIENT_SECRET_LENGTH, `The client secret can be at most ${MAX_CLIENT_SECRET_LENGTH} characters.`);

// 不收 autoCreateEnabled（strict → 帶了就 400；新服務一律 false）。
export const createProviderSchema = z
  .object({
    template: z.enum(["gitlab", "google", "oidc"]),
    displayName,
    issuerUrl: issuerUrlSchema,
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
  })
  .strict();

/** 沒帶的欄位＝不改（SQL 端以 `COALESCE(參數, 現值)` 代入）。`template`、`legacyCallback` 不可改。 */
export const patchProviderSchema = z
  .object({
    displayName: displayName.optional(),
    issuerUrl: issuerUrlSchema.optional(),
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
    enabled: z.boolean().optional(),
    autoCreateEnabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    // 圖示：upload 只能經 PUT …/icon，這裡不收。值域與 CHECK auth_providers_icon_kind_chk 去掉 upload 一致。
    iconKind: z.enum(["template", "gitlab", "google", "none"]).optional(),
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, "Invalid request body: send at least one field.");

export const discoverSchema = z.object({ issuerUrl: issuerUrlSchema }).strict();

/**
 * 400 `invalid_body`。取第一個自訂（refine）issue 的訊息；zod 內建的（型別、必填、多餘欄位）訊息太技術，
 * 一律換成固定的 "Invalid request body."（#372：HTTP 層訊息一律英文）。
 */
export function sendInvalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const custom = error.issues.find(issue => issue.code === "custom");
  return sendError(reply, 400, "invalid_body", custom?.message ?? "Invalid request body.");
}
