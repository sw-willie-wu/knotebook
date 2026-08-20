import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiActions, aiModels, aiProviders, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { hashPassword } from "../src/auth/password.js";
import { BUILTIN_ACTION_IDS } from "../src/db/seed-ai.js";

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
      // 與 admin-ai／ai-sse 的同名 helper 對齊：密文綁 providerId（issue #14），要塞既有
      // 密文的呼叫端必須先拿得到 id。
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

describe("GET /api/ai/actions（一般 session，spec §13.2）", () => {
  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/ai/actions" });
    expect(res.statusCode).toBe(401);
  });

  it("全新實例（seed 過內建四動作但零 provider）→ {actions: []}——未設定＝功能不存在", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);

    // seed 確實已跑過（migrate 尾端呼叫 seedAiActions）：DB 裡有四筆內建動作，
    // 但因為零 provider，解析全數失敗，清單必須是空陣列，不能因為 seed 存在就洩漏出來。
    const [seeded] = await db.select().from(aiActions).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));
    expect(seeded).toBeDefined();

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actions: [] });
  });

  it("建 provider + enabled model（未設 default）→ 四筆內建動作全出（閘門一致性正向案）", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([...BUILTIN_ACTION_IDS].sort());
    for (const a of res.json().actions) {
      expect(Object.keys(a).sort()).toEqual(["applyMode", "id", "name"].sort());
    }
  });

  it("停用唯一可用的 model → 回空", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id, { enabled: false });

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actions: [] });
  });

  it("action.enabled=false → 不出（縱使模型可解析）", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);
    await db.update(aiActions).set({ enabled: false }).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(BUILTIN_ACTION_IDS[0]);
    expect(ids).toHaveLength(BUILTIN_ACTION_IDS.length - 1);
  });

  it("排序照 sortOrder, id：自訂動作 sortOrder 更小則排在內建動作之前", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    await insertModel(db, provider.id);
    const [custom] = await db
      .insert(aiActions)
      .values({ name: "First", systemPrompt: "sp", userTemplate: "{{text}}", applyMode: "direct", sortOrder: -1 })
      .returning();

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().actions[0].id).toBe(custom.id);
  });

  it("正向回退案：action 綁定的 model 已停用，但另有可用 enabled chat model → 該 action 仍出現", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const provider = await insertProvider(db);
    const disabledModel = await insertModel(db, provider.id, { modelId: "disabled-one", enabled: false });
    await insertModel(db, provider.id, { modelId: "fallback-one" });
    await db.update(aiActions).set({ modelId: disabledModel.id }).where(eq(aiActions.id, BUILTIN_ACTION_IDS[0]));

    const res = await app.inject({ method: "GET", url: "/api/ai/actions", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().actions.map((a: { id: string }) => a.id);
    expect(ids).toContain(BUILTIN_ACTION_IDS[0]);
  });
});
