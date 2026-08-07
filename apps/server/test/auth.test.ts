import { vi, describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";

// verifyPassword／hashPassword 被包成 vi.fn(actual)：預設行為與真實實作一致，只有
// 個別測試（HashBusyError 那幾條）用 mockRejectedValueOnce 覆寫下一次呼叫，其餘測試
// 不受影響。這比用 setHashConcurrency + 真併發競態去逼出 HashBusyError 穩定，不依賴
// 時序（vi.mock 呼叫會被 vitest 靜態 hoist 到本檔最頂端，早於下面這行 import 執行）。
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword), hashPassword: vi.fn(actual.hashPassword) };
});

import { verifyPassword, hashPassword, HashBusyError, DUMMY_HASH } from "../src/auth/password.js";

// mockClear 只清呼叫紀錄（不清 mockRejectedValueOnce 以外的實作，那些本來就是
// vi.fn(actual...) 包出來的預設轉發），確保每個測試看到的呼叫次數只計自己那份。
afterEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.mocked(hashPassword).mockClear();
});

const VALID_PASSWORD = "correct-horse-battery";
const NEW_VALID_PASSWORD = "new-correct-horse-battery";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    password: string | null;
    mustChangePassword: boolean;
  }> = {}
) {
  const password = overrides.password === undefined ? VALID_PASSWORD : overrides.password;
  const passwordHash = password === null ? null : await hashPassword(password);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash,
      mustChangePassword: overrides.mustChangePassword ?? false,
    })
    .returning();
  return u;
}

function loginPayload(email: string, password: string) {
  return { email, password };
}

