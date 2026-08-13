import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CustomFetch } from "openid-client";

/**
 * In-process mock IdP harness（Task 8 交付、Task 9 消費——契約見 task-8-brief.md）。
 *
 * 不開真 socket：回傳一個符合 `openid-client` 的 `CustomFetch` 函式，依 URL 分派
 * discovery/token/userinfo/jwks 回應；`authorize()` 是 nonce/state/code 的唯一來源
 * （模擬瀏覽器對 authorize endpoint 的頂層導航——server 端從不 fetch 這個 URL）。
 */

export interface FakeIdpClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export type FakeIdpOmittableMetadataKey = "userinfo_endpoint" | "jwks_uri";
export type FakeIdpOmittableIdTokenKey = "email" | "email_verified" | "nonce";
export type FakeIdpFailTarget = "token" | "userinfo" | "discovery";

export interface FakeIdp {
  fetch: CustomFetch;
  /** 預置下一次 `authorize()` 要簽發的身分。`authorize()` 消費後必須重新呼叫才能再次
   * 使用——強制每個測試流程顯式預置，不留可能串到別次流程的殘留狀態。 */
  setNextLogin(claims: FakeIdpClaims): void;
  /** 解析 login route 302 的 `location`，記錄 state/nonce/code_challenge，回傳一次性
   * `code` + 原樣回送的 `state`。未先 `setNextLogin()` 即呼叫 → throw。 */
  authorize(location: string): { code: string; state: string };
  /** 下一次打中 `target` 的請求回傳失敗回應——一次性，消費即還原。 */
  failNext(target: FakeIdpFailTarget): void;
  /** discovery metadata 回應中省略指定欄位；傳空陣列即還原（不省略任何欄位）。 */
  omitFromMetadata(keys: FakeIdpOmittableMetadataKey[]): void;
  /** id_token claims 中省略指定欄位；傳空陣列即還原。 */
  omitFromIdToken(keys: FakeIdpOmittableIdTokenKey[]): void;
  counts: { discovery: number; token: number; userinfo: number };
}

interface AuthorizedCode {
  claims: FakeIdpClaims;
  nonce: string;
  /** Task 9 用（PKCE 綁定釘）——本 task 未消費，`authorize()` 契約要求記錄。 */
  codeChallenge: string;
  /** Task 9 用（redirect_uri 綁定釘）——本 task 未消費，`authorize()` 契約要求記錄。 */
  redirectUri: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyToParams(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  return new URLSearchParams();
}

export function createFakeIdp(issuerUrl: string): FakeIdp {
  // 啟動時建 RS256 金鑰對（惰性 await——`createFakeIdp` 本身同步回傳，jwks/token
  // endpoint 的 fetch handler 內才真的需要它，屆時 await 這個共用 promise）。
  const keyPairPromise = generateKeyPair("RS256");
  const kid = randomUUID();

  let nextLogin: FakeIdpClaims | undefined;
  const authorizedCodes = new Map<string, AuthorizedCode>();
  // MAJOR-2（審查 fix round 1）：`code` 一次性消費即刪，userinfo endpoint 收到的是
  // access_token（非 code），claims 必須另存一份、以 access_token 為 key，否則 userinfo
  // handler 物理上拿不到身分資料。
  const accessTokenClaims = new Map<string, FakeIdpClaims>();

  let failTarget: FakeIdpFailTarget | undefined;
  let omittedMetadataKeys = new Set<FakeIdpOmittableMetadataKey>();
  let omittedIdTokenKeys = new Set<FakeIdpOmittableIdTokenKey>();

  const counts = { discovery: 0, token: 0, userinfo: 0 };

  function consumeFailNext(target: FakeIdpFailTarget): boolean {
    if (failTarget !== target) return false;
    failTarget = undefined;
    return true;
  }

  function setNextLogin(claims: FakeIdpClaims): void {
    nextLogin = claims;
  }

  function authorize(location: string): { code: string; state: string } {
    if (!nextLogin) {
      throw new Error("fakeIdp.authorize() 呼叫前必須先 setNextLogin() 預置身分");
    }
    const url = new URL(location);
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const codeChallenge = url.searchParams.get("code_challenge");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!state || !nonce || !codeChallenge) {
      throw new Error(`fakeIdp.authorize()：location 缺少必要參數（state/nonce/code_challenge）：${location}`);
    }

    const code = randomBytes(16).toString("hex");
    authorizedCodes.set(code, { claims: nextLogin, nonce, codeChallenge, redirectUri });
    // 消費——強制下一次 authorize() 前必須重新 setNextLogin()。
    nextLogin = undefined;

    return { code, state };
  }

