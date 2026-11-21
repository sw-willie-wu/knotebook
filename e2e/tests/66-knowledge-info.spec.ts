import { expect, test, type Locator, type Page } from "@playwright/test";
import { clickEndOfParagraph, editorLocator, waitForEditorSelection } from "./helpers.js";
import {
  RUN,
  apiCreateNote,
  blockIdOfHeading,
  blockOuter,
  createAccount,
  fillForm,
  formOf,
  headingLine,
  hoverCardOf,
  iconForBlock,
  iconOf,
  iconsIn,
  localToday,
  makeKnowledge,
  openAs,
  outerById,
  openFormFromSlash,
  openNote,
  saveForm,
  waitForNoteTitle,
} from "./knowledge-helpers.js";

/**
 * Knowledge info on headings: the form from the three entries, the status icon and its card, the strike-through that outdated knowledge passes down, where the icon sits, copies of a knowledge heading, and the phone sheet.
 * Every test uses freshly created accounts, so notes never overlap between tests; notes are left in place (the stack is reset by `stack:down -v` each time).
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
/** A touch screen at phone width. */
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

/** Computed values of one heading, read in the page. */
async function headingStyle(outer: Locator): Promise<{ decoration: string; paddingRight: string }> {
  return outer.evaluate((el) => {
    const inline = el.querySelector(":scope > .bn-block > .bn-block-content .bn-inline-content")!;
    const style = getComputedStyle(inline);
    return { decoration: style.textDecorationLine, paddingRight: style.paddingRight };
  });
}

async function hoverBlockMenu(page: Page, text: string): Promise<void> {
  await blockOuter(page, text).hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
}

