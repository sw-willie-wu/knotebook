/**
 * #132 Task 6：同意頁的兩支站內端點（§5.3.1／§5.3.2）。
 *
 * 這一族守的是：①`GET /api/oauth/request` **不消費**（頁面可重新整理）、不吃桶；
 * ②I6 單次消費——allow 與 deny 都消費，連點兩下只建一個 code；③I1 額度要扣掉會被 I7
 * 取代的那一列（否則「20 支且其中一支是本 client」重新授權會吃 409）；④兩支都是
 * cookie 專用、站內錯誤形；⑤不變量 S：`req` 進 SQL 述詞前先過正規式。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../src/db/schema.js";
import { buildTestApp, createUserAndLogin, testConfig, type TestApp } from "./helpers.js";

const CHALLENGE = "a".repeat(43);
const ISSUER = testConfig.publicUrl.origin;
const RESOURCE = `${ISSUER}/api/mcp`;

/** 註冊 client 並走完 authorize，回 pending request 的 id 與 client_id。 */
async function startFlow(
  app: TestApp["app"],
  options: { redirectUri?: string; scope?: string; clientId?: string } = {}
): Promise<{ clientId: string; req: string }> {
  let clientId = options.clientId;
  if (clientId === undefined) {
    const registered = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { client_name: "Test client", redirect_uris: ["http://127.0.0.1:1234/cb"] },
    });
    clientId = registered.json().client_id as string;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? "http://127.0.0.1:5678/cb",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st",
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  const res = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
  expect(res.statusCode, "authorize 應 302").toBe(302);
  const req = new URL(res.headers.location as string, "http://x").searchParams.get("req")!;
  return { clientId, req };
}

function decide(app: TestApp["app"], cookie: string, body: object) {
  return app.inject({ method: "POST", url: "/api/oauth/decision", headers: { cookie }, payload: body });
}

describe("GET /api/oauth/request（§5.3.1）", () => {
  it("200 回四要素；不消費（可重新整理）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app, { scope: "notes:write" });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          clientName: "Test client",
          redirectHost: "127.0.0.1:5678", // 刻意含 port
          scope: "notes:read notes:write",
          scopes: ["notes:read", "notes:write"],
          replacesExisting: false,
        });
      }
      expect(await db.select().from(oauthRequests)).toHaveLength(1); // 沒被消費
    } finally {
      await close();
    }
  });

  it("未登入 → 401（cookie 專用）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const { req } = await startFlow(app);
      const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}` });
      expect(res.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("查無、已過期、缺 req、req 形狀不對 → 410 oauth_request_invalid（同形，不當 oracle）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      // 不變量 S：`req` 進 SQL 述詞前先過正規式。**NUL 那兩發是承重案**——拿掉
      // `REQUEST_ID_RE`，其他值只是查不到列而已，只有 NUL 會讓 PG 22021 冒成 500。
      for (const bad of ["nope", "", "\u0000", `a\u0000${"b".repeat(20)}`, "x".repeat(65), "A".repeat(22).replace("A", "!")]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/oauth/request?req=${encodeURIComponent(bad)}`,
          headers: { cookie },
        });
        expect(res.statusCode, JSON.stringify(bad)).toBe(410);
        expect(res.headers["content-type"], JSON.stringify(bad)).toContain("application/json");
        expect(res.json().error.code, JSON.stringify(bad)).toBe("oauth_request_invalid");
      }
      const missing = await app.inject({ method: "GET", url: "/api/oauth/request", headers: { cookie } });
      expect(missing.statusCode).toBe(410);

      const { req } = await startFlow(app);
      await db.update(oauthRequests).set({ expiresAt: sql`now() - interval '1 minute'` });
      const expired = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(expired.statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  it("stored redirect_uri 已與註冊不符（client 改註冊）→ 404", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db
        .update(oauthClients)
        .set({ redirectUris: ["http://127.0.0.1:1234/elsewhere"] })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await close();
    }
  });

  it("replacesExisting：呼叫者本人已有同 client 的 grant 時為 true；別人的不算", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const other = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      // 別人的 grant：request 列沒有 user_id，這一格不可能洩漏他人狀態
      await db.insert(apiTokens).values({
        userId: other.userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "other-h",
        refreshTokenHash: "other-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });
      const before = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(before.json().replacesExisting).toBe(false);

      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "mine-h",
        refreshTokenHash: "mine-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });
      const after = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(after.json().replacesExisting).toBe(true);
    } finally {
      await close();
    }
  });

  it("連打 40 次不 429（GET 不吃桶）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      for (let i = 0; i < 40; i += 1) {
        const res = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await close();
    }
  });
});

