import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterSuggestionItems } from "@blocknote/core";
import i18n from "@/i18n";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { P, mountEditor, row, shape, type AnyEditor } from "@/test/columns-fixtures";

/**
 * Mocks BlockNote's two APIs and checks only our composition logic, above all that the default items are kept: taking over the `/` menu typically fails by returning only our own items,
 * which silently replaces the whole built-in menu (the same trap as the whole-set override of `inlineContentSpecs` in `collab/schema.ts`).
 *
 * The fake default items must carry a `group`: without it `lastIndexOf(group)` is always -1, so the tests take only the fallback branch while production takes the other,
 * and replacing the whole composition with `return [item]` would still pass.
 * Group names and order follow BlockNote's built-in en dictionary (... Advanced > Media > Others).
 *
 * The grid items depend on the cursor position, so `editor` is a real editor; the mock uses importOriginal and replaces only those two APIs.
 */

const defaultItemsMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn());

vi.mock("@blocknote/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@blocknote/react")>()),
  getDefaultReactSlashMenuItems: defaultItemsMock,
}));
vi.mock("@blocknote/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@blocknote/core")>()),
  insertOrUpdateBlockForSlashMenu: insertMock,
}));

const { PHONE_SLASH_MENU_FLOATING_OPTIONS, SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX, buildSlashMenuItems, slashMenuPhoneMiddleware, withoutSlashBadges } = await import("./slash-menu");

/** Real editor with the cursor in a top-level paragraph (the grid items appear). Assertions that nothing is inserted still hit the mocked insertMock. */
let editor: AnyEditor;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function mount(content = [P("p", "p0")], cursorId = "p0"): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  m.editor.setTextCursorPosition(cursorId, "end");
  return m.editor;
}
/** The app's `translate` returns the translated string; tests use the key as the string (followed by `n` when given), but group names must match the fake default items. */
const translate = (key: string, options?: Record<string, unknown>): string =>
  key === "note.mermaid.slashGroup" ? "Advanced" : options?.n !== undefined ? `${key}:${String(options.n)}` : key;
const COLUMN_TITLES = ["note.columns.slashTitle:2", "note.columns.slashTitle:3", "note.columns.slashTitle:4"];
const noopInsertLink = () => {};

/** Shape of a built-in item: it has a group, and other groups come after ours (Advanced). */
const DEFAULT_ITEMS = [
  { title: "Paragraph", group: "Basic blocks" },
  { title: "Heading 1", group: "Basic blocks" },
  { title: "Table", group: "Advanced" },
  { title: "Image", group: "Media" },
  { title: "Emoji", group: "Others" },
];

/** Sequence of group headings (the menu draws a heading only when the group changes); a repeat means a duplicate heading on screen. */
function groupRuns(items: { group?: string }[]): string[] {
  return items.map((item) => item.group).filter((group, index, all) => group !== all[index - 1]) as string[];
}

beforeEach(() => {
  defaultItemsMock.mockReset();
  insertMock.mockReset();
  defaultItemsMock.mockReturnValue(DEFAULT_ITEMS.map((item) => ({ ...item })));
  editor = mount();
});

/** The mermaid item (not `.at(-1)`: it is inserted within its own group, which is followed by Media / Others). */
function mermaidItem() {
  return buildSlashMenuItems(editor, translate, noopInsertLink).find((item) => item.title === "note.mermaid.slashTitle");
}

