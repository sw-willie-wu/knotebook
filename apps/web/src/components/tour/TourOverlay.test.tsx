import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { cardSurface } from "@/components/ui/card";
import { isOverlayOpen } from "@/lib/versions-context";
import { HOLE_PADDING, HOLE_RADIUS } from "./geometry";
import { TourOverlay, type TourOverlayProps } from "./TourOverlay";

const TARGET = { left: 500, top: 100, width: 80, height: 40 };

function handlers() {
  return {
    onNext: vi.fn(),
    onBack: vi.fn(),
    onSkip: vi.fn(),
    onClose: vi.fn(),
    onKeep: vi.fn(),
    onDelete: vi.fn(),
  };
}

function renderOverlay(overrides: Partial<TourOverlayProps> = {}) {
  const h = handlers();
  const props: TourOverlayProps = { target: TARGET, step: 2, total: 5, title: "Search", body: "Press Ctrl+K to search.", ...h, ...overrides };
  const view = render(<TourOverlay {...props} />);
  return { ...view, h, props, rerenderWith: (next: Partial<TourOverlayProps>) => view.rerender(<TourOverlay {...props} {...next} />) };
}

const card = () => screen.getByRole("dialog");
const hintRegion = () => card().querySelector('[aria-live="polite"]:not([data-tour-step-announcement])');
const stepRegion = () => document.querySelector("[data-tour-step-announcement]");
const buttonNames = () => Array.from(card().querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent);

