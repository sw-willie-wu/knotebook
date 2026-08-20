/**
 * 固定視窗（fixed window）節流器，供 per-user API 節流用（collab-token、slug PATCH，
 * spec §5/§11.4）。與 `auth/rate-limit.ts` 的 `LoginThrottle`（帳號+IP 雙軌、指數退避）
 * 是兩套不同語意，不共用實作：這裡只要「每個 key 在固定長度的視窗內最多 N 次」。
 *
 * **生產預設值唯一真相來源**：`buildApp`（未收到 `AppDeps.limiters` 時的內建預設）與
 * `test/helpers.ts`（`buildTestApp`/`buildCollabTestApp` 注入的每次全新實例）都從這裡
 * 匯出的 `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT` 取值，不各自重複寫一份數字字面量。
 */
import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";

export const COLLAB_TOKEN_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const SLUG_PATCH_LIMIT = { limit: 10, windowMs: 600_000 } as const;
/** Plan 3 Task 10b：`POST /api/notes/:id/uploads` 節流（key=userId，同 collabToken/slugPatch 慣例）。 */
export const UPLOAD_LIMIT = { limit: 120, windowMs: 600_000 } as const;
/** Plan 4 Task 5：`POST /api/ai` 節流（key=userId，同 collabToken/slugPatch/upload 慣例）。 */
export const AI_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/**
 * Plan 5 Task 8：OIDC 端點的節流額度（key=request.ip——這兩條路由發生在登入之前，無
 * userId 可用；比照 AI_LIMIT 的數值與視窗長度）。
 *
 * ⚠ **login 與 callback 各自一個 `FixedWindowLimiter` 實例，不共用**（issue #16）：一次
 * 完整的 SSO 登入必定先 login 再 callback，兩者共用一個 bucket 的話等於每次登入吃掉
 * 兩份額度，實際可用次數只有標稱的一半（共用出口 IP 的辦公室網路更早撞到）。
 * 兩者用同一組數值，但計數彼此獨立。
 */
export const OIDC_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export interface FixedWindowLimiterOptions {
  limit: number;
  windowMs: number;
  /** 視窗登記表的 key 上限，插入序淘汰最舊。預設 `DEFAULT_MAX_KEYS`。 */
  maxKeys?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

/**
 * `consume(key)`：每次呼叫「必計數」——即使已超限，這次呼叫仍會讓計數 +1（不是只在
 * 未超限時才累加），回傳值只反映「這次呼叫本身有沒有落在限額內」。
 *
 * 視窗滾動：每個 key 各自獨立的固定視窗（非 sliding window）——`now - windowStart >=
 * windowMs` 即視為進入新視窗，計數歸零重算，不做「前一視窗按比例扣打」那種平滑處理。
 *
 * maxKeys 淘汰：交給共用的 `BoundedMap`（插入序淘汰）。只有「這個 key 開新視窗」時
 * 才會 `set()` 而移到尾端，純粹計數不觸發重排；超過上限時砍最久沒開過新視窗的
 * 那個 key。`auth/rate-limit.ts` 的 `LoginThrottle` 與 `auth/session.ts` 的 `UserGate`
 * 用的是同一個型別（issue #15）。
 */
export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly windows: BoundedMap<Window>;

  constructor(opts: FixedWindowLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.windows = new BoundedMap<Window>(opts.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  consume(key: string): boolean {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.windowStart >= this.windowMs) {
      // 開新視窗（cache miss 或前一視窗已過期）：`BoundedMap.set` 負責把這個 key
      // 移到尾端並在必要時砍掉最舊的一筆。
      window = { windowStart: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.limit;
  }
}
