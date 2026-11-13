import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NOTE_WIDTHS } from "@knotebook/shared";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  CornerDownRight,
  FilePlus,
  Folder,
  FolderPlus,
  History,
  House,
  ImageIcon,
  KeyRound,
  ListFilter,
  LogOut,
  NoteWidthIcon,
  Pencil,
  PanelLeft,
  Plug,
  RotateCcw,
  Rows3,
  SquareCheck,
  Star,
  StarOff,
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
    // 垃圾桶的「還原」與「選取」（#181）
    ["restore", RotateCcw],
    ["select", SquareCheck],
    // 資料夾列、資料夾 ⋮、GroupMenu
    ["folder", Folder],
    ["folder-plus", FolderPlus],
    ["file-plus", FilePlus],
    ["log-out", LogOut],
    // 目的地項目的根目錄與「放進這裡」
    ["house", House],
    ["corner-down-right", CornerDownRight],
    // 側欄最愛 tab、筆記 ⋮ 與頁首的最愛
    ["star", Star],
    // 最愛 tab 選取模式的「移出最愛」
    ["star-off", StarOff],
    // 浮動側欄的入口鈕
    ["panel-left", PanelLeft],
  ] as const)("圖示 %s：帶 data-icon、預設 aria-hidden、吃 className", (name, Icon) => {
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", name);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it('Pencil 帶 data-icon="pencil"、預設 aria-hidden、吃 className（#247 編輯鈕）', () => {
    const { container } = render(<Pencil className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "pencil");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it("Star 預設空心（fill=none）；呼叫端傳 fill=currentColor 畫實心、也可覆寫 aria-hidden", () => {
    const hollow = render(<Star />).container.querySelector("svg");
    expect(hollow).toHaveAttribute("fill", "none");
    expect(hollow).toHaveAttribute("stroke", "currentColor");
    const solid = render(<Star fill="currentColor" aria-hidden="false" />).container.querySelector("svg");
    expect(solid).toHaveAttribute("data-icon", "star");
    expect(solid).toHaveAttribute("fill", "currentColor");
    expect(solid).toHaveAttribute("aria-hidden", "false");
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
