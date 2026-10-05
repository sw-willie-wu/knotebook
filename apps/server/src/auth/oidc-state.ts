import { sealCookieJson, unsealCookieJson } from "./sealed-cookie.js";

// OIDC state cookie 的 seal/unseal（spec §14.3）——密封 authorization request 期間需要
// 跨 redirect 存活的一次性資料（state/nonce/PKCE code_verifier），比照 `ai/crypto.ts` 的
// sha256 namespace 衍生慣例（`:ai-key`）與 `auth/session.ts`（`:session`）：同一個
// APP_SECRET 用不同 namespace 字尾衍生出互不相通的用途專屬金鑰。
// #187 起封章本體在 `auth/sealed-cookie.ts`（格式不變；namespace `oidc-state`）。
// #187 §7.3：payload 綁「發出它的 provider」（`providerId`）與當下的設定版本（`configVersion`），並帶 `intent`——callback
// 據此判斷 cookie 是否屬於這條 provider 路徑、設定是否在登入途中變了（C5）。三欄缺任何一個＝部署前封的舊 cookie，unseal 回 null
// （在飛的登入失敗一次，§17 第 12 條）。PR1 的 intent 只有 "login"（Task 11 加 "prove"；PR3 的 "link" 不收）。

export interface OidcStateBase {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** epoch 秒。由 server 端驗證（`payload.exp <= now` → null）——cookie 的 `maxAge`
   * 只是瀏覽器端約束，不可信任（§14.3 MAJOR-4）。 */
  exp: number;
  /** #187：發出這顆 cookie 的 provider id（小寫 uuid）。 */
  providerId: string;
  /** #187：封章當下該 provider 的 `config_version`。 */
  configVersion: number;
}

export type OidcStateIntent = {
  intent: "login";
  /**
   * #131：登入完成後要回去的站內路徑。由 login 端點寫入（已過 `safeNextPath`），callback
   * 端（Task 6 起）**unseal 後再驗一次**才使用——封章保證「這是我們封的」，不保證它現在
   * 仍安全（判準日後收緊時，還在飛的舊 cookie 是用舊判準封的）。
   *
   * ⚠ **沒有第二道長度上限**：唯一的關是 `safeNextPath`（`packages/shared` 的
   * `MAX_NEXT_PATH_LENGTH` = 2048）。spec §5.3.3 原本要求再壓到 512、理由是 cookie 的
   * 4 KB 上限，實測不成立（2048 字元的 next 封章後 `name=value` 是 3049 bytes、含屬性
   * 3115，臨界值 2834 字元——Plan 5 時的量測；#187 加 providerId／configVersion／intent 後 `name=value` 實測 3165），那道關只會把 513–2048 的合法路徑在 SSO 線靜默丟掉。
   * Willie 2026-09-03 裁決拿掉。守衛見 `test/oidc-login.test.ts` 的兩案分工註解。
   */
  next?: string;
};

export type OidcStatePayload = OidcStateBase & OidcStateIntent;

/** OIDC state cookie 的存活時間（秒）：10 分鐘，足夠使用者在 IdP 完成登入流程。 */
export const OIDC_STATE_TTL_SECONDS = 600;

/** OIDC state cookie 的 `Path` 屬性：僅 OIDC 流程本身的路由需要讀到這顆 cookie。 */
export const OIDC_STATE_COOKIE_PATH = "/api/auth/oidc";

/**
 * 密封格式：`base64url(iv).base64url(ct).base64url(tag)`——單一字串，可直接當
 * cookie value（base64url 不含 cookie 分隔符會用到的字元）。
 */
export function sealOidcState(appSecret: string, payload: OidcStatePayload): string {
  return sealCookieJson(appSecret, "oidc-state", payload);
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
  const parsed = unsealCookieJson(appSecret, "oidc-state", sealed);
  if (parsed === null) return null;

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

  // #131：`next` 是可選欄位——不存在可以，存在但不是字串就是壞的 payload（整顆丟掉）。
  // `!== undefined` 那半邊是「可選」逼出來的；另一半用 typeof 就夠——null 也走這條
  // （`typeof null === "object"` ≠ `"string"`），不必也不該另寫 `!== null`。
  // ⚠ 別簡化成 `if (nextValue && typeof nextValue !== "string")`：那樣 null 會漏（空字串
  // 被放過是**對的**，`""` 本來就是合法字串）。守衛：unit 的「next 是 null」那案。
  const p = parsed as Record<string, unknown>;
  // #187 §7.3：providerId／configVersion／intent 是新必要欄位——缺的就是部署前封的舊 cookie（在飛的登入失敗一次，§17 第 12 條）。
  if (typeof p.providerId !== "string" || !Number.isInteger(p.configVersion) || p.intent !== "login") return null;

  const nextValue = (parsed as Record<string, unknown>).next;
  if (nextValue !== undefined && typeof nextValue !== "string") {
    return null;
  }

  const payload = parsed as OidcStatePayload;
  if (payload.exp <= nowEpochSeconds) return null;
  return payload;
}
