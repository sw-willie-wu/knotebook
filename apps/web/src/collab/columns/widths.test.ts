import { describe, expect, it } from "vitest";
import { canonicalColumnsLine, columnOpenTag } from "@knotebook/shared";
import {
  addColumnWidths,
  changedIndices,
  dividerResize,
  equalHeightWidths,
  expandColumnPixels,
  ratiosFromPixels,
} from "./widths";

const sumCents = (r: readonly number[]) => Math.round(r.reduce((a, b) => a + b, 0) * 100);
/** 兩位小數：值等於 `Math.round(v*100)/100` 產生的那個 double（`v*100` 本身不一定是整數，例如 1.1*100）。 */
const isTwoDecimals = (v: number) => Math.round(v * 100) / 100 === v;

describe("W1 ratiosFromPixels", () => {
  it("W1 總和＝欄數、每值兩位小數、在 [0.1,10]", () => {
    for (const px of [[100, 300], [96, 2000], [1, 1, 1], [333, 333, 334, 1]]) {
      const r = ratiosFromPixels(px);
      expect(sumCents(r)).toBe(px.length * 100);
      for (const v of r) {
        expect(v).toBeGreaterThanOrEqual(0.1);
        expect(v).toBeLessThanOrEqual(10);
        expect(isTwoDecimals(v)).toBe(true);
      }
    }
  });

  it("W1 極端：[96, 2000] → 第 1 欄夾在 0.1", () => expect(ratiosFromPixels([96, 2000])[0]).toBeCloseTo(0.1, 5));

  // 總和 533 不整除，多數 d 會產生捨入差；第 3 欄不在 changed 裡，捨入差只能落在第 1／2 欄，第 3 欄恆為 3×333/533 ≈ 1.874 → 1.87。
  it("W1 changed：[100+d|100−d|333] 只改第 1／2 欄，窮舉 d=-40..40，第 3 欄一律 1.87、捨入差只落在第 1／2 欄", () => {
    let nonzero = 0;
    for (let d = -40; d <= 40; d++) {
      const px = [100 + d, 100 - d, 333];
      const s = px.reduce((a, b) => a + b, 0);
      if (px.reduce((a, p) => a + Math.round((3 * p * 100) / s), 0) !== 300) nonzero++; // 前提：這組會產生捨入差
      const r = ratiosFromPixels(px, [0, 1]);
      expect(r[2]).toBe(1.87);
      expect(sumCents(r)).toBe(300);
    }
    expect(nonzero).toBeGreaterThan(0); // 防空真
  });

  it("W1 捨入差給 changed 裡捨入後值最大的那欄，同值取 index 小者", () => {
    // [1,1,1]：各 1，沒有捨入差。[2,2,2,1]：4×2/7=1.142857 → 1.14 ×3、0.571 → 0.57，總和 3.99，差 +0.01 給第 1 欄（同值取小 index）。
    expect(ratiosFromPixels([2, 2, 2, 1])).toEqual([1.15, 1.14, 1.14, 0.57]);
    // changed＝[1, 2]：差落在第 2 欄（1.14 與 1.14 同值，取 index 小者）。
    expect(ratiosFromPixels([2, 2, 2, 1], [1, 2])).toEqual([1.14, 1.15, 1.14, 0.57]);
  });
});

/** 決定性亂數（mulberry32）：同一個種子永遠同一串。 */
function mulberry32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it("W2 每個輸出經 canonicalColumnsLine(columnOpenTag(w)) 非 null、且就是 w 本身（固定種子 1000 組）", () => {
  const rand = mulberry32(42);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const outputs: number[][] = [];
  for (let i = 0; i < 1000; i++) {
    const n = int(2, 4);
    const px = Array.from({ length: n }, () => int(1, 3000));
    const k = int(0, n - 2);
    outputs.push(ratiosFromPixels(px));
    outputs.push(ratiosFromPixels(px, [k, k + 1]));
    outputs.push(equalHeightWidths(px.map((p) => p / int(1, 3000)))!);
    outputs.push(addColumnWidths(ratiosFromPixels(px.slice(0, Math.max(1, n - 1))), int(0, n - 1)));
  }
  for (const out of outputs) {
    for (const w of out) expect(canonicalColumnsLine(columnOpenTag(w))).toEqual({ width: w });
  }
});

describe("W3 dividerResize", () => {
  it("W3 夾 [mL, pL+pR−mR]，總和不變", () => {
    expect(dividerResize(300, 300, 200, 200, -500)).toEqual([200, 400]);
    expect(dividerResize(300, 300, 200, 96, 500)).toEqual([504, 96]);
    expect(dividerResize(300, 300, 200, 200, 37)).toEqual([337, 263]);
  });
});

describe("W4 expandColumnPixels", () => {
  // 第 2、3 欄的餘裕 s = [200, 100]，扣 150 依 2:1 分攤。
  it("W4 依餘裕比例扣", () => expect(expandColumnPixels([300, 400, 300], [96, 200, 200], 0, 150)).toEqual({ px: [450, 300, 250], granted: 150 }));
  it("W4 need > 其他欄餘裕總和 → 只給得出餘裕", () =>
    expect(expandColumnPixels([300, 250], [96, 200], 0, 999)).toEqual({ px: [350, 200], granted: 50 }));
  it("W4 need ≤ 0 不動", () => expect(expandColumnPixels([300, 300], [96, 200], 0, -10)).toEqual({ px: [300, 300], granted: 0 }));
  it("W4 其他欄都在最小寬度 → 拖不動", () => expect(expandColumnPixels([300, 200], [96, 200], 0, 50)).toEqual({ px: [300, 200], granted: 0 }));
});

describe("W5 equalHeightWidths / addColumnWidths", () => {
  it("W5 欄寬 ∝ 寬高比", () => expect(equalHeightWidths([2, 1])).toEqual([1.33, 0.67]));
  it("W5 尺寸未知或不是正數 → null", () => {
    expect(equalHeightWidths([2, null])).toBeNull();
    expect(equalHeightWidths([2, 0])).toBeNull();
    expect(equalHeightWidths([2, -1])).toBeNull();
  });
  it("W5 [0.5|1.5] 在尾端加欄：新欄＝既有平均，既有比例不變 → [0.5|1.5|1]", () => expect(addColumnWidths([0.5, 1.5], 2)).toEqual([0.5, 1.5, 1]));
  it("W5 加在開頭：[1|3] → 新欄 2 插在第 1 欄、整列正規化", () => expect(addColumnWidths([1, 3], 0)).toEqual([1, 0.5, 1.5]));
});

describe("W6 changedIndices", () => {
  it("W6 只列出值不同的欄", () => {
    expect(changedIndices([1, 1, 1], [1.2, 0.8, 1])).toEqual([0, 1]);
    expect(changedIndices([0.5, 1.5], [0.5, 1.5])).toEqual([]);
  });
});
