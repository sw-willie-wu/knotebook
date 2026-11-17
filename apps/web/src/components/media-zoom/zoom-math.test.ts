import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  PINCH_WHEEL_SENSITIVITY,
  WHEEL_SENSITIVITY,
  clampOffset,
  fitScale,
  fitView,
  panBy,
  toggleZoom,
  wheelFactor,
  zoomAt,
  type ZoomView,
} from "./zoom-math";

const VP = { width: 1000, height: 800 };
const BIG = { width: 2000, height: 1000 };

function hasNegZero(v: ZoomView): boolean {
  return [v.scale, v.offset.x, v.offset.y].some((n) => Object.is(n, -0));
}

describe("fitScale", () => {
  it("shrinks a wide image to the viewport width", () => {
    expect(fitScale(BIG, VP)).toBe(0.5);
  });
  it("never enlarges a small image", () => {
    expect(fitScale({ width: 200, height: 100 }, VP)).toBe(1);
  });
  it("is limited by height for a tall image", () => {
    expect(fitScale({ width: 1000, height: 4000 }, VP)).toBeCloseTo(0.2, 12);
  });
});

describe("fitView", () => {
  it("centers a shrunk image", () => {
    expect(fitView(BIG, VP)).toEqual({ scale: 0.5, offset: { x: 0, y: 150 } });
  });
  it("centers a small image at natural size", () => {
    expect(fitView({ width: 200, height: 100 }, VP)).toEqual({ scale: 1, offset: { x: 400, y: 350 } });
  });
});

describe("clampOffset", () => {
  const small = { width: 200, height: 100 };
  const sx = 200;
  it("keeps a small image inside the viewport", () => {
    expect(clampOffset({ x: -10, y: 0 }, 1, small, VP).x).toBe(0);
    expect(clampOffset({ x: VP.width - sx + 10, y: 0 }, 1, small, VP).x).toBe(VP.width - sx);
  });
  it("keeps a large image covering the viewport", () => {
    const sw = 4000;
    expect(clampOffset({ x: 10, y: 0 }, 2, BIG, VP).x).toBe(0);
    expect(clampOffset({ x: VP.width - sw - 10, y: 0 }, 2, BIG, VP).x).toBe(VP.width - sw);
  });
  it("never returns negative zero", () => {
    const r = clampOffset({ x: -0, y: -0 }, 2, BIG, VP);
    expect(Object.is(r.x, -0)).toBe(false);
    expect(Object.is(r.y, -0)).toBe(false);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the anchor fixed", () => {
    const start = fitView(BIG, VP);
    const anchor = { x: 300, y: 400 };
    const next = zoomAt(start, 1, anchor, BIG, VP);
    expect(next.scale).toBe(1);
    const before = { x: (anchor.x - start.offset.x) / start.scale, y: (anchor.y - start.offset.y) / start.scale };
    const after = { x: (anchor.x - next.offset.x) / next.scale, y: (anchor.y - next.offset.y) / next.scale };
    expect(Math.abs(before.x - after.x)).toBeLessThan(1e-9);
    expect(Math.abs(before.y - after.y)).toBeLessThan(1e-9);
  });
  it("clamps the upper bound", () => {
    expect(zoomAt(fitView(BIG, VP), 100, { x: 0, y: 0 }, BIG, VP).scale).toBe(MAX_ZOOM);
  });
  it("clamps the lower bound to the fit scale", () => {
    expect(zoomAt(fitView(BIG, VP), 0.01, { x: 0, y: 0 }, BIG, VP).scale).toBe(0.5);
  });
  it("produces no negative zero", () => {
    const start: ZoomView = { scale: 0.5, offset: { x: -0, y: -0 } };
    expect(hasNegZero(zoomAt(start, 1, { x: -0, y: -0 }, BIG, VP))).toBe(false);
  });
});

describe("panBy", () => {
  const zoomed = zoomAt(fitView(BIG, VP), 2, { x: 500, y: 400 }, BIG, VP);
  it("stops at the left/top edge", () => {
    expect(panBy(zoomed, 5000, 0, BIG, VP).offset.x).toBe(0);
  });
  it("stops at the right edge", () => {
    expect(panBy(zoomed, -99999, 0, BIG, VP).offset.x).toBe(1000 - 2000 * 2);
  });
});

describe("toggleZoom", () => {
  it("zooms a fitted image to 1", () => {
    expect(toggleZoom(fitView(BIG, VP), { x: 500, y: 400 }, BIG, VP).scale).toBe(1);
  });
  it("zooms a small fitted image to 2", () => {
    const small = { width: 200, height: 100 };
    expect(toggleZoom(fitView(small, VP), { x: 500, y: 400 }, small, VP).scale).toBe(2);
  });
  it("returns to fit when already zoomed", () => {
    const zoomed: ZoomView = { scale: 3, offset: { x: -100, y: -100 } };
    expect(toggleZoom(zoomed, { x: 10, y: 10 }, BIG, VP)).toEqual(fitView(BIG, VP));
  });
});

describe("wheelFactor", () => {
  it("converts pixel deltas with the wheel sensitivity", () => {
    expect(WHEEL_SENSITIVITY).toBe(0.002);
    expect(wheelFactor(-100, 0, false, 800)).toBeCloseTo(Math.exp(0.2), 12);
  });
  it("treats line mode as 16 px per line", () => {
    expect(wheelFactor(-3, 1, false, 800)).toBeCloseTo(wheelFactor(-48, 0, false, 800), 12);
  });
  it("treats page mode as the viewport height", () => {
    expect(wheelFactor(-1, 2, false, 800)).toBeCloseTo(wheelFactor(-800, 0, false, 800), 12);
  });
  it("uses the pinch sensitivity with ctrl", () => {
    expect(PINCH_WHEEL_SENSITIVITY).toBe(0.01);
    expect(wheelFactor(-100, 0, true, 800)).toBeCloseTo(Math.exp(1), 12);
  });
});

describe("invalid input", () => {
  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("rejects size %s", (n) => {
    expect(() => fitScale({ width: n, height: 10 }, VP)).toThrow(RangeError);
    expect(() => fitScale(BIG, { width: 10, height: n })).toThrow(RangeError);
    expect(() => fitView({ width: 10, height: n }, VP)).toThrow(RangeError);
    expect(() => clampOffset({ x: 0, y: 0 }, n, BIG, VP)).toThrow(RangeError);
    expect(() => zoomAt({ scale: 1, offset: { x: 0, y: 0 } }, n, { x: 0, y: 0 }, BIG, VP)).toThrow(RangeError);
  });
});
