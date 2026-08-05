import { randomBytes } from "node:crypto";
import { onTestFinished } from "vitest";
import { Pool } from "pg";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

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
