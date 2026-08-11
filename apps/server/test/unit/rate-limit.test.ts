import { describe, it, expect } from "vitest";
import { LoginThrottle } from "../../src/auth/rate-limit.js";
import { AI_LIMIT, FixedWindowLimiter } from "../../src/http/rate-limit.js";

describe("LoginThrottle", () => {
  describe("basic backoff mechanism", () => {
    it("4 次失敗後仍 allowed", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("第 5 次失敗後 blocked 且 retryAfterMs > 0", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("失敗次數遞增 → retryAfterMs 遞增", () => {
      const failureCounts = [5, 6, 7];
      const retryAfterTimes: number[] = [];

      for (const count of failureCounts) {
        const now = 1000;
        const throttle = new LoginThrottle({ now: () => now });
        for (let i = 0; i < count; i++) {
          throttle.recordFailure("user1", "192.168.1.1");
        }
        const result = throttle.checkAllowed("user1", "192.168.1.1");
        retryAfterTimes.push(result.retryAfterMs!);
      }

      // After 5 failures: 2^(5-4) = 2 seconds = 2000ms
      expect(retryAfterTimes[0]).toBe(2000);

      // After 6 failures: 2^(6-4) = 4 seconds = 4000ms
      expect(retryAfterTimes[1]).toBe(4000);

      // After 7 failures: 2^(7-4) = 8 seconds = 8000ms
      expect(retryAfterTimes[2]).toBe(8000);
    });
  });

  describe("failure count preservation (critical)", () => {
    it("計數不因退避窗過期而重置：5 次失敗 → 鎖 2s → 解封後 +1 次 → 應鎖 4s", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 5 failures at time 1000
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // At time 1000, should be blocked with 2000ms
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);

      // Advance time to 3001 (past the 2000ms backoff window)
      now = 3001;

      // checkAllowed should now return allowed (backoff expired)
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      // Record one more failure at time 3001 (6th failure)
      throttle.recordFailure("user1", "192.168.1.1");

      // checkAllowed at time 3001 should be blocked with 4000ms
      // (because 2^(6-4) = 4 seconds, lastFailureTime = 3001)
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(4000);
    });
  });

  describe("time-based unlocking with fake clock", () => {
    it("假時鐘前進超過退避窗 → allowed", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 5 failures at time 1000
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // At time 1000, should be blocked
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // Advance time beyond the backoff window
      now = 3001;

      // Should now be allowed
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("精確邊界測試：時鐘在 last+2000 時 allowed；last+1999 時 blocked", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // At 1000 + 1999 = 2999, still blocked
      now = 2999;
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(1);

      // At 1000 + 2000 = 3000, allowed (half-open: elapsedMs < backoffMs, not <=)
      now = 3000;
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();

      // At 1000 + 1999 = 2999 should still be blocked (for completeness)
      now = 2999;
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(1);
    });
  });

  describe("recordSuccess behavior", () => {
    it("recordSuccess 清除帳號計數，但保留 IP 計數", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 5 failures on account1 + IP1
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", "192.168.1.1");
      }

      // account1 on IP1 should be blocked
      let result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // Record success for account1
      throttle.recordSuccess("account1", "192.168.1.1");

      // account1 on IP1 should still be blocked (IP counter preserved)
      result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // But account1 on a different IP should be allowed (account counter cleared)
      result = throttle.checkAllowed("account1", "192.168.1.2");
      expect(result.allowed).toBe(true);

      // account2 on same IP1 should still be blocked (IP counter preserved)
      result = throttle.checkAllowed("account2", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("recordSuccess 後計數從零開始（在不同 IP），再失敗 4 次仍 allowed", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 5 failures on user1/IP1
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // Should be blocked on IP1
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // Record success
      throttle.recordSuccess("user1", "192.168.1.1");

      // Account counter cleared, so user1 on a different IP2 should be allowed
      result = throttle.checkAllowed("user1", "192.168.1.2");
      expect(result.allowed).toBe(true);

      // Can fail 4 more times on IP2 before blocking again
      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.2");
        result = throttle.checkAllowed("user1", "192.168.1.2");
        expect(result.allowed).toBe(true);
      }

      // 5th failure should block
      throttle.recordFailure("user1", "192.168.1.2");
      result = throttle.checkAllowed("user1", "192.168.1.2");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("無關帳號/IP 不受其他 recordSuccess 影響", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // user1 fails 5 times on IP1
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // user2 fails 5 times on IP2
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user2", "192.168.1.2");
      }

      // recordSuccess for user1/IP1
      throttle.recordSuccess("user1", "192.168.1.1");

      // user1 on IP1 should still be blocked (IP counter preserved)
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // user1 on a different IP3 should be allowed (account counter cleared)
      result = throttle.checkAllowed("user1", "192.168.1.3");
      expect(result.allowed).toBe(true);

      // user2/IP2 should still be blocked (unrelated)
      result = throttle.checkAllowed("user2", "192.168.1.2");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });

  describe("account and IP independence (take stricter)", () => {
    it("(a) 帳號在 5 個 IP 各失敗 1 次 → 乾淨 IP 也被帳號計數 blocked", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // account1 fails once on each of 5 different IPs
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", `192.168.1.${i}`);
      }

      // account1 on a clean IP (192.168.1.99) should still be blocked (帳號計數)
      const result = throttle.checkAllowed("account1", "192.168.1.99");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("(b) IP 被 5 個帳號各失敗 1 次 → 新帳號同 IP 也被 IP 計數 blocked", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // 5 different accounts fail once each on same IP
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure(`account${i}`, "192.168.1.1");
      }

      // New account on same IP should be blocked (IP 計數)
      const result = throttle.checkAllowed("newaccount", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });

    it("(c) 帳號和 IP 退避窗不同時 → retryAfterMs 應為較大值（精確）", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // account1 fails 5 times (retryAfterMs = 2000ms)
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("account1", "192.168.1.1");
      }

      // Advance time by 1500ms (both still locked, but IP more)
      now = 2500;

      // Record more failures on IP (from account2) to get 6 failures on IP (4000ms backoff)
      for (let i = 0; i < 1; i++) {
        throttle.recordFailure("account2", "192.168.1.1");
      }

      now = 2500;

      // Now account1 has 5 failures (last at 1000), IP has 6 failures (last at 2500)
      // account1 retryAfter: max(0, 2000 - 1500) = 500ms
      // IP retryAfter: max(0, 4000 - 0) = 4000ms
      // Should return max(500, 4000) = 4000ms
      const result = throttle.checkAllowed("account1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(4000);
    });
  });

  describe("backoff expiration cap", () => {
    it("退避上限：大量失敗後 retryAfterMs ≤ 15 分鐘（900000ms）", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 50 failures to exceed normal exponential backoff
      for (let i = 0; i < 50; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(900000);
    });

    it("精確上限驗證：第 14 次失敗後應達到 15 分鐘上限", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // 2^(14-4) = 2^10 = 1024 seconds > 900 seconds cap (n>=14 hits cap)
      for (let i = 0; i < 14; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(900000);
    });
  });

  describe("idle timeout cleanup", () => {
    it("記錄在超過 15 分鐘無新失敗後應被清理", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 5 failures at time 1000
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // Should be blocked
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);

      // Advance time by 15 minutes + 1ms
      now = 1000 + 900000 + 1;

      // checkAllowed should clean up the idle record and return allowed
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      // After cleanup, the next failure should start fresh (failureCount = 1)
      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
    });

    it("未達 5 次的記錄在 15 分鐘無新失敗後也應被清理", () => {
      let now = 1000;
      const throttle = new LoginThrottle({ now: () => now });

      // Record 3 failures
      for (let i = 0; i < 3; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }

      // Should be allowed (only 3 failures)
      let result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      // Advance time by 15 minutes + 1ms
      now = 1000 + 900000 + 1;

      // checkAllowed should clean up the idle record
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      // Verify record was cleaned by recording 1 failure and checking it's treated fresh
      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);

      // Verify it's actually fresh: 3 more failures should not block yet
      for (let i = 0; i < 3; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true); // Still have only 4 total

      // 5th failure should block
      throttle.recordFailure("user1", "192.168.1.1");
      result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });

  describe("edge cases", () => {
    it("checkAllowed 在無失敗時應返回 allowed=true", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("precise boundary: 第 4 次失敗後 checkAllowed 應返回 allowed=true", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      for (let i = 0; i < 4; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it("precise boundary: 第 5 次失敗後 checkAllowed 應返回 allowed=false 且 retryAfterMs=2000", () => {
      const now = 1000;
      const throttle = new LoginThrottle({ now: () => now });
      for (let i = 0; i < 5; i++) {
        throttle.recordFailure("user1", "192.168.1.1");
      }
      const result = throttle.checkAllowed("user1", "192.168.1.1");
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBe(2000);
    });
  });
});

// Plan 4 Task 5：POST /api/ai 節流參數形狀（比照 http/rate-limit.ts 其餘 *_LIMIT 匯出常數的
// 驗證慣例）——鎖住「每分鐘 30 次」這個具體數字，不讓它被無感改動。
describe("AI_LIMIT", () => {
  it("形狀：limit=30、windowMs=60_000（每分鐘 30 次）", () => {
    expect(AI_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it("套進 FixedWindowLimiter：30 次放行，第 31 次擋", () => {
    const limiter = new FixedWindowLimiter(AI_LIMIT);
    for (let i = 0; i < 30; i++) {
      expect(limiter.consume("user1")).toBe(true);
    }
    expect(limiter.consume("user1")).toBe(false);
  });

  it("不同 user 各自獨立計數", () => {
    const limiter = new FixedWindowLimiter(AI_LIMIT);
    for (let i = 0; i < 30; i++) limiter.consume("user1");
    expect(limiter.consume("user1")).toBe(false);
    expect(limiter.consume("user2")).toBe(true);
  });
});
