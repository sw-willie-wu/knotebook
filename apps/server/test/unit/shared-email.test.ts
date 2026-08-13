import { describe, it, expect } from "vitest";
import { normalizeEmail } from "@knotebook/shared";

describe("normalizeEmail", () => {
  it("trim 前後空白", () => {
    expect(normalizeEmail("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("大寫 → 小寫", () => {
    expect(normalizeEmail("AliCE@Example.COM")).toBe("alice@example.com");
  });

  it("已正規化的輸入 → 冪等（不變）", () => {
    expect(normalizeEmail("alice@example.com")).toBe("alice@example.com");
  });
});
