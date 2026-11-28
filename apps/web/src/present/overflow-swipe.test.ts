import { afterEach, describe, expect, it, vi } from "vitest";
import { SLIDE_ID_ATTR } from "./deck";
import {
  attachOverflowSwipe,
  HORIZONTAL_DOMINANCE_RATIO,
  SWIPE_THRESHOLD,
  VERTICAL_LOCK_THRESHOLD,
  type OverflowSwipeTarget,
} from "./overflow-swipe";

function makeDeckDom() {
  const revealEl = document.createElement("div");
  revealEl.className = "reveal";
  const slidesEl = document.createElement("div");
  slidesEl.className = "slides";
  revealEl.append(slidesEl);

  const overflowing = document.createElement("section");
  overflowing.setAttribute(SLIDE_ID_ATTR, "long");
  overflowing.setAttribute("data-prevent-swipe", "");
  const body = document.createElement("div");
  body.className = "kn-slide-body";
  const paragraph = document.createElement("p");
  paragraph.textContent = "Long slide text";
  const shortPre = document.createElement("pre");
  const shortCode = document.createElement("code");
  shortCode.textContent = "const a = 1;";
  shortPre.append(shortCode);
  const widePre = document.createElement("pre");
  widePre.setAttribute("data-prevent-swipe", "");
  const wideCode = document.createElement("code");
  wideCode.textContent = "x".repeat(200);
  widePre.append(wideCode);
  const tableWrap = document.createElement("div");
  tableWrap.className = "kn-present-table";
  tableWrap.setAttribute("data-prevent-swipe", "");
  const td = document.createElement("td");
  tableWrap.append(td);
  const video = document.createElement("video");
  video.setAttribute("controls", "");
  const audio = document.createElement("audio");
  audio.setAttribute("controls", "");
  body.append(paragraph, shortPre, widePre, tableWrap, video, audio);
  overflowing.append(body);

  const fitting = document.createElement("section");
  fitting.setAttribute(SLIDE_ID_ATTR, "short");
  const fittingP = document.createElement("p");
  fittingP.textContent = "Short slide text";
  fitting.append(fittingP);

  slidesEl.append(overflowing, fitting);
  return { revealEl, slidesEl, overflowing, paragraph, shortCode, wideCode, td, video, audio, fitting, fittingP };
}

function makeDeck(overview = false): OverflowSwipeTarget & { left: ReturnType<typeof vi.fn>; right: ReturnType<typeof vi.fn>; setOverview(v: boolean): void } {
  let isOverview = overview;
  return {
    left: vi.fn(),
    right: vi.fn(),
    isOverview: () => isOverview,
    setOverview(v: boolean) {
      isOverview = v;
    },
  };
}

function pointerEvent(type: string, init: { pointerId?: number; pointerType?: string; clientX: number; clientY: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "touch" },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
  });
  return event;
}

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touchEvent(type: string, touches: TouchPoint[], changedTouches: TouchPoint[] = touches): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  return event;
}

function setViewportScale(scale: number | undefined) {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: scale === undefined ? undefined : { scale },
  });
}

