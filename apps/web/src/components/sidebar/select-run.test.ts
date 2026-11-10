import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SidebarTabActions } from "@/lib/sidebar-tab";
import { beginSelectRun, endSelectRun, updateSelectRun, useSelectRun } from "./select-run";

// 批次進行中的 provider 層 store（#181，RN1–RN4）。store 是模組層：每案新建 owner（前一案失敗不連累下一案）。

function owner(): SidebarTabActions {
  return {
    showTab: () => {},
    updateSelection: () => {},
    endSelectionIfActive: () => false,
    getSelectionSession: () => null,
  };
}

describe("select-run", () => {
  it("RN1 同一 owner：第一次 begin true、第二次 false；end 後又可 begin", () => {
    const a = owner();
    expect(beginSelectRun(a, 2)).toBe(true);
    expect(beginSelectRun(a, 2)).toBe(false);
    endSelectRun(a);
    expect(beginSelectRun(a, 1)).toBe(true);
    endSelectRun(a);
  });

  it("RN2 兩個 owner 互不影響", () => {
    const a = owner();
    const b = owner();
    expect(beginSelectRun(a, 2)).toBe(true);
    expect(beginSelectRun(b, 3)).toBe(true);
    const ra = renderHook(() => useSelectRun(a));
    const rb = renderHook(() => useSelectRun(b));
    act(() => endSelectRun(a));
    expect(ra.result.current).toBeNull();
    expect(rb.result.current).toEqual({ progress: { done: 0, total: 3 } });
    act(() => endSelectRun(b));
  });

  it("RN3 兩個讀者在 update 後一起重繪、讀到同一個 progress；end 後都回 null", () => {
    const a = owner();
    const first = renderHook(() => useSelectRun(a));
    const second = renderHook(() => useSelectRun(a));
    expect(first.result.current).toBeNull();
    act(() => {
      beginSelectRun(a, 3);
    });
    act(() => updateSelectRun(a, 2));
    expect(first.result.current).toEqual({ progress: { done: 2, total: 3 } });
    expect(second.result.current).toBe(first.result.current);
    act(() => endSelectRun(a));
    expect(first.result.current).toBeNull();
    expect(second.result.current).toBeNull();
  });

  it("RN4 begin 之後 progress 是 { done: 0, total }", () => {
    const a = owner();
    const view = renderHook(() => useSelectRun(a));
    act(() => {
      beginSelectRun(a, 3);
    });
    expect(view.result.current).toEqual({ progress: { done: 0, total: 3 } });
    act(() => endSelectRun(a));
  });
});
