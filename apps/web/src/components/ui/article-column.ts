import type { NoteWidth } from "@knotebook/shared";

/**
 * Width chain and inset of BlockNote's centring wrapper; single source of the three width classes (Tailwind scans the literal strings here); consumers get classes via `articleColumn(width)`.
 * Header and footer once shared this column (#88); the redesign (#115) removed that deliberately, and `article-column.guard.test.ts` guards against adding it back.
 * Pinned outline (#465): a standard-width note with a pinned outline uses the `standard-pinned` state; whether pinning fits is `canPinOutline` in `outline/outline-layout.ts`, and the reserved widths of both are tied by the guard test.
 */

export type ArticleColumnState = NoteWidth | "standard-pinned";

export const ARTICLE_COLUMN_BASE = "mx-auto w-full";

/**
 * The standard floor (42.5rem = 680px, the pre-redesign width) is load-bearing, don't turn the clamp into `min()`: on medium windows (~730px scroller) 85% is only 620px, narrower than before. Wide uses the same floor, so below ~735px parent width both sit on the floor and equal standard.
 * Standard + pinned: width = min(standard, container − 17.875rem); 17.875rem = 286px = panel 240 + gap 16 + panel's right inset 30 (same spot as the floating panel, so it doesn't move when pinned). Shift = min(0, right space after centring − 17.875rem): with room to spare `left` is 0 and the body doesn't move, otherwise it moves left just enough, keeping 286px from the column's right edge to the container's (16px between column and panel); a squeezed column's left edge sits exactly on the container's left edge.
 * The shift uses `left` (the column is `relative`): margin `auto` can't transition, and a transform would make the column the containing block of the fixed overlays inside.
 * On narrower windows `w-full` shrinks the column (max-width doesn't cause horizontal scroll). Percentages resolve against the parent scroll container for both max-width and `left`.
 */
export const ARTICLE_COLUMN_MAX: Record<ArticleColumnState, string> = {
  standard: "max-w-[clamp(42.5rem,85%,66rem)]",
  wide: "max-w-[clamp(42.5rem,92.5%,88rem)]",
  full: "max-w-none",
  "standard-pinned":
    "max-w-[min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem))] left-[min(0px,calc((100%_-_min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem)))/2_-_17.875rem))]",
};

export const ARTICLE_COLUMN_PIN_MOTION = "transition-[max-width,left] duration-150 ease-out motion-reduce:transition-none";

/** Pinning applies only to standard width: wide and full users want a wide body. */
export function articleColumnState(width: NoteWidth, pinned: boolean): ArticleColumnState {
  return pinned && width === "standard" ? "standard-pinned" : width;
}

/** `pinMotion`: for consumers that can toggle pinning; adds a transition to both standard states and an explicit `left-0` on the unpinned one (`left: auto` can't transition). Ignored for wide and full. */
export function articleColumn(state: ArticleColumnState = "standard", options?: { pinMotion?: boolean }): string {
  const column = `${ARTICLE_COLUMN_BASE} ${ARTICLE_COLUMN_MAX[state]}`;
  if (options?.pinMotion !== true) return column;
  if (state === "standard") return `${column} left-0 ${ARTICLE_COLUMN_PIN_MOTION}`;
  if (state === "standard-pinned") return `${column} ${ARTICLE_COLUMN_PIN_MOTION}`;
  return column;
}

export const ARTICLE_COLUMN = articleColumn("standard");

/** md+: `px-4` + BlockNote's built-in 54px = text edge at 70px. <md: `px-0` plus the `.bn-editor.bn-editor{padding-inline:1.25rem}` override in index.css = 20px (aligned with header/footer `px-5`). `max-md:` compiles to `@media (width < 48rem)`, the same boundary as that index.css query: both must move together, or between 767–768px the wrapper is px-0 while the 54px remains. */
export const ARTICLE_COLUMN_PADDING = "px-4 max-md:px-0";

/** BlockNote `.bn-editor`'s built-in `padding-inline`. The <md 20px override assumes the original 54, so the guard test goes red if BlockNote changes it; `ARTICLE_TEXT_INSET` is the one place the 54 is used as a class. */
export const BN_EDITOR_INLINE_PADDING_PX = 54;

/** For rows inside the article column but outside the editor: `px-4` + 54 = 70px (md+), 0 + 20 = 20px (<md), the editor text's left edge. Same breakpoint as `ARTICLE_COLUMN_PADDING`. */
export const ARTICLE_TEXT_INSET = "px-[54px] max-md:px-5";
