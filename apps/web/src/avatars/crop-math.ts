import type { AvatarCropDto } from "@knotebook/shared";

/**
 * 頭貼裁切框的純數學。座標約定：
 * - 視窗是邊長 `viewport`（px）的正方形；原圖像素 p 顯示在視窗座標 `offset + p * scale`。
 * - `scale`＝每個原圖像素佔幾個視窗像素；`offset` 是原圖左上角在視窗內的位置，合法時兩軸都 ≤ 0（圖蓋滿視窗）。
 * - 裁切框 `{ x, y, size }` 是原圖像素座標的正方形，三個值都是整數、落在圖內。
 */

export interface Point {
  x: number;
  y: number;
}

export interface CropView {
  scale: number;
  offset: Point;
}

/** 視窗上限：原圖 1 px 最多放大成視窗 4 px。 */
const MAX_PIXEL_ZOOM = 4;
/** 縮放範圍上限：最多是最小縮放的 8 倍。 */
const MAX_ZOOM_RATIO = 8;

function assertSize(width: number, height: number): void {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`invalid image size ${width}×${height}`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`invalid ${name} ${value}`);
  }
}

/** `Math.min(Math.max(...))` 會產生 -0；一律正規化成 0，讓 `toEqual`／相等比較不被負零絆倒。 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value)) + 0;
}

/** 最小縮放：短邊剛好填滿視窗。`viewport` 必須是正的有限數，否則丟 `RangeError`。 */
export function minScale(width: number, height: number, viewport: number): number {
  assertSize(width, height);
  assertPositive("viewport", viewport);
  return viewport / Math.min(width, height);
}

/** 最大縮放：原圖 1 px 對應視窗 4 px，或最小縮放的 8 倍，取小者；但不會小於最小縮放（原圖比視窗小很多時）。 */
export function maxScale(width: number, height: number, viewport: number): number {
  const lo = minScale(width, height, viewport);
  return Math.max(lo, Math.min(MAX_PIXEL_ZOOM, MAX_ZOOM_RATIO * lo));
}

/** 把平移量夾到圖蓋滿視窗的範圍：每軸 `[視窗 − 圖尺寸 × scale, 0]`。 */
export function clampOffset(offset: Point, scale: number, width: number, height: number, viewport: number): Point {
  return {
    x: clamp(offset.x, Math.min(0, viewport - width * scale), 0),
    y: clamp(offset.y, Math.min(0, viewport - height * scale), 0),
  };
}

/** 以 `anchor`（視窗座標）為不動點縮放到 `nextScale`（先夾進上下限），結果的平移量已夾在圖內。`view.scale`、`nextScale` 必須是正的有限數，否則丟 `RangeError`。 */
export function zoomAround(view: CropView, nextScale: number, anchor: Point, width: number, height: number, viewport: number): CropView {
  assertPositive("scale", view.scale);
  assertPositive("scale", nextScale);
  const scale = clamp(nextScale, minScale(width, height, viewport), maxScale(width, height, viewport));
  const imageX = (anchor.x - view.offset.x) / view.scale;
  const imageY = (anchor.y - view.offset.y) / view.scale;
  const offset = clampOffset({ x: anchor.x - imageX * scale, y: anchor.y - imageY * scale }, scale, width, height, viewport);
  return { scale, offset };
}

/**
 * 目前的檢視換成原圖整數像素的裁切框：`size ≥ 1` 且落在圖內，即使 `offset` 沒夾過也一樣。
 * `view.scale`、`viewport` 必須是正的有限數，否則丟 `RangeError`；`offset` 必須是有限數。
 */
export function viewToCrop(view: CropView, width: number, height: number, viewport: number): AvatarCropDto {
  assertSize(width, height);
  assertPositive("viewport", viewport);
  assertPositive("scale", view.scale);
  const size = clamp(Math.round(viewport / view.scale), 1, Math.min(width, height));
  return {
    x: clamp(Math.round(-view.offset.x / view.scale), 0, width - size),
    y: clamp(Math.round(-view.offset.y / view.scale), 0, height - size),
    size,
  };
}

/** 既有裁切框換回檢視（縮放夾進上下限、平移夾在圖內）。 */
export function cropToView(crop: AvatarCropDto, width: number, height: number, viewport: number): CropView {
  const scale = clamp(viewport / Math.max(1, crop.size), minScale(width, height, viewport), maxScale(width, height, viewport));
  return { scale, offset: clampOffset({ x: -crop.x * scale, y: -crop.y * scale }, scale, width, height, viewport) };
}

/** 置中、取短邊的裁切框（沒有人調過裁切時的預設）。 */
export function centeredCrop(width: number, height: number): AvatarCropDto {
  assertSize(width, height);
  const size = Math.min(width, height);
  return { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), size };
}
