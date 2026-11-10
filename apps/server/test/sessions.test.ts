/**
 * #388：網頁登入改伺服器端 session（`sessions` 表、JWT 的 `sid`）。登出只作廢這台裝置；改密碼保留本機、踢其他台；
 * 停用全部作廢；沒有 `sid` 的舊 JWT 一律 401；過期列擋得住也清得掉；共編連線在登出後不能續寫。
 *
 * ⚠ `freshDb()` 的測試 trigger 會替每個使用者建一列「測試預設 session」（`testSessionId`，見 helpers.ts）。這裡
 * 數列數時一律只數**這次登入建的列**（`sidOf(cookie)`）或明講那一列也在。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { eq, sql } from "drizzle-orm";
import { COLLAB_CLOSE_REVOKED, SESSION_COOKIE, type Role } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { COLLAB_REJECT_INVALID_TOKEN } from "../src/collab/server.js";
import { insertSession } from "../src/auth/sessions.js";
import { signSession } from "../src/auth/session.js";
import { sessions, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { spyCollabHooks } from "./group-helpers.js";
import { hashPassword } from "../src/auth/password.js";
import {
  buildCollabTestApp,
  buildTestApp,
  COLLAB_TOKEN_INIT,
  insertPasswordUser,
  signTestSession,
  TEST_SESSION_TTL,
  testConfig,
  testSessionId,
  type HttpSession,
} from "./helpers.js";

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-388";

async function login(app: App, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode, res.body).toBe(200);
  return res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
}

async function me(app: App, cookie: string): Promise<number> {
  return (await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } })).statusCode;
}

async function logout(app: App, cookie?: string): Promise<{ status: number; cleared: boolean }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/logout", ...(cookie !== undefined ? { cookies: { [SESSION_COOKIE]: cookie } } : {}) });
  const c = res.cookies.find(one => one.name === SESSION_COOKIE);
  return { status: res.statusCode, cleared: c?.value === "" && c.maxAge === 0 };
}

const sidOf = (jwt: string): string => decodeJwt(jwt).sid as string;

async function sessionIdsOf(db: Db, userId: string): Promise<string[]> {
  return (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).map(r => r.id).sort();
}

/** 跟 `auth/session.ts` 的 `sessionKey` 同一個衍生——用來簽「升級前」形狀（沒有 sid）的 JWT。 */
function sessionKey(): Uint8Array {
  return createHash("sha256").update(`${testConfig.appSecret}:session`).digest();
}

