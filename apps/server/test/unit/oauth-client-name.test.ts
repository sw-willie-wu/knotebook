/**
 * #132：`client_name` 的黑名單（§5.2）。這是 D10（loopback-only）之外唯一的釣魚防線——
 * 擋的是能把同意頁那行「名稱未經驗證」旁註在視覺上推走的字元。
 */
import { describe, expect, it } from "vitest";
import { hasUnsafeClientNameChar } from "../../src/oauth/client-name.js";

// 碼位一律用 String.fromCodePoint 組字：直接把字元貼進原始碼會在編輯/搬運時失真。
const cp = (code: number): string => String.fromCodePoint(code);

describe("hasUnsafeClientNameChar（同意頁的視覺防線）", () => {
  it("放行一般名稱（含 CJK 與 emoji）", () => {
    expect(hasUnsafeClientNameChar("Claude Code")).toBe(false);
    expect(hasUnsafeClientNameChar("我的腳本 v2")).toBe(false);
    expect(hasUnsafeClientNameChar("tool 🛠")).toBe(false);
  });

  it("擋 C0／C1 控制字元", () => {
    expect(hasUnsafeClientNameChar(`a${cp(0x0a)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x00)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x1f)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x7f)}b`)).toBe(true);
    expect(hasUnsafeClientNameChar(`a${cp(0x9f)}b`)).toBe(true);
  });

  it("擋 bidi 覆寫、零寬與行分隔字元", () => {
    for (const code of [0x061c, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      expect(hasUnsafeClientNameChar(`app${cp(code)}name`), code.toString(16)).toBe(true);
    }
  });

  // 邊界外一格都不能擋——擋過頭會讓合法名稱莫名被拒，而且沒人查得出原因
  it("不擋緊鄰黑名單邊界的合法碼位", () => {
    for (const code of [0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0x20, 0xa0]) {
      expect(hasUnsafeClientNameChar(`app${cp(code)}name`), code.toString(16)).toBe(false);
    }
  });

  it("空字串沒有不安全字元（長度由 zod 另外管）", () => {
    expect(hasUnsafeClientNameChar("")).toBe(false);
  });
});
