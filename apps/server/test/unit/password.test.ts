import { describe, it, expect, beforeEach } from "vitest";
import { hashPassword, verifyPassword, HashBusyError, setHashConcurrency, DUMMY_HASH } from "../../src/auth/password.js";

describe("password service", () => {
  beforeEach(() => {
    setHashConcurrency(4);
  });

  it("hash/verify 往返", async () => {
    const h = await hashPassword("correct horse battery st");
    expect(await verifyPassword(h, "correct horse battery st")).toBe(true);
    expect(await verifyPassword(h, "wrong password here!!")).toBe(false);
  });

  it("argon2id 參數達標", async () => {
    const h = await hashPassword("correct horse battery st");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).toMatch(/m=19456,t=2,p=1/);
  });

  it("併發超限 throw HashBusyError 不排隊 (hash)", async () => {
    setHashConcurrency(2);
    const rs = await Promise.all(Array.from({ length: 6 }, () => hashPassword("x".repeat(16)).catch(e => e)));
    const errors = rs.filter(r => r instanceof HashBusyError);
    const successes = rs.filter(r => typeof r === "string");
    expect(errors.length).toBe(4);
    expect(successes.length).toBe(2);
    successes.forEach(h => {
      expect(h).toMatch(/^\$argon2id\$/);
    });
  });

  it("併發超限 throw HashBusyError 不排隊 (verify)", async () => {
    const h = await hashPassword("x".repeat(16));
    setHashConcurrency(2);
    const rs = await Promise.all(Array.from({ length: 6 }, () => verifyPassword(h, "x".repeat(16)).catch(e => e)));
    const errors = rs.filter(r => r instanceof HashBusyError);
    const successes = rs.filter(r => typeof r === "boolean");
    expect(errors.length).toBe(4);
    expect(successes.length).toBe(2);
    successes.forEach(result => {
      expect(result).toBe(true);
    });
  });

  it("釋放路徑測試 (hash): 限額滿後恢復正常", async () => {
    setHashConcurrency(1);
    // First call succeeds
    const h1 = await hashPassword("password1");
    expect(h1).toMatch(/^\$argon2id\$/);
    // Send 2 concurrent calls, 1 fails
    const rs = await Promise.allSettled([
      hashPassword("password2"),
      hashPassword("password3"),
    ]);
    expect(rs[0].status === "rejected" || rs[1].status === "rejected").toBe(true);
    // After errors, next call should succeed (counter released)
    const h2 = await hashPassword("password4");
    expect(h2).toMatch(/^\$argon2id\$/);
  });

  it("釋放路徑測試 (verify): argon2 異常也正確釋放", async () => {
    setHashConcurrency(1);
    const validHash = await hashPassword("password1");
    // Call verify with invalid hash (triggers argon2 error)
    const badResult = await verifyPassword("invalid-hash-format", "password");
    expect(badResult).toBe(false);
    // Next verify should succeed (counter released despite argon2 error)
    const goodResult = await verifyPassword(validHash, "password1");
    expect(goodResult).toBe(true);
  });

  it("共用計數器測試: hash 佔用 slot 導致 verify 被拒", async () => {
    setHashConcurrency(2);
    // Launch 1 hash + 5 verify concurrently
    // Hash and verify share same semaphore counter; sync dispatch means hash consumes 1 slot,
    // leaving only 1 slot for 5 verify calls, so at least 4 are rejected
    const hash1 = hashPassword("x".repeat(16));
    const verify1 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify2 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify3 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify4 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const verify5 = verifyPassword(DUMMY_HASH, "x".repeat(16));
    const results = await Promise.allSettled([hash1, verify1, verify2, verify3, verify4, verify5]);
    const rejectedCount = results.filter(r => r.status === "rejected").length;
    const verifyRejectedCount = results
      .slice(1) // skip hash result
      .filter(r => r.status === "rejected")
      .length;
    // With concurrency 2 and 1 hash + 5 verify, expect at least some verify to be rejected
    expect(verifyRejectedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBe(4); // 4 total rejected (3-4 verify)
  });

  it("setHashConcurrency 驗證輸入", async () => {
    expect(() => setHashConcurrency(NaN)).toThrow(RangeError);
    expect(() => setHashConcurrency(0)).toThrow(RangeError);
    expect(() => setHashConcurrency(-1)).toThrow(RangeError);
    expect(() => setHashConcurrency(1.5)).toThrow(RangeError);
    expect(() => setHashConcurrency(1)).not.toThrow();
  });

  it("verifyPassword 無效 hash 回傳 false 而非拋錯", async () => {
    const result = await verifyPassword("not-a-valid-hash-format", "any password");
    expect(result).toBe(false);
  });
});
