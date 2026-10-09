import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderedSection } from "./render";
import {
  applyRenderedDeck, createDeckDom, NO_TRANSITION_CLASS, playingMedia, SLIDE_ID_ATTR, STACK_CLASS,
  updateSwipeGuard, watchSwipeGuards, withoutTransition,
} from "./deck";

/** "a:a1,a2|b:b1" → RenderedSection[]；每張 content 是一個 <p>id@version</p>（version 讓「內容變了」可控）。 */
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
        return { id, kind: "heading" as const, titleOnly: id.endsWith("!"), key: `${id}@${v}`, content: reuse.includes(id) ? null : { fragment, mermaid: [] } };
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
  it("初次：單張章是頂層 section、多張章包 kn-present-stack；沒有任何 id／data-id（A11）", () => {
    const dom = createDeckDom();
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1,a2|b:b1"));
    expect(shape(dom.slidesEl)).toBe("_title [a1,a2] b1");
    expect(dom.slidesEl.querySelectorAll("[id], [data-id]")).toHaveLength(0);
    expect(result).toEqual({ structureChanged: true, changed: ["_title", "a1", "a2", "b1"] });
    expect(dom.revealEl.className).toBe("reveal");
    expect(dom.slidesEl.parentElement).toBe(dom.revealEl);
  });

  it("titleOnly → section 有 kn-slide-title-only；內容放在 .kn-slide-body", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|t:t!"));
    const els = dom.els.get("t!")!;
    expect(els.section.classList.contains("kn-slide-title-only")).toBe(true);
    expect(els.body.className).toBe("kn-slide-body");
    expect(els.body.textContent).toBe("t!@0");
  });

  it("結構不變、只有一張內容變 → structureChanged false、只換那張的 body；別張 body 子節點不動", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    const a1Child = dom.els.get("a1")!.body.firstChild;
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1,a2", { a2: 1 }, ["_title", "a1"]));
    expect(result).toEqual({ structureChanged: false, changed: ["a2"] });
    expect(dom.els.get("a1")!.body.firstChild).toBe(a1Child);
    expect(dom.els.get("a2")!.body.textContent).toBe("a2@1");
  });

  it("在目前那張之前插一章：沿用的元素不離開文件（起草裁定 10）", () => {
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

  it("刪掉一張：DOM 與 map 都移除", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    const result = applyRenderedDeck(dom, rendered("_:_title|a:a1", {}, ["_title", "a1"]));
    expect(result.structureChanged).toBe(true);
    expect(shape(dom.slidesEl)).toBe("_title a1");
    expect(dom.els.has("a2")).toBe(false);
    expect(dom.keys.has("a2")).toBe(false);
  });

  it("單張章長成多張：包進 stack；多張變單張：拆掉 stack", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1"));
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2", {}, ["_title", "a1"]));
    expect(shape(dom.slidesEl)).toBe("_title [a1,a2]");
    applyRenderedDeck(dom, rendered("_:_title|a:a1", {}, ["_title", "a1"]));
    expect(shape(dom.slidesEl)).toBe("_title a1");
    expect(dom.slidesEl.querySelectorAll(`.${STACK_CLASS}`)).toHaveLength(0);
  });

  it("dom.sections 記下最新結構", () => {
    const dom = createDeckDom();
    applyRenderedDeck(dom, rendered("_:_title|a:a1,a2"));
    expect(dom.sections).toEqual([{ id: "_title", slides: [{ id: "_title" }] }, { id: "a1", slides: [{ id: "a1" }, { id: "a2" }] }]);
  });
});

describe("media、轉場", () => {
  it("playingMedia 只回正在播的 video／audio", () => {
    const root = document.createElement("div");
    root.innerHTML = "<video></video><audio></audio>";
    const [video, audio] = Array.from(root.querySelectorAll<HTMLMediaElement>("video, audio"));
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    expect(playingMedia(root)).toEqual([video]);
  });

  it("withoutTransition：run 期間 .reveal 帶 kn-present-no-transition，之後拿掉（run 拋錯也拿掉）", () => {
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

describe("data-prevent-swipe（§6.8 ②）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function sized(scrollHeight: number, clientHeight: number): HTMLElement {
    const section = document.createElement("section");
    section.setAttribute(SLIDE_ID_ATTR, "s");
    Object.defineProperty(section, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(section, "clientHeight", { configurable: true, get: () => clientHeight });
    return section;
  }

  it("溢出才設、不溢出就拿掉", () => {
    const section = sized(900, 600);
    updateSwipeGuard(section);
    expect(section.hasAttribute("data-prevent-swipe")).toBe(true);
    Object.defineProperty(section, "scrollHeight", { configurable: true, get: () => 600 });
    updateSwipeGuard(section);
    expect(section.hasAttribute("data-prevent-swipe")).toBe(false);
  });

  it("橫向溢出的 <pre> 標 data-prevent-swipe、不溢出的不標，尺寸變化後切換", () => {
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
    expect(section.hasAttribute("data-prevent-swipe")).toBe(false); // section 自己沒溢出，pre 的標記獨立判斷
    expect(wide.hasAttribute("data-prevent-swipe")).toBe(true);
    expect(narrow.hasAttribute("data-prevent-swipe")).toBe(false);
    wideScroll = 250;
    updateSwipeGuard(section);
    expect(wide.hasAttribute("data-prevent-swipe")).toBe(false);
  });

  it("ResizeObserver、img load、loadedmetadata、details toggle 都觸發重算", () => {
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
      child.dispatchEvent(new Event(type)); // 不冒泡的事件：靠捕獲階段收
      expect(els.section.hasAttribute("data-prevent-swipe"), type).toBe(true);
    }
    guards.disconnect();
  });
});
