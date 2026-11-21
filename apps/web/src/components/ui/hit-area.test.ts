import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FIELD_ICON_HIT, HEADER_ICON_HIT, ROW_ICON_HIT, ROW_ICON_HIT_BORDERED, ROW_ICON_ROW } from "./hit-area";

/**
 * Source-level guard for touch hit areas. jsdom applies no CSS, so this only guards that the literals exist and are used by the right components;
 * the real extent to 44px must be measured in a browser (e2e and a grep of the build CSS).
 */

const root = `${process.cwd()}/src`;

function read(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8").replace(/\r\n/g, "\n");
}

/** Strip comments so constant names mentioned in comments do not affect the counts. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function count(path: string, name: string): number {
  return (code(path).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
}

function tokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

describe("hit area of icon buttons inside input fields", () => {
  it("FIELD_ICON_HIT: no relative (the button is already absolute), extends to 44 only on coarse pointers", () => {
    expect(tokens(FIELD_ICON_HIT)).toEqual(
      new Set(["pointer-coarse:after:absolute", "pointer-coarse:after:-inset-2.5", "pointer-coarse:after:content-['']"]),
    );
  });

  it("the search box's clear button uses it; on touch the right padding shrinks to pr-10 (hit area's left edge at 38px, text ending at 41px) and the Ctrl K hint is hidden", () => {
    expect(count("components/AppShell.tsx", "FIELD_ICON_HIT")).toBe(2);
    const shell = code("components/AppShell.tsx");
    expect(shell).toContain("pr-11 pointer-coarse:pr-10");
    expect(shell).toMatch(/<kbd[\s\S]*?pointer-coarse:hidden[\s\S]*?<\/kbd>/);
  });
});

describe("touch hit-area constants", () => {
  it("ROW_ICON_HIT: a 24px icon button grows 10px on each side to 44, applies only on coarse pointers and carries the row-icon marker", () => {
    expect(tokens(ROW_ICON_HIT)).toEqual(
      new Set(["row-icon", "relative", "pointer-coarse:after:absolute", "pointer-coarse:after:-inset-2.5", "pointer-coarse:after:content-['']"]),
    );
  });

  it("ROW_ICON_HIT_BORDERED: compensates the 1px border with 11px on each side and still carries the row-icon marker", () => {
    expect(tokens(ROW_ICON_HIT_BORDERED)).toEqual(
      new Set(["row-icon", "relative", "pointer-coarse:after:absolute", "pointer-coarse:after:-inset-[11px]", "pointer-coarse:after:content-['']"]),
    );
  });

  it("a bordered Done (outline) uses BORDERED", () => {
    expect(count("components/sidebar/SelectHeader.tsx", "ROW_ICON_HIT_BORDERED")).toBe(2);
    expect(count("components/sidebar/TrashPanel.tsx", "ROW_ICON_HIT_BORDERED")).toBe(2);
  });

  it("ROW_ICON_ROW: adds spacing only between two adjacent row-icons", () => {
    expect(tokens(ROW_ICON_ROW)).toEqual(new Set(["pointer-coarse:gap-1", "pointer-coarse:[&>.row-icon:has(+.row-icon)]:me-4"]));
  });

  it("HEADER_ICON_HIT: a 32px icon button grows to 40 wide and 44 tall, applying only on coarse pointers", () => {
    expect(tokens(HEADER_ICON_HIT)).toEqual(
      new Set([
        "relative",
        "pointer-coarse:after:absolute",
        "pointer-coarse:after:-inset-x-1",
        "pointer-coarse:after:-inset-y-1.5",
        "pointer-coarse:after:content-['']",
      ]),
    );
  });
});

function sourceFiles(dir = "components"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(`${root}/${dir}`)) {
    const rel = `${dir}/${name}`;
    if (statSync(`${root}/${rel}`).isDirectory()) out.push(...sourceFiles(rel));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(rel);
  }
  return out;
}

describe("all 24px-tall buttons (h-6 / size-6, including text buttons) have a touch hit area", () => {
  // A `<Button ... h-6 ...>` (or `size-6`; class order, line breaks and being inside cn(...) all count) without ROW_ICON_HIT must be one of the entries below, each with a reason; one more or one fewer fails.
  const EXCEPTIONS: Record<string, number> = {
    // Wide-screen (hoverable) toolbar in select mode: rendered only in mouse environments; touch uses the narrow bottom action bar.
    "components/sidebar/SelectHeader.tsx": 1,
    "components/sidebar/TrashFooter.tsx": 2,
    "components/sidebar/TrashPanel.tsx": 1,
  };

  it("24px icon buttons without ROW_ICON_HIT are exactly the exception list", () => {
    const found: Record<string, number> = {};
    for (const path of sourceFiles()) {
      const source = code(path);
      for (const match of source.matchAll(/<Button\b[\s\S]*?(?:<\/Button>|\/>\s*\n)/g)) {
        const block = match[0];
        if (/\bh-6\b|\bsize-6\b/.test(block) && !/\b(?:ROW|FIELD)_ICON_HIT(?:_BORDERED)?\b/.test(block)) found[path] = (found[path] ?? 0) + 1;
      }
    }
    expect(found).toEqual(EXCEPTIONS);
  });

  it("a bordered (variant=\"outline\") 24px button uses ROW_ICON_HIT_BORDERED", () => {
    const wrong: string[] = [];
    for (const path of sourceFiles()) {
      const source = code(path);
      for (const match of source.matchAll(/<Button\b[\s\S]*?(?:<\/Button>|\/>\s*\n)/g)) {
        const block = match[0];
        if (!/\bh-6\b|\bsize-6\b/.test(block) || !/variant="outline"/.test(block)) continue;
        // `\b` followed by `_BORDERED` is not a boundary, so this regex matches only ROW_ICON_HIT / FIELD_ICON_HIT without the border compensation.
        if (/\b(?:ROW|FIELD)_ICON_HIT\b/.test(block)) wrong.push(path);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("how many times sidebar 24px icon buttons apply ROW_ICON_HIT", () => {
  const SITES: readonly [string, number][] = [
    ["components/NoteList.tsx", 2],
    ["components/NoteMenu.tsx", 1],
    ["components/RowFavoriteStar.tsx", 1],
    ["components/sidebar/FolderMenu.tsx", 1],
    ["components/groups/GroupMenu.tsx", 1],
    ["components/tags/TagFilterMenu.tsx", 1],
    ["components/sidebar/TrashPanel.tsx", 5],
    ["components/sidebar/SelectHeader.tsx", 1],
  ];
  it.each(SITES)("%s: imports and applies it %i times", (path, uses) => {
    expect(read(path)).toMatch(/import \{[^}]*ROW_ICON_HIT[^}]*\} from "@\/components\/ui\/hit-area";/);
    // One is the import, the rest are uses inside className.
    expect(count(path, "ROW_ICON_HIT")).toBe(uses + 1);
  });
});

describe("header 32px icon buttons all apply HEADER_ICON_HIT", () => {
  const SITES: readonly [string, number][] = [
    ["components/NoteMenu.tsx", 1],
    ["components/ShareDialog.tsx", 1],
    ["components/FavoriteToggle.tsx", 1],
    ["components/NoteWidthToggle.tsx", 1],
    ["components/BackToListButton.tsx", 1],
    ["components/AppShell.tsx", 1],
  ];
  it.each(SITES)("%s: imports and applies it %i times", (path, uses) => {
    expect(read(path)).toMatch(/import \{[^}]*HEADER_ICON_HIT[^}]*\} from "@\/components\/ui\/hit-area";/);
    expect(count(path, "HEADER_ICON_HIT")).toBe(uses + 1);
  });
});

describe("rows with two or more 24px icon buttons: the container applies ROW_ICON_ROW (it spaces only adjacent icon buttons)", () => {
  it.each([
    // group row, folder row, header row (a note row has only the kebab menu left: the star is hidden on touch devices)
    ["components/NoteList.tsx", 3],
    // trash row, header row
    ["components/sidebar/TrashPanel.tsx", 2],
  ] as const)("%s: %i containers", (path, rows) => {
    expect(count(path, "ROW_ICON_ROW")).toBe(rows + 1);
  });

  it("nothing enlarges the gap of the whole row any more", () => {
    for (const path of sourceFiles()) expect(code(path), path).not.toContain("pointer-coarse:gap-5");
  });
});

describe("row height returns to 28 / 36 only on fine pointers", () => {
  const FILES = [
    "components/NoteList.tsx",
    "components/sidebar/SelectableTree.tsx",
    "components/sidebar/StackPreview.tsx",
    "components/sidebar/SidebarTabList.tsx",
  ];
  it.each(FILES)("%s has no md:h-7 / md:h-9", (path) => {
    const source = code(path);
    expect(source).not.toMatch(/\bmd:h-7\b/);
    expect(source).not.toMatch(/\bmd:h-9\b/);
  });
  it("row height literals all use pointer-fine (group rows also start at 44)", () => {
    expect(code("components/NoteList.tsx").match(/pointer-fine:h-7/g)).toHaveLength(4);
    expect(code("components/sidebar/SelectableTree.tsx").match(/pointer-fine:h-7/g)).toHaveLength(4);
    expect(code("components/sidebar/StackPreview.tsx").match(/pointer-fine:h-7/g)).toHaveLength(3);
    expect(code("components/sidebar/SidebarTabList.tsx").match(/pointer-fine:h-9/g)).toHaveLength(2);
  });
});

describe("menus with their own radio row style: row height on coarse pointers matches DropdownMenuItem", () => {
  it.each([
    "components/sidebar/FolderMenu.tsx",
    "components/NoteWidthMenuItems.tsx",
    "components/versions/ComparePicker.tsx",
  ])("%s", (path) => {
    expect(code(path)).toContain("py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm");
  });
});

describe("extra padding on touch", () => {
  it("header bottom pb-2.5: keeps the 24px buttons' hit area from being eaten by the list below", () => {
    expect(code("components/NoteList.tsx").match(/pointer-coarse:pb-2\.5/g)).toHaveLength(1);
    expect(code("components/sidebar/TrashPanel.tsx").match(/pointer-coarse:pb-2\.5/g)).toHaveLength(1);
  });
  it("note, folder and group rows' right edge pr-0.75 (3px): the rightmost button's icon edge is 16px from the list edge (same as the left text start) while its hit area (10px outward) is not clipped by the scroll container", () => {
    const source = code("components/NoteList.tsx");
    expect(source.match(/\bpr-0\.75\b/g)).toHaveLength(3);
    expect(source).not.toContain("pointer-coarse:pr-0.5");
    expect(source.match(/\bpr-2\.75\b/g)).toHaveLength(1);
    expect(code("components/sidebar/TrashPanel.tsx").match(/\bpr-2\.75\b/g)).toHaveLength(1);
  });
});
