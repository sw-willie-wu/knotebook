import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { ThemeProvider } from "@/theme";
import { foldedIndexOf } from "@/lib/search-match";
import { PHONE_PAGE_SCROLL_ATTR, STICKY_TOP_VAR } from "@/lib/page-scroll";
import { stubLayoutTier } from "@/test/layout-tier";
import indexCssRaw from "../index.css?raw";
import { ANCHOR_FLASH_ATTR, ANCHOR_MARK_CLASS, ANCHOR_PENDING_CLASS, ANCHOR_SETTLE_MAX_MS, ANCHOR_WAIT_MS, findTextFromState, scrollToBlock, useBlockAnchor } from "./useBlockAnchor";
import { clearSearchMark } from "./search-mark";
import { findMatchBlock, sectionUnits } from "./block-find";

/**
 * #93: clicking a snippet jumps to the matching block. DOM follows BlockNote's shape (see `VersionPreview.tsx`):
 * `.bn-editor > .bn-block-group > .bn-block-outer[data-id] > .bn-block > .bn-block-content[data-content-type] > .bn-inline-content`,
 * nested child blocks sit in `.bn-block > .bn-block-group > .bn-block-outer`; a side-by-side row is
 * `[data-node-type="columnList"]` under `.bn-block-group`.
 */
type B = { id: string; type?: string; level?: number; text?: string; children?: B[]; extra?: string; inner?: string; attrs?: string; toggle?: "open" | "collapsed" };
const H = (id: string, level: number, text: string): B => ({ id, type: "heading", level, text });
const P = (id: string, text: string, children?: B[]): B => ({ id, type: "paragraph", text, ...(children ? { children } : {}) });

function outerHtml(b: B): string {
  const lvl = b.level === undefined ? "" : ` data-level="${b.level}"`;
  const kids = b.children?.length ? `<div class="bn-block-group">${b.children.map(outerHtml).join("")}</div>` : "";
  const inline = b.inner ?? `<p class="bn-inline-content">${b.text ?? ""}</p>`;
  const body = b.toggle ? `<div><div class="bn-toggle-wrapper" data-show-children="${b.toggle === "open" ? "true" : "false"}">${inline}</div></div>` : inline;
  return `<div class="bn-block-outer" data-id="${b.id}"><div class="bn-block"><div class="bn-block-content" data-content-type="${b.type ?? "paragraph"}"${lvl}${b.attrs ?? ""}>${b.extra ?? ""}${body}</div>${kids}</div></div>`;
}
function buildRoot(top: Array<B | { columns: B[][] }>): HTMLElement {
  const root = document.createElement("div");
  const units = top
    .map((u) =>
      "columns" in u
        ? `<div data-node-type="columnList">${u.columns.map((c) => `<div data-node-type="column"><div class="bn-block-group">${c.map(outerHtml).join("")}</div></div>`).join("")}</div>`
        : outerHtml(u),
    )
    .join("");
  root.innerHTML = `<div class="bn-editor"><div class="bn-block-group">${units}</div></div>`;
  document.body.appendChild(root);
  return root;
}

let root: HTMLElement | null = null;
afterEach(() => {
  root?.remove();
  root = null;
});
const idOf = (el: HTMLElement | null) => el?.getAttribute("data-id") ?? null;

describe("foldedIndexOf (matching shared by highlighting and jumping)", () => {
  it("case folds, fullwidth uppercase folds to fullwidth lowercase, fullwidth != halfwidth (the server's lower() does no NFKC), length-changing characters -> -1", () => {
    expect(foldedIndexOf("Hello NEEDLE", "needle")).toBe(6);
    expect(foldedIndexOf("ＡＢＣ", "ａｂｃ")).toBe(0);
    expect(foldedIndexOf("ABC", "ａｂｃ")).toBe(-1);
    expect(foldedIndexOf("İstanbul", "stan")).toBe(-1);
  });
});

describe("sectionUnits (splits the same way as sectionize in note-sections.ts)", () => {
  it("a heading of the same or a higher level starts a new section; deeper subheadings do not; _top is everything before the first heading", () => {
    root = buildRoot([P("t1", "top a"), H("h1", 1, "One"), P("a", "a"), H("h2", 2, "Sub"), P("b", "b"), H("h3", 1, "Two"), P("c", "c")]);
    expect(sectionUnits(root, "_top")!.map(idOf)).toEqual(["t1"]);
    expect(sectionUnits(root, "h1")!.map(idOf)).toEqual(["h1", "a", "h2", "b"]);
    expect(sectionUnits(root, "h3")!.map(idOf)).toEqual(["h3", "c"]);
    expect(sectionUnits(root, "nope")).toBeNull();
  });

  it("a # after a ## starts a new section (level <= current)", () => {
    root = buildRoot([H("h2", 2, "Sub"), P("a", "a"), H("h1", 1, "Top"), P("b", "b")]);
    expect(sectionUnits(root, "h2")!.map(idOf)).toEqual(["h2", "a"]);
    expect(sectionUnits(root, "h1")!.map(idOf)).toEqual(["h1", "b"]);
  });

  it("a heading inside a column does not split (a side-by-side row is one top-level unit)", () => {
    root = buildRoot([H("h1", 1, "One"), { columns: [[H("hc", 1, "In column")], [P("pc", "x")]] }, P("after", "after")]);
    const units = sectionUnits(root, "h1")!;
    expect(units).toHaveLength(3);
    expect(sectionUnits(root, "hc")).toBeNull();
  });
});