describe("#388 登出只作廢這台裝置", () => {
  it("同帳號兩台登入：A 登出 → A 的舊 cookie 401、列被刪；B 照常 200、列還在", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    expect(sidOf(a)).not.toBe(sidOf(b));
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a), sidOf(b), testSessionId(u.id)].sort());

    // 先各打一次，讓 gate 的 session 快取熱起來——登出必須立刻生效，不能等 60 秒 TTL。
    expect(await me(app, a)).toBe(200);
    expect(await me(app, b)).toBe(200);

    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await me(app, a)).toBe(401); // 被複製走的 cookie 也一樣進不來
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b), testSessionId(u.id)].sort());
  });

  it("冪等：沒帶 cookie、亂字串、已登出過的 cookie 都回 204 並清 cookie；不動任何列", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    expect(await logout(app)).toEqual({ status: 204, cleared: true });
    expect(await logout(app, "not-a-jwt")).toEqual({ status: 204, cleared: true });
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b), testSessionId(u.id)].sort());
  });

  it("刪列撞到 DB 錯誤：照樣 204＋清 cookie（不卡在登入狀態）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    // 讓 DELETE 撞錯：表改名（verifySession 不碰 DB，所以只有刪列那一步會失敗）。
    await db.execute(sql`alter table sessions rename to sessions_hidden`);
    try {
      expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    } finally {
      await db.execute(sql`alter table sessions_hidden rename to sessions`);
    }
    // 已知代價（照實釘住）：列沒刪掉，這張 cookie 的副本在過期前仍可用；這台瀏覽器的 cookie 已清。
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a), testSessionId(u.id)].sort());
  });

  it("同一台瀏覽器沒登出就再登入一次：舊 cookie 那一列被刪（副本失效）；同帳號別台不受影響", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: a }, payload: { email: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a)).toBe(401);
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, b)).toBe(200);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a2), sidOf(b), testSessionId(u.id)].sort());
  });

  it("瀏覽器帶著別的帳號 V 的 cookie 登入：V 那一列不動（#187）", async () => {
    const { app, db } = await buildTestApp();
    const v = await insertPasswordUser(db);
    const u = await insertPasswordUser(db);
    const vCookie = await login(app, v.email);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: vCookie }, payload: { email: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(await me(app, vCookie)).toBe(200);
    expect(await sessionIdsOf(db, v.id)).toEqual([sidOf(vCookie), testSessionId(v.id)].sort());
  });

  it("列早已不在的 cookie：登出、再登入都不觸發重驗（只有真的刪到列才清快取、重驗、排延遲重驗）", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, reloginReverifyDelayMs: 50 });
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(1); // 真的刪到那一次
    expect(await logout(app, a)).toEqual({ status: 204, cleared: true });
    const relogin = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: a }, payload: { email: u.email, password: PASSWORD } });
    expect(relogin.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300)); // 過了延遲
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(1);
    // 對照：列還在的舊 cookie 重登，延遲後重驗一次。
    const b = relogin.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const again = await app.inject({ method: "POST", url: "/api/auth/login", cookies: { [SESSION_COOKIE]: b }, payload: { email: u.email, password: PASSWORD } });
    expect(again.statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(hooks.onSessionRevoked).toHaveBeenCalledTimes(2);
    expect(hooks.onSessionRevoked).toHaveBeenLastCalledWith(u.id, sidOf(b));
  });

  it("別的金鑰簽、但 sid 指著別人那一列的 JWT：登出不刪那一列", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const b = await login(app, u.email);
    const forged = await signSession("f".repeat(64), { userId: u.id, tv: 0, sid: sidOf(b) }, TEST_SESSION_TTL);
    expect(await logout(app, forged)).toEqual({ status: 204, cleared: true });
    expect(await me(app, b)).toBe(200);
  });
});

describe("#388 舊格式與失效的 JWT", () => {
  it("升級前的 JWT（簽章對、tv 對，但沒有 sid）→ 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const legacy = await new SignJWT({ tv: 0 }).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime("7d").sign(sessionKey());
    expect(await me(app, legacy)).toBe(401);
    // 對照：同一個使用者、同樣的簽法帶上一個存在的 sid 就過——401 確實是 sid 缺席造成的。
    const withSid = await new SignJWT({ tv: 0, sid: testSessionId(u.id) }).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime("7d").sign(sessionKey());
    expect(await me(app, withSid)).toBe(200);
  });

  it("sid 不是 uuid 形狀 → 401（不是 500）", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const bad = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: "not-a-uuid" }, TEST_SESSION_TTL);
    expect(await me(app, bad)).toBe(401);
  });

  it("sid 那一列屬於別的使用者 → 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const other = await insertPasswordUser(db);
    const cross = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: testSessionId(other.id) }, TEST_SESSION_TTL);
    expect(await me(app, cross)).toBe(401);
  });

  it("列過期（JWT 本身還沒過期）→ 401；下一次有人登入時過期列被清掉，沒過期的列不動", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const sid = await insertSession(db, u.id, TEST_SESSION_TTL);
    const cookie = await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid }, TEST_SESSION_TTL);
    // 對照：另一列沒過期的照常可用（下面的 401 是過期造成的，不是這種簽法本身不行）。
    const liveSid = await insertSession(db, u.id, TEST_SESSION_TTL);
    expect(await me(app, await signSession(testConfig.appSecret, { userId: u.id, tv: 0, sid: liveSid }, TEST_SESSION_TTL))).toBe(200);
    // expires_at 在正式碼裡不會變（不滑動），這裡直接改 DB 模擬「已過期」；先改再打，不經 gate 的快取。
    await db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(sessions.id, sid));
    expect(await me(app, cookie)).toBe(401);

    const keep = await login(app, u.email); // 觸發機會性清理（fire-and-forget）
    const deadline = Date.now() + 5_000;
    while ((await sessionIdsOf(db, u.id)).includes(sid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(await sessionIdsOf(db, u.id)).toEqual([liveSid, sidOf(keep), testSessionId(u.id)].sort());
  });
});

