import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { onTestFinished } from "vitest";
import http from "node:http";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiActions, aiModels, aiProviders, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { hashPassword } from "../src/auth/password.js";
import { decryptApiKey, encryptApiKey } from "../src/ai/crypto.js";
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
      // 密文綁 providerId（issue #14）：要塞既有密文的呼叫端必須先拿到 id，所以這裡
      // 收 `overrides.id`，比照 production 的 `POST /api/admin/ai/providers`。
      id: overrides.id ?? randomUUID(),
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
    const p1Id = randomUUID();
    await insertProvider(db, { id: p1Id, name: "P1", apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-abc", p1Id) });
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

  it("改 base_url（沒同時給新金鑰）→ 既有金鑰作廢：hasKey false、DB 密文真的是 null（issue #46）", async () => {
    // `/test` 與每一次 AI 呼叫都會把**明文** key 送到 baseUrl 指的主機，而 baseUrl 只驗格式。
    // 不作廢的話，任何 admin 改一個明文欄位再按一下 Test，就能把金鑰送到自己的主機。
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4c@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, { id, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-secret", id) });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "http://attacker.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: false, baseUrl: "http://attacker.example.com" });

    // DB 端斷言：不是只有回應的 hasKey 變了，密文本體真的沒了。
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(row!.apiKeyEncrypted).toBeNull();
    // 沒有金鑰就不可能是「密文解不開」——degraded 一起收掉（比照 issue #17）。
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("改 base_url ＋ 同一次帶新金鑰 → 用新的，不作廢（換網址換金鑰一步完成）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4d@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, { id, apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-old", id) });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "https://new.example.com", apiKey: "sk-brand-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(decryptApiKey(testConfig.appSecret, row!.apiKeyEncrypted!, provider.id)).toBe("sk-brand-new");
  });

  it("baseUrl 帶的是**同一個值**（只改名字）→ 金鑰原封不動", async () => {
    // ⚠ 這條是整組裡最重要的：編輯表單每次送出都會把 baseUrl 一起帶上，所以判斷必須是
    // 「跟舊值不同」而不是「有沒有帶這個欄位」——否則改一次名字就把使用者的金鑰清掉。
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4e@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, {
      id,
      baseUrl: "https://api.example.com",
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-keep-me", id),
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { name: "換個名字", baseUrl: "https://api.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: true, name: "換個名字" });

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, provider.id));
    expect(decryptApiKey(testConfig.appSecret, row!.apiKeyEncrypted!, provider.id)).toBe("sk-keep-me");
  });

  it("本來就沒有金鑰的 provider 改網址 → 200、hasKey 仍是 false、不噴錯", async () => {
    // 自架 Ollama 換 port：清空是 no-op，不該有任何副作用。
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4f@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { baseUrl: "http://localhost:11434/v1", apiKeyEncrypted: null });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "http://localhost:11435/v1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasKey: false, baseUrl: "http://localhost:11435/v1" });
  });

  it("改網址會留下稽核 log，訊息字串與 docs 逐字相符（docs 教人 grep 它）", async () => {
    // `docs/self-hosting.md` 教維護者 `grep 'base URL'`、`docs/known-limitations.md` 逐字
    // 引用這則訊息並稱它是「唯一可信的痕跡」。沒有測試釘住的話，有人改一次訊息，兩份
    // 文件會靜默失效。
    const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
    const { app, db } = await buildTestApp(
      {},
      {
        logger: {
          level: "info",
          // pino 的 write hook：只收我們自己那一行，其餘（fastify 的 req/res）忽略。
          hooks: {
            logMethod(args: unknown[], method: (...a: unknown[]) => void) {
              const [obj, msg] = args as [Record<string, unknown>, string | undefined];
              if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
              method.apply(this, args as never[]);
            },
          },
        },
      }
    );
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4h@example.com" });
    const cookie = await cookieFor(admin.id);
    const id = randomUUID();
    const provider = await insertProvider(db, {
      id,
      baseUrl: "https://api.openai.com/v1",
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-x", id),
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      // 帶 userinfo：`safeTarget` 必須只記 origin+pathname，不得把憑證寫進日誌。
      payload: { baseUrl: "https://user:pass@evil.example.com/v1?k=secret" },
    });
    expect(res.statusCode).toBe(200);

    const line = lines.find(one => one.msg === "AI provider 的 base URL 被寫入");
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({
      providerId: provider.id,
      userId: admin.id,
      from: "https://api.openai.com/v1",
      to: "https://evil.example.com/v1",
      hasKeyAfter: false,
    });
    // 憑證與 query 都不得出現在那一行的任何欄位裡。
    expect(JSON.stringify(line!.obj)).not.toContain("pass");
    expect(JSON.stringify(line!.obj)).not.toContain("secret");

    // ⚠ **網址看起來沒變也要記**（審查指出，這是 round 2 的核心修法）：觸發條件若退回
    // 「跟 `existing` 不同才記」，攻擊者持續送 no-op PATCH 的那個競態下會一行都不輸出
    // ——而 docs 說那行 log 是「唯一可信的痕跡」，要抓的正是那個姿勢。
    lines.length = 0;
    const again = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { baseUrl: "https://user:pass@evil.example.com/v1?k=secret" },
    });
    expect(again.statusCode).toBe(200);
    expect(lines.some(one => one.msg === "AI provider 的 base URL 被寫入")).toBe(true);
  });

  it("併發：攻擊者的 no-op PATCH 排在受害者之後，也偷不到那把剛輸入的金鑰（TOCTOU 回歸釘）", async () => {
    // 審查實測抓到的繞過：handler 先 SELECT 舊網址、再 UPDATE，中間沒有交易。攻擊者持續送
    // `{baseUrl: EVIL}`（讀到的舊值就是 EVIL ⇒ 判定沒變 ⇒ 不清金鑰，但 base_url = EVIL 照
    // 寫），只要有一發的 SELECT 落在受害者「改回正確網址＋重新輸入金鑰」的 UPDATE 之前、
    // UPDATE 落在之後，最終列就是「攻擊者的網址 ＋ 受害者剛輸入的金鑰」。
    //
    // ⚠ 這裡**不用併發去賭那個窗口**（審查算過：以舊碼 7% 的命中率下界，12 輪全 miss 的
    // 機率有四成——那根釘子有四成機會抓不到它專門要抓的回歸）。改成自己持有行鎖，把兩者
    // 的順序釘死：攻擊者的 UPDATE 必然排在受害者 commit 之後。舊寫法（Node 端比對）在這個
    // 順序下**必然**漏，因為它的 SELECT 不受行鎖阻擋，讀到的是受害者寫入前的舊值。
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4g@example.com" });
    const cookie = await cookieFor(admin.id);
    const GOOD = "https://api.openai.com/v1";
    const EVIL = "http://evil.example.com/v1";

    const id = randomUUID();
    await insertProvider(db, { id, baseUrl: EVIL, apiKeyEncrypted: null });

    // 另開一條連往同一個測試資料庫的原始連線（`buildTestApp` 不吐 pool）。
    const [{ current_database: dbName }] = (
      await db.execute<{ current_database: string }>(sql`select current_database()`)
    ).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();

    try {
      await holder.query("begin");
      await holder.query("select 1 from ai_providers where id = $1 for update", [id]);

      // 攻擊者那一發：SELECT 讀得到（不受行鎖阻擋，讀到 EVIL），UPDATE 卡在鎖上。
      const attacker = app.inject({
        method: "PATCH",
        url: `/api/admin/ai/providers/${id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { baseUrl: EVIL },
      });
      await new Promise(resolve => setTimeout(resolve, 500));

      // ⚠ 證明攻擊者那一發真的卡在行鎖上（審查指出）：少了這道斷言，慢機器上 500ms 不夠
      // 時它的 SELECT 會跑在受害者 commit 之後 ⇒ 讀到 GOOD ⇒ 判定有變 ⇒ 連舊碼都會通過，
      // 這根釘子就不再測它要測的回歸了。被鎖擋住這件事本身就證明 SELECT 已經跑完。
      const pending = Symbol("pending");
      expect(await Promise.race([attacker, Promise.resolve(pending)])).toBe(pending);

      // 受害者：改回正確網址並重新輸入金鑰（在鎖內完成，必然先 commit）。
      await holder.query(
        `update ai_providers set base_url = $1, api_key_encrypted = $2::jsonb where id = $3`,
        [GOOD, JSON.stringify(encryptApiKey(testConfig.appSecret, "sk-victim-secret", id)), id]
      );
      await holder.query("commit");
      await attacker;
    } finally {
      await holder.end();
    }

    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
    // 攻擊者的網址寫進去了（他本來就有權限改），但**金鑰不能跟著留下**——那一句
    // `case when` 是拿受害者剛 commit 的網址重新比對的，所以必然清掉。
    expect(row!.baseUrl).toBe(EVIL);
    expect(row!.apiKeyEncrypted).toBeNull();
  });

  it("DELETE provider → 一併從 degraded 移除（留著會是永遠不會被清掉的髒狀態）", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p4b@example.com" });
    const cookie = await cookieFor(admin.id);
    const provider = await insertProvider(db, { apiKeyEncrypted: { v: 1, keyId: "deadbeef", iv: "aa", tag: "bb", ct: "cc" } });
    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/ai/providers/${provider.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(204);
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("PATCH 不給 apiKey → 密文原樣不動（hasKey 不變）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await insertUser(db, { isAdmin: true, email: "admin-p5@example.com" });
    const cookie = await cookieFor(admin.id);
    const providerId = randomUUID();
    const encrypted = encryptApiKey(testConfig.appSecret, "sk-original", providerId);
    const provider = await insertProvider(db, { id: providerId, apiKeyEncrypted: encrypted });

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
    const okId = randomUUID();
    const provider = await insertProvider(db, {
      id: okId,
      baseUrl: upstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ok", okId),
    });

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
    const antId = randomUUID();
    const provider = await insertProvider(db, {
      id: antId,
      type: "anthropic",
      baseUrl: upstream.baseUrl,
      apiKeyEncrypted: encryptApiKey(testConfig.appSecret, "sk-ant-test-key", antId),
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
