import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { MediaLightbox } from "./MediaLightbox";
import type { ZoomSource } from "./context";
import { fitView, wheelFactor, zoomAt, type Size } from "./zoom-math";

// jsdom 沒有 PointerEvent；補一個帶 pointerId／pointerType 的 MouseEvent，讓 clientX／clientY 等欄位進得去。
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

const HINT_EN =
  "Scroll or pinch to zoom and drag to move. Press + or - to zoom, 0 to fit, the arrow keys to move, and Esc to close.";

let viewportSize: Size = { width: 1000, height: 800 };
let observerCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(cb: () => void) {
    observerCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function isViewport(el: Element): boolean {
  return el.hasAttribute("data-zoom-viewport");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  viewportSize = { width: 1000, height: 800 };
  observerCallbacks = [];
  vi.stubGlobal("PointerEvent", FakePointerEvent);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return isViewport(this) ? viewportSize.width : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isViewport(this) ? viewportSize.height : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return isViewport(this) ? new DOMRect(0, 0, viewportSize.width, viewportSize.height) : new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BIG: Size = { width: 2000, height: 1000 };

function image(over: Partial<Extract<ZoomSource, { kind: "image" }>> = {}): ZoomSource {
  return { kind: "image", src: "/uploads/alice.png", alt: "alice.png", caption: "Cap", naturalWidth: 2000, naturalHeight: 1000, ...over };
}

function setup(source: ZoomSource = image()) {
  const onClose = vi.fn();
  const restoreFocus = vi.fn();
  render(<MediaLightbox source={source} onClose={onClose} restoreFocus={restoreFocus} />);
  const dialog = screen.getByRole("dialog");
  const viewport = dialog.querySelector<HTMLElement>("[data-zoom-viewport]")!;
  return { onClose, restoreFocus, dialog, viewport };
}

function img(): HTMLImageElement {
  return screen.getByRole("dialog").querySelector("img")!;
}

/** 內容元素目前的位置與大小（從 style 讀回）。 */
function geometry(el: HTMLElement) {
  const m = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(el.style.transform);
  if (!m) throw new Error(`no translate in "${el.style.transform}"`);
  return { width: parseFloat(el.style.width), height: parseFloat(el.style.height), x: Number(m[1]), y: Number(m[2]) };
}

/** 視窗座標 `p` 底下的原圖座標。 */
function contentPointUnder(el: HTMLElement, natural: Size, p: { x: number; y: number }) {
  const g = geometry(el);
  const scale = g.width / natural.width;
  return { x: (p.x - g.x) / scale, y: (p.y - g.y) / scale };
}

function tap(target: Element, x: number, y: number, pointerId = 1, pointerType = "mouse") {
  fireEvent.pointerDown(target, { pointerId, pointerType, clientX: x, clientY: y });
  fireEvent.pointerUp(target, { pointerId, pointerType, clientX: x, clientY: y });
}

describe("MediaLightbox", () => {
  it("大圖等比縮進視窗並置中；名稱是 caption，畫面下方顯示 caption，說明是操作提示", () => {
    const { dialog } = setup();
    const g = geometry(img());
    expect(img().style.width).toBe("1000px");
    expect(img().style.height).toBe("500px");
    expect(img().style.transform).toContain("translate(0px, 150px)");
    expect(g.x).toBe(0);
    expect(screen.getByRole("dialog", { name: "Cap" })).toBe(dialog);
    const visible = within(dialog)
      .getAllByText("Cap")
      .filter(el => !el.classList.contains("sr-only"));
    expect(visible).toHaveLength(1);
    expect(dialog).toHaveAccessibleDescription(HINT_EN);
    expect(img().getAttribute("src")).toBe("/uploads/alice.png");
    expect(img().getAttribute("alt")).toBe("alice.png");
    expect(img().getAttribute("draggable")).toBe("false");
  });

  it("小圖不放大、原尺寸置中；名稱退回 alt，再退回「Image」", () => {
    setup(image({ naturalWidth: 200, naturalHeight: 100, caption: "", alt: "box.png" }));
    expect(img().style.width).toBe("200px");
    expect(img().style.transform).toContain("translate(400px, 350px)");
    expect(screen.getByRole("dialog", { name: "box.png" })).toBeInTheDocument();
    cleanup();
    setup(image({ caption: "", alt: "" }));
    expect(screen.getByRole("dialog", { name: "Image" })).toBeInTheDocument();
  });

  it("svg：放入換過根 id 的字串，style 裡的選擇器跟著換；名稱是「Diagram」", () => {
    const { dialog, viewport } = setup({
      kind: "svg",
      svg: '<svg id="mermaid-7" viewBox="0 0 300 200"><style>#mermaid-7 .node{}</style></svg>',
      naturalWidth: 300,
      naturalHeight: 200,
    });
    const svgs = viewport.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(dialog.querySelector("img")).toBeNull();
    const svg = svgs[0]!;
    const id = svg.getAttribute("id")!;
    expect(id).not.toBe("mermaid-7");
    expect(id).toMatch(/^mermaid-\d+$/);
    expect(svg.querySelector("style")!.textContent).toBe(`#${id} .node{}`);
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBe(dialog);
    const box = svg.parentElement as HTMLElement;
    expect(box.style.width).toBe("300px");
    expect(box.style.height).toBe("200px");
  });

  it("滾輪：以游標為中心放大，游標底下的原圖座標不變", () => {
    const { viewport } = setup();
    const anchor = { x: 300, y: 400 };
    const before = contentPointUnder(img(), BIG, anchor);
    fireEvent.wheel(viewport, { deltaY: -100, deltaMode: 0, clientX: anchor.x, clientY: anchor.y });
    const fit = fitView(BIG, viewportSize);
    const expected = zoomAt(fit, fit.scale * wheelFactor(-100, 0, false, 800), anchor, BIG, viewportSize);
    const g = geometry(img());
    expect(g.width).toBeGreaterThan(1000);
    expect(g.width).toBeCloseTo(BIG.width * expected.scale, 6);
    expect(g.x).toBeCloseTo(expected.offset.x, 6);
    expect(g.y).toBeCloseTo(expected.offset.y, 6);
    const after = contentPointUnder(img(), BIG, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("滾輪送來無效的量：不丟例外、畫面不變", () => {
    const { viewport } = setup();
    // 事件建構子不收 NaN，建好再把欄位換掉。
    const event = createEvent.wheel(viewport, { deltaY: -100, clientX: 300, clientY: 400 });
    Object.defineProperty(event, "deltaY", { value: Number.NaN });
    expect(() => fireEvent(viewport, event)).not.toThrow();
    expect(img().style.width).toBe("1000px");
  });

  it("鍵盤：+ 放大、- 縮回、0 回到符合視窗、方向鍵往看過去的方向移；帶 Ctrl 的不攔", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
    fireEvent.keyDown(dialog, { key: "-" });
    expect(geometry(img()).width).toBeCloseTo(1000, 6);
    fireEvent.keyDown(dialog, { key: "=" });
    fireEvent.keyDown(dialog, { key: "=" });
    expect(geometry(img()).width).toBeCloseTo(1440, 6);
    fireEvent.keyDown(dialog, { key: "0" });
    expect(img().style.width).toBe("1000px");
    expect(img().style.transform).toContain("translate(0px, 150px)");
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    const zoomed = geometry(img());
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(geometry(img()).x).toBeCloseTo(zoomed.x - 40, 6);
    fireEvent.keyDown(dialog, { key: "ArrowLeft", shiftKey: true });
    expect(geometry(img()).x).toBeCloseTo(Math.min(0, zoomed.x - 40 + 200), 6);
    const now = geometry(img());
    fireEvent.keyDown(dialog, { key: "+", ctrlKey: true });
    fireEvent.keyDown(dialog, { key: "ArrowRight", metaKey: true });
    expect(geometry(img())).toEqual(now);
  });

  it("Esc 呼叫 onClose 一次；關閉鈕也呼叫 onClose", () => {
    const { dialog, onClose } = setup();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("點背景（不移動）關閉；點在圖上不關", () => {
    const { viewport, onClose } = setup();
    tap(img(), 500, 400);
    expect(onClose).not.toHaveBeenCalled();
    tap(viewport, 900, 50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("在圖上點兩下（相隔 100ms）切換放大與符合視窗；相隔 400ms 不切換", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    vi.setSystemTime(10_000);
    tap(img(), 500, 400);
    vi.setSystemTime(10_100);
    tap(img(), 500, 400);
    // 符合視窗是 0.5 倍 → 切到 max(1, 2 × 0.5) = 1 倍
    expect(img().style.width).toBe("2000px");
    vi.setSystemTime(11_000);
    tap(img(), 500, 400);
    vi.setSystemTime(11_100);
    tap(img(), 500, 400);
    expect(img().style.width).toBe("1000px");
    vi.setSystemTime(13_000);
    tap(img(), 500, 400);
    vi.setSystemTime(13_400);
    tap(img(), 500, 400);
    expect(img().style.width).toBe("1000px");
  });

  it("兩下點擊相距太遠（> 24px）不切換", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setup();
    vi.setSystemTime(10_000);
    tap(img(), 300, 400);
    vi.setSystemTime(10_100);
    tap(img(), 360, 400);
    expect(img().style.width).toBe("1000px");
  });

  it("在背景按下、移動 20px 再放開：是拖曳不是點擊，不關閉", () => {
    const { viewport, onClose } = setup();
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 900, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 920, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 920, clientY: 50 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("拖曳平移：放大後跟著指標移動，且不能拖出內容邊界", () => {
    const { dialog, viewport } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    const start = geometry(img());
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 470, clientY: 390 });
    const moved = geometry(img());
    expect(moved.x).toBeCloseTo(start.x - 30, 6);
    expect(moved.y).toBeCloseTo(start.y - 10, 6);
    // 往右下拖很遠：寬比視窗大的那一軸左緣停在視窗左緣（內容一直蓋滿視窗）；
    // 高比視窗小的那一軸停在下緣貼齊視窗下緣（拖不出視窗）
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
    expect(geometry(img()).x).toBe(0);
    expect(geometry(img()).y).toBeCloseTo(800 - 720, 6);
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
  });

  it("小圖拖不出視窗", () => {
    const { viewport } = setup(image({ naturalWidth: 200, naturalHeight: 100 }));
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: -5000, clientY: -5000 });
    expect(geometry(img()).x).toBe(0);
    expect(geometry(img()).y).toBe(0);
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 5000, clientY: 5000 });
    expect(geometry(img()).x).toBe(800);
    expect(geometry(img()).y).toBe(700);
  });

  it("指標送來無效的座標：不丟例外、畫面不變", () => {
    const { viewport } = setup();
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    // 事件建構子不收 NaN，建好再把欄位換掉。
    const event = createEvent.pointerMove(viewport, { pointerId: 1, clientX: 510, clientY: 400 });
    Object.defineProperty(event, "clientX", { value: Number.NaN });
    expect(() => fireEvent(viewport, event)).not.toThrow();
    expect(img().style.transform).toContain("translate(0px, 150px)");
    // 之後正常的移動照常平移（壞事件沒有把起點弄壞）
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "+" });
    const zoomed = geometry(img());
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 490, clientY: 400 });
    expect(geometry(img()).x).toBeCloseTo(zoomed.x - 10, 6);
  });

  it("放大後視窗尺寸改變：回到新尺寸的符合視窗", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
    viewportSize = { width: 600, height: 400 };
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(img().style.width).toBe("600px");
    expect(img().style.height).toBe("300px");
    expect(img().style.transform).toContain("translate(0px, 50px)");
  });

  it("視窗尺寸沒變的回報不重設縮放", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(geometry(img()).width).toBeCloseTo(1200, 6);
  });

  it("量到視窗尺寸之前不渲染內容", () => {
    viewportSize = { width: 0, height: 0 };
    const { viewport } = setup();
    expect(viewport.querySelector("img")).toBeNull();
    viewportSize = { width: 1000, height: 800 };
    act(() => observerCallbacks.forEach(cb => cb()));
    expect(img().style.width).toBe("1000px");
  });

  it("兩指：以中點縮放，第一個中點底下的原圖座標跟著手指到新中點", () => {
    const { viewport, onClose } = setup();
    const oldMid = { x: 450, y: 400 };
    const before = contentPointUnder(img(), BIG, oldMid);
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerDown(img(), { pointerId: 2, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 400 });
    // 兩指距離 100 → 200：放大 2 倍（0.5 → 1）
    expect(geometry(img()).width).toBeCloseTo(2000, 6);
    const newMid = { x: 500, y: 400 };
    const after = contentPointUnder(img(), BIG, newMid);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("內容坐在筆記的卡面上：圖片與 svg 外框都帶 bg-card", () => {
    setup();
    expect(img()).toHaveClass("bg-card");
    cleanup();
    const { viewport } = setup({ kind: "svg", svg: '<svg id="mermaid-9" viewBox="0 0 30 20"></svg>', naturalWidth: 30, naturalHeight: 20 });
    expect(viewport.querySelector("svg")!.parentElement).toHaveClass("bg-card");
  });

  it("根 svg 沒有 id：內層 svg 的 id 不被換掉", () => {
    const { viewport } = setup({
      kind: "svg",
      // 內層 id 取一個測試期間不會被 nextMermaidId() 發到的號碼
      svg: '<svg viewBox="0 0 30 20"><svg id="mermaid-9999"></svg><style>#mermaid-9999{}</style></svg>',
      naturalWidth: 30,
      naturalHeight: 20,
    });
    expect(viewport.querySelector("svg svg")!.getAttribute("id")).toBe("mermaid-9999");
    expect(viewport.querySelector("style")!.textContent).toBe("#mermaid-9999{}");
  });

  it("觸控與筆點背景：放開時不關，等接下來的 click 才關（避免點到底下的頁面）", () => {
    for (const pointerType of ["touch", "pen"]) {
      const { viewport, onClose } = setup();
      tap(viewport, 900, 50, 1, pointerType);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(viewport);
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("觸控點背景後沒有 click（例如長按），下一次按下就取消待關：之後點圖的 click 不關閉", () => {
    const { viewport, onClose } = setup();
    tap(viewport, 900, 50, 1, "touch");
    tap(img(), 500, 400, 1, "touch");
    fireEvent.click(img());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("滑鼠點背景：放開就關，之後的 click 不再關一次", () => {
    const { viewport, onClose } = setup();
    tap(viewport, 900, 50, 1, "mouse");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(viewport);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("觸控在背景拖曳或點圖之後的 click 不關閉", () => {
    const { viewport, onClose } = setup();
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "touch", clientX: 900, clientY: 50 });
    fireEvent.pointerMove(viewport, { pointerId: 1, pointerType: "touch", clientX: 920, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "touch", clientX: 920, clientY: 50 });
    fireEvent.click(viewport);
    tap(img(), 500, 400, 1, "touch");
    fireEvent.click(img());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("失去指標捕捉的指標不再被追蹤：之後另一指單指拖曳是平移，不是捏合", () => {
    const { dialog, viewport } = setup();
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.keyDown(dialog, { key: "+" });
    fireEvent.pointerDown(img(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.lostPointerCapture(viewport, { pointerId: 1 });
    const start = geometry(img());
    fireEvent.pointerDown(img(), { pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 570, clientY: 390 });
    const moved = geometry(img());
    expect(moved.width).toBeCloseTo(start.width, 6);
    expect(moved.x).toBeCloseTo(start.x - 30, 6);
    expect(moved.y).toBeCloseTo(start.y - 10, 6);
  });

  it("關閉（卸載）時呼叫 restoreFocus", async () => {
    const restoreFocus = vi.fn();
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <MediaLightbox source={image()} onClose={() => setOpen(false)} restoreFocus={restoreFocus} /> : null;
    }
    render(<Host />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});

describe("MediaLightbox 載入中的灰塊", () => {
  it("圖片載入前顯示灰塊（依原尺寸比例）、圖本身先隱形；load 後灰塊消失、圖現身", () => {
    const { viewport } = setup();
    const skeleton = viewport.querySelector<HTMLElement>("[data-zoom-skeleton]");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.style.aspectRatio).toBe("2000 / 1000");
    expect(img().className).toContain("opacity-0");
    fireEvent.load(img());
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
    expect(img().className).not.toContain("opacity-0");
  });

  it("圖載入失敗也會收掉灰塊，不會永遠卡著", () => {
    const { viewport } = setup();
    fireEvent.error(img());
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
  });

  it("灰塊顯示時 Esc 與關閉鈕都能關", () => {
    const { dialog, onClose } = setup();
    expect(dialog.querySelector("[data-zoom-skeleton]")).not.toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("svg 不必等：沒有灰塊", () => {
    const { viewport } = setup({ kind: "svg", svg: '<svg id="m1"></svg>', naturalWidth: 200, naturalHeight: 100 });
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
  });
});

describe("MediaLightbox 游標", () => {
  it("符合視窗時維持預設游標；放大到超出視窗是 grab，拖曳中是 grabbing，放開回 grab；縮回符合視窗又回預設", () => {
    const { dialog, viewport } = setup();
    expect(img().style.cursor).toBe("");
    expect(viewport.style.cursor).toBe("");
    fireEvent.keyDown(dialog, { key: "+" });
    expect(img().style.cursor).toBe("grab");
    expect(viewport.style.cursor).toBe("grab");
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "mouse", clientX: 500, clientY: 400 });
    expect(img().style.cursor).toBe("grabbing");
    expect(viewport.style.cursor).toBe("grabbing");
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "mouse", clientX: 480, clientY: 400 });
    expect(img().style.cursor).toBe("grab");
    expect(viewport.style.cursor).toBe("grab");
    fireEvent.keyDown(dialog, { key: "0" });
    expect(img().style.cursor).toBe("");
    expect(viewport.style.cursor).toBe("");
  });

  it("svg 放大後同樣是 grab", () => {
    const { dialog } = setup({ kind: "svg", svg: '<svg id="m1"></svg>', naturalWidth: 2000, naturalHeight: 1000 });
    const content = dialog.querySelector<HTMLElement>("[data-zoom-viewport] > div")!;
    expect(content.style.cursor).toBe("");
    fireEvent.keyDown(dialog, { key: "+" });
    expect(content.style.cursor).toBe("grab");
  });
});

describe("MediaLightbox 快取圖", () => {
  it("圖已載好（complete 且有原尺寸）：一渲染就沒有灰塊、圖不隱形", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(2000);
    const { viewport } = setup();
    expect(viewport.querySelector("[data-zoom-skeleton]")).toBeNull();
    expect(img().className).not.toContain("opacity-0");
  });
});
