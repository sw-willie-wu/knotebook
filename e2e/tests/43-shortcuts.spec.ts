import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  chooseSelectOption,
  adminNav,
  createNote,
  editorLocator,
  loginAs,
  openSelectionAiBox,
  openSiteAdmin,
  selectionAiBox,
  showSidebarTab,
  startSidebarSelection,
  toggleSelectedNote,
  waitForEditorSelection,
} from "./helpers.js";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems } from "../../apps/web/src/components/shortcuts/release-highlights.js";
import { E2E_ORIGIN } from "../ports.js";

/**
 * Verifies the claims of the shortcuts help page (Ctrl+/ modal).
 *
 * Every shortcut and typed trigger on the list has an e2e run in a real browser: the `[sc:<id>]` tag at the end of a test title links the
 * entry to the test (`shortcut-e2e-coverage.test.ts` scans this directory's `*.spec.ts` source text and checks list ids against tags in both
 * directions). The behaviours the help text describes are measured here, so a BlockNote/Tiptap upgrade that changes one fails here first,
 * prompting an update of the text.
 *
 * - One test per category, each creating its own note with `createNote` (no shared page).
 *   Keys use `ControlOrMeta` (Control on the Linux stack).
 * - Titles are plain string literals (no template literal): the coverage test only recognises the first argument of `test("...")`.
 * - Verified on Chromium only.
 * - Entries covered by other specs are not rewritten here (presentOverview, presentExit: `22-presentation.spec.ts`; dragNoteToEditor,
 *   dragNoteToFolder: `42-folders-drag.spec.ts`; dragBlockCopy: `49-drag-undo.spec.ts`).
 */

const RUN = Date.now();
const ORIGIN = E2E_ORIGIN;

async function startNote(page: Page, label: string): Promise<Locator> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E sc ${label} ${RUN}`);
  const editor = editorLocator(page);
  await editor.click();
  await waitForEditorSelection(page);
  return editor;
}

async function caretBlockType(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; firstChild: PmNode | null };
    type View = { state: { selection: { $head: { depth: number; node(d: number): PmNode } } } };
    const view = (el as Element & { editor?: { view?: View } }).editor?.view;
    if (!view) return "no-editor";
    const $h = view.state.selection.$head;
    for (let d = $h.depth; d >= 0; d--) {
      const node = $h.node(d);
      if (node.type.name === "blockContainer") return node.firstChild!.type.name;
    }
    return "none";
  });
}

/** Opens an empty plain paragraph at the end of the note (after a list, heading or quote, Backspace converts it back to a paragraph). */
async function freshParagraph(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 3; i++) {
    await waitForEditorSelection(page);
    if ((await caretBlockType(page)) === "paragraph") return;
    await page.keyboard.press("Backspace");
  }
  expect(await caretBlockType(page), "freshParagraph：游標所在區塊轉不回一般段落").toBe("paragraph");
}

function blocksOf(page: Page, type: string): Locator {
  return editorLocator(page).locator(`.bn-block-content[data-content-type="${type}"]`);
}

async function selectToLineStart(page: Page): Promise<void> {
  await page.keyboard.press("Shift+Home");
  await expect
    .poll(() =>
      editorLocator(page).evaluate((el) => {
        const view = (el as Element & { editor?: { view?: { state: { selection: { empty: boolean } } } } }).editor?.view;
        return view ? !view.state.selection.empty : null;
      }),
    )
    .toBe(true);
}

async function blockTexts(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((el) => {
    const view = (el as Element & { editor?: { view?: { state: { doc: { descendants(f: (n: { type: { name: string }; isTextblock: boolean; textContent: string }) => void): void } } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const out: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.isTextblock) out.push(n.textContent);
    });
    return out;
  });
}

async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

test("Global: Ctrl+K focuses the sidebar search box; Esc clears the search and returns to the tab list [sc:search] [sc:searchClear]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "global-search");
  const search = page.getByRole("textbox", { name: "Search notes" });
  await expect(search).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();

  const tabs = page.getByRole("tablist", { name: "Sidebar sections" });
  await expect(tabs).toBeVisible();
  await page.keyboard.type("zzz-no-such-note");
  await expect(search).toHaveValue("zzz-no-such-note");
  await expect(tabs).toHaveCount(0); // while searching the tab list is replaced by results

  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).not.toBeFocused();
  await expect(tabs).toBeVisible();
});

test("Global: Ctrl+S saves a version on an editable note page [sc:saveVersion]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "global-save");
  await page.keyboard.type("version body");
  await expect(editor).toContainText("version body");
  await page.keyboard.press("ControlOrMeta+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  const name = `sc-version-${RUN}`;
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const noteId = await noteIdFromUrl(page);
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${noteId}/versions?limit=100`);
    expect(res.ok()).toBe(true);
    const { versions } = (await res.json()) as { versions: Array<{ name: string | null }> };
    expect(versions.some((v) => v.name === name)).toBe(true);
  }).toPass({ timeout: 15_000 });
});

