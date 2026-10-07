import { describe, expect, it } from "vitest";
import { canUnlinkIdentity, usableIdentityIds } from "../../src/auth/sign-in-methods.js";

describe("usableIdentityIds（effective issuer 精確相等）", () => {
  it("只收 issuer 等於某個啟用中 provider 的 effective issuer 者；尾斜線不同就不算（寬鬆比對只用在 B14 排除）", () => {
    const ids = usableIdentityIds(
      [{ id: "a", issuer: "https://a.example" }, { id: "b", issuer: "https://b.example" }, { id: "c", issuer: "https://c.example/" }],
      [{ effectiveIssuer: "https://a.example" }, { effectiveIssuer: "https://c.example" }],
    );
    expect([...ids]).toEqual(["a"]);
  });
});

describe("canUnlinkIdentity（INV-7，B24：密碼只在 DB 值為真時算數）", () => {
  const set = (...ids: string[]) => new Set(ids);
  it.each([
    // [hasPassword, dbValue, usable, target, expected]
    [true, true, set(), "x", true],
    [true, false, set("x"), "x", false],
    [true, false, set("x", "y"), "x", true],
    [false, true, set("x"), "x", false],
    [false, true, set("x", "y"), "x", true],
    [false, true, set("y"), "x", true],
    [false, false, set(), "x", false],
  ] as const)("密碼=%s、DB=%s、可用=%o、解除 %s → %s", (hasPassword, passwordLoginDbValue, usable, target, expected) => {
    expect(canUnlinkIdentity(target, { hasPassword, passwordLoginDbValue, usableIdentityIds: usable })).toBe(expected);
  });
});
