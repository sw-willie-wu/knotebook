import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { freshDb } from "./helpers.js";

// freshDb() 建的每個 test_<random> 資料庫都必須在測試結束時被 DROP 掉（issue #51）——
// 否則單一 run 內 400+ 條測試會單調累積出數百個資料庫，最終在 CREATE DATABASE 撞牆、
// 症狀看起來像隨機 flake。這條測試釘住「close() 會把它建的資料庫刪掉」這個契約：
// 把 DROP 從 close() 拿掉（回到只 pool.end()）時它必須變紅。
describe("freshDb 清理", () => {
  it("close() 會 DROP 掉它建立的資料庫", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) throw new Error("TEST_DATABASE_URL 未設定");

    const { pool, close } = await freshDb();

    // 從連線自身問出資料庫名——freshDb() 不對外暴露它，用 current_database() 取回。
    const nameRes = await pool.query<{ name: string }>("SELECT current_database() AS name");
    const dbName = nameRes.rows[0]?.name;
    expect(dbName).toMatch(/^test_[0-9a-f]+$/);

    const admin = new Pool({ connectionString: baseUrl });
    try {
      const before = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      expect(before.rowCount).toBe(1);

      await close();

      const after = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      expect(after.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
