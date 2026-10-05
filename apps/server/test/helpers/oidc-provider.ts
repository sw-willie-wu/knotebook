import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CustomFetch } from "openid-client";
import type { AppDeps } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import type { Db } from "../../src/db/index.js";
import { authProviders, userIdentities } from "../../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../../src/auth/oidc-client.js";
import { sealClientSecret, type OidcProviderRow } from "../../src/auth/oidc-providers.js";
import { buildTestApp, testConfig, type TestApp } from "../helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./fake-idp.js";

export interface SeedProviderOpts {
  issuerUrl: string;
  id?: string;
  template?: "gitlab" | "google" | "oidc";
  displayName?: string;
  clientId?: string;
  /** null＝不存 secret（此時 `enabled` 必須為 false，否則 CHECK 擋）。 */
  clientSecret?: string | null;
  enabled?: boolean;
  legacyCallback?: boolean;
  sortOrder?: number;
  resolvedIssuer?: string | null;
  configVersion?: number;
}

/** 直接寫 `auth_providers`（PR2 才有管理 API）。secret 以 `testConfig.appSecret` 封——`buildTestApp` 預設 config 同一把。 */
export async function seedAuthProvider(db: Db, opts: SeedProviderOpts): Promise<OidcProviderRow> {
  const id = opts.id ?? randomUUID();
  const secret = opts.clientSecret === undefined ? "test-secret" : opts.clientSecret;
  const [row] = await db
    .insert(authProviders)
    .values({
      id,
      template: opts.template ?? "oidc",
      displayName: opts.displayName ?? "SSO",
      issuerUrl: opts.issuerUrl,
      resolvedIssuer: opts.resolvedIssuer ?? null,
      clientId: opts.clientId ?? "test-client",
      clientSecretEncrypted: secret === null ? null : sealClientSecret(testConfig.appSecret, id, secret),
      enabled: opts.enabled ?? true,
      legacyCallback: opts.legacyCallback ?? false,
      sortOrder: opts.sortOrder ?? 0,
      configVersion: opts.configVersion ?? 1,
    })
    .returning();
  return {
    id: row!.id,
    displayName: row!.displayName,
    issuerUrl: row!.issuerUrl,
    resolvedIssuer: row!.resolvedIssuer,
    clientId: row!.clientId,
    clientSecretEncrypted: row!.clientSecretEncrypted,
    enabled: row!.enabled,
    legacyCallback: row!.legacyCallback,
    configVersion: row!.configVersion,
  };
}

export async function identitiesOf(db: Db, userId: string): Promise<Array<{ issuer: string; sub: string }>> {
  return db
    .select({ issuer: userIdentities.issuer, sub: userIdentities.sub })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.issuer), asc(userIdentities.sub));
}

/**
 * #187：單一 legacy provider 的 OIDC 整合測試（oidc-login／oidc-callback／handle）共用起手式——`buildTestApp` 注入以 `fetch`
 * 接 fake IdP 的 `createOidcRuntimeRegistry`（OIDC 設定一律來自 DB 的 `auth_providers`，不再讀 config），再
 * seed 一個 legacy provider（＝env 匯入的那一個，走舊網址 `/api/auth/oidc/login`、`/callback`，B13），issuer 與 fake IdP 相同。
 * `config` 就是 `testConfig`：PUBLIC_URL（http://localhost:3000）與 APP_SECRET（"a"×64）與舊 `oidcConfig()` 逐字相同。
 */
export async function legacyOidcApp(
  fetch: CustomFetch,
  issuerUrl: string,
  overrides: Partial<AppDeps> = {},
): Promise<TestApp & { provider: OidcProviderRow; config: AppConfig }> {
  const built = await buildTestApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch }), ...overrides });
  const provider = await seedAuthProvider(built.db, { issuerUrl, legacyCallback: true });
  return { ...built, provider, config: testConfig };
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

/** 多個 in-process fake IdP 共用一個 fetch：依 issuer 前綴分派（fake IdP 本身以路徑尾綴分派、一個 issuer 一份）。 */
export function combineFakeIdpFetch(entries: Array<{ issuer: string; idp: FakeIdp }>): CustomFetch {
  return async (url, options) => {
    const href = String(url);
    const hit = entries.find(e => href.startsWith(e.issuer.replace(/\/$/, "") + "/"));
    if (hit === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return hit.idp.fetch(url, options);
  };
}

export interface OidcTestApp {
  app: FastifyInstance;
  db: Db;
  idp: (key: string) => FakeIdp;
  provider: (key: string) => OidcProviderRow;
}

/** 每個 provider 一份 fake IdP（`idpIssuer` 預設＝`issuerUrl` 去尾斜線）；registry 注入合併後的 fetch。 */
export async function buildOidcApp(
  spec: { providers: Array<{ key: string; idpIssuer?: string } & SeedProviderOpts> },
  overrides: Partial<AppDeps> = {},
): Promise<OidcTestApp> {
  const idps = new Map<string, FakeIdp>();
  const entries: Array<{ issuer: string; idp: FakeIdp }> = [];
  for (const p of spec.providers) {
    const issuer = p.idpIssuer ?? p.issuerUrl.replace(/\/$/, "");
    const existing = entries.find(e => e.issuer === issuer);
    const idp = existing?.idp ?? createFakeIdp(issuer);
    if (existing === undefined) entries.push({ issuer, idp });
    idps.set(p.key, idp);
  }
  const { app, db } = await buildTestApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: combineFakeIdpFetch(entries) }), ...overrides });
  const rows = new Map<string, OidcProviderRow>();
  for (const p of spec.providers) {
    const { key, idpIssuer, ...seed } = p;
    void key;
    void idpIssuer;
    rows.set(p.key, await seedAuthProvider(db, seed));
  }
  return { app, db, idp: k => idps.get(k)!, provider: k => rows.get(k)! };
}

function mergeCookies(base: Record<string, string>, res: InjectResponse): Record<string, string> {
  const next = { ...base };
  for (const c of res.cookies) {
    if (c.value === "") delete next[c.name];
    else next[c.name] = c.value;
  }
  return next;
}

/**
 * login 302 → fakeIdp.authorize → callback。callback 路徑取自 authorize URL 上的 `redirect_uri`（＝也順手驗了 §7.1 的字面），
 * 除非 `callbackPath` 指定（RF1 的大寫路徑、state 錯配那幾案）。
 */
export async function ssoRoundTrip(
  app: FastifyInstance,
  idp: FakeIdp,
  opts: { loginUrl: string; claims: FakeIdpClaims; cookies?: Record<string, string>; callbackPath?: string },
): Promise<SsoRoundTrip> {
  idp.setNextLogin(opts.claims);
  const loginRes = await app.inject({ method: "GET", url: opts.loginUrl, cookies: opts.cookies ?? {} });
  if (loginRes.statusCode !== 302) throw new Error(`login 沒有 302：${loginRes.statusCode} ${loginRes.body}`);
  const location = loginRes.headers.location as string;
  const { code, state } = idp.authorize(location);
  const redirectUri = new URL(location).searchParams.get("redirect_uri")!;
  const afterLogin = mergeCookies(opts.cookies ?? {}, loginRes);
  const path = opts.callbackPath ?? new URL(redirectUri).pathname;
  const callbackRes = await app.inject({
    method: "GET",
    url: `${path}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: afterLogin,
  });
  return { loginRes, callbackRes, redirectUri, cookies: mergeCookies(afterLogin, callbackRes) };
}

export interface SsoRoundTrip {
  loginRes: InjectResponse;
  callbackRes: InjectResponse;
  redirectUri: string;
  cookies: Record<string, string>;
}
