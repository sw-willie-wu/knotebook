import { createHash, randomBytes } from "node:crypto";

/**
 * #107：API token 的明文格式。前綴有兩個承重理由：
 * ① Bearer 路徑一眼分辨「這不是我們發的 token」→ 直接 401，不必查 DB；
 * ② secret scanner 的鉤子（GitHub push protection 那族靠前綴比對）。
 *
 * ⚠ `REFRESH_TOKEN_PREFIX` **刻意不是** `ACCESS_TOKEN_PREFIX` 的延長：第 4 個字元
 * 是 `r` 而不是 `_`，所以把 refresh token 當 Bearer 送時 `isAccessTokenShape` 為
 * false，會落在「前綴不合」那條 401 而不是進 DB 查表。這條性質是靠字元恰好不同
 * 成立的，改前綴前先看 `test/unit/api-token.test.ts` 的守衛。
 */
export const ACCESS_TOKEN_PREFIX = "knb_";
export const REFRESH_TOKEN_PREFIX = "knbr_";

/** 32 bytes＝256 bit 熵，base64url 43 字元，加前綴共 47。 */
export function generateAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** 同上，加前綴共 48。只有 OAuth grant 有 refresh token（#132）。 */
export function generateRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * 落庫形：sha256 hex，靠 UNIQUE 索引查。
 *
 * **刻意不用 argon2／不加鹽**：那是為了擋低熵密碼的字典攻擊，對 256 bit 的隨機
 * token 沒有意義，只會讓每次 Bearer 驗證多花幾十毫秒——而 Bearer 是每個 API
 * 請求都會走的路徑（對照 `auth/password.ts` 的 argon2，那裡的輸入是人選的密碼）。
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * `Authorization` header 的三態解析。三態分開的理由是 RFC 6750 對兩種失敗要求
 * 不同的 challenge：
 * - §3「unsupported authentication method」（例如 `Basic`）**SHOULD NOT** 帶 error；
 * - §3.1「malformed / invalid token」要帶 `error="invalid_token"`。
 *
 * - `none`：完全沒有 header → 呼叫端回退 cookie session。
 * - `other-scheme`：有 header 但不是形狀完整的 `Bearer <token>`（含 `Basic`、空字串、
 *   只有 scheme、token 內帶空白）。**仍計入無效 Bearer 的節流**，只是 challenge
 *   不帶 error。
 * - `bearer`：scheme 是 Bearer（大小寫不敏感），`token` 已 trim 且保證非空、無空白。
 *
 * ⚠ `\S+` 不可放寬成 `.*`：`Bearer a b` 是畸形 header，不是「token 剛好含空白」。
 */
export type BearerHeader = { kind: "none" } | { kind: "other-scheme" } | { kind: "bearer"; token: string };

export function parseAuthorizationHeader(raw: string | undefined): BearerHeader {
  if (raw === undefined) return { kind: "none" };
  const match = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  if (match === null) return { kind: "other-scheme" };
  return { kind: "bearer", token: match[1]! };
}

export function isAccessTokenShape(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}
