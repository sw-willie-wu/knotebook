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
 */

interface FailureRecord {
  failureCount: number;
  lastFailureTime: number;
}

const MAX_BACKOFF_SECONDS = 900; // 15 minutes

export class LoginThrottle {
  private accountFailures = new Map<string, FailureRecord>();
  private ipFailures = new Map<string, FailureRecord>();
  private now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Check if a login attempt is allowed for the given account and IP
   */
  checkAllowed(account: string, ip: string): {
    allowed: boolean;
    retryAfterMs?: number;
  } {
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
  recordFailure(account: string, ip: string): void {
    const currentTime = this.now();

    // Update account record
    const accountRecord = this.accountFailures.get(account);
    if (accountRecord) {
      accountRecord.failureCount += 1;
      accountRecord.lastFailureTime = currentTime;
    } else {
      this.accountFailures.set(account, {
        failureCount: 1,
        lastFailureTime: currentTime,
      });
    }

    // Update IP record
    const ipRecord = this.ipFailures.get(ip);
    if (ipRecord) {
      ipRecord.failureCount += 1;
      ipRecord.lastFailureTime = currentTime;
    } else {
      this.ipFailures.set(ip, {
        failureCount: 1,
        lastFailureTime: currentTime,
      });
    }
  }

  /**
   * Record a success for the given account (clears only account counter, not IP)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordSuccess(account: string, _ip: string): void {
    this.accountFailures.delete(account);
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
    map: Map<string, FailureRecord>,
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
