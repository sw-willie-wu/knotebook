import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TAG_COLORS } from "@knotebook/shared";

const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rawCss = readFileSync(`${process.cwd()}/src/index.css`, "utf8");

// The sidebar and tag row sit on --card; these are its resolved values (the dark one is the hex noted beside --card in index.css).
const CARD_LIGHT = "#ffffff";
const CARD_DARK = "#1a1d23";

type Rgb = [number, number, number];

function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match![1]!;
}

function token(rule: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(rule);
  expect(match, `missing ${name}`).not.toBeNull();
  return match![1]!.trim();
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexToLinear(hex: string): Rgb {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  return [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Rgb;
}

function toOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH hue in degrees and chroma. */
function hueChroma(rgb: Rgb): { hue: number; chroma: number } {
  const [, a, b] = toOklab(rgb);
  return { hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, b) };
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("tag colors", () => {
  it("assumes the card colors this test measures against", () => {
    expect(rawCss).toMatch(/--card: oklch\(1 0 0\); \/\* #ffffff \*\//);
    expect(rawCss).toMatch(/--card: oklch\(0\.230 0\.012 264\.3\); \/\* #1a1d23 \*\//);
  });

  it.each(TAG_COLORS)("defines --tag-dot, --tag-bg and --tag-fg for %s in light and under :root.dark", (color) => {
    for (const selector of [`[data-tag-color="${color}"]`, `:root.dark [data-tag-color="${color}"]`]) {
      const rule = body(selector);
      for (const name of ["--tag-dot", "--tag-bg", "--tag-fg"]) expect(rule, `${selector} ${name}`).toMatch(new RegExp(`${name}:\\s*\\S`));
    }
  });

  it.each(TAG_COLORS)("%s: pill text is at least 4.5:1 on its background and the dot at least 3:1 on the card, in both modes", (color) => {
    for (const [selector, cardHex] of [
      [`[data-tag-color="${color}"]`, CARD_LIGHT],
      [`:root.dark [data-tag-color="${color}"]`, CARD_DARK],
    ] as const) {
      const rule = body(selector);
      const card = hexToLinear(cardHex);
      const text = contrast(hexToLinear(token(rule, "--tag-fg")), hexToLinear(token(rule, "--tag-bg")));
      const dot = contrast(hexToLinear(token(rule, "--tag-dot")), card);
      expect(text, `${selector} text`).toBeGreaterThanOrEqual(4.5);
      expect(dot, `${selector} dot`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(TAG_COLORS)("%s: the pill background is distinguishable from the card", (color) => {
    // Light pastels (yellow, gray) sit near 1.14-1.18; dark tints must be clearly off the card.
    for (const [selector, cardHex, min] of [
      [`[data-tag-color="${color}"]`, CARD_LIGHT, 1.1],
      [`:root.dark [data-tag-color="${color}"]`, CARD_DARK, 1.2],
    ] as const) {
      const bg = hexToLinear(token(body(selector), "--tag-bg"));
      expect(contrast(bg, hexToLinear(cardHex)), selector).toBeGreaterThanOrEqual(min);
    }
  });

  it.each(TAG_COLORS)("%s: pill background and text keep the hue of the dot (no drift toward the card's blue)", (color) => {
    for (const selector of [`[data-tag-color="${color}"]`, `:root.dark [data-tag-color="${color}"]`]) {
      const rule = body(selector);
      const dot = hueChroma(hexToLinear(token(rule, "--tag-dot")));
      for (const name of ["--tag-bg", "--tag-fg"]) {
        const other = hueChroma(hexToLinear(token(rule, name)));
        // Near-neutral colors (gray, brown tints) have no stable hue to compare.
        if (dot.chroma < 0.03 || other.chroma < 0.015) continue;
        const diff = Math.abs(dot.hue - other.hue);
        expect(Math.min(diff, 360 - diff), `${selector} ${name}`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("covers no color outside TAG_COLORS", () => {
    const found = [...css.matchAll(/\[data-tag-color="([a-z]+)"\]/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(TAG_COLORS));
  });
});
