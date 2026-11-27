import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MATH_SCROLL_ATTR, TABLE_MORE_RIGHT_ATTR, supportsScrollTimeline, syncTableScrollHint, useTableScrollHint } from "./table-scroll-hint";

function scroller(metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number }): HTMLElement {
  const el = document.createElement("div");
  el.className = "tableWrapper";
  for (const [key, value] of Object.entries(metrics)) Object.defineProperty(el, key, { value, configurable: true, writable: true });
  return el;
}

function setup(...tables: HTMLElement[]) {
  const root = document.createElement("div");
  for (const table of tables) root.appendChild(table);
  document.body.appendChild(root);
  return { root, ref: { current: root } };
}

describe("syncTableScrollHint", () => {
  it("carries the attribute only when content remains to the right; less than 1px away or scrolled exactly to the end does not", () => {
    const el = scroller({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });
    syncTableScrollHint(el);
    expect(el).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(el, "scrollLeft", { value: 300 });
    syncTableScrollHint(el);
    expect(el).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(el, "scrollLeft", { value: 299.5 });
    syncTableScrollHint(el);
    expect(el).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });
});

describe("useTableScrollHint", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("support check looks at CSS.supports; without CSS.supports it counts as unsupported", () => {
    expect(supportsScrollTimeline()).toBe(false);
    vi.stubGlobal("CSS", { supports: (query: string) => query === "animation-timeline: scroll(self inline)" });
    expect(supportsScrollTimeline()).toBe(true);
    vi.stubGlobal("CSS", {});
    expect(supportsScrollTimeline()).toBe(false);
  });

  it("browsers supporting scroll-driven animation: pure CSS, the hook attaches no listener and sets no attribute", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const add = vi.spyOn(root, "addEventListener");
    renderHook(() => useTableScrollHint(ref, true));
    expect(add).not.toHaveBeenCalled();
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("marked at start according to whether it overflows: overflowing ones have it, others do not", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const narrow = scroller({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    const { ref } = setup(wide, narrow);
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    expect(narrow).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("scroll does not bubble: the container catches the table's own scroll with capture, and removes the attribute once scrolled to the end", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { ref } = setup(wide);
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "scrollLeft", { value: 500 });
    wide.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "scrollLeft", { value: 100 });
    wide.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("after a collapsed block expands (only data-show-children changes), a wide table inside is marked too", async () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const toggle = document.createElement("div");
    toggle.appendChild(wide);
    const { ref } = setup(toggle);
    // While collapsed the table has no width of its own: clientWidth equals scrollWidth, so there is no overflow.
    Object.defineProperty(wide, "clientWidth", { value: 800, configurable: true });
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "clientWidth", { value: 300, configurable: true });
    toggle.setAttribute("data-show-children", "true");
    await waitFor(() => expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR));
  });

  it("a rescan with unchanged state writes no attribute (so no attribute mutation, and it does not trigger itself)", async () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const narrow = scroller({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide, narrow);
    renderHook(() => useTableScrollHint(ref, true));
    const seen: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => seen.push(...records));
    watcher.observe(root, { attributes: true, subtree: true });
    root.appendChild(document.createElement("p")); // triggers a rescan
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attributeRecords = [...seen, ...watcher.takeRecords()].filter((record) => record.type === "attributes");
    watcher.disconnect();
    expect(attributeRecords).toHaveLength(0);
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("attaches one listener on the container, not one per table", () => {
    const tables = [1, 2, 3].map(() => scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 }));
    const { root, ref } = setup(...tables);
    const rootAdd = vi.spyOn(root, "addEventListener");
    const tableAdds = tables.map((table) => vi.spyOn(table, "addEventListener"));
    renderHook(() => useTableScrollHint(ref, true));
    expect(rootAdd).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    for (const add of tableAdds) expect(add).not.toHaveBeenCalled();
  });

  it("not phone (enabled=false): no listener, no attribute", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const add = vi.spyOn(root, "addEventListener");
    renderHook(() => useTableScrollHint(ref, false));
    expect(add).not.toHaveBeenCalled();
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("unmount removes the listener and the attribute", () => {
    const wide = scroller({ scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    const { root, ref } = setup(wide);
    const remove = vi.spyOn(root, "removeEventListener");
    const view = renderHook(() => useTableScrollHint(ref, true));
    view.unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });
});

describe("useTableScrollHint on math scrollers", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      cb();
      return 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function mathScroller(metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number }): HTMLElement {
    const el = scroller(metrics);
    el.className = "overflow-x-auto";
    el.setAttribute(MATH_SCROLL_ATTR, "");
    return el;
  }

  it("marks an overflowing formula scroller, clears it at the far right, and leaves a fitting one alone", () => {
    const wide = mathScroller({ scrollWidth: 899, clientWidth: 332, scrollLeft: 0 });
    const fits = mathScroller({ scrollWidth: 332, clientWidth: 332, scrollLeft: 0 });
    const { ref } = setup(wide, fits);
    renderHook(() => useTableScrollHint(ref, true));
    expect(wide).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    expect(fits).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
    Object.defineProperty(wide, "scrollLeft", { value: 567 });
    wide.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(wide).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });

  it("rescans when web fonts finish loading (KaTeX fonts change formula widths after first paint), and stops listening on unmount", () => {
    const listeners = new Map<string, () => void>();
    const fonts = {
      addEventListener: vi.fn((type: string, cb: () => void) => listeners.set(type, cb)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    };
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    try {
      const formula = mathScroller({ scrollWidth: 300, clientWidth: 332, scrollLeft: 0 });
      const { ref } = setup(formula);
      const view = renderHook(() => useTableScrollHint(ref, true));
      expect(formula).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
      Object.defineProperty(formula, "scrollWidth", { value: 899 });
      listeners.get("loadingdone")!();
      expect(formula).toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
      view.unmount();
      expect(fonts.removeEventListener).toHaveBeenCalledWith("loadingdone", expect.any(Function));
      expect(listeners.has("loadingdone")).toBe(false);
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it("ignores an overflowing element that is neither a table nor a marked formula scroller", () => {
    const other = scroller({ scrollWidth: 899, clientWidth: 332, scrollLeft: 0 });
    other.className = "overflow-x-auto";
    const { ref } = setup(other);
    renderHook(() => useTableScrollHint(ref, true));
    expect(other).not.toHaveAttribute(TABLE_MORE_RIGHT_ATTR);
  });
});
