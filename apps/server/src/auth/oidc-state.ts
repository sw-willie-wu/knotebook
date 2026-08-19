import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// OIDC state cookie 的 seal/unseal（spec §14.3）——密封 authorization request 期間需要
// 跨 redirect 存活的一次性資料（state/nonce/PKCE code_verifier），比照 `ai/crypto.ts` 的
// sha256 namespace 衍生慣例（`:ai-key`）與 `auth/session.ts`（`:session`）：同一個
// APP_SECRET 用不同 namespace 字尾衍生出互不相通的用途專屬金鑰。

export interface OidcStatePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** epoch 秒。由 server 端驗證（`payload.exp <= now` → null）——cookie 的 `maxAge`
   * 只是瀏覽器端約束，不可信任（§14.3 MAJOR-4）。 */
  exp: number;
}

/** OIDC state cookie 的存活時間（秒）：10 分鐘，足夠使用者在 IdP 完成登入流程。 */
export const OIDC_STATE_TTL_SECONDS = 600;

/** OIDC state cookie 的 `Path` 屬性：僅 OIDC 流程本身的路由需要讀到這顆 cookie。 */
export const OIDC_STATE_COOKIE_PATH = "/api/auth/oidc";

/** AES-256-GCM 需要 32 bytes 金鑰；sha256 摘要正好 32 bytes，直接當金鑰用。 */
function deriveKey(appSecret: string): Buffer {
  return createHash("sha256").update(`${appSecret}:oidc-state`).digest();
}

/**
 * 密封格式：`base64url(iv).base64url(ct).base64url(tag)`——單一字串，可直接當
 * cookie value（base64url 不含 cookie 分隔符會用到的字元）。
 */
export function sealOidcState(appSecret: string, payload: OidcStatePayload): string {
  const key = deriveKey(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

/**
 * 任何解密/解析失敗（格式不對、密文被竄改、金鑰不符）皆回 `null`，不 throw——呼叫端
 * （OIDC callback route）一律視為「state 無效」統一處理，不需分辨失敗原因。
 * `exp` 由這裡驗證：`payload.exp <= nowEpochSeconds` 視為已逾期。
 *
 * 「消費後重放」不在此模組的職責內——server 端無已消費 state 集合，一次性語意由
 * callback route 的 clearCookie + exp 短 TTL + IdP authorization code 本身的單次消費
 * 共同承擔（見 spec §14.7）。
 */
export function unsealOidcState(appSecret: string, sealed: string, nowEpochSeconds: number): OidcStatePayload | null {
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [ivPart, ctPart, tagPart] = parts;
  if (!ivPart || !ctPart || !tagPart) return null;

  let plaintext: string;
  try {
    const key = deriveKey(appSecret);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]);
    plaintext = pt.toString("utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).state !== "string" ||
    typeof (parsed as Record<string, unknown>).nonce !== "string" ||
    typeof (parsed as Record<string, unknown>).codeVerifier !== "string" ||
    typeof (parsed as Record<string, unknown>).exp !== "number"
  ) {
    return null;
  }

  const payload = parsed as OidcStatePayload;
  if (payload.exp <= nowEpochSeconds) return null;
  return payload;
}
