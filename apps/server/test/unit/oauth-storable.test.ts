/**
 * #132：無認證端點的字串落庫前的字元關（`oauth/storable.ts`）。
 * NUL 與落單代理在 PG 是硬錯（text 22021／jsonb 22P05），不擋就是任何人打得出的 500。
 */
import { describe, expect, it } from "vitest";
import { hasUnstorableChar } from "../../src/oauth/storable.js";

describe("hasUnstorableChar", () => {
  it("擋 NUL 與落單代理（高位、低位皆是）", () => {
    expect(hasUnstorableChar("a\u0000b")).toBe(true);
    expect(hasUnstorableChar("a\uD800b")).toBe(true);
    expect(hasUnstorableChar("a\uDC00b")).toBe(true);
  });

  it("放行成對代理與一般字元（誤擋會讓合法名稱莫名被拒）", () => {
    expect(hasUnstorableChar("plain")).toBe(false);
    expect(hasUnstorableChar("筆記")).toBe(false);
    expect(hasUnstorableChar("emoji \u{1F600}")).toBe(false);
    expect(hasUnstorableChar("\u{10FFFF}")).toBe(false);
    // 其他控制字元 PG 收得下，不在這一關的職責內
    expect(hasUnstorableChar("a\u0001b")).toBe(false);
    expect(hasUnstorableChar("")).toBe(false);
  });
});