test("Typed trigger: / opens the insert menu [sc:slashMenu]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "typing-slash");
  await page.keyboard.type("/");
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const titles = (await menu.locator(".bn-mt-suggestion-menu-item-title").allTextContents()).map((s) => s.trim());
  for (const wanted of ["Heading 1", "Bullet List", "Table", "Image"]) expect(titles, `選單項 ${wanted}`).toContain(wanted);
  expect(titles.some((s) => /diagram/i.test(s)), "選單有流程圖項").toBe(true);
  expect(titles.some((s) => /columns/.test(s)), "選單有並排項").toBe(true);
});

test("Typed trigger: [[ links to another note and the target gets a backlink [sc:wikilink]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const stamp = String(Date.now());
  const targetTitle = `E2E sc wiki target ${stamp}`;
  await createNote(page, targetTitle);
  const targetId = await noteIdFromUrl(page);
  await createNote(page, `E2E sc wiki source ${stamp}`);
  const sourceId = await noteIdFromUrl(page);
  await editorLocator(page).click();
  await waitForEditorSelection(page);
  await page.keyboard.type("[[");
  await page.keyboard.type(`wiki target ${stamp}`); // type only the target's title: the source's own title also contains stamp and would be picked
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByText(targetTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  const wikilink = editorLocator(page).locator('[data-inline-content-type="wikilink"]');
  await expect(wikilink).toHaveCount(1, { timeout: 10_000 });
  await expect(wikilink).toContainText(targetTitle);
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${targetId}/backlinks`);
    expect(res.status()).toBe(200);
    const { backlinks } = (await res.json()) as { backlinks: Array<{ id: string }> };
    expect(backlinks.map((b) => b.id)).toContain(sourceId);
  }).toPass({ timeout: 20_000 });
});

test("Typed trigger: [text](url) becomes an external link when the closing parenthesis is typed [sc:markdownLink]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "typing-mdlink");
  await page.keyboard.type("go [example](https://example.com)");
  const link = editor.locator('a[href="https://example.com"]');
  await expect(link).toHaveCount(1, { timeout: 10_000 });
  await expect(link).toHaveText("example");
  expect(await blockTexts(page)).toEqual(["go example"]); // brackets and URL are consumed, only the display text remains
});

test("Markdown shorthand: block-start # - 1. [] > ``` --- [sc:heading] [sc:bullet] [sc:numbered] [sc:checklist] [sc:quote] [sc:codeBlock] [sc:divider]", async ({ page }) => {
  test.setTimeout(150_000);
  await startNote(page, "md-blocks");

  const levels: Array<number | null> = [];
  for (let n = 1; n <= 6; n++) {
    await freshParagraph(page);
    await page.keyboard.type(`${"#".repeat(n)} h${n}`);
    const h = editorLocator(page).locator(".bn-block-content[data-content-type='heading']", { hasText: `h${n}` });
    // Level 1 is the default and BlockNote writes no data-level for it; no attribute means 1.
    levels.push((await h.count()) === 0 ? null : Number((await h.first().getAttribute("data-level")) ?? "1"));
  }
  test.info().annotations.push({ type: "heading-levels", description: JSON.stringify(levels) });
  expect(levels, "# 到 ###### 對應標題 1 到 6 級").toEqual([1, 2, 3, 4, 5, 6]);

  for (const mark of ["-", "*", "+"]) {
    await freshParagraph(page);
    await page.keyboard.type(`${mark} b${mark === "-" ? "d" : mark === "*" ? "s" : "p"}`);
  }
  await expect(blocksOf(page, "bulletListItem")).toHaveCount(3);

  await freshParagraph(page);
  await page.keyboard.type("1. num");
  await expect(blocksOf(page, "numberedListItem")).toHaveCount(1);

  await freshParagraph(page);
  await page.keyboard.type("[] todo");
  await freshParagraph(page);
  await page.keyboard.type("[x] done");
  const checks = blocksOf(page, "checkListItem");
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0).locator("input[type=checkbox]")).not.toBeChecked();
  await expect(checks.nth(1).locator("input[type=checkbox]")).toBeChecked();

  await freshParagraph(page);
  await page.keyboard.type("> quoted");
  await expect(blocksOf(page, "quote")).toHaveCount(1);

  await freshParagraph(page);
  await page.keyboard.type("```ts");
  await expect(blocksOf(page, "codeBlock"), "``` 後沒打空白時還不是程式碼區塊").toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(blocksOf(page, "codeBlock")).toHaveCount(1);
  await expect(blocksOf(page, "codeBlock").first()).toHaveAttribute("data-language", "typescript");

  await freshParagraph(page);
  await page.keyboard.type("---");
  await expect(blocksOf(page, "divider")).toHaveCount(1);
});