describe("#388 改密碼／加上密碼／停用", () => {
  it("改密碼：本機換一列新的 session 照常可用；其他裝置（含本機改密碼前那張 cookie）401、列全刪", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: a },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, a)).toBe(401);
    expect(await me(app, b)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(a2)]);
    // 舊 tv 被 bump 只是其中一道；就算把 tv 對上，被刪的列也進不來。
    const bSameTv = await signSession(testConfig.appSecret, { userId: u.id, tv: (decodeJwt(a2).tv as number), sid: sidOf(b) }, TEST_SESSION_TTL);
    expect(await me(app, bSameTv)).toBe(401);
  });

  it("兩台同時改密碼：bump 與換列同一個交易 → 先寫那台的 bump 在換列前不提交；後寫那台保持登入、先寫那台登出", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const change = (cookie: string, newPassword: string) =>
      app.inject({ method: "POST", url: "/api/auth/password", cookies: { [SESSION_COOKIE]: cookie }, payload: { currentPassword: PASSWORD, newPassword } });
    const pool = db.$client;
    const lockWaiters = async () =>
      Number((await pool.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0].n);
    const until = async (label: string, check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
        await new Promise(r => setTimeout(r, 20));
      }
    };
    // 先鎖住這個帳號的 session 列：A 換列時就卡在 DELETE，B 隨後進來。
    const holder = await pool.connect();
    let pa: ReturnType<typeof change> | undefined;
    let pb: ReturnType<typeof change> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from sessions where user_id = $1 for update", [u.id]);
      pa = change(a, "first-new-password-388");
      await until("A 卡在 session 列鎖上", async () => (await lockWaiters()) === 1);
      pb = change(b, "second-new-password-388");
      await until("B 也在等鎖", async () => (await lockWaiters()) === 2);
      // 同交易的證據：A 已經 bump 但還沒提交（握著 users 列鎖等 session 列），B 排在 users 列鎖上——提交的 tv 仍是 0。
      // 分成兩步的話這裡會是 2（兩發的 bump 都已各自提交，兩發都卡在換列）。
      expect((await pool.query("select token_version from users where id = $1", [u.id])).rows[0].token_version).toBe(0);
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    const [ra, rb] = await Promise.all([pa!, pb!]);
    expect(ra.statusCode).toBe(204);
    expect(rb.statusCode).toBe(204);
    const a2 = ra.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const b2 = rb.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, b2)).toBe(200); // 後寫那台保持登入
    expect(await me(app, a2)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(b2)]);
    expect((await pool.query("select token_version from users where id = $1", [u.id])).rows[0].token_version).toBe(2);
    await login(app, u.email, "second-new-password-388");
  });

  it("加上密碼（純 SSO 帳號）：本機換新的一列；其他裝置的列全刪", async () => {
    const { app, db } = await buildTestApp();
    const [u] = await db.insert(users).values({ email: "sso-388@example.com", displayName: "S", passwordHash: null }).returning();
    const sidA = await insertSession(db, u!.id, TEST_SESSION_TTL);
    const sidB = await insertSession(db, u!.id, TEST_SESSION_TTL);
    const a = await signSession(testConfig.appSecret, { userId: u!.id, tv: 0, sid: sidA }, TEST_SESSION_TTL);
    const b = await signSession(testConfig.appSecret, { userId: u!.id, tv: 0, sid: sidB }, TEST_SESSION_TTL);
    const res = await app.inject({ method: "POST", url: "/api/auth/password/set", cookies: { [SESSION_COOKIE]: a }, payload: { newPassword: NEW_PASSWORD } });
    expect(res.statusCode, res.body).toBe(204);
    const a2 = res.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, a2)).toBe(200);
    expect(await me(app, b)).toBe(401);
    expect(await sessionIdsOf(db, u!.id)).toEqual([sidOf(a2)]);
  });

  it("以重設連結設新密碼：這台裝置拿到新的一列；其他裝置的列全刪、cookie 401", async () => {
    const { app, db } = await buildTestApp();
    const [admin] = await db.insert(users).values({ email: "admin-388r@example.com", displayName: "A", isAdmin: true }).returning();
    const adminCookie = await signTestSession({ userId: admin!.id, tv: 0 });
    const u = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const issued = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/password-reset`, cookies: { [SESSION_COOKIE]: adminCookie }, payload: { expiresInHours: 1 } });
    expect(issued.statusCode, issued.body).toBe(201);
    const done = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token: issued.json().token, newPassword: NEW_PASSWORD } });
    expect(done.statusCode, done.body).toBe(200);
    const fresh = done.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    expect(await me(app, fresh)).toBe(200);
    expect(await me(app, a)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([sidOf(fresh)]);
  });

  it("停用帳號：該帳號全部 session 列刪光、cookie 全 401；重新啟用也不會復活；別人的列不動", async () => {
    const { app, db } = await buildTestApp();
    const [admin] = await db.insert(users).values({ email: "admin-388@example.com", displayName: "A", isAdmin: true, passwordHash: await hashPassword(PASSWORD) }).returning();
    const adminCookie = await signTestSession({ userId: admin!.id, tv: 0 });
    const u = await insertPasswordUser(db);
    const bystander = await insertPasswordUser(db);
    const a = await login(app, u.email);
    const b = await login(app, u.email);
    const c = await login(app, bystander.email);

    const dis = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/disable`, cookies: { [SESSION_COOKIE]: adminCookie } });
    expect(dis.statusCode).toBe(204);
    expect(await sessionIdsOf(db, u.id)).toEqual([]);
    expect(await me(app, a)).toBe(401);
    expect(await me(app, b)).toBe(401);

    const en = await app.inject({ method: "POST", url: `/api/admin/users/${u.id}/enable`, cookies: { [SESSION_COOKIE]: adminCookie } });
    expect(en.statusCode).toBe(204);
    expect(await me(app, a)).toBe(401);
    expect(await sessionIdsOf(db, u.id)).toEqual([]);
    expect(await me(app, c)).toBe(200);
    expect(await sessionIdsOf(db, bystander.id)).toEqual([sidOf(c), testSessionId(bystander.id)].sort());
  });
});

