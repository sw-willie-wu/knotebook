/** #247 §9.3：PATCH /api/auth/profile 加 displayName（驗證同註冊；純 UPDATE 不進改名交易；gate.invalidate）。 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { handles, users } from "../src/db/schema.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";

const NUL = String.fromCodePoint(0);
const EMOJI = "😀";

async function call(app: FastifyInstance, method: "GET" | "PATCH", url: string, who: string | null, payload?: unknown) {
  return app.inject({ method, url, ...(who ? { cookies: await cookieOf(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe("PATCH /api/auth/profile — displayName（#247 §9.3）", () => {
  it("只帶 displayName：200 回寫入後的 UserDto（已 trim）、DB 寫入、緊接 /me 回新名（gate.invalidate，不等 60 秒快取）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db, { displayName: "Old Name" });
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().displayName).toBe("Old Name"); // 灌 gate 快取
    const res = await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: "  New Name  " });
    expect((await call(app, "GET", "/api/auth/me", u.id)).json().displayName).toBe("New Name");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: u.id, displayName: "New Name", handle: u.handle });
    const [row] = await db.select({ d: users.displayName }).from(users).where(eq(users.id, u.id));
    expect(row!.d).toBe("New Name");
  });

  it("只帶 displayName 不碰 handles registry、不消耗改名額度：連改 6 次後改 handle 仍 200", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const before = await db.select().from(handles).where(eq(handles.userId, u.id));
    for (let i = 0; i < 6; i++) expect((await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: `N${i}` })).statusCode).toBe(200);
    expect(await db.select().from(handles).where(eq(handles.userId, u.id))).toEqual(before);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { handle: `${u.handle}-x` })).statusCode).toBe(200);
  });

  it("displayName＋autoVersions 同一請求：兩欄都寫", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const res = await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: "Both", autoVersions: false });
    expect(res.json()).toMatchObject({ displayName: "Both", autoVersions: false });
    const [row] = await db.select({ d: users.displayName, a: users.autoVersions }).from(users).where(eq(users.id, u.id));
    expect(row).toEqual({ d: "Both", a: false });
  });

  it("displayName＋handle 走改名交易同一句：成功兩欄都寫；handle 撞名 409 時 displayName 也不寫（同一交易回滾）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db, { displayName: "Keep" });
    const other = await seedUser(db);
    const clash = await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: "Lost", handle: other.handle });
    const [afterClash] = await db.select({ d: users.displayName }).from(users).where(eq(users.id, u.id));
    expect(afterClash!.d).toBe("Keep");
    expect(clash.statusCode).toBe(409);
    const ok = await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: "Won", handle: `${u.handle}-y` });
    expect(ok.json()).toMatchObject({ displayName: "Won", handle: `${u.handle}-y` });
  });

  it("Review Focus 3：不合法 → 400 invalid_body（不是 500、不寫）；100 個 astral 字元放行；{} 400；未登入 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db, { displayName: "Stay" });
    for (const displayName of ["", "   ", "　　", EMOJI.repeat(101), "x".repeat(101), `a${NUL}b`, "a\uD800b", 5, null]) {
      const r = await call(app, "PATCH", "/api/auth/profile", u.id, { displayName });
      expect(r.statusCode, JSON.stringify(displayName)).toBe(400);
      expect(r.json().error, JSON.stringify(displayName)).toEqual({ code: "invalid_body", message: "請求格式錯誤" });
    }
    const [row] = await db.select({ d: users.displayName }).from(users).where(eq(users.id, u.id));
    expect(row!.d).toBe("Stay");
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, { displayName: EMOJI.repeat(100) })).statusCode).toBe(200);
    expect((await call(app, "PATCH", "/api/auth/profile", u.id, {})).statusCode).toBe(400);
    expect((await call(app, "PATCH", "/api/auth/profile", null, { displayName: "X" })).statusCode).toBe(401);
  });
});
