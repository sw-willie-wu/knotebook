import { describe, expect, it } from "vitest";
import { safeTarget } from "../../src/lib/safe-target.js";

describe("safeTarget（稽核日誌用，只留 origin＋pathname）", () => {
  it("帶 userinfo → 帳密不得出現在結果裡", () => {
    const out = safeTarget("https://user:pass@evil.example.com/v1");
    expect(out).toBe("https://evil.example.com/v1");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("user");
  });
  it("帶 query／fragment → 去掉", () => {
    const out = safeTarget("https://example.com/v1?k=secret#frag");
    expect(out).toBe("https://example.com/v1");
    expect(out).not.toContain("secret");
  });
  it("非法網址 → undefined", () => {
    expect(safeTarget("not a url")).toBeUndefined();
    expect(safeTarget("")).toBeUndefined();
  });
});
