/**
 * #132 Task 5：`GET /oauth/authorize`（§5.3）。
 *
 * 這一族守的是三條承重紀律：
 * ① **限流擋在任何 DB 存取之前**，且是 consume-always（每一發通過 T1 的都計數）；
 * ② **只有「redirect_uri 不可信」才不導回**（RFC 6749 §4.1.2.1），其餘一律 302 帶
 *    結構化錯誤回 client——否則 client 只會停在一頁純文字等逾時；
 * ③ 不可信那條的 400 頁**全靜態、不回聲任何請求參數**（無認證方控制的字串）。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { oauthClients, oauthRequests } from "../src/db/schema.js";
import { buildTestApp, freshLimiters, testConfig, type TestApp } from "./helpers.js";

const CHALLENGE = "a".repeat(43);
const ISSUER = testConfig.publicUrl.origin;
const RESOURCE = `${ISSUER}/api/mcp`;

/** 註冊一個 client，回它的 client_id。 */
async function seedClient(app: TestApp["app"], redirectUri: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { client_name: "Test client", redirect_uris: [redirectUri] },
  });
  return res.json().client_id as string;
}

function authorizeUrl(params: Record<string, string>): string {
  return `/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

function baseParams(clientId: string, redirectUri: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st",
  };
}

describe("GET /oauth/authorize（§5.3）", () => {
  it("全部合法 → 建 pending request 並 302 到 SPA 同意頁", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:5678/cb"), scope: "notes:write" }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=[A-Za-z0-9_-]{22}$/);
      // 中介快取住「302 → /authorize?req=<id>」正是不該發生的事
      expect(res.headers["cache-control"]).toBe("no-store");

      const [row] = await db.select().from(oauthRequests);
      expect(row!.clientId).toBe(clientId);
      // 存的是**本次**送來的完整值（含 ephemeral port），不是註冊值
      expect(row!.redirectUri).toBe("http://127.0.0.1:5678/cb");
      expect(row!.scope).toBe("notes:read notes:write");
      expect(row!.state).toBe("st");
      expect(row!.codeChallenge).toBe(CHALLENGE);
    } finally {
      await close();
    }
  });

  it("scope 省略 → 落庫最小權限（notes:read）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const params = baseParams(clientId, "http://127.0.0.1:1234/cb");
      const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
      expect(res.statusCode).toBe(302);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.scope).toBe("notes:read");
    } finally {
      await close();
    }
  });

  it("未註冊的 client_id 與不匹配的 redirect_uri → 400 靜態純文字，不導回、不回聲參數", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const cases = [
        baseParams("nosuchclient", "http://127.0.0.1:1234/cb"),
        baseParams(clientId, "http://127.0.0.1:1234/other"),
      ];
      for (const params of cases) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(res.body).toContain("重新加入");
        // 無認證方控制的字串一律不回聲（不出 HTML 就沒有 CSP 問題，但仍不回聲）
        expect(res.body).not.toContain(params.client_id);
        expect(res.body).not.toContain(params.redirect_uri);
      }
      // 不可信的請求不建 pending request
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("T1：client_id 或 redirect_uri 缺席／超長 → 400 且 body 不含送入的字串", async () => {
    const { app, close } = await buildTestApp();
    try {
      const longId = "c".repeat(65);
      const longUri = `http://127.0.0.1/${"a".repeat(520)}`;
      const cases: Array<Record<string, string>> = [
        baseParams(longId, "http://127.0.0.1/cb"),
        baseParams("ok", longUri),
      ];
      for (const params of cases) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
        // 必須是 T1 的訊息：拿掉長度上限後會落到步驟 1 的「註冊已失效」說明頁，
        // 那頁同樣 400／text-plain／不含送入字串，只有這一條分得出來。
        expect(res.body).toContain("缺少必要參數");
        expect(res.body).not.toContain(longId);
        expect(res.body).not.toContain(longUri);
      }
      // 完全缺參數
      for (const params of [{}, { client_id: "x" }, { redirect_uri: "http://127.0.0.1/cb" }]) {
        const res = await app.inject({ method: "GET", url: authorizeUrl(params as Record<string, string>) });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await close();
    }
  });

  // client_id 進的是 SQL 述詞（不是 INSERT）：帶 NUL 的 bind 參數會讓 PG 22021，
  // 冒到 error handler 就是無認證端點的 500。
  it("client_id 含 NUL → 400 說明頁，不是 500", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("\u0000", "http://127.0.0.1:1234/cb")),
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toContain("重新加入");
    } finally {
      await close();
    }
  });

  it("授權時的 port 與註冊時不同仍放行（RFC 8252 §7.3）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams(clientId, "http://127.0.0.1:59999/cb")),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=/);
    } finally {
      await close();
    }
  });

  it("T2 錯誤一律 302 帶結構化 error 回 redirect_uri，含 iss 與原樣 state", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const redirectUri = "http://127.0.0.1:1234/cb";
      const cases: Array<[Record<string, string>, string]> = [
        [{ response_type: "token" }, "unsupported_response_type"],
        [{ code_challenge_method: "plain" }, "invalid_request"],
        [{ code_challenge: "short" }, "invalid_request"],
        [{ code_challenge: "!".repeat(43) }, "invalid_request"],
        [{ code_challenge: "a".repeat(129) }, "invalid_request"],
        [{ resource: `${ISSUER}/API/MCP` }, "invalid_target"],
        [{ resource: `${ISSUER}/api/mcp/` }, "invalid_target"],
      ];
      for (const [override, expected] of cases) {
        const params = { ...baseParams(clientId, redirectUri), ...override };
        const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
        expect(res.statusCode, expected).toBe(302);
        const url = new URL(res.headers.location as string);
        expect(`${url.origin}${url.pathname}`, expected).toBe(redirectUri);
        expect(url.searchParams.get("error"), expected).toBe(expected);
        expect(url.searchParams.get("state"), expected).toBe("st");
        expect(url.searchParams.get("iss"), expected).toBe(ISSUER);
        expect(url.searchParams.get("error_description"), expected).toBeTruthy();
      }
      // T2 失敗不建 pending request
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("resource 缺席 → invalid_target（RFC 8707 §2.1，與無效同碼）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const params = baseParams(clientId, "http://127.0.0.1:1234/cb");
      delete params.resource;
      const res = await app.inject({ method: "GET", url: authorizeUrl(params) });
      expect(res.statusCode).toBe(302);
      expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_target");
    } finally {
      await close();
    }
  });

  it("resource 大小寫不同的 scheme/host 仍接受", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({
          ...baseParams(clientId, "http://127.0.0.1:1234/cb"),
          resource: RESOURCE.replace("http://", "HTTP://").replace("localhost", "LOCALHOST"),
        }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/authorize\?req=/);
    } finally {
      await close();
    }
  });

  it("state 2048 字元原樣回；2049 字元 → invalid_request 且不回聲 state", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const ok = "s".repeat(2048);
      const okRes = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: ok }),
      });
      expect(okRes.statusCode).toBe(302);
      expect(okRes.headers.location).toMatch(/^\/authorize\?req=/);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.state).toBe(ok); // 原樣存，禁止截斷

      const tooLong = "s".repeat(2049);
      const badRes = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: tooLong }),
      });
      expect(badRes.statusCode).toBe(302);
      const url = new URL(badRes.headers.location as string);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      // 失敗原因就是 state 超長 → 不回聲它
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
    } finally {
      await close();
    }
  });

  it("scope／resource 超長 → invalid_request", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const overrides: Array<Record<string, string>> = [
        { scope: "s".repeat(513) },
        { resource: `${RESOURCE}${"x".repeat(513)}` },
      ];
      for (const override of overrides) {
        const res = await app.inject({
          method: "GET",
          url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), ...override }),
        });
        expect(res.statusCode).toBe(302);
        expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // state 是這條路上唯一沒有其他字元守衛的落庫字串（text 欄存不下 NUL → 22021 →
  // 無認證端點的 500）。拒收時同樣不回聲它。
  //
  // ⚠ 只測 NUL：落單代理經 query string 傳不進來（URLSearchParams 會把它編碼成
  // U+FFFD），實作仍擋是為了與 redirect_uri 共用同一道述詞——那條經 jsonb 真的可達。
  it("state 含 NUL → invalid_request，且不回聲 state、不進 DB", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state: "\u0000x" }),
      });
      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get("error")).toBe("invalid_request");
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // 正對照：成對代理是合法 astral 字元，不能被誤擋
  it("state 含 emoji（成對代理）仍原樣存回", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const state = "ok-\u{1F600}";
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({ ...baseParams(clientId, "http://127.0.0.1:1234/cb"), state }),
      });
      expect(res.statusCode).toBe(302);
      const [row] = await db.select().from(oauthRequests);
      expect(row!.state).toBe(state);
    } finally {
      await close();
    }
  });

  it("state 含 & 與 # 時編碼正確（一律 URL API，不字串串接）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl({
          ...baseParams(clientId, "http://127.0.0.1:1234/cb"),
          state: "a&x=1#f",
          response_type: "token",
        }),
      });
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get("state")).toBe("a&x=1#f");
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      expect(url.searchParams.get("error")).toBe("unsupported_response_type");
    } finally {
      await close();
    }
  });

  it("consume-always：合法請求也計數，超限回 429 純文字且不進 DB", async () => {
    const { app, db, close } = await buildTestApp({
      limiters: freshLimiters({ authorize: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      const url = authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb"));
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);

      const before = await db.select({ id: oauthRequests.id }).from(oauthRequests);
      const limited = await app.inject({ method: "GET", url });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["content-type"]).toBe("text/plain; charset=utf-8");
      const after = await db.select({ id: oauthRequests.id }).from(oauthRequests);
      expect(after).toHaveLength(before.length); // 超限的請求不進 DB

      // 鑑別「限流擋在**任何 DB 存取**之前」：不存在的 client_id 在超限狀態下必須拿到
      // 429，而不是步驟 1 查表後才發現的 400 說明頁。少了這一發，把 consume 移到 I5 與
      // client 查表之後（每發超限請求都跑 5 條全表掃描）這條測試照樣綠。
      const unknownClient = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("nosuchclient", "http://127.0.0.1:1234/cb")),
      });
      expect(unknownClient.statusCode).toBe(429);
    } finally {
      await close();
    }
  });

  it("T1 失敗不吃限流額度（擋在 consume 之前）", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ authorize: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      // 三發 T1 失敗——若它們吃了額度，後面兩發合法請求就會 429。缺參數與超長兩種
      // 形都要有：只測缺參數的話，長度上限那半段被拿掉也不會紅。
      for (let i = 0; i < 3; i += 1) {
        expect((await app.inject({ method: "GET", url: "/oauth/authorize" })).statusCode).toBe(400);
      }
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({
          method: "GET",
          url: authorizeUrl(baseParams("c".repeat(65), "http://127.0.0.1:1234/cb")),
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain("缺少必要參數");
      }
      const url = authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb"));
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(302);
    } finally {
      await close();
    }
  });

  it("I5 排在 client 查表之前：25 小時前的殭屍 client 落說明頁而不是 500", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1:1234/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      const res = await app.inject({
        method: "GET",
        url: authorizeUrl(baseParams("zombie", "http://127.0.0.1:1234/cb")),
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toContain("重新加入");
    } finally {
      await close();
    }
  });

  it("pending request 有 10 分鐘到期", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const clientId = await seedClient(app, "http://127.0.0.1:1234/cb");
      await app.inject({ method: "GET", url: authorizeUrl(baseParams(clientId, "http://127.0.0.1:1234/cb")) });
      const [row] = await db.select().from(oauthRequests);
      const ttlMs = row!.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(9 * 60_000);
      expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);
    } finally {
      await close();
    }
  });
});
