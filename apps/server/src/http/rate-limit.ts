/**
 * 固定視窗（fixed window）節流器，供 per-user API 節流用（collab-token、slug PATCH，
 * spec §5/§11.4）。與 `auth/rate-limit.ts` 的 `LoginThrottle`（帳號+IP 雙軌、指數退避）
 * 是兩套不同語意，不共用實作：這裡只要「每個 key 在固定長度的視窗內最多 N 次」。
 *
 * **生產預設值唯一真相來源**：`buildApp`（未收到 `AppDeps.limiters` 時的內建預設）與
 * `test/helpers.ts`（`buildTestApp`/`buildCollabTestApp` 注入的每次全新實例）都從這裡
 * 匯出的 `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT` 取值，不各自重複寫一份數字字面量。
 */
export const COLLAB_TOKEN_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const SLUG_PATCH_LIMIT = { limit: 10, windowMs: 600_000 } as const;
/** Plan 3 Task 10b：`POST /api/notes/:id/uploads` 節流（key=userId，同 collabToken/slugPatch 慣例）。 */
export const UPLOAD_LIMIT = { limit: 120, windowMs: 600_000 } as const;
/** Plan 4 Task 5：`POST /api/ai` 節流（key=userId，同 collabToken/slugPatch/upload 慣例）。 */
export const AI_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/** Plan 5 Task 8：`GET /api/auth/oidc/login` 節流（key=request.ip——這條路由發生在登入
 * 之前，無 userId 可用；比照 AI_LIMIT 的數值與視窗長度）。 */
export const OIDC_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export interface FixedWindowLimiterOptions {
  limit: number;
  windowMs: number;
  /** 視窗登記表的 key 上限，插入序淘汰最舊。預設 10_000（見 class 註解）。 */
  maxKeys?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * `consume(key)`：每次呼叫「必計數」——即使已超限，這次呼叫仍會讓計數 +1（不是只在
 * 未超限時才累加），回傳值只反映「這次呼叫本身有沒有落在限額內」。
 *
 * 視窗滾動：每個 key 各自獨立的固定視窗（非 sliding window）——`now - windowStart >=
 * windowMs` 即視為進入新視窗，計數歸零重算，不做「前一視窗按比例扣打」那種平滑處理。
 *
 * maxKeys 淘汰：比照 `auth/session.ts` 的 `UserGate.store`——插入序淘汰（Map 迭代順序
 * 即插入序），只有「這個 key 開新視窗」時才會被重新插入而移到尾端；純粹計數不觸發
 * 重排。超過上限時砍最前面（最久沒開過新視窗）的那個 key。
 */
export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, Window>();

  constructor(opts: FixedWindowLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  consume(key: string): boolean {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.windowStart >= this.windowMs) {
      // 開新視窗（cache miss 或前一視窗已過期）：先刪除舊登記（若有）再重新 set，
      // 讓這個 key 移到 Map 迭代順序的尾端，維持「最舊的在最前面」。
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) this.windows.delete(oldestKey);
      }
      window = { windowStart: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.limit;
  }
}