test("66-1 typing /info in a heading opens the form; saving shows a Not verified icon that survives a reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge slash ${RUN}`;
    const note = await apiCreateNote(page, title, "## Release notes\n\nBody text.");
    await openNote(page, note, title);
    await expect(iconsIn(page)).toHaveCount(0);

    await openFormFromSlash(page, "Release notes");
    await expect(formOf(page).getByRole("button", { name: "Remove knowledge info" })).toHaveCount(0);
    await fillForm(page, { when: "Before touching the sync code" });
    await saveForm(page);

    const icon = iconOf(page, "Not verified");
    await expect(icon).toBeVisible();
    const style = await headingStyle(blockOuter(page, "Release notes"));
    expect(style.paddingRight).toBe("28px");

    await page.reload();
    await waitForNoteTitle(page, title);
    await expect(iconOf(page, "Not verified")).toBeVisible({ timeout: 15_000 });
    await expect(headingLine(page, "Release notes")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("66-2 hovering the icon shows the card; Mark verified today turns the icon Verified", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge card ${RUN}`;
    const note = await apiCreateNote(page, title, "## Retry policy\n\nBody text.");
    await openNote(page, note, title);
    await makeKnowledge(page, "Retry policy", { when: "When a job fails twice", conclusion: "Back off before the third try" });

    await iconOf(page, "Not verified").hover();
    const card = hoverCardOf(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText("When a job fails twice");
    await expect(card).toContainText("Back off before the third try");
    await expect(card.getByText("Not verified", { exact: true })).toBeVisible();

    // With a pointer that hovers, the card has its own Edit button and a click on the icon goes straight to the form.
    await card.getByRole("button", { name: "Edit" }).click();
    await expect(formOf(page)).toBeVisible();
    await fillForm(page, { verifiedToday: true });
    await saveForm(page);

    const today = await localToday(page);
    const icon = iconOf(page, "Verified");
    await expect(icon).toBeVisible();
    await page.mouse.move(0, 0);
    await icon.hover();
    await expect(hoverCardOf(page)).toContainText(today);

    await icon.click();
    await expect(formOf(page)).toBeVisible();
    await expect(formOf(page).getByLabel("When to read", { exact: true })).toHaveValue("When a job fails twice");
    await page.keyboard.press("Escape");
    await expect(formOf(page)).toBeHidden();
  } finally {
    await context.close();
  }
});

test("66-3 the drag handle menu opens the same form for that heading", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge handle ${RUN}`;
    const note = await apiCreateNote(page, title, "## Cache rules\n\n## Other heading\n\nBody text.");
    await openNote(page, note, title);

    await hoverBlockMenu(page, "Cache rules");
    await expect(page.getByRole("menuitem", { name: "Edit knowledge info…", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Knowledge info…", exact: true }).click();
    await expect(formOf(page)).toBeVisible();
    await fillForm(page, { conclusion: "Entries expire after a day" });
    await saveForm(page);
    await expect(iconsIn(page)).toHaveCount(1);
    await expect(iconForBlock(page, await blockIdOfHeading(page, "Cache rules"))).toBeVisible();

    await hoverBlockMenu(page, "Cache rules");
    await page.getByRole("menuitem", { name: "Edit knowledge info…", exact: true }).click();
    await expect(formOf(page).getByLabel("Conclusion", { exact: true })).toHaveValue("Entries expire after a day");
    await page.keyboard.press("Escape");
    await expect(formOf(page)).toBeHidden();

    // The other heading is untouched: the menu still offers the plain entry there.
    await hoverBlockMenu(page, "Other heading");
    await expect(page.getByRole("menuitem", { name: "Knowledge info…", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await context.close();
  }
});

test("66-4 an outdated parent strikes through its knowledge child and its icon says Outdated", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge outdated ${RUN}`;
    const note = await apiCreateNote(page, title, "## Old guide\n\n### Old guide detail\n\n## New guide\n\nBody text.");
    await openNote(page, note, title);
    await makeKnowledge(page, "New guide", { when: "Always" });
    await makeKnowledge(page, "Old guide detail", { when: "Only with the old guide" });
    await makeKnowledge(page, "Old guide", { when: "Until the new guide ships", status: "Outdated", replacedBy: "New guide" });

    const detail = blockOuter(page, "Old guide detail");
    const detailId = await blockIdOfHeading(page, "Old guide detail");
    await expect.poll(async () => (await headingStyle(detail)).decoration).toContain("line-through");
    await expect.poll(async () => (await headingStyle(blockOuter(page, "Old guide"))).decoration).toContain("line-through");
    expect((await headingStyle(blockOuter(page, "New guide"))).decoration).not.toContain("line-through");
    await expect(iconForBlock(page, detailId)).toHaveAccessibleName("Knowledge info: Outdated");
    await expect(iconOf(page, "Not verified")).toHaveCount(1);

    await iconForBlock(page, detailId).hover();
    const banner = hoverCardOf(page).locator('[data-kb-knowledge-banner="red"]');
    await expect(banner).toContainText("Old guide");
    await expect(banner).toContainText("above is outdated");

    await page.reload();
    await waitForNoteTitle(page, title);
    await expect.poll(async () => (await headingStyle(blockOuter(page, "Old guide detail"))).decoration, { timeout: 15_000 }).toContain("line-through");
  } finally {
    await context.close();
  }
});

/** Everything about where the icon sits, measured in the page. */
async function placement(outer: Locator): Promise<{ lineRight: number; lineTop: number; lineHeight: number; inlineRight: number; iconLeft: number; iconRight: number; iconMid: number; hashLeft: number | null }> {
  return outer.evaluate((el) => {
    const inline = el.querySelector(":scope > .bn-block > .bn-block-content > .bn-inline-content")!;
    const range = document.createRange();
    range.selectNodeContents(inline);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1]!;
    const icon = el.ownerDocument.querySelector(`[data-kb-knowledge-icon][data-block-id="${el.getAttribute("data-id")}"]`)!.getBoundingClientRect();
    const hash = el.ownerDocument.querySelector('button[aria-label="Copy link to this section"]')?.getBoundingClientRect() ?? null;
    return {
      lineRight: last.right,
      lineTop: last.top,
      lineHeight: last.height,
      inlineRight: inline.getBoundingClientRect().right,
      iconLeft: icon.left,
      iconRight: icon.right,
      iconMid: icon.top + icon.height / 2,
      hashLeft: hash ? hash.left : null,
    };
  });
}

test("66-5 the icon sits after the heading text, the # button after the icon, and neither changes the outline or the selected text", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge place ${RUN}`;
    const longText = "Measured sync latency across regions and the effect on retry policy for background workers";
    const note = await apiCreateNote(page, title, `## Short heading\n\nBody text.\n\n## ${longText}\n\nMore body text.`);
    await openNote(page, note, title);
    await makeKnowledge(page, "Short heading", { when: "Short one" });
    await makeKnowledge(page, longText, { when: "Long one" });

    // One line: icon after the text, "#" after the icon.
    const short = blockOuter(page, "Short heading");
    await short.hover();
    await expect(page.getByRole("button", { name: "Copy link to this section" })).toBeVisible();
    await expect
      .poll(async () => {
        const p = await placement(short);
        return p.iconLeft >= p.lineRight - 0.5 && p.hashLeft !== null && p.hashLeft >= p.iconRight - 0.5 && Math.abs(p.iconMid - (p.lineTop + p.lineHeight / 2)) <= 2;
      })
      .toBe(true);

    // Long heading: adding a word at a time moves the end of the last line through every possible fill; the icon must never overlap the text or leave the column.
    const longId = await blockIdOfHeading(page, longText);
    const long = outerById(page, longId);
    await clickEndOfParagraph(page, headingLine(page, longText));
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.type(i % 2 === 0 ? " words" : " a");
      await waitForEditorSelection(page);
      await expect(iconForBlock(page, longId)).toBeVisible();
      await expect
        .poll(
          async () => {
            const p = await placement(long);
            const clear = p.iconLeft >= p.lineRight - 0.5;
            const inside = p.iconRight <= p.inlineRight + 0.5;
            const centred = Math.abs(p.iconMid - (p.lineTop + p.lineHeight / 2)) <= 2;
            return clear && inside && centred ? "ok" : JSON.stringify(p);
          },
          { message: `icon placement after ${i + 1} added words` },
        )
        .toBe("ok");
    }

    // The outline lists the heading text only, and a selection of the heading copies only its text.
    const rail = page.getByTestId("outline-rail");
    await rail.hover();
    const item = page.getByTestId("outline-panel").locator("[data-outline-item]").filter({ hasText: /^Short heading$/ });
    await expect(item).toHaveCount(1);
    await page.mouse.move(0, 0);

    await clickEndOfParagraph(page, headingLine(page, "Short heading"));
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Short heading");
  } finally {
    await context.close();
  }
});

test("66-6 a phone-width tap on the icon opens a bottom sheet with the card, Mark as verified and Edit", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const desktop = await openAs(browser, alice, { viewport: DESKTOP });
  const phone = await openAs(browser, alice, PHONE);
  try {
    const title = `E2E knowledge phone ${RUN}`;
    const note = await apiCreateNote(desktop.page, title, "## Rate limits\n\nBody text.");
    await openNote(desktop.page, note, title);
    await makeKnowledge(desktop.page, "Rate limits", { when: "Before adding a client", conclusion: "Stay under ten requests a second", status: "Needs review" });

    await openNote(phone.page, note, title);
    const icon = iconOf(phone.page, "Needs review");
    await expect(icon).toBeVisible({ timeout: 15_000 });
    await icon.tap();

    const sheet = phone.page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Rate limits");
    await expect(sheet).toContainText("Before adding a client");
    await expect(sheet).toContainText("Stay under ten requests a second");
    const mark = sheet.getByRole("button", { name: "Mark as verified", exact: true });
    const edit = sheet.getByRole("button", { name: "Edit", exact: true });
    for (const button of [mark, edit]) {
      const box = (await button.boundingBox())!;
      expect(Math.round(box.height)).toBe(44);
    }

    await edit.tap();
    await expect(formOf(phone.page)).toBeVisible();
    await expect(formOf(phone.page).getByLabel("Conclusion", { exact: true })).toHaveValue("Stay under ten requests a second");
    await formOf(phone.page).getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(sheet).toBeHidden();

    await icon.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Mark as verified", exact: true }).tap();
    // The sheet is modal, so the icon behind it is hidden from the accessibility tree; its kind attribute still shows the change.
    await expect(sheet).toContainText(await localToday(phone.page));
    await expect(phone.page.locator('[data-kb-knowledge-icon][data-kind="verified"]')).toHaveCount(1);
  } finally {
    await desktop.context.close();
    await phone.context.close();
  }
});

test("66-7 a note without knowledge info has no knowledge element and no reserved space after headings", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge none ${RUN}`;
    const note = await apiCreateNote(page, title, "# First heading\n\n## Second heading\n\nBody text.");
    await openNote(page, note, title);
    await expect(headingLine(page, "Second heading")).toBeVisible();
    await expect(page.locator("[data-kb-knowledge-icon]")).toHaveCount(0);
    await expect(editorLocator(page).locator("[data-knowledge-id]")).toHaveCount(0);
    for (const text of ["First heading", "Second heading"]) {
      const style = await headingStyle(blockOuter(page, text));
      expect(style.paddingRight).toBe("0px");
      expect(style.decoration).not.toContain("line-through");
    }
  } finally {
    await context.close();
  }
});

test("66-8 pasting a knowledge heading elsewhere in the same note gives the copy its own id, kept after a reload", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge copy ${RUN}`;
    const note = await apiCreateNote(page, title, "## Alpha rule\n\nMiddle paragraph.\n\nLast paragraph.");
    await openNote(page, note, title);
    await makeKnowledge(page, "Alpha rule", { when: "Always" });

    // The editor's own copy format is what keeps a heading's knowledge info; the browser clipboard API only exposes the plain and external HTML flavors, so what the copy writes is recorded and replayed into a paste event.
    await page.evaluate(() => {
      const copied: Record<string, string> = {};
      (window as unknown as { __copied: Record<string, string> }).__copied = copied;
      const setData = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (type: string, value: string) {
        copied[type] = value;
        return setData.call(this, type, value);
      };
    });
    await clickEndOfParagraph(page, headingLine(page, "Alpha rule"));
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain("Alpha rule");
    // Copy reads the editor's own selection, which catches up with the browser's a moment later.
    await expect
      .poll(() => editorLocator(page).evaluate((el) => !(el as unknown as { editor: { view: { state: { selection: { empty: boolean } } } } }).editor.view.state.selection.empty))
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as { __copied?: object }).__copied ?? {}))).toContain("blocknote/html");

    // An empty paragraph takes the whole block; pasting at the end of a filled one would only merge the heading's text into it.
    await clickEndOfParagraph(page, headingLine(page, "Last paragraph."));
    await page.keyboard.press("Enter");
    await waitForEditorSelection(page);
    await editorLocator(page).evaluate((el) => {
      const copied = (window as unknown as { __copied: Record<string, string> }).__copied;
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(copied)) data.setData(type, value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });

    const ids = () =>
      editorLocator(page)
        .locator('[data-content-type="heading"][data-knowledge-id]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-knowledge-id")));
    await expect.poll(async () => (await ids()).length, { message: "both headings carry knowledge info" }).toBe(2);
    await expect.poll(async () => new Set(await ids()).size, { message: "the two ids differ" }).toBe(2);

    // Rename the copy, then make the original outdated and replaced by it: the choice only works if the two ids differ.
    const headings = editorLocator(page).locator('[data-content-type="heading"]');
    await expect(headings).toHaveCount(2);
    const second = headings.nth(1);
    await second.click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" copy");
    await expect(headingLine(page, "Alpha rule copy")).toBeVisible();

    await blockOuter(page, "Alpha rule").hover();
    await iconForBlock(page, await blockIdOfHeading(page, "Alpha rule")).click();
    await expect(formOf(page)).toBeVisible();
    await fillForm(page, { status: "Outdated", replacedBy: "Alpha rule copy" });
    await saveForm(page);

    await expect.poll(async () => new Set(await ids()).size).toBe(2);
    await page.reload();
    await waitForNoteTitle(page, title);
    await expect(iconsIn(page)).toHaveCount(2, { timeout: 15_000 });
    expect(new Set(await ids()).size).toBe(2);

    const originalIcon = iconForBlock(page, await blockIdOfHeading(page, "Alpha rule"));
    await originalIcon.hover();
    await expect(hoverCardOf(page).locator('[data-kb-knowledge-banner="red"]')).toContainText("Alpha rule copy");
  } finally {
    await context.close();
  }
});
