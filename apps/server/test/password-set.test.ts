import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, users } from "../src/db/schema.js";
import { signSession } from "../src/auth/session.js";
import { buildTestApp, insertPasswordUser, testConfig, type TestApp } from "./helpers.js";
import { cookieOf, seedUser, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});
import { HashBusyError, hashPassword, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(hashPassword).mockClear());

const NEW_PW = "brand-new-password-123";
const setPw = (app: TestApp["app"], cookies: Record<string, string>, payload: object = { newPassword: NEW_PW }) =>
  app.inject({ method: "POST", url: "/api/auth/password/set", cookies, payload });

async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}

describe("POST /api/auth/password/set（#187 §8.4、B12）", () => {
  it("純 SSO 成功 → 204、bump token_version、本人新 cookie 有效、舊 cookie 失效；之後可用密碼登入；onUserRevoked 一次", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const u = await seedUser(db);
    const old = await cookieOf(u.id);
    const res = await setPw(app, old);
    expect(res.statusCode).toBe(204);
    const fresh = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: fresh } })).json()).toMatchObject({ hasPassword: true });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: old })).statusCode).toBe(401);
    const [row] = await db.select({ tv: users.tokenVersion, h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(row!.tv).toBe(1);
    expect(await verifyPassword(row!.h!, NEW_PW)).toBe(true);
    expect(collabHooks.onUserRevoked).toHaveBeenCalledWith(u.id);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: NEW_PW } })).statusCode).toBe(200);
  });

  it("已有密碼 → 409 password_already_set、不改；C14 雙送出 → 第一次 204、第二次 409", async () => {
    const { app, db } = await buildTestApp();
    const p = await insertPasswordUser(db);
    expect((await setPw(app, await cookieOf(p.id))).json().error.code).toBe("password_already_set");
    const u = await seedUser(db);
    const first = await setPw(app, await cookieOf(u.id));
    expect(first.statusCode).toBe(204);
    const fresh = { [SESSION_COOKIE]: first.cookies.find(c => c.name === SESSION_COOKIE)!.value };
    expect((await setPw(app, fresh, { newPassword: "another-password-456" })).json().error.code).toBe("password_already_set");
  });

  it("太短 → 400 password_too_short；body 不合 → 400；未登入／Bearer → 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    expect((await setPw(app, await cookieOf(u.id), { newPassword: "short" })).json().error.code).toBe("password_too_short");
    expect((await setPw(app, await cookieOf(u.id), { newPassword: NEW_PW, extra: 1 })).json().error.code).toBe("invalid_body");
    expect((await app.inject({ method: "POST", url: "/api/auth/password/set", payload: { newPassword: NEW_PW } })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/password/set", headers: { authorization: "Bearer knb_x" }, payload: { newPassword: NEW_PW } })).statusCode,
    ).toBe(401);
  });

  it("HashBusyError → 429 server_busy、不改", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    expect((await setPw(app, await cookieOf(u.id))).json().error.code).toBe("server_busy");
    const [row] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(row!.h).toBeNull();
  });

  it("B22：有效值關 → 403 password_login_disabled（不 hash）；env 強制＋DB 關 → 204（看有效值，gate r4-M6）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await setPw(app, await cookieOf(u.id))).json().error.code).toBe("password_login_disabled");
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const v = await seedUser(forced.db);
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await setPw(forced.app, await cookieOf(v.id))).statusCode).toBe(204);
  });

  it("B22／B23：關閉期間 POST /api/auth/password（改密碼）照常成功並清 must_change_password；旗標帳號 /me 仍回 true", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { mustChangePassword: true });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().mustChangePassword).toBe(true);
    const res = await app.inject({ method: "POST", url: "/api/auth/password", cookies, payload: { currentPassword: u.password, newPassword: NEW_PW } });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
    expect(row!.m).toBe(false);
  });

  it("B23：關閉期間旗標帳號建 PAT → 403（既有擋法照常）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { mustChangePassword: true });
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const res = await app.inject({ method: "POST", url: "/api/auth/tokens", cookies: await cookieOf(u.id), payload: { name: "x", scope: "notes:read", expiresInDays: 30 } });
    expect(res.statusCode).toBe(403);
  });

  it("C10 第二形：另一連線先做「加上密碼」（未提交）→ 這邊解除最後一個身分等它提交 → 讀到有密碼 → 204", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", enabled: false, clientSecret: null });
    const u = await seedUser(db);
    const [ident] = (await db.execute<{ id: string }>(sql`insert into user_identities (user_id, issuer, sub) values (${u.id}, 'https://a.example', 'sa') returning id`)).rows;
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("update users set password_hash = $1, token_version = token_version + 1 where id = $2 and password_hash is null", [await hashPassword(NEW_PW), u.id]);
      const pending = app.inject({ method: "DELETE", url: `/api/auth/identities/${ident!.id}`, cookies: { [SESSION_COOKIE]: await signSession(testConfig.appSecret, { userId: u.id, tv: 0 }) } });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
  });
});
