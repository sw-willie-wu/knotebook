import { describe, expect, it } from "vitest";
import { centeredCrop, clampOffset, cropToView, maxScale, minScale, viewToCrop, zoomAround } from "./crop-math";

const V = 280;

describe("minScale", () => {
  it("短邊剛好填滿視窗：橫圖、直圖、正方形", () => {
    expect(minScale(4000, 3000, V)).toBeCloseTo(V / 3000, 10);
    expect(minScale(3000, 4000, V)).toBeCloseTo(V / 3000, 10);
    expect(minScale(1000, 1000, V)).toBeCloseTo(V / 1000, 10);
  });
  it("極窄、極寬、1×1 也成立", () => {
    expect(minScale(5000, 1, V)).toBe(V);
    expect(minScale(1, 5000, V)).toBe(V);
    expect(minScale(1, 1, V)).toBe(V);
  });
  it("尺寸不是正有限數 → 丟 RangeError", () => {
    expect(() => minScale(0, 100, V)).toThrow(RangeError);
    expect(() => minScale(100, Number.NaN, V)).toThrow(RangeError);
    expect(() => minScale(100, -5, V)).toThrow(RangeError);
  });
});

describe("maxScale", () => {
  it("取「原圖 1 px 對 4 視窗 px」與「最小縮放 8 倍」的小者", () => {
    // minScale = 280/3000，8 倍約 0.747，小於 4
    expect(maxScale(4000, 3000, V)).toBeCloseTo(8 * (V / 3000), 10);
    // minScale = 2.8，8 倍 = 22.4，大於 4
    expect(maxScale(100, 100, V)).toBe(4);
  });
  it("永遠不小於最小縮放（原圖比視窗小很多時）", () => {
    expect(maxScale(1, 1, V)).toBe(minScale(1, 1, V));
    expect(maxScale(50, 90, V)).toBeGreaterThanOrEqual(minScale(50, 90, V));
  });
});

describe("clampOffset", () => {
  const scale = 0.2; // 4000×3000 → 800×600，大於視窗 280
  it("四個方向都夾在 [視窗 − 圖寬高, 0]", () => {
    expect(clampOffset({ x: 50, y: 50 }, scale, 4000, 3000, V)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: -9999, y: -9999 }, scale, 4000, 3000, V)).toEqual({ x: V - 800, y: V - 600 });
    expect(clampOffset({ x: -100, y: -100 }, scale, 4000, 3000, V)).toEqual({ x: -100, y: -100 });
  });
  it("縮放後再夾：縮小後原本合法的 offset 會超界", () => {
    const before = clampOffset({ x: -500, y: -300 }, scale, 4000, 3000, V);
    expect(before).toEqual({ x: -500, y: -300 });
    expect(clampOffset(before, 0.1, 4000, 3000, V)).toEqual({ x: V - 400, y: V - 300 });
  });
  it("圖在某軸比視窗小（不該發生）時不拋錯，貼齊 0", () => {
    expect(clampOffset({ x: -10, y: 30 }, 0.01, 100, 100, V)).toEqual({ x: 0, y: 0 });
  });
});

