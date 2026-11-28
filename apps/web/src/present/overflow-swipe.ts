import { SLIDE_ID_ATTR } from "./deck";

/**
 * Horizontal swipe navigation on vertically overflowing slides (#573).
 *
 * Overflowing slides keep `data-prevent-swipe` so reveal.js leaves native vertical scrolling alone,
 * while `present.css` gives them `touch-action: pan-y pinch-zoom` so horizontal drags deliver
 * pointer/touch events instead of being cancelled by the browser's pan recognizer.
 *
 * Slide changes fire on pointerup/touchend rather than mid-move: reveal 6.0.2 listens to pointer
 * events without pointer capture, so hiding the overflowing slide mid-gesture would cause later
 * pointermove events to hit the newly visible slide (which may lack `data-prevent-swipe`) and
 * trigger a second jump against reveal's stale touchStart coordinates.
 */
/** Matches reveal.js 6.0.2 Touch controller's SWIPE_THRESHOLD (js/controllers/touch.js:4). */
export const SWIPE_THRESHOLD = 40;
/** Horizontal movement must exceed vertical movement by this factor so diagonal drags do not swipe. */
export const HORIZONTAL_DOMINANCE_RATIO = 1.5;
/** Early vertical lock distance: prevents curving sideways from a scroll boundary (where scrollTop cannot change) from triggering a swipe. */
export const VERTICAL_LOCK_THRESHOLD = 15;
/** Matches reveal.js 6.0.2 Touch controller's ZOOM_GESTURE_THRESHOLD (js/controllers/touch.js:5). */
export const ZOOM_GESTURE_THRESHOLD = 1.03;

export interface OverflowSwipeTarget {
  left(): void;
  right(): void;
  isOverview(): boolean;
}

export interface OverflowSwipeHandle {
  disconnect(): void;
}

interface Gesture {
  id: number;
  section: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startScrollTop: number;
}

function targetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function overflowingSlideFor(target: EventTarget | null): HTMLElement | null {
  const el = targetElement(target);
  if (!el) return null;
  const section = el.closest(`section[${SLIDE_ID_ATTR}]`);
  if (!(section instanceof HTMLElement) || !section.hasAttribute("data-prevent-swipe")) return null;
  // Respect nested swipe guards (table wrappers, wide <pre>) and media controls inside the slide.
  let cur: Element | null = el;
  while (cur && cur !== section) {
    if (cur.hasAttribute("data-prevent-swipe") || cur.matches("video, audio")) return null;
    cur = cur.parentElement;
  }
  return section;
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    const touch = list[i];
    if (touch && touch.identifier === id) return touch;
  }
  return null;
}

