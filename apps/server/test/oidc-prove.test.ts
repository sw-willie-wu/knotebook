import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, identitiesOf, ssoRoundTrip, type OidcTestApp } from "./helpers/oidc-provider.js";
import { GENERIC } from "./helpers/provider-icon.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import { OIDC_PENDING_COOKIE, unsealPendingLink } from "../src/auth/oidc-pending.js";
import { unsealOidcState } from "../src/auth/oidc-state.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";
import type { FakeIdpClaims } from "./helpers/fake-idp.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
const nowS = () => Math.floor(Date.now() / 1000);

/** 純 SSO 帳號 U（身分在 A）＋ B 同 email 首登 → pending。 */
async function ssoOnlyPending(t: OidcTestApp, next?: string) {
  await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "ua", email: "u@x.example" } });
  const [u] = await t.db.select().from(users).where(eq(users.email, "u@x.example"));
  const q = next !== undefined ? `?next=${encodeURIComponent(next)}` : "";
  const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}${q}`, claims: { sub: "ub", email: "u@x.example" } });
  const pending = r.cookies[OIDC_PENDING_COOKIE]!;
  return { user: u!, pending, pendingId: unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId };
}

/** prove 起點 → fake IdP authorize（以 claims 登入）→ callback。回 callback 回應與起點回應。 */
async function prove(t: OidcTestApp, key: string, cookies: Record<string, string>, pendingId: string, claims: FakeIdpClaims) {
  const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider(key).id}`, cookies, payload: { pendingId } });
  if (start.statusCode !== 200) return { start, callback: undefined };
  t.idp(key).setNextLogin(claims);
  const { code, state } = t.idp(key).authorize(start.json().url);
  const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  const callback = await t.app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback/${t.provider(key).id}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { ...cookies, [OIDC_STATE_COOKIE]: stateCookie },
  });
  return { start, callback };
}

const app2 = (over = {}) => buildOidcApp({ providers: [{ key: "a", issuerUrl: A, displayName: "A" }, { key: "b", issuerUrl: B, displayName: "B" }] }, over);