/** 走真的 `POST /api/notes/:id/collab-token` 取一份 token。 */
async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, COLLAB_TOKEN_INIT);
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）`);
  return ((await res.json()) as { token: string; role: Role }).token;
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("#388 共編連線", () => {
  const buildApp = () => buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });

  it("A 登出 → A 開著的共編連線 10 秒內被 close(revoked)；同帳號 B 的連線不受影響（不被要求重驗）", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const sessA = await ctx.loginAs("collab-388a@example.com", PASSWORD);
    const sessB = await ctx.loginAs("collab-388a@example.com", PASSWORD);
    const clientA = await sessA.connect(note.id);
    // B 取 token 的次數：A 登出後若 B 也被要求重驗（沒有只挑 A 那個 sid 的連線），這個數字會增加。
    let bTokenFetches = 0;
    const clientB = await sessB.connect(note.id, {
      tokenFn: async () => {
        bTokenFetches += 1;
        return fetchToken(sessB, note.id);
      },
    });
    expect(ctx.collab.connectionsOf(u.id).size).toBe(2);
    const bFetchesBefore = bTokenFetches;

    const started = Date.now();
    const out = await sessA.fetch("/api/auth/logout", { method: "POST" });
    expect(out.status).toBe(204);
    await waitFor("A 的連線被 close(knotebook:revoked)", 10_000, () => clientA.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED));
    expect(Date.now() - started).toBeLessThan(10_000);

    // B：等過一個重驗 deadline，仍沒被關、仍在索引裡。
    await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
    expect(clientB.closes).toEqual([]);
    expect(bTokenFetches).toBe(bFetchesBefore); // B 沒被要求重驗
    await waitFor("只剩 B 的連線", 5_000, () => ctx.collab.connectionsOf(u.id).size === 1);
    expect((await sessB.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT)).status).toBe(200);
  });

  describe("同一台瀏覽器重新登入（延遲重驗）", () => {
    // 測試用的延遲：夠長，讓「瀏覽器晚 300ms 才存好新 cookie」落在延遲之內；正式值是 RELOGIN_REVERIFY_DELAY_MS（10 秒）。
    const DELAY_MS = 1_500;
    const COOKIE_STORED_AFTER_MS = 300;
    const EMAIL = (tag: string) => `collab-388-${tag}@example.com`;
    const buildDelayed = () => buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log), reloginReverifyDelayMs: DELAY_MS });
    const cookieOf = (res: Response) => res.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
    const jwtOf = (cookieHeader: string) => cookieHeader.split("=").slice(1).join("=");

    async function scene(tag: string) {
      const ctx = await buildDelayed();
      const u = await ctx.createUser({ email: EMAIL(tag), password: PASSWORD });
      const note = await ctx.createNote(u.id);
      const loginWith = (cookie?: string) =>
        fetch(`${ctx.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ email: EMAIL(tag), password: PASSWORD }),
        });
      const tokenWith = async (cookie: string): Promise<string> => {
        const r = await fetch(`${ctx.baseUrl}/api/notes/${note.id}/collab-token`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: COLLAB_TOKEN_INIT.body });
        if (!r.ok) throw new Error(`collab token ${r.status}`);
        return ((await r.json()) as { token: string }).token;
      };
      const meWith = async (cookie: string) => (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie } })).status;
      const sess = await ctx.loginAs(EMAIL(tag), PASSWORD); // 只借 connect 管線（它自己那張 cookie 不用）
      return { ctx, u, note, loginWith, tokenWith, meWith, sess };
    }

    it("(a) 舊分頁：重登當下不被要求重驗；延遲後被要求一次、用瀏覽器的新 cookie 換到新 sid、連線留著", async () => {
      const { ctx, u, note, loginWith, tokenWith, meWith, sess } = await scene("a");
      const oldCookie = cookieOf(await loginWith());
      let current = oldCookie; // 這台瀏覽器目前的 cookie
      let fetches = 0;
      const client = await sess.connect(note.id, {
        tokenFn: async () => {
          fetches += 1;
          return tokenWith(current);
        },
      });
      const before = fetches;

      const relogin = await loginWith(oldCookie);
      expect(relogin.status).toBe(200);
      const newCookie = cookieOf(relogin);
      // 模擬瀏覽器晚一點才存好新 cookie：這段期間舊分頁若被要求重驗，會拿舊 cookie 撞 401、被踢（立即重驗的失效模式）。
      await new Promise(resolve => setTimeout(resolve, COOKIE_STORED_AFTER_MS));
      expect(fetches).toBe(before); // 重登當下沒被要求重驗
      current = newCookie;
      expect(await meWith(oldCookie)).toBe(401);
      expect(await meWith(newCookie)).toBe(200);

      await waitFor("延遲後被要求重驗一次", DELAY_MS + 3_000, () => fetches === before + 1);
      await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
      expect(fetches).toBe(before + 1);
      expect(client.closes).toEqual([]);
      const handles = [...ctx.collab.connectionsOf(u.id)];
      expect(handles).toHaveLength(1);
      expect(handles[0]!.sessionId).toBe(sidOf(jwtOf(newCookie))); // 換到新 sid（之後登出這台會找到它）
    });

    it("(b) 被複製走的舊 cookie 開著的連線：延遲＋重驗 deadline 內被 close(revoked)", async () => {
      const { note, loginWith, tokenWith, sess } = await scene("b");
      const oldCookie = cookieOf(await loginWith());
      let fetches = 0;
      const copied = await sess.connect(note.id, {
        tokenFn: () => {
          fetches += 1;
          return tokenWith(oldCookie); // 固定用舊 cookie
        },
      });
      const before = fetches;
      expect((await loginWith(oldCookie)).status).toBe(200); // 本人在原瀏覽器重登
      // 「是延遲那一發，不是立即」要看「什麼時候被要求取 token」，不能看關閉時間：立即重驗時舊 cookie 取 token 401，
      // 仍要等 5 秒 deadline 才關，關閉時間照樣 ≥ DELAY_MS。
      await new Promise(resolve => setTimeout(resolve, DELAY_MS / 2));
      expect(fetches).toBe(before);
      await waitFor("副本的連線被 close(knotebook:revoked)", DELAY_MS + REVERIFY_DEADLINE_MS + 3_000, () =>
        copied.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED),
      );
      expect(fetches).toBe(before + 1); // 延遲那一次
    });
  });

  it("登出前拿到、還沒過期的 collab token：登出後拿它握手被拒（session-revoked）", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388b@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const sess = await ctx.loginAs("collab-388b@example.com", PASSWORD);
    const token = await fetchToken(sess, note.id);
    expect((await sess.fetch("/api/auth/logout", { method: "POST" })).status).toBe(204);
    await expect(sess.connect(note.id, { tokenOverride: token })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    expect(ctx.collabLogs.some(l => l.obj.cause === "session-revoked")).toBe(true);
  });

  it("改密碼後同一台裝置的連線改用新的 sid 續留；接著登出這台（新的 sid）→ 連線被關", async () => {
    const ctx = await buildApp();
    const u = await ctx.createUser({ email: "collab-388c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    // 這台裝置的 cookie 自己管（改密碼會換 cookie，HttpSession 的 cookie 是固定的）；HttpSession 只借它的 connect 管線。
    const cookieOf = (res: Response) => res.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
    const post = (path: string, cookie: string, body?: unknown) =>
      fetch(`${ctx.baseUrl}${path}`, {
        method: "POST",
        headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const loginRes = await fetch(`${ctx.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "collab-388c@example.com", password: PASSWORD }) });
    let cookie = cookieOf(loginRes);
    let rotating = false;
    const tokenFn = async (): Promise<string> => {
      // 改密碼期間 server 會先要求重驗、才回新 cookie：等新 cookie 到手再取 token（模擬瀏覽器收下 Set-Cookie 之後的請求）。
      while (rotating) await new Promise(resolve => setTimeout(resolve, 10));
      const r = await post(`/api/notes/${note.id}/collab-token`, cookie, { noteSchemaVersion: JSON.parse(COLLAB_TOKEN_INIT.body).noteSchemaVersion });
      if (!r.ok) throw new Error(`collab token ${r.status}`);
      return ((await r.json()) as { token: string }).token;
    };
    const sess = await ctx.loginAs("collab-388c@example.com", PASSWORD);
    const client = await sess.connect(note.id, { tokenFn });

    rotating = true;
    const changed = await post("/api/auth/password", cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(204);
    cookie = cookieOf(changed);
    rotating = false;
    await new Promise(resolve => setTimeout(resolve, REVERIFY_DEADLINE_MS + 500));
    expect(client.closes).toEqual([]); // 重驗拿新 sid 的 token 通過

    expect((await post("/api/auth/logout", cookie)).status).toBe(204);
    await waitFor("新 sid 登出後連線被 close(knotebook:revoked)", 10_000, () => client.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED));
  });
});
