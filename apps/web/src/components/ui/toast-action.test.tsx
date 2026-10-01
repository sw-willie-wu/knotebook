import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { dismissAllToasts, toast, Toaster, useToasts } from "./toast";

afterEach(() => {
  act(() => dismissAllToasts());
});

describe("toast action", () => {
  it("action：渲染動作鈕、點擊呼叫 onClick 並關閉該 toast", async () => {
    const onClick = vi.fn();
    render(<Toaster />);
    const store = renderHook(() => useToasts());
    act(() => {
      toast({ title: "x", action: { label: "Open", onClick } });
    });
    expect(store.result.current).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store.result.current).toEqual([]));
    expect(screen.queryByText("x")).toBeNull();
  });

  it("action.altText 有給就用它、沒給才退回 label", async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "a", action: { label: "Open", onClick: vi.fn(), altText: "Copy is in My notes" } });
    });
    await screen.findByRole("button", { name: "Open" });
    // 依賴 @radix-ui/react-toast 的內部屬性 data-radix-toast-announce-alt（非公開 API）；升級改名會讓此測試變紅（不會假綠），屆時對照 Radix 原始碼更新選擇器。
    expect(document.querySelector('[data-radix-toast-announce-alt="Copy is in My notes"]')).not.toBeNull();
    act(() => dismissAllToasts());
    act(() => {
      toast({ title: "b", action: { label: "Go", onClick: vi.fn() } });
    });
    await screen.findByRole("button", { name: "Go" });
    expect(document.querySelector('[data-radix-toast-announce-alt="Go"]')).not.toBeNull();
  });
});
