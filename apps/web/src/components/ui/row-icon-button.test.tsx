import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import { Pencil, Trash } from "./icons";
import { RowIconButton } from "./row-icon-button";

describe("RowIconButton（spec §4.9：列內動作一律 icon 鈕）", () => {
  it("ghost＋size icon（h-8 w-8，ROW_ICON_BUTTON）；aria-label 與 title 都是 label；中性色", () => {
    render(<RowIconButton label="Edit Basic" icon={<Pencil className="h-4 w-4" />} />);
    const button = screen.getByRole("button", { name: "Edit Basic" });
    expect(button).toHaveAttribute("title", "Edit Basic");
    expect(button).toHaveClass("h-8", "w-8", "text-muted-foreground");
    expect(button.className).not.toMatch(/(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/);
    expect(button.className).not.toMatch(/(^|\s)border-input(\s|$)/);
  });

  it("tone=destructive：ROW_ICON_DANGER（text-destructive＋hover:bg-destructive/10），不是 destructive 變體（無 bg-destructive）", () => {
    render(<RowIconButton label="Delete Basic" tone="destructive" icon={<Trash className="h-4 w-4" />} />);
    const button = screen.getByRole("button", { name: "Delete Basic" });
    expect(button).toHaveClass("text-destructive", "hover:bg-destructive/10");
    expect(button).not.toHaveClass("bg-destructive");
  });

  it("softDisabled：aria-disabled（ROW_ICON_DANGER 的 aria-disabled:opacity-40 生效）＋title 換成原因；點了不呼叫 onClick；不是原生 disabled", () => {
    const onClick = vi.fn();
    render(
      <RowIconButton label="Remove a@x" tone="destructive" softDisabled softDisabledReason="Only admin" onClick={onClick} icon={<Trash className="h-4 w-4" />} />,
    );
    const button = screen.getByRole("button", { name: "Remove a@x" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", "Only admin");
    expect(button).toHaveClass("aria-disabled:opacity-40", "cursor-not-allowed");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("當 DialogTrigger asChild 的子元素：一般態點了開對話框；softDisabled 點了不開", () => {
    const { rerender } = render(
      <Dialog>
        <DialogTrigger asChild>
          <RowIconButton label="Delete Basic" tone="destructive" icon={<Trash className="h-4 w-4" />} />
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete?</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Basic" }));
    expect(screen.getByRole("dialog", { name: "Delete?" })).toBeInTheDocument();
    rerender(
      <Dialog key="b">
        <DialogTrigger asChild>
          <RowIconButton label="Delete Basic" tone="destructive" softDisabled icon={<Trash className="h-4 w-4" />} />
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete?</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Basic" }));
    expect(screen.queryByRole("dialog", { name: "Delete?" })).not.toBeInTheDocument();
  });
});
