/**
 * #130 Task 10：PAT 管理端點（`routes/api-tokens.ts`）。
 *
 * 這一族守的是：①明文只出現一次、DB 只存 sha256（I2）；②I1 額度述詞的形狀（過期 PAT
 * 不計、oauth 計）；③I5 ⑤ 的機會性清理；④撤銷＝硬刪且跨使用者同形 404（D9）；
 * ⑤三條端點是 cookie 專用——token 不能簽發或撤銷 token。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { FastifyInstance } from "fastify";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { apiTokens, oauthClients } from "../src/db/schema.js";
import { signSession } from "../src/auth/session.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, freshLimiters, insertPasswordUser, testConfig } from "./helpers.js";

/**
 * PAT 管理端點是 **cookie 專用**，所以每個案子都需要一個已登入的會話。
 * cookie 用 repo 慣例直接簽（見 test/admin-ai.test.ts 的 cookieFor），不跑登入流程——
 * `mustChangePassword: true` 那一案跑真登入會卡在首登強改密流程。帳號用
 * `insertPasswordUser` 建（有真密碼，D3 那一案要用它改密碼）。
 */
async function signedInApp(
  over: { overrides?: Partial<AppDeps>; mustChangePassword?: boolean; password?: string } = {}
): Promise<{ app: FastifyInstance; db: Db; cookie: string; userId: string; password: string }> {
  const { app, db } = await buildTestApp(over.overrides ?? {});
  const user = await insertPasswordUser(db, {
    mustChangePassword: over.mustChangePassword ?? false,
    password: over.password,
  });
  const cookie = await signSession(testConfig.appSecret, { userId: user.id, tv: 0 });
  return { app, db, cookie, userId: user.id, password: user.password };
}

/** 同一座 app 內再建第二個使用者與其 cookie（跨使用者隔離的案子用）。 */
async function anotherUser(db: Db): Promise<{ userId: string; cookie: string }> {
  const user = await insertPasswordUser(db);
  return { userId: user.id, cookie: await signSession(testConfig.appSecret, { userId: user.id, tv: 0 }) };
}

type CreateBody = { name: string; scope: "notes:read" | "notes:write"; expiresInDays: 30 | 90 | 365 | null };

function create(app: FastifyInstance, cookie: string, payload: CreateBody) {
  return app.inject({ method: "POST", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie }, payload });
}

const READ_FOREVER: CreateBody = { name: "n", scope: "notes:read", expiresInDays: null };

