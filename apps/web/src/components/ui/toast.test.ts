import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllToasts, dismissToast, toast, useToasts } from "./toast";

// 回歸測試：apps/web/src/components/ui/toast.tsx 的 id 產生器曾用
// crypto.randomUUID()，在非 secure context（LAN plain-http，rev 5.6
// 正當拓撲）該 API 不存在 → toast() 每次呼叫都拋 TypeError。這裡用
// vi.stubGlobal 模擬「沒有 randomUUID」的 crypto 形狀，確認 toast()
// 不再依賴它。

afterEach(() => {
  dismissAllToasts();
  vi.unstubAllGlobals();
});

describe("toast()", () => {
  it("does not throw when crypto.randomUUID is unavailable (non-secure context)", () => {
    // 模擬非 secure context 的 crypto 形狀——存在但沒有 randomUUID。
    vi.stubGlobal("crypto", {});

    let id = "";
    expect(() => {
      id = toast({ title: "a" });
    }).not.toThrow();
    expect(id).toBeTruthy();
  });

  it("produces distinct ids across successive calls", () => {
    const id1 = toast({ title: "a" });
    const id2 = toast({ title: "b" });
    expect(id1).not.toBe(id2);
  });

  it("dismissToast removes the matching item by id", () => {
    const { result } = renderHook(() => useToasts());

    let id1 = "";
    let id2 = "";
    act(() => {
      id1 = toast({ title: "a" });
      id2 = toast({ title: "b" });
    });
    expect(result.current.map((t) => t.id)).toEqual([id1, id2]);

    act(() => {
      dismissToast(id1);
    });
    expect(result.current.map((t) => t.id)).toEqual([id2]);
  });
});
