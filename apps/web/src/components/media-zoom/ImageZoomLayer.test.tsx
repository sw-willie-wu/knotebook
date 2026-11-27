import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import i18n from "@/i18n";
import { MediaZoomContext, type MediaZoomApi } from "./context";
import { ImageZoomLayer, zoomButtonPlacement } from "./ImageZoomLayer";
import { prefetchMediaLightbox } from "./lightbox-chunk";

vi.mock("./lightbox-chunk", () => ({ loadMediaLightbox: vi.fn(), prefetchMediaLightbox: vi.fn() }));

// DOM hand-built after BlockNote's structure: .bn-block-outer > .bn-block > .bn-block-content[data-content-type=image] > resize frame > img.
const IMAGE = (id: string, extra = "") =>
  `<div class="bn-block-outer" data-id="${id}"><div class="bn-block"><div class="bn-block-content" data-content-type="image"><div class="bn-file-block-content-wrapper">
    <div class="bn-visual-media-wrapper">${extra}<img class="bn-visual-media" src="/api/uploads/x" alt="box.png" data-testid="${id}" /></div>
    <figcaption class="bn-file-caption">Cap</figcaption></div></div></div></div>`;
const BLOCKS = `
  ${IMAGE("img1")}
  <div class="bn-block-outer" data-id="p1"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">Body</p></div></div></div>
  <div class="bn-block-outer" data-id="f1"><div class="bn-block"><div class="bn-block-content" data-content-type="file"><div class="bn-file-name-with-icon">doc.pdf</div></div></div></div>
  <div class="bn-block-outer" data-id="lk"><div class="bn-block"><div class="bn-block-content" data-content-type="image"><div class="bn-visual-media-wrapper"><a href="https://example.com/a"><img class="bn-visual-media" src="/api/uploads/y" alt="linked" data-testid="linked" /></a></div></div></div></div>
  <div class="bn-block-column-list" data-node-type="columnList"><div class="bn-block-column" data-node-type="column">${IMAGE("imgc")}</div></div>`;

/** jsdom rects are all 0: pads geometry by selector (other elements still return 0). */
function stubRects(rects: Array<[string, DOMRect]>) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rects.find(([selector]) => this.matches(selector))?.[1] ?? new DOMRect(0, 0, 0, 0);
  });
}

function setLoaded(img: HTMLElement, loaded = true, size = { w: 800, h: 600 }) {
  Object.defineProperty(img, "complete", { configurable: true, value: loaded });
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: loaded ? size.w : 0 });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: loaded ? size.h : 0 });
}

function Host({ zoom, editable = true, html = BLOCKS }: { zoom: MediaZoomApi | null; editable?: boolean; html?: string }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  // Same element so rerender does not reset innerHTML (replacing the img would lose the loaded state the test set up)
  const blocks = useMemo(() => <div dangerouslySetInnerHTML={{ __html: html }} />, [html]);
  return (
    <MediaZoomContext.Provider value={zoom}>
      <div ref={setEl} className="relative" data-testid="col">
        {blocks}
        <ImageZoomLayer container={el} editable={editable} />
      </div>
    </MediaZoomContext.Provider>
  );
}

const img = (id = "img1") => screen.getByTestId(id);
const hoverImg = (id = "img1") => {
  setLoaded(img(id));
  fireEvent.pointerOver(img(id), { pointerType: "mouse" });
};
const zoomBtn = () => screen.queryByLabelText("Zoom in");

