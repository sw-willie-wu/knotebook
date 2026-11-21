import type { CSSProperties } from "react";
import { isCustomColor, type TagColor } from "@knotebook/shared";

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function parseHex(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => toLinear(v / 255)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function hueSaturation([r, g, b]: Rgb): [number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  if (d === 0) return [0, 0];
  const h = max === rr ? ((gg - bb) / d + 6) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  const l = (max + min) / 2;
  return [h * 60, d / (1 - Math.abs(2 * l - 1))];
}

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const MIN_CONTRAST = 4.5;

/**
 * Pill text for a custom background, from the background alone: a dark shade of its hue on a light background, a near-white tint on a dark one,
 * moved toward black or white until it reaches 4.5:1. Black or white is always enough: the worse of the two is still 4.58:1 where they cross.
 */
export function tagTextColor(background: string): string {
  const rgb = parseHex(background);
  const [h, s] = hueSaturation(rgb);
  const dark = contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff");
  const sat = Math.min(s, dark ? 0.6 : 0.3);
  for (let step = 0; step <= 16; step++) {
    const text = toHex(hsl(h, sat, dark ? 0.16 - step * 0.01 : 0.96 + step * 0.0025));
    if (contrastRatio(background, text) >= MIN_CONTRAST) return text;
  }
  return dark ? "#000000" : "#ffffff";
}

/** Inline variables for a custom color; presets get theirs from the `[data-tag-color]` rules in index.css. */
export function tagColorStyle(color: TagColor): CSSProperties | undefined {
  if (!isCustomColor(color)) return undefined;
  return { "--tag-bg": color, "--tag-fg": tagTextColor(color), "--tag-dot": color } as CSSProperties;
}
