import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, userIdentities, users } from "../src/db/schema.js";
import { backfillLegacyOidcIdentities } from "../src/auth/legacy-oidc-env.js";
import { buildTestApp, insertPasswordUser, testConfig, type TestApp } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";

async function holderFor(db: TestApp["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}
async function identity(db: TestApp["db"], userId: string, issuer: string, sub: string): Promise<string> {
  const [row] = await db.insert(userIdentities).values({ userId, issuer, sub }).returning({ id: userIdentities.id });
  return row!.id;
}
const getIds = (app: TestApp["app"], cookies: Record<string, string>) => app.inject({ method: "GET", url: "/api/auth/identities", cookies });
const unlink = (app: TestApp["app"], cookies: Record<string, string>, id: string) =>
  app.inject({ method: "DELETE", url: `/api/auth/identities/${id}`, cookies });

describe("GET /api/auth/identities（#187 §8.3）", () => {
  it("回 identities（providers、unlinkable、不含 sub）、linkable、hasPassword、passwordLoginEnabled（有效值）", async () => {
    const { app, db } = await buildTestApp();
    const pa = await seedAuthProvider(db, { issuerUrl: A, displayName: "A", template: "gitlab" });
    const pb = await seedAuthProvider(db, { issuerUrl: B, displayName: "B", template: "google" });
    await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false, clientSecret: null });
    const u = await insertPasswordUser(db);
    const idA = await identity(db, u.id, A, "sa");
    const res = await getIds(app, await cookieOf(u.id));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identities).toEqual([
      { id: idA, issuer: A, providers: [{ id: pa.id, displayName: "A" }], createdAt: expect.any(String), lastLoginAt: null, unlinkable: true },
    ]);
    expect(JSON.stringify(body)).not.toContain("sa");
    expect(body.linkable).toEqual([{ providerId: pb.id, displayName: "B", template: "google" }]);
    expect(body).toMatchObject({ hasPassword: true, passwordLoginEnabled: true });
  });

  it("r2-N6：Bearer（PAT）→ 401；未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/auth/identities" })).statusCode).toBe(401);
    // 有效 PAT（scope 足以通過 authenticateAny）、不帶 cookie：401 只能來自「只認 session」（Task 7 review r0 I1 同型）。
    const { token } = await seedTokenForUser(db, (await seedUser(db)).id);
    expect((await app.inject({ method: "GET", url: "/api/auth/identities", headers: bearer(token) })).statusCode).toBe(401);
  });

  it("r1-I1 尾斜線形：provider 填 `https://a.example/`、identity 為無斜線——resolved_issuer 寫入前不對、寫入後對", async () => {
    const { app, db } = await buildTestApp();
    const p = await seedAuthProvider(db, { issuerUrl: `${A}/`, displayName: "A" });
    const u = await seedUser(db);
    await identity(db, u.id, A, "sa");
    const before = (await getIds(app, await cookieOf(u.id))).json();
    expect(before.identities[0].providers).toEqual([]);
    expect(before.linkable.map((l: { providerId: string }) => l.providerId)).toEqual([p.id]);
    await db.execute(sql`update auth_providers set resolved_issuer = ${A} where id = ${p.id}`);
    const after = (await getIds(app, await cookieOf(u.id))).json();
    expect(after.identities[0].providers).toEqual([{ id: p.id, displayName: "A" }]);
    expect(after.linkable).toEqual([]);
  });

  it("passwordLoginEnabled 是有效值：DB 關 → false；env 強制＋DB 關 → true", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await getIds(app, await cookieOf(u.id))).json().passwordLoginEnabled).toBe(false);
    const forced = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const v = await insertPasswordUser(forced.db);
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await getIds(forced.app, await cookieOf(v.id))).json().passwordLoginEnabled).toBe(true);
  });
});

describe("unlinkable 與 DELETE 逐格一致（#187 §14.1-25、B24）", () => {
  // 每格：目標身分在 A（A 啟用）。cells＝密碼 × DB 值 × 第二身分（無／B 啟用／B 停用）。
  const cells: Array<[boolean, boolean, "none" | "enabled" | "disabled", boolean]> = [];
  for (const hasPassword of [false, true]) {
    for (const dbValue of [true, false]) {
      for (const second of ["none", "enabled", "disabled"] as const) {
        const expected = (hasPassword && dbValue) || second === "enabled";
        cells.push([hasPassword, dbValue, second, expected]);
      }
    }
  }
  it.each(cells)("密碼=%s、DB=%s、第二身分=%s → unlinkable=%s 且 DELETE 結果一致", async (hasPassword, dbValue, second, expected) => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    if (second !== "none") {
      await seedAuthProvider(db, { issuerUrl: B, enabled: second === "enabled", ...(second === "disabled" ? { clientSecret: null } : {}) });
    }
    const u = hasPassword ? await insertPasswordUser(db) : await seedUser(db);
    const target = await identity(db, u.id, A, "sa");
    if (second !== "none") await identity(db, u.id, B, "sb");
    await db.update(siteSettings).set({ passwordLoginEnabled: dbValue });
    const cookies = await cookieOf(u.id);
    const row = (await getIds(app, cookies)).json().identities.find((i: { id: string }) => i.id === target);
    expect(row.unlinkable).toBe(expected);
    const res = await unlink(app, cookies, target);
    expect(res.statusCode).toBe(expected ? 204 : 409);
    if (!expected) expect(res.json().error.code).toBe("last_login_method");
  });

  it("env 強制＋DB 關、有密碼＋一個身分 → 仍 409（INV-7 看 DB 值，不看 env）", async () => {
    const { app, db } = await buildTestApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    await db.update(siteSettings).set({ passwordLoginEnabled: false });
    const cookies = await cookieOf(u.id);
    expect((await getIds(app, cookies)).json().identities[0].unlinkable).toBe(false);
    expect((await unlink(app, cookies, target)).json().error.code).toBe("last_login_method");
  });
});