test("Markdown shorthand: inline `code` **bold** *italic* ~~strikethrough~~ [sc:inlineCode] [sc:inlineMarks]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "md-inline");
  const cases: Array<[string, string, string]> = [
    ["`mono`", "code", "mono"],
    ["**bolded**", "strong", "bolded"],
    ["*slanted*", "em", "slanted"],
    ["~~struck~~", "s", "struck"],
  ];
  for (const [typed, tag, text] of cases) {
    await freshParagraph(page);
    await page.keyboard.type(typed);
    await expect(editor.locator(tag, { hasText: new RegExp(`^${text}$`) }), `${typed} → <${tag}>`).toHaveCount(1);
  }
  expect((await blockTexts(page)).filter((s) => s !== "")).toEqual(["mono", "bolded", "slanted", "struck"]);
});

test("Text formatting: Ctrl+B/I/U, Ctrl+Shift+S, Ctrl+E [sc:bold] [sc:italic] [sc:underline] [sc:strike] [sc:codeMark]", async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await startNote(page, "fmt-marks");
  const cases: Array<[string, string, string]> = [
    ["ControlOrMeta+b", "strong", "wbold"],
    ["ControlOrMeta+i", "em", "witalic"],
    ["ControlOrMeta+u", "u", "wunder"],
    ["ControlOrMeta+Shift+s", "s", "wstrike"],
    ["ControlOrMeta+e", "code", "wcode"],
  ];
  for (const [combo, tag, word] of cases) {
    await freshParagraph(page);
    await page.keyboard.type(word);
    await selectToLineStart(page);
    await page.keyboard.press(combo);
    await expect(editor.locator(tag, { hasText: new RegExp(`^${word}$`) }), `${combo} → <${tag}>`).toHaveCount(1);
    await page.keyboard.press("ArrowRight"); // collapse the selection so the next round starts a new paragraph after this one
  }
});

test("Text formatting: Ctrl+K on selected text adds a link (does not jump to search) [sc:link]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "fmt-link");
  await page.keyboard.type("linkword");
  await selectToLineStart(page);
  await page.keyboard.press("ControlOrMeta+k");
  const urlInput = page.getByPlaceholder("Edit URL");
  await expect(urlInput).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: "Search notes" })).not.toBeFocused();
  await urlInput.fill("https://example.com/sc");
  await urlInput.press("Enter");
  await expect(editorLocator(page).locator('a[href="https://example.com/sc"]')).toHaveText("linkword");
});

test("Text formatting: Ctrl+Z undoes, Ctrl+Y/Ctrl+Shift+Z redoes [sc:undo] [sc:redo]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "fmt-undo");
  // Only measures "second disappears after undo and comes back after redo". Continuous typing (including Enter) within y-prosemirror's
  // captureTimeout (500 ms) merges into one undo step, so Ctrl+Z may also undo first; that is why first is not asserted to remain.
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(editor).toContainText("second");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).not.toContain("second");
  await page.keyboard.press("ControlOrMeta+y");
  await expect.poll(() => blockTexts(page)).toContain("second");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).not.toContain("second");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => blockTexts(page)).toContain("second");
});

