import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clickOutside, settle } from "@/test/outside-click";
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

describe("DialogContent size（#247 §4.1）", () => {
  it("預設 size：恰一顆內建 Close（行為零變的基準）", async () => {
    render(<Harness />);
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it('size="panel"：不渲染內建 Close（由 ManagementShell 自己放一顆）', async () => {
    render(<Harness size="panel" />);
    await settle();
    expect(screen.queryAllByRole("button", { name: "Close" })).toHaveLength(0);
  });

  it('size="panel"：透明外框、§4.6 窄視窗寬高＋§4.1 的 md: clamp', async () => {
    render(<Harness size="panel" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass(
      "p-0",
      "bg-transparent",
      "border-0",
      "shadow-none",
      "overflow-visible",
      "w-[96vw]",
      "h-[92vh]",
      "md:w-[clamp(min(56rem,96vw),92vw,85rem)]",
      "md:h-[clamp(min(42rem,92vh),88vh,56rem)]",
    );
    // twMerge 要把 base 的 bg-popover／shadow-lg／w-full 蓋掉
    expect(dialog).not.toHaveClass("bg-popover");
    expect(dialog).not.toHaveClass("shadow-lg");
    expect(dialog).not.toHaveClass("w-full");
  });
});