describe("POST /api/oauth/decision（§5.3.2）", () => {
  it("allow → 200 redirectTo 帶 code／state／iss，並建一列 oauth_codes", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app, { scope: "notes:write" });
      // register 幾秒前才把 last_used_at 設成 now()——先推回 10 天前，下面那條
      // 「建 code 後更新 last_used_at」的 UPDATE 被拿掉時才分得出來。
      const staleStamp = new Date(Date.now() - 10 * 86_400_000); // 須 < I5 ① 的 30 天，否則 client 會被清掉
      await db.update(oauthClients).set({ lastUsedAt: staleStamp }).where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().redirectTo as string);
      expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:5678/cb");
      const code = url.searchParams.get("code")!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("state")).toBe("st");
      expect(url.searchParams.get("iss")).toBe(ISSUER);

      const rows = await db.select().from(oauthCodes);
      expect(rows).toHaveLength(1);
      // I2：明文不落庫（DB 只有 sha256）；其餘欄位從 pending request 抄過來
      expect(rows[0]!.codeHash).not.toBe(code);
      expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.userId).toBe(userId);
      expect(rows[0]!.clientId).toBe(clientId);
      expect(rows[0]!.scope).toBe("notes:read notes:write");
      expect(rows[0]!.redirectUri).toBe("http://127.0.0.1:5678/cb");
      expect(rows[0]!.codeChallenge).toBe(CHALLENGE);
      const ttl = rows[0]!.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000);

      // 建 code 時連帶更新 client 的 last_used_at（I5 ① 的依據）
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(staleStamp.getTime());
      expect(Date.now() - client!.lastUsedAt.getTime()).toBeLessThan(5_000);
    } finally {
      await close();
    }
  });

  it("state 缺席時 redirectTo 不帶 state；單值 scope 的 DTO 形狀", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const registered = await app.inject({
        method: "POST",
        url: "/oauth/register",
        payload: { redirect_uris: ["http://127.0.0.1:1234/cb"] },
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: registered.json().client_id as string,
        redirect_uri: "http://127.0.0.1:1234/cb",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        resource: RESOURCE,
      });
      const auth = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
      const req = new URL(auth.headers.location as string, "http://x").searchParams.get("req")!;

      const dto = await app.inject({ method: "GET", url: `/api/oauth/request?req=${req}`, headers: { cookie } });
      expect(dto.json()).toMatchObject({ clientName: "MCP client", scope: "notes:read", scopes: ["notes:read"] });

      const res = await decide(app, cookie, { req, decision: "allow" });
      const url = new URL(res.json().redirectTo as string);
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.has("code")).toBe(true);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
    } finally {
      await close();
    }
  });

  it("deny → 200 redirectTo 帶 access_denied，且同樣消費 pending request", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      const denied = await decide(app, cookie, { req, decision: "deny" });
      expect(denied.statusCode).toBe(200);
      const url = new URL(denied.json().redirectTo as string);
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("state")).toBe("st");
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);

      const again = await decide(app, cookie, { req, decision: "allow" });
      expect(again.statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  it("I6：同一個 req 兩次 allow → 第二次 410，且只建一個 code", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { req } = await startFlow(app);
      expect((await decide(app, cookie, { req, decision: "allow" })).statusCode).toBe(200);
      const second = await decide(app, cookie, { req, decision: "allow" });
      expect(second.statusCode).toBe(410);
      expect(second.json().error.code).toBe("oauth_request_invalid");
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("body 形狀錯 → 400 invalid_body；req 形狀不對 → 410（不變量 S）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      for (const body of [{ req: "x", decision: "maybe" }, { decision: "allow" }, {}]) {
        const res = await decide(app, cookie, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error.code).toBe("invalid_body");
      }
      // 同上：NUL 那兩發是唯一分得出「有守衛」與「沒守衛但查不到」的案
      for (const req of ["\u0000", `a\u0000${"b".repeat(20)}`, "nope", "x".repeat(65)]) {
        const res = await decide(app, cookie, { req, decision: "allow" });
        expect(res.statusCode, JSON.stringify(req)).toBe(410);
        expect(res.headers["content-type"], JSON.stringify(req)).toContain("application/json");
        expect(res.json().error.code).toBe("oauth_request_invalid");
      }
    } finally {
      await close();
    }
  });

  it("未登入 → 401；mustChangePassword → 403 且不消費", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { req } = await startFlow(app);
      const anon = await app.inject({ method: "POST", url: "/api/oauth/decision", payload: { req, decision: "allow" } });
      expect(anon.statusCode).toBe(401);

      const locked = await createUserAndLogin(db, { mustChangePassword: true });
      const res = await decide(app, locked.cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
      expect(await db.select().from(oauthRequests)).toHaveLength(1); // 沒被白吃掉
    } finally {
      await close();
    }
  });

  it("I1：20 支計入額度的 grant 時 409；其中一支屬本 client 時放行", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db.insert(apiTokens).values(
        Array.from({ length: 19 }, (_, i) => ({
          userId,
          kind: "pat" as const,
          name: `pat${i}`,
          scope: "notes:read" as const,
          accessTokenHash: `pat-${i}`,
          accessExpiresAt: null,
        }))
      );
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Test client",
        scope: "notes:read",
        accessTokenHash: "same-client",
        refreshTokenHash: "same-client-r",
        clientId,
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      const ok = await decide(app, cookie, { req, decision: "allow" });
      expect(ok.statusCode).toBe(200); // 扣掉會被 I7 取代的那一列

      // 換一個新 client：同樣 20 支，這次沒得扣 → 409
      const other = await startFlow(app);
      const limited = await decide(app, cookie, { req: other.req, decision: "allow" });
      expect(limited.statusCode).toBe(409);
      expect(limited.json().error.code).toBe("token_limit");
      // 409 那一發仍然消費了 pending request（I6 在額度檢查之前）
      expect((await decide(app, cookie, { req: other.req, decision: "allow" })).statusCode).toBe(410);
    } finally {
      await close();
    }
  });

  // I1 額度的「有效」定義守衛（§9.2）：oauth grant 一律計入，**access 過期也算**
  // （refresh 不到期）。把述詞寫成「未過期才計」的話這一案會變 200。
  it("20 支 oauth grant 全部 access 過期，對新 client 授權仍 409", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      for (let i = 0; i < 20; i += 1) {
        await db.insert(oauthClients).values({
          clientId: `c${i}`,
          clientName: `c${i}`,
          redirectUris: ["http://127.0.0.1/cb"],
        });
        await db.insert(apiTokens).values({
          userId,
          kind: "oauth",
          name: `c${i}`,
          scope: "notes:read",
          accessTokenHash: `h${i}`,
          refreshTokenHash: `r${i}`,
          clientId: `c${i}`,
          accessExpiresAt: sql`now() - interval '1 hour'`,
        });
      }
      const { req } = await startFlow(app); // 全新的第 21 個 client
      const res = await decide(app, cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("token_limit");
    } finally {
      await close();
    }
  });

  it("消費後 client 已被改註冊（stored redirect_uri 不符）→ 404", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      await db
        .update(oauthClients)
        .set({ redirectUris: ["http://127.0.0.1:1234/elsewhere"] })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(404);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("decision 的 I5 排在消費之前：pending request 跨過 24h 邊界的殭屍 client → 410 不是 500", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const { clientId, req } = await startFlow(app);
      // 把 client 推回 25 小時前：它沒有 grant／code，I5 ② 會清掉它（CASCADE 帶走 request）
      await db
        .update(oauthClients)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      const res = await decide(app, cookie, { req, decision: "allow" });
      expect(res.statusCode).toBe(410);
    } finally {
      await close();
    }
  });
});