describe("SSO 證明（#187 §7.5.3，§14.1-4a）", () => {
  it("純 SSO 帳號：methods={password:false, providers:[A]}；以 A 證明 → B 的身分（取自 pending）連到 U、session、旗標不清、清 pending、A 的 last_login_at 更新", async () => {
    const t = await app2();
    const { user, pending, pendingId } = await ssoOnlyPending(t, "/n/alice/x");
    await t.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: false, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const { start, callback } = await prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "whatever@else.example" });
    expect(start.statusCode).toBe(200);
    expect(new URL(start.json().url).origin).toBe(A);
    const st = unsealOidcState(testConfig.appSecret, start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value, nowS());
    expect(st).toMatchObject({ intent: "prove", providerId: t.provider("a").id, pendingId, proveUserId: user.id });
    expect(st && "next" in st).toBe(false);
    expect(callback!.headers.location).toBe("/n/alice/x");
    expect(callback!.cookies.find(c => c.name === SESSION_COOKIE)?.value).toBeTruthy();
    expect(callback!.cookies.find(c => c.name === OIDC_PENDING_COOKIE)?.value).toBe("");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
    const [row] = await t.db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, user.id));
    expect(row!.m).toBe(true);
    const [proof] = await t.db.select().from(userIdentities).where(eq(userIdentities.sub, "ua"));
    expect(proof!.lastLoginAt).not.toBeNull();
  });

  it("綁定：用 A 登入的是另一個帳號 V 的身分 → /link-account?error=oidc_link_proof_mismatch、不寫入、pending 保留；之後以密碼仍可成功（有密碼又有 A 的帳號）", async () => {
    const t = await app2();
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: A, sub: "ua" });
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "va", email: "v@x.example" } });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: true, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const { callback } = await prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "va", email: "v@x.example" });
    expect(callback!.headers.location).toBe("/link-account?error=oidc_link_proof_mismatch");
    expect(callback!.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "ua" }]);
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { password: "correct-horse-battery-staple", pendingId } });
    expect(ok.statusCode).toBe(200);
  });

  it("state 的 pendingId 與當下 pending 不符（另一分頁覆蓋了 pending）→ /link-account?error=oidc_link_expired（不清 pending，M1）；callback 時 pending 已不在 → 同；起點沒有 pending → 401", async () => {
    const t = await app2();
    const first = await ssoOnlyPending(t);
    // (a) callback 時 pending cookie 已不在（過期或被清——`readPendingLink` 都回 null）：只帶 state cookie 回來（gate r1 t8-13 M3）。
    const s0 = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: first.pending }, payload: { pendingId: first.pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const a0 = t.idp("a").authorize(s0.json().url);
    const cb0 = await t.app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${a0.code}&state=${a0.state}`,
      cookies: { [OIDC_STATE_COOKIE]: s0.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value },
    });
    expect(cb0.headers.location).toBe("/link-account?error=oidc_link_expired");
    expect(await identitiesOf(t.db, first.user.id)).toEqual([{ issuer: A, sub: "ua" }]);
    // (b) 另一分頁覆蓋了 pending。
    const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: first.pending }, payload: { pendingId: first.pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const { code, state } = t.idp("a").authorize(start.json().url);
    const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    // 同一瀏覽器另一分頁再走一次 B → pending 被覆蓋（新 pendingId）。
    const again = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const overwritten = again.cookies[OIDC_PENDING_COOKIE]!;
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: overwritten, [OIDC_STATE_COOKIE]: stateCookie } });
    expect(cb.headers.location).toBe("/link-account?error=oidc_link_expired");
    // M1／C18：不符時不清 cookie——覆蓋後的新 pending 屬於另一分頁，仍有效。
    expect(cb.cookies.find(c => c.name === OIDC_PENDING_COOKIE)).toBeUndefined();
    const stillThere = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: overwritten } });
    expect(stillThere.statusCode).toBe(200);
    const second = await prove(t, "a", { [OIDC_PENDING_COOKIE]: overwritten }, unsealPendingLink(testConfig.appSecret, overwritten, nowS())!.pendingId, { sub: "ua", email: "u@x.example" });
    expect(second.callback!.statusCode).toBe(302);
    const noPending = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, payload: { pendingId: "x" } });
    expect(noPending.statusCode).toBe(401);
  });

  it("起點：provider 未連結／停用／非 uuid → 404 provider_not_found（不區分）；pendingId 不符 → 409；無 body → 400；form → 415", async () => {
    const t = await app2();
    const { pending, pendingId } = await ssoOnlyPending(t);
    const post = (id: string, payload?: unknown, headers?: Record<string, string>) =>
      t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, ...(payload !== undefined ? { payload: payload as object } : {}), ...(headers ? { headers } : {}) });
    for (const id of [t.provider("b").id, "not-a-uuid"]) {
      const r = await post(id, { pendingId });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("provider_not_found");
    }
    expect((await post(t.provider("a").id, { pendingId: "other" })).json().error.code).toBe("oidc_link_expired");
    expect((await post(t.provider("a").id)).statusCode).toBe(400);
    const form = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `pendingId=${pendingId}` });
    expect(form.statusCode).toBe(415);
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    expect((await post(t.provider("a").id, { pendingId })).statusCode).toBe(404);
  });

  it("B14：帳號已有待連結 issuer（B）的另一個 sub → 起點對 B 回 404 provider_not_found（與 GET pending 同一個排除），A 仍可用", async () => {
    const t = await app2();
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values([{ userId: u.id, issuer: A, sub: "ua" }, { userId: u.id, issuer: B, sub: "older-b" }]);
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.json().methods).toEqual({ password: true, providers: [{ id: t.provider("a").id, displayName: "A", icon: GENERIC }] });
    const post = (key: string) => t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider(key).id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    const viaB = await post("b");
    expect(viaB.statusCode).toBe(404);
    expect(viaB.json().error.code).toBe("provider_not_found");
    expect(viaB.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
    expect((await post("a")).statusCode).toBe(200);
  });

  it("§14.1-4a 第 2 點 B2：帳號已有 A(sub-1)＋B → 以 A 的另一個 sub 首登，證明前不揭露 B2；用 B 證明完 → /link-account?error=identity_already_linked、不寫入", async () => {
    const t = await app2();
    await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sub-1", email: "u@x.example" } });
    const [u] = await t.db.select().from(users).where(eq(users.email, "u@x.example"));
    await t.db.insert(userIdentities).values({ userId: u!.id, issuer: B, sub: "ub" });
    const r = await ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "sub-2", email: "u@x.example" } });
    // 證明前：callback 只導 /link-account，GET pending 只列 B（A 被同 issuer 排除），都不透露「已有 A 的另一個 sub」。
    expect(r.callbackRes.headers.location).toBe("/link-account");
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const get = await t.app.inject({ method: "GET", url: "/api/auth/oidc/pending", cookies: { [OIDC_PENDING_COOKIE]: pending } });
    expect(get.statusCode).toBe(200);
    expect(get.json().methods).toEqual({ password: false, providers: [{ id: t.provider("b").id, displayName: "B", icon: GENERIC }] });
    expect(JSON.stringify(get.json())).not.toContain("identity_already_linked");
    const { start, callback } = await prove(t, "b", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ub", email: "u@x.example" });
    expect(start.statusCode).toBe(200);
    expect(callback!.headers.location).toBe("/link-account?error=identity_already_linked");
    expect(callback!.cookies.find(c => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(await identitiesOf(t.db, u!.id)).toEqual([{ issuer: A, sub: "sub-1" }, { issuer: B, sub: "ub" }]);
    expect(await t.db.select().from(userIdentities).where(eq(userIdentities.sub, "sub-2"))).toEqual([]);
  });

  it("C19：往返途中證明用的 provider 被停用 → callback 302 /login?error=oidc_unavailable；身分被刪 → oidc_link_proof_mismatch", async () => {
    const t = await app2();
    const { user, pending, pendingId } = await ssoOnlyPending(t);
    const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const { code, state } = t.idp("a").authorize(start.json().url);
    const stateCookie = start.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
    await t.db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, t.provider("a").id));
    const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${code}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: stateCookie } });
    expect(cb.headers.location).toBe("/login?error=oidc_unavailable");
    await t.db.update(authProviders).set({ enabled: true }).where(eq(authProviders.id, t.provider("a").id));
    const start2 = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
    t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
    const auth2 = t.idp("a").authorize(start2.json().url);
    await t.db.delete(userIdentities).where(eq(userIdentities.userId, user.id));
    const cb2 = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${auth2.code}&state=${auth2.state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: start2.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value } });
    expect(cb2.headers.location).toBe("/link-account?error=oidc_link_proof_mismatch");
  });

  it("C20：往返途中目標帳號被停用 → /link-account?error=account_disabled；email 被改 → oidc_link_expired（清 pending）", async () => {
    for (const [mutate, code] of [[{ disabledAt: new Date() }, "account_disabled"], [{ email: "changed@x.example" }, "oidc_link_expired"]] as const) {
      const t = await app2();
      const { user, pending, pendingId } = await ssoOnlyPending(t);
      const start = await t.app.inject({ method: "POST", url: `/api/auth/oidc/pending/prove/${t.provider("a").id}`, cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { pendingId } });
      t.idp("a").setNextLogin({ sub: "ua", email: "u@x.example" });
      const { code: c, state } = t.idp("a").authorize(start.json().url);
      await t.db.update(users).set(mutate).where(eq(users.id, user.id));
      const cb = await t.app.inject({ method: "GET", url: `/api/auth/oidc/callback/${t.provider("a").id}?code=${c}&state=${state}`, cookies: { [OIDC_PENDING_COOKIE]: pending, [OIDC_STATE_COOKIE]: start.cookies.find(x => x.name === OIDC_STATE_COOKIE)!.value } });
      expect(cb.headers.location).toBe(`/link-account?error=${code}`);
      expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }]);
    }
  });

  it("C21：密碼證明與 SSO 證明同時完成（同一顆 pending）→ 後到者在 users 鎖後看到身分已屬本人、冪等成功；兩顆 session 都有效", async () => {
    const gate = { release: () => {}, entered: () => {} };
    const held = new Promise<void>(r => (gate.release = r));
    const entered = new Promise<void>(r => (gate.entered = r));
    let first = true;
    const hook: OidcTestHook = async point => {
      if (point === "link-locked" && first) {
        first = false;
        gate.entered();
        await held;
      }
    };
    const t = await app2({ oidcTestHook: hook });
    const u = await insertPasswordUser(t.db, { email: "u@x.example", password: "correct-horse-battery-staple" });
    await t.db.insert(userIdentities).values({ userId: u.id, issuer: A, sub: "ua" });
    const r = await ssoRoundTrip(t.app, t.idp("b"), { loginUrl: `/api/auth/oidc/login/${t.provider("b").id}`, claims: { sub: "ub", email: "u@x.example" } });
    const pending = r.cookies[OIDC_PENDING_COOKIE]!;
    const pendingId = unsealPendingLink(testConfig.appSecret, pending, nowS())!.pendingId;
    const confirmP = t.app.inject({ method: "POST", url: "/api/auth/oidc/pending/confirm", cookies: { [OIDC_PENDING_COOKIE]: pending }, payload: { password: "correct-horse-battery-staple", pendingId } });
    await entered;
    const proveP = prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "u@x.example" });
    try {
      expect(await waitForBlockedOrSettled(t.db.$client, proveP)).toBe("blocked");
    } finally {
      gate.release();
    }
    const [c, p] = await Promise.all([confirmP, proveP]);
    expect(c.statusCode).toBe(200);
    expect(p.callback!.headers.location).toBe("/");
    expect(await identitiesOf(t.db, u.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
    for (const cookie of [c.cookies, p.callback!.cookies].map(cs => cs.find(x => x.name === SESSION_COOKIE)!.value)) {
      expect((await t.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } })).json().id).toBe(u.id);
    }
  });

  it("C24：SSO 證明持有 users 列鎖時，同一帳號的 SSO 登入（只碰 user_identities）不被擋、兩者都成功、無 40P01", async () => {
    const gate = { release: () => {}, entered: () => {} };
    const held = new Promise<void>(r => (gate.release = r));
    const entered = new Promise<void>(r => (gate.entered = r));
    let first = true;
    const hook: OidcTestHook = async point => {
      if (point === "link-locked" && first) {
        first = false;
        gate.entered();
        await held;
      }
    };
    const t = await app2({ oidcTestHook: hook });
    const { user, pending, pendingId } = await ssoOnlyPending(t);
    const proveP = prove(t, "a", { [OIDC_PENDING_COOKIE]: pending }, pendingId, { sub: "ua", email: "u@x.example" });
    await entered;
    const loginP = ssoRoundTrip(t.app, t.idp("a"), { loginUrl: `/api/auth/oidc/login/${t.provider("a").id}`, claims: { sub: "ua", email: "u@x.example" } });
    try {
      // 這一案要證明的就是「不被擋」：login 分支不寫 users（B15），與 A2 的 users 鎖不相交。
      expect(await waitForBlockedOrSettled(t.db.$client, loginP)).toBe("settled");
    } finally {
      gate.release();
    }
    const [p, l] = await Promise.all([proveP, loginP]);
    expect(l.callbackRes.headers.location).toBe("/");
    expect(p.callback!.headers.location).toBe("/");
    expect(await identitiesOf(t.db, user.id)).toEqual([{ issuer: A, sub: "ua" }, { issuer: B, sub: "ub" }]);
  });
});
