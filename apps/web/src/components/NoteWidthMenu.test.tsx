import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { setNoteWidth } from "@/components/note-width";
import { NoteWidthMenu } from "./NoteWidthMenu";

/** #297 §4.3：頁首寬度 icon＋三選一選單。Radix trigger 只掛 onPointerDown，開選單用 pointerDown（同 NoteMenu.test）。 */
const ID = "11111111-1111-4111-8111-111111111111";

function widthButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Width/ });
}

function openMenu(): void {
  fireEvent.pointerDown(widthButton(), { button: 0 });
}

function iconOf(button: HTMLElement): string | null {
  return button.querySelector("svg")!.getAttribute("data-icon");
}

describe("NoteWidthMenu（頁首寬度 icon，#297）", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it.each([
    ["standard", "Width: Standard"],
    ["wide", "Width: Wide"],
    ["full", "Width: Full width"],
  ] as const)("M1 現值 %s → 按鈕名與 title 為「%s」、icon 圖樣跟著", (width, name) => {
    setNoteWidth(ID, width);
    render(<NoteWidthMenu noteId={ID} />);
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("title", name);
    expect(iconOf(button)).toBe(`note-width-${width}`);
  });

  it("M0 寬度鈕用主題色：className 含 text-brand／hover:text-brand（比照分享鈕）", () => {
    render(<NoteWidthMenu noteId={ID} />);
    expect(widthButton()).toHaveClass("text-brand", "hover:text-brand");
  });

  it("M2 選單以 label 命名群組；選 Wide → 寫入 localStorage、選單關閉、按鈕與 icon 更新；再開 Wide 為勾選", async () => {
    render(<NoteWidthMenu noteId={ID} />);
    openMenu();
    const group = await screen.findByRole("group", { name: "Width" });
    const items = within(group).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["Standard", "Wide", "Full width"]);
    expect(within(group).getByRole("menuitemradio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(group).getByRole("menuitemradio", { name: "Wide" }));
    expect(localStorage.getItem(`note.width.${ID}`)).toBe("wide");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(widthButton()).toHaveAccessibleName("Width: Wide");
    expect(iconOf(widthButton())).toBe("note-width-wide");

    openMenu();
    expect(await screen.findByRole("menuitemradio", { name: "Wide" })).toHaveAttribute("aria-checked", "true");
  });

  it("M3 從全寬選 Standard → 鍵被移除", async () => {
    setNoteWidth(ID, "full");
    render(<NoteWidthMenu noteId={ID} />);
    expect(localStorage.getItem(`note.width.${ID}`)).toBe("full");
    openMenu();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Standard" }));
    expect(localStorage.getItem(`note.width.${ID}`)).toBeNull();
    expect(widthButton()).toHaveAccessibleName("Width: Standard");
  });

  it("M4 按鈕帶 container query 顯示 class；選項列照 CheckboxItem 的列樣式", async () => {
    render(<NoteWidthMenu noteId={ID} />);
    expect(widthButton()).toHaveClass("hidden", "@min-[43.5rem]:inline-flex", "shrink-0");
    openMenu();
    expect(await screen.findByRole("menuitemradio", { name: "Wide" })).toHaveClass(
      "relative",
      "py-1.5",
      "pl-8",
      "text-sm",
      "focus:bg-accent",
    );
  });

  it("M5 zh-TW：按鈕名「寬度：標準」", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<NoteWidthMenu noteId={ID} />);
    expect(screen.getByRole("button", { name: "寬度：標準" })).toBeInTheDocument();
  });

  it("M6 外部變更（同分頁 setNoteWidth、他分頁 storage 事件）→ 掛著的按鈕即時跟上", () => {
    render(<NoteWidthMenu noteId={ID} />);
    act(() => setNoteWidth(ID, "full"));
    expect(widthButton()).toHaveAccessibleName("Width: Full width");
    expect(iconOf(widthButton())).toBe("note-width-full");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: `note.width.${ID}`, newValue: "wide" }));
    });
    expect(widthButton()).toHaveAccessibleName("Width: Wide");
    expect(iconOf(widthButton())).toBe("note-width-wide");
  });
});
