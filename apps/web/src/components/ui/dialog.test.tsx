import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

type ContentProps = React.ComponentProps<typeof DialogContent>;

/** 受控 Dialog：關閉時卸載內容，`onOpenChange` 只記錄 Radix 要求的狀態；`probe` 用來模擬「對話框外的元素」。 */
function Harness(props: ContentProps) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">outside-probe</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent {...props}>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
          <input aria-label="field" defaultValue="" />
        </DialogContent>
      </Dialog>
    </>
  );
}

const dialogEl = () => screen.queryByRole("dialog");

/** Radix 在 DismissableLayer 掛載後下一個 tick 才訂閱 document pointerdown；先讓 timer 走完再點。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

async function clickOutside(): Promise<void> {
  await settle();
  // 這版 Radix 對 button===0 的 pointerdown 延後到 document 的 click 才派發 pointerDownOutside，
  // 所以要送完整的 pointerdown→mousedown→pointerup→mouseup→click（只送 pointerdown 不會有任何作用）。
  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.mouseUp(document.body);
  fireEvent.click(document.body);
  await settle();
}

describe("DialogContent dismissOnOutside", () => {
  it("預設（未傳）：點外面 → 關閉（基準：證明這個 jsdom 觸發方式 Radix 真的處理）", async () => {
    render(<Harness />);
    expect(dialogEl()).not.toBeNull();
    await clickOutside();
    expect(dialogEl()).toBeNull();
  });

  it("dismissOnOutside={false}：同樣的點外面操作 → 不關閉、輸入內容仍在（基準案證明事件確實會讓對話框關）", async () => {
    render(<Harness dismissOnOutside={false} />);
    const field = screen.getByLabelText("field");
    fireEvent.change(field, { target: { value: "keep me" } });
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
    expect(screen.getByLabelText("field")).toHaveValue("keep me");
  });

  it("dismissOnOutside={false}：Esc 照常關閉", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("dismissOnOutside={false}：右上 X 照常關閉", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("呼叫端的 onInteractOutside 仍被呼叫（守衛開／關兩種都是）", async () => {
    for (const dismissOnOutside of [true, false]) {
      const onInteractOutside = vi.fn();
      const { unmount } = render(<Harness dismissOnOutside={dismissOnOutside} onInteractOutside={onInteractOutside} />);
      await clickOutside();
      expect(onInteractOutside).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("呼叫端自己的 preventDefault 在預設（dismissOnOutside 未傳）下仍有效", async () => {
    render(<Harness onInteractOutside={(e) => e.preventDefault()} />);
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
  });

  it("呼叫端的 onPointerDownOutside 仍被呼叫（與守衛並存）", async () => {
    const onPointerDownOutside = vi.fn();
    render(<Harness dismissOnOutside={false} onPointerDownOutside={onPointerDownOutside} />);
    await clickOutside();
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    expect(dialogEl()).not.toBeNull();
  });
});
