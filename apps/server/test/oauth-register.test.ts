/**
 * #132 Task 4：`POST /oauth/register`（DCR，§5.2）。
 *
 * 這一族守的是：①loopback-only（D10——無認證的 DCR 若收遠端 redirect，任何人都能註冊
 * 好聽的名字做一鍵釣魚）；②不支援的 metadata 一律回絕而不是默默接受；③`client_name`
 * 黑名單；④進表前先跑 I5；⑤限流與 content-type 都走 RFC 形。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { oauthClients } from "../src/db/schema.js";
import { buildTestApp, freshLimiters, type TestApp } from "./helpers.js";

const OK_BODY = { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:1234/cb"] };

async function register(app: TestApp["app"], body: object) {
  return app.inject({ method: "POST", url: "/oauth/register", payload: body });
}

describe("POST /oauth/register（§5.2）", () => {
  it("201 回註冊結果，不發 secret，欄位固定", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, OK_BODY);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(body.client_name).toBe("Claude Code");
      expect(body.redirect_uris).toEqual(OK_BODY.redirect_uris);
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      expect(body.response_types).toEqual(["code"]);
      expect(body.token_endpoint_auth_method).toBe("none");
      // epoch **秒**（RFC 7591）——寫成毫秒的話這兩條會紅
      expect(body.client_id_issued_at).toBeGreaterThan(1_700_000_000);
      expect(body.client_id_issued_at).toBeLessThan(Date.now() / 1000 + 60);
      // 201 的兩個 header（RFC 7591 §3.2.1 的範例兩個都有）
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
      expect(body).not.toHaveProperty("client_secret");
    } finally {
      await close();
    }
  });

  it("省略 client_name → 落庫值是固定字串 MCP client", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const res = await register(app, { redirect_uris: ["http://localhost/cb"] });
      expect(res.statusCode).toBe(201);
      expect(res.json().client_name).toBe("MCP client");
      const [row] = await db.select({ name: oauthClients.clientName }).from(oauthClients);
      expect(row!.name).toBe("MCP client");
    } finally {
      await close();
    }
  });

  it("非 loopback／帶 query／帶 fragment／帶 userinfo 的 redirect_uri → 400 invalid_redirect_uri", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      for (const uri of [
        "https://example.com/cb",
        "http://localhost.evil.com/cb",
        "http://mylocalhost/cb",
        "http://127.0.0.1/cb?x=1",
        "http://127.0.0.1/cb#f",
        "http://user:pw@127.0.0.1/cb",
        "not a url",
      ]) {
        const res = await register(app, { redirect_uris: [uri] });
        expect(res.statusCode, uri).toBe(400);
        expect(res.json().error, uri).toBe("invalid_redirect_uri");
      }
      // 一個都沒落庫（拒絕要發生在 insert 之前）
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("多筆 redirect_uri 只要有一筆不合就整批拒絕", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, {
        redirect_uris: ["http://127.0.0.1:1234/cb", "https://example.com/cb"],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    } finally {
      await close();
    }
  });

  it("redirect_uris 為空、超過 8 筆或單筆超長 → 400 invalid_redirect_uri", async () => {
    const { app, close } = await buildTestApp();
    try {
      const long = `http://127.0.0.1/${"a".repeat(520)}`;
      for (const uris of [[], Array.from({ length: 9 }, (_, i) => `http://127.0.0.1/cb${i}`), [long]]) {
        const res = await register(app, { redirect_uris: uris });
        expect(res.statusCode, JSON.stringify(uris).slice(0, 40)).toBe(400);
        expect(res.json().error).toBe("invalid_redirect_uri");
      }
      // 正對照：剛好 8 筆合法 → 201（上限是 8 不是 7）
      const ok = await register(app, {
        redirect_uris: Array.from({ length: 8 }, (_, i) => `http://127.0.0.1/cb${i}`),
      });
      expect(ok.statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  it("缺 redirect_uris → 400 invalid_redirect_uri（不是 invalid_client_metadata）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { client_name: "X" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_redirect_uri");
    } finally {
      await close();
    }
  });

  it("不支援的 metadata → 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const extra of [
        { token_endpoint_auth_method: "client_secret_basic" },
        { grant_types: ["client_credentials"] },
        { grant_types: ["authorization_code", "implicit"] },
        { response_types: ["token"] },
        { response_types: ["code", "token"] },
        { client_name: "" },
        { client_name: "x".repeat(65) },
      ]) {
        const res = await register(app, { ...OK_BODY, ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json().error, JSON.stringify(extra)).toBe("invalid_client_metadata");
      }
    } finally {
      await close();
    }
  });

  it("支援範圍內的 metadata 明示給值 → 201（正對照）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, {
        ...OK_BODY,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await close();
    }
  });

  // 全空白的名稱同樣是同意頁的視覺洞：trim 後長度 0 就該落 400
  it("全空白的 client_name → 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const name of ["   ", "\t\t"]) {
        const res = await register(app, { ...OK_BODY, client_name: name });
        expect(res.statusCode, JSON.stringify(name)).toBe(400);
        expect(res.json().error).toBe("invalid_client_metadata");
      }
    } finally {
      await close();
    }
  });

  it("client_name 含 bidi 覆寫字元 → 400 invalid_client_metadata", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, client_name: `Claude${String.fromCodePoint(0x202e)}Code` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_client_metadata");
    } finally {
      await close();
    }
  });

  // trim 跑在黑名單之前：頭尾的行分隔字元被剝掉而不是回 400（方向安全——危險字元在
  // 顯示前就消失了），但落庫的名稱必須不含它。
  it("頭尾的 U+2028 被 trim 掉 → 201 且落庫名稱不含它", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, client_name: `${String.fromCodePoint(0x2028)}App` });
      expect(res.statusCode).toBe(201);
      expect(res.json().client_name).toBe("App");
      const [row] = await db.select({ name: oauthClients.clientName }).from(oauthClients);
      expect(row!.name).toBe("App");
    } finally {
      await close();
    }
  });

  it("未知欄位收到即忽略、回應不回聲", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await register(app, { ...OK_BODY, application_type: "native", software_id: "x" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty("software_id");
      expect(res.json()).not.toHaveProperty("application_type");
    } finally {
      await close();
    }
  });

  it("超過 DCR 額度 → 429 RFC 形", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ dcr: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      expect((await register(app, OK_BODY)).statusCode).toBe(201);
      expect((await register(app, OK_BODY)).statusCode).toBe(201);
      const res = await register(app, OK_BODY);
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("invalid_request");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await close();
    }
  });

  it("進表前跑 I5：25 小時前的殭屍 client 在這一發後消失", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await register(app, OK_BODY);
      const ids = (await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id);
      expect(ids).not.toContain("zombie");
      expect(ids).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("JSON 以外的 content-type → 415 RFC 形", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauth/register",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "redirect_uris=x",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("兩次註冊拿到不同的 client_id", async () => {
    const { app, close } = await buildTestApp();
    try {
      const a = (await register(app, OK_BODY)).json().client_id as string;
      const b = (await register(app, OK_BODY)).json().client_id as string;
      expect(a).not.toBe(b);
    } finally {
      await close();
    }
  });
});
