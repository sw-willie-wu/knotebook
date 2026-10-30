import { describe, expect, it } from "vitest";
import { SIZE_PX_MAX, SIZE_PX_MIN, clampSizePx, isSizePx } from "./note-sizes.js";

// spec 2026-10-21 columns-layout §11.1 I6：圖片寬度、表格欄寬一律 [32, 4000] 的整數 px。

describe("SZ1 clampSizePx：非有限數或 ≤ 0 → null；否則四捨五入後夾 [32, 4000]", () => {
  it.each<[number, number | null]>([
    [300, 300], [312.6, 313], [20, 32], [5000, 4000], [0, null], [-5, null], [NaN, null], [Infinity, null],
  ])("%s → %s", (n, expected) => {
    expect(clampSizePx(n)).toBe(expected);
  });

  it("範圍常數", () => {
    expect([SIZE_PX_MIN, SIZE_PX_MAX]).toEqual([32, 4000]);
  });
});

describe("SZ2 isSizePx：[32, 4000] 的十進位整數、無前導 0、無空白", () => {
  it.each(["32", "4000", "300"])("%j → true", s => {
    expect(isSizePx(s)).toBe(true);
  });
  it.each(["31", "4001", "0300", "300.5", " 300", "", "3e2"])("%j → false", s => {
    expect(isSizePx(s)).toBe(false);
  });
});
