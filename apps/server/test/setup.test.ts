import { vi, describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, freshDb, testConfig, withTestRoutes } from "./helpers.js";
import { SetupState } from "../src/auth/setup.js";
import { SESSION_TTL_SECONDS } from "../src/auth/session.js";
import { instanceSetup, users } from "../src/db/schema.js";

// hashPassword 包成 vi.fn(actual)：預設行為與真實實作一致，只有 HashBusyError 那條
// 測試用 mockRejectedValueOnce 覆寫下一次呼叫——同 auth.test.ts / admin-users.test.ts 的手法。
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

import { hashPassword, HashBusyError } from "../src/auth/password.js";

afterEach(() => {
  vi.mocked(hashPassword).mockClear();
});

const VALID_PASSWORD = "correct-horse-battery";

function validBody(overrides: Partial<{ token: string; email: string; password: string; displayName: string }> = {}) {
  return {
    token: "irrelevant-placeholder", // 每個測試呼叫都會覆寫成該 app 實際的 token
    email: "admin@example.com",
    password: VALID_PASSWORD,
    displayName: "Admin",
    ...overrides,
  };
}

describe("GET /api/setup/status", () => {
  it("未 setup → { needed: true }；POST /api/setup 成功後變 { needed: false }（isNeeded 查 DB，不是快取值）", async () => {
    const { app, setupState } = await buildTestApp();
    expect((await app.inject({ url: "/api/setup/status" })).json()).toEqual({ needed: true });

    const token = setupState.token;
    expect(token).not.toBeNull();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token: token! }) });
    expect(res.statusCode).toBe(201);

    expect((await app.inject({ url: "/api/setup/status" })).json()).toEqual({ needed: false });
  });
});

describe("POST /api/setup", () => {
  it("正確 token → 201 + session cookie + DB 落地（isAdmin=true、instance_setup 完成）；該 cookie 可通過 authenticate", async () => {
    const { app, db, setupState } = await buildTestApp();
    withTestRoutes(app);
    const token = setupState.token!;

    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, email: "owner@example.com" }) });
    expect(res.statusCode).toBe(201);

    const cookie = res.cookies.find(c => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");
    expect(String(cookie?.sameSite).toLowerCase()).toBe("lax");
    expect(cookie?.secure).toBeFalsy(); // testConfig 的 PUBLIC_URL 是 http://，cookieSecure=false
    expect(cookie?.maxAge).toBe(SESSION_TTL_SECONDS);

    const [dbUser] = await db.select().from(users).where(eq(users.email, "owner@example.com"));
    expect(dbUser).toMatchObject({ email: "owner@example.com", displayName: "Admin", isAdmin: true });
    expect(dbUser.passwordHash).toBeTruthy();

    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);

    const protectedRes = await app.inject({
      method: "GET",
      url: "/__test/protected",
      cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(protectedRes.statusCode).toBe(200);
    expect(protectedRes.json()).toMatchObject({ email: "owner@example.com", isAdmin: true });
  });

  it("錯誤 token → 403 invalid_setup_token（不落地任何 DB 變更）", async () => {
    const { app, db } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token: "wrong-token" }) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "invalid_setup_token" } });
    expect(await db.select().from(instanceSetup)).toHaveLength(0);
  });

  it("token 錯誤 + 密碼也太短 → 403 invalid_setup_token（不是 400 password_too_short；釘住檢查順序：token 優先於內容驗證）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: validBody({ token: "wrong-token", password: "short" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "invalid_setup_token" } });
  });

  it("DB 上已完成 setup（instance_setup 已有列，唯一原子性機制生效）→ 即使 app 手上的 token 仍「有效」也回 409 already_setup，且事後 markCompleted 生效", async () => {
    // 模擬：另一個並發請求（或另一個 process）已經完成 setup，但這個 app 實例的
    // in-memory SetupState 還沒被告知（markCompleted 只在「自己那次」成功後才會呼叫）——
    // 此時唯一能擋下重複建 admin 的防線是交易內的 DB 原子性 guard，不是應用層狀態。
    const { app, db, setupState } = await buildTestApp();
    const token = setupState.token!;
    await db.insert(instanceSetup).values({ singleton: true });

    const usersBefore = await db.select().from(users);
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token }) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "already_setup" } });
    expect(await db.select().from(users)).toEqual(usersBefore); // 沒有建立任何 user

    // AlreadySetupError 分支是「setup 已完成」的正面證明，路由必須順帶呼叫
    // markCompleted()，讓這個 process 的 setupState 狀態機跟 DB 保持一致——
    // 不然它會一直誤以為手上的 token 還能再用一次。
    expect(setupState.verifyToken(token)).toBe(false);
  });

  it("users.email 唯一鍵違反 → 同樣 map 409 already_setup（訊息中性、不透露細節）且整筆交易 rollback（instance_setup 不落地），也不 markCompleted", async () => {
    const { app, db, setupState } = await buildTestApp();
    const token = setupState.token!;
    await db.insert(users).values({ email: "taken@example.com", displayName: "Existing", isAdmin: false, tokenVersion: 0 });

    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, email: "taken@example.com" }) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "already_setup" } });
    expect(res.json().error.message).toBe("無法建立此帳號，可能已存在或實例已完成 setup");
    expect(await db.select().from(instanceSetup)).toHaveLength(0); // 整筆交易 rollback，singleton 沒落地

    // 這不是「setup 已完成」的正面證明（交易已整筆 rollback）——與上面 AlreadySetupError
    // 分支不同，不該 markCompleted()；同一個 token 應該還能再試一次（例如換個 email）。
    expect(setupState.verifyToken(token)).toBe(true);
  });

  it("並發：兩個同時 POST（同一個有效 token）→ 結果集合恰為 {201, 409}", async () => {
    const { app, db, setupState } = await buildTestApp();
    const token = setupState.token!;
    const body = validBody({ token });

    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: "/api/setup", payload: body }),
      app.inject({ method: "POST", url: "/api/setup", payload: body }),
    ]);

    expect([resA.statusCode, resB.statusCode].sort()).toEqual([201, 409]);
    expect(await db.select().from(instanceSetup)).toHaveLength(1); // 只有一筆
    expect(await db.select().from(users)).toHaveLength(1); // 只建立一個 admin
  });

  it("密碼 <12 字元 → 400 password_too_short", async () => {
    const { app, setupState } = await buildTestApp();
    const token = setupState.token!;
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, password: "x".repeat(11) }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "password_too_short" } });
  });

  it("密碼剛好 12 字元 → 通過密碼長度檢查（不是 400 password_too_short）", async () => {
    const { app, setupState } = await buildTestApp();
    const token = setupState.token!;
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, password: "x".repeat(12) }) });
    expect(res.statusCode).toBe(201);
  });

  it("hashPassword 拋出 HashBusyError（併發超限）→ 429 server_busy（不落地 DB，instance_setup 與 users 皆無新列）", async () => {
    const { app, db, setupState } = await buildTestApp();
    const token = setupState.token!;

    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, email: "busy@example.com" }) });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });

    expect(await db.select().from(instanceSetup)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);

    // 交易根本沒開始（hashPassword 在交易外先失敗），token 不該被消耗——同一個 token
    // 應該還能再試一次。
    expect(setupState.verifyToken(token)).toBe(true);
  });

  describe("BOOTSTRAP_ADMIN_EMAIL 設定時", () => {
    it("email 不符 → 403 bootstrap_email_mismatch", async () => {
      const { app, setupState } = await buildTestApp({ config: { ...testConfig, bootstrapAdminEmail: "boss@example.com" } });
      const token = setupState.token!;
      const res = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: validBody({ token, email: "someone-else@example.com" }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "bootstrap_email_mismatch" } });
    });

    it("email 相符 → 201", async () => {
      const { app, setupState } = await buildTestApp({ config: { ...testConfig, bootstrapAdminEmail: "boss@example.com" } });
      const token = setupState.token!;
      const res = await app.inject({ method: "POST", url: "/api/setup", payload: validBody({ token, email: "boss@example.com" }) });
      expect(res.statusCode).toBe(201);
    });
  });
});

