import { describe, it, expect } from "vitest";
import { onTestFinished } from "vitest";
import http from "node:http";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiActions, aiModels, aiProviders, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptApiKey } from "../src/ai/crypto.js";
import { createAiRuntime } from "../src/ai/runtime.js";
import { BUILTIN_ACTION_IDS } from "../src/db/seed-ai.js";

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(db: Db, overrides: Partial<{ email: string; isAdmin: boolean }> = {}) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: "Test User",
      isAdmin: overrides.isAdmin ?? false,
      passwordHash,
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv: 0 });
}

async function insertProvider(db: Db, overrides: Partial<typeof aiProviders.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiProviders)
    .values({
      name: overrides.name ?? "Test Provider",
      type: overrides.type ?? "openai_compatible",
      baseUrl: overrides.baseUrl ?? "http://localhost:9",
      apiKeyEncrypted: overrides.apiKeyEncrypted ?? null,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

async function insertModel(db: Db, providerId: string, overrides: Partial<typeof aiModels.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiModels)
    .values({
      providerId,
      modelId: overrides.modelId ?? "model-a",
      displayName: overrides.displayName ?? "Model A",
      purpose: "chat",
      isDefault: overrides.isDefault ?? false,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

interface FakeUpstream {
  baseUrl: string;
  calls: number;
}

/** 起一個真的本機 http server 當 fake upstream——測試連線端點打真的 `fetch()`，
 * `app.inject()` 攔不到出站請求，必須用真連線才驗得到「零呼叫」與「body 不外洩」。 */
async function startFakeUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const state: FakeUpstream = { baseUrl: "", calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream 取不到 TCP 位址");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));
  return state;
}

describe("requireAdmin 保護：admin AI 全端點非 admin 403、未登入 401", () => {
  const endpoints: Array<{ name: string; url: (id: string) => string; method: "GET" | "POST" | "PATCH" | "DELETE" }> = [
    { name: "GET providers", method: "GET", url: () => "/api/admin/ai/providers" },
    { name: "POST providers", method: "POST", url: () => "/api/admin/ai/providers" },
    { name: "PATCH providers/:id", method: "PATCH", url: id => `/api/admin/ai/providers/${id}` },
    { name: "DELETE providers/:id", method: "DELETE", url: id => `/api/admin/ai/providers/${id}` },
    { name: "POST providers/:id/test", method: "POST", url: id => `/api/admin/ai/providers/${id}/test` },
    { name: "GET models", method: "GET", url: () => "/api/admin/ai/models" },
    { name: "POST models", method: "POST", url: () => "/api/admin/ai/models" },
    { name: "PATCH models/:id", method: "PATCH", url: id => `/api/admin/ai/models/${id}` },
    { name: "DELETE models/:id", method: "DELETE", url: id => `/api/admin/ai/models/${id}` },
    { name: "GET actions", method: "GET", url: () => "/api/admin/ai/actions" },
    { name: "POST actions", method: "POST", url: () => "/api/admin/ai/actions" },
    { name: "PATCH actions/:id", method: "PATCH", url: id => `/api/admin/ai/actions/${id}` },
    { name: "DELETE actions/:id", method: "DELETE", url: id => `/api/admin/ai/actions/${id}` },
  ];

  for (const ep of endpoints) {
    it(`${ep.name}：非 admin → 403`, async () => {
      const { app, db } = await buildTestApp();
      const nonAdmin = await insertUser(db, { email: `nonadmin-${ep.name}@example.com` });
      const cookie = await cookieFor(nonAdmin.id);
      const res = await app.inject({ method: ep.method, url: ep.url("00000000-0000-0000-0000-000000000000"), cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode).toBe(403);
    });

    it(`${ep.name}：未登入 → 401`, async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({ method: ep.method, url: ep.url("00000000-0000-0000-0000-000000000000") });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("providers CRUD", () => {
  it("POST 建立（含 apiKey）→ 201，hasKey=true；回應絕不含 api_key_encrypted/ct/iv/tag/keyId 字樣", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p1@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/providers",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Ollama", type: "openai_compatible", baseUrl: "http://localhost:11434/v1", apiKey: "sk-test-123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "Ollama", type: "openai_compatible", baseUrl: "http://localhost:11434/v1", hasKey: true, degraded: false });
    expect(Object.keys(body).sort()).toEqual(["baseUrl", "createdAt", "degraded", "enabled", "hasKey", "id", "name", "type"].sort());

    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/api_key_encrypted|"ct"|"iv"|"tag"|"keyId"/);

    // DB 層真的有存密文（確認不是完全沒寫入，只是回應遮罩掉）。
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, body.id));
    expect(row.apiKeyEncrypted).not.toBeNull();
  });

  it("POST 未帶 apiKey → hasKey=false", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p2@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/providers",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "No Key", type: "openai_compatible", baseUrl: "http://localhost:11434/v1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ hasKey: false });
  });

  it("GET 列表：回應不含 api_key_encrypted/ct 字樣，即使 DB 裡有密文", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p3@example.com" });
    await insertProvider(db, { name: "P1", apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-abc") });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/providers", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toMatch(/api_key_encrypted|"ct"|"iv"|"tag"|"keyId"/);
    expect(res.json().providers.find((p: { name: string }) => p.name === "P1")).toMatchObject({ hasKey: true });
  });

  it("PATCH 給 apiKey 覆寫後從 degraded 移除（自檢成功即移除，§10 不重啟生效）", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { apiKeyEncrypted: { v: 1, keyId: "deadbeef", iv: "aa", tag: "bb", ct: "cc" } });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { apiKey: "sk-new-valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true, degraded: false });
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("PATCH 不給 apiKey → 密文原樣不動（hasKey 不變）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p5@example.com" });
    const cookie = await cookieFor(admin.id);
    const encrypted = encryptApiKey(testConfig.appSecret, "sk-original");
    const provider = await insertProvider(db, { apiKeyEncrypted: encrypted });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Renamed", hasKey: true });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(row.apiKeyEncrypted).toEqual(encrypted);
  });

  it("PATCH 不存在 → 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p6@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  // fix round 1（I-2）：空 body `{}` 全欄位皆 optional，未過濾直接 `.set({})` 會被
  // drizzle 0.44 同步 throw "No values to set"，逃出 handler 變成裸 500。
  it("PATCH 空 body {} → 400 invalid_body（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p9@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("DELETE → 204；models cascade 刪除；關聯 actions.modelId SET NULL（DB 斷言）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p7@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "Custom", systemPrompt: "sp", userTemplate: "{{text}}", modelId: model.id, applyMode: "direct", sortOrder: 99 })
      .returning();

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/providers/${provider.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);

    const [modelRow] = await db.select().from(aiModels).where(eq(aiModels.id, model.id));
    expect(modelRow).toBeUndefined();

    const [actionRow] = await db.select().from(aiActions).where(eq(aiActions.id, action.id));
    expect(actionRow.modelId).toBeNull();
  });

  it("DELETE 不存在 → 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p8@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({ method: "DELETE", url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("POST /api/admin/ai/providers/:id/test", () => {
  it("degraded provider → 503 provider_unavailable，不打 upstream（fake upstream 零呼叫）", async () => {
    const runtime = createAiRuntime();
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t1@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });
    runtime.degraded.add(provider.id);

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(upstream.calls).toBe(0);
  });

  it("fake upstream 200 → {ok:true}", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t2@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ok") });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(upstream.calls).toBe(1);
  });

  it("anthropic 分支：打 /v1/models、帶 x-api-key + anthropic-version，不含 authorization", async () => {
    const seen: { url?: string; headers?: http.IncomingHttpHeaders } = {};
    const upstream = await startFakeUpstream((req, res) => {
      seen.url = req.url;
      seen.headers = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t6@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, {
      type: "anthropic",
      baseUrl: upstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ant-test-key"),
    });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(seen.url).toBe("/v1/models");
    expect(seen.headers?.["x-api-key"]).toBe("sk-ant-test-key");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it("fake upstream 5xx → 錯誤碼 upstream_error，body 不含上游內容", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: "leaked-internal-detail-should-not-appear" }));
    });
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t3@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });

    const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });
    expect(res.body).not.toContain("leaked-internal-detail-should-not-appear");
  });

  it(
    "上游逾時（>10s 不回應）→ upstream_error，body 不含上游內容",
    async () => {
      const upstream = await startFakeUpstream(() => {
        // 刻意不呼叫 res.end()：讓連線掛著，逼 AbortSignal.timeout(10_000) 生效。
      });
      const { app, db } = await buildTestApp();
      const admin = await insertUser(db, { isAdmin: true, email: "admin-t4@example.com" });
      const cookie = await cookieFor(admin.id);
      const provider = await insertProvider(db, { baseUrl: upstream.baseUrl });

      const res = await app.inject({ method: "POST", url: `/api/admin/ai/providers/${provider.id}/test`, cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: { code: "upstream_error" } });
    },
    15_000
  );

  it("provider 不存在 → 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-t5@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({ method: "POST", url: "/api/admin/ai/providers/00000000-0000-0000-0000-000000000000/test", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("models CRUD", () => {
  it("POST purpose 非 chat → 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m1@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "m1", displayName: "M1", purpose: "embedding" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("isDefault 交易唯一：設第二個 default 後第一個變 false", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m2@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const m1 = await insertModel(db, provider.id, { modelId: "m1", isDefault: true });
    const m2 = await insertModel(db, provider.id, { modelId: "m2", isDefault: false });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${m2.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isDefault: true });

    const [row1] = await db.select().from(aiModels).where(eq(aiModels.id, m1.id));
    expect(row1.isDefault).toBe(false);
  });

  // fix round 1（I-1 迴歸釘）：PATCH 一個不存在的 id 且帶 `{isDefault:true}`——修法前
  // 的順序（交易內先無條件 unset 同 purpose 其他列，之後才發現 target 不存在）會讓
  // 這種完全找不到目標的請求，靜默把既有的 default 偏好清空後才回 404，且交易仍
  // commit（找不到列不是例外，不觸發 rollback）。必須是：整個請求無效果，404，
  // 既有 default 原封不動。
  it("PATCH 不存在的 id + {isDefault:true} → 404，且不動既有 default（I-1 迴歸）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m7@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const existingDefault = await insertModel(db, provider.id, { modelId: "existing-default", isDefault: true });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/models/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });

    const [row] = await db.select().from(aiModels).where(eq(aiModels.id, existingDefault.id));
    expect(row.isDefault).toBe(true);
  });

  // fix round 1（I-2）：models PATCH 空 body {} → 400（同 providers PATCH 理由）。
  it("PATCH 空 body {} → 400 invalid_body（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m8@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${model.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // fix round 1（I-3-2）：合法 uuid 格式但不存在的 providerId——驗證 `isForeignKeyViolation`
  // 真的接得住 drizzle 0.44 包裝過的 pg 錯誤（`DrizzleQueryError`，原始錯誤落在 `.cause`），
  // 不是只在裸 `DatabaseError` 形狀下才生效。
  it("POST 帶不存在的 providerId（合法 uuid）→ 400 invalid_body（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m9@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: "00000000-0000-0000-0000-000000000000", modelId: "m1", displayName: "M1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("POST isDefault:true 交易唯一：既有 default 被 unset", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m3@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const existing = await insertModel(db, provider.id, { modelId: "existing", isDefault: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "new-default", displayName: "New Default", isDefault: true },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await db.select().from(aiModels).where(eq(aiModels.id, existing.id));
    expect(row.isDefault).toBe(false);
  });

  it("重複 (providerId, modelId) → 409 model_taken", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m4@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { modelId: "dup-model" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/models",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { providerId: provider.id, modelId: "dup-model", displayName: "Dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "model_taken" } });
  });

  it("DELETE → 204；不存在 → 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m5@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id);

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/models/${model.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(204);

    const resMissing = await app.inject({ method: "DELETE", url: `/api/admin/ai/models/${model.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(resMissing.statusCode).toBe(404);
  });

  it("GET 列表形狀正確", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-m6@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { modelId: "shape-model" });

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/models", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const found = res.json().models.find((m: { modelId: string }) => m.modelId === "shape-model");
    expect(found).toMatchObject({ providerId: provider.id, displayName: "Model A", purpose: "chat", enabled: true });
  });
});

describe("actions CRUD", () => {
  it("GET 列表：builtin 旗標正確（內建四動作 true，自訂 false）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a1@example.com" });
    const cookie = await cookieFor(admin.id);
    await db.insert(aiActions).values({ name: "Custom", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 100 });

    const res = await app.inject({ method: "GET", url: "/api/admin/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const rows: Array<{ id: string; builtin: boolean; name: string }> = res.json().actions;
    for (const id of BUILTIN_ACTION_IDS) {
      expect(rows.find(r => r.id === id)?.builtin).toBe(true);
    }
    expect(rows.find(r => r.name === "Custom")?.builtin).toBe(false);
  });

  it("POST userTemplate 缺 {{text}} → 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a2@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "Bad", systemPrompt: "sp", userTemplate: "no placeholder here", applyMode: "direct" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // fix round 1（I-3-2）：合法 uuid 格式但不存在的 modelId——同 models POST 的
  // `isForeignKeyViolation` 解包驗證，這裡驗的是 actions 表另一個 FK（`model_id`）。
  it("POST 帶不存在的 modelId（合法 uuid）→ 400 invalid_body（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a7@example.com" });
    const cookie = await cookieFor(admin.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {
        name: "Bad Model Ref",
        systemPrompt: "sp",
        userTemplate: "{{text}}",
        applyMode: "direct",
        modelId: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  // fix round 1（I-2）：actions PATCH 空 body {} → 400（同 providers/models PATCH 理由）。
  it("PATCH 空 body {} → 400 invalid_body（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a8@example.com" });
    const cookie = await cookieFor(admin.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "EmptyPatchTarget", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 1 })
      .returning();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("POST 建立自訂動作成功；自訂動作可 DELETE", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a3@example.com" });
    const cookie = await cookieFor(admin.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/admin/ai/actions",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "MyAction", systemPrompt: "sp", userTemplate: "{{text}} 請處理", applyMode: "preview", sortOrder: 5 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created).toMatchObject({ name: "MyAction", builtin: false, applyMode: "preview", sortOrder: 5 });

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/admin/ai/actions/${created.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(deleteRes.statusCode).toBe(204);

    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, created.id));
    expect(row).toBeUndefined();
  });

  it("DELETE 內建動作 → 400 builtin_action，不落地刪除", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a4@example.com" });
    const cookie = await cookieFor(admin.id);
    const builtinId = BUILTIN_ACTION_IDS[0];

    const res = await app.inject({ method: "DELETE", url: `/api/admin/ai/actions/${builtinId}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "builtin_action" } });

    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, builtinId));
    expect(row).toBeDefined();
  });

  it("PATCH sortOrder 收整數；PATCH userTemplate 缺 {{text}} → 400", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a5@example.com" });
    const cookie = await cookieFor(admin.id);
    const [action] = await db
      .insert(aiActions)
      .values({ name: "PatchMe", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: 1 })
      .returning();

    const okRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { sortOrder: 7 },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toMatchObject({ sortOrder: 7 });

    const badRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/actions/${action.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { userTemplate: "沒有佔位符" },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json()).toMatchObject({ error: { code: "invalid_body" } });
  });

  it("PATCH 不存在 → 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-a6@example.com" });
    const cookie = await cookieFor(admin.id);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/ai/actions/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { sortOrder: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
