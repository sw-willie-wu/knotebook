import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { aiActions, aiModels, aiProviders, notes } from "../src/db/schema.js";
import { createAiRuntime, selfCheckAiKeys } from "../src/ai/runtime.js";
import type { Db } from "../src/db/index.js";
import { encryptApiKey } from "../src/ai/crypto.js";
import { testConfig } from "./helpers.js";
import { adminApp } from "./helpers/admin-auth.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { OidcUnavailableError, probeOidcIssuer } from "../src/auth/oidc-client.js";

// admin AI 路由遇非預期 DB 錯誤時，全域 error handler 會把整個 err 交給 pino——drizzle 0.44 的 `DrizzleQueryError` 把整條 SQL
// 與 params 串進 message、也掛成屬性：寫 provider 時就是 `api_key_encrypted` 的 ct／iv／tag、可能帶 `user:pass@` 的 base_url；
// 寫 action 時是 system prompt 全文。這裡用 NUL 字元觸發真的 pg 錯誤（22021，不是任何已知的唯一鍵／FK），走真實的 drizzle 錯誤形。
const NUL = String.fromCodePoint(0);
/** pino JSON 行裡 jsonb 的鍵會以 `\"ct\"` 形出現在 message 字串裡、以 `"ct"` 形出現在物件裡——兩形都抓。 */
const SEALED_KEY = /\\*"(?:ct|iv|tag|keyId)\\*"/;
const BASE_PASS = "base-url-password-marker";
const SECRET_HOST = "secret-host-marker.example.com";
const PROMPT_MARKER = "system-prompt-marker";
const MODEL_MARKER = "model-id-marker";
const REDACTED_SUFFIX = "時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
/** DrizzleQueryError 的 params 落進 JSON log 的兩種形：message 裡的 `params: …`（drizzle 以「換行＋`params: ${params}`」接在 SQL 後）
 * 與可列舉屬性序列化成的 `"params":`。只比對這兩形，不比對裸字 params（避免別處合法出現的字樣假紅）。 */
const PARAMS_LEAK = /params: |"params"\s*:/; // 不加 \b：JSON 裡換行被跳脫成 `\n`，`params` 前一個字元是 n，\b 會漏抓

function logged(): { out: string[]; options: { logger: { level: string; stream: { write(chunk: string): void } } } } {
  const out: string[] = [];
  return { out, options: { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } } };
}

