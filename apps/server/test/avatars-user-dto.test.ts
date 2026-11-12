/**
 * `UserDto.avatar` 的每一處產生點各一案：
 * 閘門（`GET /api/auth/me`）、帳密登入、重設密碼、OIDC 待定連結、`PATCH /api/auth/profile` 的兩個分支（純 UPDATE／改名交易）、
 * 註冊、接受邀請。再加一案證明閘門的 60 秒快取要靠 `invalidate` 才會換新。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { UserAvatarDto } from "@knotebook/shared";
import { buildTestApp, freshDb, insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildOidcApp, ssoRoundTrip } from "./helpers/oidc-provider.js";
import { seedAvatarRow } from "./avatar-helpers.js";
import { userAvatars } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { UserGate } from "../src/auth/session.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";

const PW = "correct-horse-battery-staple";

/** alice 的目前頭貼（版本 3）加一張非目前的舊候選（先插，讀取若漏掉 is_current 條件會先撿到它）；回目前那張該有的 DTO。 */
async function giveAlicePicture(db: Db, userId: string): Promise<UserAvatarDto> {
  await seedAvatarRow(db, { userId, originalSize: 4000, displaySize: 200 });
  const current = await seedAvatarRow(db, { userId, originalSize: 5000, displaySize: 300, isCurrent: true });
  await db.update(userAvatars).set({ version: 3 }).where(eq(userAvatars.id, current));
  return { id: current, v: 3, pending: false };
}

describe("UserDto.avatar：閘門（GET /api/auth/me）", () => {
  it("alice 有目前頭貼（另有一張非目前的候選）→ 只回目前那張；沒有頭貼的 bob → null", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(a.statusCode).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(bob.id) });
    expect(b.json().avatar).toBeNull();
  });

  it("顯示圖尚未補產的目前頭貼 → pending: true", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 800, displaySize: 0, isCurrent: true });
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(res.json().avatar).toEqual({ id, v: 1, pending: true });
  });

  it("閘門有 60 秒快取：換掉目前頭貼後 /me 仍是舊值，invalidate 之後才是新值", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    const { app } = await buildTestApp({ db, gate });
    const alice = await seedUser(db);
    const first = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const cookies = await cookieOf(alice.id);
    const read = async () => (await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar;
    expect(await read()).toEqual({ id: first, v: 1, pending: false });

    await db.update(userAvatars).set({ isCurrent: false }).where(eq(userAvatars.id, first));
    const second = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    expect(await read()).toEqual({ id: first, v: 1, pending: false });
    gate.invalidate(alice.id);
    expect(await read()).toEqual({ id: second, v: 1, pending: false });
  });
});

describe("UserDto.avatar：手組的產生點", () => {
  it("帳密登入", async () => {
    const { app, db } = await buildTestApp();
    const alice = await insertPasswordUser(db);
    const bob = await insertPasswordUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: alice.email, password: PW } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: bob.email, password: PW } });
    expect(b.json().avatar).toBeNull();
    // 顯示圖尚未補產的目前頭貼，手組的產生點也要帶 pending: true
    const carol = await insertPasswordUser(db);
    const waiting = await seedAvatarRow(db, { userId: carol.id, originalSize: 800, displaySize: 0, isCurrent: true });
    const c = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: carol.email, password: PW } });
    expect(c.json().avatar).toEqual({ id: waiting, v: 1, pending: true });
  });

  it("重設密碼成功的回應", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const alice = await insertPasswordUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${alice.id}/password-reset`, cookies: await cookieOf(admin.id), payload: { expiresInHours: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const res = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token: issued.json().token, newPassword: "brand-new-password-404" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().avatar).toEqual(expected);
  });

  it("OIDC 待定連結：以密碼確認後的回應", async () => {
    const A = "https://idp-a.example";
    const t = await buildOidcApp({ providers: [{ key: "b", issuerUrl: A, displayName: "B" }] });
    const alice = await insertPasswordUser(t.db, { email: "alice@x.example", password: PW });
    const expected = await giveAlicePicture(t.db, alice.id);
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: alice.email } });
    expect(r.callbackRes.headers.location).toBe("/link-account");
    const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, cookie, Math.floor(Date.now() / 1000))!.pendingId;
    const res = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie }, payload: { password: PW, pendingId } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.avatar).toEqual(expected);
  });

  it("註冊：新帳號 avatar 為 null", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "carol@x.example", password: PW, displayName: "Carol" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toHaveProperty("avatar", null);
  });

  it("接受邀請：新帳號 avatar 為 null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const issued = await app.inject({ method: "POST", url: "/api/admin/invites", cookies: await cookieOf(admin.id), payload: { expiresInDays: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const res = await app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: issued.json().token, email: "dave@x.example", password: PW, displayName: "Dave" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toHaveProperty("avatar", null);
  });
});

describe("UserDto.avatar：PATCH /api/auth/profile（RETURNING 的兩個分支）", () => {
  it("只改 autoVersions（純 UPDATE 分支）：avatar 與 /me 相同", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(alice.id), payload: { autoVersions: false } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().avatar).toEqual(expected);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(me.json().avatar).toEqual(a.json().avatar);
    const b = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(bob.id), payload: { autoVersions: false } });
    expect(b.json().avatar).toBeNull();
  });

  it("改 handle（改名交易分支）：avatar 非 null，沒有頭貼的人是 null", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const expected = await giveAlicePicture(db, alice.id);
    const a = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(alice.id), payload: { handle: "alice-renamed" } });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().handle).toBe("alice-renamed");
    expect(a.json().avatar).toEqual(expected);
    const b = await app.inject({ method: "PATCH", url: "/api/auth/profile", cookies: await cookieOf(bob.id), payload: { handle: "bob-renamed" } });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().avatar).toBeNull();
  });
});