describe("findMatchBlock", () => {
  it("#399 several keywords: the first block in the section containing any of them; a quoted phrase is one keyword", () => {
    const root = buildRoot([H("h1", 2, "S"), P("a", "nothing"), P("b", "has beta"), P("c", "alpha and beta"), H("h2", 2, "T"), P("d", "alpha")]);
    expect(idOf(findMatchBlock(root, "h1", "alpha beta"))).toBe("b");
    expect(idOf(findMatchBlock(root, "h1", '"alpha and"'))).toBe("c");
    expect(findMatchBlock(root, "h1", "   ")).toBeNull();
    root.remove();
  });

  it("ordinary paragraph: first block with the text inside the range; a match outside the range does not count", () => {
    root = buildRoot([P("t1", "needle in top"), H("h1", 1, "One"), P("a", "nothing"), P("b", "has the Needle here"), P("c", "needle again"), H("h2", 1, "Two"), P("d", "needle")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("b");
    expect(idOf(findMatchBlock(root, "h2", "needle"))).toBe("d");
  });

  it("_top: from the start up to the first heading", () => {
    root = buildRoot([P("t1", "x"), P("t2", "a needle"), H("h1", 1, "One"), P("a", "needle")]);
    expect(idOf(findMatchBlock(root, "_top", "needle"))).toBe("t2");
    root.remove();
    root = buildRoot([P("t1", "x"), H("h1", 1, "One"), P("a", "needle")]);
    expect(findMatchBlock(root, "_top", "needle")).toBeNull();
  });

  it("nested list item: returns the innermost block that really contains the text, not the outer one", () => {
    root = buildRoot([H("h1", 1, "One"), P("outer", "parent item", [P("mid", "child", [P("deep", "grandchild needle")])]), P("z", "tail")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("deep");
  });

  it("match inside a column: returns that block inside the column", () => {
    root = buildRoot([H("h1", 1, "One"), { columns: [[P("l", "left")], [P("r", "right needle")]] }]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("r");
  });

  it("not found -> null (the caller falls back to the section heading); empty string -> null", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    expect(findMatchBlock(root, "h1", "needle")).toBeNull();
    expect(findMatchBlock(root, "h1", "")).toBeNull();
  });

  it("case and fullwidth: same rules as highlighting (toLowerCase; fullwidth uppercase folds to fullwidth lowercase; fullwidth != halfwidth)", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "ａｂｃ lower fullwidth"), P("b", "Mixed CASE here")]);
    expect(idOf(findMatchBlock(root, "h1", "case"))).toBe("b");
    expect(idOf(findMatchBlock(root, "h1", "ＡＢＣ"))).toBe("a");
    expect(findMatchBlock(root, "h1", "abc")).toBeNull();
  });

  it("code block language menu options do not count as text; a heading block's own text does", () => {
    root = buildRoot([
      H("h1", 1, "Needle title"),
      { id: "code", type: "codeBlock", text: "let x", extra: "<div><select><option>Needle lang</option></select></div>" },
    ]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("h1");
    root.remove();
    root = buildRoot([H("h1", 1, "One"), { id: "code", type: "codeBlock", text: "let x", extra: "<div><select><option>Needle lang</option></select></div>" }]);
    expect(findMatchBlock(root, "h1", "needle")).toBeNull();
  });
});

describe("collapsed toggle", () => {
  const T = (id: string, text: string, toggle: "open" | "collapsed", children: B[]): B => ({ id, type: "toggleListItem", text, toggle, children });

  it("match in a collapsed toggle's child (any depth) -> returns the outermost collapsed toggle, not the hidden child", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "collapsed", [P("c", "child needle", [P("d", "deep needle")])]), P("z", "tail")]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("t");
  });

  it("expanded toggle -> innermost block as usual; outer expanded and inner collapsed -> the collapsed inner one", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "open", [P("c", "child needle")])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("c");
    root.remove();
    root = buildRoot([H("h1", 1, "One"), T("t", "parent", "open", [T("u", "mid", "collapsed", [P("c", "child needle")])])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("u");
  });

  it("toggle's own text matches and it is collapsed -> returns itself", () => {
    root = buildRoot([H("h1", 1, "One"), T("t", "parent needle", "collapsed", [P("c", "x")])]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("t");
  });
});

