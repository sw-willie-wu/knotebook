/**
 * #130 Task 8：`authenticateAny`（Bearer／session 雙路徑認證）與 `/api/mcp` 的
 * #108 前暫時形。
 *
 * 這一族守的是三件會靜默壞掉的事：①401／403 的 `WWW-Authenticate` 形狀（MCP client
 * 靠它發現授權伺服器，少一個欄位整條 OAuth 流程起不了頭）；②哪些失敗計入
 * BEARER_MISS 桶、哪些刻意不計；③token 明文與 `Authorization` header 永不落 log。
 */
import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { apiTokens, oauthClients, users } from "../src/db/schema.js";
import { signSession } from "../src/auth/session.js";
import { generateAccessToken } from "../src/auth/api-token.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, freshLimiters, testConfig } from "./helpers.js";

/** testConfig 的 PUBLIC_URL 是 http://localhost:3000，issuer 取其 origin。 */
const ISSUER = "http://localhost:3000";

function hash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** 用產品的產生器（真的 base64url 字符集）；`hash()` 則刻意不 import，留作獨立 oracle。 */
function randomToken(): string {
  return generateAccessToken();
}

/** 等 fire-and-forget 的 UPDATE 落盤：有上限的輪詢，滿足即回。 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function seedToken(
  db: Db,
  over: {
    scope?: "notes:read" | "notes:read notes:write";
    expiresAt?: Date | null;
    disabled?: boolean;
    mustChangePassword?: boolean;
  } = {}
): Promise<{ token: string; userId: string; tokenId: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `t-${randomUUID()}@example.com`,
      displayName: "T",
      disabledAt: over.disabled === true ? new Date() : null,
      mustChangePassword: over.mustChangePassword ?? false,
    })
    .returning();
  const token = randomToken();
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: user.id,
      kind: "pat",
      name: "test",
      scope: over.scope ?? "notes:read notes:write",
      accessTokenHash: hash(token),
      accessExpiresAt: over.expiresAt === undefined ? null : over.expiresAt,
    })
    .returning();
  return { token, userId: user.id, tokenId: row.id };
}

describe("/api/mcp 暫時形與 Bearer challenge", () => {
  it("三個 method 無憑證 → 401，challenge 帶 resource_metadata 與兩個 scope、不帶 error", async () => {
    const { app } = await buildTestApp();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/mcp", ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode, method).toBe(401);
      const challenge = res.headers["www-authenticate"] as string;
      expect(challenge, method).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
      expect(challenge, method).toContain(`scope="notes:read notes:write"`);
      expect(challenge, method).not.toContain("error=");
    }
  });

  it("有效 token 通過 → 501 not_implemented（是我們的錯誤形，不是 500 internal）", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: { code: "not_implemented", message: expect.any(String) } });
  });

  it("壞 token → 401 且 challenge 帶 error=invalid_token", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Bearer knb_nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(`error="invalid_token"`);
  });

  it("Authorization: Basic → 401 不帶 error（RFC 6750 §3），且計入 BEARER_MISS", async () => {
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Basic dXNlcjpwdw==" } });
      expect(res.statusCode, `#${i}`).toBe(401);
      expect(res.headers["www-authenticate"], `#${i}`).not.toContain("error=");
    }
    const fourth = await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: "Basic dXNlcjpwdw==" } });
    expect(fourth.statusCode).toBe(429);
    // 429 不帶 challenge（RFC 6750 的 challenge 只定義在 400／401／403）
    expect(fourth.headers["www-authenticate"]).toBeUndefined();
  });

  it("knb_ 前綴但查無的 token 也計入 BEARER_MISS（不是只有 Basic 那條路）", async () => {
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const bad = { authorization: `Bearer ${randomToken()}` };
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: bad })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: bad })).statusCode).toBe(401);
    const third = await app.inject({ method: "GET", url: "/api/mcp", headers: bad });
    expect(third.statusCode).toBe(429);
    expect(third.headers["www-authenticate"]).toBeUndefined();
  });

  it("refresh token 當 Bearer 送 → 401 invalid_token，且計入 BEARER_MISS（前綴不合）", async () => {
    // 「前綴不合就不查 DB」這個性質這裡沒有斷言（拿掉 isAccessTokenShape 早退，查表
    // 落空後回應與計桶完全同形）——它由 test/unit/api-token.test.ts 的前綴單元測試守。
    const { app } = await buildTestApp({
      limiters: freshLimiters({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const refreshAsBearer = { authorization: `Bearer knbr_${"a".repeat(43)}` };
    const first = await app.inject({ method: "GET", url: "/api/mcp", headers: refreshAsBearer });
    expect(first.statusCode).toBe(401);
    expect(first.headers["www-authenticate"]).toContain(`error="invalid_token"`);
    expect((await app.inject({ method: "GET", url: "/api/mcp", headers: refreshAsBearer })).statusCode).toBe(429);
  });

  it("過期 PAT → 401；不到期 PAT（access_expires_at IS NULL）→ 通過", async () => {
    const { app, db } = await buildTestApp();
    const expired = await seedToken(db, { expiresAt: new Date(Date.now() - 1000) });
    const never = await seedToken(db, { expiresAt: null });
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${expired.token}` } }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${never.token}` } }))
        .statusCode
    ).toBe(501);
  });

  it("停權使用者的 token → 401；mustChangePassword 的 token → 401", async () => {
    const { app, db } = await buildTestApp();
    const disabled = await seedToken(db, { disabled: true });
    const mustChange = await seedToken(db, { mustChangePassword: true });
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${disabled.token}` } }))
        .statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${mustChange.token}` } }))
        .statusCode
    ).toBe(401);
  });

  it("有 Bearer 也有 cookie 時只看 Bearer（不回退 session）", async () => {
    const { app, db } = await buildTestApp();
    const [user] = await db
      .insert(users)
      .values({ email: `both-${randomUUID()}@example.com`, displayName: "B" })
      .returning();
    const cookie = await signSession(testConfig.appSecret, { userId: user.id, tv: 0 });

    // 先確認這個 cookie 本身有效
    const cookieOnly = await app.inject({ method: "GET", url: "/api/mcp", cookies: { [SESSION_COOKIE]: cookie } });
    expect(cookieOnly.statusCode).toBe(501);

    // 同一發再帶一個壞掉的 Bearer——必須 401，不得回退到 cookie 而變成 501
    const both = await app.inject({
      method: "GET",
      url: "/api/mcp",
      cookies: { [SESSION_COOKIE]: cookie },
      headers: { authorization: `Bearer ${randomToken()}` },
    });
    expect(both.statusCode).toBe(401);
    expect(both.headers["www-authenticate"]).toContain(`error="invalid_token"`);
  });

  it("last_used_at：第一發寫入，60 秒內第二發不再寫（節流）", async () => {
    const { app, db } = await buildTestApp();
    const { token, tokenId } = await seedToken(db);
    const read = async () => (await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)))[0];
    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    await waitFor(async () => (await read()).lastUsedAt !== null);
    const first = await read();
    expect(first.lastUsedAt).not.toBeNull();

    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    // 負向斷言（沒有第二次寫入）輪詢救不了——固定等一段，讓「若有寫」來得及落盤。
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = await read();
    expect(second.lastUsedAt!.getTime()).toBe(first.lastUsedAt!.getTime());
  });

  it("oauth grant 的 Bearer 連帶更新 oauth_clients.last_used_at（#132 的 I5 ① 依賴它）", async () => {
    const { app, db } = await buildTestApp();
    // PR1 沒有建立 oauth grant 的產品路徑，直接插一列——這條分支的邏輯現在就在
    // auth/bearer.ts 裡，必須有守衛，不能等 #132。
    const [user] = await db
      .insert(users)
      .values({ email: `oa-${randomUUID()}@example.com`, displayName: "O" })
      .returning();
    const stale = new Date(Date.now() - 10 * 86_400_000);
    await db.insert(oauthClients).values({
      clientId: "c-last-used",
      clientName: "MCP client",
      redirectUris: ["http://127.0.0.1:1/cb"],
      lastUsedAt: stale,
    });
    const token = randomToken();
    await db.insert(apiTokens).values({
      userId: user.id,
      kind: "oauth",
      name: "MCP client",
      scope: "notes:read notes:write",
      accessTokenHash: hash(token),
      refreshTokenHash: hash(`r-${token}`),
      clientId: "c-last-used",
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });
    const readClient = async () =>
      (await db.select().from(oauthClients).where(eq(oauthClients.clientId, "c-last-used")))[0];
    await waitFor(async () => (await readClient()).lastUsedAt.getTime() > stale.getTime());

    const client = await readClient();
    expect(client.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("通過後 request.user 是 gate 投影的使用者、authKind 依路徑而異", async () => {
    // token 路徑的 request.user 是 Task 9 三條 notes 路由做擁有權判定的依據——把它
    // 設成 DB 的 api_tokens 列（而非 gate 的 user）測試不會紅，這裡用探針釘住。
    const { app, db } = await buildTestApp();
    app.get("/__test/whoami-auth", { preHandler: app.authenticateAny("notes:read") }, async request => ({
      id: request.user?.id,
      email: request.user?.email,
      authKind: request.authKind,
      tokenScope: request.tokenScope ?? null,
      tokenId: request.tokenId ?? null,
    }));
    await app.ready();

    const { token, userId, tokenId } = await seedToken(db, { scope: "notes:read" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const viaToken = await app.inject({
      method: "GET",
      url: "/__test/whoami-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.json()).toEqual({
      id: userId,
      email: user.email,
      authKind: "token",
      tokenScope: "notes:read",
      tokenId,
    });

    const cookie = await signSession(testConfig.appSecret, { userId, tv: 0 });
    const viaSession = await app.inject({ method: "GET", url: "/__test/whoami-auth", cookies: { [SESSION_COOKIE]: cookie } });
    expect(viaSession.statusCode).toBe(200);
    expect(viaSession.json()).toEqual({ id: userId, email: user.email, authKind: "session", tokenScope: null, tokenId: null });
  });

  it("cookie-only 路由不帶 challenge（Bearer 打 /api/auth/me → 401 無 header）", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("spec §7：token 明文與 Authorization header 都不落 log", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const { app, db } = await buildTestApp({}, { logger: { level: "info", stream: sink } });
    const { token } = await seedToken(db);
    await app.inject({ method: "GET", url: "/api/mcp", headers: { authorization: `Bearer ${token}` } });

    const output = chunks.join("");
    // 先確認 log 真的有輸出，否則下面兩條斷言是空的（假綠）
    expect(output).toContain("/api/mcp");
    expect(output).not.toContain(token);
    expect(output.toLowerCase()).not.toContain("authorization");
  });

  it("spec §7：5xx 的錯誤 log 記得 authKind（否則 request.authKind 是只寫不驗的死欄位）", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const { app, db } = await buildTestApp({}, { logger: { level: "info", stream: sink } });
    // `withTestRoutes` 的 /__test/throw 是既有的「丟例外」探針；掛上 authenticateAny
    // 才會有 authKind，所以這裡另掛一條同形的探針路由。
    app.get("/__test/throw-auth", { preHandler: app.authenticateAny("notes:read") }, async () => {
      throw new Error("boom");
    });
    await app.ready();

    const { token } = await seedToken(db);
    const res = await app.inject({
      method: "GET",
      url: "/__test/throw-auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(500);

    const output = chunks.join("");
    // 釘住「token 路徑真的把 authKind 寫進 request」——只斷言 toContain("token") 是
    // 恆真的假守衛（tokenId 這個欄位名本身就含 token）。
    expect(output).toContain('"authKind":"token"');
    // 明文與 header 一樣不得出現在錯誤 log 裡
    expect(output).not.toContain(token);
  });
});
