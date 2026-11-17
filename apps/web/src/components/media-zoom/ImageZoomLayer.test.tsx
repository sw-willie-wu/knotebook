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

// DOM 照 BlockNote 的結構手造：.bn-block-outer > .bn-block > .bn-block-content[data-content-type=image] > 調寬框 > img。
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

/** jsdom 的 rect 全是 0：依 selector 墊幾何（其餘元素照舊回 0）。 */
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
  // 同一個元素才不會在 rerender 時重設 innerHTML（換掉 img，測試墊的載入狀態就跟著丟了）
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

describe("#462 圖片放大鈕浮動層", () => {
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

  it("滑鼠移到圖上 → 鈕在圖右上角內側 4px", () => {
    // 欄 (100,50) 寬 800；圖 (300,100) 寬 400 高 300；鈕 20×24。
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
    expect(layer.style.top).toBe("54px"); // 圖上緣 100 − 欄上緣 50 + 4
    expect(layer.style.left).toBe("576px"); // 圖右緣 700 − 欄左緣 100 − 鈕寬 20 − 4
  });

  it("欄內 .kb-diff 預覽裡的圖：hover 沒有鈕、唯讀時不加 tabindex、點了不開", () => {
    const html = `<div class="kb-diff">${IMAGE("dimg")}</div>`;
    render(<Host zoom={zoom} html={html} editable={false} />);
    setLoaded(img("dimg"));
    fireEvent.pointerOver(img("dimg"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
    expect(img("dimg")).not.toHaveAttribute("tabindex");
    fireEvent.click(img("dimg"));
    expect(open).not.toHaveBeenCalled();
  });

  it("滑鼠移到圖上就預取放大畫面（唯讀也一樣）；移到段落上不預取", () => {
    vi.mocked(prefetchMediaLightbox).mockClear();
    render(<Host zoom={zoom} editable={false} />);
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(prefetchMediaLightbox).not.toHaveBeenCalled();
    hoverImg();
    expect(prefetchMediaLightbox).toHaveBeenCalled();
  });

  it("觸控的 pointer 不顯示鈕", () => {
    render(<Host zoom={zoom} />);
    setLoaded(img());
    fireEvent.pointerOver(img(), { pointerType: "touch" });
    expect(zoomBtn()).toBeNull();
  });

  it("移到段落上、或 pointer 離開整個欄 → 收起", () => {
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

  it("壞圖或還沒載好 → hover 也沒有鈕；載好後在圖上派 load → 鈕出現", () => {
    render(<Host zoom={zoom} />);
    setLoaded(img(), true);
    setLoaded(img(), false); // naturalWidth 0、complete false
    fireEvent.pointerOver(img(), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
    setLoaded(img(), true);
    fireEvent.load(img());
    expect(zoomBtn()).not.toBeNull();
  });

  it("只顯示檔名的檔案 block（沒有 img）→ 沒有鈕", () => {
    render(<Host zoom={zoom} />);
    fireEvent.pointerOver(screen.getByText("doc.pdf"), { pointerType: "mouse" });
    expect(zoomBtn()).toBeNull();
  });

  it("點鈕 → open 一次，帶圖與 caption；origin 是鈕與圖", () => {
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

  it("圖矮（高 60）→ 鈕放在圖外上方；高 300 → 內側", () => {
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
    expect(zoomBtn()!.parentElement!.style.top).toBe("26px"); // 100 − 50 − 24（下緣貼圖的上緣）
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

  it("矮圖的鈕在圖外上方：pointer 移到圖的 block 內容區（調寬框外）、block 外框或鈕本身，鈕都還在", () => {
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

  it("同一張圖被推動（尺寸不變）後再 pointerover → 鈕位置重算", () => {
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

  it("圖載入失敗（error 事件、naturalWidth 歸 0）→ 鈕收起", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    expect(zoomBtn()).not.toBeNull();
    setLoaded(img(), false);
    fireEvent.error(img());
    expect(zoomBtn()).toBeNull();
  });

  it("鈕有焦點時只擋收起：可以換成別張圖", () => {
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

  it("鈕有焦點時整個浮動層卸載（Provider 拿掉）再裝回：不會卡在「有焦點」而擋住收起", () => {
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

  it("真的 image block：showPreview=false 時沒有 img.bn-visual-media，hover 沒有鈕", async () => {
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
    it("內側／外側的分界：4 + 鈕高 > 半高 − 15 − 4", () => {
      // 半高 − 19 恰為 28（鈕高 24 + 4）→ 圖高 94：不算矮；高 92：矮。
      expect(zoomButtonPlacement(new DOMRect(0, 100, 400, 94), col, btn).top).toBe(104);
      expect(zoomButtonPlacement(new DOMRect(0, 100, 400, 92), col, btn).top).toBe(76);
    });
  });

  describe("唯讀", () => {
    it("圖可聚焦；點圖、Enter、Space 各開一次（button null）；editable 改回 true → 屬性拿掉、點圖不開", () => {
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

    it("尚未載好的圖也先標屬性，點下去不開", () => {
      render(<Host zoom={zoom} editable={false} />);
      setLoaded(img(), false);
      expect(img()).toHaveAttribute("tabindex", "0");
      fireEvent.click(img());
      expect(open).not.toHaveBeenCalled();
    });

    it("之後才插進來的圖也會被標上", async () => {
      render(<Host zoom={zoom} editable={false} />);
      const wrap = screen.getByTestId("col");
      const outer = document.createElement("div");
      outer.innerHTML = IMAGE("late");
      act(() => {
        wrap.appendChild(outer);
      });
      await waitFor(() => expect(screen.getByTestId("late")).toHaveAttribute("tabindex", "0"));
    });

    it("圖包在連結裡 → 點圖不開", () => {
      render(<Host zoom={zoom} editable={false} />);
      setLoaded(img("linked"));
      fireEvent.click(img("linked"));
      expect(open).not.toHaveBeenCalled();
    });

    it("鈕對輔助科技隱藏、不進 Tab 順序", () => {
      render(<Host zoom={zoom} editable={false} />);
      hoverImg();
      const button = screen.getByLabelText("Zoom in", { selector: "button" });
      expect(button).toHaveAttribute("tabindex", "-1");
      expect(button).toHaveAttribute("aria-hidden", "true");
      // 滑鼠點這顆不可聚焦的鈕：origin.button 是 null，關掉後焦點回圖本身
      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![1]).toEqual({ button: null, media: img() });
    });
  });

  it("內容變動：鈕顯示中才每幀重量一次位置，沒有鈕時不重算", () => {
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
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- 假編輯器只有 ImageZoomLayer 用到的三個成員 */}
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

  it("放大開著（isOpen）時 pointerleave 不收鈕", () => {
    const { rerender } = render(<Host zoom={zoom} />);
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(zoomBtn()).not.toBeNull();
  });

  it("放大剛關掉、焦點還沒還回來：指標在別的區塊也先不收；焦點回到鈕就留著，沒回來才追上指標", async () => {
    const { rerender } = render(<Host zoom={zoom} />);
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    rerender(<Host zoom={zoom} />);
    // 關掉的同一個 task 裡指標底下是段落：鈕還在
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    // 焦點還回鈕（Radix 在下一個 task 做）：之後也不收
    act(() => zoomBtn()!.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(zoomBtn()).not.toBeNull();
    expect(zoomBtn()).toHaveFocus();

    // 再開一次、關掉後焦點沒回到鈕：凍結結束就追上指標（段落 ⇒ 收起）
    act(() => zoomBtn()!.blur());
    hoverImg();
    rerender(<Host zoom={{ open, isOpen: true }} />);
    rerender(<Host zoom={zoom} />);
    fireEvent.pointerOver(screen.getByText("Body"), { pointerType: "mouse" });
    expect(zoomBtn()).not.toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(zoomBtn()).toBeNull();
  });

  it("鈕有焦點時不收起；失焦且 pointer 不在圖上才收", () => {
    render(<Host zoom={zoom} />);
    hoverImg();
    act(() => zoomBtn()!.focus());
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(zoomBtn()).not.toBeNull();
    act(() => zoomBtn()!.blur());
    expect(zoomBtn()).toBeNull();
  });

  it("沒有 Provider → 不渲染、圖沒有被加 tabindex", () => {
    render(<Host zoom={null} editable={false} />);
    hoverImg();
    expect(zoomBtn()).toBeNull();
    expect(img()).not.toHaveAttribute("tabindex");
    fireEvent.click(img());
    expect(open).not.toHaveBeenCalled();
  });

  it("並排欄裡的圖一樣有鈕", () => {
    render(<Host zoom={zoom} />);
    hoverImg("imgc");
    expect(zoomBtn()).not.toBeNull();
  });

  it("CSS 守衛：拖放中放大鈕浮動層不接指標、且隱藏", () => {
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ selector: m[1]!, body: m[2]! }));
    const find = (decl: RegExp) => rules.find((r) => r.selector.includes(".kb-dragging [data-kb-zoom-layer]") && decl.test(r.body));
    const pe = find(/pointer-events:\s*none/);
    expect(pe).toBeDefined();
    expect(pe!.selector).toContain(".kb-dragging [data-kb-zoom-layer] *");
    expect(find(/visibility:\s*hidden/)).toBeDefined();
  });
});