describe("tables and mermaid", () => {
  it("table cells are <td><p> without .bn-inline-content: a match returns the table block", () => {
    root = buildRoot([
      H("h1", 1, "One"),
      P("a", "nothing"),
      { id: "tbl", type: "table", inner: "<table><tbody><tr><td><p>cell one</p></td><th><p>Needle head</p></th></tr></tbody></table>" },
    ]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("tbl");
  });

  it("mermaid reads data-code (the server index takes the code attribute)", () => {
    root = buildRoot([H("h1", 1, "One"), { id: "mm", type: "mermaid", inner: "<svg></svg>", attrs: ' data-code="graph TD; A--&gt;Needle"' }]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("mm");
  });

  // Hand-built DOM, not the real shape (see the real mounted editor test below): it only pins the attribute that is read.
  it("math reads data-tex (the server index takes the tex attribute)", () => {
    root = buildRoot([H("h1", 1, "One"), { id: "mt", type: "math", inner: "<span class=\"katex\"></span>", attrs: ' data-tex="\\frac{Needle}{2}"' }]);
    expect(idOf(findMatchBlock(root, "h1", "needle"))).toBe("mt");
  });

  it("math: text KaTeX renders is not matched, only the tex source is", () => {
    root = buildRoot([H("h1", 1, "One"), { id: "mt", type: "math", inner: '<span class="katex">Needle</span>', attrs: ' data-tex="\\frac{a}{2}"' }]);
    expect(findMatchBlock(root, "h1", "needle")).toBeNull();
  });
});

describe("duplicate ids", () => {
  it("a second heading with the same id -> only the first section is used (the server only takes the first)", () => {
    root = buildRoot([H("dup", 1, "One"), P("a", "first"), H("dup", 1, "One again"), P("b", "second needle")]);
    expect(sectionUnits(root, "dup")!.map(idOf)).toEqual(["dup", "a"]);
    expect(findMatchBlock(root, "dup", "needle")).toBeNull();
  });
});

describe("scrollToBlock + findText", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("match found -> scrolls to and highlights the block containing the text, not the heading", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    const cancel = scrollToBlock(root, "h1", "needle");
    const flash = root.querySelector(`[${ANCHOR_FLASH_ATTR}]`);
    expect(flash?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
    expect(root.querySelector('[data-id="b"]')!.scrollIntoView).toHaveBeenCalled();
    cancel();
  });

  it("not found in range -> falls back to the section heading; without findText -> heading as before", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    scrollToBlock(root, "h1", "needle")();
    root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.remove();
    const cancel = scrollToBlock(root, "h1");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("h1");
    cancel();
  });

  it("_top: match -> highlights that block; no match -> scrolls back to the top without highlighting", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    const c1 = scrollToBlock(root, "_top", "needle");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("t1");
    c1();
    root.remove();
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle")();
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)).toBeNull();
  });
});

