/**
 * #132：PKCE S256 驗證（`oauth/pkce.ts`）。「長度不等先 false」是承重性質——
 * `timingSafeEqual` 對長度不同的 Buffer 會**丟例外**，不是回 false。
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPkce } from "../../src/oauth/pkce.js";

describe("verifyPkce", () => {
  it("正確的 verifier 通過", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("錯的 verifier 不通過", () => {
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    expect(verifyPkce(randomBytes(32).toString("base64url"), challenge)).toBe(false);
  });

  // 承重案：拿掉長度預檢的話這裡會 throw，不是回 false
  it("長度不同的 challenge 回 false 而不是丟例外", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(() => verifyPkce(verifier, "short")).not.toThrow();
    expect(verifyPkce(verifier, "short")).toBe(false);
  });

  // base64 標準形（含 +/=）與 base64url 是不同字串——client 送錯編碼要拒，不能寬鬆比對
  it("challenge 用 base64（非 url-safe）編碼 → 不通過", () => {
    const verifier = randomBytes(32).toString("base64url");
    const std = createHash("sha256").update(verifier).digest("base64");
    const url = createHash("sha256").update(verifier).digest("base64url");
    if (std !== url) expect(verifyPkce(verifier, std)).toBe(false);
  });
});
