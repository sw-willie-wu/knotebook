import { useCallback, type ReactNode } from "react";
import { useActiveHeading } from "./active-heading";
import type { OutlineHeading } from "./headings";
import { HeadingOutline } from "./HeadingOutline";
import { outlineMaxHeight, outlinePlacement, outlineTop } from "./outline-layout";
import type { OutlineBox } from "./use-outline-box";
import { useOutlineJump } from "./use-outline-jump";

/** `WheelEvent.deltaMode` values: lines and pages (0 is pixels). */
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
/** Pixels per line for wheels that report lines (Firefox with a mouse wheel), about one line of note text. */
const WHEEL_LINE_PX = 16;

/**
 * Zero-height positioning layer for the outline, rendered right above the scroll container (a sibling, not inside it),
 * so the rail and the panel stay put while the note scrolls and take no layout space. Its top edge is the scroll
 * container's top edge and its left edge the container's left edge, which is what the outline's coordinates assume.
 * `z-20` keeps it over the note text and under dialogs (`z-50`). The layer itself lets the pointer through;
 * only the rail and the panel take it.
 */
export function OutlineAnchor({ children }: { children: ReactNode }) {
  return (
    <div data-outline-anchor="" className="pointer-events-none relative z-20 h-0 shrink-0">
      {children}
    </div>
  );
}

export interface NoteOutlineProps {
  headings: readonly OutlineHeading[];
  /** The note's scroll container: headings are looked up and scrolled inside it. */
  scrollEl: HTMLElement | null;
  box: OutlineBox;
  /** The corner bubbles sit in the bottom-right corner; the outline stops above them. */
  bubbleShown: boolean;
  /** How many bubbles are stacked there (default 1). */
  bubbleCount?: number;
  pinned: boolean;
  pinAvailable: boolean;
  onPinnedChange: (next: boolean) => void;
}

/** Heading outline of a note page (desktop and tablet): rail and panel wired to the scroll container. Nothing without headings. */
export function NoteOutline({ headings, scrollEl, box, bubbleShown, bubbleCount = 1, pinned, pinAvailable, onPinnedChange }: NoteOutlineProps) {
  const topEdge = useCallback(() => scrollEl?.getBoundingClientRect().top ?? 0, [scrollEl]);
  const { activeId, markJumped, releaseJump } = useActiveHeading({ headings, root: scrollEl, scrollTarget: scrollEl, topEdge, enabled: true });

  // A wheel over the rail or panel scrolls the note, as it would anywhere else over the card. It is a hand scroll:
  // it ends a jump's pin like a wheel inside the container does.
  const onForwardWheel = useCallback(
    (deltaY: number, deltaMode: number) => {
      if (!scrollEl) return;
      const px = deltaMode === WHEEL_DELTA_LINE ? deltaY * WHEEL_LINE_PX : deltaMode === WHEEL_DELTA_PAGE ? deltaY * scrollEl.clientHeight : deltaY;
      releaseJump();
      scrollEl.scrollTop += px;
    },
    [scrollEl, releaseJump],
  );

  const onJump = useOutlineJump(scrollEl, markJumped);

  if (headings.length === 0) return null;

  return (
    <OutlineAnchor>
      <HeadingOutline
        headings={headings}
        activeId={activeId}
        placement={outlinePlacement(box.width)}
        top={outlineTop(box)}
        maxHeight={outlineMaxHeight(box.height, bubbleShown, outlineTop(box), bubbleCount)}
        pinned={pinned}
        pinAvailable={pinAvailable}
        onPinnedChange={onPinnedChange}
        onJump={onJump}
        onForwardWheel={onForwardWheel}
      />
    </OutlineAnchor>
  );
}
