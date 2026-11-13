import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { KEYBOARD_OPEN_THRESHOLD_PX, isKeyboardOpen, readKeyboardInset, useKeyboardInset } from "./visual-viewport";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
  listeners = 0;
  addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    this.listeners += 1;
    super.addEventListener(type, cb, opts);
  }
  removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
    this.listeners -= 1;
    super.removeEventListener(type, cb, opts);
  }
}

let viewport: FakeViewport;
let frames: Array<() => void>;

function setViewport(value: FakeViewport | undefined) {
  Object.defineProperty(window, "visualViewport", { value, configurable: true, writable: true });
}

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((run) => run()));
}

describe("keyboard inset", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    frames = [];
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    setViewport(viewport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setViewport(undefined);
  });

  it("沒有 visualViewport：0", () => {
    setViewport(undefined);
    expect(readKeyboardInset()).toBe(0);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it("innerHeight 800、視覺高 500、offsetTop 0：300", () => {
    viewport.height = 500;
    expect(readKeyboardInset()).toBe(300);
  });

  it("offsetTop 50：250（頁面被推上去時要扣掉）", () => {
    viewport.height = 500;
    viewport.offsetTop = 50;
    expect(readKeyboardInset()).toBe(250);
  });

  it("負值夾成 0", () => {
    viewport.height = 900;
    expect(readKeyboardInset()).toBe(0);
  });

  it("isKeyboardOpen：門檻以內不算，超過才算", () => {
    expect(isKeyboardOpen(0)).toBe(false);
    expect(isKeyboardOpen(KEYBOARD_OPEN_THRESHOLD_PX)).toBe(false);
    expect(isKeyboardOpen(KEYBOARD_OPEN_THRESHOLD_PX + 1)).toBe(true);
  });

  it("掛上時讀目前的值；resize 後下一幀重繪", () => {
    viewport.height = 600;
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(200);
    viewport.height = 500;
    act(() => void viewport.dispatchEvent(new Event("resize")));
    expect(result.current).toBe(200);
    flushFrames();
    expect(result.current).toBe(300);
  });

  it("scroll 事件也會更新（offsetTop 變動）", () => {
    viewport.height = 500;
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(300);
    viewport.offsetTop = 100;
    act(() => void viewport.dispatchEvent(new Event("scroll")));
    flushFrames();
    expect(result.current).toBe(200);
  });

  it("同一幀的多次事件只排一個 rAF", () => {
    renderHook(() => useKeyboardInset());
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(frames).toHaveLength(1);
  });

  it("卸載時移除兩個監聽並取消待跑的 rAF", () => {
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(viewport.listeners).toBe(2);
    act(() => void viewport.dispatchEvent(new Event("resize")));
    unmount();
    expect(viewport.listeners).toBe(0);
    // 待跑的幀 id 是 frames.push 的回傳值（1）。
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("卸載時沒有待跑的幀：不呼叫 cancelAnimationFrame", () => {
    const { unmount } = renderHook(() => useKeyboardInset());
    unmount();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("縮放中（scale 不是 1）：視覺視窗變小不是鍵盤，回 0", () => {
    viewport.height = 500;
    viewport.scale = 2;
    expect(readKeyboardInset()).toBe(0);
    viewport.scale = 1.005;
    expect(readKeyboardInset()).toBe(300);
  });
});
