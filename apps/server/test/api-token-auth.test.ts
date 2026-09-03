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
import { apiTokens, noteShares, notes, oauthClients, users } from "../src/db/schema.js";
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

describe("三條 notes 路由收 Bearer（D2 的允許清單）", () => {
  it("write token 打得動三條路由", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "T" } });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/notes/${noteId}`, headers: auth })).statusCode).toBe(200);
  });

  it("read token 打得動兩條 GET、打不動 POST（各路由的 required 值逐條釘住）", async () => {
    // 沒有這條，把 GET /api/notes/:ref 的 required 改成 notes:write 全套照樣綠——唯讀
    // token 會被鎖在 MCP 最主要的讀取路由外。D2 允許清單的核心語意就是每列的 required。
    const { app, db } = await buildTestApp();
    const writer = await seedToken(db);
    const created = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { title: "shared" },
    });
    expect(created.statusCode).toBe(201);
    // 讓 reader 也讀得到這篇：分享給 reader 的使用者
    const reader = await seedToken(db, { scope: "notes:read" });
    await db.insert(noteShares).values({ noteId: created.json().id, userId: reader.userId, role: "viewer" });
    const auth = { authorization: `Bearer ${reader.token}` };

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/notes/${created.json().id}`, headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "x" } })).statusCode).toBe(403);
  });

  it("token 建的筆記擁有者是 token 的使用者（request.user 走 gate 投影）", async () => {
    const { app, db } = await buildTestApp();
    const { token, userId } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "Mine" } });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/notes", headers: auth });
    expect(listed.json().map((n: { id: string }) => n.id)).toContain(created.json().id);
    const [note] = await db.select().from(notes).where(eq(notes.id, created.json().id));
    expect(note.ownerId).toBe(userId);
  });

  it("read token 打 POST /api/notes → 403 insufficient_scope，challenge 帶該 error", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db, { scope: "notes:read" });
    const res = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
    expect(res.headers["www-authenticate"]).toContain('error="insufficient_scope"');
  });

  it("無憑證打 GET /api/notes → 401 帶 challenge，scope 只有 notes:read（鑑別力由 scope 值承擔）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/notes" });
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toContain('scope="notes:read"');
    expect(challenge).toContain("/.well-known/oauth-protected-resource/api/mcp");
  });

  it("未開放的 notes 路由不收 Bearer：PATCH／DELETE /api/notes/:id 與 collab-token 皆 401 且無 challenge", async () => {
    const { app, db } = await buildTestApp();
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    const noteId = "00000000-0000-0000-0000-000000000000";
    const cases = [
      { method: "PATCH" as const, url: `/api/notes/${noteId}`, payload: { title: "x" } },
      { method: "DELETE" as const, url: `/api/notes/${noteId}` },
      // D8：collab-token 明文不收 Bearer
      { method: "POST" as const, url: `/api/notes/${noteId}/collab-token`, payload: {} },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: auth,
        ...(c.payload ? { payload: c.payload } : {}),
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
      expect(res.headers["www-authenticate"], `${c.method} ${c.url}`).toBeUndefined();
    }
  });

  it("403 不啃 write 桶、也不啃 BEARER_MISS（扣點在 scope 檢查之後，合法 token 不連累同 IP）", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({
        tokenWrite: new FixedWindowLimiter({ limit: 3, windowMs: 600_000 }),
        // 預設 30 額度四發打不滿——bearerMiss 也收緊，否則「403 計入 miss 桶」翻掉不會紅。
        bearerMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }),
      }),
    });
    const { token } = await seedToken(db, { scope: "notes:read" });
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/notes",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      // 扣點若在 scope 檢查之前，第 4 發會變成 429；若 403 計入 miss 桶，第 3 發就 429
      expect(res.statusCode, `attempt ${i + 1}`).toBe(403);
    }
    // 「照扣但不看回傳值」的形上面抓不到：同 IP 接著送一發壞 token，miss 桶若被
    // 403 扣過會提早 429，正確是 401。
    const bad = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${randomToken()}` } });
    expect(bad.statusCode).toBe(401);
  });

  it("/api/mcp 與 GET /api/notes 同一顆 read 桶", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: "/api/mcp", headers: auth })).statusCode).toBe(501);
    }
    const limited = await app.inject({ method: "GET", url: "/api/notes", headers: auth });
    expect(limited.statusCode).toBe(429);
    // 429 一律不帶 challenge（read 桶與 BEARER_MISS 同紀律）
    expect(limited.headers["www-authenticate"]).toBeUndefined();
  });

  it("write 路由吃 write 桶，不吃 read 桶", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({
        tokenRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }),
        tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }),
      }),
    });
    const { token } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    // read 桶只剩 1 額度，先用掉
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    // write 路由若誤吃 read 桶，這裡會 429
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "a" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "b" } })).statusCode).toBe(201);
    const third = await app.inject({ method: "POST", url: "/api/notes", headers: auth, payload: { title: "c" } });
    expect(third.statusCode).toBe(429);
    expect(third.headers["www-authenticate"]).toBeUndefined();
  });

  it("token 桶 429 不寫 last_used_at（last_used 只記驗證成功的請求）", async () => {
    // #132 的 I5 ① 用 last_used_at 判斷 client 是否「30 天未使用」；被限流打回的請求
    // 若也蓋時間戳，一支只會被 429 的 token 會讓它的 client 永遠看起來活著。
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 0, windowMs: 60_000 }) }),
    });
    const { token, tokenId } = await seedToken(db);
    const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(429);
    // 負向斷言：固定等一段，讓「若有寫」來得及落盤
    await new Promise(resolve => setTimeout(resolve, 100));
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(row.lastUsedAt).toBeNull();
  });

  it("token 打滿不影響同一使用者的 session（限流只對 token 路徑）", async () => {
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ tokenRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const { token, userId } = await seedToken(db);
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: auth })).statusCode).toBe(429);
    // 同一使用者的 cookie session 不受影響（repo 慣例：各測試檔自己 signSession）
    const cookie = await signSession(testConfig.appSecret, { userId, tv: 0 });
    const viaSession = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie } });
    expect(viaSession.statusCode).toBe(200);
  });
});