describe("PAT 管理端點", () => {
  it("建立 → 明文只出現一次、DB 只存 sha256", async () => {
    const { app, db, cookie } = await signedInApp();
    const res = await create(app, cookie, { name: "  Claude Desktop  ", scope: "notes:write", expiresInDays: null });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Claude Desktop"); // 前後空白落庫前 trim
    expect(body.token).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
    expect(body.scope).toBe("notes:read notes:write"); // 落庫形是集合
    expect(body.expiresAt).toBeNull();

    const rows = await db.select().from(apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).not.toContain(body.token);
    expect(rows[0].accessTokenHash).toMatch(/^[0-9a-f]{64}$/);

    // 列表回應永遠不含明文
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    expect(JSON.stringify(list.json())).not.toContain(body.token);
    expect(list.json().tokens[0]).toMatchObject({ kind: "pat", name: "Claude Desktop", scope: "notes:read notes:write" });
  });

  it("建立出來的 token 真的能過 Bearer 認證（hash 與 bearer.ts 同一套）", async () => {
    const { app, cookie } = await signedInApp();
    const { token } = (await create(app, cookie, READ_FOREVER)).json();
    const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("expiresInDays 只收 30/90/365/null；其他值 400；空名 400", async () => {
    const { app, cookie } = await signedInApp();
    for (const expiresInDays of [30, 90, 365, null] as const) {
      const res = await create(app, cookie, { name: "n", scope: "notes:read", expiresInDays });
      expect(res.statusCode, String(expiresInDays)).toBe(201);
      if (expiresInDays !== null) {
        // expiresAt 要落在「現在＋N 天」附近（±1 分鐘）
        const delta = new Date(res.json().expiresAt).getTime() - Date.now();
        expect(Math.abs(delta - expiresInDays * 86_400_000)).toBeLessThan(60_000);
      }
    }
    // 負向案刻意餵型別外的值，單點 cast
    const badDays = { name: "n", scope: "notes:read", expiresInDays: 7 } as unknown as CreateBody;
    expect((await create(app, cookie, badDays)).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "", scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "   ", scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "x".repeat(65), scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
  });

  it("I1：第 21 支 409 token_limit", async () => {
    const { app, cookie } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 20; i += 1) {
      expect((await create(app, cookie, { name: `t${i}`, scope: "notes:read", expiresInDays: null })).statusCode, `#${i}`).toBe(201);
    }
    const over = await create(app, cookie, { name: "t20", scope: "notes:read", expiresInDays: null });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe("token_limit");
  });

  it("I1：已過期的 PAT 不計入額度", async () => {
    const { app, db, cookie, userId } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    // 直接插 20 支「已過期 1 天」的 PAT——它們不該擋住第 21 支
    for (let i = 0; i < 20; i += 1) {
      await db.insert(apiTokens).values({
        userId,
        kind: "pat",
        name: `old${i}`,
        scope: "notes:read",
        // ⚠ 用 padStart 不是 padEnd：`h1`.padEnd(64,"0") 與 `h10`.padEnd(64,"0")
        // 是同一個字串，第 11 圈就會撞 access_token_hash 的唯一索引，測試在 arrange
        // 階段就炸（而且錯誤看起來與 I1 無關）。
        accessTokenHash: `${i}`.padStart(64, "0"),
        accessExpiresAt: new Date(Date.now() - 86_400_000),
      });
    }
    expect((await create(app, cookie, { name: "fresh", scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
  });

  it("I1：oauth grant 即使 access 已過期也計入額度（refresh 不到期）", async () => {
    const { app, db, cookie, userId } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    // 同一使用者對同一 client 只能有一個 oauth grant（per-owner partial unique），
    // 所以 20 個 grant 要對應 20 個不同 client。
    for (let i = 0; i < 20; i += 1) {
      await db.insert(oauthClients).values({ clientId: `c-quota-${i}`, clientName: "C", redirectUris: ["http://127.0.0.1:1/cb"] });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: `g${i}`,
        scope: "notes:read",
        accessTokenHash: `a${i}`.padStart(64, "0"),
        refreshTokenHash: `r${i}`.padStart(64, "0"),
        clientId: `c-quota-${i}`,
        accessExpiresAt: new Date(Date.now() - 86_400_000),
      });
    }
    const over = await create(app, cookie, { name: "fresh", scope: "notes:read", expiresInDays: null });
    expect(over.statusCode).toBe(409);

    // 列表是「本人全部 grant」：oauth 列要出現、clientId 有值、access 已過期也仍列出
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    const rows = list.json().tokens as Array<{ kind: string; clientId: string | null; expiresAt: string | null; name: string }>;
    expect(rows).toHaveLength(20);
    const g0 = rows.find(r => r.name === "g0");
    expect(g0).toMatchObject({ kind: "oauth", clientId: "c-quota-0" });
    expect(new Date(g0!.expiresAt!).getTime()).toBeLessThan(Date.now());
  });

  it("I5 ⑤：建立時順手清掉過期超過 30 天的 PAT，未滿 30 天的留著；oauth grant 不清", async () => {
    const { app, db, cookie, userId } = await signedInApp();
    // oauth grant 的 access 過期不代表授權失效（refresh 不到期）——#132 落地後這是
    // 唯一擋住「連 oauth 一起清」的防線，spec I5 ⑤ 逐字寫了 kind='pat'。
    await db.insert(oauthClients).values({ clientId: "c-old", clientName: "C", redirectUris: ["http://127.0.0.1:1/cb"] });
    await db.insert(apiTokens).values({
      userId,
      kind: "oauth",
      name: "oauth-old",
      scope: "notes:read",
      accessTokenHash: "c".repeat(64),
      refreshTokenHash: "d".repeat(64),
      clientId: "c-old",
      accessExpiresAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "pat",
      name: "ancient",
      scope: "notes:read",
      accessTokenHash: "a".repeat(64),
      accessExpiresAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "pat",
      name: "recent",
      scope: "notes:read",
      accessTokenHash: "b".repeat(64),
      accessExpiresAt: new Date(Date.now() - 29 * 86_400_000),
    });
    // #132：建 PAT 現在跑的是完整五條（`oauth/cleanup.ts`），不只 ⑤。這一列 31 天沒用
    // 的 client 是 ① 的觸發——少了它，把呼叫換回「只有 ⑤」的版本仍會全綠。
    await db.insert(oauthClients).values({
      clientId: "c-stale",
      clientName: "Stale",
      redirectUris: ["http://127.0.0.1:1/cb"],
      lastUsedAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "oauth",
      name: "stale-grant",
      scope: "notes:read",
      accessTokenHash: "e".repeat(64),
      refreshTokenHash: "f".repeat(64),
      clientId: "c-stale",
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await create(app, cookie, { name: "new", scope: "notes:read", expiresInDays: null });
    const names = (await db.select().from(apiTokens)).map(r => r.name).sort();
    expect(names).toEqual(["new", "oauth-old", "recent"]);
    // ① 把 30 天沒用的 client 連同其 grant 一起帶走（CASCADE）
    expect((await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id)).toEqual(["c-old"]);
  });

  it("限流：PAT_CREATE 超限 → 429", async () => {
    const { app, cookie } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 2, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 2; i += 1) {
      expect((await create(app, cookie, { name: `t${i}`, scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
    }
    expect((await create(app, cookie, { name: "t2", scope: "notes:read", expiresInDays: null })).statusCode).toBe(429);
  });

  it("mustChangePassword 的使用者 → 403，且不吃限流額度", async () => {
    const { app, cookie } = await signedInApp({
      mustChangePassword: true,
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await create(app, cookie, READ_FOREVER);
      expect(res.statusCode, `#${i}`).toBe(403); // 第 2 發若變 429 就是順序錯了
    }
  });

  it("撤銷：只刪那一支（另一支要在）、204 且立即失效；不存在的／非 uuid → 404 token_not_found", async () => {
    const { app, db, cookie } = await signedInApp();
    const { id, token } = (await create(app, cookie, READ_FOREVER)).json();
    // 第二支：WHERE 少了 id 半邊（只剩 user_id）會把使用者全部 token 刪光——只建一支
    // 的話「刪光」與「刪對」不可分辨。
    const other = (await create(app, cookie, { name: "other", scope: "notes:read", expiresInDays: null })).json();

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // pg 的 uuid 比較不分大小寫，大寫路徑也要能撤（admin-users 同族註解）
    expect(
      (await app.inject({ method: "DELETE", url: `/api/auth/tokens/${String(id).toUpperCase()}`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode
    ).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, id))).toHaveLength(0);
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, other.id))).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(200);

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/auth/tokens/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("token_not_found");
    // 非 uuid 的 :id 也是 404（不能讓 pg 的 22P02 冒成 500）
    const notUuid = await app.inject({ method: "DELETE", url: "/api/auth/tokens/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(notUuid.statusCode).toBe(404);
    expect(notUuid.json().error.code).toBe("token_not_found");
  });

  it("跨使用者隔離：B 看不到也刪不掉 A 的 token，A 建滿 20 支也不占 B 的額度", async () => {
    const { app, db, cookie: cookieA } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    const b = await anotherUser(db);

    const created = await create(app, cookieA, { name: "A only", scope: "notes:read", expiresInDays: null });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // B 的列表不含 A 的 token
    const listB = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: b.cookie } });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().tokens).toEqual([]);

    // B 撤銷 A 的 token → 404，且列還在（把 WHERE 的 user_id 條件刪掉這案就會紅）
    const revokeByB = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${id}`, cookies: { [SESSION_COOKIE]: b.cookie } });
    expect(revokeByB.statusCode).toBe(404);
    expect(revokeByB.json().error.code).toBe("token_not_found");
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, id))).toHaveLength(1);

    // B 自己的額度不受 A 的 token 影響（I1 查詢也帶 user_id）——A 先建滿 20 支，
    // I1 少了 user_id 條件的話 B 的第一支就會 409。
    for (let i = 1; i < 20; i += 1) {
      expect((await create(app, cookieA, { name: `A${i}`, scope: "notes:read", expiresInDays: null })).statusCode, `A#${i}`).toBe(201);
    }
    expect((await create(app, cookieA, { name: "A20", scope: "notes:read", expiresInDays: null })).statusCode).toBe(409);
    expect((await create(app, b.cookie, { name: "B only", scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
  });

  it("列表依建立時間新到舊", async () => {
    const { app, cookie } = await signedInApp();
    await create(app, cookie, { name: "first", scope: "notes:read", expiresInDays: null });
    await new Promise(resolve => setTimeout(resolve, 5));
    await create(app, cookie, { name: "second", scope: "notes:read", expiresInDays: null });
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    expect(list.json().tokens.map((t: { name: string }) => t.name)).toEqual(["second", "first"]);
  });

  it("D3：改密碼之後既有 token 仍然有效", async () => {
    const { app, cookie, password } = await signedInApp({ password: "correct-horse-battery" });
    const { token } = (await create(app, cookie, READ_FOREVER)).json();
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: password, newPassword: "another-long-password-1" },
    });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it("PAT 管理端點是 cookie 專用：Bearer 打三條都 401 且不帶 challenge", async () => {
    const { app, cookie } = await signedInApp();
    const created = (await create(app, cookie, READ_FOREVER)).json();
    const auth = { authorization: `Bearer ${created.token}` };
    const cases = [
      ["GET", "/api/auth/tokens"],
      ["POST", "/api/auth/tokens"],
      ["DELETE", `/api/auth/tokens/${created.id}`],
    ] as const;
    for (const [method, url] of cases) {
      const res = await app.inject({
        method,
        url,
        headers: auth,
        ...(method === "POST" ? { payload: READ_FOREVER } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.headers["www-authenticate"], `${method} ${url}`).toBeUndefined();
    }
  });
});
