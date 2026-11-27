import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderedSection } from "./render";
import {
  applyRenderedDeck, createDeckDom, NO_TRANSITION_CLASS, playingMedia, SLIDE_ID_ATTR, STACK_CLASS,
  updateSwipeGuard, watchSwipeGuards, withoutTransition,
} from "./deck";

/** "a:a1,a2|b:b1" -> RenderedSection[]; each content is a <p>id@version</p> (the version makes "content changed" controllable). */
function rendered(spec: string, version: Record<string, number> = {}, reuse: string[] = []): RenderedSection[] {
  return spec.split("|").map((part) => {
    const ids = part.split(":")[1].split(",");
    return {
      id: ids[0],
      slides: ids.map((id) => {
        const v = version[id] ?? 0;
        const fragment = document.createDocumentFragment();
        const p = document.createElement("p");
        p.textContent = `${id}@${v}`;
        fragment.append(p);
        return { id, kind: "heading" as const, titleOnly: id.endsWith("!"), key: `${id}@${v}`, content: reuse.includes(id) ? null : { fragment, mermaid: [], math: [], code: [] } };
      }),
    };
  });
}

function shape(slidesEl: HTMLElement): string {
  return Array.from(slidesEl.children)
    .map((el) => (el.classList.contains(STACK_CLASS) ? `[${Array.from(el.children).map((c) => c.getAttribute(SLIDE_ID_ATTR)).join(",")}]` : el.getAttribute(SLIDE_ID_ATTR)))
    .join(" ");
}

describe("applyRenderedDeck", () => {
  it("initial: a single-slide section is a top-level section, a multi-slide section is wrapped in kn-present-stack; no id / data-id", () => {
    const dom = createDeckDom();
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1,a2|b:b1"));
    expect(shape(dom.slidesEl)).toBe("_title [a1,a2] b1");
    expect(dom.slidesEl.querySelectorAll("[id], [data-id]")).toHaveLength(0);
    expect(result).toEqual({ structureChanged: true, changed: ["_title", "a1", "a2", "b1"] });
    expect(dom.revealEl.className).toBe("reveal");
    expect(dom.slidesEl.parentElement).toBe(dom.revealEl);
  });

  it("titleOnly -> section has kn-slide-title-only; content goes in .kn-slide-body", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|t:t!"));
    const els = dom.els.get("t!")!;
    expect(els.section.classList.contains("kn-slide-title-only")).toBe(true);
    expect(els.body.className).toBe("kn-slide-body");
    expect(els.body.textContent).toBe("t!@0");
  });

  it("structure unchanged, one slide's content changed -> structureChanged false, only that slide's body swapped; other bodies' children untouched", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    const a1Child = dom.els.get("a1")!.body.firstChild;
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1,a2", { a2: 1 }, ["_title", "a1"]));
    expect(result).toEqual({ structureChanged: false, changed: ["a2"] });
    expect(dom.els.get("a1")!.body.firstChild).toBe(a1Child);
    expect(dom.els.get("a2")!.body.textContent).toBe("a2@1");
  });

  it("inserting a section before the current slide: reused elements never leave the document", () => {
    const dom = createDeckDom();
    document.body.append(dom.revealEl);
    try {
      applyRenderedDeck(dom, rendered("_:_title|b:b1"));
      const b1 = dom.els.get("b1")!.section;
      const removed: Node[] = [];
      const observer = new MutationObserver((records) => records.forEach((r) => removed.push(...r.removedNodes)));
      observer.observe(dom.slidesEl, { childList: true, subtree: true });
      applyRenderedDeck(dom, rendered("_:_title|n:n1|b:b1", {}, ["_title", "b1"]));
      observer.takeRecords().forEach((r) => removed.push(...r.removedNodes));
      observer.disconnect();
      expect(shape(dom.slidesEl)).toBe("_title n1 b1");
      expect(removed).not.toContain(b1);
      expect(dom.els.get("b1")!.section).toBe(b1);
    } finally {
      dom.revealEl.remove();
    }
  });

  it("deleting a slide: removed from both the DOM and the map", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1", {}, ["_title", "a1"]));
    expect(result.structureChanged).toBe(true);
    expect(shape(dom.slidesEl)).toBe("_title a1");
    expect(dom.els.has("a2")).toBe(false);
    expect(dom.keys.has("a2")).toBe(false);
  });

  it("a single-slide section grows to several: wrapped in a stack; several shrink to one: the stack is removed", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1"));
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2", {}, ["_title", "a1"]));
    expect(shape(dom.slidesEl)).toBe("_title [a1,a2]");
    applyRenderedDeck(dom, rendered("_:_title|a:a1", {}, ["_title", "a1"]));
    expect(shape(dom.slidesEl)).toBe("_title a1");
    expect(dom.slidesEl.querySelectorAll(`.${STACK_CLASS}`)).toHaveLength(0);
  });

  it("dom.sections records the latest structure", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    expect(dom.sections).toEqual([{ id: "_title", slides: [{ id: "_title" }] }, { id: "a1", slides: [{ id: "a1" }, { id: "a2" }] }]);
  });
});