  function failNext(target: FakeIdpFailTarget): void {
    failTarget = target;
  }

  function omitFromMetadata(keys: FakeIdpOmittableMetadataKey[]): void {
    omittedMetadataKeys = new Set(keys);
  }

  function omitFromIdToken(keys: FakeIdpOmittableIdTokenKey[]): void {
    omittedIdTokenKeys = new Set(keys);
  }

  const fetchImpl: CustomFetch = async (url, options) => {
    const path = new URL(url).pathname;

    if (path.endsWith("/.well-known/openid-configuration")) {
      counts.discovery += 1;
      if (consumeFailNext("discovery")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const metadata: Record<string, unknown> = {
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        userinfo_endpoint: `${issuerUrl}/userinfo`,
        jwks_uri: `${issuerUrl}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      };
      for (const key of omittedMetadataKeys) delete metadata[key];
      return jsonResponse(metadata);
    }

    if (path.endsWith("/token")) {
      counts.token += 1;
      if (consumeFailNext("token")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const params = bodyToParams(options.body);
      const code = params.get("code");
      const clientId = params.get("client_id");
      const record = code ? authorizedCodes.get(code) : undefined;
      if (!code || !record) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      // 一次性消費：同一個 code 二次使用回 400。
      authorizedCodes.delete(code);

      const { privateKey } = await keyPairPromise;
      const idTokenClaims: Record<string, unknown> = { sub: record.claims.sub };
      if (record.claims.email !== undefined && !omittedIdTokenKeys.has("email")) {
        idTokenClaims.email = record.claims.email;
      }
      if (record.claims.email_verified !== undefined && !omittedIdTokenKeys.has("email_verified")) {
        idTokenClaims.email_verified = record.claims.email_verified;
      }
      if (record.claims.name !== undefined) {
        idTokenClaims.name = record.claims.name;
      }
      if (!omittedIdTokenKeys.has("nonce")) {
        idTokenClaims.nonce = record.nonce;
      }

      const idToken = await new SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuerUrl)
        .setAudience(clientId ?? "")
        // MAJOR-1（審查 fix round 1）：oauth4webapi 硬性要求 id_token 帶 `iat`
        // （實測 `JWT "iat" claim missing`）——`setExpirationTime` 不會連帶補上 `iat`。
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

      const accessToken = randomBytes(16).toString("hex");
      accessTokenClaims.set(accessToken, record.claims);

      return jsonResponse({
        access_token: accessToken,
        token_type: "Bearer",
        id_token: idToken,
        scope: "openid email profile",
      });
    }

    if (path.endsWith("/userinfo")) {
      counts.userinfo += 1;
      if (consumeFailNext("userinfo")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      // MAJOR-2（審查 fix round 1）：`processUserInfoResponse` 先驗 `sub` 為 string、再比對
      // `expectedSubject`——回空物件必炸。真的依 Bearer token 查回預置身分。
      const authHeader = options.headers.authorization ?? options.headers.Authorization;
      const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
      const claims = accessToken ? accessTokenClaims.get(accessToken) : undefined;
      if (!claims) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      const body: Record<string, unknown> = { sub: claims.sub };
      if (claims.email !== undefined) body.email = claims.email;
      if (claims.email_verified !== undefined) body.email_verified = claims.email_verified;
      if (claims.name !== undefined) body.name = claims.name;
      return jsonResponse(body);
    }

    if (path.endsWith("/jwks")) {
      const { publicKey } = await keyPairPromise;
      const jwk = await exportJWK(publicKey);
      return jsonResponse({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  return { fetch: fetchImpl, setNextLogin, authorize, failNext, omitFromMetadata, omitFromIdToken, counts };
}
