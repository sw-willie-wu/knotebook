import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { buildOidcApp, identitiesOf, ssoRoundTrip, type OidcTestApp } from "./helpers/oidc-provider.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import { OIDC_PENDING_COOKIE, sealPendingLink, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { signSession } from "../src/auth/session.js";
import { hashPassword } from "../src/auth/password.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";

vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});
import { HashBusyError, verifyPassword } from "../src/auth/password.js";
afterEach(() => vi.mocked(verifyPassword).mockClear());

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const PW = "correct-horse-battery-staple";

/**
 * 既有帳號（有密碼）＋ provider B 同 email 首登 → 停在 /link-account（內含斷言）。回 pending cookie 與 pendingId。
 * `beforeSso` 在建帳之後、SSO 之前執行（例如先替帳號插一列同 issuer 的身分）——「證明前仍是 /link-account」才真的被測到。
 */
async function toPending(
  t: OidcTestApp,
  opts: { mustChangePassword?: boolean; next?: string; email?: string; beforeSso?: (userId: string) => Promise<void> } = {},
) {
  const email = opts.email ?? "target@x.example";
  const user = await insertPasswordUser(t.db, { email, password: PW, mustChangePassword: opts.mustChangePassword ?? false });
  if (opts.beforeSso !== undefined) await opts.beforeSso(user.id);
  const q = opts.next !== undefined ? `?next=${encodeURIComponent(opts.next)}` : "";
  const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}${q}`, claims: { sub: "sb", email } });
  expect(r.callbackRes.headers.location).toBe("/link-account");
  const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
  const pendingId = unsealPendingLink(testConfig.appSecret, cookie, Math.floor(Date.now() / 1000))!.pendingId;
  return { user, cookie, pendingId };
}
const twoProviders = () => buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] });
const confirm = (t: OidcTestApp, cookie: string, body: unknown, extraCookies: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie, ...extraCookies }, payload: body as object });

describe("GET /api/auth/oidc/pending（#187 §7.5.2 第 2 步）", () => {
  it("200：pendingId／email／providerDisplayName／methods（每次重算）；沒有 cookie → 401", async () => {
    const t = await twoProviders();
    const { cookie, pendingId } = await toPending(t);
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pendingId, email: "target@x.example", providerDisplayName: "B", methods: { password: true, providers: [] } });
    expect((await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending" })).statusCode).toBe(401);
  });

  it("純 SSO 帳號：methods.providers 列出已連結且啟用中的；provider 停用後重算 → 409 oidc_link_no_proof_method", async () => {
    const t = await twoProviders();
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sa", email: "sso@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "sso@x.example" } });
    const cookie = r.cookies[OIDC_PENDING_COOKIE]!;
    const get = () => t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect((await get()).json().methods).toEqual({ password: false, providers: [{ id: t.provider("a").id, displayName: "A" }] });
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const res = await get();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("oidc_link_no_proof_method");
  });

  it("目標帳號 email 已改 → 409 oidc_link_expired 並清 cookie", async () => {
    const t = await twoProviders();
    const { user, cookie } = await toPending(t);
    await t.db.update(users).set({ email: "changed@x.example" }).where(eq(users.id, user.id));
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("oidc_link_expired");
    expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
  });

  it("RF2b：兩個啟用中的 provider 指向帳號已連結的同一個 issuer → methods.providers 兩個都列", async () => {
    const t = await buildOidcApp({ providers: [
      { key: "a1", issuerUrl: A, displayName: "A one", sortOrder: 1 }, { key: "a2", issuerUrl: `${A}/`, displayName: "A two", sortOrder: 2, resolvedIssuer: A },
      { key: "b", issuerUrl: B, displayName: "B" },
    ] });
    await ssoRoundTrip(t.app, t.idp("a1"), { loginUrl: `/api/auth/oidc/login/${t.provider("a1").id}`, claims: { sub: "sa", email: "x@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: "x@x.example" } });
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: r.cookies[OIDC_PENDING_COOKIE]! } });
    expect(res.json().methods.providers).toEqual([{ id: t.provider("a1").id, displayName: "A one" }, { id: t.provider("a2").id, displayName: "A two" }]);
  });

  it("B14（Task 6 裁定 A）：帳號有 pending issuer 的另一個 sub＋另一 issuer 的已啟用 provider 身分＋密碼 → providers 只列另一 issuer、不列 pending issuer", async () => {
    const t = await twoProviders();
    // 身分在 SSO 之前就在：B 的另一個 sub（同 issuer）與 A 的身分（另一 issuer）。列出 B 就等於證明前告訴對方「這帳號已連過 B」。
    const { cookie, pendingId } = await toPending(t, {
      beforeSso: async userId => {
        await t.db.insert(userIdentities).values([{ userId, issuer: B, sub: "older-sub" }, { userId, issuer: A, sub: "sa" }]);
      },
    });
    const res = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pendingId, email: "target@x.example", providerDisplayName: "B", methods: { password: true, providers: [{ id: t.provider("a").id, displayName: "A" }] } });
  });
});

describe("POST /api/auth/oidc/pending/confirm（#187 §7.5.2–§7.5.4）", () => {
  it("§14.1-2：密碼正確 → 200 {user, next:'/'}、簽 session、清 pending、寫第二列 identity；之後 B 直接登入", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.insert(userIdentities).values({ userId: user.id, issuer: A, sub: "sa" });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: user.id, email: user.email, hasPassword: true, mustChangePassword: false }, next: "/" });
    expect(res.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    expect(res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "sa" }, { issuer: B, sub: "sb" }]);
    const again = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "sb", email: user.email } });
    expect(again.callbackRes.headers.location).toBe("/");
  });

  it("B15：旗標為 true 的帳號以密碼連結後旗標仍 true（/api/auth/me 也是）；回應的 next 來自 pending 且已過 safeNextPath", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t, { mustChangePassword: true, next: "/n/alice/x" });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.json()).toMatchObject({ user: { mustChangePassword: true }, next: "/n/alice/x" });
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: res.cookies.find(c => c.name === SESSION_COOKIE)!.value } });
    expect(me.json().mustChangePassword).toBe(true);
    const [row] = await t.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, user.id));
    expect(row!.m).toBe(true);
  });

  it("錯密碼 → 401 invalid_credentials、不寫入；吃 LoginThrottle（同 email 鍵）：5 次後第 6 次 429，且 /api/auth/login 同 email 也 429", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    for (let i = 0; i < 5; i++) {
      const r = await confirm(t, cookie, { password: "wrong-password-xx", pendingId });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe("invalid_credentials");
    }
    const sixth = await confirm(t, cookie, { password: PW, pendingId });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(typeof sixth.json().retryAfterMs).toBe("number");
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password: PW } });
    expect(login.statusCode).toBe(429);
    // 上一行分不出帳號軌：同一個來源 IP 的 IP 軌也是 5 次門檻，本身就擋（Task 10 突變 M1 實跑存活）。換來源 IP 只剩帳號軌——
    // confirm 與 /api/auth/login 用同一個 email 鍵才會 429；鍵若不同，這裡密碼正確 → 200。
    const loginOtherIp = await t.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.9.8.6", payload: { email: user.email, password: PW } });
    expect(loginOtherIp.statusCode).toBe(429);
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("HashBusyError → 429 server_busy", async () => {
    const t = await twoProviders();
    const { cookie, pendingId } = await toPending(t);
    vi.mocked(verifyPassword).mockRejectedValueOnce(new HashBusyError());
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("server_busy");
  });

  it("B14：先驗密碼再判停用——停用＋錯密碼 → 401；停用＋對密碼 → 403 account_disabled", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await confirm(t, cookie, { password: "wrong-password-xx", pendingId })).statusCode).toBe(401);
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("account_disabled");
  });

  it("§14.1-3 B2：帳號已有同 issuer 另一個 sub → 證明前是 /link-account、以密碼證明後 409 identity_already_linked", async () => {
    const t = await twoProviders();
    // 身分要在 SSO **之前**就在（gate r1 t8-13 M2）：toPending 內的 `/link-account` 斷言才是「證明前不揭露 B2」的那一條。
    const { user, cookie, pendingId } = await toPending(t, {
      beforeSso: async userId => {
        await t.db.insert(userIdentities).values({ userId, issuer: B, sub: "older-sub" });
      },
    });
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("identity_already_linked");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "older-sub" }]);
  });

  it("r3-N4：tx 拒絕（403 停用）時 recordSuccess／recordFailure 都不記——帳號軌的失敗數不被清掉", async () => {
    // gate r1 t8-13 I3。帳號軌第 5 次失敗起擋（`auth/rate-limit.ts` evaluateRecord：failureCount < 5 不擋，5 次後 2^(5-4)=2 秒）。
    // ⚠ 最後兩步換一個來源 IP：LoginThrottle 的 IP 軌不會被 recordSuccess 清（同檔 recordSuccess 只刪帳號軌），同一個 IP
    // 打第 5 次失敗時 IP 軌也滿 5 → 不論帳號軌有沒有被清都 429，突變看不出來。換 IP 後只剩帳號軌在決定結果。
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    for (let i = 0; i < 4; i++) {
      expect((await confirm(t, cookie, { password: "wrong-password-xx", pendingId })).statusCode).toBe(401);
    }
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(403);
    await t.db.update(users).set({ disabledAt: null }).where(eq(users.id, user.id));
    const fromOtherIp = (password: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", remoteAddress: "10.9.8.7", cookies: { [OIDC_PENDING_COOKIE]: cookie }, payload: { password, pendingId } });
    expect((await fromOtherIp("wrong-password-xx")).statusCode).toBe(401);
    // 帳號軌此時累計 5 次失敗 → 擋。突變「tx 失敗也 recordSuccess」會在 403 那步清掉帳號軌 → 這裡只剩 1 次失敗 → 200。
    const last = await fromOtherIp(PW);
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe("too_many_attempts");
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("§14.1-4 cookie 過期：exp 已過的 pending → confirm 401 unauthorized、不寫入（與「沒有 pending」同一條路徑；spec 疑點第 12 條）", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    const nowS = Math.floor(Date.now() / 1000);
    const payload = unsealPendingLink(testConfig.appSecret, cookie, nowS)!;
    const expired = sealPendingLink(testConfig.appSecret, { ...payload, exp: nowS - 1 });
    const res = await confirm(t, expired, { password: PW, pendingId });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect((await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: expired } })).statusCode).toBe(401);
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("C18：pendingId 與 cookie 不符（另一分頁覆蓋）→ 409 oidc_link_expired；C12：同一顆 cookie 雙送出 → 第二次冪等 200", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    const bad = await confirm(t, cookie, { password: PW, pendingId: "not-the-same" });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("oidc_link_expired");
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  it("body：缺 pendingId → 400 invalid_body；form 形 → 415（CSRF hook）；沒有 pending cookie → 401", async () => {
    const t = await twoProviders();
    const { cookie } = await toPending(t);
    expect((await confirm(t, cookie, { password: PW })).statusCode).toBe(400);
    const form = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: cookie }, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "password=x&pendingId=y" });
    expect(form.statusCode).toBe(415);
    const none = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", payload: { password: PW, pendingId: "x" } });
    expect(none.statusCode).toBe(401);
  });

  it("C23：密碼驗過之後、寫入之前本人改了密碼 → 401 invalid_credentials、不寫入", async () => {
    const holder: { db?: OidcTestApp["db"] } = {};
    const hook: OidcTestHook = async point => {
      if (point === "pending-confirm-verified") {
        await holder.db!.update(users).set({ passwordHash: await hashPassword("a-brand-new-password") }).where(eq(users.email, "target@x.example"));
      }
    };
    const t = await buildOidcApp({ providers: [{ key: "a", issuerUrl: A }, { key: "b", issuerUrl: B }] }, { oidcTestHook: hook });
    holder.db = t.db;
    const { user, cookie, pendingId } = await toPending(t);
    const res = await confirm(t, cookie, { password: PW, pendingId });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_credentials");
    expect(await identitiesOf(t.db, user.id)).toEqual([]);
  });

  it("RF3：pending 期間要連結的 provider 被刪掉 → GET 的 providerDisplayName 為 null；密碼證明仍能連結（B1）", async () => {
    const t = await twoProviders();
    const { user, cookie, pendingId } = await toPending(t);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("b").id));
    await t.db.delete(authProviders).where(eq(authProviders.id, t.provider("b").id));
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(get.json().providerDisplayName).toBeNull();
    expect((await confirm(t, cookie, { password: PW, pendingId })).statusCode).toBe(200);
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: B, sub: "sb" }]);
  });

  it("RF4：瀏覽器已登入另一個帳號 V → 完成連結後回應的 session 是目標帳號；V 的舊 session 不受影響", async () => {
    const t = await twoProviders();
    const v = await insertPasswordUser(t.db, { email: "v@x.example" });
    const vCookie = await signSession(testConfig.appSecret, { userId: v.id, tv: 0 });
    const { user, cookie, pendingId } = await toPending(t);
    const res = await confirm(t, cookie, { password: PW, pendingId }, { [SESSION_COOKIE]: vCookie });
    const newSession = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newSession } });
    expect(me.json().id).toBe(user.id);
    const meV = await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: vCookie } });
    expect(meV.json().id).toBe(v.id);
  });
});

describe("POST /api/auth/oidc/pending/cancel", () => {
  it("204、清 pending cookie（之後 GET → 401）", async () => {
    const t = await twoProviders();
    const { cookie } = await toPending(t);
    const res = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/cancel", cookies: { [OIDC_PENDING_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find(c => c.name === OIDC_PENDING_COOKIE)!;
    expect(cleared).toMatchObject({ value: "", path: "/api/auth/oidc" });
  });
});
