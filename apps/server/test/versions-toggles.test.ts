// 自動儲存三層開關與站台清除設定（spec 2026-10-09 §6.7、§6.8、Review Focus RF4）。開關「下一次載入才生效」由 Task 12 驗。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { groups, handles, siteSettings, users } from "../src/db/schema.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";

async function call(app: FastifyInstance, method: "GET" | "PATCH" | "POST", url: string, who: string | null, payload?: unknown) {
  return app.inject({ method, url, ...(who ? { cookies: await cookieOf(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe("站台設定 /api/admin/versions/settings（§6.7）", () => {
  it("只有站台管理員；GET 預設 7／30／開；PATCH 單欄合併；違反 1 ≤ F ≤ D ≤ 3650 → 400 且不改；非整數、空 body、多欄 → 400", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const user = await seedUser(db);
    const url = "/api/admin/versions/settings";
    expect((await call(app, "GET", url, null)).statusCode).toBe(401);
    expect((await call(app, "GET", url, user.id)).statusCode).toBe(403);
    expect((await call(app, "GET", url, admin.id)).json()).toEqual({ keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true });
    expect((await call(app, "PATCH", url, admin.id, { keepAllDays: 3 })).json()).toEqual({ keepAllDays: 3, dailyUntilDays: 30, autoVersionsEnabled: true });
    for (const body of [{ dailyUntilDays: 2 }, { keepAllDays: 0 }, { dailyUntilDays: 3651 }, { keepAllDays: 31 }]) {
      const r = await call(app, "PATCH", url, admin.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
      expect(r.json().error.message).toMatch(/3650/);
    }
    for (const body of [{}, { keepAllDays: 1.5 }, { keepAllDays: "3" }, { foo: 1 }]) expect((await call(app, "PATCH", url, admin.id, body)).statusCode).toBe(400);
    expect((await call(app, "GET", url, admin.id)).json()).toEqual({ keepAllDays: 3, dailyUntilDays: 30, autoVersionsEnabled: true });
    expect((await call(app, "PATCH", url, admin.id, { autoVersionsEnabled: false, keepAllDays: 1, dailyUntilDays: 1 })).json()).toEqual({ keepAllDays: 1, dailyUntilDays: 1, autoVersionsEnabled: false });
    expect((await call(app, "PATCH", url, user.id, { keepAllDays: 2 })).statusCode).toBe(403);
  });

  it("site_settings 沒有列 → GET／PATCH 500，log.error 物件開頭帶 table", async () => {
    const logs = captureLogs();
    const { app, db } = await buildTestApp({}, logs.options);
    const admin = await seedUser(db, { isAdmin: true });
    await db.delete(siteSettings);
    expect((await call(app, "GET", "/api/admin/versions/settings", admin.id)).statusCode).toBe(500);
    expect((await call(app, "PATCH", "/api/admin/versions/settings", admin.id, { keepAllDays: 2 })).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.obj.table === "site_settings").length).toBeGreaterThanOrEqual(2);
  });

  it("總開關進公開的 /api/auth/config", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().autoVersionsEnabled).toBe(true);
    await call(app, "PATCH", "/api/admin/versions/settings", admin.id, { autoVersionsEnabled: false });
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().autoVersionsEnabled).toBe(false);
  });
});

describe("個人開關 PATCH /api/auth/profile（§6.8）", () => {
  it("只帶 autoVersions：純 UPDATE、回寫入後的 UserDto、/me 立刻反映、連改 6 次不消耗改名額度", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const handlesBefore = await db.select().from(handles).where(eq(handles.userId, u.id));
    for (let i = 0; i < 6; i += 1) {
      const r = await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: i % 2 === 0 });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id: u.id, handle: u.handle, autoVersions: i % 2 === 0 });
    }
    // 最後一次寫 false（≠ 初值 true）：gate 快取若沒被 invalidate，/me 會回第一次 authenticate 快取到的 true。
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().autoVersions).toBe(false);
    expect(await db.select().from(handles).where(eq(handles.userId, u.id))).toEqual(handlesBefore);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { handle: `${u.handle}-x` })).statusCode).toBe(200); // 額度沒被吃
  });

  it("RF4：autoVersions 與不合法／已被占用的 handle 一起送 → 400／409，auto_versions 不變；兩欄都合法 → 同一交易都生效", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: "Bad Handle!" })).statusCode).toBe(400);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: other.handle })).statusCode).toBe(409);
    expect((await db.select({ a: users.autoVersions }).from(users).where(eq(users.id, u.id)))[0]!.a).toBe(true);
    const ok = await call(app, "PATCH", "/api/auth/profile", u.id, { autoVersions: false, handle: `${u.handle}-y` });
    expect(ok.json()).toMatchObject({ handle: `${u.handle}-y`, autoVersions: false });
  });

  it("空 body、型別錯 → 400；既有只帶 handle 的行為不變（回應帶 autoVersions）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    for (const body of [{}, { autoVersions: "no" }, { handle: 5 }]) expect((await call(app, "PATCH", "/api/auth/profile", u.id, body)).statusCode).toBe(400);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { handle: `${u.handle}-z` })).json()).toMatchObject({ handle: `${u.handle}-z`, autoVersions: true });
  });

  it("登入回應與 /api/auth/me 都帶 autoVersions", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const password = "correct-horse-battery";
    await db.update(users).set({ autoVersions: false, passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().autoVersions).toBe(false);
    // 登入回應的值取自 DB（不是寫死 true）：先設 false 再登入。
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ id: u.id, autoVersions: false });
  });
});

describe("群組開關 PATCH /api/groups/:id（§6.8）", () => {
  it("manageGroup 才能改；只帶 autoVersions 可；空 body 400；GroupDto 與 GET /api/groups 帶 autoVersions；POST /api/groups 仍只收 name", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, member.id, { autoVersions: false })).statusCode).toBe(403);
    const r = await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, { autoVersions: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: g.id, name: "G", autoVersions: false });
    expect((await db.select({ a: groups.autoVersions }).from(groups).where(eq(groups.id, g.id)))[0]!.a).toBe(false);
    // 先 PATCH false 再 GET：清單若沒選這欄（預設 true 補位）只有在關閉後才分辨得出來。
    expect((await call(app, "GET", "/api/groups", member.id)).json()[0]).toMatchObject({ id: g.id, autoVersions: false });
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, {})).statusCode).toBe(400);
    expect((await call(app, "PATCH", `/api/groups/${g.id}`, admin.id, { name: "G2", autoVersions: true })).json()).toMatchObject({ name: "G2", autoVersions: true });
    expect((await call(app, "GET", "/api/groups", member.id)).json()[0]).toMatchObject({ id: g.id, autoVersions: true });
    expect((await call(app, "POST", "/api/groups", admin.id, { name: "H", autoVersions: false })).statusCode).toBe(400);
  });
});