describe("POST /api/auth/login", () => {
  it("正確帳密 → 200 + session cookie，且該 cookie 打 me 回傳正確內容", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "alice@example.com", displayName: "Alice", isAdmin: false });

    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("alice@example.com", VALID_PASSWORD) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: u.id, email: u.email, displayName: u.displayName, isAdmin: false, mustChangePassword: false });

    const cookie = res.cookies.find(c => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie!.value } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({ id: u.id, email: u.email, displayName: u.displayName, isAdmin: false, mustChangePassword: false });
  });

  it("密碼錯 5 次 → 第 6 次前置 429 too_many_attempts，回應含正數 retryAfterMs", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "bob@example.com" });

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("bob@example.com", "wrong-password-here") });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("bob@example.com", "wrong-password-here") });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(typeof blocked.json().retryAfterMs).toBe("number");
    expect(blocked.json().retryAfterMs).toBeGreaterThan(0);
  });

  it("不存在的帳號連續失敗 5 次 → 第 6 次也 429 too_many_attempts", async () => {
    const { app } = await buildTestApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ghost@example.com", "whatever-password") });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ghost@example.com", "whatever-password") });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
  });

  it("401 回應體：不存在帳號 與 存在帳號密碼錯誤，逐 byte 一致（同 code、同 message，避免帳號存在 oracle）；不存在帳號底層真的跑了一次 dummy verify（DUMMY_HASH）", async () => {
    const { app: appExisting, db } = await buildTestApp();
    await insertUser(db, { email: "carol@example.com" });
    const resExistingWrong = await appExisting.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("carol@example.com", "totally-wrong-password"),
    });
    expect(resExistingWrong.statusCode).toBe(401);

    // 只隔離接下來「不存在帳號」那次呼叫的 verifyPassword 呼叫紀錄——上面存在帳號的
    // 分支已經驗證完 status code，不需要保留它的呼叫紀錄。
    vi.mocked(verifyPassword).mockClear();

    const { app: appMissing } = await buildTestApp();
    const resMissing = await appMissing.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("nobody-at-all@example.com", "totally-wrong-password"),
    });
    expect(resMissing.statusCode).toBe(401);

    // 頭號安全性質：帳號不存在時不能短路直接回 401，必須真的跑一次 dummy verify
    // （用 DUMMY_HASH），否則耗時差異會變成帳號是否存在的 timing oracle。
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPassword).mock.calls[0]?.[0]).toBe(DUMMY_HASH);

    expect(JSON.stringify(resMissing.json())).toBe(JSON.stringify(resExistingWrong.json()));
  });

  it("OIDC-only user（passwordHash null）登入 → 401 invalid_credentials，與一般密碼錯誤回應一致；底層真的跑了一次 dummy verify（DUMMY_HASH）", async () => {
    const { app: appOidc, db } = await buildTestApp();
    await insertUser(db, { email: "oidc@example.com", password: null });
    const resOidc = await appOidc.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("oidc@example.com", "any-password-at-all") });
    expect(resOidc.statusCode).toBe(401);

    // 在打第二個（存在帳號、真密碼錯誤）請求之前先斷言，確保這裡量到的呼叫次數/參數
    // 只屬於上面 OIDC-only 那次呼叫。
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPassword).mock.calls[0]?.[0]).toBe(DUMMY_HASH);

    const { app: appWrong, db: db2 } = await buildTestApp();
    await insertUser(db2, { email: "dana@example.com" });
    const resWrong = await appWrong.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("dana@example.com", "any-password-at-all") });
    expect(resWrong.statusCode).toBe(401);

    expect(JSON.stringify(resOidc.json())).toBe(JSON.stringify(resWrong.json()));
  });

  it("停用帳號：正確密碼 → 403 account_disabled；錯誤密碼 → 401（先驗密碼再檢查 disabled，不是 403 蓋過 401）", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "evan@example.com", disabledAt: new Date() });

    const resCorrect = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("evan@example.com", VALID_PASSWORD) });
    expect(resCorrect.statusCode).toBe(403);
    expect(resCorrect.json()).toMatchObject({ error: { code: "account_disabled" } });

    const resWrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("evan@example.com", "wrong-password-here") });
    expect(resWrong.statusCode).toBe(401);
    expect(resWrong.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("已登入取得的舊 cookie，帳號事後被停用（DB 直接設 disabledAt）→ me 401（gate 視為 revoked）", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "frank@example.com" });

    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("frank@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, "frank@example.com"));

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(meRes.statusCode).toBe(401);
  });

  it("HashBusyError（verifyPassword 併發超限）→ 429 server_busy", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "busy@example.com" });

    vi.mocked(verifyPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("busy@example.com", VALID_PASSWORD) });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });
  });

  it("recordSuccess 只清帳號計數、不清 IP 計數：登入成功後帳號計數歸零，換一個乾淨 IP 可再失敗 4 次仍不 429", async () => {
    // 用 x-forwarded-for 控制 request.ip（app 已設定 trustProxy: true）：先在 IP A
    // 上對同一帳號失敗 4 次、成功 1 次，再換到全新的 IP B 失敗 4 次——若 recordSuccess
    // 真的只清了帳號計數（不影響 IP 計數），帳號計數在 IP B 這批次會是 0+4=4（仍 <5，
    // 不 429）；若 recordSuccess 沒有正確接線／沒有真的清帳號計數，帳號計數會累積成
    // 4（IP A）+4（IP B）=8，一定會在這批次中途就被帳號臂擋下。
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "karen@example.com" });

    const ipA = "203.0.113.10";
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload("karen@example.com", "wrong-password-here"),
        headers: { "x-forwarded-for": ipA },
      });
      expect(res.statusCode).toBe(401);
    }

    const successRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("karen@example.com", VALID_PASSWORD),
      headers: { "x-forwarded-for": ipA },
    });
    expect(successRes.statusCode).toBe(200);

    const ipB = "203.0.113.20";
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload("karen@example.com", "wrong-password-here"),
        headers: { "x-forwarded-for": ipB },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("清除 cookie（value 為空、maxAge 0）→ 204；之後不帶 cookie 打 me → 401", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "grace@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("grace@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);

    const logoutRes = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logoutRes.statusCode).toBe(204);
    const cleared = logoutRes.cookies.find(c => c.name === SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    // path 必須跟簽發時一致（"/"）——瀏覽器用「name+path（+domain）」比對是否為同一顆
    // cookie 才會真的覆蓋掉它；path 對不上，這個 Set-Cookie 只會新增一顆空 cookie，
    // 原本那顆帶著 session token 的 cookie 完全沒被清掉。
    expect(cleared?.path).toBe("/");

    // 模擬瀏覽器已依 Set-Cookie 清除本地 cookie：後續請求不帶 cookie。
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(meRes.statusCode).toBe(401);
  });

  it("免認證亦可打（未登入直接打 logout）→ 204", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(204);
  });
});