test("Text formatting: Tab/Shift+Tab indent, Shift+Enter breaks a line inside a paragraph [sc:indent] [sc:lineBreak]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "fmt-indent");
  await page.keyboard.type("- top");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await expect(blocksOf(page, "bulletListItem")).toHaveCount(2);
  const nestedGroups = editor.locator(".bn-block-group .bn-block-group");
  await expect(nestedGroups).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(nestedGroups).toHaveCount(1); // the second item becomes a child block of the first
  await page.keyboard.press("Shift+Tab");
  await expect(nestedGroups).toHaveCount(0);

  await freshParagraph(page);
  await page.keyboard.type("plain child");
  await page.keyboard.press("Tab");
  await expect(nestedGroups).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(nestedGroups).toHaveCount(0);

  await freshParagraph(page);
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  const para = editor.locator(".bn-block-content[data-content-type='paragraph']", { hasText: "line one" });
  await expect(para).toHaveCount(1); // still the same block
  await expect(para.locator("br")).toHaveCount(1);
  await expect(para).toContainText("line two");
});

test("Text formatting: Ctrl+Shift+Up/Down moves a paragraph up/down [sc:moveBlock]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "fmt-move");
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("bravo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("charlie");
  await waitForEditorSelection(page);
  expect(await blockTexts(page)).toEqual(["alpha", "bravo", "charlie"]);
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp"); // charlie up
  await expect.poll(() => blockTexts(page)).toEqual(["alpha", "charlie", "bravo"]);
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown"); // then down
  await expect.poll(() => blockTexts(page)).toEqual(["alpha", "bravo", "charlie"]);
});

const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';

async function docShape(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; childCount: number; child(i: number): PmNode; firstChild: PmNode | null; textContent: string };
    const view = (el as Element & { editor?: { view?: { state: { doc: PmNode } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const kids = (n: PmNode): PmNode[] => Array.from({ length: n.childCount }, (_, i) => n.child(i));
    const shapeOf = (n: PmNode): string => {
      if (n.type.name === "columnList") return `ROW[${kids(n).map(shapeOf).join(" | ")}]`;
      if (n.type.name === "column") return `COL(${kids(n).map(shapeOf).join(",")})`;
      const content = n.firstChild!;
      const text = content.textContent;
      const group = n.childCount > 1 ? n.child(1) : null;
      return `${content.type.name}${text ? `:${text}` : ""}${group ? `{${kids(group).map(shapeOf).join(",")}}` : ""}`;
    };
    return kids(view.state.doc.firstChild!).map(shapeOf).join("  ");
  });
}

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) })
    .last();
}

async function caretIn(page: Page, text: string, where: "Home" | "End"): Promise<void> {
  await blockOuter(page, text).locator(".bn-inline-content").first().click();
  await page.keyboard.press(where);
  await waitForEditorSelection(page);
}

async function slashTitles(page: Page): Promise<string[]> {
  return (await page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title").allTextContents()).map((t) => t.trim());
}

test("Columns: / then \"2 columns\" creates columns; the menu does not offer it when the caret is inside a column [sc:columnsInsert]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-insert");
  await page.keyboard.type("/grid");
  await expect.poll(() => slashTitles(page)).toEqual(expect.arrayContaining(["2 columns", "3 columns", "4 columns"]));
  await page.keyboard.press("Enter"); // the first item is 2 columns
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(2);
  await waitForEditorSelection(page);
  // The caret is now in column 1: typing / shows the menu (positive anchor: contains Heading 1) without a columns item.
  await page.keyboard.type("/");
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => slashTitles(page)).toContain("Heading 1");
  expect((await slashTitles(page)).filter((t) => /columns/.test(t))).toEqual([]);
  await page.keyboard.press("Escape");
});

test("Columns: Backspace at column start moves the paragraph to the previous column; Delete at column end pulls the next column's first paragraph up [sc:columnBackspace] [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(120_000);
  await startNote(page, "cols-edge");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b", "c", "d"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]");

  await caretIn(page, "b", "Home");
  await page.keyboard.press("Backspace");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]");

  await caretIn(page, "b", "End");
  await page.keyboard.press("Delete");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a,paragraph:b,paragraph:c) | COL(paragraph:d)]");
});

test("Columns: Backspace in an empty column deletes it; Delete at column end deletes an empty next column; with one column left the row unwraps into stacked paragraphs [sc:columnBackspace] [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await startNote(page, "cols-empty");
  await page.keyboard.type("/grid3");
  await expect.poll(() => slashTitles(page)).toEqual(["3 columns"]);
  await page.keyboard.press("Enter");
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(3);
  await waitForEditorSelection(page);
  await page.keyboard.type("keep");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph) | COL(paragraph)]");

  await page.keyboard.press("Delete");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph)]");

  await editor.locator(COL).nth(1).click();
  await waitForEditorSelection(page);
  await page.keyboard.press("Backspace");
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:keep");
});