function parseLines(out: string[]): Array<Record<string, unknown>> {
  return out
    .join("")
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

async function insertProvider(db: Db, baseUrl = "https://api.example.com/v1") {
  const id = randomUUID();
  const [row] = await db
    .insert(aiProviders)
    .values({ id, name: "P", type: "openai_compatible", baseUrl, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-seed", id) })
    .returning();
  return row!;
}

async function insertModel(db: Db, providerId: string) {
  const [row] = await db.insert(aiModels).values({ providerId, modelId: "m", displayName: "M", purpose: "chat" }).returning();
  return row!;
}

async function insertAction(db: Db) {
  const [row] = await db
    .insert(aiActions)
    .values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct" })
    .returning();
  return row!;
}

type Case = {
  name: string;
  context: string;
  /** 回傳要打的請求（必要時先種資料）。 */
  request: (db: Db) => Promise<{ method: "POST" | "PATCH"; url: string; payload: object }>;
  /** 這一路 params 裡會帶的敏感片段——log 全文不得出現。 */
  markers: string[];
  sealed: boolean;
};

const CASES: Case[] = [
  {
    name: "POST /providers",
    context: "建立 AI provider",
    request: async () => ({
      method: "POST",
      url: "/api/admin/ai/providers",
      payload: { name: `x${NUL}`, type: "openai_compatible", baseUrl: `https://user:${BASE_PASS}@${SECRET_HOST}/v1`, apiKey: "sk-leak-me-not" },
    }),
    markers: [BASE_PASS, SECRET_HOST, "sk-leak-me-not"],
    sealed: true,
  },
  {
    name: "PATCH /providers/:id",
    context: "修改 AI provider",
    request: async db => {
      const p = await insertProvider(db);
      return {
        method: "PATCH",
        url: `/api/admin/ai/providers/${p.id}`,
        payload: { name: `x${NUL}`, baseUrl: `https://user:${BASE_PASS}@${SECRET_HOST}/v1`, apiKey: "sk-leak-me-not" },
      };
    },
    markers: [BASE_PASS, SECRET_HOST, "sk-leak-me-not"],
    sealed: true,
  },
  {
    name: "POST /models",
    context: "建立 AI model",
    request: async db => {
      const p = await insertProvider(db);
      return { method: "POST", url: "/api/admin/ai/models", payload: { providerId: p.id, modelId: MODEL_MARKER, displayName: `x${NUL}` } };
    },
    markers: [MODEL_MARKER],
    sealed: false,
  },
  {
    name: "PATCH /models/:id",
    context: "修改 AI model",
    request: async db => {
      const m = await insertModel(db, (await insertProvider(db)).id);
      return { method: "PATCH", url: `/api/admin/ai/models/${m.id}`, payload: { modelId: MODEL_MARKER, displayName: `x${NUL}` } };
    },
    markers: [MODEL_MARKER],
    sealed: false,
  },
  {
    name: "POST /actions",
    context: "建立 AI 動作",
    request: async () => ({
      method: "POST",
      url: "/api/admin/ai/actions",
      payload: { name: `x${NUL}`, systemPrompt: PROMPT_MARKER, userTemplate: "{{text}}", applyMode: "direct" },
    }),
    markers: [PROMPT_MARKER],
    sealed: false,
  },
  {
    name: "PATCH /actions/:id",
    context: "修改 AI 動作",
    request: async db => {
      const a = await insertAction(db);
      return { method: "PATCH", url: `/api/admin/ai/actions/${a.id}`, payload: { name: `x${NUL}`, systemPrompt: PROMPT_MARKER } };
    },
    markers: [PROMPT_MARKER],
    sealed: false,
  },
];

describe("admin AI 寫入遇非預期 DB 錯誤：回 500 internal，log 不含 params／密文／base_url／prompt", () => {
  it("前提：同一形錯誤原樣丟出時，DrizzleQueryError 的 message 確實帶 base_url 與密文（不然下面量不到東西）", async () => {
    const { db } = await adminApp();
    const id = randomUUID();
    const err = await db
      .insert(aiProviders)
      .values({ id, name: `x${NUL}`, type: "openai_compatible", baseUrl: `https://user:${BASE_PASS}@${SECRET_HOST}/v1`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "k", id) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DrizzleQueryError);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("22021");
    expect((err as Error).message).toContain(BASE_PASS);
    expect(JSON.stringify({ msg: (err as Error).message })).toMatch(SEALED_KEY);
  });

  it.each(CASES)("$name：500 internal；遮蔽行記 {code 22021, constraint null, context}；log 全文不含敏感片段", async c => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const req = await c.request(db);
    const res = await app.inject({ ...req, cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "伺服器內部錯誤" } });

    const lines = parseLines(out);
    const hits = lines.filter(l => l.msg === `${c.context}${REDACTED_SUFFIX}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 50, code: "22021", context: c.context });
    expect(hits[0]).toHaveProperty("constraint", null);
    expect(hits[0]).not.toHaveProperty("name");

    const text = out.join("");
    expect(text).toContain("unhandled error");
    expect(text).not.toContain("Failed query");
    expect(text).not.toMatch(PARAMS_LEAK);
    for (const m of c.markers) expect(text).not.toContain(m);
    if (c.sealed) expect(text).not.toMatch(SEALED_KEY);
  });
});

describe("POST /providers/:id/test 連線失敗的 log 不含 base_url 裡的憑證", () => {
  const MSG = "AI provider 測試連線失敗（逾時或網路錯誤）";

  it("base_url 帶 user:pass@ → 502；log 只記 errName／target／urlHasCredentials，不含密碼", async () => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await insertProvider(db, `http://user:${BASE_PASS}@127.0.0.1:9/v1?k=query-secret-marker`);
    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId: p.id, errName: "TypeError", urlHasCredentials: true, target: "http://127.0.0.1:9/v1" });
    expect(hits[0]).not.toHaveProperty("err");

    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("無憑證的連線拒絕 → log 仍保留可除錯資訊（causeCode ECONNREFUSED）", async () => {
    // 先起後關一個本機 server，拿一個確定沒人聽的埠（不用 :9 之類被 fetch 列為 bad port 的埠）。
    const server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));

    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await insertProvider(db, `http://127.0.0.1:${port}/v1`);
    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "TypeError", causeCode: "ECONNREFUSED", urlHasCredentials: false, target: `http://127.0.0.1:${port}/v1/models` });
  });
});

