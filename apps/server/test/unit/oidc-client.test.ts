import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import { OidcUnavailableError, createOidcRuntime, oidcRedirectUri } from "../../src/auth/oidc-client.js";
import { loadConfig, type AppConfig } from "../../src/config.js";

function config(publicUrl: string) {
  return loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/test",
    APP_SECRET: "a".repeat(64),
    PUBLIC_URL: publicUrl,
  });
}

const ISSUER_URL = "https://idp.example.com";

function oidcConfig(): NonNullable<AppConfig["oidc"]> {
  return loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/test",
    APP_SECRET: "a".repeat(64),
    PUBLIC_URL: "http://localhost:3000",
    OIDC_ISSUER_URL: ISSUER_URL,
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-secret",
  }).oidc!;
}

/** 手寫 CustomFetch stub——只回應 discovery 這一個 URL，`getConfiguration()` 不會打到
 * 其他 endpoint（token/userinfo/jwks 都是 Task 9 才會真的 fetch），不需要 DB、不需要
 * `test/helpers/fake-idp.ts` 那整套。`algs` 為 `undefined` 時整個省略該欄位（測「缺欄位」
 * 分支），否則原樣塞進 metadata。 */
function discoveryOnlyFetch(algs: string[] | undefined): CustomFetch {
  return async url => {
    if (!new URL(url).pathname.endsWith("/.well-known/openid-configuration")) {
      return new Response(null, { status: 404 });
    }
    const metadata: Record<string, unknown> = {
      issuer: ISSUER_URL,
      authorization_endpoint: `${ISSUER_URL}/authorize`,
      token_endpoint: `${ISSUER_URL}/token`,
      userinfo_endpoint: `${ISSUER_URL}/userinfo`,
      jwks_uri: `${ISSUER_URL}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };
    if (algs !== undefined) metadata.id_token_signing_alg_values_supported = algs;
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("auth/oidc-client：oidcRedirectUri（login 與 callback 共用的單一 helper，§14.3）", () => {
  it("組出 <publicUrl origin>/api/auth/oidc/callback", () => {
    expect(oidcRedirectUri(config("https://notes.example.com"))).toBe(
      "https://notes.example.com/api/auth/oidc/callback"
    );
  });

  it("publicUrl 帶 port → 保留 port", () => {
    expect(oidcRedirectUri(config("http://192.168.3.22:8006"))).toBe(
      "http://192.168.3.22:8006/api/auth/oidc/callback"
    );
  });

  it("publicUrl 帶路徑 → 絕對路徑覆蓋（new URL 的第二參數只取 origin，不併接既有路徑）", () => {
    expect(oidcRedirectUri(config("https://notes.example.com/base/path"))).toBe(
      "https://notes.example.com/api/auth/oidc/callback"
    );
  });
});

describe("auth/oidc-client：createOidcRuntime 對 id_token_signing_alg_values_supported 的三分支判定（MINOR-6，審查 fix round 1）", () => {
  it("metadata 缺該欄位 → 視為含 RS256，不擋（getConfiguration 正常 resolve）", async () => {
    const runtime = createOidcRuntime(oidcConfig(), { fetch: discoveryOnlyFetch(undefined) });
    await expect(runtime.getConfiguration()).resolves.toBeDefined();
  });

  it('metadata 僅含 ["HS256"]（無非對稱演算法）→ throw OidcUnavailableError', async () => {
    const runtime = createOidcRuntime(oidcConfig(), { fetch: discoveryOnlyFetch(["HS256"]) });
    await expect(runtime.getConfiguration()).rejects.toBeInstanceOf(OidcUnavailableError);
  });

  it('metadata 含 ["RS256"] → 正常通過', async () => {
    const runtime = createOidcRuntime(oidcConfig(), { fetch: discoveryOnlyFetch(["RS256"]) });
    await expect(runtime.getConfiguration()).resolves.toBeDefined();
  });
});