test("Columns: with two columns, Delete at column end with an empty second column unwraps the row into stacked paragraphs [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-delete-last");
  await page.keyboard.type("/grid2");
  await expect.poll(() => slashTitles(page)).toEqual(["2 columns"]);
  await page.keyboard.press("Enter");
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(2);
  await waitForEditorSelection(page);
  await page.keyboard.type("keep");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph)]");
  await page.keyboard.press("Delete"); // end of column 1, column 2 empty: deletes column 2, one column left, row unwraps
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:keep");
});

test("Columns: the drag-handle menu's \"Ungroup columns\" unwraps the row into stacked paragraphs [sc:columnUngroup]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-ungroup");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["l", "r"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:l) | COL(paragraph:r)]");
  await blockOuter(page, "r").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Ungroup columns" }).click();
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:l  paragraph:r  paragraph:z");
});

test("Mouse: dragging the drag handle moves a paragraph [sc:dragBlock]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "mouse-drag");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("three");
  await waitForEditorSelection(page);
  expect(await blockTexts(page)).toEqual(["one", "two", "three"]);

  await blockOuter(page, "one").hover();
  const handle = page.getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const t = (await blockOuter(page, "three").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10, h.y + h.height / 2 + 10, { steps: 5 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.75, { steps: 15 });
  await page.mouse.move(t.x + t.width / 2 + 2, t.y + t.height * 0.75);
  await page.mouse.up();
  await expect.poll(() => blockTexts(page)).toEqual(["two", "three", "one"]);
});

test("Sidebar: Esc ends select mode (no effect while focus is in the body); Shift+click selects a range [sc:selectEsc] [sc:selectRange]", async ({ page }) => {
  test.setTimeout(150_000);
  const titles = ["A", "B", "C", "D"].map((s) => `E2E sc sel ${s} ${RUN}`);
  await loginAs(page, ADMIN.email, ADMIN.password);
  for (const title of titles) {
    const res = await page.request.post("/api/notes", { data: { title } });
    expect(res.status(), await res.text()).toBe(201);
  }
  await page.goto("/");
  await showSidebarTab(page, "My notes");

  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  await toggleSelectedNote(panel, titles[3]!, { shift: true });
  for (const title of titles) await expect(panel.getByRole("checkbox", { name: new RegExp("^" + title) })).toBeChecked();

  expect(await panel.locator(":focus").count(), "焦點在側欄的勾選框上").toBe(1);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  const main = page.getByRole("main");
  const box = (await main.boundingBox())!;
  await main.click({ position: { x: 24, y: box.height - 24 } });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  await panel.getByRole("link", { name: new RegExp("^" + titles[1]) }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(titles[1]!, { timeout: 15_000 });
  await showSidebarTab(page, "My notes");
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.type("x");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: new RegExp("^" + titles[0]) })).toBeChecked();
});

const DECK = ["Intro paragraph", "", "## Chapter A", "", "alpha text", "", "### Section A2", "", "a2 text", "", "## Chapter B", "", "beta text", ""].join("\n");

async function currentSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector(".reveal .slides section.present[data-kn-slide-id]")?.getAttribute("data-kn-slide-id") ?? null);
}

async function slideIdContaining(page: Page, text: string): Promise<string> {
  const id = await page.evaluate(
    (needle) => Array.from(document.querySelectorAll(".reveal .slides section[data-kn-slide-id]")).find((s) => s.textContent?.includes(needle))?.getAttribute("data-kn-slide-id") ?? null,
    text,
  );
  expect(id, `找不到含「${text}」的投影片`).not.toBeNull();
  return id!;
}

async function presentFromHeaderMenu(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test("Presentation: right/left arrows change chapter, down/up change section [sc:presentNav]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E sc present nav ${RUN}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
  await presentFromHeaderMenu(page, title);

  const start = await currentSlideId(page);
  await page.keyboard.press("ArrowRight");
  const chapterA = await slideIdContaining(page, "Chapter A");
  await expect.poll(() => currentSlideId(page)).toBe(chapterA);
  await page.keyboard.press("ArrowDown");
  const a2 = await slideIdContaining(page, "Section A2");
  await expect.poll(() => currentSlideId(page)).toBe(a2);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => currentSlideId(page)).toBe(chapterA);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => currentSlideId(page)).toBe(start);
});

