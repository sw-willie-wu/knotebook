import { describe, expect, it } from "vitest";
import { contrastRatio, tagColorStyle, tagTextColor } from "./tag-color-style";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const gray = (v: number) => `#${v.toString(16).padStart(2, "0").repeat(3)}`;

function hue(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

const NAMED = ["#ffffff", "#000000", "#f5d90a", "#a7f3d0", "#1e3a8a", "#e03e3e", "#ff7ab6", "#808080"];
// Where black and white text are equally far: relative luminance about 0.18. Grays and colors on both sides of it.
const NEAR_THRESHOLD = ["#757575", "#767676", "#777777", "#787878", "#e0423e", "#ff5c5c", "#00a0a0", "#00a2a2", "#d07000", "#7a7aff", "#8a8a2a", "#ff3fff", "#3a9a3a", "#a0784a"];

function spread(): string[] {
  const out: string[] = [];
  for (let v = 0; v <= 255; v++) out.push(gray(v));
  const steps = [0, 34, 68, 102, 136, 170, 204, 238, 255];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push(hex((r << 16) | (g << 8) | b));
  let seed = 12345;
  for (let i = 0; i < 3000; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    out.push(hex(seed % 0x1000000));
  }
  return out;
}

describe("tagTextColor", () => {
  it.each([...NAMED, ...NEAR_THRESHOLD])("text on %s is at least 4.5:1 and a #rrggbb", (bg) => {
    const text = tagTextColor(bg);
    expect(text).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("reaches 4.5:1 over every gray, a 9-step color cube and 3,000 more colors", () => {
    const failures = spread().filter((bg) => contrastRatio(tagTextColor(bg), bg) < 4.5);
    expect(failures).toEqual([]);
  });

  it("is dark on a light background and light on a dark one", () => {
    for (const bg of ["#ffffff", "#f5d90a", "#a7f3d0", "#ff7ab6"]) expect(contrastRatio(tagTextColor(bg), "#000000"), bg).toBeLessThan(2);
    for (const bg of ["#000000", "#1e3a8a", "#333333"]) expect(contrastRatio(tagTextColor(bg), "#ffffff"), bg).toBeLessThan(1.2);
  });

  it("keeps the hue of a colored background", () => {
    for (const bg of ["#f5d90a", "#a7f3d0", "#1e3a8a", "#e03e3e", "#ff7ab6"]) {
      const diff = Math.abs(hue(tagTextColor(bg)) - hue(bg));
      expect(Math.min(diff, 360 - diff), bg).toBeLessThanOrEqual(8);
    }
  });
});

describe("tagColorStyle", () => {
  it("sets background and dot to the color as given, and the derived text", () => {
    expect(tagColorStyle("#e03e3e")).toEqual({ "--tag-bg": "#e03e3e", "--tag-fg": tagTextColor("#e03e3e"), "--tag-dot": "#e03e3e" });
  });

  it("leaves presets to the stylesheet", () => {
    expect(tagColorStyle("red")).toBeUndefined();
  });
});