describe("DELETE /api/auth/identities/:id（#187 §8.2）", () => {
  it("不屬本人、不存在、非 UUID → 404 not_found；身分不動", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const me = await insertPasswordUser(db);
    const other = await insertPasswordUser(db);
    const theirs = await identity(db, other.id, A, "so");
    const cookies = await cookieOf(me.id);
    for (const id of [theirs, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await unlink(app, cookies, id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    expect(await identitiesOf(db, other.id)).toEqual([{ issuer: A, sub: "so" }]);
  });

  it("RF4：路徑 id 大寫 → 與小寫同義（204、身分刪掉）", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    expect((await unlink(app, await cookieOf(u.id), target.toUpperCase())).statusCode).toBe(204);
    expect(await identitiesOf(db, u.id)).toEqual([]);
  });

  it("同交易清掉吻合的 users.oidc_*；§14.1-16：之後跑 §10.3 補登不會讓它復活（不吻合的舊欄不動）", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    await db.execute(sql`update users set oidc_issuer = ${A}, oidc_sub = 'sa' where id = ${u.id}`);
    const v = await insertPasswordUser(db);
    const vTarget = await identity(db, v.id, A, "sv");
    await db.execute(sql`update users set oidc_issuer = ${A}, oidc_sub = 'other-sub' where id = ${v.id}`);

    expect((await unlink(app, await cookieOf(u.id), target)).statusCode).toBe(204);
    expect((await unlink(app, await cookieOf(v.id), vTarget)).statusCode).toBe(204);
    const [uRow] = await db.select({ i: users.oidcIssuer, s: users.oidcSub }).from(users).where(eq(users.id, u.id));
    expect(uRow).toEqual({ i: null, s: null });
    const [vRow] = await db.select({ i: users.oidcIssuer, s: users.oidcSub }).from(users).where(eq(users.id, v.id));
    expect(vRow).toEqual({ i: A, s: "other-sub" });

    const logger = { warn: () => {} } as unknown as Parameters<typeof backfillLegacyOidcIdentities>[1];
    await backfillLegacyOidcIdentities(db, logger);
    expect(await identitiesOf(db, u.id)).toEqual([]);
  });

  it("不撤 session：解除後同一顆 cookie 打 /me 仍 200", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    const u = await insertPasswordUser(db);
    const target = await identity(db, u.id, A, "sa");
    const cookies = await cookieOf(u.id);
    expect((await unlink(app, cookies, target)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
  });

  it("C10：同人並發解除最後兩個身分——另一連線持 users 鎖並刪了 X → 這邊解除 Y 等它提交 → 409 last_login_method", async () => {
    const { app, db } = await buildTestApp();
    await seedAuthProvider(db, { issuerUrl: A });
    await seedAuthProvider(db, { issuerUrl: B });
    const u = await seedUser(db);
    const x = await identity(db, u.id, A, "sa");
    const y = await identity(db, u.id, B, "sb");
    const holder = await holderFor(db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [u.id]);
      await holder.query("delete from user_identities where id = $1", [x]);
      const pending = unlink(app, await cookieOf(u.id), y);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("last_login_method");
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  // 這案不呼叫 P2（holder 以手打 SQL 擺出解除交易的鎖足跡）：守的只是 r3-N10「登入影響 0 列照樣簽 session」。
  // P2 與登入的真並發（C24）見下一案。
  it("r3-N10：登入撞上解除已刪未提交的身分 → 等它提交、0 列照樣簽 session", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }] });
    const u = await insertPasswordUser(t.db);
    const idA = await identity(t.db, u.id, A, "sa");
    const holder = await holderFor(t.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [u.id]);
      await holder.query("select password_login_enabled from site_settings where singleton for share");
      await holder.query("delete from user_identities where id = $1", [idA]);
      const pending = ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: u.email } });
      expect(await waitForBlockedOrSettled(t.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const r = await pending;
      expect(r.callbackRes.headers.location).toBe("/");
      expect(r.cookies[SESSION_COOKIE]).toBeTruthy();
    } finally {
      await holder.end();
    }
  });

  it("C24：真 P2 持 users 鎖卡在身分列上 → 真 SSO 登入（同帳號另一身分）不等 users、照樣完成；放行後 P2 → 204、無 40P01", async () => {
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] });
    const u = await insertPasswordUser(t.db);
    const idA = await identity(t.db, u.id, A, "sa");
    await identity(t.db, u.id, B, "sb");
    const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"timeout">(r => setTimeout(() => r("timeout"), ms))]);
    const holder = await holderFor(t.db);
    try {
      // holder＝「登入 A 進行中」的鎖足跡（A1 login 分支：site_settings FOR SHARE＋UPDATE 該身分列，未提交）。
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for share");
      await holder.query("update user_identities set last_login_at = now() where id = $1", [idA]);
      const del = unlink(t.app, await cookieOf(u.id), idA);
      // 真 P2 已持 users NKU＋site_settings SHARE，卡在刪 A 那一列。
      expect(await waitForBlockedOrSettled(t.db.$client, del)).toBe("blocked");
      const login = ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: u.email } });
      const r = await within(login, 5000);
      expect(r).not.toBe("timeout");
      if (r !== "timeout") {
        expect(r.callbackRes.headers.location).toBe("/");
        expect(r.cookies[SESSION_COOKIE]).toBeTruthy();
      }
      await holder.query("commit");
      expect((await del).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });
});