describe("GET /api/auth/me", () => {
  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/password", () => {
  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("舊密碼錯 → 401 invalid_credentials（不變更 DB）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "henry@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("henry@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: "wrong-old-password", newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "invalid_credentials" } });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.tokenVersion).toBe(0);
  });

  it("新密碼 <12 字元 → 400 password_too_short", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "ivy@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ivy@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "password_too_short" } });
  });

  it("成功改密碼：本 request 新 cookie 打 me → 200；舊 cookie（改密碼前）→ 401；舊密碼登入 401、新密碼登入 200", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "jack@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    const oldCookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const changeRes = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: oldCookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(changeRes.statusCode).toBe(204);
    const newCookie = changeRes.cookies.find(c => c.name === SESSION_COOKIE);
    expect(newCookie).toBeDefined();
    expect(newCookie!.value).not.toBe(oldCookie);

    // (a) 本 request 拿到的新 cookie → me 200，本人沒被自己觸發的 tokenVersion bump 登出
    const meNew = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie!.value } });
    expect(meNew.statusCode).toBe(200);
    expect(meNew.json()).toMatchObject({ email: "jack@example.com" });

    // (b) 舊 cookie（改密碼前簽發，tv 已被 bump）→ 401，模擬他裝置 session 被踢
    const meOld = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(meOld.statusCode).toBe(401);

    // (c) 舊密碼登入 401、新密碼登入 200
    const loginOld = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", VALID_PASSWORD) });
    expect(loginOld.statusCode).toBe(401);
    const loginNew = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", NEW_VALID_PASSWORD) });
    expect(loginNew.statusCode).toBe(200);
  });

  it("成功改密碼 → collabHooks.onUserRevoked(userId) 被呼叫一次（spec §5 接縫：Plan 2 即時協作連線撤銷）", async () => {
    const onUserRevoked = vi.fn();
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked,
      beforeNoteDeleted: vi.fn(async () => {}),
    };
    const { app, db } = await buildTestApp({ collabHooks });
    const u = await insertUser(db, { email: "laura@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("laura@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    expect(onUserRevoked).toHaveBeenCalledTimes(1);
    expect(onUserRevoked).toHaveBeenCalledWith(u.id);
  });

  it("OIDC-only user（passwordHash null）打改密碼 → 401 invalid_credentials（釘住 dummy verify 分支，而非 500 或誤判成功）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "mia@example.com", password: null });
    // OIDC-only 使用者無法透過密碼登入拿 cookie，直接簽一把合法 session 模擬其已登入狀態。
    const cookie = await signSession(testConfig.appSecret, { userId: u.id, tv: u.tokenVersion });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: "any-password-at-all", newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("成功改密碼 → mustChangePassword 由 true 清為 false（後續 me 反映）；tokenVersion 照常 +1", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "olga@example.com", mustChangePassword: true });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("olga@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json()).toMatchObject({ mustChangePassword: true });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const changeRes = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(changeRes.statusCode).toBe(204);
    const newCookie = changeRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ mustChangePassword: false });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.mustChangePassword).toBe(false);
  });

  it("hashPassword 拋出 HashBusyError（雜湊新密碼時併發超限）→ 429 server_busy（不落地 DB 變更）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "nina@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("nina@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.tokenVersion).toBe(0);
  });
});
