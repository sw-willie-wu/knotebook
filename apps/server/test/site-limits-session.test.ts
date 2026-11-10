/**
 * #397：網頁登入有效期（`sessionTtlSeconds`）在每次簽發 session 時現讀 `siteLimits`。新登入與三條換發路徑（改密碼、
 * 加上密碼、以重設連結設新密碼）簽出的 cookie `Max-Age`、JWT `exp − iat`、`sessions.expires_at − now` 三者同值；
 * 修改之前簽發的 session 維持原本的到期時間。actor 一律是本測試在同一個 DB 建的 admin。
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { sessions } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, insertPasswordUser, TEST_SESSION_TTL, type TestApp } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";

type App = TestApp["app"];
type Res = Awaited<ReturnType<App["inject"]>>;

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-397";
const TTL = 3600;

/** 回應帶的 session cookie：值與 `Max-Age`。 */
function sessionCookieOf(res: Res): { jwt: string; maxAge: number | undefined } {
  const c = res.cookies.find(one => one.name === SESSION_COOKIE);
  expect(c, "回應應帶 session cookie").toBeDefined();
  return { jwt: c!.value, maxAge: c!.maxAge };
}

async function expiresAtOf(db: Db, sid: string): Promise<Date> {
  const [row] = await db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.id, sid));
  expect(row, `sessions 應有 ${sid} 這一列`).toBeDefined();
  return row!.expiresAt;
}

async function me(app: App, jwt: string): Promise<number> {
  return (await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: jwt } })).statusCode;
}

async function login(app: App, email: string, password = PASSWORD): Promise<Res> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** 一次簽發的三個值都等於 `ttl`：cookie `Max-Age` 與 JWT `exp − iat` 恰好相等，列的 `expires_at − now` 容許 ±5 s。 */
async function expectIssuedWithTtl(app: App, db: Db, res: Res, ttl: number): Promise<string> {
  const { jwt, maxAge } = sessionCookieOf(res);
  expect(maxAge).toBe(ttl);
  const claims = decodeJwt(jwt);
  expect(claims.exp! - claims.iat!).toBe(ttl);
  const remaining = ((await expiresAtOf(db, claims.sid as string)).getTime() - Date.now()) / 1000;
  expect(Math.abs(remaining - ttl), `expires_at − now = ${remaining} s`).toBeLessThanOrEqual(5);
  // 列沒有比 JWT 先到期：換到的 cookie 可以直接用。
  expect(await me(app, jwt)).toBe(200);
  return jwt;
}

describe("sessionTtlSeconds 立即生效", () => {
  it("新登入：改成 3600 後帳密登入三個值都是 3600；修改前登入的那一列到期時間不變、cookie 仍可用", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await insertPasswordUser(db);

    const earlier = await login(app, u.email);
    const earlierJwt = await expectIssuedWithTtl(app, db, earlier, TEST_SESSION_TTL);
    const earlierSid = decodeJwt(earlierJwt).sid as string;
    const earlierExpiresAt = await expiresAtOf(db, earlierSid);

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    await expectIssuedWithTtl(app, db, await login(app, u.email), TTL);

    expect((await expiresAtOf(db, earlierSid)).getTime()).toBe(earlierExpiresAt.getTime());
    expect(await me(app, earlierJwt)).toBe(200);
  });

  it("改密碼：換發的 session 三個值都是 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await insertPasswordUser(db);
    const { jwt } = sessionCookieOf(await login(app, u.email));

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: jwt },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(204);
    await expectIssuedWithTtl(app, db, res, TTL);
  });

  it("加上密碼：換發的 session 三個值都是 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const u = await seedUser(db);

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({ method: "POST", url: "/api/auth/password/set", cookies: await cookieOf(u.id), payload: { newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(204);
    await expectIssuedWithTtl(app, db, res, TTL);
  });

  it("以重設連結設新密碼：換發的 session 三個值都是 3600", async () => {
    const { app, db, siteLimits, close } = await buildTestApp();
    onTestFinished(close);
    const admin = await seedUser(db, { isAdmin: true });
    const target = await insertPasswordUser(db);
    const issued = await app.inject({
      method: "POST",
      url: `/api/admin/users/${target.id}/password-reset`,
      cookies: await cookieOf(admin.id),
      payload: { expiresInHours: 1 },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const { token } = issued.json() as { token: string };

    await siteLimits.update(admin.id, { sessionTtlSeconds: TTL });
    const res = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token, newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(200);
    await expectIssuedWithTtl(app, db, res, TTL);
  });
});
