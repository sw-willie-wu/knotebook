import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { FavoriteRemoveDialog } from "./FavoriteRemoveDialog";

function setup(props: { pending?: boolean; title?: string } = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FavoriteRemoveDialog
      title={props.title ?? "Alpha"}
      open
      pending={props.pending ?? false}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={() => {}}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe("FavoriteRemoveDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    cleanup();
  });

  it("標題與說明（帶入筆記標題）", () => {
    setup({ title: "Alpha" });
    const dialog = screen.getByRole("dialog", { name: "Remove from favorites?" });
    expect(dialog).toHaveAccessibleDescription(
      "\"Alpha\" will be removed from your favorites. The note itself isn't changed, and you can add it back later.",
    );
  });

  it("開框時焦點在 Cancel；Remove 是第二顆", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    const footer = screen.getByRole("button", { name: "Remove" }).parentElement!;
    expect(Array.from(footer.children).map((el) => el.textContent)).toEqual(["Cancel", "Remove"]);
  });

  it("Remove 呼叫 onConfirm", () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Esc", () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })],
    ["✕", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
  ])("%s 呼叫 onOpenChange(false)、不呼叫 onConfirm", (_name, act) => {
    const { onConfirm, onOpenChange } = setup();
    act();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("pending：兩鈕 disabled，Esc 與 ✕ 不呼叫 onOpenChange", () => {
    const { onConfirm, onOpenChange } = setup({ pending: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
