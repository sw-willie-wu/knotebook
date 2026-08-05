import { randomBytes } from "node:crypto";
import { onTestFinished } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp, type AppDeps, type BuildAppOptions } from "../src/app.js";
import { UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import type { SetupState } from "../src/auth/setup.js";

export interface FreshDb {
  db: Db;
  pool: Pool;
  /** 手動關閉 pool（非測試情境用）。在 test 內呼叫 freshDb() 不必自己叫這個——已用 onTestFinished 自動掛好。 */
  close: () => Promise<void>;
}

/**
 * 建一個全新的 database（隨機名）並跑完整 migration。
 *
 * 刻意不用「DROP SCHEMA public CASCADE; CREATE SCHEMA public」——drizzle 的 migration
 * journal 存在 `drizzle` schema，砍掉 public 後 drizzle 仍以為所有 migration 都跑過，
 * 第二次 migrate 會靜默跳過建表（journal 與實際表結構不同步）。用隨機名 CREATE DATABASE
 * 保證每個測試都是全新、乾淨、journal 與表結構一致的資料庫。
 *
 * Teardown 契約：在 vitest test 內呼叫時，用 `onTestFinished` 自動清理 pool——
 * 即使斷言失敗（test 拋出）也會執行，不會洩漏連線。同時回傳 `close()`
 * 供非 test context（例如手動除錯腳本）自行呼叫。兩者皆冪等（多次呼叫安全）。
 */
export async function freshDb(): Promise<FreshDb> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL 未設定——確認 vitest globalSetup（test/global-setup.ts）有跑過");

  const dbName = `test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: baseUrl });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  const pool = new Pool({ connectionString: dbUrl.toString() });
  const db = createDb(pool);
  await runMigrations(db);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await pool.end();
  };

  // onTestFinished 只能在 vitest test 執行context 內呼叫（否則 throw）；freshDb() 也可能被
  // 手動情境（例如除錯用的一次性腳本）呼叫，此時就退回「呼叫方自己叫 close()」。
  try {
    onTestFinished(close);
  } catch {
    // 不在 test context 內——呼叫方需自行呼叫回傳的 close()。
  }

  return { db, pool, close };
}

// buildTestApp 用的固定測試設定：databaseUrl 只是通過 loadConfig 的格式驗證，實際的
// db 連線一律走 freshDb()（每個測試獨立、全新的資料庫），與這裡的 DATABASE_URL 無關。
// 匯出供需要簽發「真的能通過 buildTestApp() 那個 app 驗證」的 session cookie 的測試
// （例如 app.test.ts 的認證鏈測試）取用同一把 appSecret。
export const testConfig: AppConfig = loadConfig({
  DATABASE_URL: "postgres://u:p@localhost:5432/test",
  APP_SECRET: "a".repeat(64),
  PUBLIC_URL: "http://localhost:3000",
});

// Task 8 才會實作真正的 SetupState；這裡先給一個固定回答（不需要 setup）的 stub，
// 讓依賴 buildApp 的測試在 Task 8 之前也能跑。
const stubSetupState: SetupState = {
  isNeeded: async () => false,
  verifyToken: () => false,
};

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  /** 手動關閉底層 pool（非測試情境用）。在 test 內呼叫 buildTestApp() 不必自己叫這個——已用 onTestFinished 自動掛好（見 freshDb）。 */
  close: () => Promise<void>;
}

/**
 * 建一個掛好預設 deps（freshDb + 真 UserGate/LoginThrottle + noop collab hooks + stub
 * setupState）的 FastifyInstance，供整合測試使用。任何 deps 都可用 `overrides` 覆寫。
 *
 * logger 預設關閉（測試輸出降噪），可用 `options.logger` 覆寫回開（例如要除錯某個
 * 測試的實際請求日誌時）。
 */
export async function buildTestApp(overrides: Partial<AppDeps> = {}, options: BuildAppOptions = {}): Promise<TestApp> {
  const { db, close } = await freshDb();
  const deps: AppDeps = {
    config: testConfig,
    db,
    gate: new UserGate(db),
    throttle: new LoginThrottle(),
    collabHooks: noopCollabHooks,
    setupState: stubSetupState,
    ...overrides,
  };
  const app = buildApp(deps, { logger: false, ...options });
  // 回傳 deps.db（而非上面 freshDb() 的原始 db）——若呼叫方透過 overrides 換掉了
  // db，回傳值必須與 app 實際在用的一致，否則呼叫方用回傳的 db 操作會打到錯的資料庫。
  return { app, db: deps.db, close };
}
