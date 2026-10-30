import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NOTE_WIDTHS } from "@knotebook/shared";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  FilePlus,
  Folder,
  FolderPlus,
  History,
  ImageIcon,
  KeyRound,
  ListFilter,
  LogOut,
  NoteWidthIcon,
  Pencil,
  Plug,
  RotateCcw,
  Rows3,
  SquareCheck,
  Users,
} from "./icons";

describe("icons", () => {
  it("Users 帶 data-icon=\"users\"（ShareDialog 測試靠它斷觸發鈕圖示）且吃 className", () => {
    const { container } = render(<Users className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "users");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it("History 帶 data-icon=\"history\" 且吃 className", () => {
    const { container } = render(<History className="h-5 w-5" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "history");
    expect(svg).toHaveClass("h-5", "w-5");
  });
  it.each([
    ["columns-2", Columns2],
    ["rows-3", Rows3],
    ["list-filter", ListFilter],
    ["plug", Plug],
    ["image", ImageIcon],
    ["key-round", KeyRound],
    ["arrow-up", ArrowUp],
    ["arrow-down", ArrowDown],
    // IC1 垃圾桶的「還原」與「選取」（#181 PR-2b）
    ["restore", RotateCcw],
    ["select", SquareCheck],
    // 資料夾列、資料夾 ⋮、GroupMenu（資料夾 PR-3b-1）
    ["folder", Folder],
    ["folder-plus", FolderPlus],
    ["file-plus", FilePlus],
    ["log-out", LogOut],
  ] as const)("圖示 %s：帶 data-icon、預設 aria-hidden、吃 className", (name, Icon) => {
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", name);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it('Pencil 帶 data-icon="pencil"、預設 aria-hidden、吃 className（#247 §4.9 編輯鈕）', () => {
    const { container } = render(<Pencil className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "pencil");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it.each(NOTE_WIDTHS)("NoteWidthIcon %s：data-icon=note-width-<w>、預設 aria-hidden、吃 className（#297）", (width) => {
    const { container } = render(<NoteWidthIcon width={width} className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", `note-width-${width}`);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it.each([
    ["standard", true, false],
    ["wide", true, true],
    ["full", false, true],
  ] as const)("NoteWidthIcon %s：兩端垂直線＝%s、朝外箭頭＝%s、無外框（#297）", (w, bars, arrows) => {
    const { container } = render(<NoteWidthIcon width={w} />);
    expect(container.querySelector("rect")).toBeNull();
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(/v8/.test(d)).toBe(bars);
    expect(/l-4 4 4 4/.test(d)).toBe(arrows);
  });
});