describe("scroll position: search jumps scroll to the middle, ordinary anchors to the top", () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
  });
  const blocks = () => spy.mock.calls.map((c) => c[0]);

  it("findText with a match -> center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("findText but nothing found in range, falling back to the section heading -> also center", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing")]);
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("_top with a match -> center; _top without -> scrolls to the top (scrollIntoView is not called)", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    scrollToBlock(root, "_top", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
    root.remove();
    spy.mockClear();
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle")();
    expect(spy).not.toHaveBeenCalled();
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("ordinary #b- anchor (no findText) -> start", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    scrollToBlock(root, "h1")();
    expect(blocks()).toEqual([{ block: "start" }]);
  });

  it("the overlay sits on the matching block (not the heading); when centering, scroll aligns to that block's own line (.bn-block-content), not the whole outer", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    const cancel = scrollToBlock(root, "h1", "needle");
    expect(root.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
    const outer = root.querySelector<HTMLElement>('[data-id="b"]')!;
    expect(spy.mock.contexts[0]).toBe(outer.querySelector(":scope > .bn-block > .bn-block-content"));
    expect(spy.mock.contexts[0]).not.toBe(outer);
    cancel();
  });

  it("parent wraps many children: centering aligns to the parent's own line, not the outer containing all children; a child's own line is not selected", () => {
    root = buildRoot([H("h1", 1, "One"), P("parent", "the needle", [P("c1", "child 1"), P("c2", "child 2")])]);
    scrollToBlock(root, "h1", "needle")();
    const ctx = spy.mock.contexts[0] as HTMLElement;
    expect(ctx.closest(".bn-block-outer")!.getAttribute("data-id")).toBe("parent");
    expect(ctx.classList.contains("bn-block-content")).toBe(true);
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("when that line is taller than the scroll container -> falls back to start (still aligned to that line); not taller -> center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "the needle")]);
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 500 });
    const line = root.querySelector<HTMLElement>('[data-id="b"] > .bn-block > .bn-block-content')!;
    line.getBoundingClientRect = () => ({ height: 501 }) as DOMRect;
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "start" }]);
    expect(spy.mock.contexts[0]).toBe(line);
    spy.mockClear();
    line.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    scrollToBlock(root, "h1", "needle")();
    expect(blocks()).toEqual([{ block: "center" }]);
  });

  it("ordinary anchor (start) aligns to the outer itself, not the content line", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "x")]);
    scrollToBlock(root, "b")();
    expect(spy.mock.contexts[0]).toBe(root.querySelector('[data-id="b"]'));
  });

  describe("phone: the document scrolls (root sits inside the data-phone-page-scroll frame and does not scroll itself)", () => {
    let frame: HTMLElement;
    beforeEach(() => {
      stubLayoutTier("phone");
      vi.stubGlobal("innerHeight", 844);
      document.documentElement.style.setProperty(STICKY_TOP_VAR, "100px");
    });
    afterEach(() => {
      frame?.remove();
      document.documentElement.style.removeProperty(STICKY_TOP_VAR);
      vi.unstubAllGlobals();
    });
    function framed(r: HTMLElement): HTMLElement {
      frame = document.createElement("div");
      frame.setAttribute(PHONE_PAGE_SCROLL_ATTR, "");
      document.body.appendChild(frame);
      frame.appendChild(r);
      // root stretches to the full note height: what must be compared is the visible height (viewport 844 - header 100 = 744), not that.
      Object.defineProperty(r, "clientHeight", { configurable: true, value: 5000 });
      return r;
    }

    it("line taller than 'viewport minus header' -> start; not taller -> center", () => {
      root = framed(buildRoot([H("h1", 1, "One"), P("b", "the needle")]));
      const line = root.querySelector<HTMLElement>('[data-id="b"] > .bn-block > .bn-block-content')!;
      line.getBoundingClientRect = () => ({ height: 745 }) as DOMRect;
      scrollToBlock(root, "h1", "needle")();
      expect(blocks()).toEqual([{ block: "start" }]);
      spy.mockClear();
      line.getBoundingClientRect = () => ({ height: 744 }) as DOMRect;
      scrollToBlock(root, "h1", "needle")();
      expect(blocks()).toEqual([{ block: "center" }]);
    });

    it("_top without a match -> scrolls the document back to the top, root does not move", () => {
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      root = framed(buildRoot([P("t1", "plain"), H("h1", 1, "One")]));
      root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
      scrollToBlock(root, "_top", "needle")();
      expect(windowScroll).toHaveBeenCalledWith({ top: 0 });
      expect(root.scrollTo).not.toHaveBeenCalled();
      windowScroll.mockRestore();
    });

    it("useBlockAnchor's scrollToTop (same-note top link) -> scrolls the document back to the top", () => {
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      root = framed(buildRoot([P("t1", "plain")]));
      root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
      let api!: ReturnType<typeof useBlockAnchor>;
      render(
        <MemoryRouter initialEntries={["/n"]}>
          <Host root={root} onApi={(x) => (api = x)} />
        </MemoryRouter>,
      );
      api.scrollToTop();
      expect(windowScroll).toHaveBeenCalledWith({ top: 0 });
      expect(root.scrollTo).not.toHaveBeenCalled();
      windowScroll.mockRestore();
    });
  });

  function Host({ root: r, onApi }: { root: HTMLElement; onApi?: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey: "n1", ready: true, root: r, currentNoteId: "n1" });
    onApi?.(api);
    return null;
  }
  it("requestAnchor(id, findText) passes findText into scrollToBlock: flashes and scrolls to the matching block (center), not the heading; without findText it is the heading (start)", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    let api!: ReturnType<typeof useBlockAnchor>;
    render(
      <MemoryRouter initialEntries={["/n"]}>
        <Host root={root} onApi={(x) => (api = x)} />
      </MemoryRouter>,
    );
    const rootEl = root;
    const flashed = () => rootEl.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR) ?? null;
    act(() => api.requestAnchor("h1", "needle"));
    expect(flashed()).toBe("b");
    expect(blocks()).toEqual([{ block: "center" }]);
    rootEl.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.remove();
    spy.mockClear();
    act(() => api.requestAnchor("h1"));
    expect(flashed()).toBe("h1");
    expect(blocks()).toEqual([{ block: "start" }]);
  });

  it("via useBlockAnchor: only a #b- hash (a copied paragraph link) -> start; hash + state.kbFind (search jump) -> center", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "needle")]);
    const a = render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1" }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(blocks()).toEqual([{ block: "start" }]);
    a.unmount();
    spy.mockClear();
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(blocks()).toEqual([{ block: "center" }]);
  });
});

