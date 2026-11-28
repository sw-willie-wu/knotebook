import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NOTE_WIDTHS } from "@knotebook/shared";
import {
  CornerDownRight,
  FilePlus,
  Folder,
  FolderPlus,
  History,
  House,
  ListTree,
  LogOut,
  Pencil,
  PanelLeft,
  Pin,
  SquareCheck,
  Star,
  Users,
} from "./icons";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Download,
  ExternalLink,
  ImageIcon,
  KeyRound,
  ListFilter,
  NoteWidthIcon,
  Plug,
  RotateCcw,
  Rows3,
  StarOff,
} from "./icons-extra";

describe("icons", () => {
  it("Users carries data-icon=\"users\" (ShareDialog tests assert the trigger icon through it) and accepts className", () => {
    const { container } = render(<Users className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "users");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it("History carries data-icon=\"history\" and accepts className", () => {
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
    ["restore", RotateCcw],
    ["select", SquareCheck],
    ["folder", Folder],
    ["folder-plus", FolderPlus],
    ["file-plus", FilePlus],
    ["log-out", LogOut],
    ["house", House],
    ["corner-down-right", CornerDownRight],
    ["star", Star],
    ["star-off", StarOff],
    ["panel-left", PanelLeft],
    ["pin", Pin],
    ["list-tree", ListTree],
    ["external-link", ExternalLink],
    ["download", Download],
  ] as const)("icon %s: carries data-icon, is aria-hidden by default and accepts className", (name, Icon) => {
    const { container } = render(<Icon className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", name);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it('Pencil carries data-icon="pencil", is aria-hidden by default and accepts className (#247 edit button)', () => {
    const { container } = render(<Pencil className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "pencil");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4");
  });
  it("Star is hollow by default (fill=none); a caller passing fill=currentColor draws it solid and can also override aria-hidden", () => {
    const hollow = render(<Star />).container.querySelector("svg");
    expect(hollow).toHaveAttribute("fill", "none");
    expect(hollow).toHaveAttribute("stroke", "currentColor");
    const solid = render(<Star fill="currentColor" aria-hidden="false" />).container.querySelector("svg");
    expect(solid).toHaveAttribute("data-icon", "star");
    expect(solid).toHaveAttribute("fill", "currentColor");
    expect(solid).toHaveAttribute("aria-hidden", "false");
  });
  it.each(NOTE_WIDTHS)("NoteWidthIcon %s: data-icon=note-width-<w>, aria-hidden by default, accepts className (#297)", (width) => {
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
  ] as const)("NoteWidthIcon %s: end bars = %s, outward arrows = %s, no frame (#297)", (w, bars, arrows) => {
    const { container } = render(<NoteWidthIcon width={w} />);
    expect(container.querySelector("rect")).toBeNull();
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(/v8/.test(d)).toBe(bars);
    expect(/l-4 4 4 4/.test(d)).toBe(arrows);
  });
});
