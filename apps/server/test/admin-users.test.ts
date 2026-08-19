import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";

// hashPassword 包成 vi.fn(actual)：預設行為與真實實作一致，只有 HashBusyError 那條
// 測試用 mockRejectedValueOnce 覆寫下一次呼叫——同 auth.test.ts 的手法。
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

import { hashPassword, HashBusyError } from "../src/auth/password.js";

afterEach(() => {
  vi.mocked(hashPassword).mockClear();
});

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returning();
  return u;
}

async function cookieFor(userId: string, tv = 0): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv });
}

function spyCollabHooks(): CollabHooks {
  return {
    onShareChanged: vi.fn(),
    onUserRevoked: vi.fn(),
    beforeNoteDeleted: vi.fn(async () => {}),
    linkSyncGate: () => ({ ok: false as const }),
  };
}

const EXPECTED_KEYS = ["id", "email", "displayName", "isAdmin", "disabledAt", "createdAt"].sort();

describe("requireAdmin 保護：全部端點非 admin 403、未登入 401", () => {
  const endpoints: Array<{ name: string; url: (id: string) => string; method: "GET" | "POST" }> = [
    { name: "GET /api/admin/users", method: "GET", url: () => "/api/admin/users" },
    { name: "POST /api/admin/users", method: "POST", url: () => "/api/admin/users" },
    { name: "POST /api/admin/users/:id/disable", method: "POST", url: id => `/api/admin/users/${id}/disable` },
    { name: "POST /api/admin/users/:id/enable", method: "POST", url: id => `/api/admin/users/${id}/enable` },
    { name: "POST /api/admin/users/:id/promote", method: "POST", url: id => `/api/admin/users/${id}/promote` },
  ];

  for (const ep of endpoints) {
    it(`${ep.name}：非 admin → 403`, async () => {
      const { app, db } = await buildTestApp();
      const nonAdmin = await insertUser(db, { email: `nonadmin-${ep.name}@example.com` });
      const target = await insertUser(db, { email: `target-${ep.name}@example.com` });
      const cookie = await cookieFor(nonAdmin.id);

      const res = await app.inject({ method: ep.method, url: ep.url(target.id), cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode).toBe(403);
    });

    it(`${ep.name}：未登入 → 401`, async () => {
      const { app, db } = await buildTestApp();
      const target = await insertUser(db, { email: `target2-${ep.name}@example.com` });

      const res = await app.inject({ method: ep.method, url: ep.url(target.id) });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("GET /api/admin/users", () => {
  it("形狀鎖（Object.keys 精確）+ 不洩漏 passwordHash/tokenVersion", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-shape@example.com" });
    const other = await insertUser(db, { email: "other-shape@example.com", displayName: "Other" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
    }
    const otherRow = body.find((u: { id: string }) => u.id === other.id);
    expect(otherRow).toMatchObject({ id: other.id, email: "other-shape@example.com", displayName: "Other", isAdmin: false, disabledAt: null });
  });

  it("依 createdAt asc 排序", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-order@example.com", createdAt: new Date("2026-01-01T00:00:00Z") });
    const second = await insertUser(db, { email: "second-order@example.com", createdAt: new Date("2026-01-02T00:00:00Z") });
    const third = await insertUser(db, { email: "third-order@example.com", createdAt: new Date("2026-01-03T00:00:00Z") });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((u: { id: string }) => u.id);
    expect(ids).toEqual([admin.id, second.id, third.id]);
  });
});

describe("POST /api/admin/users", () => {
  it("201 建立成功、形狀正確；該帳號可登入", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c1@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "newuser-c1@example.com", password: "a-strong-password", displayName: "New User" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(EXPECTED_KEYS);
    expect(body).toMatchObject({ email: "newuser-c1@example.com", displayName: "New User", isAdmin: false, disabledAt: null });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "newuser-c1@example.com", password: "a-strong-password" },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it("代建的帳號 mustChangePassword=true（spec rev 5.7；DB 斷言，AdminUserDto 形狀本身不含此欄位）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c6@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "newuser-c6@example.com", password: "a-strong-password", displayName: "New User" },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db.select().from(users).where(eq(users.email, "newuser-c6@example.com"));
    expect(row.mustChangePassword).toBe(true);
  });

  it("Mixed-Case email 建帳 → DB 存小寫（spec §14.3 單一漏斗）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c7@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "MiXed-Case-C7@Example.COM", password: "a-strong-password", displayName: "Mixed Case" },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db.select().from(users).where(eq(users.email, "mixed-case-c7@example.com"));
    expect(row).toBeDefined();
    expect(row.email).toBe("mixed-case-c7@example.com");
  });

  it("isAdmin: true → 建立管理員帳號", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c2@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "newadmin-c2@example.com", password: "a-strong-password", displayName: "New Admin", isAdmin: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ isAdmin: true });
  });

  it("email 撞 → 409 email_taken", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c3@example.com" });
    await insertUser(db, { email: "dup-c3@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "dup-c3@example.com", password: "a-strong-password", displayName: "Dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "email_taken" } });
  });

  it("密碼 <12 字元 → 400 password_too_short", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c4@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "shortpw-c4@example.com", password: "short", displayName: "Short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "password_too_short" } });

    const [row] = await db.select().from(users).where(eq(users.email, "shortpw-c4@example.com"));
    expect(row).toBeUndefined();
  });

  it("hashPassword 拋出 HashBusyError（併發超限）→ 429 server_busy，不落地 DB", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-c5@example.com" });
    const cookie = await cookieFor(admin.id);

    // insertUser(admin) 已經真的呼叫過一次 hashPassword（消耗掉的是「當下」那次呼叫），
    // 在這裡才排入 mockRejectedValueOnce，確保吃到 rejection 的是路由 handler 那次呼叫。
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { email: "busy-c5@example.com", password: "a-strong-password", displayName: "Busy" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });

    const [row] = await db.select().from(users).where(eq(users.email, "busy-c5@example.com"));
    expect(row).toBeUndefined();
  });
});