describe("POST /api/ai 上游失敗的 log 不含 base_url 裡的憑證（任何能觸發 AI 動作的使用者都能讓這行出現）", () => {
  const MSG = "ai upstream failed";

  async function aiSetup(provider: { type: "openai_compatible" | "anthropic"; baseUrl: string; apiKey?: string }) {
    const { out, options } = logged();
    const { app, db, admin, cookies } = await adminApp({}, options);
    const id = randomUUID();
    await db.insert(aiProviders).values({
      id,
      name: "P",
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEncrypted: provider.apiKey !== undefined ? encryptApiKey(testConfig.appSecret, provider.apiKey, id) : null,
    });
    const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
    const [action] = await db
      .insert(aiActions)
      .values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id })
      .returning();
    const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
    const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
    return { out, res, providerId: id };
  }

  it.each(["openai_compatible", "anthropic"] as const)("%s：base_url 帶 user:pass@ → SSE error；log 只記摘要，不含密碼與 query", async type => {
    const { out, res, providerId } = await aiSetup({ type, baseUrl: `http://user:${BASE_PASS}@127.0.0.1:9/v1?k=query-secret-marker`, apiKey: "sk-ai-key" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");

    const hits = parseLines(out).filter(l => l.msg === MSG);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId, urlHasCredentials: true, target: "http://127.0.0.1:9/v1" });
    // openai_compatible：fetch 直接丟 TypeError；anthropic：SDK 包成 APIConnectionError（`.name` 是 "Error"，取 constructor.name），
    // cause 是同一個 TypeError。
    expect(hits[0]).toMatchObject(type === "anthropic" ? { errName: "APIConnectionError", causeName: "TypeError" } : { errName: "TypeError" });
    expect(hits[0]).not.toHaveProperty("err");

    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("上游回非 2xx（UpstreamError）→ log 仍保留 status 與截過的 upstreamBody", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream-body-marker");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { out } = await aiSetup({ type: "openai_compatible", baseUrl: `http://127.0.0.1:${port}/v1` });
      const hits = parseLines(out).filter(l => l.msg === MSG);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ errName: "UpstreamError", status: 500, upstreamBody: "upstream-body-marker", urlHasCredentials: false });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("開機 v1→v2 密文升級寫入失敗：log 不含新密文", () => {
  it("UPDATE 遇非預期 DB 錯誤 → 遮蔽行 {code P0001, context}＋原 warn 行（無 err）；log 全文不含 ct／iv／tag／params", async () => {
    const { db } = await adminApp();
    const id = randomUUID();
    // 手造 v1 密文（issue #14 之前格式：無 AAD）——升級條件是「用目前 APP_SECRET 解得開的 v1」。
    const key = createHash("sha256").update(`${testConfig.appSecret}:ai-key`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("sk-legacy", "utf8"), cipher.final()]);
    await db.insert(aiProviders).values({
      id,
      name: "Legacy",
      type: "openai_compatible",
      baseUrl: "http://localhost:9",
      apiKeyEncrypted: {
        v: 1,
        keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      },
    });
    // 只讓 UPDATE 失敗（SQLSTATE P0001，不是任何已知約束），走真實的 drizzle 錯誤形。
    await db.execute(sql.raw("create function kb_test_fail_ai_update() returns trigger language plpgsql as $$ begin raise exception 'forced test failure'; end $$"));
    await db.execute(sql.raw("create trigger kb_test_fail_ai_update before update on ai_providers for each row execute function kb_test_fail_ai_update()"));

    const out: string[] = [];
    const log = pino({ level: "info" }, { write: (chunk: string) => void out.push(chunk) });
    await selfCheckAiKeys(db, testConfig.appSecret, createAiRuntime(), log);

    const lines = parseLines(out);
    const redacted = lines.filter(l => l.msg === `升級 AI provider 密文${REDACTED_SUFFIX}`);
    expect(redacted).toHaveLength(1);
    expect(redacted[0]).toMatchObject({ level: 50, code: "P0001", context: "升級 AI provider 密文" });
    const warn = lines.filter(l => typeof l.msg === "string" && l.msg.startsWith("AI provider API key 密文升級為 v2 失敗"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 40, providerId: id });
    expect(warn[0]).not.toHaveProperty("err");
    expect(lines.find(l => l.msg === "AI provider API key 密文升級掃描完成")).toMatchObject({ upgraded: 0, remaining: 1 });

    const text = out.join("");
    expect(text).not.toMatch(SEALED_KEY);
    expect(text).not.toContain("Failed query");
    expect(text).not.toMatch(PARAMS_LEAK);
  });
});

