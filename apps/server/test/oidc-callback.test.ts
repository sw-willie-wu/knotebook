import { describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { identitiesOf, legacyOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import type { AppConfig } from "../src/config.js";
import { OIDC_STATE_COOKIE_PATH, sealOidcState, unsealOidcState } from "../src/auth/oidc-state.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import type { OidcProviderRow } from "../src/auth/oidc-providers.js";
import { userIdentities, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { UserGate } from "../src/auth/session.js";
import type { Db } from "../src/db/index.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const ISSUER_URL = "https://idp.example.com";

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

/**
 * #187：seed 一個 legacy provider（舊網址——本檔順帶守住 B13 的書籤相容）＋in-process fake IdP。
 * 身分以 IdP 的 metadata.issuer（＝ISSUER_URL）存進 user_identities；`users.oidc_*` 新碼一律不寫。
 */
async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  db: Db;
  config: AppConfig;
  fakeIdp: FakeIdp;
  provider: OidcProviderRow;
}> {
  const fakeIdp = createFakeIdp(ISSUER_URL);
  const { app, db, config, provider } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);
  return { app, db, config, fakeIdp, provider };
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
    it("沒有 legacy provider → 302 oidc_unavailable；legacy provider 停用 → 同（provider 檢查在 cookie 解開之前，不帶 next）", async () => {
      const { app, db } = await buildTestApp();
      const none = await callback(app, {});
      expect(none.statusCode).toBe(302);
      expect(none.headers.location).toBe("/login?error=oidc_unavailable");

      await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true, enabled: false });
      const disabled = await callback(app, {});
      expect(disabled.statusCode).toBe(302);
      expect(disabled.headers.location).toBe("/login?error=oidc_unavailable");
    });

    it("discovery 失敗（callback 自己呼叫 getConfiguration 時撞到，非沿用 login 已快取的成功結果）→ 302 oidc_unavailable", async () => {
      const { app, config, fakeIdp, provider } = await setup();
      fakeIdp.failNext("discovery");
      // 手動組一顆合法 state cookie（不經 login route）：若透過 login 先跑一次，會讓 discovery 在那一步就成功並快取，
      // callback 這裡就測不到「callback 自己第一次呼叫 getConfiguration() 就撞失敗」這條路徑。
      // #187 §7.3：手封的 cookie 也要帶新必要欄位（綁到 seed 的 legacy provider、當下版本、intent login），否則在
      // providerId 那一關就落 oidc_state_mismatch，測不到 discovery 這條。
      const state = "manual-state";
      const nonce = "manual-nonce";
      const codeVerifier = "manual-code-verifier";
      const nowEpochSeconds = Math.floor(Date.now() / 1000);
      const cookieValue = sealOidcState(config.appSecret, {
        state,
        nonce,
        codeVerifier,
        exp: nowEpochSeconds + 600,
        providerId: provider.id,
        configVersion: provider.configVersion,
        intent: "login",
      });

      const res = await callback(app, { code: "irrelevant-code", state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
      // 確實走到 discovery（不是更早的 state 檢查）：callback 自己打了恰一次。
      expect(fakeIdp.counts.discovery).toBe(1);
    });

    it("provider id 不是 UUID（/api/auth/oidc/callback/not-a-uuid）→ 302 oidc_unavailable，不碰 IdP（discovery 0 次）", async () => {
      const { app, fakeIdp } = await setup();
      const res = await app.inject({ method: "GET", url: "/api/auth/oidc/callback/not-a-uuid?code=x&state=y" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_unavailable");
      expect(fakeIdp.counts.discovery).toBe(0);
    });
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
    it("全新 email → 建帳＋登入；身分寫進 user_identities（issuer＝IdP 的 metadata.issuer），舊欄 users.oidc_* 不寫", async () => {
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
      expect(await identitiesOf(db, row!.id)).toEqual([{ issuer: ISSUER_URL, sub: "new-sub" }]);
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();
      expect(row?.passwordHash).toBeNull();
      expect(row?.email).toBe("new.user@example.com");

      // T4 帶入釘：OIDC 自動建帳後用該 session cookie 打 /api/auth/me → hasPassword:false。
      const oidcCookie = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oidcCookie } });
      expect(me.json().hasPassword).toBe(false);
    });

    it("gate 快取：create 分支（寫了 users）→ gate.invalidate(新帳號) 恰一次；同一身分再登入（login 分支，不寫 users）→ 不 invalidate（spec §7.4、B15）", async () => {
      // 新帳號的 id 是交易內現產的 uuid，gate 不可能事先快取它——「漏 invalidate」沒有可從 HTTP 觀察的後果，只能 spy。
      const invalidate = vi.spyOn(UserGate.prototype, "invalidate");
      onTestFinished(() => invalidate.mockRestore());
      const { app, db, fakeIdp } = await setup();
      const claims: FakeIdpClaims = { sub: "gate-inv-sub", email: "gate-inv@example.com", name: "G" };

      const created = await callback(app, await loginAndAuthorize(app, fakeIdp, claims));
      expect(created.headers.location).toBe("/");
      const row = await fetchUserByEmail(db, "gate-inv@example.com");
      expect(invalidate.mock.calls).toEqual([[row!.id]]);

      invalidate.mockClear();
      const loggedIn = await callback(app, await loginAndAuthorize(app, fakeIdp, claims));
      expect(loggedIn.headers.location).toBe("/");
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("email 命中既有帳號（有密碼、未連結）→ 302 /link-account：不簽 session、封 pending cookie、零寫入（S5：不再自動連結）；帳密照常可登入", async () => {
      const { app, db, fakeIdp } = await setup();
      const existing = await insertUser(db, { email: "existing@example.com", passwordHash: await hashPassword("Password123!") });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "existing-sub",
        email: "existing@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBeTruthy();
      expect(await identitiesOf(db, existing.id)).toEqual([]);
      const row = await fetchUserByEmail(db, "existing@example.com");
      expect(row?.oidcIssuer).toBeNull();
      expect(row?.oidcSub).toBeNull();

      // 帳密路徑照常可登入（沒有被這次 SSO 動到）。
      const passwordLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "Password123!" },
      });
      expect(passwordLogin.statusCode).toBe(200);
    });

    it("帳號已連結同 issuer 的另一個 sub → 證明前仍是 /link-account（B14：不揭露 B2）、原身分不動", async () => {
      const { app, db, fakeIdp } = await setup();
      // ⚠ 要有密碼：同 issuer 的 provider 不列為證明方式（Task 6 fix round 1 裁定 A——列出來就等於在證明前告訴對方「這帳號
      // 已連過這個 IdP」），所以沒有密碼的純 SSO 帳號在這裡會落 oidc_link_no_proof_method，測不到 B14（brief 原稿無密碼，實跑即落該碼）。
      const row0 = await insertUser(db, { email: "conflict@example.com", passwordHash: await hashPassword("Password123!") });
      await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "original-sub" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "different-sub",
        email: "conflict@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(await identitiesOf(db, row0.id)).toEqual([{ issuer: ISSUER_URL, sub: "original-sub" }]);
    });

    it("停用帳號經 email（有密碼、未連結）→ 302 /link-account（B14：證明前不揭露停用）、不簽 session、零寫入", async () => {
      const { app, db, fakeIdp } = await setup();
      // ⚠ 要有密碼：沒有密碼、又沒連任何 provider 的帳號會落 oidc_link_no_proof_method（§7.4 第 4.1 步），測不到 B14。
      const row0 = await insertUser(db, {
        email: "disabled@example.com",
        passwordHash: await hashPassword("Password123!"),
        disabledAt: new Date(),
      });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-sub",
        email: "disabled@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/link-account");
      expect(res.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
      expect(await identitiesOf(db, row0.id)).toEqual([]);
    });

    it("停用帳號 (issuer,sub) 命中 → 302 account_disabled、不寫 last_login_at", async () => {
      const { app, db, fakeIdp } = await setup();
      const row0 = await insertUser(db, { email: "disabled2@example.com", disabledAt: new Date() });
      await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "disabled-idsub" });

      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "disabled-idsub",
        email: "disabled2@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=account_disabled");
      const [identity] = await db.select().from(userIdentities).where(eq(userIdentities.userId, row0.id));
      expect(identity!.lastLoginAt).toBeNull();
    });
  });

  describe("userinfo 補打矩陣", () => {
    it("ID token 有 email、缺 email_verified → 不打 userinfo（r2-M4）、以 ID token 的 email 照常建帳——userinfo 就算會回別的 email 也不採用", async () => {
      const { app, db, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email_verified"]);
      // 預置一個分歧的 userinfo：只要有任何寫法多打了 userinfo 並採用它的 email，下面兩條 fetchUserByEmail 會反過來。
      fakeIdp.overrideNextUserinfo({ email: "userinfo-diverged@example.com" });
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv1",
        email: "uv1@example.com",
        email_verified: true,
      });
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(fakeIdp.counts.userinfo).toBe(0);
      expect(await fetchUserByEmail(db, "uv1@example.com")).toBeDefined();
      expect(await fetchUserByEmail(db, "userinfo-diverged@example.com")).toBeUndefined();
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

    it("userinfo 500（ID token 缺 email 才會打）→ 302 oidc_exchange_failed", async () => {
      const { app, fakeIdp } = await setup();
      fakeIdp.omitFromIdToken(["email"]);
      const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
        sub: "u-uv5",
        email: "uv5@example.com",
        email_verified: true,
      });
      fakeIdp.failNext("userinfo");
      const res = await callback(app, { code, state, cookieValue });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
      expect(fakeIdp.counts.userinfo).toBe(1);
    });
  });

  it("Mixed-Case email claim 命中既有小寫帳號（有密碼）→ /link-account、不建帳、不撞 unique-violation；pending 帶正規化後的 email", async () => {
    const { app, db, config, fakeIdp } = await setup();
    const existing = await insertUser(db, { email: "mixed@example.com", passwordHash: await hashPassword("Password123!") });

    const { code, state, cookieValue } = await loginAndAuthorize(app, fakeIdp, {
      sub: "mixed-sub",
      email: "Mixed@Example.com",
      email_verified: true,
    });
    const res = await callback(app, { code, state, cookieValue });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/link-account");

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await identitiesOf(db, existing.id)).toEqual([]);
    const pending = res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(unsealPendingLink(config.appSecret, pending.value, Math.floor(Date.now() / 1000))).toMatchObject({
      userId: existing.id,
      email: "mixed@example.com",
      sub: "mixed-sub",
    });
  });

  it("冪等：同 (issuer,sub) 二度 callback → 不重建帳號、不重複身分，直接登入", async () => {
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
    expect(await identitiesOf(db, rows[0]!.id)).toEqual([{ issuer: ISSUER_URL, sub: "idem-sub" }]);
  });

  it("race：兩個並發 callback 同時試圖建立同一 email 帳號 → 撞唯一鍵整 tx 重投一次、重查命中身分，兩個都 302 /（非 500）", async () => {
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
    expect(await identitiesOf(db, rows[0]!.id)).toEqual([{ issuer: ISSUER_URL, sub: "race-sub" }]);
    expect(rows[0]?.oidcSub).toBeNull();
  });

  it("B15：mustChangePassword:true 的帳號以已連結身分 SSO 登入 → 302 /、旗標不清（/api/auth/me 與 DB 皆仍 true）；gate 快取已暖也不吐錯值", async () => {
    const { app, db, fakeIdp } = await setup();
    const row0 = await insertUser(db, {
      email: "gatecache@example.com",
      passwordHash: await hashPassword("Password123!"),
      mustChangePassword: true,
    });
    await db.insert(userIdentities).values({ userId: row0.id, issuer: ISSUER_URL, sub: "gatecache-sub" });

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "gatecache@example.com", password: "Password123!" },
    });
    expect(passwordLogin.statusCode).toBe(200);
    const passwordCookie = passwordLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    // 暖 gate 快取：login 分支不寫 users、不 invalidate（B15）——快取裡的值本來就對，這一步守的是「不會因此吐出錯的值」。
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
    expect(meAfter.json().mustChangePassword).toBe(true);

    const row = await fetchUserByEmail(db, "gatecache@example.com");
    expect(row?.mustChangePassword).toBe(true);

    // 密碼仍有效（SSO 登入不碰密碼）。
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

  /** login 帶 next → IdP → callback，回傳 callback 的 302 location。`prepare` 在 login 之前對 fake IdP 動手腳（例如拿掉 userinfo）。 */
  async function flowWithNext(
    nextQuery: string,
    overrideClaims: FakeIdpClaims = claims,
    prepare: (fakeIdp: FakeIdp) => void = () => {},
  ): Promise<string> {
    const { app, fakeIdp } = await setup();
    prepare(fakeIdp);
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
    // Task 11 起 payload 是聯集（prove 形沒有 next）：先收窄再展開，否則 `{ ...payload, next }` 是 TS2345（gate r2 t8-14 I1）。
    if (payload.intent !== "login") throw new Error("unreachable：login 端點封的 state cookie 一定是 login 形");
    const tampered = sealOidcState(config.appSecret, { ...payload, next: "//evil.example" });

    const res = await callback(app, { code, state, cookieValue: tampered });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("失敗（email 缺）→ /login?error=…&next=…（next 有 encode）", async () => {
    // 原本用「email 未驗證」造失敗；#187 起那個判斷不存在（B3），改用 cookie 解開之後、決策層的另一個失敗：email 缺
    // （ID token 沒有 email、metadata 也沒有 userinfo endpoint → 無處可補）。
    const noEmail: FakeIdpClaims = { sub: "s-131b", name: "U" };

    expect(
      await flowWithNext("/n/alice/my-note?x=1", noEmail, idp => idp.omitFromMetadata(["userinfo_endpoint"])),
    ).toBe("/login?error=oidc_email_missing&next=%2Fn%2Falice%2Fmy-note%3Fx%3D1");
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