describe("buildSlashMenuItems", () => {
  it("all default items are kept in the same order (taking over the / menu must not replace the built-in menu)", () => {
    const titles = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    expect(titles.filter((title) => !title.startsWith("note."))).toEqual(
      DEFAULT_ITEMS.map((item) => item.title),
    );
  });

  it("mermaid and link items go after the last item of the same group (not at the very end of the list)", () => {
    const titles = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    expect(titles).toEqual([
      "Paragraph",
      "Heading 1",
      "Table",
      "note.mermaid.slashTitle",
      "note.link.slashTitle",
      ...COLUMN_TITLES,
      "Image",
      "Emoji",
    ]);
  });

  it("no second heading with the same group name appears (it would if they were appended at the end)", () => {
    const runs = groupRuns(buildSlashMenuItems(editor, translate, noopInsertLink));
    expect(runs).toEqual(["Basic blocks", "Advanced", "Media", "Others"]);
  });

  it("when the group name does not exist in the built-in list, falls back to appending at the end (the group does not vanish)", () => {
    const titles = buildSlashMenuItems(
      editor,
      (key, options) => (key === "note.mermaid.slashGroup" ? "不存在的分組" : translate(key, options)),
      noopInsertLink,
    ).map((i) => i.title);
    expect(titles).toEqual([...DEFAULT_ITEMS.map((item) => item.title), "note.mermaid.slashTitle", "note.link.slashTitle", ...COLUMN_TITLES]);
  });

  it("mermaid item has English and Chinese aliases (found by typing either)", () => {
    expect(mermaidItem()?.aliases).toEqual(expect.arrayContaining(["mermaid", "diagram", "flowchart", "圖表"]));
  });

  it("clicking inserts a block of type:\"mermaid\"", () => {
    mermaidItem()?.onItemClick();
    expect(insertMock).toHaveBeenCalledWith(editor, { type: "mermaid" });
  });

  it("the inserted block has no code prop (so the propSchema default applies)", () => {
    mermaidItem()?.onItemClick();
    const [, block] = insertMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(block).not.toHaveProperty("props");
  });

  it("link and diagram items share a group (the group key is a shared constant)", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const link = items.find((i) => i.title === "note.link.slashTitle");
    const mermaid = items.find((i) => i.title === "note.mermaid.slashTitle");
    expect(link?.group).toBe(mermaid?.group);
  });

  it("clicking the link item calls onInsertLink and inserts no block", () => {
    const onInsertLink = vi.fn();
    buildSlashMenuItems(editor, translate, onInsertLink)
      .find((i) => i.title === "note.link.slashTitle")
      ?.onItemClick();
    expect(onInsertLink).toHaveBeenCalledOnce();
    // Assert on the mocked insert: `insertOrUpdateBlockForSlashMenu` is mocked in this file and does not change the document, so comparing `editor.document` before and after is always equal and would miss a regression that inserts a block.
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("link item has English and Chinese aliases (found by typing either)", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const link = items.find((i) => i.title === "note.link.slashTitle");
    expect(link?.aliases).toEqual(expect.arrayContaining(["link", "url", "連結"]));
  });
});

