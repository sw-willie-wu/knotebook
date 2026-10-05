import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { buildOidcApp, identitiesOf, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { authProviders, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { sealCookieJson } from "../src/auth/sealed-cookie.js";
import { backfillLegacyOidcIdentities, importLegacyOidcEnv } from "../src/auth/legacy-oidc-env.js";
import pino from "pino";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const now = () => Math.floor(Date.now() / 1000);
const silent = pino({ level: "silent" });

describe("多 provider 的 login／callback（#187 §7.1–§7.4）", () => {
  it("§14.1-13 redirect_uri 字面：一般 provider＝<PUBLIC_URL>/api/auth/oidc/callback/<id>、legacy＝舊路徑；兩者都能走完並建帳", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "l", issuerUrl: B, legacyCallback: true }] });
    const a = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "a@x.example", name: "A" } });
    expect(a.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${t.provider("a").id}`);
    expect(a.callbackRes.headers.location).toBe("/");
    const l = await ssoRoundTrip(t.app, t.idp("l"), { loginUrl: "/api/auth/oidc/login", claims: { sub: "sl", email: "l@x.example", name: "L" } });
    expect(l.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
    expect(l.callbackRes.headers.location).toBe("/");
    // 帶 id 的入口打到 legacy provider 也可以（redirect_uri 仍是舊路徑——legacy 不提供切換，§7.1）。
    const l2 = await ssoRoundTrip(t.app, t.idp("l"), { loginUrl: `/api/auth/oidc/login/${t.provider("l").id}`, claims: { sub: "sl", email: "l@x.example" } });
    expect(l2.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
    expect(l2.callbackRes.headers.location).toBe("/");
  });

  it("S5：A 建的帳號、B（不同 issuer）同 email 首登 → 不自動合併：302 /link-account、pending cookie 帶 B 的身分與目標帳號、零寫入", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B, displayName: "B" }] });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "same@x.example" } });
    const [u] = await t.db.select().from(users).where(eq(users.email, "same@x.example"));
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}?next=%2Fn%2Falice%2Fx`, claims: { sub: "sb", email: "Same@X.example" } });
    expect(r.callbackRes.statusCode).toBe(302);
    expect(r.callbackRes.headers.location).toBe("/link-account");
    expect(r.callbackRes.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
    const pc = r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(pc).toMatchObject({ path: "/api/auth/oidc", httpOnly: true, sameSite: "Lax", maxAge: 900 });
    expect(unsealPendingLink(testConfig.appSecret, pc.value, now())).toMatchObject({
      issuer: B, sub: "sb", providerId: t.provider("b").id, userId: u!.id, email: "same@x.example", next: "/n/alice/x",
    });
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sa" }]);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("§14.1-8 state cookie：providerId 不符 → oidc_state_mismatch；login 後版本變了 → oidc_unavailable；舊格式（無 providerId）→ oidc_state_mismatch", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    const swapped = await ssoRoundTrip(t.app, t.idp("a"), {
      loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "s", email: "s@x.example" },
      callbackPath: `/api/auth/oidc/callback/${t.provider("b").id}`,
    });
    expect(swapped.callbackRes.headers.location).toBe("/login?error=oidc_state_mismatch");

    t.idp("a").setNextLogin({ sub: "s", email: "s@x.example" });
    const loginRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${t.provider("a").id}` });
    const { code, state } = t.idp("a").authorize(loginRes.headers.location as string);
    await t.db.update(authProviders).set({ configVersion: 2 }).where(eq(authProviders.id, t.provider("a").id));
    const cookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const stale = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_STATE_COOKIE]: cookie } });
    expect(stale.headers.location).toBe("/login?error=oidc_unavailable");

    const old = sealCookieJson(testConfig.appSecret, "oidc-state", { state: "x", nonce: "y", codeVerifier: "z", exp: now() + 600 });
    const oldRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("b").id}?code=c&state=x`, cookies: { [OIDC_STATE_COOKIE]: old } });
    expect(oldRes.headers.location).toBe("/login?error=oidc_state_mismatch");
  });

  it("§14.1-9 停用：login 與 callback 都拒（oidc_unavailable）；重新啟用恢復；刪除後以同 issuer 重建 → 原身分照常 login（B1）", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "sa", email: "a@x.example" } });
    const [u] = await t.db.select().from(users);
    t.idp("a").setNextLogin({ sub: "sa", email: "a@x.example" });
    const loginRes = await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${id}` });
    const { code, state } = t.idp("a").authorize(loginRes.headers.location as string);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, id));
    expect((await t.app.inject({ method: "GET", url: `/api/auth/oidc/login/${id}` })).headers.location).toBe("/login?error=oidc_unavailable");
    const cookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${id}?code=${code}&state=${state}`, cookies: { [OIDC_STATE_COOKIE]: cookie } });
    expect(cb.headers.location).toBe("/login?error=oidc_unavailable");
    await t.db.update(authProviders).set({ enabled: true }).where(eq(authProviders.id, id));
    expect((await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "sa", email: "a@x.example" } })).callbackRes.headers.location).toBe("/");
    await t.db.delete(authProviders).where(eq(authProviders.id, id));
    const again = await seedAuthProvider(t.db, { issuerUrl: A });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${again.id}`, claims: { sub: "sa", email: "a@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sa" }]);
  });

  it("W21：註冊關閉時新 email → /login?error=registration_disabled、不建帳；已連結身分照常登入", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "old", email: "old@x.example" } });
    await t.db.update(siteSettings).set({ registrationEnabled: false });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "new", email: "new@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=registration_disabled");
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect((await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "old", email: "old@x.example" } })).callbackRes.headers.location).toBe("/");
  });

  it("r3-M3 claim 上限：email 255 字或 sub 256 字 → oidc_claim_too_long、不封 pending、不建帳；剛好 254／255 → 照常", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const email255 = "e".repeat(255 - "@x.example".length) + "@x.example";
    const email254 = "e".repeat(254 - "@x.example".length) + "@x.example";
    for (const claims of [{ sub: "s1", email: email255 }, { sub: "s".repeat(256), email: "ok@x.example" }]) {
      const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims });
      expect(r.callbackRes.headers.location).toBe("/login?error=oidc_claim_too_long");
      expect(r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    }
    expect(await t.db.select().from(users)).toHaveLength(0);
    const ok = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: "s".repeat(255), email: email254 } });
    expect(ok.callbackRes.headers.location).toBe("/");
  });

  it("RF1：provider id 以大寫出現在 login 與 callback 網址 → 照常完成；送給 IdP 的 redirect_uri 用小寫 id", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const r = await ssoRoundTrip(t.app, t.idp("a"), {
      loginUrl: `/api/auth/oidc/login/${id.toUpperCase()}`, claims: { sub: "sa", email: "a@x.example" },
      callbackPath: `/api/auth/oidc/callback/${id.toUpperCase()}`,
    });
    expect(r.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${id}`);
    expect(r.callbackRes.headers.location).toBe("/");
    expect(r.cookies[SESSION_COOKIE]).toBeDefined();
  });

  it("RF2：兩個啟用中的 provider 指向同一個 issuer → 用 A 建的帳號用 B 直接登入（不是 confirm_link、不建第二個帳號）", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a1", issuerUrl: A, clientId: "c1" }, { key: "a2", issuerUrl: `${A}/`, clientId: "c2", displayName: "Same IdP again" }] });
    await ssoRoundTrip(t.app, t.idp("a1"), { loginUrl: `/api/auth/oidc/login/${t.provider("a1").id}`, claims: { sub: "sa", email: "a@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("a2"), { loginUrl: `/api/auth/oidc/login/${t.provider("a2").id}`, claims: { sub: "sa", email: "a@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    expect(r.cookies[SESSION_COOKIE]).toBeDefined();
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("r1-I1 尾斜線形：provider 填 https://gitlab.example/、IdP 回無斜線 → 登入成功、resolved_issuer 寫成無斜線、身分存 IdP 的值", async () => {
    const t = await buildOidcApp({ providers: [{ key: "g", issuerUrl: "https://gitlab.example/", idpIssuer: "https://gitlab.example" }] });
    const r = await ssoRoundTrip(t.app, t.idp("g"), { loginUrl: `/api/auth/oidc/login/${t.provider("g").id}`, claims: { sub: "sg", email: "g@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/");
    const [p] = await t.db.select({ r: authProviders.resolvedIssuer }).from(authProviders);
    expect(p!.r).toBe("https://gitlab.example");
    const [i] = await t.db.select({ issuer: userIdentities.issuer }).from(userIdentities);
    expect(i!.issuer).toBe("https://gitlab.example");
  });

  it("§14.1-15／16：env 匯入的 legacy provider＋舊回呼網址，接上 0014 搬過來的身分與補登的身分 → 同帳號登入", async () => {
    const idp = createFakeIdp(A);
    const { app, db } = await buildTestApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: idp.fetch }) });
    const [u] = await db.insert(users).values({ email: "legacy@x.example", displayName: "Legacy" }).returning();
    const [v] = await db.insert(users).values({ email: "rolled@x.example", displayName: "Rolled" }).returning();
    await db.insert(userIdentities).values({ userId: u!.id, issuer: A, sub: "migrated" });
    await db.$client.query(`update users set oidc_issuer = $1, oidc_sub = 'rolled-back' where id = $2`, [A, v!.id]);
    await importLegacyOidcEnv(db, { appSecret: testConfig.appSecret, legacyOidcEnv: { issuerUrl: `${A}/`, clientId: "test-client", clientSecret: "test-secret" } }, silent);
    await backfillLegacyOidcIdentities(db, silent);
    for (const [sub, email, userId] of [["migrated", "legacy@x.example", u!.id], ["rolled-back", "rolled@x.example", v!.id]] as const) {
      const r = await ssoRoundTrip(app, idp, { loginUrl: "/api/auth/oidc/login", claims: { sub, email } });
      expect(r.redirectUri).toBe("http://localhost:3000/api/auth/oidc/callback");
      expect(r.callbackRes.headers.location).toBe("/");
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: r.cookies[SESSION_COOKIE]! } });
      expect(me.json().id).toBe(userId);
    }
    const [p] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders);
    expect(p!.r).toBe(A);
  });

  it("§14.1-1 B3：email_verified 為 false、為字串 'true'、或缺 → 結果與 true 相同（照常建帳）", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const id = t.provider("a").id;
    const variants: Array<Record<string, unknown>> = [{ email_verified: false }, { email_verified: "true" }, {}];
    for (const [i, extra] of variants.entries()) {
      const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${id}`, claims: { sub: `b3-${i}`, email: `b3-${i}@x.example`, ...extra } as never });
      expect(r.callbackRes.headers.location).toBe("/");
    }
    expect(await t.db.select().from(users)).toHaveLength(3);
  });

  it("oidc_link_no_proof_method：純 SSO 帳號、它連結的 provider 已停用 → 別的 provider 同 email 首登回該碼（不封 pending）", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "p@x.example" } });
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "p@x.example" } });
    expect(r.callbackRes.headers.location).toBe("/login?error=oidc_link_no_proof_method");
    expect(r.callbackRes.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
  });
});
