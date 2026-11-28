import type { RenderedSection } from "./render";

/**
 * **A `<section>` never gets id / data-id**: reveal's named hash lookup searches the whole document and would hit a block
 * of the background editor.
 * Updates remove unwanted elements first and insertBefore the rest in order, so unmoved elements never leave the document
 * (media leaving the document is paused by the browser).
 * data-prevent-swipe: on an overflowing slide's scroll container (reveal leaves vertical scrolling alone while overflow-swipe.ts handles horizontal swipes) and on a horizontally overflowing `<pre>`, so a finger scrolls instead of paging.
 */
export const SLIDE_ID_ATTR = "data-kn-slide-id";
export const STACK_CLASS = "kn-present-stack";
export const NO_TRANSITION_CLASS = "kn-present-no-transition";
const BODY_CLASS = "kn-slide-body";
const TITLE_ONLY_CLASS = "kn-slide-title-only";

export interface SlideEls {
  section: HTMLElement;
  body: HTMLElement;
}

export interface DeckStructure {
  id: string;
  slides: { id: string }[];
}

export interface DeckDom {
  revealEl: HTMLElement;
  slidesEl: HTMLElement;
  els: Map<string, SlideEls>;
  keys: Map<string, string>;
  sections: DeckStructure[];
}

export function createDeckDom(): DeckDom {
  const revealEl = document.createElement("div");
  revealEl.className = "reveal";
  const slidesEl = document.createElement("div");
  slidesEl.className = "slides";
  revealEl.append(slidesEl);
  return { revealEl, slidesEl, els: new Map(), keys: new Map(), sections: [] };
}

function createSlideEls(id: string): SlideEls {
  const section = document.createElement("section");
  section.setAttribute(SLIDE_ID_ATTR, id);
  const body = document.createElement("div");
  body.className = BODY_CLASS;
  section.append(body);
  return { section, body };
}

function sameStructure(a: readonly DeckStructure[], b: readonly DeckStructure[]): boolean {
  return (
    a.length === b.length &&
    a.every((section, h) => section.slides.length === b[h].slides.length && section.slides.every((slide, v) => slide.id === b[h].slides[v].id))
  );
}

function reconcileChildren(parent: HTMLElement, wanted: readonly HTMLElement[]): void {
  const keep = new Set<Element>(wanted);
  for (const child of Array.from(parent.children)) if (!keep.has(child)) child.remove();
  wanted.forEach((el, index) => {
    const at = parent.children[index];
    if (at !== el) parent.insertBefore(el, at ?? null);
  });
}

function layout(dom: DeckDom, structure: readonly DeckStructure[]): void {
  const top: HTMLElement[] = [];
  for (const section of structure) {
    const slideEls = section.slides.map((slide) => dom.els.get(slide.id)!.section);
    if (slideEls.length === 1) {
      top.push(slideEls[0]);
      continue;
    }
    const reusable = slideEls
      .map((el) => el.parentElement)
      .find((parent): parent is HTMLElement => parent instanceof HTMLElement && parent.classList.contains(STACK_CLASS) && !top.includes(parent));
    let stack = reusable;
    if (!stack) {
      stack = document.createElement("section");
      stack.className = STACK_CLASS;
    }
    reconcileChildren(stack, slideEls);
    top.push(stack);
  }
  reconcileChildren(dom.slidesEl, top);
}

export function applyRenderedDeck(dom: DeckDom, rendered: readonly RenderedSection[]): { structureChanged: boolean; changed: string[] } {
  const changed: string[] = [];
  const nextIds = new Set<string>();
  for (const section of rendered) {
    for (const slide of section.slides) {
      nextIds.add(slide.id);
      let els = dom.els.get(slide.id);
      if (!els) {
        els = createSlideEls(slide.id);
        dom.els.set(slide.id, els);
      }
      els.section.classList.toggle(TITLE_ONLY_CLASS, slide.titleOnly);
      if (slide.content) {
        els.body.replaceChildren(slide.content.fragment);
        changed.push(slide.id);
      }
      dom.keys.set(slide.id, slide.key);
    }
  }
  for (const [id, els] of Array.from(dom.els)) {
    if (nextIds.has(id)) continue;
    els.section.remove();
    dom.els.delete(id);
    dom.keys.delete(id);
  }
  const next: DeckStructure[] = rendered.map((section) => ({ id: section.id, slides: section.slides.map((slide) => ({ id: slide.id })) }));
  const structureChanged = !sameStructure(dom.sections, next);
  if (structureChanged) layout(dom, next);
  dom.sections = next;
  return { structureChanged, changed };
}

export function playingMedia(root: ParentNode): HTMLMediaElement[] {
  return Array.from(root.querySelectorAll<HTMLMediaElement>("video, audio")).filter((media) => !media.paused);
}

export function withoutTransition(revealEl: HTMLElement, run: () => void): void {
  revealEl.classList.add(NO_TRANSITION_CLASS);
  try {
    run();
  } finally {
    // Without a reflow before removing the class, a pure-DOM change still animates. reveal 6.0.2's slide() happens to reflow
    // (it reads offsetWidth / offsetHeight after changing classes); this line doesn't rely on that. Re-check when upgrading reveal.
    void revealEl.offsetHeight;
    revealEl.classList.remove(NO_TRANSITION_CLASS);
  }
}

export function updateSwipeGuard(section: HTMLElement): void {
  section.toggleAttribute("data-prevent-swipe", section.scrollHeight > section.clientHeight);
  // An overflow-x:auto `<pre>` is marked too (present.css disables browser gestures only for unmarked ones), so a horizontal swipe scrolls the code.
  section.querySelectorAll<HTMLElement>("pre").forEach((pre) => pre.toggleAttribute("data-prevent-swipe", pre.scrollWidth > pre.clientWidth));
}

export interface SwipeGuards {
  observe(els: SlideEls): void;
  refresh(section: Element | null): void;
  refreshAll(): void;
  disconnect(): void;
}

const RECOMPUTE_EVENTS = ["load", "loadedmetadata", "toggle"] as const;

/** None of img load, loadedmetadata and details toggle bubble, so they are captured. */
export function watchSwipeGuards(slidesEl: HTMLElement): SwipeGuards {
  const refresh = (target: Element | null) => {
    const section = target?.closest(`[${SLIDE_ID_ATTR}]`);
    if (section instanceof HTMLElement) updateSwipeGuard(section);
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) refresh(entry.target);
  });
  const onEvent = (event: Event) => refresh(event.target instanceof Element ? event.target : null);
  for (const type of RECOMPUTE_EVENTS) slidesEl.addEventListener(type, onEvent, true);
  return {
    observe(els) {
      observer.observe(els.section);
      observer.observe(els.body);
    },
    refresh,
    refreshAll() {
      slidesEl.querySelectorAll<HTMLElement>(`section[${SLIDE_ID_ATTR}]`).forEach(updateSwipeGuard);
    },
    disconnect() {
      observer.disconnect();
      for (const type of RECOMPUTE_EVENTS) slidesEl.removeEventListener(type, onEvent, true);
    },
  };
}
