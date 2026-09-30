/**
 * #175 §6.10 保險絲的失敗形——直接對 `createPool` 測（`buildTestApp` 用 `freshDb()` 自己的 pool，碰不到 `index.ts` 那段接線）。
 * S14 違反形：持交易連線時 await 同一個 pool。沒有保險絲時這是永久卡死（gate r3 A-10）；有了之後那批請求逾時 reject、pool 復原。
 */
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";

describe("createPool（#175 §6.10 保險絲）", () => {
  // 自帶 5 秒逾時（gate r1 B-N2）：「拿掉 connectionTimeoutMillis」的突變在這裡 5 秒就紅，不必等 config 的 120 秒、也不依賴 config。
  it("max=2、timeout 300ms：持交易連線時再 await 同一個 pool → 逾時 reject、不永久卡死；之後的查詢恢復", async () => {
    const pool = createPool({ databaseUrl: process.env.TEST_DATABASE_URL!, databasePoolMax: 2, databasePoolConnectionTimeoutMs: 300 });
    try {
      const violator = async () => {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await c.query("select 1");
          await new Promise(r => setTimeout(r, 30)); // 讓兩個違規者同時持有連線
          await pool.query("select 2"); // 第二條連線：pool 已滿 → 等到逾時
          await c.query("commit");
          return "ok";
        } catch (err) {
          await c.query("rollback").catch(() => {});
          return (err as Error).message;
        } finally {
          c.release();
        }
      };
      const started = Date.now();
      const results = await Promise.all([violator(), violator()]);
      expect(results).toEqual(["timeout exceeded when trying to connect", "timeout exceeded when trying to connect"]);
      expect(Date.now() - started).toBeLessThan(5_000);
      await expect(pool.query("select 3 as n")).resolves.toMatchObject({ rows: [{ n: 3 }] });
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 5_000);
});
