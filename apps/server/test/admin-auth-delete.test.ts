import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { authProviders, userIdentities } from "../src/db/schema.js";
import { createOidcRuntimeRegistry, type OidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, seedAuthProvider, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { adminApp, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";

describe("DELETE /api/admin/auth/providers/:id（#187 §9.2、W11）", () => {
  it("只給站台管理員", async () => {
    const { app, db } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    await expectAdminOnly(app, db, "DELETE", `/api/admin/auth/providers/${p.id}`);
  });

  it("啟用中 → 409 provider_enabled、列還在；不存在 → 404；非 uuid → 404", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: true });
    const res = await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_enabled");
    expect(await providerRow(db, p.id)).toBeDefined();
    const missing = await app.inject({ method: "DELETE", url: "/api/admin/auth/providers/00000000-0000-4000-8000-000000000000", cookies });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/auth/providers/nope", cookies })).statusCode).toBe(404);
  });

  it("RF4d 已停用 → 204（大寫 uuid 路徑同義）；identities 不動（B1）；registry.invalidate 收到小寫 id", async () => {
    const invalidated: string[] = [];
    const inner = createOidcRuntimeRegistry();
    const registry: OidcRuntimeRegistry = { get: inner.get, probe: inner.probe, invalidate: id => { invalidated.push(id); inner.invalidate(id); } };
    const { app, db, cookies } = await adminApp({ oidcRegistry: registry });
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    const user = await seedUser(db);
    await db.insert(userIdentities).values({ userId: user.id, issuer: ISS, sub: "s-1" });
    const res = await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id.toUpperCase()}`, cookies });
    expect(res.statusCode).toBe(204);
    expect(await providerRow(db, p.id)).toBeUndefined();
    expect(await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id))).toHaveLength(1);
    expect(invalidated).toEqual([p.id]);
  });

  it("§14.1-9 停用 → 刪除（既有 session 不撤，Q5）→ 以同 issuer 重建（API）→ 原身分照常登入同一個帳號", async () => {
    const { app, db, idp, provider } = await buildOidcApp({ providers: [{ key: "a", issuerUrl: ISS }] });
    const admin = await seedUser(db, { isAdmin: true });
    const adminCookies = await cookieOf(admin.id);
    const claims = { sub: "keeps-identity", email: "keeps@example.com", name: "Keeps" };
    const first = await ssoRoundTrip(app, idp("a"), { loginUrl: `/api/auth/oidc/login/${provider("a").id}`, claims });
    expect(first.callbackRes.headers.location).toBe("/");
    const meBefore = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: first.cookies[SESSION_COOKIE]! } });

    const oldId = provider("a").id;
    expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${oldId}`, cookies: adminCookies, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${oldId}`, cookies: adminCookies })).statusCode).toBe(204);
    // Q5：停用與刪除都不撤 session——用那個服務登入的 session 仍有效（gate r1-t1-7 M7）。
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: first.cookies[SESSION_COOKIE]! } })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies: adminCookies, payload: { template: "oidc", displayName: "Again", issuerUrl: ISS, clientId: "test-client", clientSecret: "test-secret" } });
    const newId = created.json().id as string;
    expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${newId}`, cookies: adminCookies, payload: { enabled: true } })).statusCode).toBe(200);

    const again = await ssoRoundTrip(app, idp("a"), { loginUrl: `/api/auth/oidc/login/${newId}`, claims });
    expect(again.callbackRes.headers.location).toBe("/");
    expect(again.redirectUri).toBe(`http://localhost:3000/api/auth/oidc/callback/${newId}`);
    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: again.cookies[SESSION_COOKIE]! } });
    expect(meAfter.json().id).toBe(meBefore.json().id);
  });

  it("刪掉 legacy provider（已停用）→ 列真的刪掉；之後以同 issuer 新建的服務不是 legacy、回呼網址帶 id（gate r1-t1-7 M2）", async () => {
    const { app, db, cookies } = await adminApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: ISS, legacyCallback: true, enabled: false });
    expect((await app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${legacy.id}`, cookies })).statusCode).toBe(204);
    expect(await providerRow(db, legacy.id)).toBeUndefined();
    const created = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { template: "oidc", displayName: "SSO", issuerUrl: ISS, clientId: "test-client" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ legacyCallback: false, callbackUrl: `http://localhost:3000/api/auth/oidc/callback/${created.json().id}` });
  });

  it("C7 停用與刪除交錯：DELETE 卡在「另一條連線正把它重新啟用」的行鎖上 → 對方提交後 409 provider_enabled、列還在", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, enabled: false });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      await holder.query("begin");
      await holder.query("update auth_providers set enabled = true where id = $1", [p.id]);
      const pending = app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      res = await pending;
    } finally {
      await holder.end();
    }
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_enabled");
    const [row] = await db.select({ enabled: authProviders.enabled }).from(authProviders).where(eq(authProviders.id, p.id));
    expect(row!.enabled).toBe(true);
  });
});
