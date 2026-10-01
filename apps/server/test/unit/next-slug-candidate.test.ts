import { describe, expect, it } from "vitest";
import { validateSlug } from "@knotebook/shared";
import { nextSlugCandidate } from "../../src/notes/slug.js";

describe("nextSlugCandidate（#175 §6.9：移動／轉移／建立共用的 -N 與重截 ≤60）", () => {
  it("n=1 回基底本身（不截）", () => {
    expect(nextSlugCandidate("meeting", 1)).toBe("meeting");
    const long = "a".repeat(100);
    expect(nextSlugCandidate(long, 1)).toBe(long);
  });
  it("n≥2 加 -N，總長 ≤60", () => {
    expect(nextSlugCandidate("meeting", 2)).toBe("meeting-2");
    expect(nextSlugCandidate("meeting", 21)).toBe("meeting-21");
  });
  it("RF1：100 字元自訂 slug 的 -2 候選 ≤60、以 -2 結尾、通過 validateSlug", () => {
    const c = nextSlugCandidate("b".repeat(100), 2);
    expect(Array.from(c).length).toBeLessThanOrEqual(60);
    expect(c.endsWith("-2")).toBe(true);
    expect(validateSlug(c)).toBeNull();
  });
  it("截斷點落在連字號上時去掉尾端連字號（不產生 --2）", () => {
    const base = `${"c".repeat(57)}-dddd`; // 前 58 字＝57 個 c＋'-'
    expect(nextSlugCandidate(base, 2)).toBe(`${"c".repeat(57)}-2`);
  });
  it("以 code point 計長（CJK 不被切半）", () => {
    const c = nextSlugCandidate("會".repeat(70), 3);
    expect(Array.from(c).length).toBe(60);
    expect(c.endsWith("-3")).toBe(true);
  });
});