describe("persistent search marker", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    clearSearchMark();
    vi.useRealTimers();
  });
  const overlays = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ANCHOR_FLASH_ATTR}]`));
  const esc = (init: KeyboardEventInit = {}, after?: (e: KeyboardEvent) => void) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    if (after) window.addEventListener("keydown", after, { once: true });
    window.dispatchEvent(e);
    return e;
  };
  const fresh = () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "nothing"), P("b", "the needle")]);
    return root;
  };

  it("stays after the two flashes: a jump with findText still shows the overlay at 2 s and 10 s, and it is .kn-anchor-mark (persistent)", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    expect(overlays()).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    expect(overlays()[0]!.getAttribute(ANCHOR_FLASH_ATTR)).toBe("b");
  });

  it("flashing starts only after scrolling settles: pending at the jump (no mark class); pending while the target position keeps moving; two consecutive frames without movement -> becomes mark", () => {
    vi.useFakeTimers();
    const r = fresh();
    let top = 500;
    vi.spyOn(r.querySelector<HTMLElement>('[data-id="b"]')!, "getBoundingClientRect").mockImplementation(
      () => ({ top, left: 0, width: 100, height: 20, right: 100, bottom: top + 20, x: 0, y: top, toJSON: () => ({}) }),
    );
    scrollToBlock(r, "h1", "needle");
    const ov = overlays()[0]!;
    expect(ov.classList.contains(ANCHOR_PENDING_CLASS)).toBe(true);
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    for (let i = 0; i < 10; i++) {
      top -= 40; // scrolling: the position changes every frame
      vi.advanceTimersByTime(16);
    }
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(100); // stops
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    expect(ov.classList.contains(ANCHOR_PENDING_CLASS)).toBe(false);
  });

  it("continuous unsettled scrolling does not postpone flashing forever: it starts forcibly after ANCHOR_SETTLE_MAX_MS", () => {
    vi.useFakeTimers();
    const r = fresh();
    let top = 0;
    vi.spyOn(r.querySelector<HTMLElement>('[data-id="b"]')!, "getBoundingClientRect").mockImplementation(
      () => ({ top: (top += 7), left: 0, width: 1, height: 1, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) }),
    );
    scrollToBlock(r, "h1", "needle");
    vi.advanceTimersByTime(ANCHOR_SETTLE_MAX_MS - 50);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(100);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
  });

  it("after flashing starts, realignment only changes the position: same element, same class, not rebuilt (the animation does not replay)", async () => {
    vi.useFakeTimers();
    const r = fresh();
    scrollToBlock(r, "h1", "needle");
    vi.advanceTimersByTime(200);
    const ov = overlays()[0]!;
    expect(ov.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    const classBefore = ov.className;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((recs) => records.push(...recs));
    mo.observe(document.body, { childList: true, subtree: true });
    r.querySelector('[data-id="a"] .bn-inline-content')!.textContent = "changed";
    await vi.advanceTimersByTimeAsync(100);
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toBe(ov);
    expect(ov.className).toBe(classBefore);
    records.push(...mo.takeRecords());
    const touched = records.filter((rec) => rec.type === "childList" && [...rec.addedNodes, ...rec.removedNodes].includes(ov));
    expect(touched).toHaveLength(0);
    mo.disconnect();
  });

  it("under prefers-reduced-motion: reduce the search marker still enters the flash (JS ignores this setting, and CSS does not disable the .kn-anchor-mark animation)", () => {
    vi.useFakeTimers();
    const mm = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
    }));
    vi.stubGlobal("matchMedia", mm);
    try {
      scrollToBlock(fresh(), "h1", "needle");
      vi.advanceTimersByTime(200);
      expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // This part is only a string-level helper; the real-browser check is the reduce run of `e2e/tests/44-fulltext-search.spec.ts`, which samples the background color.
    // CSS: the rule that disables animation inside the reduced-motion block must exclude .kn-anchor-mark, and the mark rule itself must have an animation.
    const css = indexCssRaw.replace(/\r\n/g, "\n");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .kn-anchor-flash");
    expect(start).toBeGreaterThan(-1);
    const rmBlock = css.slice(start, css.indexOf("\n}\n", start) + 3);
    expect(rmBlock).toContain(":not(.kn-anchor-mark)");
    expect(rmBlock).not.toMatch(/\.kn-anchor-flash\.kn-anchor-mark/);
    expect(css).toMatch(/\.kn-anchor-flash\.kn-anchor-mark \{[^}]*animation: kn-anchor-mark/);
  });

  it("ordinary anchor (no findText) still disappears after 2 s and has no persistent class", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1");
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]!.classList.contains(ANCHOR_MARK_CLASS)).toBe(false);
    vi.advanceTimersByTime(2_100);
    expect(overlays()).toHaveLength(0);
  });

  it("Esc clears it; other keys do not", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    esc({ key: "a" });
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(0);
  });

  it("someone else's Esc is not stolen: already preventDefault'ed (a listener registered later calling preventDefault counts too), IME composing, a dialog open -> the marker stays", () => {
    vi.useFakeTimers();
    scrollToBlock(fresh(), "h1", "needle");
    esc({}, (e) => e.preventDefault());
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    esc({ isComposing: true });
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(1);
    dialog.remove();
    esc();
    vi.advanceTimersByTime(10);
    expect(overlays()).toHaveLength(0);
  });

  it("clearSearchMark() (closing search) clears it; calling it again is a no-op", () => {
    scrollToBlock(fresh(), "h1", "needle");
    expect(overlays()).toHaveLength(1);
    clearSearchMark();
    expect(overlays()).toHaveLength(0);
    clearSearchMark();
  });

  it("closing search while still waiting for the block to appear -> no marker shows up once the block appears", async () => {
    root = buildRoot([P("t1", "x")]);
    scrollToBlock(root, "nope", "needle");
    clearSearchMark();
    const late = document.createElement("div");
    late.className = "bn-block-outer";
    late.setAttribute("data-id", "nope");
    late.innerHTML = '<div class="bn-block"><div class="bn-block-content"><p class="bn-inline-content">needle</p></div></div>';
    root.appendChild(late);
    await new Promise((r) => setTimeout(r, 30));
    expect(overlays()).toHaveLength(0);
  });

  it("block re-rendered (element replaced, same data-id) -> marker stays and realigns; block deleted -> marker removed and no more lookups", async () => {
    const r = fresh();
    scrollToBlock(r, "h1", "needle");
    const old = r.querySelector<HTMLElement>('[data-id="b"]')!;
    const next = old.cloneNode(true) as HTMLElement;
    next.getBoundingClientRect = () => ({ top: 123, left: 7, width: 200, height: 30 }) as DOMRect;
    old.replaceWith(next);
    await waitFor(() => expect(overlays()[0]!.style.top).toBe("123px"));
    expect(overlays()).toHaveLength(1);
    next.remove();
    await waitFor(() => expect(overlays()).toHaveLength(0));
  });

  it("no match, parked at _top: no overlay means no marker (scrolled back to the top)", () => {
    root = buildRoot([P("t1", "plain"), H("h1", 1, "One")]);
    root.scrollTo = vi.fn() as unknown as typeof root.scrollTo;
    scrollToBlock(root, "_top", "needle");
    expect(overlays()).toHaveLength(0);
    expect(root.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  function Host({ root: r, noteKey, onApi }: { root: HTMLElement; noteKey: string; onApi?: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey, ready: true, root: r, currentNoteId: noteKey });
    onApi?.(api);
    return null;
  }
  const hostUi = (r: HTMLElement, k: string, onApi: (api: ReturnType<typeof useBlockAnchor>) => void) => (
    <MemoryRouter initialEntries={["/n"]}>
      <Host root={r} noteKey={k} onApi={onApi} />
    </MemoryRouter>
  );

  it("clicking another search result: old marker removed and moved to the new position (one on screen)", () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha"), H("h2", 1, "Two"), P("b", "beta")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["a"]);
    act(() => api.requestAnchor("h2", "beta"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["b"]);
  });

  it("an ordinary anchor inside the note (wikilink / #b-) does not clear the search marker; it disappears itself after 2 s and the marker stays", () => {
    vi.useFakeTimers();
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha"), H("h2", 1, "Two"), P("b", "beta")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    act(() => api.requestAnchor("h2"));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR)).sort()).toEqual(["a", "h2"]);
    act(() => void vi.advanceTimersByTime(2_100));
    expect(overlays().map((o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["a"]);
  });

  it("leaving this note (noteKey changes) -> the marker disappears and does not carry over to another note", () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "alpha")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    const view = render(hostUi(r, "n1", (x) => (api = x)));
    act(() => api.requestAnchor("h1", "alpha"));
    expect(overlays()).toHaveLength(1);
    view.rerender(hostUi(r, "n2", (x) => (api = x)));
    expect(overlays()).toHaveLength(0);
  });
});

describe("useBlockAnchor reads navigation state (another note / full page load)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function Host({ root: r }: { root: HTMLElement }) {
    useBlockAnchor({ noteKey: "n1", ready: true, root: r, currentNoteId: "n1" });
    return null;
  }
  const flashed = () => document.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR) ?? null;

  it("hash + state.kbFind -> the block containing the text flashes", () => {
    root = buildRoot([H("h1", 1, "One"), P("a", "x"), P("b", "needle")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("b");
  });

  it("hash only (no state, e.g. a copied link) -> the heading flashes", () => {
    root = buildRoot([H("h1", 1, "One"), P("b", "needle")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", hash: "#b-h1" }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("h1");
  });

  it("no hash, only state (_top snippet) -> searches within the _top range", () => {
    root = buildRoot([P("t1", "a needle"), H("h1", 1, "One")]);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/n", state: { kbFind: "needle" } }]}>
        <Host root={root} />
      </MemoryRouter>,
    );
    expect(flashed()).toBe("t1");
  });

  it("findTextFromState accepts only non-empty strings", () => {
    expect(findTextFromState({ kbFind: "x" })).toBe("x");
    expect(findTextFromState({ kbFind: "" })).toBeNull();
    expect(findTextFromState({ kbFind: 3 })).toBeNull();
    expect(findTextFromState(null)).toBeNull();
  });
});

describe("search marker cancellation: exceptions while waiting for readiness, and Esc", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    clearSearchMark();
    vi.useRealTimers();
    document.querySelectorAll("li[data-swipe-direction], .ProseMirror").forEach((n) => n.remove());
  });
  const ovs = () => Array.from(document.querySelectorAll<HTMLElement>(`[${ANCHOR_FLASH_ATTR}]`));
  function RHost({ root: r, ready, onApi }: { root: HTMLElement; ready: boolean; onApi: (api: ReturnType<typeof useBlockAnchor>) => void }) {
    const api = useBlockAnchor({ noteKey: "n1", ready, root: r, currentNoteId: "n1" });
    onApi(api);
    return null;
  }
  const ui = (r: HTMLElement, ready: boolean, onApi: (api: ReturnType<typeof useBlockAnchor>) => void) => (
    <MemoryRouter initialEntries={["/n"]}>
      <RHost root={r} ready={ready} onApi={onApi} />
    </MemoryRouter>
  );
  const pendingSetup = () => {
    const r = buildRoot([H("h1", 1, "One"), P("a", "the needle")]);
    root = r;
    let api!: ReturnType<typeof useBlockAnchor>;
    const view = render(ui(r, false, (x) => (api = x)));
    act(() => api.requestAnchor("h1", "needle"));
    expect(ovs()).toHaveLength(0);
    return { r, view, setApi: (x: ReturnType<typeof useBlockAnchor>) => (api = x) };
  };

  it("closing search while not ready (pending) -> still scrolls over once ready, but leaves no marker", () => {
    const { r, view, setApi } = pendingSetup();
    clearSearchMark();
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("Esc while not ready -> still scrolls once ready, but leaves no marker", async () => {
    const { r, view, setApi } = pendingSetup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 10));
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("nobody cancels: the marker stays once ready (control); the next jump does not inherit the previous cancellation", () => {
    const { r, view, setApi } = pendingSetup();
    clearSearchMark();
    view.rerender(ui(r, true, setApi));
    expect(ovs()).toHaveLength(0);
    let api2!: ReturnType<typeof useBlockAnchor>;
    view.rerender(ui(r, true, (x) => (api2 = x)));
    act(() => api2.requestAnchor("h1", "needle"));
    expect(ovs()).toHaveLength(1);
  });

  /** Simulates BlockNote's OverrideEscape: Esc with focus in the editor -> blur() first, then ProseMirror preventDefault. */
  function editor(onKey: (e: KeyboardEvent, pm: HTMLElement) => void): HTMLElement {
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    pm.tabIndex = 0;
    pm.addEventListener("keydown", (e) => onKey(e, pm));
    document.body.appendChild(pm);
    pm.focus();
    return pm;
  }
  const mark = () => {
    vi.useFakeTimers();
    root = buildRoot([H("h1", 1, "One"), P("a", "the needle")]);
    scrollToBlock(root, "h1", "needle");
    vi.advanceTimersByTime(200);
    expect(ovs()).toHaveLength(1);
  };
  const escOn = (el: Element) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  it("Esc with focus in the editor: BlockNote blurs then preventDefault -> this one press clears the marker (no double press)", () => {
    const pm = editor((e, el) => {
      el.blur();
      e.preventDefault();
    });
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(0);
  });

  it("slash menu's Esc (preventDefault, focus stays in the editor) -> the marker stays", () => {
    const pm = editor((e) => e.preventDefault());
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("AI box / mermaid Esc (stopPropagation, window never receives it) -> the marker stays", () => {
    const pm = editor((e, el) => {
      el.blur();
      e.preventDefault();
      e.stopPropagation();
    });
    mark();
    escOn(pm);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("Esc preventDefault'ed elsewhere outside the editor (focus on body) -> the marker stays", () => {
    mark();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
    document.body.dispatchEvent(e);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
  });

  it("a toast is open at keypress: that Esc only closes the toast (Radix does not preventDefault) and the marker stays; the next Esc after the toast closes clears it", () => {
    mark();
    const toast = document.createElement("li");
    toast.setAttribute("data-swipe-direction", "right");
    toast.setAttribute("data-state", "open");
    document.body.appendChild(toast);
    escOn(document.body);
    toast.setAttribute("data-state", "closed"); // real browser: the toast may already be closed by the time it bubbles
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(1);
    escOn(document.body);
    vi.advanceTimersByTime(10);
    expect(ovs()).toHaveLength(0);
  });
});

describe("math in a real mounted editor", () => {
  // The hand-built DOM above is not the real shape: a React block gets an extra `.react-renderer` wrapper between `.bn-block` and `.bn-block-content`.
  it("a search for the tex source finds the math block (the real DOM wraps the content in .react-renderer)", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { id: "h1", type: "heading", props: { level: 1 }, content: "One" },
        { id: "mt", type: "math", props: { tex: "\\frac{Needle}{2}" } },
        { id: "mm", type: "mermaid", props: { code: "graph TD; A-->Needle" } },
      ] as never,
    });
    const { container, unmount } = render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <BlockNoteView editor={editor} editable={false} />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    try {
      await waitFor(() => expect(container.querySelector('[data-content-type="math"][data-tex]')).not.toBeNull());
      expect(idOf(findMatchBlock(container, "h1", "needle"))).toBe("mt");
    } finally {
      unmount();
    }
  });

  it("a math child block is matched as itself, not counted on its parent list item", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { id: "h1", type: "heading", props: { level: 1 }, content: "One" },
        { id: "li", type: "bulletListItem", content: "item", children: [{ id: "mchild", type: "math", props: { tex: "x_{Kid}" } }] },
      ] as never,
    });
    const { container, unmount } = render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <BlockNoteView editor={editor} editable={false} />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    try {
      await waitFor(() => expect(container.querySelector('[data-content-type="math"][data-tex]')).not.toBeNull());
      expect(idOf(findMatchBlock(container, "h1", "kid"))).toBe("mchild");
    } finally {
      unmount();
    }
  });
});

describe("search jump while a math block's node view has not rendered yet", () => {
  // Shape copied from the production build at the moment the jump ran: the React node view is mounted as an empty
  // `.react-renderer.node-math` shell, and its `.bn-block-content[data-tex]` arrives on a later React commit.
  const shell = (id: string, type = "math") =>
    `<div class="bn-block-outer" data-node-type="blockOuter" data-id="${id}"><div class="bn-block" data-node-type="blockContainer" data-id="${id}"><div class="react-renderer node-${type} bn-react-node-view-renderer" contenteditable="false"></div></div></div>`;
  const filled = (tex: string) => `<div class="bn-block-content" data-content-type="math" data-tex="${tex}"><span class="katex"></span></div>`;
  const build = (units: string[]) => {
    root = document.createElement("div");
    root.innerHTML = `<div class="bn-editor"><div class="bn-block-group">${units.join("")}</div></div>`;
    document.body.appendChild(root);
    return root;
  };
  const heading = (id: string, text: string) => outerHtml(H(id, 1, text));
  const flashed = () => root!.querySelector(`[${ANCHOR_FLASH_ATTR}]`)?.getAttribute(ANCHOR_FLASH_ATTR) ?? null;
  const renderShell = (id: string, tex: string) => {
    root!.querySelector(`[data-id="${id}"] .react-renderer`)!.innerHTML = filled(tex);
  };
  const flushObservers = () => act(async () => {
    await Promise.resolve();
  });

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the formula to render, then highlights the formula, not the section heading", async () => {
    const r = build([heading("h1", "One"), shell("mt"), outerHtml(P("p", "after"))]);
    const cancel = scrollToBlock(r, "h1", "needle");
    expect(flashed()).toBeNull();
    renderShell("mt", "\\frac{Needle}{2}");
    await flushObservers();
    expect(flashed()).toBe("mt");
    cancel();
  });

  it("_top: waits for the formula to render, then highlights it instead of scrolling to the top", async () => {
    const r = build([shell("mt"), heading("h1", "One")]);
    r.scrollTo = vi.fn() as unknown as typeof r.scrollTo;
    const cancel = scrollToBlock(r, "_top", "needle");
    renderShell("mt", "x_{Needle}");
    await flushObservers();
    expect(flashed()).toBe("mt");
    expect(r.scrollTo).not.toHaveBeenCalled();
    cancel();
  });

  it("a formula earlier in the section is matched before a later paragraph once it renders (document order)", async () => {
    const r = build([heading("h1", "One"), shell("mt"), outerHtml(P("p", "needle in text"))]);
    const cancel = scrollToBlock(r, "h1", "needle");
    renderShell("mt", "\\text{needle}");
    await flushObservers();
    expect(flashed()).toBe("mt");
    cancel();
  });

  it("rendered formula without the word -> falls back to the heading", async () => {
    const r = build([heading("h1", "One"), shell("mt")]);
    const cancel = scrollToBlock(r, "h1", "needle");
    renderShell("mt", "a + b");
    await flushObservers();
    expect(flashed()).toBe("h1");
    cancel();
  });

  it("a formula that never renders -> after the wait cap, falls back to the heading (the jump is not lost)", () => {
    vi.useFakeTimers();
    const r = build([heading("h1", "One"), shell("mt")]);
    const cancel = scrollToBlock(r, "h1", "needle");
    expect(flashed()).toBeNull();
    vi.advanceTimersByTime(ANCHOR_WAIT_MS);
    expect(flashed()).toBe("h1");
    cancel();
  });

  it("closing the search while waiting cancels the jump: nothing is highlighted later", async () => {
    const r = build([heading("h1", "One"), shell("mt")]);
    const cancel = scrollToBlock(r, "h1", "needle");
    cancel();
    renderShell("mt", "\\text{needle}");
    await flushObservers();
    expect(flashed()).toBeNull();
  });

  it("only math is waited for: an unrendered mermaid shell and plain anchors behave as before (immediate)", () => {
    const r = build([heading("h1", "One"), shell("mm", "mermaid"), shell("mt")]);
    const plain = scrollToBlock(r, "h1");
    expect(flashed()).toBe("h1"); // no findText: no waiting
    plain();
    r.querySelector('[data-id="mt"]')!.remove();
    const cancel = scrollToBlock(r, "h1", "needle");
    expect(flashed()).toBe("h1");
    cancel();
  });
});
