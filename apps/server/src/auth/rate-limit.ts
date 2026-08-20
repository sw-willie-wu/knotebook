/**
 * LoginThrottle: In-memory login rate limiting with exponential backoff
 *
 * After 5 consecutive failures, subsequent attempts are blocked with backoff windows
 * calculated as 2^(n-4) seconds, where n is the failure count, capped at 15 minutes.
 *
 * Account and IP counters are tracked independently, but checkAllowed returns blocked
 * if either counter indicates a block.
 *
 * recordSuccess clears only the account counter; IP counter decays through idle timeout
 * (no new failures for > 15 minutes).
 *
 * 兩軌紀錄都住在有上限的 `BoundedMap` 裡（issue #15）。原本是純 `Map`，只有「這次
 * 剛好碰到的 key 閒置超過 15 分鐘」才會被懶惰清掉——沒再被碰到的 key 永遠留著，
 * 大量不同帳號/IP 的嘗試會讓記憶體單向成長；隱居的 `FixedWindowLimiter` 實則早就有上限。
 *
 * 淘汰順序對得起語意：**每一次 `recordFailure` 都重寫那一筆紀錄**，於是它移到
 * `BoundedMap` 的尾端。被砍的永遠是「最久沒有新失敗」的那一筆——也就是最接近
 * 閒置過期、本來就快要被清掉的那一筆。要把一筆**封鎖中**的紀錄擠掉，攻擊者得先
 * 用 maxKeys 個「失敗時間更新」的 key 把它推到最前面，而那些 key 自己也都被記上了。
 */

import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";

interface FailureRecord {
  failureCount: number;
  lastFailureTime: number;
}

const MAX_BACKOFF_SECONDS = 900; // 15 minutes

/**
 * throttle key 的長度上限。key 直接來自請求：帳號軌是使用者送的 email（login 的 body
 * schema 刻意只驗 `z.string()`——加格式驗證會讓 400/401 變成「帳號存不存在」的 oracle，
 * 見 `routes/auth.ts`），IP 軌在 `trustProxy` 之下實質上是 `X-Forwarded-For` 的內容。兩者都是
 * 攻擊者可控的字串，Fastify 預設 bodyLimit 是 1 MiB —— 不截斷的話，「筆數有上限」換不到
 * 「位元組有上限」（`BoundedMap` 綁的是筆數）。
 *
 * 320 = RFC 5321 的 email 長度上限（254）再加餘裕：真實輸入永遠不會被截到，只有
 * 刻意灌長字串的請求會——而那些請求落在同一筆紀錄上正是我們要的。
 */
const MAX_KEY_LENGTH = 320;

const boundKey = (key: string): string => (key.length <= MAX_KEY_LENGTH ? key : key.slice(0, MAX_KEY_LENGTH));

export class LoginThrottle {
  private accountFailures: BoundedMap<FailureRecord>;
  private ipFailures: BoundedMap<FailureRecord>;
  private now: () => number;

  constructor(opts?: { now?: () => number; maxKeys?: number }) {
    this.now = opts?.now ?? (() => Date.now());
    const maxKeys = opts?.maxKeys ?? DEFAULT_MAX_KEYS;
    this.accountFailures = new BoundedMap<FailureRecord>(maxKeys);
    this.ipFailures = new BoundedMap<FailureRecord>(maxKeys);
  }

  /**
   * Check if a login attempt is allowed for the given account and IP
   */
  checkAllowed(rawAccount: string, rawIp: string): {
    allowed: boolean;
    retryAfterMs?: number;
  } {
    const account = boundKey(rawAccount);
    const ip = boundKey(rawIp);
    const currentTime = this.now();

    // Evaluate account and IP records
    const accountRetryAfterMs = this.evaluateRecord(
      this.accountFailures.get(account),
      currentTime
    );
    const ipRetryAfterMs = this.evaluateRecord(
      this.ipFailures.get(ip),
      currentTime
    );

    // Lazy cleanup: delete idle entries (no new failures for > max backoff window)
    this.cleanupIdleRecord(this.accountFailures, account, currentTime);
    this.cleanupIdleRecord(this.ipFailures, ip, currentTime);

    // Return blocked if either is blocked, with the longer retry window
    const accountBlocked = accountRetryAfterMs !== undefined;
    const ipBlocked = ipRetryAfterMs !== undefined;
    const blocked = accountBlocked || ipBlocked;

    if (blocked) {
      const retryAfterMs = Math.max(
        accountRetryAfterMs ?? 0,
        ipRetryAfterMs ?? 0
      );
      return {
        allowed: false,
        retryAfterMs,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a failure for the given account and IP
   */
  recordFailure(rawAccount: string, rawIp: string): void {
    const account = boundKey(rawAccount);
    const ip = boundKey(rawIp);
    const currentTime = this.now();

    // 一律走 set()（而不是就地改 record 的欄位）：這次失敗把這個 key 移到 BoundedMap
    // 尾端，淘汰順序才會是「最久沒有新失敗的先被砍」（見 class 註解）。
    this.accountFailures.set(account, {
      failureCount: (this.accountFailures.get(account)?.failureCount ?? 0) + 1,
      lastFailureTime: currentTime,
    });

    this.ipFailures.set(ip, {
      failureCount: (this.ipFailures.get(ip)?.failureCount ?? 0) + 1,
      lastFailureTime: currentTime,
    });
  }

  /**
   * Record a success for the given account (clears only account counter, not IP)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordSuccess(account: string, _ip: string): void {
    this.accountFailures.delete(boundKey(account));
    // Note: IP counter is NOT cleared, only decays through idle timeout
  }

  /**
   * Evaluate a record and return milliseconds until backoff window expires
   * Returns undefined if not blocked (window has passed or < 5 failures)
   * Returns the remaining milliseconds if blocked (elapsedMs < backoffMs)
   * Half-open interval: exactly at lastFailureTime + backoffMs is allowed
   */
  private evaluateRecord(
    record: FailureRecord | undefined,
    currentTime: number
  ): number | undefined {
    if (!record || record.failureCount < 5) {
      return undefined;
    }

    // Calculate backoff window in milliseconds
    const backoffMs = this.getBackoffMs(record.failureCount);

    // Calculate time elapsed since last failure
    const elapsedMs = currentTime - record.lastFailureTime;

    // Return remaining time if still within backoff window (half-open: < not <=)
    if (elapsedMs < backoffMs) {
      return Math.max(0, backoffMs - elapsedMs);
    }

    // Window has passed
    return undefined;
  }

  /**
   * Clean up idle records (no new failures for > max backoff window)
   */
  private cleanupIdleRecord(
    map: BoundedMap<FailureRecord>,
    key: string,
    currentTime: number
  ): void {
    const record = map.get(key);
    if (!record) {
      return;
    }

    // Delete if idle for > 15 minutes
    const idleMs = currentTime - record.lastFailureTime;
    if (idleMs > MAX_BACKOFF_SECONDS * 1000) {
      map.delete(key);
    }
  }

  /**
   * Calculate the backoff window in milliseconds: 2^(n-4) seconds, capped at 15 minutes
   */
  private getBackoffMs(failureCount: number): number {
    const exponent = failureCount - 4;
    const backoffSeconds = Math.pow(2, exponent);
    const cappedSeconds = Math.min(backoffSeconds, MAX_BACKOFF_SECONDS);
    return cappedSeconds * 1000;
  }
}