describe("side-by-side items /grid N", () => {
  const columnItems = <T extends { aliases?: readonly string[] }>(items: T[]) => items.filter((item) => item.aliases?.includes("grid"));

  it("the three items follow the link item directly and share its group", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink);
    const linkIndex = items.findIndex((item) => item.title === "note.link.slashTitle");
    expect(items.slice(linkIndex + 1, linkIndex + 4).map((item) => item.title)).toEqual(COLUMN_TITLES);
    expect(items.slice(linkIndex + 1, linkIndex + 4).map((item) => item.group)).toEqual(Array(3).fill(items[linkIndex]!.group));
  });

  it("aliases: grid gives three items; grid3 / grid 3 gives only the 3-column item; the Chinese words for side-by-side and column, and columns, each give three items", () => {
    // Titles are replaced with strings that contain no query text, so a hit can only come from an alias (the key string itself contains `columns`).
    const opaque = (key: string, options?: Record<string, unknown>) => (options?.n !== undefined ? `T${String(options.n)}` : translate(key));
    const items = buildSlashMenuItems(editor, opaque, noopInsertLink);
    const titles = (query: string) => filterSuggestionItems(items, query).map((item) => item.title);
    expect(titles("grid")).toEqual(["T2", "T3", "T4"]);
    expect(titles("grid3")).toEqual(["T3"]);
    expect(titles("grid 3")).toEqual(["T3"]);
    expect(titles("並排")).toEqual(["T2", "T3", "T4"]);
    expect(titles("欄")).toEqual(["T2", "T3", "T4"]);
    expect(titles("columns")).toEqual(["T2", "T3", "T4"]);
  });

  it("cursor inside a column -> no such items, other items unchanged", () => {
    const top = buildSlashMenuItems(editor, translate, noopInsertLink).map((item) => item.title);
    const inColumn = mount([row([[P("a", "a1")], [P("b", "b1")]], "r")], "b1");
    const titles = buildSlashMenuItems(inColumn, translate, noopInsertLink).map((item) => item.title);
    expect(titles).toEqual(top.filter((title) => !COLUMN_TITLES.includes(title)));
  });

  it("titles and descriptions in zh-TW and en", async () => {
    await i18n.changeLanguage("zh-TW");
    const zh = columnItems(buildSlashMenuItems(editor, i18n.t.bind(i18n), noopInsertLink));
    expect(zh.map((item) => item.title)).toEqual(["並排 2 欄", "並排 3 欄", "並排 4 欄"]);
    expect(zh[0]!.subtext).toBe("把內容分成左右並排的幾欄");
    await i18n.changeLanguage("en");
    const en = columnItems(buildSlashMenuItems(editor, i18n.t.bind(i18n), noopInsertLink));
    expect(en.map((item) => item.title)).toEqual(["2 columns", "3 columns", "4 columns"]);
    expect(en[0]!.subtext).toBe("Place blocks side by side");
  });

  it("clicking the 2-column item creates a 2-column row after the cursor's paragraph", () => {
    const target = mount([P("x", "x0")], "x0");
    buildSlashMenuItems(target, translate, noopInsertLink)
      .find((item) => item.title === "note.columns.slashTitle:2")!
      .onItemClick();
    expect(shape(target)).toBe("paragraph:x  ROW[COL(paragraph) | COL(paragraph)]  paragraph");
  });
});

