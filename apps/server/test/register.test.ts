import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { handles, siteSettings, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters, insertPasswordUser, testConfig, type TestApp } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});
import { HashBusyError, hashPassword, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(hashPassword).mockClear());

const PW = "correct-horse-battery-staple";
const NUL = String.fromCodePoint(0);
const register = (app: TestApp["app"], payload: object) => app.inject({ method: "POST", url: "/api/auth/register", payload });

/** 另一條連線（同 test/admin-auth-patch.test.ts:171-175）。 */
async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}

describe("POST /api/auth/register（#187 §9.1、B9）", () => {
  it("成功 → 201 UserDto、簽 session（可打 /me）、must_change_password=false、handle 派生自 email local-part", async () => {
    const { app, db } = await buildTestApp();
    const res = await register(app, { email: "new.user@example.com", password: PW, displayName: "New User" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "new.user@example.com", displayName: "New User", isAdmin: false, mustChangePassword: false, hasPassword: true });
    const session = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: session } });
    expect(me.json().id).toBe(res.json().id);
    const [row] = await db.select().from(users).where(eq(users.id, res.json().id));
    expect(row!.mustChangePassword).toBe(false);
    expect(await verifyPassword(row!.passwordHash!, PW)).toBe(true);
    expect(row!.handle).toBe("new-user");
    const [h] = await db.select().from(handles).where(eq(handles.userId, row!.id));
    expect(h).toMatchObject({ handle: "new-user", state: "live" });
  });

  it("沒給顯示名 → 用 email local-part", async () => {
    const { app } = await buildTestApp();
    const res = await register(app, { email: "solo@example.com", password: PW });
    expect(res.json().displayName).toBe("solo");
  });

  it("RF1：email 前後空白與大寫 → 存成正規化小寫；之後以小寫登入成功；顯示名含 NUL → 400、不是 500", async () => {
    const { app, db } = await buildTestApp();
    const res = await register(app, { email: "  Alice@X.Example ", password: PW });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe("alice@x.example");
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alice@x.example", password: PW } });
    expect(login.statusCode).toBe(200);
    const bad = await register(app, { email: "bob@x.example", password: PW, displayName: `Bo${NUL}b` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_body");
    expect(bad.json().error.message).toMatch(/[一-鿿]/);
    expect(await db.select().from(users).where(eq(users.email, "bob@x.example"))).toEqual([]);
  });

  it("疑點 4 上限（總管裁定）：email 255 字元 → 400（中文訊息）、254 → 201；顯示名 101 個 code point → 400、100 個 → 201", async () => {
    const { app, db } = await buildTestApp();
    const emailOf = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
    const long = await register(app, { email: emailOf(255), password: PW });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe("email 不得超過 254 個字元");
    const longLocal = await register(app, { email: emailOf(254), password: PW });
    expect(longLocal.statusCode).toBe(201);
    // R1（I1）：不帶顯示名時預設值＝local-part（242 字元）截到前 100 個 code point。
    expect(longLocal.json().displayName).toBe("a".repeat(100));
    const [longRow] = await db.select().from(users).where(eq(users.id, longLocal.json().id));
    expect(longRow!.displayName).toBe("a".repeat(100));
    const tooLongName = await register(app, { email: "n1@example.com", password: PW, displayName: "😀".repeat(101) });
    expect(tooLongName.json().error).toEqual({ code: "invalid_body", message: "顯示名稱不得超過 100 個字" });
    expect((await register(app, { email: "n2@example.com", password: PW, displayName: "😀".repeat(100) })).statusCode).toBe(201);
  });

  it("email 已存在 → 409；r2-M8：既有 `Alice@x`（大小寫混合舊列）時以 `alice@x` 註冊 → 409 email_taken", async () => {
    const { app, db } = await buildTestApp();
    await insertPasswordUser(db, { email: "taken@example.com" });
    expect((await register(app, { email: "taken@example.com", password: PW })).json().error.code).toBe("email_taken");
    await db.insert(users).values({ email: "Legacy@Example.com", displayName: "Old" });
    const res = await register(app, { email: "legacy@example.com", password: PW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("email_taken");
  });

  it("密碼太短 → 400 password_too_short；body 不合 → 400 invalid_body（中文訊息）", async () => {
    const { app } = await buildTestApp();
    expect((await register(app, { email: "a@example.com", password: "short" })).json().error.code).toBe("password_too_short");
    const bad = await register(app, { email: "not-an-email", password: PW });
    expect(bad.json().error).toEqual({ code: "invalid_body", message: "請求格式錯誤" });
    expect((await register(app, { email: "a@example.com", password: PW, isAdmin: true })).statusCode).toBe(400);
  });

  it("「允許註冊」關 → 403 registration_disabled（快速路徑，不 hash）", async () => {
    const { app, db } = await buildTestApp();
    await db.update(siteSettings).set({ registrationEnabled: false });
    const res = await register(app, { email: "x@example.com", password: PW });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("registration_disabled");
    expect(vi.mocked(hashPassword)).not.toHaveBeenCalled();
  });

  it("B21：帳密登入有效值關 → 403 password_login_disabled；兩者皆關 → registration_disabled；env 強制＋DB 關 → 201", async () => {
    const { app, db } = await buildTestApp();
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await register(app, { email: "p@example.com", password: PW })).json().error.code).toBe("password_login_disabled");
    await db.update(siteSettings).set({ registrationEnabled: false });
    expect((await register(app, { email: "p@example.com", password: PW })).json().error.code).toBe("registration_disabled");
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await register(forced.app, { email: "p@example.com", password: PW })).statusCode).toBe(201);
  });

  it("讀不到 site_settings 列 → 註冊視同關（403 registration_disabled）", async () => {
    const { app, db } = await buildTestApp();
    await db.delete(siteSettings);
    expect((await register(app, { email: "x@example.com", password: PW })).json().error.code).toBe("registration_disabled");
  });

  it("HashBusyError → 429 server_busy、不建帳", async () => {
    const { app, db } = await buildTestApp();
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    const res = await register(app, { email: "busy@example.com", password: PW });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("server_busy");
    expect(await db.select().from(users).where(eq(users.email, "busy@example.com"))).toEqual([]);
  });

  it("per-IP 限流（REGISTER_LIMIT）：額度用完 → 429 too_many_requests", async () => {
    const { app } = await buildTestApp({ limiters: freshLimiters({ register: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    expect((await register(app, { email: "one@example.com", password: PW })).statusCode).toBe(201);
    expect((await register(app, { email: "two@example.com", password: PW })).json().error.code).toBe("too_many_requests");
  });

  it("handle 撞名重試：local-part 對應的 handle 已被佔 → 派生出另一個、仍 201", async () => {
    const { app, db } = await buildTestApp();
    await db.insert(users).values({ email: "someone@else.example", displayName: "X", handle: "dup" });
    await db.insert(handles).values({ handle: "dup", userId: (await db.select({ id: users.id }).from(users).where(eq(users.handle, "dup")))[0]!.id, state: "live" });
    const res = await register(app, { email: "dup@example.com", password: PW });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).not.toBe("dup");
  });

  it("C9：快速路徑讀到開、交易內 FOR SHARE 等關閉提交後讀到關 → 403 registration_disabled、無建帳", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set registration_enabled = false");
      const pending = register(app, { email: "c9@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.json().error.code).toBe("registration_disabled");
    } finally {
      await holder.end();
    }
    expect(await db.select().from(users).where(eq(users.email, "c9@example.com"))).toEqual([]);
  });

  it("C27：同形，關的是帳密登入 → 403 password_login_disabled、無建帳", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = register(app, { email: "c27@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("password_login_disabled");
    } finally {
      await holder.end();
    }
    expect(await db.select().from(users).where(eq(users.email, "c27@example.com"))).toEqual([]);
  });

  it("C3（SSO 先 → 註冊 409）：另一連線持有同 email 的未提交 users 列（＝SSO 首登建帳途中）→ 註冊等它提交 → 409 email_taken", async () => {
    const { app, db } = await buildTestApp();
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("insert into users (email, display_name, handle) values ('c3@example.com', 'C3', 'c3-holder')");
      const pending = register(app, { email: "c3@example.com", password: PW });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("email_taken");
    } finally {
      await holder.end();
    }
  });
});