describe("media, transitions", () => {
  it("playingMedia returns only video / audio that is playing", () => {
    const root = document.createElement("div");
    root.innerHTML = "<video></video><audio></audio>";
    const [video, audio] = Array.from(root.querySelectorAll<HTMLMediaElement>("video, audio"));
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    expect(playingMedia(root)).toEqual([video]);
  });

  it("withoutTransition: .reveal carries kn-present-no-transition during run and loses it afterwards (also when run throws)", () => {
    const el = document.createElement("div");
    let during = false;
    withoutTransition(el, () => {
      during = el.classList.contains(NO_TRANSITION_CLASS);
    });
    expect(during).toBe(true);
    expect(el.classList.contains(NO_TRANSITION_CLASS)).toBe(false);
    expect(() => withoutTransition(el, () => { throw new Error("x"); })).toThrow("x");
    expect(el.classList.contains(NO_TRANSITION_CLASS)).toBe(false);
  });
});

describe("data-prevent-swipe", () => {
  afterEach(() => vi.unstubAllGlobals());

  function sized(scrollHeight: number, clientHeight: number): HTMLElement {
    const section = document.createElement("section");
    section.setAttribute(SLIDE_ID_ATTR, "s");
    Object.defineProperty(section, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(section, "clientHeight", { configurable: true, get: () => clientHeight });
    return section;
  }

  it("set only on overflow, removed when not overflowing", () => {
    const section = sized(900, 600);
    updateSwipeGuard(section);
    expect(section.hasAttribute("data-prevent-swipe")).toBe(true);
    Object.defineProperty(section, "scrollHeight", { configurable: true, get: () => 600 });
    updateSwipeGuard(section);
    expect(section.hasAttribute("data-prevent-swipe")).toBe(false);
  });

  it("a horizontally overflowing <pre> gets data-prevent-swipe, a non-overflowing one doesn't; toggles after a size change", () => {
    const section = sized(600, 600);
    const wide = document.createElement("pre");
    const narrow = document.createElement("pre");
    let wideScroll = 900;
    Object.defineProperty(wide, "scrollWidth", { configurable: true, get: () => wideScroll });
    Object.defineProperty(wide, "clientWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(narrow, "scrollWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(narrow, "clientWidth", { configurable: true, get: () => 300 });
    section.append(wide, narrow);
    updateSwipeGuard(section);
    expect(section.hasAttribute("data-prevent-swipe")).toBe(false); // The section itself doesn't overflow; the pre's flag is judged independently
    expect(wide.hasAttribute("data-prevent-swipe")).toBe(true);
    expect(narrow.hasAttribute("data-prevent-swipe")).toBe(false);
    wideScroll = 250;
    updateSwipeGuard(section);
    expect(wide.hasAttribute("data-prevent-swipe")).toBe(false);
  });

  it("a horizontally overflowing math block gets data-prevent-swipe, a non-overflowing one doesn't", () => {
    const section = sized(600, 600);
    const wide = document.createElement("div");
    const narrow = document.createElement("div");
    wide.className = narrow.className = "kn-present-math";
    Object.defineProperty(wide, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(wide, "clientWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(narrow, "scrollWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(narrow, "clientWidth", { configurable: true, get: () => 300 });
    section.append(wide, narrow);
    updateSwipeGuard(section);
    expect(wide.hasAttribute("data-prevent-swipe")).toBe(true);
    expect(narrow.hasAttribute("data-prevent-swipe")).toBe(false);
  });

  it("ResizeObserver, img load, loadedmetadata and details toggle all trigger a recompute", () => {
    const observed: Element[] = [];
    let callback: ResizeObserverCallback = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe(target: Element) { observed.push(target); }
      unobserve() {}
      disconnect() {}
    });
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1"));
    const els = dom.els.get("a1")!;
    let height = 100;
    Object.defineProperty(els.section, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(els.section, "clientHeight", { configurable: true, get: () => 500 });
    const guards = watchSwipeGuards(dom.slidesEl);
    guards.observe(els);
    expect(observed).toEqual([els.section, els.body]);

    height = 900;
    callback([{ target: els.body } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    expect(els.section.hasAttribute("data-prevent-swipe")).toBe(true);

    for (const [tag, type] of [["img", "load"], ["video", "loadedmetadata"], ["details", "toggle"]] as const) {
      height = 100;
      updateSwipeGuard(els.section);
      const child = document.createElement(tag);
      els.body.append(child);
      height = 900;
      child.dispatchEvent(new Event(type)); // Non-bubbling events: received in the capture phase
      expect(els.section.hasAttribute("data-prevent-swipe"), type).toBe(true);
    }
    guards.disconnect();
  });
});