describe("zoomAround", () => {
  const w = 4000;
  const h = 3000;
  const lo = minScale(w, h, V);
  const start = { scale: lo, offset: { x: -((w * lo - V) / 2), y: 0 } };
  it("錨點下的原圖座標放大前後不變", () => {
    const anchor = { x: 100, y: 200 };
    const next = zoomAround(start, 0.4, anchor, w, h, V);
    const before = { x: (anchor.x - start.offset.x) / start.scale, y: (anchor.y - start.offset.y) / start.scale };
    const after = { x: (anchor.x - next.offset.x) / next.scale, y: (anchor.y - next.offset.y) / next.scale };
    expect(next.scale).toBe(0.4);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it("縮放夾在上下限", () => {
    const anchor = { x: V / 2, y: V / 2 };
    expect(zoomAround(start, 0.0001, anchor, w, h, V).scale).toBe(minScale(w, h, V));
    expect(zoomAround(start, 999, anchor, w, h, V).scale).toBe(maxScale(w, h, V));
  });
  it("結果 offset 已夾在圖內", () => {
    const next = zoomAround(start, 0.5, { x: 0, y: 0 }, w, h, V);
    expect(next.offset).toEqual(clampOffset(next.offset, next.scale, w, h, V));
    const out = zoomAround({ scale: 0.5, offset: { x: -1000, y: -700 } }, lo, { x: V, y: V }, w, h, V);
    expect(out.offset).toEqual(clampOffset(out.offset, out.scale, w, h, V));
  });
});

describe("viewToCrop", () => {
  it("輸出整數、size > 0、落在圖內", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [1234, 1234], [5000, 1], [1, 1], [97, 1013]] as const) {
      const lo = minScale(w, h, V);
      const hi = maxScale(w, h, V);
      for (const f of [0, 0.37, 0.5, 1]) {
        const scale = lo + (hi - lo) * f;
        for (const off of [{ x: 0, y: 0 }, { x: -1e9, y: -1e9 }, { x: -33.3, y: -71.9 }]) {
          const c = viewToCrop({ scale, offset: clampOffset(off, scale, w, h, V) }, w, h, V);
          expect(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.size)).toBe(true);
          expect(c.size).toBeGreaterThan(0);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.size).toBeLessThanOrEqual(w);
          expect(c.y + c.size).toBeLessThanOrEqual(h);
        }
      }
    }
  });
  it("最小縮放置中 → 整個短邊", () => {
    const scale = minScale(4000, 3000, V);
    const offset = { x: -((4000 * scale - V) / 2), y: 0 };
    expect(viewToCrop({ scale, offset }, 4000, 3000, V)).toEqual({ x: 500, y: 0, size: 3000 });
  });
  it("非整數的 scale／offset 會被四捨五入成整數像素", () => {
    // size = 280 / 0.3 = 933.33…、x = 33.3 / 0.3 = 111
    expect(viewToCrop({ scale: 0.3, offset: { x: -33.3, y: -10.2 } }, 4000, 3000, V)).toEqual({ x: 111, y: 34, size: 933 });
  });
  it("1×1 → { 0, 0, 1 }", () => {
    expect(viewToCrop({ scale: V, offset: { x: 0, y: 0 } }, 1, 1, V)).toEqual({ x: 0, y: 0, size: 1 });
  });
  it("傳沒夾過的 offset 也夾在圖內", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [97, 1013], [1, 1]] as const) {
      for (const scale of [minScale(w, h, V), maxScale(w, h, V)]) {
        for (const offset of [{ x: -1e9, y: -1e9 }, { x: 1e9, y: 1e9 }]) {
          const c = viewToCrop({ scale, offset }, w, h, V);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.size).toBeLessThanOrEqual(w);
          expect(c.y + c.size).toBeLessThanOrEqual(h);
        }
      }
    }
  });
  it("viewport 或 scale 不是正的有限數 → RangeError", () => {
    const ok = { scale: 0.5, offset: { x: 0, y: 0 } };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => viewToCrop(ok, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => viewToCrop({ ...ok, scale: bad }, 4000, 3000, V)).toThrow(RangeError);
      expect(() => minScale(4000, 3000, bad)).toThrow(RangeError);
      expect(() => maxScale(4000, 3000, bad)).toThrow(RangeError);
      expect(() => cropToView({ x: 0, y: 0, size: 100 }, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => zoomAround(ok, 1, { x: 0, y: 0 }, 4000, 3000, bad)).toThrow(RangeError);
      expect(() => zoomAround({ ...ok, scale: bad }, 1, { x: 0, y: 0 }, 4000, 3000, V)).toThrow(RangeError);
      expect(() => zoomAround(ok, bad, { x: 0, y: 0 }, 4000, 3000, V)).toThrow(RangeError);
    }
  });
  it("縮放略小於最小縮放（浮點誤差）使 size 超過短邊時，仍夾回圖內", () => {
    const c = viewToCrop({ scale: minScale(4000, 3000, V) * 0.9999, offset: { x: 0, y: 0 } }, 4000, 3000, V);
    expect(c.size).toBeLessThanOrEqual(3000);
    expect(c.x + c.size).toBeLessThanOrEqual(4000);
  });
});

describe("cropToView", () => {
  it("cropToView ∘ viewToCrop 往返誤差 ≤ 1 px", () => {
    const w = 4000;
    const h = 3000;
    for (const crop of [{ x: 500, y: 0, size: 3000 }, { x: 1234, y: 567, size: 800 }, { x: 3500, y: 2600, size: 400 }, { x: 0, y: 0, size: 3000 }]) {
      const back = viewToCrop(cropToView(crop, w, h, V), w, h, V);
      expect(Math.abs(back.x - crop.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.y - crop.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.size - crop.size)).toBeLessThanOrEqual(1);
    }
  });
  it("裁切比縮放上限更小時，scale 夾在上限、offset 仍在圖內", () => {
    const v = cropToView({ x: 10, y: 10, size: 2 }, 4000, 3000, V);
    expect(v.scale).toBe(maxScale(4000, 3000, V));
    expect(v.offset).toEqual(clampOffset(v.offset, v.scale, 4000, 3000, V));
  });
  it("超出圖的裁切（資料壞掉）也夾回圖內", () => {
    const v = cropToView({ x: 9999, y: 9999, size: 3000 }, 4000, 3000, V);
    expect(v.offset.x).toBeGreaterThanOrEqual(V - 4000 * v.scale);
    expect(v.offset.y).toBeGreaterThanOrEqual(V - 3000 * v.scale);
  });
});

describe("centeredCrop", () => {
  it("置中、取短邊", () => {
    expect(centeredCrop(4000, 3000)).toEqual({ x: 500, y: 0, size: 3000 });
    expect(centeredCrop(3000, 4000)).toEqual({ x: 0, y: 500, size: 3000 });
    expect(centeredCrop(800, 800)).toEqual({ x: 0, y: 0, size: 800 });
  });
  it("奇數差、極窄、1×1 仍是整數並落在圖內", () => {
    for (const [w, h] of [[1001, 1000], [5000, 1], [1, 5000], [1, 1], [3, 2]] as const) {
      const c = centeredCrop(w, h);
      expect(Number.isInteger(c.x) && Number.isInteger(c.y)).toBe(true);
      expect(c.size).toBe(Math.min(w, h));
      expect(c.x + c.size).toBeLessThanOrEqual(w);
      expect(c.y + c.size).toBeLessThanOrEqual(h);
    }
  });
});