describe("SetupState", () => {
  it("init()：未完成時產生 token 並用 log.info 印出格式 `Setup token: <64hex>`", async () => {
    const { db } = await freshDb();
    const calls: string[] = [];
    const state = await SetupState.init(db, { info: msg => calls.push(msg) });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^Setup token: [0-9a-f]{64}$/);
    expect(state.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("init()：已完成時不產生 token、不呼叫 log.info", async () => {
    const { db } = await freshDb();
    await db.insert(instanceSetup).values({ singleton: true });
    const calls: string[] = [];
    const state = await SetupState.init(db, { info: msg => calls.push(msg) });

    expect(calls).toHaveLength(0);
    expect(state.token).toBeNull();
  });

  it("setup 未完成時，verifyToken 對錯誤字串回 false；對正確 token 回 true", async () => {
    const { db } = await freshDb();
    const state = await SetupState.init(db, { info: () => {} });
    expect(state.verifyToken("this-is-definitely-wrong")).toBe(false);
    expect(state.verifyToken(state.token!)).toBe(true);
  });

  it("verifyToken 對『長度相同但內容錯誤』的字串回 false（覆蓋 timingSafeEqual 分支，不是只靠長度短路判否）", async () => {
    const { db } = await freshDb();
    const state = await SetupState.init(db, { info: () => {} });
    expect(state.token).toHaveLength(64); // 前提：真 token 是 64 hex 字元
    expect(state.verifyToken("f".repeat(64))).toBe(false);
  });

  it("markCompleted() 後，即使是原本正確的 token，verifyToken 也永遠回 false", async () => {
    const { db } = await freshDb();
    const state = await SetupState.init(db, { info: () => {} });
    const token = state.token!;
    expect(state.verifyToken(token)).toBe(true);

    state.markCompleted();
    expect(state.verifyToken(token)).toBe(false);
  });

  it("isNeeded()：每次都重查 DB——setup 完成後（即使不是透過本實例 markCompleted）立刻變 false", async () => {
    const { db } = await freshDb();
    const state = await SetupState.init(db, { info: () => {} });
    expect(await state.isNeeded()).toBe(true);

    await db.insert(instanceSetup).values({ singleton: true }); // 不經過這個 state，直接改 DB
    expect(await state.isNeeded()).toBe(false);
  });
});