/** document 的 capture 監聽：BlockNote 選單的「點外面就關」掛在這一層（floating-ui `useDismiss`）。 */
function documentCaptureSpy(type: string) {
  const spy = vi.fn();
  document.addEventListener(type, spy, true);
  return { spy, remove: () => document.removeEventListener(type, spy, true) };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("卡片的角色與名稱", () => {
  it("role=dialog、aria-modal=false、名稱是標題、描述是說明、有 data-tour-card", () => {
    renderOverlay();
    const dialog = screen.getByRole("dialog", { name: "Search" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveAccessibleDescription("Press Ctrl+K to search.");
    expect(dialog).toHaveAttribute("data-tour-card");
  });

  it("站數顯示 n / N", () => {
    renderOverlay({ step: 2, total: 5 });
    expect(card()).toHaveTextContent("2 / 5");
  });
});

describe("按鈕依站序", () => {
  it("第 1 站：跳過、下一步、✕；沒有上一步", () => {
    renderOverlay({ step: 1, total: 5 });
    expect(buttonNames()).toEqual(["Skip feature tour", "Next", "Close"]);
  });

  it("中間的站：上一步、下一步、✕；沒有跳過", () => {
    renderOverlay({ step: 3, total: 5 });
    expect(buttonNames()).toEqual(["Back", "Next", "Close"]);
  });

  it("最後一站：上一步、保留、刪除、✕；沒有下一步", () => {
    renderOverlay({ step: 5, total: 5 });
    expect(buttonNames()).toEqual(["Back", "Keep sample note", "Delete sample note", "Close"]);
  });

  it("只有一站時：第 1 站也是最後一站，只有保留、刪除、✕（不另放跳過）", () => {
    renderOverlay({ step: 1, total: 1 });
    expect(buttonNames()).toEqual(["Keep sample note", "Delete sample note", "Close"]);
  });

  it("每顆鈕呼叫自己的動作", () => {
    const first = renderOverlay({ step: 1, total: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Skip feature tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(first.h.onSkip).toHaveBeenCalledTimes(1);
    expect(first.h.onNext).toHaveBeenCalledTimes(1);
    expect(first.h.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const last = renderOverlay({ step: 5, total: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep sample note" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete sample note" }));
    expect(last.h.onBack).toHaveBeenCalledTimes(1);
    expect(last.h.onKeep).toHaveBeenCalledTimes(1);
    expect(last.h.onDelete).toHaveBeenCalledTimes(1);
    expect(last.h.onNext).not.toHaveBeenCalled();
  });

  it("zh-TW 的按鈕字樣", async () => {
    await i18n.changeLanguage("zh-TW");
    const { unmount } = renderOverlay({ step: 1, total: 5 });
    expect(buttonNames()).toEqual(["跳過功能導覽", "下一步", "關閉"]);
    unmount();
    renderOverlay({ step: 5, total: 5 });
    expect(buttonNames()).toEqual(["上一步", "保留示範筆記", "刪除示範筆記", "關閉"]);
    expect(screen.getByRole("button", { name: "刪除示範筆記" })).toHaveTextContent("刪除");
  });
});

describe("導覽開著時全站快捷鍵讓路", () => {
  it("isOverlayOpen() 掛著為 true、卸載後回到 false", () => {
    expect(isOverlayOpen()).toBe(false);
    const { unmount } = renderOverlay();
    expect(isOverlayOpen()).toBe(true);
    unmount();
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("卡面", () => {
  it("用 cardSurface", () => {
    renderOverlay();
    for (const cls of cardSurface.split(" ")) expect(card()).toHaveClass(cls);
  });

  it("卡片容器本身聚焦時不畫瀏覽器預設外框", () => {
    renderOverlay();
    expect(card()).toHaveClass("outline-none");
  });
});

describe("演示站模式", () => {
  it("有 aria-live=polite 的提示「← → 換站、Esc 結束」", () => {
    renderOverlay({ live: true });
    const region = hintRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("← → to change stops, Esc to end");
  });

  it("一般站沒有提示字，但 live region 先掛著（換到演示站時才讀得出來）", () => {
    const view = renderOverlay();
    const region = hintRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("");
    view.rerenderWith({ live: true });
    expect(hintRegion()).toBe(region);
    expect(region).toHaveTextContent("← → to change stops, Esc to end");
  });
});

describe("換站時報讀器讀得到新的一站", () => {
  it("掛上時不報（焦點進卡片時 dialog 本身會被讀出）；換站後報「n / N、標題、說明」", () => {
    const view = renderOverlay({ step: 2, total: 5 });
    const region = stepRegion();
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveClass("sr-only");
    expect(region).toHaveTextContent(/^$/);
    view.rerenderWith({ step: 3, title: "Folders", body: "Create folders here." });
    expect(stepRegion()).toBe(region);
    expect(region).toHaveTextContent("3 / 5: Folders. Create folders here.");
  });

  it("往回走也報；live region 一直是同一個元素（不重掛）", () => {
    const view = renderOverlay({ step: 3, total: 5, title: "Folders", body: "Create folders here." });
    const region = stepRegion();
    view.rerenderWith({ step: 2, title: "New note", body: "Click here to create a note." });
    expect(region).toHaveTextContent("2 / 5: New note. Click here to create a note.");
    view.rerenderWith({ step: 5, title: "Forgot how something works?", body: "Press Ctrl+/." });
    expect(stepRegion()).toBe(region);
    expect(region).toHaveTextContent("5 / 5: Forgot how something works?. Press Ctrl+/.");
  });

  it("zh-TW 的格式", async () => {
    await i18n.changeLanguage("zh-TW");
    const view = renderOverlay({ step: 1, total: 4, title: "側欄分類", body: "側欄有五個分類。" });
    view.rerenderWith({ step: 2, title: "新增筆記", body: "按這裡新增一篇筆記。" });
    expect(stepRegion()).toHaveTextContent("2 / 4：新增筆記。按這裡新增一篇筆記。");
  });
});

describe("window capture 的 pointerdown 攔截", () => {
  it("卡片按鈕、卡片文字、遮罩：defaultPrevented，而且 document 的 capture 監聽收不到", () => {
    renderOverlay();
    const targets = [
      screen.getByRole("button", { name: "Next" }),
      screen.getByText("Press Ctrl+K to search."),
      document.querySelector("[data-tour-overlay] svg")!,
      document.querySelector("[data-tour-overlay]")!,
    ];
    for (const el of targets) {
      const doc = documentCaptureSpy("pointerdown");
      const notCancelled = fireEvent.pointerDown(el);
      doc.remove();
      expect(notCancelled, el.tagName).toBe(false);
      expect(doc.spy, el.tagName).not.toHaveBeenCalled();
    }
  });

  it("遮罩與卡片以外（例如通知）不攔", () => {
    renderOverlay();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const doc = documentCaptureSpy("pointerdown");
    const notCancelled = fireEvent.pointerDown(outside);
    doc.remove();
    outside.remove();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
  });

  it("pointerdown 被攔下後，按鈕的 click 照常觸發動作", () => {
    const first = renderOverlay({ step: 1, total: 5 });
    for (const name of ["Skip feature tour", "Next", "Close"]) {
      const btn = screen.getByRole("button", { name });
      fireEvent.pointerDown(btn);
      fireEvent.click(btn);
    }
    expect(first.h.onSkip).toHaveBeenCalledTimes(1);
    expect(first.h.onNext).toHaveBeenCalledTimes(1);
    expect(first.h.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const last = renderOverlay({ step: 5, total: 5 });
    for (const name of ["Back", "Keep sample note", "Delete sample note"]) {
      const btn = screen.getByRole("button", { name });
      fireEvent.pointerDown(btn);
      fireEvent.click(btn);
    }
    expect(last.h.onBack).toHaveBeenCalledTimes(1);
    expect(last.h.onKeep).toHaveBeenCalledTimes(1);
    expect(last.h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("卸載後監聽拆掉（同一支函式、同一個 capture 旗標）", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderOverlay();
    const added = add.mock.calls.filter(([type]) => type === "pointerdown");
    expect(added).toHaveLength(1);
    expect(added[0]![2]).toBe(true);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "pointerdown");
    expect(removed).toEqual([["pointerdown", added[0]![1], true]]);
  });
});

describe("沒有「每次登入都顯示」", () => {
  it("卡片裡沒有 checkbox", () => {
    renderOverlay({ step: 1, total: 5 });
    expect(card().querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]')).toBeNull();
  });
});

describe("最後一站", () => {
  it("兩顆鈕的 aria-describedby 指向那句提問；說明句另有自己的元素", () => {
    renderOverlay({ step: 5, total: 5, body: "Press Ctrl+/ or open Keyboard shortcuts from here." });
    const question = screen.getByText("Keep the sample note, or move it to the trash?");
    expect(question.id).not.toBe("");
    for (const name of ["Keep sample note", "Delete sample note"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.getAttribute("aria-describedby")).toBe(question.id);
      expect(btn).toHaveAccessibleDescription("Keep the sample note, or move it to the trash?");
    }
    expect(card()).toHaveAccessibleDescription("Press Ctrl+/ or open Keyboard shortcuts from here.");
  });

  it("〔刪除〕的可及名稱含可見字樣、破壞性外觀；〔保留〕不是", () => {
    renderOverlay({ step: 5, total: 5 });
    const del = screen.getByRole("button", { name: "Delete sample note" });
    expect(del).toHaveTextContent("Delete");
    expect(del).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Keep sample note" })).not.toHaveClass("text-destructive");
  });

  it("其他站沒有那句提問", () => {
    renderOverlay({ step: 4, total: 5 });
    expect(screen.queryByText("Keep the sample note, or move it to the trash?")).toBeNull();
  });

  it("預設焦點在〔保留示範筆記〕，Tab 依序走到〔刪除〕再到 ✕", () => {
    renderOverlay({ step: 5, total: 5 });
    expect(screen.getByRole("button", { name: "Keep sample note" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Delete sample note" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});

describe("焦點與 Tab 迴圈", () => {
  it("一般站預設焦點在「下一步」；換站後再放回「下一步」", () => {
    const view = renderOverlay({ step: 2, total: 5 });
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toHaveFocus();
    screen.getByRole("button", { name: "Back" }).focus();
    view.rerenderWith({ step: 3 });
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("走到最後一站時焦點換到〔保留示範筆記〕", () => {
    const view = renderOverlay({ step: 4, total: 5 });
    view.rerenderWith({ step: 5 });
    expect(screen.getByRole("button", { name: "Keep sample note" })).toHaveFocus();
  });

  it("演示站不搶焦點（焦點留在編輯器）", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const view = renderOverlay({ live: true });
    expect(editor).toHaveFocus();
    view.rerenderWith({ step: 3 });
    expect(editor).toHaveFocus();
    view.unmount();
    editor.remove();
  });

  it("Tab 在最後一顆後回到第一顆、Shift+Tab 在第一顆回到最後一顆；事件不往下傳", () => {
    renderOverlay({ step: 2, total: 5 });
    const back = screen.getByRole("button", { name: "Back" });
    const next = screen.getByRole("button", { name: "Next" });
    const close = screen.getByRole("button", { name: "Close" });
    const doc = documentCaptureSpy("keydown");
    fireEvent.keyDown(next, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();
    doc.remove();
    expect(doc.spy).not.toHaveBeenCalled();
  });

  it("演示站不攔 Tab（焦點留在編輯器，交給演示站處理；搶進卡片會讓選單關掉）", () => {
    renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    for (const shiftKey of [false, true]) {
      const doc = documentCaptureSpy("keydown");
      const notCancelled = fireEvent.keyDown(editor, { key: "Tab", shiftKey });
      doc.remove();
      expect(notCancelled).toBe(true);
      expect(doc.spy).toHaveBeenCalledTimes(1);
      expect(editor).toHaveFocus();
    }
    editor.remove();
  });

  it("焦點跑到卡片外時，Tab 把它帶回卡片", () => {
    renderOverlay({ step: 2, total: 5 });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    outside.remove();
  });
});

describe("Esc", () => {
  it("在 window capture 接走：焦點在卡片外（例如編輯器）也關，document 的監聽收不到", () => {
    const { h } = renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(editor, { key: "Escape" });
    doc.remove();
    editor.remove();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
    expect(doc.spy).not.toHaveBeenCalled();
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("輸入法組字中的 Esc 讓給輸入法（%s）：不關、不攔", (_name, init) => {
    const { h } = renderOverlay({ live: true });
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(editor, { key: "Escape", ...init });
    doc.remove();
    editor.remove();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
  });

  it("焦點在卡片內也一樣只關一次", () => {
    const { h } = renderOverlay();
    fireEvent.keyDown(screen.getByRole("button", { name: "Next" }), { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("其他鍵不攔（演示站的鍵盤另外處理）", () => {
    const { h } = renderOverlay({ live: true });
    const doc = documentCaptureSpy("keydown");
    const notCancelled = fireEvent.keyDown(document.body, { key: "a" });
    doc.remove();
    expect(notCancelled).toBe(true);
    expect(doc.spy).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("卸載後 Esc 不再呼叫", () => {
    const { h, unmount } = renderOverlay();
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("每次都用最新的 onClose（換站後傳進來的新函式）", () => {
    const view = renderOverlay();
    const latest = vi.fn();
    view.rerenderWith({ onClose: latest });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(view.h.onClose).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe("遮罩：挖洞、外框、箭頭", () => {
  const hole = () => document.querySelector("[data-tour-hole]");
  const ring = () => document.querySelector("[data-tour-ring]");

  it("挖洞與外框比目標外擴 6px、圓角 8px", () => {
    renderOverlay();
    for (const el of [hole(), ring()]) {
      expect(el).not.toBeNull();
      expect(el).toHaveAttribute("x", String(TARGET.left - HOLE_PADDING));
      expect(el).toHaveAttribute("y", String(TARGET.top - HOLE_PADDING));
      expect(el).toHaveAttribute("width", String(TARGET.width + HOLE_PADDING * 2));
      expect(el).toHaveAttribute("height", String(TARGET.height + HOLE_PADDING * 2));
      expect(el).toHaveAttribute("rx", String(HOLE_RADIUS));
    }
    expect(ring()).toHaveAttribute("stroke-width", "2");
    expect(ring()).toHaveClass("stroke-brand");
  });

  it("目標動了，挖洞跟著動", () => {
    const view = renderOverlay();
    view.rerenderWith({ target: { left: 40, top: 300, width: 10, height: 10 } });
    expect(hole()).toHaveAttribute("x", String(40 - HOLE_PADDING));
    expect(hole()).toHaveAttribute("y", String(300 - HOLE_PADDING));
  });

  it("有目標時畫箭頭；沒有目標時不挖洞、不畫箭頭，卡片照樣在", () => {
    const view = renderOverlay();
    expect(document.querySelector("[data-tour-arrow]")).not.toBeNull();
    view.rerenderWith({ target: null });
    expect(hole()).toBeNull();
    expect(ring()).toBeNull();
    expect(document.querySelector("[data-tour-arrow]")).toBeNull();
    expect(card()).toBeInTheDocument();
  });

  it("遮罩是全畫面 fixed、z-[60]，畫在 body 底下（不受頁面的 stacking context 影響）", () => {
    renderOverlay();
    const root = document.querySelector("[data-tour-overlay]")!;
    expect(root.parentElement).toBe(document.body);
    expect(root).toHaveClass("fixed", "inset-0", "z-[60]");
    expect(root.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("forced-colors：外框用 Highlight，另有一圈 CanvasText 外框只在高對比時出現", () => {
    renderOverlay();
    expect(ring()).toHaveClass("forced-colors:stroke-[Highlight]");
    const outline = document.querySelector("[data-tour-ring-contrast]");
    expect(outline).not.toBeNull();
    expect(outline).toHaveClass("hidden", "forced-colors:inline", "forced-colors:stroke-[CanvasText]");
  });

  it("挖洞、外框、箭頭、卡片都不做過渡，換站時一起跳到新位置（也就沒有要為 prefers-reduced-motion 關掉的動畫）", () => {
    renderOverlay();
    const parts = [hole()!, ring()!, document.querySelector("[data-tour-ring-contrast]")!, document.querySelector("[data-tour-arrow]")!, card()];
    for (const el of parts) {
      expect(el).not.toBeNull();
      const classes = (el.getAttribute("class") ?? "").split(/\s+/);
      expect(classes.filter((c) => /(^|:)(transition|duration|animate)/.test(c)), el.tagName).toEqual([]);
      expect((el as HTMLElement | SVGElement).style.transition, el.tagName).toBe("");
    }
  });
});

describe("卡片位置", () => {
  it("下方放得下時放在目標下方（依卡片實際尺寸）", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    renderOverlay();
    const style = card().style;
    expect(style.left).toBe(`${TARGET.left + TARGET.width / 2 - 160}px`);
    expect(Number.parseFloat(style.top)).toBeGreaterThan(TARGET.top + TARGET.height);
  });

  it("卡片尺寸變了（換站後說明變長）重新放位置；卸載時停止觀察", () => {
    const observers: { cb: ResizeObserverCallback; observed: Element[]; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: (typeof observers)[number];
        constructor(cb: ResizeObserverCallback) {
          this.entry = { cb, observed: [], disconnected: false };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.observed.push(el);
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    const { unmount } = renderOverlay({ target: null });
    expect(card().style.top).toBe(`${(window.innerHeight - 160) / 2}px`);
    const mine = observers.find((o) => o.observed.includes(card()));
    expect(mine).toBeDefined();
    height.mockReturnValue(300);
    act(() => mine!.cb([], {} as ResizeObserver));
    expect(card().style.top).toBe(`${(window.innerHeight - 300) / 2}px`);
    unmount();
    expect(mine!.disconnected).toBe(true);
  });

  it("視窗縮放時重新算位置", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(160);
    renderOverlay({ target: null });
    const before = card().style.left;
    const original = window.innerWidth;
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(card().style.left).toBe(`${(600 - 320) / 2}px`);
    expect(card().style.left).not.toBe(before);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
  });
});
