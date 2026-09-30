import { Pool } from "pg";
import type { AppConfig } from "../config.js";

/**
 * #175 §6.10（Willie 2026-09-30 裁決 Q24）：pool 保險絲。
 * 它做了什麼：S14 被違反（交易持連線、又 await 同一個 pool）時，卡住的那批請求在 timeout 後 reject 成 500；等待佇列 FIFO，
 * 卡住期間排在它們前面的一般請求也可能一起逾時，之後才到的最多延遲一個 timeout；卡死解開後恢復（gate r5 A-7／A-8 實跑）。
 * 它**沒做**的：不解自我死鎖、不取代 S14——調大 `max` 只把門檻往上推（spec §15 第 17 條）。
 * `pool.on("error")` **收不到**借連線逾時（只在閒置 client 出錯時觸發），別在那裡找這個訊號。
 */
export function createPool(config: Pick<AppConfig, "databaseUrl" | "databasePoolMax" | "databasePoolConnectionTimeoutMs">): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs,
  });
}
