import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createOidcRuntime } from "../src/auth/oidc-client.js";
import { OIDC_STATE_COOKIE_PATH, sealOidcState, unsealOidcState } from "../src/auth/oidc-state.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import type { Db } from "../src/db/index.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const ISSUER_URL = "https://idp.example.com";

function oidcConfig(): AppConfig {
  return loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/test",
    APP_SECRET: "a".repeat(64),
    PUBLIC_URL: "http://localhost:3000",
    OIDC_ISSUER_URL: ISSUER_URL,
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-secret",
  });
}

/** login 302 → fakeIdp.authorize(location) 取 code/state——callback 測試流程固定起手式。 */
async function loginAndAuthorize(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  fakeIdp: FakeIdp,
  claims: FakeIdpClaims
): Promise<{ code: string; state: string; cookieValue: string; loginRes: InjectResponse }> {
  fakeIdp.setNextLogin(claims);
  const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  const location = loginRes.headers.location as string;
  const { code, state } = fakeIdp.authorize(location);
  const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  return { code, state, cookieValue, loginRes };
}

function callback(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  params: { code?: string; state?: string; cookieValue?: string }
): Promise<InjectResponse> {
  const query = new URLSearchParams();
  if (params.code !== undefined) query.set("code", params.code);
  if (params.state !== undefined) query.set("state", params.state);
  return app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?${query.toString()}`,
    cookies: params.cookieValue !== undefined ? { [OIDC_STATE_COOKIE]: params.cookieValue } : {},
  });
}

function assertStateMismatch(res: InjectResponse): void {
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
  const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
  expect(cookie).toBeDefined();
  expect(cookie?.value).toBe("");
  expect(cookie?.path).toBe(OIDC_STATE_COOKIE_PATH);
}

async function insertUser(
  db: Db,
  overrides: Partial<typeof users.$inferInsert> & { email: string }
): Promise<typeof users.$inferSelect> {
  const [row] = await db
    .insert(users)
    .values({
      displayName: overrides.email.split("@")[0] ?? overrides.email,
      ...overrides,
    })
    .returning();
  return row!;
}

async function fetchUserByEmail(db: Db, email: string): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
}

async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  db: Db;
  config: AppConfig;
  fakeIdp: FakeIdp;
}> {
  const config = oidcConfig();
  const fakeIdp = createFakeIdp(ISSUER_URL);
  const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
  const { app, db } = await buildTestApp({ config, oidc: runtime });
  return { app, db, config, fakeIdp };
}

describe("GET /api/auth/oidc/callback", () => {
  it("state cookie 缺失 → 302 oidc_state_mismatch，帶清除 cookie", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state } = await loginAndAuthorize(app, fakeIdp, { sub: "u1", email: "new@example.com", email_verified: true });
    const res = await callback(app, { code, state });
    assertStateMismatch(res);
  });

  it("state cookie exp 逾期 → 302 oidc_state_mismatch，帶清除 cookie", async () => {
    const { app, config, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    const now = Math.floor(Date.now() / 1000);
    const payload = unsealOidcState(config.appSecret, cookieValue, now)!;
    const expiredCookie = sealOidcState(config.appSecret, { ...payload, exp: now - 1 });
    const res = await callback(app, { code, state, cookieValue: expiredCookie });
    assertStateMismatch(res);
  });

  it("query state 與 payload 不符 → 302 oidc_state_mismatch，帶清除 cookie", async () => {
    const { app, fakeIdp } = await setup();
    const { code, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    const res = await callback(app, { code, state: "wrong-state", cookieValue });
    assertStateMismatch(res);
  });

  it("token exchange 失敗（token endpoint 500）→ 302 oidc_exchange_failed", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "u1",
      email: "new@example.com",
      email_verified: true,
    });
    fakeIdp.failNext("token");
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
    // MINOR-3：exchange 失敗路徑一樣要清 state cookie（成敗皆清，不只 state_mismatch 路徑）。
    const clearedCookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(clearedCookie?.value).toBe("");
    expect(clearedCookie?.path).toBe(OIDC_STATE_COOKIE_PATH);
  });

  describe("callback 自身的 oidc_unavailable（§14.7：兩端點各自覆蓋，非僅 login）", () => {
    it("OIDC 未設定 → 302 oidc_unavailable", async () => {
      const { app } = await buildTestApp();
      const res = await callback(app, {});
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    });

    it("discovery 失敗（callback 自己呼叫 getConfiguration 時撞到，非沿用 login 已快取的成功結果）→ 302 oidc_unavailable", async () => {
      const { app, config, fakeIdp } = await setup();
      fakeIdp.failNext("discovery");
      // 手動組一顆合法 state cookie（不經 login route）：若透過 login 先跑一次，
      // 會讓 discovery 在那一步就成功並快取，callback 這裡就測不到「callback 自己
      // 第一次呼叫 getConfiguration() 就撞失敗」這條路徑。
      const state = "manual-state";
      const nonce = "manual-nonce";
      const codeVerifier = "manual-code-verifier";
      const nowEpochSeconds = Math.floor(Date.now() / 1000);
      const cookieValue = sealOidcState(config.appSecret, { state, nonce, codeVerifier, exp: nowEpochSeconds + 600 });

      const res = await callback(app, { code: "irrelevant-code", state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    });
  });

  it("email_verified 為非 boolean 值（如字串 'true'，模擬 as-cast 誤用）→ 嚴格視為缺欄位，302 oidc_email_unverified", async () => {
    const { app, db, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "as-cast-sub",
      email: "ascast@example.com",
      email_verified: "true" as unknown as boolean,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_email_unverified");
    expect(await fetchUserByEmail(db, "ascast@example.com")).toBeUndefined();
  });

  it("email claim 為空字串 → 視為缺欄位，302 oidc_email_missing（不建出 email='' 帳號）", async () => {
    const { app, db, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "empty-email-sub",
      email: "",
      email_verified: true,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_email_missing");
    expect(await fetchUserByEmail(db, "")).toBeUndefined();
  });

  describe("N9 帳號解析矩陣", () => {
    it("全新 email（verified）→ 建帳＋登入", async () => {
      const { app, db, fakeIdp } = await setup();
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "new-sub",
        email: "New.User@Example.com",
        email_verified: true,
        name: "New User",
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeDefined();

      const row = await fetchUserByEmail(db, "new.user@example.com");
      expect(row).toBeDefined();
      expect(row?.oidcIssuer).toBe(ISSUER_URL);
      expect(row?.oidcSub).toBe("new-sub");
      expect(row?.passwordHash).toBeNull();
      expect(row?.email).toBe("new.user@example.com");

      // T4 帶入釘：OIDC 自動建帳後用該 session cookie 打 /api/auth/me → hasPassword:false。
      const oidcCookie = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oidcCookie } });
      expect(me.json().hasPassword).toBe(false);
    });

    it("email 命中既有帳號（verified）→ 連結＋登入，之後帳密與 OIDC 雙路皆可登入", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, { email: "existing@example.com", passwordHash: await hashPassword("Password123!") });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "existing-sub",
        email: "existing@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");

      const row = await fetchUserByEmail(db, "existing@example.com");
      expect(row?.oidcIssuer).toBe(ISSUER_URL);
      expect(row?.oidcSub).toBe("existing-sub");

      // 帳密路徑仍可登入。
      const passwordLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "Password123!" },
      });
      expect(passwordLogin.statusCode).toBe(200);

      // OIDC 路徑二度登入仍成功（冪等，見下方獨立測試進一步釘）。
      const { code: code2, state: state2, cookieValue: cookie2 } = await loginAndAuthorize(app, fakeIdp, {
        sub: "existing-sub",
        email: "existing@example.com",
        email_verified: true,
      });
      const res2 = await callback(app, { code: code2, state: state2, cookieValue: cookie2 });
      expect(res2.statusCode).toBe(302);
      expect(res2.headers.location).toBe("/");
    });

    it("verified=false（新 email）→ 302 oidc_email_unverified，不建帳", async () => {
      const { app, db, fakeIdp } = await setup();
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-unverified",
        email: "unverified@example.com",
        email_verified: false,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_unverified");
      expect(await fetchUserByEmail(db, "unverified@example.com")).toBeUndefined();
    });

    it("verified 缺（ID token 與 userinfo 皆無）→ 302 oidc_email_unverified，不建帳", async () => {
      const { app, db, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email_verified"]);
      fakeIdp.omitFromMetadata(["userinfo_endpoint"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-missing-verified",
        email: "missingverified@example.com",
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_unverified");
      expect(await fetchUserByEmail(db, "missingverified@example.com")).toBeUndefined();
    });

    it("email 命中既有帳號但 verified=false → 302 oidc_email_unverified，不連結（DB 斷言 oidc 欄未寫入）", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, { email: "linkunverified@example.com" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "link-unverified-sub",
        email: "linkunverified@example.com",
        email_verified: false,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_unverified");

      const row = await fetchUserByEmail(db, "linkunverified@example.com");
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();
    });

    it("email 命中既有帳號但 verified 缺（ID token 與 userinfo 皆無）→ 302 oidc_email_unverified，不連結", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, { email: "linkmissingverified@example.com" });
      fakeIdp.omitFromIdToken(["email_verified"]);
      fakeIdp.omitFromMetadata(["userinfo_endpoint"]);

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "link-missing-verified-sub",
        email: "linkmissingverified@example.com",
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_unverified");

      const row = await fetchUserByEmail(db, "linkmissingverified@example.com");
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();
    });

    it("已綁其他 (issuer,sub) → 302 oidc_conflict，不覆寫（DB 斷言原值）", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, { email: "conflict@example.com", oidcIssuer: ISSUER_URL, oidcSub: "original-sub" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "different-sub",
        email: "conflict@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_conflict");

      const row = await fetchUserByEmail(db, "conflict@example.com");
      expect(row?.oidcSub).toBe("original-sub");
    });

    it("停用帳號經 email 連結路徑 → 302 account_disabled，不寫入", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, { email: "disabled@example.com", disabledAt: new Date() });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-sub",
        email: "disabled@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=account_disabled");

      const row = await fetchUserByEmail(db, "disabled@example.com");
      expect(row?.oidcIssuer).toBeNull();
    });

    it("停用帳號 (issuer,sub) 命中 → 302 account_disabled", async () => {
      const { app, db, fakeIdp } = await setup();
      await insertUser(db, {
        email: "disabled2@example.com",
        oidcIssuer: ISSUER_URL,
        oidcSub: "disabled-idsub",
        disabledAt: new Date(),
      });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-idsub",
        email: "disabled2@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=account_disabled");
    });
  });

  describe("userinfo 補打矩陣", () => {
    it("僅缺 email_verified → userinfo 被打恰一次，合併後成功", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email_verified"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv1",
        email: "uv1@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });

    it("僅缺 email → userinfo 被打恰一次，合併後成功", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv2",
        email: "uv2@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });

    it("皆缺 → userinfo 被打恰一次，合併後成功", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email", "email_verified"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv3",
        email: "uv3@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });

    it("metadata 無 userinfo_endpoint → 不打，按缺失欄位走對應錯誤", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      fakeIdp.omitFromMetadata(["userinfo_endpoint"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv4",
        email: "uv4@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_email_missing");
      expect(fakeIdp.counts.userinfo).toBe(0);
    });

    it("ID token 有 email、userinfo 回不同 email（分歧）→ 逐欄位合併以 ID token 為準", async () => {
      const { app, db, fakeIdp } = await setup();
      // ID token 缺 email_verified（觸發 userinfo 補打），但 email 本身在 ID token 上有值。
      fakeIdp.omitFromIdToken(["email_verified"]);
      fakeIdp.overrideNextUserinfo({ email: "userinfo-diverged@example.com", email_verified: true });
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "idtoken-wins-sub",
        email: "idtoken-wins@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(1);

      expect(await fetchUserByEmail(db, "idtoken-wins@example.com")).toBeDefined();
      expect(await fetchUserByEmail(db, "userinfo-diverged@example.com")).toBeUndefined();
    });

    it("userinfo 500 → 302 oidc_exchange_failed", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email_verified"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv5",
        email: "uv5@example.com",
        email_verified: true,
      });
      fakeIdp.failNext("userinfo");
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
    });
  });

  it("Mixed-Case claim（verified）命中既有小寫帳號 → 連結而非建帳，不觸 unique-violation", async () => {
    const { app, db, fakeIdp } = await setup();
    await insertUser(db, { email: "mixed@example.com" });

    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "mixed-sub",
      email: "Mixed@Example.com",
      email_verified: true,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");

    const rows = await db.select().from(users).where(eq(users.email, "mixed@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oidcSub).toBe("mixed-sub");
  });

  it("冪等：同 (issuer,sub) 二度 callback → 不重建帳號，直接登入", async () => {
    const { app, db, fakeIdp } = await setup();
    const claims: FakeIdpClaims = { sub: "idem-sub", email: "idem@example.com", email_verified: true };

    const first = await loginAndAuthorize(app, fakeIdp, claims);
    const res1 = await callback(app, first);
    expect(res1.statusCode).toBe(302);
    expect(res1.headers.location).toBe("/");

    const second = await loginAndAuthorize(app, fakeIdp, claims);
    const res2 = await callback(app, second);
    expect(res2.statusCode).toBe(302);
    expect(res2.headers.location).toBe("/");

    const rows = await db.select().from(users).where(eq(users.email, "idem@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("race：兩個並發 callback 同時試圖建立同一 email 帳號 → 轉譯重查成功，非 500", async () => {
    const { app, db, fakeIdp } = await setup();
    const claims: FakeIdpClaims = { sub: "race-sub", email: "race@example.com", email_verified: true };

    const first = await loginAndAuthorize(app, fakeIdp, claims);
    const second = await loginAndAuthorize(app, fakeIdp, claims);

    const [res1, res2] = await Promise.all([callback(app, first), callback(app, second)]);

    expect(res1.statusCode).toBe(302);
    expect(res1.headers.location).toBe("/");
    expect(res2.statusCode).toBe(302);
    expect(res2.headers.location).toBe("/");

    const rows = await db.select().from(users).where(eq(users.email, "race@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oidcSub).toBe("race-sub");
  });

  it("gate 快取一致性：admin 代建帳號（暖 gate 快取）→ OIDC 連結後 /api/auth/me 立即 mustChangePassword:false", async () => {
    const { app, db, fakeIdp } = await setup();
    await insertUser(db, {
      email: "gatecache@example.com",
      passwordHash: await hashPassword("Password123!"),
      mustChangePassword: true,
    });

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "gatecache@example.com", password: "Password123!" },
    });
    expect(passwordLogin.statusCode).toBe(200);
    const passwordCookie = passwordLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    // 暖 gate 快取。
    const meBefore = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: passwordCookie } });
    expect(meBefore.json().mustChangePassword).toBe(true);

    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "gatecache-sub",
      email: "gatecache@example.com",
      email_verified: true,
    });
    const callbackRes = await callback(app, { code, state, cookieValue });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe("/");
    const oidcCookie = callbackRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oidcCookie } });
    expect(meAfter.statusCode).toBe(200);
    expect(meAfter.json().mustChangePassword).toBe(false);

    const row = await fetchUserByEmail(db, "gatecache@example.com");
    expect(row?.mustChangePassword).toBe(false);

    // 密碼仍有效（殘留面：連結不清密碼）。
    const passwordLoginAgain = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "gatecache@example.com", password: "Password123!" },
    });
    expect(passwordLoginAgain.statusCode).toBe(200);
  });

  it("callback limiter：同一 IP 第 30 次仍放行、第 31 次請求 → 302 too_many_requests（非 JSON）", async () => {
    const { app } = await setup();

    let res: InjectResponse | undefined;
    for (let i = 0; i < 31; i += 1) {
      res = await callback(app, {});
      if (i === 29) {
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
      }
    }
    expect(res!.statusCode).toBe(302);
    expect(res!.headers.location).toBe("/login?error=too_many_requests");
    // 非 JSON：302 redirect 本身沒有 JSON body/content-type（有值的話也不該是 json）。
    if (res!.headers["content-type"] !== undefined) {
      expect(res!.headers["content-type"]).not.toMatch(/json/);
    }
  });
});

// ── #131：callback 的 return-to ──────────────────────────────────────────────
//
// 成功導向 state cookie 裡那個 next（沒有就 `/`）；失敗導回 /login?error=… 時，只要
// cookie 已經解開過就把 next 一併帶上——那是 OIDC 正常流程的一部分，使用者修正錯誤後
// 還要回得去原本那頁。cookie 解開之前的出口（cookie 缺、unseal 失敗、限流、未設定）
// 拿不到 next，輸出與 #131 之前逐字相同。
describe("#131 callback 的 return-to", () => {
  const claims: FakeIdpClaims = { sub: "s-131", email: "next@example.com", email_verified: true, name: "Next" };

  /** login 帶 next → IdP → callback，回傳 callback 的 302 location。 */
  async function flowWithNext(nextQuery: string, overrideClaims: FakeIdpClaims = claims): Promise<string> {
    const { app, fakeIdp } = await setup();
    fakeIdp.setNextLogin(overrideClaims);
    const loginRes = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/login?next=${encodeURIComponent(nextQuery)}`,
    });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    return res.headers.location as string;
  }

  it("成功 → 導向 next（不是 `/`）", async () => {
    expect(await flowWithNext("/n/alice/my-note?x=1")).toBe("/n/alice/my-note?x=1");
  });

  it("沒有 next → 仍導 `/`（既有行為不變）", async () => {
    const { app, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, claims);

    const res = await callback(app, { code, state, cookieValue });

    expect(res.headers.location).toBe("/");
  });

  it("2049 字元 next → 落 `/`（跨層冒煙；長度關本身由 oidc-login.test.ts 的 2048/2049 那案守）", async () => {
    expect(await flowWithNext("/" + "a".repeat(2048))).toBe("/");
  });

  it("unseal 後再驗：手動封一顆帶跨站 next 的 cookie → 落 `/`", async () => {
    // 這是唯一能單獨殺掉「unseal 後再驗一次」那行的形——正常流程裡 login 端已先擋掉，
    // 只有偽造 payload（或判準日後收緊、舊 cookie 還在飛）才走得到。
    const { app, config, fakeIdp } = await setup();
    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, claims);
    const payload = unsealOidcState(config.appSecret, cookieValue, Math.floor(Date.now() / 1000))!;
    const tampered = sealOidcState(config.appSecret, { ...payload, next: "//evil.example" });

    const res = await callback(app, { code, state, cookieValue: tampered });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("失敗（email 未驗證）→ /login?error=…&next=…（next 有 encode）", async () => {
    const unverified: FakeIdpClaims = { sub: "s-131b", email: "unv@example.com", email_verified: false, name: "U" };

    expect(await flowWithNext("/n/alice/my-note?x=1", unverified)).toBe(
      "/login?error=oidc_email_unverified&next=%2Fn%2Falice%2Fmy-note%3Fx%3D1",
    );
  });

  it("state 參數不符（cookie 已解開、next 已知）→ 錯誤導回也帶 next", async () => {
    const { app, fakeIdp } = await setup();
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    const { code } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;

    const res = await callback(app, { code, state: "not-the-state", cookieValue });

    expect(res.headers.location).toBe("/login?error=oidc_state_mismatch&next=%2Fn%2Falice%2Fmy-note");
  });

  it("cookie 缺失、但 query 帶了 next → 逐字無 next（不得從 query 撿）", async () => {
    // `next` 的**唯一**來源是密封 cookie。從 query 撿的話，攻擊者就能用自己的連結決定
    // 別人失敗後被送去哪。⚠ query 一定要真的帶 next，否則這一案恆綠：不撿也是同一個
    // 字串（實測過，那樣連「在宣告處直接從 query 撿」的突變都殺不掉）。
    const { app } = await setup();

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=c&state=s&next=%2Fattacker-page",
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_state_mismatch");
  });

  it("cookie 與 query 各帶一個 next → 採 cookie 那個（query 不參與）", async () => {
    // 上一案守的是「解開之前不撿」，這一案守「解開之後也不撿」——兩者少任何一個，
    // 「query ?? payload」這種寫法就有一半殺不掉。
    const { app, fakeIdp } = await setup();
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${code}&state=${state}&next=%2Fattacker-page`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/n/alice/my-note");
  });
});
