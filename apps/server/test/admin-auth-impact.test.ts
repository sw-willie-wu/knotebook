import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { insertPasswordUser } from "./helpers.js";
import { seedUser } from "./group-helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, expectAdminOnly } from "./helpers/admin-auth.js";

const IA = "https://a.example.com";
const IB = "https://b.example.com";

type Built = Awaited<ReturnType<typeof adminApp>>;
async function identity(db: Built["db"], userId: string, issuer: string, sub: string) {
  await db.insert(userIdentities).values({ userId, issuer, sub });
}
async function impact(built: Built, id: string) {
  const res = await built.app.inject({ method: "GET", url: `/api/admin/auth/providers/${id}/impact`, cookies: built.cookies });
  return { status: res.statusCode, body: res.json() };
}

describe("GET /api/admin/auth/providers/:id/impact（#187 §9.3，PR2 公式：「無密碼」＝password_hash IS NULL）", () => {
  it("只給站台管理員", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA });
    await expectAdminOnly(built.app, built.db, "GET", `/api/admin/auth/providers/${a.id}/impact`);
  });

  it("linked／lockedOut：有密碼不算 locked、還有別的啟用中服務不算 locked、停用帳號不算、沒連這個 issuer 不算；別的服務停用後轉成 locked", async () => {
    const built = await adminApp();
    const { db } = built;
    const a = await seedAuthProvider(db, { issuerUrl: IA, resolvedIssuer: IA });
    const b = await seedAuthProvider(db, { issuerUrl: IB, resolvedIssuer: IB });
    const withPassword = await insertPasswordUser(db);
    await identity(db, withPassword.id, IA, "u1");
    const ssoOnly = await seedUser(db);
    await identity(db, ssoOnly.id, IA, "u2");
    const twoIdps = await seedUser(db);
    await identity(db, twoIdps.id, IA, "u3");
    await identity(db, twoIdps.id, IB, "u3b");
    const disabled = await seedUser(db, { disabled: true });
    await identity(db, disabled.id, IA, "u4");
    const onlyB = await seedUser(db);
    await identity(db, onlyB.id, IB, "u5");

    expect(await impact(built, a.id)).toEqual({ status: 200, body: { linkedUsers: 3, lockedOutUsers: 1, issuerResolved: true } });
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, b.id));
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 3, lockedOutUsers: 2, issuerResolved: true });
  });

  it("同一個帳號在這個 issuer 只算一次（補登可能留下同 issuer 兩個 sub，r2-N4）", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, IA, "x1");
    await identity(built.db, u.id, IA, "x2");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 1, issuerResolved: true });
  });

  it("RF2 兩個啟用中的服務指向同一個 issuer：停用其中一個，只連這個 issuer 的純 SSO 帳號仍可用另一個 → 不算 locked", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA, clientId: "second-client" });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, IA, "twin");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true });
  });

  it.each([
    ["尾斜線形", "https://gitlab.example/"],
    ["大寫 host 形（gate r1-t1-7 M7）", "https://GitLab.Example"],
  ])("§14.1-12 %s：resolved_issuer 為 NULL 時對不上（issuerResolved=false、0 人）；測試連線寫入後對上", async (_name, typed) => {
    const idp = createFakeIdp("https://gitlab.example");
    const built = await adminApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch: idp.fetch }) });
    const p = await seedAuthProvider(built.db, { issuerUrl: typed });
    const u = await seedUser(built.db);
    await identity(built.db, u.id, "https://gitlab.example", "tail");
    expect((await impact(built, p.id)).body).toEqual({ linkedUsers: 0, lockedOutUsers: 0, issuerResolved: false });
    expect((await built.app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies: built.cookies })).statusCode).toBe(200);
    expect((await impact(built, p.id)).body).toEqual({ linkedUsers: 1, lockedOutUsers: 1, issuerResolved: true });
  });

  it("RF4i 大寫 uuid 路徑同義；不存在 → 404；非 uuid → 404", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA });
    expect((await impact(built, a.id.toUpperCase())).status).toBe(200);
    expect(await impact(built, "00000000-0000-4000-8000-000000000000")).toEqual({ status: 404, body: { error: { code: "not_found", message: "找不到此登入服務" } } });
    expect((await impact(built, "zzz")).status).toBe(404);
  });

  it("停用帳號不論有沒有密碼都不計（§9.3「未停用的帳號數」）", async () => {
    const built = await adminApp();
    const a = await seedAuthProvider(built.db, { issuerUrl: IA, resolvedIssuer: IA });
    const u = await insertPasswordUser(built.db);
    await built.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
    await identity(built.db, u.id, IA, "d");
    expect((await impact(built, a.id)).body).toEqual({ linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true });
  });
});
