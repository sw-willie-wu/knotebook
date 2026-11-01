import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockWidePointer } from "@/test/wide-pointer";
import { isWidePointer, useWidePointer, WIDE_POINTER_QUERY } from "./wide-pointer";

describe("wide-pointer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("WP1 query 字串恰為 spec F22 的判準", () => {
    expect(WIDE_POINTER_QUERY).toBe("(width >= 48rem) and (hover: hover) and (pointer: fine)");
  });

  it("WP2 mockWidePointer 的值反映在 hook", () => {
    mockWidePointer(true);
    expect(renderHook(() => useWidePointer()).result.current).toBe(true);
    mockWidePointer(false);
    expect(renderHook(() => useWidePointer()).result.current).toBe(false);
  });

  it("WP3 翻轉時 hook 跟著重繪", () => {
    const ctl = mockWidePointer(true);
    const { result } = renderHook(() => useWidePointer());
    expect(result.current).toBe(true);
    act(() => {
      ctl.setWide(false);
    });
    expect(result.current).toBe(false);
    act(() => {
      ctl.setWide(true);
    });
    expect(result.current).toBe(true);
  });

  it("WP5 卸載後 change 監聽被移除（不留訂閱）", () => {
    const ctl = mockWidePointer(true);
    const { unmount } = renderHook(() => useWidePointer());
    expect(ctl.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(ctl.listenerCount()).toBe(0);
  });

  it("WP4沒有 matchMedia：isWidePointer 為 false、hook 不 throw", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isWidePointer()).toBe(false);
    expect(renderHook(() => useWidePointer()).result.current).toBe(false);
  });
});
