/**
 * 功能導覽遮罩的幾何：挖洞範圍、卡片位置、箭頭。全部是純函式，座標一律是視窗座標（`getBoundingClientRect` 那一套）。
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Placement = "bottom" | "top" | "right" | "left" | "center";

export interface CardPlacement {
  placement: Placement;
  left: number;
  top: number;
}

/** 挖洞比目標往外擴的距離：外框畫在洞的邊上，貼著目標畫會壓到目標自己的邊框與 focus ring。 */
export const HOLE_PADDING = 6;
export const HOLE_RADIUS = 8;
/** 卡片與挖洞之間的距離，箭頭畫在這段空隙裡。 */
export const CARD_GAP = 20;
/** 卡片離視窗邊緣至少這麼遠。 */
export const VIEWPORT_MARGIN = 8;

const rightOf = (r: Rect) => r.left + r.width;
const bottomOf = (r: Rect) => r.top + r.height;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function padRect(r: Rect, pad: number = HOLE_PADDING): Rect {
  return { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** 多個目標合成一個挖洞範圍（例如頁首的「分享」與 ⋮）。 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map(rightOf));
  const bottom = Math.max(...rects.map(bottomOf));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 卡片放哪裡：下方放得下就放下方，否則依序試上、右、左，都放不下（或沒有挖洞）就置中。
 * 「放得下」只看與挖洞垂直的那個方向；另一個方向對齊挖洞中心後夾在視窗內，所以卡片不會出界。
 */
export function placeCard(hole: Rect | null, card: Size, viewport: Size): CardPlacement {
  const m = VIEWPORT_MARGIN;
  const xRange = (left: number) => clamp(left, m, viewport.width - m - card.width);
  const yRange = (top: number) => clamp(top, m, viewport.height - m - card.height);
  if (hole !== null) {
    const centerX = hole.left + hole.width / 2 - card.width / 2;
    const centerY = hole.top + hole.height / 2 - card.height / 2;
    if (bottomOf(hole) + CARD_GAP + card.height <= viewport.height - m) {
      return { placement: "bottom", left: xRange(centerX), top: bottomOf(hole) + CARD_GAP };
    }
    if (hole.top - CARD_GAP - card.height >= m) {
      return { placement: "top", left: xRange(centerX), top: hole.top - CARD_GAP - card.height };
    }
    if (rightOf(hole) + CARD_GAP + card.width <= viewport.width - m) {
      return { placement: "right", left: rightOf(hole) + CARD_GAP, top: yRange(centerY) };
    }
    if (hole.left - CARD_GAP - card.width >= m) {
      return { placement: "left", left: hole.left - CARD_GAP - card.width, top: yRange(centerY) };
    }
  }
  return {
    placement: "center",
    left: xRange((viewport.width - card.width) / 2),
    top: yRange((viewport.height - card.height) / 2),
  };
}

/**
 * 箭頭：從卡片對著挖洞的那條邊，畫直線到挖洞對著卡片的那條邊。挖洞中心落在卡片的寬（或高）範圍內時，是一條垂直（或水平）的線。
 * 終點避開挖洞的圓角，箭頭才會落在外框的直線段上。置中時卡片不靠著挖洞，不畫箭頭。
 */
export function arrowPath(hole: Rect, card: Rect, placement: Placement): { d: string; from: Point; to: Point } | null {
  const r = HOLE_RADIUS;
  let from: Point;
  let to: Point;
  switch (placement) {
    case "bottom":
    case "top": {
      const x = clamp(hole.left + hole.width / 2, card.left, rightOf(card));
      from = { x, y: placement === "bottom" ? card.top : bottomOf(card) };
      to = { x: clamp(x, hole.left + r, rightOf(hole) - r), y: placement === "bottom" ? bottomOf(hole) : hole.top };
      break;
    }
    case "right":
    case "left": {
      const y = clamp(hole.top + hole.height / 2, card.top, bottomOf(card));
      from = { x: placement === "right" ? card.left : rightOf(card), y };
      to = { x: placement === "right" ? rightOf(hole) : hole.left, y: clamp(y, hole.top + r, bottomOf(hole) - r) };
      break;
    }
    case "center":
      return null;
  }
  return { d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, from, to };
}
