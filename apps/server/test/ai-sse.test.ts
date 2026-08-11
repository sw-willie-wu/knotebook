import { setTimeout as realDelay } from "node:timers/promises";
import http from "node:http";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiActions, aiModels, aiProviders, notes, noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptApiKey } from "../src/ai/crypto.js";
import { createAiRuntime } from "../src/ai/runtime.js";
import { COLLAB_TOKEN_LIMIT, FixedWindowLimiter, SLUG_PATCH_LIMIT, UPLOAD_LIMIT } from "../src/http/rate-limit.js";

const VALID_PASSWORD = "correct-horse-battery";

async function insertUser(db: Db) {
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({ email: `user-${Math.random().toString(36).slice(2)}@example.com`, displayName: "Test User", passwordHash })
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

async function insertAction(db: Db, overrides: Partial<typeof aiActions.$inferInsert> = {}) {
  const [row] = await db
    .insert(aiActions)
    .values({
      name: overrides.name ?? "Test Action",
      systemPrompt: overrides.systemPrompt ?? "You are a helpful assistant.",
      userTemplate: overrides.userTemplate ?? "{{text}}",
      modelId: overrides.modelId ?? null,
      applyMode: overrides.applyMode ?? "direct",
      sortOrder: overrides.sortOrder ?? 0,
      enabled: overrides.enabled ?? true,
    })
    .returning();
  return row;
}

interface NoteAccess {
  ownerId: string;
  ownerCookie: string;
  editorId: string;
  editorCookie: string;
  viewerId: string;
  viewerCookie: string;
  noteId: string;
}

async function setupNoteAccess(db: Db): Promise<NoteAccess> {
  const owner = await insertUser(db);
  const editor = await insertUser(db);
  const viewer = await insertUser(db);
  const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning({ id: notes.id });
  await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
  await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });
  return {
    ownerId: owner.id,
    ownerCookie: await cookieFor(owner.id),
    editorId: editor.id,
    editorCookie: await cookieFor(editor.id),
    viewerId: viewer.id,
    viewerCookie: await cookieFor(viewer.id),
    noteId: note.id,
  };
}

/** 全 limiters 皆給生產預設值，只有 `ai` 可覆寫——供 429 測試用小額度，其餘測試不受影響。 */
function limitersWithAi(ai: FixedWindowLimiter) {
  return {
    collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
    slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
    upload: new FixedWindowLimiter(UPLOAD_LIMIT),
    ai,
  };
}

interface FakeUpstream {
  baseUrl: string;
  calls: number;
  /** 每次收到請求時解析出的 JSON body（openai_compatible chat/completions 格式）。 */
  requestBodies: Array<{ model?: string; messages?: Array<{ role: string; content: string }> }>;
  /** 最近一次連線是否在完整回應前就被 client 中止（server 端偵測 `req`/`res` 的 close/aborted）。 */
  lastAborted: boolean;
}

/** 起一個真的本機 http server 當 fake upstream——`app.inject()` 攔不到出站請求（我們自己的
 * server code 內部打的是真 `fetch()`），沿用 `admin-ai.test.ts` 的既有 harness 慣例。 */
async function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, state: FakeUpstream) => void
): Promise<FakeUpstream> {
  const state: FakeUpstream = { baseUrl: "", calls: 0, requestBodies: [], lastAborted: false };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("aborted", () => {
      state.lastAborted = true;
    });
    res.on("close", () => {
      if (!res.writableEnded) state.lastAborted = true;
    });
    req.on("end", () => {
      try {
        state.requestBodies.push(JSON.parse(raw));
      } catch {
        // 非 JSON body（不影響測試斷言，僅供 debug）。
      }
      handler(req, res, state);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream 取不到 TCP 位址");
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  return state;
}

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

/** 解析回應體裡依序出現的 SSE `event: <type>` 名稱清單（忽略 data 內容，只看事件順序）。 */
function eventSequence(body: string): string[] {
  return [...body.matchAll(/^event: (\w+)$/gm)].map(m => m[1]!);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/ai — 授權矩陣", () => {
  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: "00000000-0000-0000-0000-000000000000", text: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("非 uuid action_id/note_id → 400（非 500）", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { action_id: "not-a-uuid", note_id: "also-not-a-uuid", text: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("note 無權（含不存在的 note）→ 404", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: "00000000-0000-0000-0000-000000000000", text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("viewer → 403", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.viewerCookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });
});

describe("POST /api/ai — action/model 解析", () => {
  it("action 不存在 → 404", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("action 存在但 disabled → 404", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const action = await insertAction(db, { enabled: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("零 provider → 503 ai_not_configured", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const action = await insertAction(db); // modelId null，且全站零 provider/model
    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ai_not_configured");
  });

  it("degraded provider → 503 provider_unavailable，不打 upstream", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end("data: [DONE]\n\n");
    });
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    runtime.degraded.add(provider.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(fakeUpstream.calls).toBe(0);
  });

  it("anthropic provider 無 key → 503 provider_unavailable，且**不**進 degraded 集合（pre-stream 獨立檢查）", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { type: "anthropic", baseUrl: "https://api.anthropic.example", apiKeyEncrypted: null });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(runtime.degraded.has(provider.id)).toBe(false);
  });

  it("apiKey 解密失敗 → 503 provider_unavailable，且加入 degraded 集合", async () => {
    const runtime = createAiRuntime();
    const { app, db } = await buildTestApp({ ai: runtime });
    const access = await setupNoteAccess(db);
    // 用不同的 appSecret 加密，模擬「APP_SECRET 已變更、舊密文解不開」。
    const badCiphertext = encryptApiKey("a-completely-different-secret-".repeat(3), "sk-x");
    const provider = await insertProvider(db, { apiKeyEncrypted: badCiphertext });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(runtime.degraded.has(provider.id)).toBe(true);
  });

  it("429（AI_LIMIT 打滿）", async () => {
    const smallAiLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: limitersWithAi(smallAiLimiter) });
    const access = await setupNoteAccess(db);
    const payload = { action_id: "00000000-0000-0000-0000-000000000000", note_id: access.noteId, text: "hi" };

    const first = await app.inject({ method: "POST", url: "/api/ai", cookies: { [SESSION_COOKIE]: access.editorCookie }, payload });
    expect(first.statusCode).not.toBe(429); // 第一次消耗掉唯一的額度（結果本身是 404，不是本測試重點）

    const second = await app.inject({ method: "POST", url: "/api/ai", cookies: { [SESSION_COOKIE]: access.editorCookie }, payload });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");
  });
});