describe("attachOverflowSwipe (pointer events)", () => {
  afterEach(() => {
    setViewportScale(undefined);
  });

  function swipePointer(target: EventTarget, points: [number, number][], pointerId = 1, pointerType = "touch") {
    const [first, ...rest] = points;
    const last = rest.pop() ?? first;
    target.dispatchEvent(pointerEvent("pointerdown", { pointerId, pointerType, clientX: first[0], clientY: first[1] }));
    for (const [x, y] of rest) {
      target.dispatchEvent(pointerEvent("pointermove", { pointerId, pointerType, clientX: x, clientY: y }));
    }
    target.dispatchEvent(pointerEvent("pointerup", { pointerId, pointerType, clientX: last[0], clientY: last[1] }));
  }

  it("horizontal swipe left calls right(); horizontal swipe right calls left()", () => {
    expect("onpointerdown" in window).toBe(true);
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    swipePointer(dom.paragraph, [[300, 200], [240, 205], [200, 210]]);
    expect(deck.right).toHaveBeenCalledTimes(1);
    expect(deck.left).not.toHaveBeenCalled();

    swipePointer(dom.paragraph, [[100, 200], [160, 200], [220, 205]]);
    expect(deck.left).toHaveBeenCalledTimes(1);
    expect(deck.right).toHaveBeenCalledTimes(1);

    handle.disconnect();
  });

  it("matches reveal's threshold (40px) and rejects short or diagonal swipes", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    // Just below threshold
    swipePointer(dom.paragraph, [[200, 200], [200 - (SWIPE_THRESHOLD - 1), 200]]);
    expect(deck.right).not.toHaveBeenCalled();

    // Diagonal at the exact dominance boundary (|dx| === |dy| * ratio) is rejected
    const diagX = 60;
    const diagY = diagX / HORIZONTAL_DOMINANCE_RATIO;
    swipePointer(dom.paragraph, [[200, 200], [200 - diagX, 200 + diagY]]);
    expect(deck.right).not.toHaveBeenCalled();

    // 45-degree diagonal is rejected
    swipePointer(dom.paragraph, [[200, 200], [120, 280]]);
    expect(deck.right).not.toHaveBeenCalled();

    // Pure vertical swipe is rejected
    swipePointer(dom.paragraph, [[200, 400], [200, 200]]);
    expect(deck.right).not.toHaveBeenCalled();
    expect(deck.left).not.toHaveBeenCalled();

    // Exact threshold horizontally succeeds
    swipePointer(dom.paragraph, [[200, 200], [200 - SWIPE_THRESHOLD, 200]]);
    expect(deck.right).toHaveBeenCalledTimes(1);

    handle.disconnect();
  });

  it("aborts if the slide scrolls vertically or locks vertically before curving sideways", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    // Case 1: scrollTop changed during the gesture
    dom.overflowing.scrollTop = 0;
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { clientX: 300, clientY: 200 }));
    dom.overflowing.scrollTop = 12;
    dom.paragraph.dispatchEvent(pointerEvent("pointermove", { clientX: 250, clientY: 205 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { clientX: 180, clientY: 205 }));
    expect(deck.right).not.toHaveBeenCalled();

    // Case 2: scrollTop stays at 0 (e.g. already at top edge), drags vertically past lock threshold, then curves horizontally
    dom.overflowing.scrollTop = 0;
    swipePointer(dom.paragraph, [[300, 200], [295, 200 + VERTICAL_LOCK_THRESHOLD], [150, 200 + VERTICAL_LOCK_THRESHOLD]]);
    expect(deck.right).not.toHaveBeenCalled();

    handle.disconnect();
  });

  it("ignores gestures starting inside wide <pre>, table wrapper, or media controls, but allows short <pre> and Text nodes", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    swipePointer(dom.wideCode, [[300, 200], [180, 200]]);
    swipePointer(dom.td, [[300, 200], [180, 200]]);
    swipePointer(dom.video, [[300, 200], [180, 200]]);
    swipePointer(dom.audio, [[300, 200], [180, 200]]);
    expect(deck.right).not.toHaveBeenCalled();

    // Short <pre> (no data-prevent-swipe) inside an overflowing slide still swipes horizontally
    swipePointer(dom.shortCode, [[300, 200], [180, 200]]);
    expect(deck.right).toHaveBeenCalledTimes(1);

    // Text node target inside the paragraph still resolves to the overflowing slide
    swipePointer(dom.paragraph.firstChild!, [[100, 200], [220, 200]]);
    expect(deck.left).toHaveBeenCalledTimes(1);

    handle.disconnect();
  });

  it("ignores non-overflowing slides so reveal.js handles them without double-triggering", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    swipePointer(dom.fittingP, [[300, 200], [180, 200]]);
    expect(deck.right).not.toHaveBeenCalled();
    expect(deck.left).not.toHaveBeenCalled();

    handle.disconnect();
  });

  it("cancels on multi-touch / pinch-zoom and stays suppressed until all fingers lift", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    // Finger 1 down, finger 2 down, finger 2 lifts, finger 1 drags far left and lifts -> no swipe
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 300, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 250, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, clientX: 260, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 150, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, clientX: 150, clientY: 200 }));
    expect(deck.right).not.toHaveBeenCalled();

    // Next single-finger swipe after all fingers lifted works normally
    swipePointer(dom.paragraph, [[300, 200], [180, 200]], 3);
    expect(deck.right).toHaveBeenCalledTimes(1);

    handle.disconnect();
  });

  it("does not change slides while the viewport is zoomed in (#235), and resumes at scale 1", () => {
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    setViewportScale(1.5);
    swipePointer(dom.paragraph, [[300, 200], [150, 200]]);
    expect(deck.right).not.toHaveBeenCalled();

    // Zooming mid-gesture also aborts
    setViewportScale(1);
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { clientX: 300, clientY: 200 }));
    setViewportScale(1.2);
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { clientX: 150, clientY: 200 }));
    expect(deck.right).not.toHaveBeenCalled();

    // Back to unzoomed scale -> swipe works again
    setViewportScale(1);
    swipePointer(dom.paragraph, [[300, 200], [150, 200]]);
    expect(deck.right).toHaveBeenCalledTimes(1);

    handle.disconnect();
  });

  it("ignores overview mode, non-touch pointers, pointercancel, and window blur, and cleans up on disconnect", () => {
    const dom = makeDeckDom();
    const deck = makeDeck(true);
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    swipePointer(dom.paragraph, [[300, 200], [150, 200]]);
    expect(deck.right).not.toHaveBeenCalled();

    deck.setOverview(false);
    swipePointer(dom.paragraph, [[300, 200], [150, 200]], 1, "mouse");
    swipePointer(dom.paragraph, [[300, 200], [150, 200]], 1, "pen");
    expect(deck.right).not.toHaveBeenCalled();

    // pointercancel aborts the gesture
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { pointerId: 5, clientX: 300, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointercancel", { pointerId: 5, clientX: 250, clientY: 200 }));
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { pointerId: 5, clientX: 150, clientY: 200 }));
    expect(deck.right).not.toHaveBeenCalled();

    // window blur clears any orphaned pointer state
    dom.paragraph.dispatchEvent(pointerEvent("pointerdown", { pointerId: 6, clientX: 300, clientY: 200 }));
    window.dispatchEvent(new Event("blur"));
    dom.paragraph.dispatchEvent(pointerEvent("pointerup", { pointerId: 6, clientX: 150, clientY: 200 }));
    expect(deck.right).not.toHaveBeenCalled();

    // After blur, a fresh touch still works
    swipePointer(dom.paragraph, [[300, 200], [150, 200]], 7);
    expect(deck.right).toHaveBeenCalledTimes(1);

    // After disconnect, listeners are removed
    handle.disconnect();
    swipePointer(dom.paragraph, [[300, 200], [150, 200]], 8);
    expect(deck.right).toHaveBeenCalledTimes(1);
  });
});