describe("tag item /tag", () => {
  const TAG_TITLE = "tags.entry.slashTitle";
  const noopOpenTagEntry = () => {};
  const titlesOf = (target: AnyEditor, onOpenTagEntry?: () => void) =>
    buildSlashMenuItems(target, translate, noopInsertLink, onOpenTagEntry).map((item) => item.title);

  it("lists Tag after the side-by-side items in the extra group when onOpenTagEntry is given, with aliases tag, tags, label, 標籤", () => {
    const items = buildSlashMenuItems(editor, translate, noopInsertLink, noopOpenTagEntry);
    const tagIndex = items.findIndex((item) => item.title === TAG_TITLE);
    expect(items.slice(tagIndex - 3, tagIndex).map((item) => item.title)).toEqual(COLUMN_TITLES);
    expect(items[tagIndex]!.group).toBe(items[tagIndex - 1]!.group);
    expect(items[tagIndex]!.subtext).toBe("tags.entry.slashSubtext");
    expect(items[tagIndex]!.aliases).toEqual(["tag", "tags", "label", "標籤"]);
    expect(groupRuns(items)).toEqual(["Basic blocks", "Advanced", "Media", "Others"]);
  });

  it("lists Tag right after Link when the side-by-side items aren't offered, and in every position", () => {
    const inColumn = mount([row([[P("a", "a1")], [P("b", "b1")]], "r")], "b1");
    const titles = titlesOf(inColumn, noopOpenTagEntry);
    expect(titles[titles.indexOf("note.link.slashTitle") + 1]).toBe(TAG_TITLE);
    // The column case is the position limit that /grid has and /tag must not have.
    expect(titles).toContain(TAG_TITLE);
  });

  it("leaves Tag out without onOpenTagEntry", () => {
    expect(titlesOf(editor)).not.toContain(TAG_TITLE);
  });

  it("choosing Tag calls onOpenTagEntry and inserts no block", () => {
    const onOpenTagEntry = vi.fn();
    buildSlashMenuItems(editor, translate, noopInsertLink, onOpenTagEntry)
      .find((item) => item.title === TAG_TITLE)!
      .onItemClick();
    expect(onOpenTagEntry).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("the tag aliases find it in both languages", () => {
    const items = buildSlashMenuItems(editor, (key) => (key === "note.mermaid.slashGroup" ? "Advanced" : "x"), noopInsertLink, noopOpenTagEntry);
    for (const query of ["tag", "labe", "標籤"]) {
      expect(filterSuggestionItems(items, query).some((item) => item.aliases?.includes("label"))).toBe(true);
    }
  });

  it("titles and descriptions in zh-TW and en", async () => {
    const tagItem = () => buildSlashMenuItems(editor, i18n.t.bind(i18n), noopInsertLink, noopOpenTagEntry).find((item) => item.aliases?.includes("label"))!;
    await i18n.changeLanguage("zh-TW");
    expect([tagItem().title, tagItem().subtext]).toEqual(["標籤", "替這篇筆記加標籤"]);
    await i18n.changeLanguage("en");
    expect([tagItem().title, tagItem().subtext]).toEqual(["Tag", "Add a tag to this note"]);
  });
});

describe("withoutSlashBadges (phones hide the shortcut column)", () => {
  const items = [
    { title: "Heading 1", badge: "Ctrl-Alt-1", onItemClick: () => {} },
    { title: "Table", onItemClick: () => {} },
  ];

  it("no item has a badge; item count and order are unchanged and other fields stay as they were", () => {
    const stripped = withoutSlashBadges(items);
    expect(stripped.map((item) => item.title)).toEqual(["Heading 1", "Table"]);
    expect(stripped.every((item) => !("badge" in item))).toBe(true);
    expect(stripped[0]!.onItemClick).toBe(items[0]!.onItemClick);
  });

  it("does not mutate the original items (docked and phone share one source)", () => {
    withoutSlashBadges(items);
    expect(items[0]!.badge).toBe("Ctrl-Alt-1");
  });
});

describe("slashMenuPhoneMiddleware (phone height and flipping)", () => {
  type SizeOptions = { apply: (args: { elements: { floating: { style: Record<string, string> } }; availableHeight: number }) => void; padding: { bottom: number } };
  type PlacementOptions = { padding: { bottom: number; top: number }; allowedPlacements: string[] };
  const byName = (name: string) => slashMenuPhoneMiddleware().find((entry) => entry.name === name) as unknown as { options: [never, unknown] };

  it("size: max height = min(50vh, available height), clamped to 0 when the available height is negative", () => {
    const options = byName("size").options[0] as SizeOptions;
    const floating = { style: {} as Record<string, string> };
    options.apply({ elements: { floating }, availableHeight: 312 });
    expect(floating.style.maxHeight).toBe("min(50vh, 312px)");
    options.apply({ elements: { floating }, availableHeight: -5 });
    expect(floating.style.maxHeight).toBe("min(50vh, 0px)");
  });

  it("shift's boundary padding is also 8 (matching the padding around the menu)", () => {
    expect((byName("shift").options[0] as { padding: number }).padding).toBe(8);
  });

  it("size and autoPlacement both subtract the editing toolbar at the bottom (available height and the flip decision use the same line)", () => {
    const size = byName("size").options[0] as SizeOptions;
    const placement = byName("autoPlacement").options[0] as PlacementOptions;
    expect(size.padding.bottom).toBeGreaterThanOrEqual(SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX);
    expect(placement.padding.bottom).toBe(size.padding.bottom);
    expect(placement.allowedPlacements).toEqual(["bottom-start", "top-start"]);
  });

  it("bottom padding = editing toolbar frame height + 8", () => {
    expect(SLASH_MENU_PHONE_BOTTOM_CLEARANCE_PX).toBe(PHONE_EDIT_TOOLBAR_CLEARANCE_PX + 8);
  });

  it("PHONE_SLASH_MENU_FLOATING_OPTIONS puts it into useFloatingOptions.middleware", () => {
    expect(PHONE_SLASH_MENU_FLOATING_OPTIONS.useFloatingOptions?.middleware?.map((entry) => entry && "name" in entry && entry.name)).toEqual(["offset", "autoPlacement", "shift", "size"]);
  });
});