describe("POST /api/ai — 正常串流", () => {
  it("正常串流至 done：event 順序為 delta×N → done", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("Hello"));
      res.write(sseDelta(", "));
      res.write(sseDelta("world!"));
      res.end("data: [DONE]\n\n");
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "sys prompt", userTemplate: "prefix {{text}} suffix" });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi there" },
    });

    expect(res.statusCode).toBe(200);
    // fix round 1 M-4：四個 SSE header 全斷（不只 content-type）——這行最容易在後人整理
    // header 時被無感刪掉，尤其 x-accel-buffering（反向代理不緩衝，SSE 即時性的關鍵）。
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(eventSequence(res.body)).toEqual(["delta", "delta", "delta", "done"]);
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).not.toContain("event: error");

    // 上游收到的 body：system/user 都正確套用（含 {{text}} 模板替換）。
    expect(fakeUpstream.requestBodies).toHaveLength(1);
    const sent = fakeUpstream.requestBodies[0]!;
    expect(sent.model).toBe(model.modelId);
    expect(sent.messages).toEqual([
      { role: "system", content: "sys prompt" },
      { role: "user", content: "prefix hi there suffix" },
    ]);
  });

  it("[DONE] 後即使 upstream 自己不主動關閉連線，server 端仍主動中止（I-2 回歸，防 socket 洩漏）", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("ok"));
      res.write("data: [DONE]\n\n");
      // 刻意不呼叫 res.end()——模擬「送了 [DONE] 但自己不掛斷連線」的寬鬆上游實作，
      // 逼出 route 端 finally 的 `handle.abort()` 是否真的主動要求關閉這條連線。
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(eventSequence(res.body)).toEqual(["delta", "done"]); // 正常收尾，不受 upstream 未關連線影響

    // 即使 client 端請求早已正常完成，upstream 端的連線也應該在短時間內被我們主動中止
    // （`handle.abort()`），不會無限期掛著——`lastAborted` 沿用既有 fake upstream helper 的
    // 「未寫完就被關」語意（這裡是「res 未呼叫 end() 就被關」）。
    await realDelay(300);
    expect(fakeUpstream.lastAborted).toBe(true);
  });

  it("upstream 5xx → SSE error 事件，message 固定文案不含 fake upstream body 的哨兵字串", async () => {
    const sentinel = "SENTINEL-DO-NOT-LEAK-9f3a";
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(sentinel);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });

    expect(res.statusCode).toBe(200); // hijack 之後一律 200 + SSE，錯誤走事件而非 HTTP 狀態碼
    expect(eventSequence(res.body)).toEqual(["error"]);
    expect(res.body).toContain("upstream request failed");
    expect(res.body).not.toContain(sentinel);
  });

  it("PATCH action 的 systemPrompt 後，下一發立即生效（無快取護欄）", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id, systemPrompt: "v1 prompt" });

    const first = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(first.statusCode).toBe(200);

    await db.update(aiActions).set({ systemPrompt: "v2 prompt — 改過了" }).where(eq(aiActions.id, action.id));

    const second = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(second.statusCode).toBe(200);

    expect(fakeUpstream.requestBodies).toHaveLength(2);
    expect(fakeUpstream.requestBodies[0]!.messages?.[0]).toEqual({ role: "system", content: "v1 prompt" });
    expect(fakeUpstream.requestBodies[1]!.messages?.[0]).toEqual({ role: "system", content: "v2 prompt — 改過了" });
  });

  it("client 中途斷線 → fake upstream 收到 abort", async () => {
    let releaseUpstream: (() => void) | undefined;
    const upstreamHeld = new Promise<void>(resolve => (releaseUpstream = resolve));
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("first-chunk"));
      // 刻意不 end：卡住連線，等測試主動中止 client 端後，觀察 server 端是否偵測到 abort。
      void upstreamHeld;
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    await app.listen({ port: 0, host: "127.0.0.1" });
    onTestFinished(() => app.close());
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("app.listen 後取不到 TCP 位址");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const cookieHeader = `${SESSION_COOKIE}=${access.editorCookie}`;
    const controller = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/api/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ action_id: action.id, note_id: access.noteId, text: "hi" }),
      signal: controller.signal,
    });

    const res = await fetchPromise;
    const reader = res.body!.getReader();
    await reader.read(); // 確保至少收到第一個 delta，client 真的已經連上串流

    controller.abort(); // 模擬 client 中途斷線
    await reader.cancel().catch(() => {});

    // fake upstream 端應觀察到連線被中止（req 'aborted' 或 res 'close' 於未寫完前觸發）。
    await realDelay(300);
    expect(fakeUpstream.lastAborted).toBe(true);
    releaseUpstream?.();
  });

  it("idle timeout：fake upstream 停止吐 delta 60s → SSE error", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseDelta("only-one-chunk-then-silence"));
      // 之後刻意不再吐任何 delta、也不 res.end()——模擬 upstream 卡住，逼出 idle timeout 分支。
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const model = await insertModel(db, provider.id);
    const action = await insertAction(db, { modelId: model.id });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const resPromise = app.inject({
        method: "POST",
        url: "/api/ai",
        cookies: { [SESSION_COOKIE]: access.editorCookie },
        payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
      });

      // 給 pre-stream DB 查詢／首個 delta 真實時間跑完，確保 handler 已至少呼叫過一次
      // resetIdleTimer（用 node:timers/promises 的 setTimeout，不受 vi.useFakeTimers 影響）。
      await realDelay(300);

      await vi.advanceTimersByTimeAsync(60_000);

      const res = await resPromise;
      expect(res.statusCode).toBe(200);
      expect(eventSequence(res.body)).toEqual(["delta", "error"]);
      expect(res.body).toContain("upstream request failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/ai — 閘門一致性三案（與 GET /api/ai/actions 共用 resolveActionModel）", () => {
  it("案 A：首個 model 建成 disabled → GET 清單與 POST 皆判定不可用", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { enabled: false });
    const action = await insertAction(db); // modelId null，回退候選為空（唯一 model 是 disabled）

    const getRes = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getRes.json().actions.map((a: { id: string }) => a.id)).not.toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(503);
    expect(postRes.json().error.code).toBe("ai_not_configured");
  });

  it("案 B：PATCH 停用 default model 後 → GET 清單與 POST 由可用轉為不可用", async () => {
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db);
    const model = await insertModel(db, provider.id, { isDefault: true });
    const action = await insertAction(db); // modelId null，靠 isDefault 回退命中 model

    const getBefore = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getBefore.json().actions.map((a: { id: string }) => a.id)).toContain(action.id);

    const admin = await insertUser(db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const adminCookie = await cookieFor(admin.id);
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/admin/ai/models/${model.id}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const getAfter = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getAfter.json().actions.map((a: { id: string }) => a.id)).not.toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(503);
    expect(postRes.json().error.code).toBe("ai_not_configured");
  });

  it("案 C：DELETE default model 後另一 enabled model 仍在 → GET 清單與 POST 回退成功", async () => {
    const fakeUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(`${sseDelta("fallback ok")}data: [DONE]\n\n`);
    });
    const { app, db } = await buildTestApp();
    const access = await setupNoteAccess(db);
    const provider = await insertProvider(db, { baseUrl: fakeUpstream.baseUrl });
    const defaultModel = await insertModel(db, provider.id, { modelId: "default-model", isDefault: true });
    const fallbackModel = await insertModel(db, provider.id, { modelId: "fallback-model", isDefault: false });
    const action = await insertAction(db); // modelId null，靠回退排序命中

    const admin = await insertUser(db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const adminCookie = await cookieFor(admin.id);
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/admin/ai/models/${defaultModel.id}`,
      cookies: { [SESSION_COOKIE]: adminCookie },
    });
    expect(deleteRes.statusCode).toBe(204);

    const getAfter = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: access.editorCookie } });
    expect(getAfter.json().actions.map((a: { id: string }) => a.id)).toContain(action.id);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/ai",
      cookies: { [SESSION_COOKIE]: access.editorCookie },
      payload: { action_id: action.id, note_id: access.noteId, text: "hi" },
    });
    expect(postRes.statusCode).toBe(200);
    expect(eventSequence(postRes.body)).toEqual(["delta", "done"]);
    expect(fakeUpstream.requestBodies[0]!.model).toBe(fallbackModel.modelId);
  });
});