describe("#462 image zoom button floating layer", () => {
  let open: ReturnType<typeof vi.fn>;
  let zoom: MediaZoomApi;
  let spies: Array<{ mockRestore: () => void }> = [];
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    open = vi.fn();
    zoom = { open, isOpen: false };
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  it("hovering an image puts the button 4px inside the image's top-right corner", () => {
    // Column (100,50) width 800; image (300,100) width 400 height 300; button 20x24.
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
        ['[data-testid="img1"]', new DOMRect(300, 100, 400, 300)],
        ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
      ]),
    );
    render(<Host zoom={zoom} />);
    hoverImg();
    const layer = zoomBtn()!.parentElement!;
    expect(layer).toHaveAttribute("data-kb-zoom-layer");
    expect(layer.style.top).toBe("54px"); // image top 100 - column top 50 + 4
    expect(layer.style.left).toBe("576px"); // image right 700 - column left 100 - button width 20 - 4
  });

  it("an image inside a .kb-diff preview in a column: hover shows no button, read-only adds no tabindex, clicking does not open", () => {
    const html = `<div class="kb-diff">${IMAGE("dimg")}</div>`;
    render(<Host zoom={zoom} html={html} editable={false} />);
    setLoaded(img("dimg"));
    fireEvent.pointerOver(img("dimg"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
    expect(img("dimg")).not.toHaveAttribute("tabindex");
    fireEvent.click(img("dimg"));
    expect(open).not.toHaveBeenCalled();
  });

  it("hovering an image prefetches the zoom view (also when read-only); moving over a paragraph does not prefetch", () => {
    vi.mocked(prefetchMediaLightbox).mockClear();
    render(<Host zoom={zoom} editable={false} />);
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(prefetchMediaLightbox).not.toHaveBeenCalled();
    hoverImg();
    expect(prefetchMediaLightbox).toHaveBeenCalled();
  });

  it("a touch pointer does not show the button", () => {
    render(<Host zoom={zoom} />);
    setLoaded(img());
    fireEvent.pointerOver(img(), { pointerType: "touch" });
    expect(zoomBtn()).toBeNull();
  });

  it("moving over a paragraph, or the pointer leaving the whole column, hides it", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()).not.toBeNull();
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
    hoverImg();
    expect(zoomBtn()).not.toBeNull();
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(zoomBtn()).toBeNull();
  });

  it("broken or not-yet-loaded image: hover shows no button; dispatching load on the image then shows it", () => {
    render(<Host zoom={zoom} />);
    setLoaded(img(), true);
    setLoaded(img(), false); // naturalWidth 0, complete false
    fireEvent.pointerOver(img(), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
    setLoaded(img(), true);
    fireEvent.load(img());
    expect(zoomBtn()).not.toBeNull();
  });

  it("a file block showing only a file name (no img): no button", () => {
    render(<Host zoom={zoom} />);
    fireEvent.pointerOver(screen.getByText("doc.pdf"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
  });

  it("clicking the button calls open once with the image and caption; origin is the button and the image", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    const button = zoomBtn()!;
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      { kind: "image", src: expect.stringContaining("/api/uploads/x"), alt: "box.png", caption: "Cap", naturalWidth: 800, naturalHeight: 600 },
      { button, media: img() },
    );
  });

  it("zoom baseline is the larger of natural and rendered size, keeping the natural aspect ratio", () => {
    spies.push(stubRects([['[data-testid="img1"]', new DOMRect(0, 0, 400, 300)]]));
    render(<Host zoom={zoom} />);
    hoverImg();
    setLoaded(img(), true, { w: 800, h: 600 });
    fireEvent.click(zoomBtn()!);
    expect(open.mock.calls[0]![0]).toMatchObject({ naturalWidth: 800, naturalHeight: 600 });
    open.mockClear();
    setLoaded(img(), true, { w: 300, h: 150 });
    spies.push(stubRects([['[data-testid="img1"]', new DOMRect(0, 0, 600, 400)]]));
    fireEvent.click(zoomBtn()!);
    const source = open.mock.calls[0]![0] as { naturalWidth: number; naturalHeight: number };
    expect(source.naturalWidth).toBeCloseTo(800);
    expect(source.naturalHeight).toBeCloseTo(400);
  });

  it("short image (height 60): the button sits above the image, outside it; height 300: inside", () => {
    const imgRect = [new DOMRect(300, 100, 400, 60)];
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
        ['[data-testid="img1"]', imgRect[0]!],
        ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
      ]),
    );
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()!.parentElement!.style.top).toBe("26px"); // 100 - 50 - 24 (the button's bottom edge touches the image's top edge)
    spies.forEach((s) => s.mockRestore());
    spies = [
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
        ['[data-testid="img1"]', new DOMRect(300, 100, 400, 300)],
        ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
      ]),
    ];
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(zoomBtn()!.parentElement!.style.top).toBe("54px");
  });

  it("a short image's button sits above it: the button stays when the pointer moves to the image block's content area (outside the resize frame), the block outer frame, or the button itself", () => {
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
        ['[data-testid="img1"]', new DOMRect(300, 100, 400, 60)],
        ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
      ]),
    );
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()!.parentElement!.style.top).toBe("26px");
    fireEvent.pointerOver(img().closest(".bn-block-content")!, { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    fireEvent.pointerOver(img().closest(".bn-block-outer")!, { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    fireEvent.pointerOver(zoomBtn()!, { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
  });

  it("after the same image is pushed (size unchanged), another pointerover recomputes the button position", () => {
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
        ['[data-testid="img1"]', new DOMRect(300, 100, 400, 300)],
        ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
      ]),
    );
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()!.parentElement!.style.left).toBe("576px");
    spies[0]!.mockRestore();
    spies[0] = stubRects([
      ['[data-testid="col"]', new DOMRect(100, 50, 800, 2000)],
      ['[data-testid="img1"]', new DOMRect(340, 100, 400, 300)],
      ['[aria-label="Zoom in"]', new DOMRect(0, 0, 20, 24)],
    ]);
    fireEvent.pointerOver(img(), { pointerType: "mouse" });
    expect(zoomBtn()!.parentElement!.style.left).toBe("616px");
  });

  it("image load failure (error event, naturalWidth back to 0) hides the button", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()).not.toBeNull();
    setLoaded(img(), false);
    fireEvent.error(img());
    expect(zoomBtn()).toBeNull();
  });

  it("while the button has focus it only blocks hiding: it can switch to another image", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    act(() => zoomBtn()!.focus());
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    setLoaded(img("imgc"));
    fireEvent.pointerOver(img("imgc"), { pointerType: "mouse" });
    fireEvent.click(zoomBtn()!);
    expect(open.mock.calls.at(-1)![1].media).toBe(img("imgc"));
  });

  it("when the whole floating layer unmounts while the button has focus (Provider removed) and mounts again, it does not stay stuck on \"has focus\" and block hiding", () => {
    const { rerender } = render(<Host zoom={zoom} />);
    hoverImg();
    act(() => zoomBtn()!.focus());
    rerender(<Host zoom={null} />);
    expect(zoomBtn()).toBeNull();
    rerender(<Host zoom={zoom} />);
    hoverImg();
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
  });

  it("real image block: with showPreview=false there is no img.bn-visual-media and hover shows no button", async () => {
    function Real() {
      const [el, setEl] = useState<HTMLElement | null>(null);
      const editor = useCreateBlockNote({
        schema: noteSchema,
        initialContent: [{ type: "image", props: { url: "/api/uploads/z.png", name: "z.png", showPreview: false } }],
        resolveFileUrl: (url: string) => Promise.resolve(url),
      });
      return (
        <MediaZoomContext.Provider value={zoom}>
          <div ref={setEl} data-testid="real">
            <BlockNoteView editor={editor} />
            <ImageZoomLayer container={el} editable editor={editor} />
          </div>
        </MediaZoomContext.Provider>
      );
    }
    const { container } = render(<Real />);
    await waitFor(() => expect(container.querySelector('.bn-block-content[data-content-type="image"]')).not.toBeNull());
    expect(container.querySelector("img.bn-visual-media")).toBeNull();
    fireEvent.pointerOver(container.querySelector('.bn-block-content[data-content-type="image"]')!, { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
  });

  describe("zoomButtonPlacement", () => {
    const col = new DOMRect(0, 0, 800, 800);
    const btn = { width: 20, height: 24 };
    it("boundary between inside and outside: 4 + button height > half height - 15 - 4", () => {
      // half height - 19 is exactly 28 (button height 24 + 4): image height 94 is not short; 92 is short.
      expect(zoomButtonPlacement(new DOMRect(0, 100, 400, 94), col, btn).top).toBe(104);
      expect(zoomButtonPlacement(new DOMRect(0, 100, 400, 92), col, btn).top).toBe(76);
    });
  });

  describe("read-only", () => {
    it("the image is focusable; click, Enter and Space each open once (button null); when editable returns to true the attribute is removed and clicking does not open", () => {
      const { rerender } = render(<Host zoom={zoom} editable={false} />);
      setLoaded(img());
      expect(img()).toHaveAttribute("tabindex", "0");
      expect(img()).toHaveAttribute("data-kb-zoomable");
      expect(img()).toHaveAttribute("aria-label", "box.png, Zoom in");
      fireEvent.click(img());
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![1]).toEqual({ button: null, media: img() });
      fireEvent.keyDown(img(), { key: "Enter" });
      fireEvent.keyDown(img(), { key: " " });
      expect(open).toHaveBeenCalledTimes(3);
      rerender(<Host zoom={zoom} editable />);
      expect(img()).not.toHaveAttribute("tabindex");
      expect(img()).not.toHaveAttribute("data-kb-zoomable");
      expect(img()).not.toHaveAttribute("aria-label");
      fireEvent.click(img());
      expect(open).toHaveBeenCalledTimes(3);
    });

    it("an image not yet loaded is also marked first, and clicking does not open", () => {
      render(<Host zoom={zoom} editable={false} />);
      setLoaded(img(), false);
      expect(img()).toHaveAttribute("tabindex", "0");
      fireEvent.click(img());
      expect(open).not.toHaveBeenCalled();
    });

    it("an image inserted later is marked too", async () => {
      render(<Host zoom={zoom} editable={false} />);
      const wrap = screen.getByTestId("col");
      const outer = document.createElement("div");
      outer.innerHTML = IMAGE("late");
      act(() => {
        wrap.appendChild(outer);
      });
      await waitFor(() => expect(screen.getByTestId("late")).toHaveAttribute("tabindex", "0"));
    });

    it("an image wrapped in a link: clicking the image does not open", () => {
      render(<Host zoom={zoom} editable={false} />);
      setLoaded(img("linked"));
      fireEvent.click(img("linked"));
      expect(open).not.toHaveBeenCalled();
    });

    it("the button is hidden from assistive technology and not in the Tab order", () => {
      render(<Host zoom={zoom} editable={false} />);
      hoverImg();
      const button = screen.getByLabelText("Zoom in", { selector: "button" });
      expect(button).toHaveAttribute("tabindex", "-1");
      expect(button).toHaveAttribute("aria-hidden", "true");
      // A mouse click on this unfocusable button: origin.button is null, and after closing focus returns to the image itself
      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![1]).toEqual({ button: null, media: img() });
    });
  });

  it("on content change: while the button is shown the position is re-measured once per frame; with no button nothing is recomputed", () => {
    let fireChange = () => {};
    const editor = {
      prosemirrorView: { state: { selection: {} } },
      onSelectionChange: () => () => {},
      onChange: (cb: () => void) => {
        fireChange = cb;
        return () => {};
      },
    };
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    spies.push(raf);
    function EditorHost() {
      const [el, setEl] = useState<HTMLElement | null>(null);
      const blocks = useMemo(() => <div dangerouslySetInnerHTML={{ __html: BLOCKS }} />, []);
      return (
        <MediaZoomContext.Provider value={zoom}>
          <div ref={setEl} className="relative" data-testid="col">
            {blocks}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake editor has only the three members ImageZoomLayer uses */}
            <ImageZoomLayer container={el} editable editor={editor as any} />
          </div>
        </MediaZoomContext.Provider>
      );
    }
    render(<EditorHost />);
    fireChange();
    expect(raf, "沒有鈕：不排重算").not.toHaveBeenCalled();
    hoverImg();
    raf.mockClear();
    fireChange();
    expect(raf, "鈕顯示中：排一次重算").toHaveBeenCalledTimes(1);
  });

  it("pointerleave does not hide the button while zoom is open (isOpen)", () => {
    const { rerender } = render(<Host zoom={zoom} />);
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(zoomBtn()).not.toBeNull();
  });

  it("zoom just closed and focus has not been returned yet: the pointer being over another block does not hide the button either; if focus returns to the button it stays, otherwise it catches up with the pointer", async () => {
    const { rerender } = render(<Host zoom={zoom} />);
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    rerender(<Host zoom={zoom} />);
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    act(() => zoomBtn()!.focus());
    // Radix returns focus to the button in the next task (hence the setTimeout 0); the button still stays after that.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(zoomBtn()).not.toBeNull();
    expect(zoomBtn()).toHaveFocus();

    act(() => zoomBtn()!.blur());
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    rerender(<Host zoom={zoom} />);
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(zoomBtn()).toBeNull();
  });

  it("does not hide while the button has focus; hides only when it has lost focus and the pointer is not over the image", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    act(() => zoomBtn()!.focus());
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(zoomBtn()).not.toBeNull();
    act(() => zoomBtn()!.blur());
    expect(zoomBtn()).toBeNull();
  });

  it("without a Provider: nothing renders and the image gets no tabindex", () => {
    render(<Host zoom={null} editable={false} />);
    hoverImg();
    expect(zoomBtn()).toBeNull();
    expect(img()).not.toHaveAttribute("tabindex");
    fireEvent.click(img());
    expect(open).not.toHaveBeenCalled();
  });

  it("an image inside a column also has the button", () => {
    render(<Host zoom={zoom} />);
    hoverImg("imgc");
    expect(zoomBtn()).not.toBeNull();
  });

  it("uploaded viewBox-only SVG rendered wider than its browser fallback naturalWidth uses at least the rendered size as zoom baseline (#389)", () => {
    const html = `<div class="bn-block-outer" data-id="svg1"><div class="bn-block"><div class="bn-block-content" data-content-type="image"><div class="bn-file-block-content-wrapper">
      <div class="bn-visual-media-wrapper"><img class="bn-visual-media" src="/api/uploads/diagram-svg" alt="diagram.svg" data-testid="svg1" /></div>
      <figcaption class="bn-file-caption">Slide diagram</figcaption></div></div></div></div>`;
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(0, 0, 800, 2000)],
        ['[data-testid="svg1"]', new DOMRect(0, 0, 720, 405)],
      ]),
    );
    render(<Host zoom={zoom} html={html} />);
    // Browsers synthesize a small fallback naturalWidth (~267x150) for a viewBox-only SVG even when it fills the column.
    setLoaded(img("svg1"), true, { w: 267, h: 150 });
    fireEvent.pointerOver(img("svg1"), { pointerType: "mouse" });
    const button = zoomBtn();
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(open).toHaveBeenCalledTimes(1);
    const [source, origin] = open.mock.calls[0]!;
    expect(source).toMatchObject({
      kind: "image",
      src: expect.stringContaining("/api/uploads/diagram-svg"),
      alt: "diagram.svg",
      caption: "Slide diagram",
    });
    expect(source.naturalWidth).toBeGreaterThanOrEqual(720);
    expect(source.naturalHeight).toBeGreaterThanOrEqual(405);
    expect(source.naturalWidth / source.naturalHeight).toBeCloseTo(267 / 150, 5);
    expect(origin).toEqual({ button, media: img("svg1") });
  });

  it("CSS guard: during a drag-and-drop the zoom button layer takes no pointer and is hidden", () => {
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!, body: m[2]! }));
    const find = (decl: RegExp) => rules.find((r) => r.selector.includes(".kb-dragging [data-kb-zoom-layer]") && decl.test(r.body));
    const pe = find(/pointer-events:\s*none/);
    expect(pe).toBeDefined();
    expect(pe!.selector).toContain(".kb-dragging [data-kb-zoom-layer] *");
    expect(find(/visibility:\s*hidden/)).toBeDefined();
  });
});
