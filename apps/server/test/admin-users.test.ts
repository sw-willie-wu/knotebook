import { describe, it, expect, vi, afterEach } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { oneTimeLinks, users } from "../src/db/schema.js";
import { captureLogs } from "./helpers/admin-auth.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";
import type { AdminTestHook } from "../src/auth/admin-test-hook.js";

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
    onGroupAccessChanged: vi.fn(),
    beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
    linkSyncGate: () => ({ ok: false as const }),
  };
}

const EXPECTED_KEYS = ["id", "email", "handle", "displayName", "isAdmin", "disabledAt", "createdAt", "lastLoginAt", "lastActiveAt", "storage", "hasPassword", "passwordResetExpiresAt"].sort();

describe("requireAdmin 保護：全部端點非 admin 403、未登入 401", () => {
  const endpoints: Array<{ name: string; url: (id: string) => string; method: "GET" | "POST" | "DELETE" }> = [
    { name: "GET /api/admin/users", method: "GET", url: () => "/api/admin/users" },
    { name: "POST /api/admin/users", method: "POST", url: () => "/api/admin/users" },
    { name: "POST /api/admin/users/:id/disable", method: "POST", url: id => `/api/admin/users/${id}/disable` },
    { name: "POST /api/admin/users/:id/enable", method: "POST", url: id => `/api/admin/users/${id}/enable` },
    { name: "POST /api/admin/users/:id/promote", method: "POST", url: id => `/api/admin/users/${id}/promote` },
    { name: "POST /api/admin/users/:id/demote", method: "POST", url: id => `/api/admin/users/${id}/demote` },
    { name: "POST /api/admin/users/:id/password-reset", method: "POST", url: id => `/api/admin/users/${id}/password-reset` },
    { name: "DELETE /api/admin/users/:id/password-reset", method: "DELETE", url: id => `/api/admin/users/${id}/password-reset` },
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
    expect(otherRow).toMatchObject({ id: other.id, email: "other-shape@example.com", displayName: "Other", isAdmin: false, disabledAt: null, hasPassword: true, passwordResetExpiresAt: null });
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
    expect(body).toMatchObject({ email: "newuser-c1@example.com", handle: "newuser-c1", displayName: "New User", isAdmin: false, disabledAt: null, hasPassword: true, passwordResetExpiresAt: null });

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

  // #286 spec §4.6：停用與撤銷重設連結同一交易；revoked > 0 才記 log。
  const REVOKE_LOG = "停用帳號時撤銷重設密碼連結";

  async function disableSetup() {
    const cap = captureLogs();
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() }, cap.options);
    const admin = await insertUser(db, { isAdmin: true });
    const target = await insertUser(db);
    const adminCookies = { [SESSION_COOKIE]: await cookieFor(admin.id) };
    return { app, db, admin, target, adminCookies, lines: cap.lines };
  }

  it("D-R1：有效連結 → 停用 204 並撤銷、記 log；重新啟用後連結仍撤銷、列表為 null", async () => {
    const { app, db, admin, target, adminCookies, lines } = await disableSetup();
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/password-reset`, cookies: adminCookies, payload: { expiresInHours: 1 } });
    expect(issued.statusCode).toBe(201);

    const res = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies });
    expect(res.statusCode).toBe(204);
    const [link] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.targetUserId, target.id));
    expect(link!.revokedAt).not.toBeNull();
    expect(link!.usedAt).toBeNull();
    expect(lines.filter(l => l.msg === REVOKE_LOG).map(l => l.obj)).toEqual([{ userId: admin.id, targetUserId: target.id, revoked: 1 }]);

    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/enable`, cookies: adminCookies })).statusCode).toBe(204);
    const [after] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, link!.id));
    expect(after!.revokedAt).not.toBeNull();
    const list = await app.inject({ method: "GET", url: "/api/admin/users", cookies: adminCookies });
    expect(list.json().find((u: { id: string }) => u.id === target.id)).toMatchObject({ disabledAt: null, passwordResetExpiresAt: null });
  });

  it("D-R2：沒有連結 → 停用 204、不記撤銷 log", async () => {
    const { app, target, adminCookies, lines } = await disableSetup();
    const res = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies });
    expect(res.statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toEqual([]);
  });

  it("D-R3：已停用再停用（冪等 204）→ 不再記撤銷 log", async () => {
    const { app, target, adminCookies, lines } = await disableSetup();
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/password-reset`, cookies: adminCookies, payload: { expiresInHours: 1 } });
    expect(issued.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies })).statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: adminCookies })).statusCode).toBe(204);
    expect(lines.filter(l => l.msg === REVOKE_LOG)).toHaveLength(1);
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

/** 這幾位裡仍是「啟用中的 admin」的人數（只看本案種的人；不受其他列影響）。 */
async function enabledAdminsAmong(db: Db, ids: string[]): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.isAdmin, true), isNull(users.disabledAt)));
  return rows.length;
}
const demote = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], targetId: string, cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: `/api/admin/users/${targetId}/demote`, cookies });

describe("POST /api/admin/users/:id/demote（#247 §9.4）", () => {
  it("成功 204、DB is_admin=false；被降級者緊接打 admin API → 403（gate.invalidate，不等 60 秒快取）", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const bCookies = await cookieOf(b.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: bCookies })).statusCode).toBe(200); // 灌 gate 快取
    const res = await demote(app, b.id, await cookieOf(a.id));
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: bCookies })).statusCode).toBe(403);
    expect(res.statusCode).toBe(204);
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, b.id));
    expect(row!.isAdmin).toBe(false);
  });

  it("降自己（小寫與大寫 UUID 兩形）→ 400 cannot_demote_self；仍是 admin", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    await seedUser(db, { isAdmin: true }); // 另一位 admin 在：證明擋下的是「自己」而不是「最後一位」
    for (const id of [a.id, a.id.toUpperCase()]) {
      const r = await demote(app, id, await cookieOf(a.id));
      expect(r.statusCode, id).toBe(400);
      expect(r.json().error, id).toEqual({ code: "cannot_demote_self", message: "無法移除自己的管理員身分" });
    }
    expect(await enabledAdminsAmong(db, [a.id])).toBe(1);
  });

  it("不存在／非 UUID → 404 user_not_found；本來就不是 admin → 204 冪等、仍不是 admin", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const plain = await seedUser(db);
    const cookies = await cookieOf(a.id);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      const r = await demote(app, id, cookies);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().error.code, id).toBe("user_not_found");
    }
    expect((await demote(app, plain.id, cookies)).statusCode).toBe(204);
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, plain.id));
    expect(row!.isAdmin).toBe(false);
  });

  it("Review Focus 4（序列）：呼叫者已被降級但 gate 快取仍是 admin → 降唯一的 admin 得 409 last_site_admin（不是群組的 last_admin）、不寫", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const aCookies = await cookieOf(a.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: aCookies })).statusCode).toBe(200); // 灌 a 的快取
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, a.id)); // 繞過端點、不 invalidate：a 的快取仍是 admin
    const r = await demote(app, b.id, aCookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({ code: "last_site_admin", message: "站台至少要保留一位啟用中的管理員" });
    expect(await enabledAdminsAmong(db, [a.id, b.id])).toBe(1);
  });

  it("Review Focus 4（序列，停用形）：呼叫者已被停用但快取仍有效 → 只剩目標一位啟用中的 admin → 409；停用中的 admin 不算", async () => {
    const { app, db } = await buildTestApp();
    const a = await seedUser(db, { isAdmin: true });
    const b = await seedUser(db, { isAdmin: true });
    const aCookies = await cookieOf(a.id);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: aCookies })).statusCode).toBe(200);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.id));
    const r = await demote(app, b.id, aCookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("last_site_admin");
  });

  it("併發互降（注入縫交錯）：A 降 B 持鎖未寫時 B 降 A → B 那發卡在鎖上；恰一個 204、另一個 409 last_site_admin；剩一位啟用中的 admin", async () => {
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: AdminTestHook = async point => {
      if (point !== "demote-locked" || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ adminTestHook: hook });
    const a = await seedUser(built.db, { isAdmin: true });
    const b = await seedUser(built.db, { isAdmin: true });
    const bCookies = await cookieOf(b.id);
    race.fire = () => demote(built.app, a.id, bCookies);
    const first = await demote(built.app, b.id, await cookieOf(a.id));
    const other = await second!;
    expect(interleave).toBe("blocked");
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_site_admin");
    expect(await enabledAdminsAmong(built.db, [a.id, b.id])).toBe(1);
  });

  it("disabled_at 併發形：C 是已停用的 admin；A、B 同時互降 → 恰一個 204、另一個 409（計數只算啟用中的，C 不算）", async () => {
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: AdminTestHook = async point => {
      if (point !== "demote-locked" || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ adminTestHook: hook });
    const a = await seedUser(built.db, { isAdmin: true });
    const b = await seedUser(built.db, { isAdmin: true });
    const c = await seedUser(built.db, { isAdmin: true, disabled: true });
    const bCookies = await cookieOf(b.id);
    race.fire = () => demote(built.app, a.id, bCookies);
    const first = await demote(built.app, b.id, await cookieOf(a.id));
    const other = await second!;
    expect(interleave).toBe("blocked");
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect(await enabledAdminsAmong(built.db, [a.id, b.id, c.id])).toBe(1);
  });
});
