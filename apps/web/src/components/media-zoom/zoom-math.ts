/**
 * Pure zoom/pan math for the media viewer.
 *
 * Coordinates: the content's top-left corner sits at `offset` in viewport
 * coordinates, and its displayed size is natural size × `scale`. `scale` is
 * measured against the natural pixels, so 1 means natural size.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ZoomView {
  scale: number;
  offset: Point;
}

export const MAX_ZOOM = 8;
/** Zoom exponent per pixel of a plain mouse wheel `deltaY`. */
export const WHEEL_SENSITIVITY = 0.002;
/** Zoom exponent per pixel of a ctrl+wheel event (trackpad pinch). */
export const PINCH_WHEEL_SENSITIVITY = 0.01;

const FIT_EPSILON = 1e-6;
const LINE_HEIGHT_PX = 16;

function assertSize(name: string, size: Size): void {
  const { width, height } = size;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`invalid ${name} size ${width}×${height}`);
  }
}

function assertScale(scale: number): void {
  if (!(Number.isFinite(scale) && scale > 0)) {
    throw new RangeError(`invalid scale ${scale}`);
  }
}

/** `x + 0` turns -0 into 0 and leaves every other number unchanged. */
function noNegZero(x: number): number {
  return x + 0;
}

function clampAxis(value: number, displayed: number, viewport: number): number {
  const edge = viewport - displayed;
  // Smaller than the viewport: stay inside it. Larger: keep it covered.
  const lo = Math.min(edge, 0);
  const hi = Math.max(edge, 0);
  return noNegZero(Math.min(hi, Math.max(lo, value)));
}

/** Largest scale at which the whole content fits the viewport; never above 1. */
export function fitScale(natural: Size, viewport: Size): number {
  assertSize("natural", natural);
  assertSize("viewport", viewport);
  return Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
}

/** The fitted view, centered in the viewport. */
export function fitView(natural: Size, viewport: Size): ZoomView {
  const scale = fitScale(natural, viewport);
  return {
    scale,
    offset: {
      x: noNegZero((viewport.width - natural.width * scale) / 2),
      y: noNegZero((viewport.height - natural.height * scale) / 2),
    },
  };
}

/**
 * Per axis: when the displayed size fits the viewport the offset range is
 * `[0, V - S]` (cannot be dragged out of view); otherwise `[V - S, 0]`
 * (the content keeps covering the viewport).
 */
export function clampOffset(offset: Point, scale: number, natural: Size, viewport: Size): Point {
  assertScale(scale);
  assertSize("natural", natural);
  assertSize("viewport", viewport);
  return {
    x: clampAxis(offset.x, natural.width * scale, viewport.width),
    y: clampAxis(offset.y, natural.height * scale, viewport.height),
  };
}

/** Zoom to `nextScale` (clamped to `[fitScale, MAX_ZOOM]`) keeping the point under `anchor` fixed. */
export function zoomAt(view: ZoomView, nextScale: number, anchor: Point, natural: Size, viewport: Size): ZoomView {
  assertScale(view.scale);
  assertScale(nextScale);
  const scale = Math.min(MAX_ZOOM, Math.max(fitScale(natural, viewport), nextScale));
  const ratio = scale / view.scale;
  const offset = clampOffset(
    {
      x: anchor.x - (anchor.x - view.offset.x) * ratio,
      y: anchor.y - (anchor.y - view.offset.y) * ratio,
    },
    scale,
    natural,
    viewport,
  );
  return { scale, offset };
}

export function panBy(view: ZoomView, dx: number, dy: number, natural: Size, viewport: Size): ZoomView {
  assertScale(view.scale);
  return {
    scale: view.scale,
    offset: clampOffset({ x: view.offset.x + dx, y: view.offset.y + dy }, view.scale, natural, viewport),
  };
}

/** Fitted → zoom in around `anchor` (to natural size, at least 2× the fit scale); zoomed → back to fit. */
export function toggleZoom(view: ZoomView, anchor: Point, natural: Size, viewport: Size): ZoomView {
  const fit = fitScale(natural, viewport);
  if (Math.abs(view.scale - fit) < FIT_EPSILON) {
    return zoomAt(view, Math.max(1, 2 * fit), anchor, natural, viewport);
  }
  return fitView(natural, viewport);
}

/** Multiplicative zoom step for a wheel event; `deltaMode` 1 is lines, 2 is pages. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean, viewportHeight: number): number {
  const pixels = deltaMode === 1 ? deltaY * LINE_HEIGHT_PX : deltaMode === 2 ? deltaY * viewportHeight : deltaY;
  return Math.exp(-pixels * (ctrlKey ? PINCH_WHEEL_SENSITIVITY : WHEEL_SENSITIVITY));
}
