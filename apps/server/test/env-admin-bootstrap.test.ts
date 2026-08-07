import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildApp } from "../src/app.js";
import { freshDb, testConfig } from "./helpers.js";
import { UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import { SetupState } from "../src/auth/setup.js";
import { instanceSetup, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const silentLogger = { info: () => {} };

/**
 * `ADMIN_EMAIL`/`ADMIN_PASSWORD` env bootstrap（spec rev 5.7）整合測試專用 harness：
 * 不透過 `buildTestApp()`——那個 helper 的 `db`/`setupState` override 各自獨立套用，
 * 這裡需要「先對同一個 db 跑帶 envAdmin 的 `SetupState.init`，再拿同一個 db 建
 * app」這種有順序依賴的組裝，手動兜出來比硬塞進共用 helper 更直接、不影響其他測試。
 * `limiters` 不傳，沿用 `buildApp` 內建生產預設（同 buildTestApp 未收到 override 時的
 * 行為基礎，只是這裡不需要每個測試全新實例——本檔每個 it 都是全新 db/app）。
 */
async function buildAppWithEnvAdmin(envAdmin?: { email: string; password: string }) {
  const { db } = await freshDb();
  const setupState = await SetupState.init(db, silentLogger, envAdmin);
  const gate = new UserGate(db);
  const app = buildApp(
    { config: testConfig, db, gate, throttle: new LoginThrottle(), collabHooks: noopCollabHooks, setupState },
    { logger: false }
  );
  return { app, db, setupState };
}

const ENV_ADMIN = { email: "boss@example.com", password: "correct-horse-battery" };

describe("ADMIN_EMAIL/ADMIN_PASSWORD env bootstrap admin（spec rev 5.7）", () => {
  it("空 DB + 雙 env → 啟動後該帳號可登入、isAdmin、mustChangePassword=true；setup/status needed:false；POST /api/setup → 403（無 token 可用，等同已完成）", async () => {
    const { app, db, setupState } = await buildAppWithEnvAdmin(ENV_ADMIN);

    // 不產生 setup token。
    expect(setupState.token).toBeNull();

    const statusRes = await app.inject({ url: "/api/setup/status" });
    expect(statusRes.json()).toEqual({ needed: false });

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

    // instance_setup 已落地（一筆 singleton）——POST /api/setup 沒有可用 token
    // （setupState.token 為 null），任何 token 一律 403 invalid_setup_token，
    // 效果上等同「已完成，不能再 setup 一次」。
    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
    const setupRes = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { token: "irrelevant", email: "someone@example.com", password: "whatever-password", displayName: "Someone" },
    });
    expect(setupRes.statusCode).toBe(403);
    expect(setupRes.json()).toMatchObject({ error: { code: "invalid_setup_token" } });
  });

  it("已 setup 的 DB（既有 admin）+ 雙 env → env 完全被忽略，不建立新帳號，既有帳號不變", async () => {
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

    const setupState = await SetupState.init(db, silentLogger, ENV_ADMIN);
    expect(setupState.token).toBeNull(); // 已完成，不產生 token（本來就不該產生）

    // env 指定的帳號完全沒被建立。
    const envUserRows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(envUserRows).toHaveLength(0);

    // 既有帳號一筆不動。
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]).toMatchObject({ id: existing[0]!.id, email: "existing-owner@example.com" });
  });

  it("啟動重試（同一個 db 再跑一次 SetupState.init 帶同一組 envAdmin）不會建出第二個 admin", async () => {
    const { db } = await freshDb();
    await SetupState.init(db, silentLogger, ENV_ADMIN);
    const afterFirst = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterFirst).toHaveLength(1);

    // 模擬「process 重啟後再跑一次 init」——instance_setup 已完成，第二次呼叫應直接
    // 走 completed 分支，完全不碰 bootstrap 邏輯。
    const secondState = await SetupState.init(db, silentLogger, ENV_ADMIN);
    expect(secondState.token).toBeNull();

    const afterSecond = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
  });

  it("並發啟動嘗試（同一個 db 同時兩次 SetupState.init 帶同一組 envAdmin）→ 只建立一個 admin", async () => {
    const { db } = await freshDb();

    const [stateA, stateB] = await Promise.all([
      SetupState.init(db, silentLogger, ENV_ADMIN),
      SetupState.init(db, silentLogger, ENV_ADMIN),
    ]);

    expect(stateA.token).toBeNull();
    expect(stateB.token).toBeNull();

    const rows = await db.select().from(users).where(eq(users.email, ENV_ADMIN.email));
    expect(rows).toHaveLength(1);
    const setupRows = await db.select().from(instanceSetup);
    expect(setupRows).toHaveLength(1);
  });

  it("未設 ADMIN_EMAIL/ADMIN_PASSWORD → 現行 setup token 流程完全不變（回歸）", async () => {
    const { app, setupState } = await buildAppWithEnvAdmin(undefined);
    expect(setupState.token).toMatch(/^[0-9a-f]{64}$/);

    const statusRes = await app.inject({ url: "/api/setup/status" });
    expect(statusRes.json()).toEqual({ needed: true });
  });
});
