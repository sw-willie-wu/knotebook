/** #247 §9.5：五個「新簽一張登入 session」的點寫 users.last_login_at；同一次登入換 token、已登入時連結身分都不寫。時間一律以 DB 時鐘比。 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { buildTestApp, insertPasswordUser } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildOidcApp, ssoRoundTrip } from "./helpers/oidc-provider.js";

const A = "https://idp-a.example";
const PW = "correct-horse-battery-staple";

async function dbNow(db: Db): Promise<string> {
  return (await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`)).rows[0]!.t;
}
async function lastLoginText(db: Db, userId: string): Promise<string | null> {
  return (await db.execute<{ t: string | null }>(sql`select last_login_at::text as t from users where id = ${userId}`)).rows[0]!.t;
}
async function touchedSince(db: Db, userId: string, t0: string): Promise<boolean> {
  return (await db.execute<{ ok: boolean }>(sql`select coalesce(last_login_at >= ${t0}::timestamptz, false) as ok from users where id = ${userId}`)).rows[0]!.ok;
}

describe("users.last_login_at（#247 §9.5）", () => {
  it("帳密登入 → 寫入（≥ 登入前的 DB 時間）；錯密碼、停用帳號的對密碼都不寫", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    const t0 = await dbNow(db);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PW } })).statusCode).toBe(200);
    expect(await touchedSince(db, u.id, t0)).toBe(true);

    const v = await insertPasswordUser(db, { password: PW });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: v.email, password: "wrong-password-xx" } })).statusCode).toBe(401);
    await db.execute(sql`update users set disabled_at = now() where id = ${v.id}`);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: v.email, password: PW } })).statusCode).toBe(403);
    expect(await lastLoginText(db, v.id)).toBeNull();
  });

  it("改密碼後重簽（同一次登入換 token）不改值", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PW } });
    const session = login.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const before = await lastLoginText(db, u.id);
    expect(before).not.toBeNull();
    const r = await app.inject({ method: "POST", url: "/api/auth/password", cookies: { [SESSION_COOKIE]: session }, payload: { currentPassword: PW, newPassword: "another-long-password" } });
    expect(r.statusCode).toBe(204);
    expect(await lastLoginText(db, u.id)).toBe(before);
  });

  it("加上密碼後重簽不寫", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db); // 無密碼
    const r = await app.inject({ method: "POST", url: "/api/auth/password/set", cookies: await cookieOf(u.id), payload: { newPassword: "a-brand-new-password" } });
    expect(r.statusCode).toBe(204);
    expect(await lastLoginText(db, u.id)).toBeNull();
  });

  it("OIDC：首登建帳寫入；之後再以同一身分登入也寫入", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }] });
    const t0 = await dbNow(t.db);
    const first = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "s-1", email: "sso-new@x.example" } });
    expect(first.callbackRes.headers.location).toBe("/");
    const id = (await t.db.execute<{ id: string }>(sql`select id from users where email = 'sso-new@x.example'`)).rows[0]!.id;
    expect(await touchedSince(t.db, id, t0)).toBe(true);
    await t.db.execute(sql`update users set last_login_at = null where id = ${id}`);
    const t1 = await dbNow(t.db);
    const again = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "s-1", email: "sso-new@x.example" } });
    expect(again.callbackRes.headers.location).toBe("/");
    expect(await touchedSince(t.db, id, t1)).toBe(true);
  });

  it("GET /api/admin/users 帶 lastLoginAt：登入過的是 ISO 字串、從未登入的是 null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const never = await seedUser(db);
    const u = await insertPasswordUser(db, { password: PW });
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PW } });
    const rows = (await app.inject({ method: "GET", url: "/api/admin/users", cookies: await cookieOf(admin.id) })).json() as Array<{ id: string; lastLoginAt: string | null }>;
    expect(rows.find(r => r.id === never.id)!.lastLoginAt).toBeNull();
    const at = rows.find(r => r.id === u.id)!.lastLoginAt!;
    expect(new Date(at).toISOString()).toBe(at);
  });
});
