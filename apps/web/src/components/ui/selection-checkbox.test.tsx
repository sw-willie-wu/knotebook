import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { SelectAllCheckbox, SelectionCheckbox } from "./selection-checkbox";

const input = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("SelectionCheckbox", () => {
  it("SC1 自繪：appearance-none、14px、小圓角、主色底與 focus 環；不含 accent-brand；兩個 svg 都 aria-hidden", () => {
    const { container } = render(<SelectionCheckbox checked={false} onChange={() => {}} />);
    for (const cls of ["appearance-none", "h-3.5", "w-3.5", "rounded-sm", "border-muted-foreground", "bg-transparent", "checked:bg-brand", "indeterminate:bg-brand", "focus-visible:ring-2"]) {
      expect(input()).toHaveClass(cls);
    }
    for (const cls of ["accent-brand", "bg-background", "border-input"]) expect(input()).not.toHaveClass(cls);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg).toHaveAttribute("aria-hidden", "true");
    const minus = container.querySelector('svg[data-icon="minus"]');
    const check = [...svgs].find((svg) => svg !== minus)!;
    expect(minus).not.toBeNull();
    // pointer-events-none 是承重的：拿掉後點勾會落在 svg 上、真瀏覽器不切換。
    for (const cls of ["pointer-events-none", "hidden", "peer-checked:block", "peer-disabled:opacity-50"]) expect(check).toHaveClass(cls);
    for (const cls of ["pointer-events-none", "hidden", "peer-indeterminate:block", "peer-disabled:opacity-50"]) expect(minus).toHaveClass(cls);
    expect(minus).not.toHaveClass("peer-checked:block");
  });

  it("SC2 indeterminate 屬性跟著 prop 走（真→假→真）", () => {
    const { rerender } = render(<SelectionCheckbox checked={false} indeterminate onChange={() => {}} />);
    expect(input().indeterminate).toBe(true);
    rerender(<SelectionCheckbox checked={false} indeterminate={false} onChange={() => {}} />);
    expect(input().indeterminate).toBe(false);
    rerender(<SelectionCheckbox checked={false} indeterminate onChange={() => {}} />);
    expect(input().indeterminate).toBe(true);
  });

  it("SC3 點一下半勾框、上層狀態沒變：onChange 呼叫 1 次、半勾仍在", () => {
    const onChange = vi.fn();
    render(<SelectionCheckbox checked={false} indeterminate onChange={onChange} />);
    fireEvent.click(input());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input().indeterminate).toBe(true);
  });

  it("SC4 checked 與 indeterminate 同為真：半勾優先，checked 為 false", () => {
    render(<SelectionCheckbox checked indeterminate onChange={() => {}} />);
    expect(input().checked).toBe(false);
    expect(input().indeterminate).toBe(true);
  });

  it("SC5 ref 指向 input、data-selection-key 傳到 input、Shift 點擊的 nativeEvent.shiftKey 讀得到", () => {
    const ref = createRef<HTMLInputElement>();
    const seen: boolean[] = [];
    render(
      <SelectionCheckbox
        ref={ref}
        checked={false}
        data-selection-key="note:1"
        onChange={(event) => seen.push((event.nativeEvent as MouseEvent).shiftKey)}
      />,
    );
    expect(ref.current).toBe(input());
    expect(input()).toHaveAttribute("data-selection-key", "note:1");
    fireEvent.click(input(), { shiftKey: true });
    expect(seen).toEqual([true]);
  });
});

describe("SelectAllCheckbox", () => {
  const renderAll = (state: "all" | "some" | "none", onToggle = () => {}) =>
    render(<SelectAllCheckbox state={state} onToggle={onToggle} label="Select all" title="Select all visible" />);
  const box = () => screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;

  it("SA1 三態對應 checked／indeterminate；點擊呼叫 onToggle 1 次；title 照傳", () => {
    const onToggle = vi.fn();
    const { unmount } = renderAll("some", onToggle);
    expect(box().indeterminate).toBe(true);
    expect(box().checked).toBe(false);
    expect(box()).toHaveAttribute("title", "Select all visible");
    fireEvent.click(box());
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
    renderAll("all");
    expect(box().checked).toBe(true);
    expect(box().indeterminate).toBe(false);
  });

  it("SA2 disabled：停用、點擊不呼叫 onToggle", () => {
    const onToggle = vi.fn();
    render(<SelectAllCheckbox state="none" disabled onToggle={onToggle} label="Select all" title="Select all visible" />);
    expect(box()).toBeDisabled();
    // 用 element.click()（jsdom 對 disabled 不做啟動行為，與真瀏覽器一致）；fireEvent.click 直接派發事件會繞過 disabled。
    box().click();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("SA1b none：兩者都不是", () => {
    renderAll("none");
    expect(box().checked).toBe(false);
    expect(box().indeterminate).toBe(false);
  });
});
