import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildApp } from "../src/app.js";
import { freshDb, freshUploadsDir, testConfig } from "./helpers.js";
import { UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { instanceSetup, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { createAiRuntime } from "../src/ai/runtime.js";

/**
 * `ADMIN_EMAIL`/`ADMIN_PASSWORD` env bootstrap（spec rev 5.7 / §14.2：setup token 已
 * 退役，`initializeInstance` 是實例初始化的唯一路徑）整合測試專用 harness：不透過
 * `buildTestApp()`——那個 helper 刻意不呼叫 `initializeInstance`（見該函式說明），這裡
 * 需要「先對同一個 db 跑帶 envAdmin 的 `initializeInstance`，再拿同一個 db 建 app」這種
 * 有順序依賴的組裝，手動兜出來比硬塞進共用 helper 更直接、不影響其他測試。`limiters`
 * 不傳，沿用 `buildApp` 內建生產預設（同 buildTestApp 未收到 override 時的行為基礎，
 * 只是這裡不需要每個測試全新實例——本檔每個 it 都是全新 db/app）。
 */
async function buildAppWithEnvAdmin(envAdmin?: { email: string; password: string }) {
  const { db } = await freshDb();
  await initializeInstance(db, envAdmin);
  const gate = new UserGate(db);
  const app = buildApp(
    {
      config: testConfig,
      db,
      gate,
      throttle: new LoginThrottle(),
      collabHooks: noopCollabHooks,
      uploadsDir: freshUploadsDir(),
      ai: createAiRuntime(),
    },
    { logger: false }
  );
  return { app, db };
}

const ENV_ADMIN = { email: "boss@example.com", password: "correct-horse-battery" };

describe("ADMIN_EMAIL/ADMIN_PASSWORD env bootstrap admin（spec rev 5.7 / §14.2）", () => {
  it("空 DB + 雙 env → 啟動後該帳號可登入、isAdmin、mustChangePassword=true", async () => {
    const { app, db } = await buildAppWithEnvAdmin(ENV_ADMIN);

    const [dbUser] = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(dbUser).toMatchObject({ email: ENV_ADMIN.email, displayName: "boss", isAdmin: true, mustChangePassword: true });
    expect(dbUser.passwordHash).toBeTruthy();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ENV_ADMIN.email, password: ENV_ADMIN.password },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json()).toMatchObject({ email: ENV_ADMIN.email, isAdmin: true, mustChangePassword: true });

    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ isAdmin: true, mustChangePassword: true });

    // instance_setup 已落地（一筆 singleton）。
    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
  });

  it("已初始化的 DB（既有 admin）+ 雙 env → env 完全被忽略，不建立新帳號，既有帳號不變", async () => {
    const { db } = await freshDb();
    await db.insert(instanceSetup).values({ singleton: true });
    const existing = await db
      .insert(users)
      .values({
        email: "existing-owner@example.com",
        passwordHash: await hashPassword("existing-password-here"),
        displayName: "Existing Owner",
        isAdmin: true,
      })
      .returning();

    await initializeInstance(db, ENV_ADMIN);

    // env 指定的帳號完全沒被建立。
    const envUserRows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(envUserRows).toHaveLength(0);

    // 既有帳號一筆不動。
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]).toMatchObject({ id: existing[0]!.id, email: "existing-owner@example.com" });
  });

  it("啟動重試（同一個 db 再跑一次 initializeInstance 帶同一組 envAdmin）不會建出第二個 admin", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, ENV_ADMIN);
    const afterFirst = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterFirst).toHaveLength(1);

    // 模擬「process 重啟後再跑一次 init」——instance_setup 已完成，第二次呼叫應直接
    // no-op，完全不碰 bootstrap 邏輯。
    await initializeInstance(db, ENV_ADMIN);

    const afterSecond = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
  });

  it("並發啟動嘗試（同一個 db 同時兩次 initializeInstance 帶同一組 envAdmin）→ 只建立一個 admin", async () => {
    const { db } = await freshDb();

    await Promise.all([initializeInstance(db, ENV_ADMIN), initializeInstance(db, ENV_ADMIN)]);

    const rows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(rows).toHaveLength(1);
    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
  });

  it("未初始化且無 envAdmin → throw 可行動訊息", async () => {
    const { db } = await freshDb(); // freshDb 回 {db, pool, close}——比照 gate.test.ts 解構慣例
    await expect(initializeInstance(db)).rejects.toThrow(/ADMIN_EMAIL/);
    // 且不得留下任何副作用
    expect(await db.select().from(instanceSetup)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