describe("attachOverflowSwipe (touch events fallback)", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, "onpointerdown");

  afterEach(() => {
    if (originalDescriptor) Object.defineProperty(window, "onpointerdown", originalDescriptor);
    else delete (window as { onpointerdown?: unknown }).onpointerdown;
    setViewportScale(undefined);
  });

  function disablePointer() {
    delete (window as { onpointerdown?: unknown }).onpointerdown;
  }

  function swipeTouch(target: EventTarget, points: [number, number][], id = 0) {
    const [first, ...rest] = points;
    const last = rest.pop() ?? first;
    target.dispatchEvent(touchEvent("touchstart", [{ identifier: id, clientX: first[0], clientY: first[1] }]));
    for (const [x, y] of rest) {
      target.dispatchEvent(touchEvent("touchmove", [{ identifier: id, clientX: x, clientY: y }]));
    }
    target.dispatchEvent(touchEvent("touchend", [], [{ identifier: id, clientX: last[0], clientY: last[1] }]));
  }

  it("handles horizontal swipes, rejects multi-touch and touchcancel, and cleans up on disconnect", () => {
    disablePointer();
    expect("onpointerdown" in window).toBe(false);
    const dom = makeDeckDom();
    const deck = makeDeck();
    const handle = attachOverflowSwipe(dom.revealEl, deck);

    swipeTouch(dom.paragraph, [[300, 200], [240, 202], [180, 205]]);
    expect(deck.right).toHaveBeenCalledTimes(1);

    swipeTouch(dom.paragraph, [[100, 200], [220, 200]]);
    expect(deck.left).toHaveBeenCalledTimes(1);

    // Multi-touch pinch cancels gesture until all fingers lift
    const p1 = { identifier: 1, clientX: 300, clientY: 200 };
    const p2 = { identifier: 2, clientX: 250, clientY: 200 };
    dom.paragraph.dispatchEvent(touchEvent("touchstart", [p1]));
    dom.paragraph.dispatchEvent(touchEvent("touchstart", [p1, p2], [p2]));
    dom.paragraph.dispatchEvent(touchEvent("touchend", [p1], [p2]));
    dom.paragraph.dispatchEvent(touchEvent("touchend", [], [{ identifier: 1, clientX: 120, clientY: 200 }]));
    expect(deck.right).toHaveBeenCalledTimes(1);

    // touchcancel aborts
    dom.paragraph.dispatchEvent(touchEvent("touchstart", [p1]));
    dom.paragraph.dispatchEvent(touchEvent("touchcancel", [], [p1]));
    dom.paragraph.dispatchEvent(touchEvent("touchend", [], [{ identifier: 1, clientX: 120, clientY: 200 }]));
    expect(deck.right).toHaveBeenCalledTimes(1);

    // Disconnect stops listening
    handle.disconnect();
    swipeTouch(dom.paragraph, [[300, 200], [180, 200]]);
    expect(deck.right).toHaveBeenCalledTimes(1);
  });
});
