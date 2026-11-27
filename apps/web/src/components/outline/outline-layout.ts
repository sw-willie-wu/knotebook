import { CORNER_STACK_RIGHT_INSET_PX, CORNER_STACK_SIZE_PX, cornerStackFootprint } from "@/components/corner-stack-geometry";

/** Layout of the right-hand heading outline. All x coordinates are measured from the scroll container's left edge. */
export const OUTLINE_PANEL_WIDTH = 240;
export const OUTLINE_GAP = 16;
export const OUTLINE_RAIL_WIDTH = 24;
export const OUTLINE_MIN_PINNED_COLUMN = 640;
/** Outline distance from the container top when the first block can't be measured (empty document). */
export const OUTLINE_TOP_OFFSET = 28;
/** Gap between the panel bottom and the version bubble (or the container bottom). */
export const OUTLINE_BOTTOM_GAP = 12;
/** Max panel height (floating and pinned alike) as a fraction of the scroll container's visible height. */
export const OUTLINE_MAX_HEIGHT_RATIO = 2 / 3;

/**
 * Panel distance from the container's right edge, aligning its right edge with the rail's: bubble inset plus
 * half the bubble/rail width difference (the rail is horizontally centered in the bubble's column).
 */
export const OUTLINE_PANEL_RIGHT_INSET = CORNER_STACK_RIGHT_INSET_PX + (CORNER_STACK_SIZE_PX - OUTLINE_RAIL_WIDTH) / 2;

/**
 * When pinned, the content column's right edge stays at least this far from the container's right edge.
 * `standard-pinned` in `ui/article-column.ts` yields this same width; `article-column.guard.test.ts` ties them together.
 */
export const OUTLINE_PIN_RESERVED_WIDTH = OUTLINE_PANEL_WIDTH + OUTLINE_GAP + OUTLINE_PANEL_RIGHT_INSET;

export function canPinOutline(containerWidth: number): boolean {
  return containerWidth - OUTLINE_PIN_RESERVED_WIDTH >= OUTLINE_MIN_PINNED_COLUMN;
}

export interface OutlinePlacement {
  railLeft: number;
  /** Same position floating and pinned. */
  panelLeft: number;
}

/**
 * The rail sits in the column right above the version bubble and follows the right edge of the visible
 * width (the version panel opening on the right narrows the card and moves the rail left); no other panel
 * open/close moves it. The panel's right edge aligns with the rail's, floating and pinned alike (pinning
 * doesn't move it): it covers the rail so the pointer crosses no gap. When pinned the content column yields
 * `OUTLINE_PIN_RESERVED_WIDTH`, leaving `OUTLINE_GAP` to the panel.
 */
export function outlinePlacement(containerWidth: number): OutlinePlacement {
  const W = containerWidth;
  // The scrollbar gutter is not part of the visible width. Independent of whether the bubble shows or the
  // version and outline panels are open.
  const bubbleCenter = W - CORNER_STACK_RIGHT_INSET_PX - CORNER_STACK_SIZE_PX / 2;
  const railLeft = bubbleCenter - OUTLINE_RAIL_WIDTH / 2;
  const panelLeft = Math.max(0, railLeft + OUTLINE_RAIL_WIDTH - OUTLINE_PANEL_WIDTH);
  return { railLeft, panelLeft };
}

export function outlineTop(box: { firstLineTop: number | null }): number {
  return box.firstLineTop ?? OUTLINE_TOP_OFFSET;
}

/**
 * `top` is the outline's distance from the container top. The smaller of 2/3 of the visible height and
 * stopping above the corner bubbles (`bubbleCount` of them) when they show; overflow scrolls inside the panel.
 */
export function outlineMaxHeight(containerHeight: number, bubbleShown: boolean, top: number = OUTLINE_TOP_OFFSET, bubbleCount = 1): number {
  const bottom = bubbleShown ? cornerStackFootprint(bubbleCount) + OUTLINE_BOTTOM_GAP : OUTLINE_BOTTOM_GAP;
  return Math.max(0, Math.min(containerHeight * OUTLINE_MAX_HEIGHT_RATIO, containerHeight - top - bottom));
}
