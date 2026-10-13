import { sql } from "drizzle-orm";
import { LAST_ACTIVE_WRITE_INTERVAL_MS } from "@knotebook/shared";
import type { Db } from "../db/index.js";

/** 節流表的預設上限（使用者數）：滿了先清過期項，仍滿就整張清空（見 `touch`）。 */
const DEFAULT_MAX_ENTRIES = 10_000;

/** 只用到 warn；Fastify logger 與 `CollabLogger` 都相容。 */
export interface LastActiveLogger {
  warn(obj: object, msg: string): void;
}

export interface LastActiveTrackerOptions {
  /** 節流表上限；測試用。 */
  maxEntries?: number;
  /** 節流表的時鐘（ms）；測試用。DB 那層一律用 DB 的 `now()`。 */
  now?: () => number;
}

/**
 * #267：記「最後活動」（`users.last_active_at = now()`）。呼叫點（每個 app 行程一份實例，REST 與共編共用，見 `createCollabServer`）：
 * - `app.ts` 的 `resolveSessionUser` 解出有效的 session cookie 後——`authenticate`／`requireAdmin` 與 `authenticateAny` 的 session 路徑
 *   都走那裡；bearer token（PAT／OAuth）不走，token 自有「最後使用」。
 * - 共編 WebSocket（`collab/server.ts`）：連線通過驗證（`connected`）時，與這條連線送來的文件變更（`onChange`，只算人的連線，
 *   AI／套用版本的直連不算）。共編 token 只能由 session 換得（`POST /api/notes/:id/collab-token` 是 session-only），所以這也是 session 活動。
 *
 * 同一使用者至多每 `LAST_ACTIVE_WRITE_INTERVAL_MS` 寫一次，兩層：
 * 1. 行程內節流表 `Map<userId, 上次嘗試的 ms>`：間隔內的呼叫不碰 DB（打字時每個變更都會呼叫，這層是主要的擋）。記的是「嘗試」不是
 *    「成功」——失敗或被 SKIP LOCKED 跳過的那次也要等滿間隔才再試，換來的是 DB 故障時不會每個請求都打一發。
 * 2. SQL 條件：`last_active_at` 是 NULL 或早於 `now() - 間隔` 才寫。多個 app 行程各有一張節流表，靠這層保底——同一使用者每個間隔
 *    每個行程最多嘗試一次、實際寫入通常只有最先到的那發。
 *
 * **永不等鎖的 best-effort**（同 `touchLastLogin`）：子查詢 `FOR NO KEY UPDATE SKIP LOCKED` 取列，該列正被別的交易鎖著時整句 0 列；
 * `touch` 自己吞掉所有錯誤（只記 warn）、回傳的 promise 永不 reject——REST 端 await 它不會讓請求失敗，共編端不 await 也不會出現未處理的 rejection。
 * `last_active_at` 不在 `UserDto` 裡，gate 快取不含它，不需 invalidate。
 */
export class LastActiveTracker {
  private readonly lastAttempt = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly log: LastActiveLogger,
    options: LastActiveTrackerOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** 節流表目前的項數（測試用）。 */
  get size(): number {
    return this.lastAttempt.size;
  }

  /** 節流表裡這位使用者上次嘗試寫入的時間（ms，節流表時鐘）；不在表裡回 undefined（測試用）。 */
  lastAttemptAt(userId: string): number | undefined {
    return this.lastAttempt.get(userId);
  }

  async touch(userId: string): Promise<void> {
    try {
      const now = this.now();
      const prev = this.lastAttempt.get(userId);
      if (prev !== undefined && now - prev < LAST_ACTIVE_WRITE_INTERVAL_MS) return;
      if (prev === undefined && this.lastAttempt.size >= this.maxEntries) this.prune(now);
      this.lastAttempt.set(userId, now);
      await this.db.execute(sql`
        update users set last_active_at = now()
         where id = (select id from users
                      where id = ${userId}
                        and (last_active_at is null or last_active_at < now() - make_interval(secs => ${LAST_ACTIVE_WRITE_INTERVAL_MS / 1000}))
                      for no key update skip locked)`);
    } catch (err) {
      this.log.warn({ err, userId }, "last_active_at 寫入失敗（不影響請求）");
    }
  }

  /** 已過間隔的項與「不在表裡」等價，先清它們；仍滿（間隔內的使用者超過上限）就整張清空——最壞多打幾發會被 SQL 條件擋下的 UPDATE。 */
  private prune(now: number): void {
    for (const [id, at] of this.lastAttempt) {
      if (now - at >= LAST_ACTIVE_WRITE_INTERVAL_MS) this.lastAttempt.delete(id);
    }
    if (this.lastAttempt.size >= this.maxEntries) this.lastAttempt.clear();
  }
}