test("Presentation: F toggles fullscreen (already fullscreen when entered from the menu) [sc:presentFullscreen]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E sc present fs ${RUN}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
  await presentFromHeaderMenu(page, title);

  const isFs = () => page.evaluate(() => document.fullscreenElement !== null);
  await expect.poll(isFs).toBe(true); // already fullscreen when entering presentation from the menu
  await page.keyboard.press("f");
  await expect.poll(isFs).toBe(false); // F exits first
  await page.waitForTimeout(350); // guard window against double exit: a semantic interval, not a wait condition
  await page.keyboard.press("f");
  await expect.poll(isFs).toBe(true); // pressing again returns to fullscreen

  // Cleanup: exit fullscreen the way a browser Esc does, then press Esc to leave the presentation.
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await page.waitForTimeout(350);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// ── AI ─────────────────────────────────────────────────────────────────────────────────────────

const PROVIDER_NAME = `E2E SC Provider ${RUN}`;
const MODEL_DISPLAY_NAME = `E2E SC Model ${RUN}`;

test.describe.serial("ai facts", () => {
  test("AI: create a provider (/fast, Default model checked)", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, ADMIN.email, ADMIN.password);
    await openSiteAdmin(page);
    await adminNav(page, "AI agents");
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const providerDialog = page.getByRole("dialog", { name: "Add provider" });
    await providerDialog.locator("#ai-provider-name").fill(PROVIDER_NAME);
    await chooseSelectOption(page, providerDialog.locator("#ai-provider-type"), "OpenAI-compatible");
    await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/fast");
    await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(providerDialog).not.toBeVisible();
    await page.getByRole("row", { name: `${PROVIDER_NAME} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
    const modelDialog = page.getByRole("dialog", { name: "Add model" });
    await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-sc-model");
    await modelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await modelDialog.getByLabel("Default model", { exact: true }).check();
    await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(modelDialog).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  });

  test("AI: the toolbar AI button opens the box on selected text; Shift+Enter breaks a line and Enter sends in the box; Esc closes [sc:aiSelect] [sc:aiSend] [sc:aiClose]", async ({ page }) => {
    test.setTimeout(120_000);
    await startNote(page, "ai");
    await page.keyboard.type("ai target text");
    await waitForEditorSelection(page);

    const box = await openSelectionAiBox(page, "ai target text");

    await box.press("Escape");
    await expect(box).toBeHidden();

    const box2 = await openSelectionAiBox(page, "ai target text");
    const input = box2.getByRole("textbox", { name: "Instruction for the selected text" });
    await input.fill("first");
    await input.press("Shift+Enter");
    await input.pressSequentially("second");
    expect(await input.inputValue()).toBe("first\nsecond"); // Shift+Enter breaks the line and does not send
    await expect(selectionAiBox(page).getByTestId("selection-ai-preview")).toHaveCount(0);
    await input.press("Enter"); // Enter sends
    await expect(selectionAiBox(page).getByTestId("selection-ai-preview")).toContainText("E2E rewritten text", { timeout: 15_000 });
  });
});

/** The Help dialog: shortcuts, the feature tour and What's new share one dialog. */
const shortcutsDialog = (page: Page): Locator => page.getByRole("dialog", { name: "Help", exact: true });

async function presentFromHeaderMenuForDialog(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test.describe("shortcuts dialog", () => {
  test("wide: Ctrl+/ opens it, no extra / in the body, PageDown scrolls, Tab cycles between content and the close button, after Esc the caret returns to where it was [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    const editor = await startNote(page, "dlg-open");
    await page.keyboard.type("abc");
    await waitForEditorSelection(page);
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 3, name: "General" })).toBeVisible();
    await expect(editor).toContainText("abc");
    expect(await blockTexts(page)).toEqual(["abc"]); // no extra /
    await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);

    const content = dialog.locator("[data-shortcuts-content]");
    await expect(content).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(content).toBeFocused();

    const formatting = dialog.getByRole("button", { name: "Text formatting" });
    // "Text formatting" is long enough for PageDown to scroll.
    await formatting.click();
    await expect(formatting).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("button", { name: "General" })).not.toHaveAttribute("aria-current", "true");
    await expect(formatting).toBeFocused();
    await expect(dialog.getByRole("region", { name: "Text formatting" })).toBeVisible();
    await expect(dialog.locator('[data-shortcut-id="search"]')).toHaveCount(0);
    await expect(dialog.locator('[data-shortcut-id="bold"]')).toHaveCount(1);
    await content.click({ position: { x: 4, y: 4 } });
    await expect(content).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Radix restores focus via setTimeout(0) after unmount: wait for focus to be back in the editor before typing, otherwise "d" can beat the focus restore (a source of flakes).
    await expect(editor).toBeFocused();
    await page.keyboard.type("d");
    await expect.poll(() => blockTexts(page)).toEqual(["abcd"]); // focus and caret are back where they were
  });

  test("opened from the user menu, Esc returns focus to the trigger button [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-menu");
    const trigger = page.getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Feature tour", exact: true })).toHaveCount(0);
    const item = page.getByRole("menuitem", { name: "Help", exact: true });
    await expect(item).toContainText("Ctrl+/");
    await item.click();
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("opened from the user menu it lands on the Feature tour page with a Start tour button; the What's new page has a version heading; Ctrl+/ opens on General", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-help-pages");
    await page.getByRole("button", { name: "admin", exact: true }).click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog.getByRole("button", { name: "Feature tour", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("region", { name: "Feature tour" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Start tour", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "What's new", exact: true }).click();
    // This test signs in as the site admin, who sees every entry of the registry.
    if (visibleHighlightItems(RELEASE_HIGHLIGHTS.items, true).length === 0) {
      await expect(dialog.getByRole("region", { name: "What's new" })).toContainText("Nothing new to highlight in this version.");
    } else {
      await expect(dialog.locator('[data-help-page-content="whatsNew"]').getByRole("heading", { level: 3, name: `New in v${RELEASE_HIGHLIGHTS.version}`, exact: true })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(dialog.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
  });

  test("pressing Ctrl+/ again closes it [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-toggle");
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
  });

  test("Ctrl+/ does not open the shortcuts page while the settings modal is open [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-other");
    await page.getByRole("button", { name: "admin", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\//);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1); // still only the settings dialog
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the AI section matches site capability [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-ai");
    const res = await page.request.get("/api/ai/actions");
    expect(res.ok()).toBe(true);
    const { actions } = (await res.json()) as { actions: Array<{ kind: string }> };
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
    const aiNav = dialog.getByRole("button", { name: "AI", exact: true });
    await expect(aiNav).toHaveCount(actions.length > 0 ? 1 : 0); // without AI on the site the whole category is absent
    if (actions.length > 0) {
      await aiNav.click();
      await expect(dialog.getByRole("region", { name: "AI" })).toBeVisible();
    }
    await expect(dialog.locator('[data-shortcut-id="aiSend"]')).toHaveCount(actions.some((a) => a.kind === "instruct") ? 1 : 0);
    test.info().annotations.push({ type: "e5-site", description: `actions=${actions.length} instruct=${actions.some((a) => a.kind === "instruct")}` });
  });

  test("phone (390 wide): Ctrl+K on a note screen returns to the list and focuses the bottom search box, Esc closes search; opening shortcuts from the top bar avatar, Esc closes only the shortcuts page [sc:search] [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-phone");
    await page.setViewportSize({ width: 390, height: 844 });
    const search = page.getByRole("textbox", { name: "Search notes", exact: true });
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    await expect(search).toBeHidden();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(page.locator("[data-phone-list-fabs]").getByRole("button", { name: "New note", exact: true })).toBeVisible();

    const trigger = page.locator("[data-phone-top-bar]").getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    // On a phone the shortcuts page is a sheet rising from the bottom: measure after the entry animation (mid-rise part of the frame is below the viewport).
    await expect.poll(() => dialog.evaluate((el) => el.getAnimations().length)).toBe(0);
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    // Esc closes only the shortcuts page (not the list's "Back to menu", so the account menu does not reopen); focus returns to the avatar button.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("floating sidebar (700 wide): Ctrl+K opens the sidebar first; opening shortcuts from the user menu in the drawer keeps the drawer, and Esc closes only the shortcuts page [sc:search] [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-narrow");
    await page.setViewportSize({ width: 700, height: 844 });
    // The search help says a narrow screen opens the sidebar first: Ctrl+K opens the drawer and focuses the search box inside it.
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("textbox", { name: "Search notes" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(drawer).toBeVisible();
    const trigger = drawer.getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    // While the shortcuts page is open Radix marks the drawer aria-hidden (expected), so use an attribute selector instead of getByRole.
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    // A narrow screen shows one pane at a time: opened from the menu it shows the right card (feature tour) first; the left card (two pages, categories, hint) is after "Back".
    await expect(dialog.getByRole("region", { name: "Feature tour" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Text formatting" })).toBeHidden();
    await dialog.getByRole("button", { name: "Back to sections" }).click();
    const footer = dialog.locator("[data-shortcuts-footer]");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Feature tour", exact: true })).toBeFocused(); // focus returns to the current item
    await dialog.getByRole("button", { name: "Mouse" }).click();
    const mouseRegion = dialog.getByRole("region", { name: "Mouse" });
    await expect(mouseRegion).toBeVisible();
    await expect(mouseRegion).toBeFocused(); // on a narrow screen, picking a category moves focus into the content
    await expect(dialog.getByRole("button", { name: "General" })).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("every category in the left column can be clicked, and the right card shows only the selected one (heading = region name = the aria-current item)", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-cats");
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-shortcuts-category]").first()).toBeVisible(); // the content chunk has loaded
    const names = await dialog.locator("[data-shortcuts-category]").allTextContents();
    expect(names.slice(0, 3)).toEqual(["General", "Typing triggers", "Markdown shortcuts"]);
    for (const name of names) {
      await dialog.getByRole("button", { name, exact: true }).click();
      await expect(dialog.getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "true");
      await expect(dialog.getByRole("region", { name, exact: true })).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
      await expect(dialog.locator("[data-shortcut-id]").first()).toBeVisible();
    }
  });

  test("Ctrl+, opens settings (also from the body text); pressing it again while open does nothing; closing returns to the original note page [sc:openSettings]", async ({ page }) => {
    test.setTimeout(90_000);
    const editor = await startNote(page, "dlg-settings");
    await page.keyboard.type("abc");
    await waitForEditorSelection(page);
    const noteUrl = page.url();
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    // With settings open, pressing again does nothing. An unchanged URL and dialog count are not enough (the background page's location is unchanged, so a redirect would look the same): also check history gained no entry.
    const historyBefore = await page.evaluate(() => history.length);
    await page.keyboard.press("ControlOrMeta+,");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(0)))));
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(noteUrl);
    await expect(editor).toContainText("abc");
    expect(await blockTexts(page)).toEqual(["abc"]); // the editor did nothing with Ctrl+, (text is still abc)
  });

  test("Ctrl+/ does not open the shortcuts page during presentation [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, ADMIN.email, ADMIN.password);
    const title = `E2E sc present dlg ${RUN}`;
    await createNote(page, title);
    await pasteMarkdown(page, DECK);
    await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
    await presentFromHeaderMenuForDialog(page, title);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    // Cleanup: in fullscreen the browser swallows Esc, so exit fullscreen the way a browser does, then press Esc to leave the presentation.
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  // Known side effect: on keyboard layouts where `/` needs Shift (e.g. German Ctrl+Shift+7, key="/", keyCode=55), prosemirror-keymap falls back to
  // keyCode when Ctrl is held and matches BlockNote's Mod-Shift-7 (convert to numbered list) inside the editor. This case simulates it with CDP and
  // only records and asserts the observed result (docs/known-limitations.md is written from it).
  test("German-style Ctrl+Shift+7 (key=/): separate outcomes inside and outside the editor", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-de");
    await page.keyboard.type("seven");
    await waitForEditorSelection(page);
    const cdp = await page.context().newCDPSession(page);
    const send = async () => {
      const base = { key: "/", code: "Digit7", windowsVirtualKeyCode: 55, nativeVirtualKeyCode: 55, modifiers: 2 | 8 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    await send();
    await page.waitForTimeout(500); // for recording: gives event handling time, not a wait condition
    const inEditor = { blockType: await caretBlockType(page), dialog: await shortcutsDialog(page).count() };
    test.info().annotations.push({ type: "e8-in-editor", description: JSON.stringify(inEditor) });
    if (inEditor.dialog > 0) await page.keyboard.press("Escape");
    const main = page.getByRole("main");
    const mainBox = (await main.boundingBox())!;
    await main.click({ position: { x: 24, y: mainBox.height - 24 } });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await send();
    await expect(shortcutsDialog(page)).toHaveCount(1); // positive: outside the body text it opens as usual (retrying assertion, no fixed wait)
    const onBody = { dialog: await shortcutsDialog(page).count() };
    test.info().annotations.push({ type: "e8-on-body", description: JSON.stringify(onBody) });
    // Observed (Chromium, CDP simulation): the paragraph in the body is converted to a numbered list and the shortcuts page does not open; outside the body it opens as usual. docs/known-limitations.md is written from this.
    expect(inEditor).toEqual({ blockType: "numberedListItem", dialog: 0 });
    expect(onBody).toEqual({ dialog: 1 });
  });
});
