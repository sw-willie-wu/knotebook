import type { Size } from "./zoom-math";

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function fromViewBox(svg: SVGSVGElement): Size | null {
  const raw = svg.getAttribute("viewBox");
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  const [, , width, height] = parts as [number, number, number, number];
  return positive(width) && positive(height) ? { width, height } : null;
}

/** A bare number or a `px` value; percentages and other units are not an intrinsic size. */
function pixelLength(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return positive(n) ? n : null;
}

/** The SVG's own size: `viewBox` first, then pixel `width`/`height`; `null` when neither says. */
export function svgIntrinsicSize(svg: SVGSVGElement): Size | null {
  const box = fromViewBox(svg);
  if (box) return box;
  const width = pixelLength(svg.getAttribute("width"));
  const height = pixelLength(svg.getAttribute("height"));
  return width !== null && height !== null ? { width, height } : null;
}