export function attachOverflowSwipe(revealEl: HTMLElement, deck: OverflowSwipeTarget): OverflowSwipeHandle {
  const activePointers = new Set<number>();
  let sawMultiTouch = false;
  let gesture: Gesture | null = null;
  let baseScale = 1;

  const isViewportZoomed = (): boolean => {
    const scale = window.visualViewport?.scale;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return false;
    baseScale = Math.min(baseScale, scale);
    return scale / baseScale > ZOOM_GESTURE_THRESHOLD;
  };

  const resetAll = () => {
    activePointers.clear();
    sawMultiTouch = false;
    gesture = null;
  };

  const checkMove = (g: Gesture, x: number, y: number): void => {
    if (deck.isOverview() || isViewportZoomed() || g.section.scrollTop !== g.startScrollTop) {
      gesture = null;
      return;
    }
    g.lastX = x;
    g.lastY = y;
    const absX = Math.abs(x - g.startX);
    const absY = Math.abs(y - g.startY);
    if (absY >= VERTICAL_LOCK_THRESHOLD && absY >= absX) {
      gesture = null;
    }
  };

  const finishGesture = (g: Gesture, x: number, y: number): void => {
    gesture = null;
    if (deck.isOverview() || isViewportZoomed() || g.section.scrollTop !== g.startScrollTop) return;
    const dx = x - g.startX;
    const dy = y - g.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < SWIPE_THRESHOLD || absX <= absY * HORIZONTAL_DOMINANCE_RATIO) return;
    if (dx > 0) deck.left();
    else deck.right();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    activePointers.add(event.pointerId);
    if (activePointers.size > 1) {
      sawMultiTouch = true;
      gesture = null;
      return;
    }
    if (sawMultiTouch || deck.isOverview() || isViewportZoomed()) return;
    const section = overflowingSlideFor(event.target);
    if (!section) return;
    gesture = {
      id: event.pointerId,
      section,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startScrollTop: section.scrollTop,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    if (!gesture || event.pointerId !== gesture.id) return;
    checkMove(gesture, event.clientX, event.clientY);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    activePointers.delete(event.pointerId);
    const wasMulti = sawMultiTouch;
    if (activePointers.size === 0) sawMultiTouch = false;
    if (!gesture || event.pointerId !== gesture.id) return;
    if (wasMulti) {
      gesture = null;
      return;
    }
    finishGesture(gesture, event.clientX, event.clientY);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    activePointers.delete(event.pointerId);
    if (gesture && event.pointerId === gesture.id) gesture = null;
    if (activePointers.size === 0) sawMultiTouch = false;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      sawMultiTouch = true;
      gesture = null;
      return;
    }
    if (sawMultiTouch || deck.isOverview() || isViewportZoomed()) return;
    const touch = event.touches[0];
    if (!touch) return;
    const section = overflowingSlideFor(event.target);
    if (!section) return;
    gesture = {
      id: touch.identifier,
      section,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startScrollTop: section.scrollTop,
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      sawMultiTouch = true;
      gesture = null;
      return;
    }
    if (!gesture) return;
    const touch = findTouch(event.touches, gesture.id);
    if (!touch) return;
    checkMove(gesture, touch.clientX, touch.clientY);
  };

  const onTouchEnd = (event: TouchEvent) => {
    const wasMulti = sawMultiTouch;
    if (event.touches.length === 0) sawMultiTouch = false;
    if (!gesture) return;
    const touch = findTouch(event.changedTouches, gesture.id);
    if (!touch) return;
    if (wasMulti) {
      gesture = null;
      return;
    }
    finishGesture(gesture, touch.clientX, touch.clientY);
  };

  const onTouchCancel = (event: TouchEvent) => {
    if (event.touches.length === 0) sawMultiTouch = false;
    if (!gesture) return;
    if (event.touches.length === 0 || findTouch(event.changedTouches, gesture.id)) gesture = null;
  };

  const usePointer = "onpointerdown" in window;
  const passive: AddEventListenerOptions = { passive: true };
  if (usePointer) {
    revealEl.addEventListener("pointerdown", onPointerDown, passive);
    revealEl.addEventListener("pointermove", onPointerMove, passive);
    revealEl.addEventListener("pointerup", onPointerUp, passive);
    revealEl.addEventListener("pointercancel", onPointerCancel, passive);
  } else {
    revealEl.addEventListener("touchstart", onTouchStart, passive);
    revealEl.addEventListener("touchmove", onTouchMove, passive);
    revealEl.addEventListener("touchend", onTouchEnd, passive);
    revealEl.addEventListener("touchcancel", onTouchCancel, passive);
  }
  window.addEventListener("blur", resetAll);

  return {
    disconnect() {
      resetAll();
      window.removeEventListener("blur", resetAll);
      if (usePointer) {
        revealEl.removeEventListener("pointerdown", onPointerDown, passive);
        revealEl.removeEventListener("pointermove", onPointerMove, passive);
        revealEl.removeEventListener("pointerup", onPointerUp, passive);
        revealEl.removeEventListener("pointercancel", onPointerCancel, passive);
      } else {
        revealEl.removeEventListener("touchstart", onTouchStart, passive);
        revealEl.removeEventListener("touchmove", onTouchMove, passive);
        revealEl.removeEventListener("touchend", onTouchEnd, passive);
        revealEl.removeEventListener("touchcancel", onTouchCancel, passive);
      }
    },
  };
}
