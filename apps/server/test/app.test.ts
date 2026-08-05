import { describe, it, expect } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig, withTestRoutes } from "./helpers.js";
import { signSession } from "../src/auth/session.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

async function insertUser(
  db: Db,
  overrides: Partial<{ email: string; displayName: string; isAdmin: boolean; tokenVersion: number; disabledAt: Date | null }> = {}
) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
    })
    .returning();
  return u;
}

// session.test.ts 已驗證「flip payload 首字元」是可靠的竄改手法（末字元 base64url
// 只有部分位元有效，翻轉有極小機率不改變解碼位元組，造成假綠）。
function tamperToken(token: string): string {
  const [header, payload, signature] = token.split(".");
  const flipped = payload[0] === "a" ? "b" : "a";
  return `${header}.${flipped}${payload.slice(1)}.${signature}`;
}

describe("buildApp", () => {
  it("未登入 → 401 統一格式", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("變更請求非 JSON → 415 且 code 正確", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "x", headers: { "content-type": "text/plain" } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("未知路由 → 404 統一格式", async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/nope" })).json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("healthz 免認證 200 且 body { ok: true }", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // Mandatory item 1（第二輪審查備忘）：content-type 守衛必須放行無 body 的變更請求
  // （例如 POST /logout 不會帶 Content-Type/body），不能一律要求 application/json——
  // 否則所有無 body 的變更端點都會被誤判 415。
  it("變更請求無 body（如 POST /logout 不帶 Content-Type）→ 放行，不觸發 415", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo" });
    expect(res.statusCode).not.toBe(415);
  });

  it("壞 JSON body → 400（非 500，錯誤 handler 不可把 4xx 吞成 500）", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{not valid json", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("content-type 為 text/plain;charset=application/json（CORS-safelisted 繞法）→ 仍是 415", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{}", headers: { "content-type": "text/plain;charset=application/json" } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("content-type 為 application/json; charset=utf-8（MIME essence 相符）→ 通過", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "POST", url: "/__test/echo", payload: "{}", headers: { "content-type": "application/json; charset=utf-8" } });
    expect(res.statusCode).not.toBe(415);
    expect(res.json()).toEqual({});
  });

  it("未知路由 + 變更方法 + 非 JSON body → 415（證明 onRequest 對未匹配路由也生效，GET /nope 對此無鑑別力）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/nope", payload: "x", headers: { "content-type": "text/plain" } });
    expect(res.statusCode).toBe(415);
  });

  it("真 cookie happy path：登入使用者 → 200 且 request.user 內容正確", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: false, tokenVersion: 0 });
    const token = await signSession(testConfig.appSecret, { userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: u.id, email: u.email, displayName: u.displayName, isAdmin: false });
  });

  it("篡改 token → 401", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { tokenVersion: 0 });
    const token = await signSession(testConfig.appSecret, { userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: tamperToken(token) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("gate revoked（DB disabledAt 已設定）→ 401", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { tokenVersion: 0, disabledAt: new Date() });
    const token = await signSession(testConfig.appSecret, { userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/protected", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("requireAdmin：未登入 → 401", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/admin" });
    expect(res.statusCode).toBe(401);
  });

  it("requireAdmin：非 admin → 403", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: false, tokenVersion: 0 });
    const token = await signSession(testConfig.appSecret, { userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/admin", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("requireAdmin：admin → 通過（200）", async () => {
    const { app, db } = await buildTestApp();
    withTestRoutes(app);
    const u = await insertUser(db, { isAdmin: true, tokenVersion: 0 });
    const token = await signSession(testConfig.appSecret, { userId: u.id, tv: 0 });
    const res = await app.inject({ method: "GET", url: "/__test/admin", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("route throw → 500 統一格式，body 不洩漏 stack", async () => {
    const { app } = await buildTestApp();
    withTestRoutes(app);
    const res = await app.inject({ method: "GET", url: "/__test/throw" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ error: { code: "internal" } });
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});
