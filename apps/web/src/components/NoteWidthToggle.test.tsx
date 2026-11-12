import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { setNoteWidth } from "@/components/note-width";
import { NoteWidthToggle } from "./NoteWidthToggle";

/** #297：頁首寬度鈕——按一下循環 標準 → 寬 → 全寬 → 標準，不彈選單。 */
const ID = "11111111-1111-4111-8111-111111111111";

function widthButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Width/ });
}

function iconOf(button: HTMLElement): string | null {
  return button.querySelector("svg")!.getAttribute("data-icon");
}

describe("NoteWidthToggle（頁首寬度鈕，#297）", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it.each([
    ["standard", "Width: Standard — click for Wide"],
    ["wide", "Width: Wide — click for Full width"],
    ["full", "Width: Full width — click for Standard"],
  ] as const)("M1 現值 %s → 按鈕名與 title 同字「%s」、icon 圖樣跟著", (width, name) => {
    setNoteWidth(ID, width);
    render(<NoteWidthToggle noteId={ID} />);
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("title", name);
    expect(iconOf(button)).toBe(`note-width-${width}`);
  });

  it("M0 寬度鈕用主題色：className 含 text-brand／hover:text-brand（比照分享鈕）", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).toHaveClass("text-brand", "hover:text-brand");
  });

  it("M2 連按三下 standard → wide → full → standard；localStorage 標準＝沒有鍵", () => {
    render(<NoteWidthToggle noteId={ID} />);
    const key = `note.width.${ID}`;
    expect(localStorage.getItem(key)).toBeNull();

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBe("wide");
    expect(widthButton()).toHaveAccessibleName("Width: Wide — click for Full width");
    expect(iconOf(widthButton())).toBe("note-width-wide");

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBe("full");
    expect(widthButton()).toHaveAccessibleName("Width: Full width — click for Standard");
    expect(iconOf(widthButton())).toBe("note-width-full");

    fireEvent.click(widthButton());
    expect(localStorage.getItem(key)).toBeNull();
    expect(widthButton()).toHaveAccessibleName("Width: Standard — click for Wide");
    expect(iconOf(widthButton())).toBe("note-width-standard");
  });

  it("M3 不是選單：沒有 aria-haspopup、aria-expanded，按了也不出現 role=menu", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).not.toHaveAttribute("aria-haspopup");
    expect(widthButton()).not.toHaveAttribute("aria-expanded");
    fireEvent.pointerDown(widthButton(), { button: 0 });
    fireEvent.click(widthButton());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("M4 按鈕帶 container query 顯示 class", () => {
    render(<NoteWidthToggle noteId={ID} />);
    expect(widthButton()).toHaveClass("hidden", "@min-[43.5rem]:inline-flex", "shrink-0");
  });

  it("M5 zh-TW：按鈕名「寬度：標準（按一下改為寬）」", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<NoteWidthToggle noteId={ID} />);
    const button = screen.getByRole("button", { name: "寬度：標準（按一下改為寬）" });
    expect(button).toHaveAttribute("title", "寬度：標準（按一下改為寬）");
  });

  it("M6 外部變更（同分頁 setNoteWidth、他分頁 storage 事件）→ 掛著的按鈕即時跟上", () => {
    render(<NoteWidthToggle noteId={ID} />);
    act(() => setNoteWidth(ID, "full"));
    expect(widthButton()).toHaveAccessibleName("Width: Full width — click for Standard");
    expect(iconOf(widthButton())).toBe("note-width-full");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: `note.width.${ID}`, newValue: "wide" }));
    });
    expect(widthButton()).toHaveAccessibleName("Width: Wide — click for Full width");
    expect(iconOf(widthButton())).toBe("note-width-wide");
  });
});