describe("POST /api/admin/users/:id/disable", () => {
  it("該使用者現有 session 立即失效（me → 401，不等 TTL）；login → 403 account_disabled；onUserRevoked 被呼叫", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d1@example.com" });
    const target = await insertUser(db, { email: "target-d1@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-d1@example.com", password: VALID_PASSWORD },
    });
    expect(targetLogin.statusCode).toBe(200);
    const targetCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const beforeMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(beforeMe.statusCode).toBe(200);

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    const afterMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(afterMe.statusCode).toBe(401);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-d1@example.com", password: VALID_PASSWORD },
    });
    expect(loginRes.statusCode).toBe(403);
    expect(loginRes.json()).toMatchObject({ error: { code: "account_disabled" } });

    expect(collabHooks.onUserRevoked).toHaveBeenCalledWith(target.id);
    expect(collabHooks.onUserRevoked).toHaveBeenCalledTimes(1);
  });

  it("disable 自己 → 400 cannot_disable_self；onUserRevoked 未被呼叫", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${admin.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();
  });

  it("disable 自己（UUID 大寫版本）→ 仍是 400 cannot_disable_self（不可靠大小寫繞過自我鎖死檢查）", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d2b@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/users/${admin.id.toUpperCase()}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "cannot_disable_self" } });
    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();

    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row.disabledAt).toBeNull();
    expect(row.tokenVersion).toBe(0);
  });

  it("非 UUID／不存在 → 404 user_not_found；onUserRevoked 未被呼叫", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d3@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const resInvalid = await app.inject({
      method: "POST",
      url: "/api/admin/users/not-a-uuid/disable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(resInvalid.statusCode).toBe(404);
    expect(resInvalid.json()).toMatchObject({ error: { code: "user_not_found" } });

    const resMissing = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/disable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(resMissing.statusCode).toBe(404);
    expect(resMissing.json()).toMatchObject({ error: { code: "user_not_found" } });

    expect(collabHooks.onUserRevoked).not.toHaveBeenCalled();
  });

  it("重複 disable → 204 冪等，tv 不再增加（DB 斷言）", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-d4@example.com" });
    const target = await insertUser(db, { email: "target-d4@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const first = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(first.statusCode).toBe(204);

    const [afterFirst] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterFirst.tokenVersion).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(second.statusCode).toBe(204);

    const [afterSecond] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterSecond.tokenVersion).toBe(1);

    // 狀態未變（早已停用）不重複呼叫 hook——第二次 disable 不應該讓 onUserRevoked
    // 再多觸發一次（維持第一次成功停用時那一次呼叫）。
    expect(collabHooks.onUserRevoked).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/admin/users/:id/enable", () => {
  it("清除 disabledAt 後可重新登入；舊 session（disable 前簽的）仍 401（tv 已 bump，不回復）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e1@example.com" });
    const target = await insertUser(db, { email: "target-e1@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e1@example.com", password: VALID_PASSWORD },
    });
    const oldCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    const enableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/enable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(enableRes.statusCode).toBe(204);

    const loginAfterEnable = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e1@example.com", password: VALID_PASSWORD },
    });
    expect(loginAfterEnable.statusCode).toBe(200);

    const meOld = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(meOld.statusCode).toBe(401);
  });

  it("gate 快取內的 stale 停用狀態不能沿用：disable 前先灌一筆 revoked 快取，enable 後新 session 仍需正常 200（鎖住 gate.invalidate 呼叫，不可被無聲刪除）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e3@example.com" });
    const target = await insertUser(db, { email: "target-e3@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const targetLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e3@example.com", password: VALID_PASSWORD },
    });
    const oldCookie = targetLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const disableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/disable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(disableRes.statusCode).toBe(204);

    // 用舊 cookie 打 me → 401，順便把「disabledAt 已設」的 row 灌進 gate 快取
    // （TTL 60s）——這是 disable 自己的 gate.invalidate 已經處理過的快取寫入，
    // 之後這筆 stale 快取要靠 enable 的 gate.invalidate 清掉，不是靠 disable 那次。
    const staleMe = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(staleMe.statusCode).toBe(401);

    const enableRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/enable`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(enableRes.statusCode).toBe(204);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "target-e3@example.com", password: VALID_PASSWORD },
    });
    expect(newLogin.statusCode).toBe(200);
    const newCookie = newLogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    // 若 enable 沒有呼叫 gate.invalidate，這裡會沿用上面那筆 stale 快取（row.disabledAt
    // 仍非 null），即使拿到全新登入核發的 session 仍會被誤判成 401（不等 60s TTL 過期）。
    const meAfterEnable = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie } });
    expect(meAfterEnable.statusCode).toBe(200);
  });

  it("不存在 → 404 user_not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-e2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/enable",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "user_not_found" } });
  });
});

describe("POST /api/admin/users/:id/promote", () => {
  it("isAdmin=true；該使用者立即（不等 TTL）可打 admin API（gate.invalidate 生效）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p1@example.com" });
    const target = await insertUser(db, { email: "target-p1@example.com" });
    const adminCookie = await cookieFor(admin.id);
    const targetCookie = await cookieFor(target.id, 0);

    const beforeRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(beforeRes.statusCode).toBe(403);

    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/promote`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(promoteRes.statusCode).toBe(204);

    const afterRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(afterRes.statusCode).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row.isAdmin).toBe(true);
  });

  it("不存在 → 404 user_not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p2@example.com" });
    const adminCookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users/00000000-0000-0000-0000-000000000000/promote",
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "user_not_found" } });
  });
});