describe("anthropic 連不上（無憑證）：log 的摘要分得出錯誤種類與底層 code", () => {
  it("關掉的本機埠 → errName APIConnectionError、causeCode ECONNREFUSED（在 cause.cause）", async () => {
    const server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));

    const { out, options } = logged();
    const { app, db, admin, cookies } = await adminApp({}, options);
    const id = randomUUID();
    await db.insert(aiProviders).values({ id, name: "P", type: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-a", id) });
    const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
    const [action] = await db.insert(aiActions).values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id }).returning();
    const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
    const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
    expect(res.body).toContain("event: error");

    const hits = parseLines(out).filter(l => l.msg === "ai upstream failed");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "APIConnectionError", causeName: "TypeError", causeCode: "ECONNREFUSED", urlHasCredentials: false });
  }, 60_000);
});

describe("OIDC discovery 失敗：issuer 帶 user:pass@ 時錯誤訊息與 log 都不含密碼（/login 不必登入就能觸發）", () => {
  const ISSUER = `http://user:${BASE_PASS}@127.0.0.1:9/realms/x?k=query-secret-marker`;

  it("probeOidcIssuer：OidcUnavailableError 的 message 只含 safeTarget、不串底層 message；底層只留 name／code 摘要", async () => {
    const err = await probeOidcIssuer(ISSUER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcUnavailableError);
    expect((err as Error).message).toBe("OIDC discovery 失敗（issuer=http://127.0.0.1:9/realms/x）");
    expect((err as OidcUnavailableError).underlying).toMatchObject({ errName: "TypeError" });
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(BASE_PASS);
  });

  it("GET /api/auth/oidc/login/:id → 302 oidc_unavailable（回應不變）；log 行記 reason／underlying，不含密碼與 query", async () => {
    const { out, options } = logged();
    const { app, db } = await adminApp({}, options);
    const p = await seedAuthProvider(db, { issuerUrl: ISSUER });
    const res = await app.inject({ method: "GET", url: `/api/auth/oidc/login/${p.id}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");

    const hits = parseLines(out).filter(l => l.msg === "OIDC discovery 不可用，導回登入頁");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: 40, providerId: p.id, errName: "OidcUnavailableError", reason: "OIDC discovery 失敗（issuer=http://127.0.0.1:9/realms/x）", underlying: { errName: "TypeError" } });
    expect(hits[0]).not.toHaveProperty("err");
    const text = out.join("");
    expect(text).not.toContain(BASE_PASS);
    expect(text).not.toContain("query-secret-marker");
  });

  it("POST /api/auth/oidc/link/:id → 503 oidc_unavailable（回應不變）；log 不含密碼", async () => {
    const { out, options } = logged();
    const { app, db, cookies } = await adminApp({}, options);
    const p = await seedAuthProvider(db, { issuerUrl: ISSUER });
    const res = await app.inject({ method: "POST", url: `/api/auth/oidc/link/${p.id}`, cookies, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "oidc_unavailable", message: "登入服務目前無法使用，請稍後再試" } });

    const hits = parseLines(out).filter(l => l.msg === "手動連結起點：discovery 不可用");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ errName: "OidcUnavailableError", underlying: { errName: "TypeError" } });
    expect(out.join("")).not.toContain(BASE_PASS);
  });
});

describe("anthropic 上游回非 2xx：log 比照 openai 記 status 與截過的回應 body", () => {
  it("400 JSON body → errName BadRequestError、status 400、upstreamBody 含上游訊息", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json", "request-id": "req-marker" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "anthropic-body-marker" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { out, options } = logged();
      const { app, db, admin, cookies } = await adminApp({}, options);
      const id = randomUUID();
      await db.insert(aiProviders).values({ id, name: "P", type: "anthropic", baseUrl: `http://127.0.0.1:${port}`, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-a", id) });
      const [model] = await db.insert(aiModels).values({ providerId: id, modelId: "m", displayName: "M", purpose: "chat", isDefault: true }).returning();
      const [action] = await db.insert(aiActions).values({ name: "A", systemPrompt: "s", userTemplate: "{{text}}", applyMode: "direct", modelId: model!.id }).returning();
      const [note] = await db.insert(notes).values({ ownerId: admin.id }).returning({ id: notes.id });
      const res = await app.inject({ method: "POST", url: "/api/ai", cookies, payload: { action_id: action!.id, note_id: note!.id, text: "hi" } });
      expect(res.body).toContain("event: error");
      expect(res.body).not.toContain("anthropic-body-marker");

      const hits = parseLines(out).filter(l => l.msg === "ai upstream failed");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ errName: "BadRequestError", status: 400, requestId: "req-marker" });
      expect(hits[0]!.upstreamBody).toContain("anthropic-body-marker");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
