import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, reEscape, setAutoWait, versionLabelOf, waitForEditorSelection } from "./helpers.js";

/**
 * Side-by-side block alignment: the two columns' top-level blocks carry `data-diff-row`. The two sides of the same row have
 * tops within 1 px; for a row present on one side only, the opposite column has a `.kb-diff-spacer` covering that row's height
 * (tolerance 1 px). `minSingle`: how many single-side rows there must be at least (avoids an empty assertion).
 * The layout is written inside a layout effect / ResizeObserver + rAF, so retry with toPass. One evaluate reads both columns
 * (the same layout snapshot).
 */
async function expectSplitAligned(page: Page, minSingle: number) {
  const split = page.getByTestId("diff-split");
  await expect(async () => {
    const m = await split.evaluate((root) => {
      const secs = Array.from(root.querySelectorAll<HTMLElement>(":scope > section"));
      return secs.map((sec) => ({
        blocks: Array.from(sec.querySelectorAll<HTMLElement>(".bn-editor > .bn-block-group > .bn-block-outer[data-diff-row]")).map((el) => ({
          row: el.dataset.diffRow!,
          top: el.getBoundingClientRect().top,
          height: el.offsetHeight,
        })),
        spacers: Array.from(sec.querySelectorAll<HTMLElement>(":scope > .kb-diff-spacer")).map((el) => ({ top: el.getBoundingClientRect().top, height: el.offsetHeight })),
      }));
    });
    expect(m).toHaveLength(2);
    const [L, R] = m;
    expect(L.blocks.length + R.blocks.length).toBeGreaterThan(0);
    let single = 0;
    for (const [mine, other] of [
      [L, R],
      [R, L],
    ] as const) {
      for (const blk of mine.blocks) {
        const twin = other.blocks.find((o) => o.row === blk.row);
        if (twin) {
          expect(Math.abs(twin.top - blk.top), `row ${blk.row} 兩側 top`).toBeLessThanOrEqual(1);
          continue;
        }
        single += 1;
        const covered = other.spacers.some((s) => s.top <= blk.top + 1 && s.top + s.height >= blk.top + blk.height - 1);
        expect(covered, `row ${blk.row} 單側列對面要有 spacer 蓋住 ${JSON.stringify(blk)}；spacers=${JSON.stringify(other.spacers)}`).toBe(true);
      }
    }
    expect(single).toBeGreaterThanOrEqual(minSingle);
  }).toPass({ timeout: 10_000 });
}

/**
 * Auto-save needs the user to stop typing for X minutes (site default 5), so this test builds versions only by manual save
 * (Ctrl+S); auto-save is covered by server integration tests and 22c (a test hook shrinks X to seconds).
 *
 * #272: a row's accessible name is "name (short id)" + (the "Auto-saved" pill for an auto version) + the second line, joined
 * into one string, so manual versions always carry a name and rows are always found with `/^name \(/`; a row's ... button is
 * "Actions for name (short id)" and is not caught by `^name`. The short id is the first 7 characters of the uuid, asserted
 * with `[0-9a-f]{7}`.
 * Toast assertions are anchored on the whole sentence (`/^...$/`; Radix toast's live region announces text that contains the
 * substring).
 */

async function saveVersion(page: Page, name?: string) {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  if (name) await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("Control+End");
  // Ctrl+End is the browser's native caret move and ProseMirror catches up only after selectionchange; pressing Enter before that splits the paragraph at the old position (see the helper's comment)
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

test("22 version history: save, edit, preview diff, apply, edit on top of \"name (short id)\", remote edit, narrow-viewport full page", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  const other = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E versions ${Date.now()}`);
    const url = page.url();

    await typeAtEnd(page, "alpha-one");
    await saveVersion(page, "milestone");
    await expect(page.getByText(/^Saved as milestone \([0-9a-f]{7}\)$/)).toBeVisible();

    await typeAtEnd(page, "beta-two");
    await saveVersion(page, "second");
    await expect(page.getByText(/^Saved as second \([0-9a-f]{7}\)$/)).toBeVisible();
    await typeAtEnd(page, "gamma-three");

    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: /^milestone \(/ })).toContainText("milestone");
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on second \([0-9a-f]{7}\) · unsaved changes/, { timeout: 10_000 });
    await expect(panel.getByTestId("auto-badge")).toHaveCount(0);
    await expect(panel.getByTestId("base-dot")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^second \(/ })).not.toContainText(/Manual|Auto/);

    await panel.getByRole("button", { name: /^second \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toContainText(/Previewing second \([0-9a-f]{7}\)/);
    // Panel opened at 1500 px (sidebar and versions panel 320 px each): the preview area is about 810 px >= 720, so it goes side by side automatically; the two column headers are a left/right pair of dropdowns. Switch to single column and look at data-diff again.
    await expect(page.getByTestId("diff-split")).toBeVisible();
    const splitHead = page.getByTestId("diff-split-head");
    await expect(splitHead.getByRole("button", { name: "Left side" })).toHaveText(/^second \(/);
    await expect(splitHead.getByRole("button", { name: "Right side" })).toHaveText(/Current state/);
    await expectSplitAligned(page, 1);
    await page.getByTestId("preview-banner").getByRole("button", { name: "Single column" }).click();
    const diffBlocks = page.getByTestId("diff-single").locator("[data-diff]");
    await expect(diffBlocks.filter({ hasText: "gamma-three" })).toHaveAttribute("data-diff", "added");
    await expect(diffBlocks.filter({ hasText: "beta-two" })).toHaveAttribute("data-diff", "context");
    await expect(diffBlocks.filter({ hasText: "alpha-one" })).toHaveAttribute("data-diff", "context");
    await expect(editorLocator(page)).toBeHidden();

    await panel.getByRole("button", { name: /^milestone \(/ }).click();
    const applyV1 = page.getByTestId("versions-footer").getByRole("button", { name: /^Apply milestone \(/ });
    // The bubble stack stays while the panel is open and must not cover "Apply milestone (...)".
    const stack = page.getByTestId("corner-stack");
    await expect(stack).toBeVisible();
    const s = (await stack.boundingBox())!;
    const btn = (await applyV1.boundingBox())!;
    const overlap = s.x < btn.x + btn.width && btn.x < s.x + s.width && s.y < btn.y + btn.height && btn.y < s.y + s.height;
    expect(overlap).toBe(false);
    await applyV1.click();
    const applyDialog = page.getByRole("dialog", { name: /^Apply milestone \(/ });
    await expect(applyDialog).toBeVisible();
    await applyDialog.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText(/^Applied milestone \([0-9a-f]{7}\)$/)).toBeVisible();
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await expect(editorLocator(page)).toContainText("alpha-one");
    await expect(editorLocator(page)).not.toContainText("beta-two");
    await expect(editorLocator(page)).not.toContainText("gamma-three");

    await typeAtEnd(page, "delta-four");
    await saveVersion(page, "third");
    await expect(panel.getByRole("button", { name: /^third \(/ })).toContainText(/based on milestone \([0-9a-f]{7}\)/, { timeout: 10_000 });
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on third \([0-9a-f]{7}\) · no changes/, { timeout: 10_000 });

    await panel.getByRole("button", { name: /^third \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    // Real keyboard: in preview, Esc with the save dialog or a row's ... menu open closes only that overlay and the banner stays; with no overlay, Esc leaves the preview.
    // First wait for the toast ("Saved as third (...)", 5 s) to disappear: while it is shown, the first Esc is eaten by Radix
    // Toast (it closes the toast and the dialog stays), which would not measure what this section guards.
    await expect(page.getByRole("region", { name: /^Notifications/ }).getByRole("listitem")).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press("Control+s");
    const saveDlg = page.getByRole("dialog", { name: "Save current version" });
    await expect(saveDlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(saveDlg).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await panel.getByRole("button", { name: /^Actions for third \(/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await panel.getByRole("button", { name: /^third \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    const otherPage = await other.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.password);
    await otherPage.goto(url);
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await typeAtEnd(otherPage, "remote-five");
    // The banner has no close button: clicking the already selected row again leaves the preview (toggle).
    await panel.getByRole("button", { name: /^third \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await expect(editorLocator(page)).toContainText("remote-five", { timeout: 15_000 });
    await typeAtEnd(page, "local-six");
    await expect(editorLocator(otherPage)).toContainText("local-six", { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".bn-suggestion-menu")).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("versions-bubble")).toBeHidden();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^second \(/ }).click();
    await expect(sheet.getByTestId("diff-single")).toBeVisible();
    await sheet.getByTestId("sheet-footer").getByRole("button", { name: /^Apply second \(/ }).click();
    // Always dirty: remote-five / local-six come after third, and local-six was already read in the other context above
    // (= the server has it), and auto-save needs 5 minutes of idleness (site default) so it cannot slip in - so the three-way
    // dialog always appears and this is not written as a conditional branch.
    const narrowApply = page.getByRole("dialog", { name: /^Apply second \(/ });
    await expect(narrowApply).toBeVisible();
    await narrowApply.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText(/^Applied second \([0-9a-f]{7}\)$/)).toBeVisible();
    await sheet.getByRole("button", { name: "Back", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(editorLocator(page)).toContainText("beta-two");
    await expect(editorLocator(page)).not.toContainText("local-six");
  } finally {
    await other.close();
    await ctx.close();
  }
});

test("22b side-by-side block alignment: a paragraph inserted in the middle plus the previous paragraph lengthened -> left 2 and right 3 share a row, and the inserted row's left column keeps stripes", async ({ browser }) => {
  test.setTimeout(120_000);
  const shotDir = process.env.VERSIONS_SCREENSHOT_DIR; // screenshots for visual inspection: taken only when set; this file writes no absolute path
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E split align ${Date.now()}`);
    await typeAtEnd(page, "one-top");
    await typeAtEnd(page, "two-bottom");
    await saveVersion(page, "base");
    await expect(page.getByText(/^Saved as base \([0-9a-f]{7}\)$/)).toBeVisible();

    const editor = editorLocator(page);
    // The caret must be sure to be in one-top before Enter: the insert once landed after two-bottom. The cause is not focus
    // restoration of the save dialog but ProseMirror not yet having received the click / End selectionchange (it reproduces
    // without the dialog; see the `waitForEditorSelection` comment): the DOM selection is already in one-top while
    // state.selection is still at the end of two-bottom. So besides the DOM selection, also wait for ProseMirror's state to
    // line up; assert the order of the three paragraphs again before previewing.
    const caretAtEndOf = async (text: string) => {
      await expect(async () => {
        await editor.getByText(text).click();
        await page.keyboard.press("End");
        expect(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? "")).toContain(text);
        await waitForEditorSelection(page, 1_000);
      }).toPass({ timeout: 10_000 });
    };
    await caretAtEndOf("one-top");
    await page.keyboard.press("Enter");
    await page.keyboard.type("inserted-middle paragraph that exists only in the current state");
    await caretAtEndOf("one-top");
    await page.keyboard.type(" and now a much longer tail that wraps over several lines in the narrow side-by-side column of the preview");
    const order = await editor.innerText();
    expect(order).toContain("one-top and now a much longer tail");
    expect(order.indexOf("one-top")).toBeLessThan(order.indexOf("inserted-middle"));
    expect(order.indexOf("inserted-middle")).toBeLessThan(order.indexOf("two-bottom"));

    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await panel.getByRole("button", { name: /^base \(/ }).click();
    await expect(page.getByTestId("diff-split")).toBeVisible();
    const split = page.getByTestId("diff-split");
    await expect(split.locator("section").nth(1).getByText("inserted-middle", { exact: false })).toBeVisible();
    await expectSplitAligned(page, 1);
    const left = split.locator("section").nth(0).locator(".bn-block-outer", { hasText: "two-bottom" }).last();
    const right = split.locator("section").nth(1).locator(".bn-block-outer", { hasText: "two-bottom" }).last();
    await expect(left).toHaveAttribute("data-diff-row", (await right.getAttribute("data-diff-row"))!);
    expect(Math.abs((await left.boundingBox())!.y - (await right.boundingBox())!.y)).toBeLessThanOrEqual(1);
    await expect(split.locator("section").nth(0).locator(".kb-diff-spacer")).toHaveCount(1);
    if (shotDir) {
      await page.screenshot({ path: path.join(shotDir, "task-2-split-align.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await expectSplitAligned(page, 1);
      await page.screenshot({ path: path.join(shotDir, "task-2-split-align-dark.png") });
    }
  } finally {
    await ctx.close();
  }
});

test("22c version list filter (#258) + auto-save only after X idle (#272): auto versions get a pill, All / Manual only toggle, preview unaffected, localStorage remembers, switching notes keeps the panel open", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    // #272: a test hook shrinks the wait X to 2 seconds (the e2e stack scans every second); after the auto version appears, and in finally, always set it back to null (= the site setting, 5 minutes).
    await setAutoWait(page, 2);
    const titleA = `E2E vfilter A ${Date.now()}`;
    const titleB = `E2E vfilter B ${Date.now()}`;
    await createNote(page, titleB);
    await createNote(page, titleA);
    const noteA = await noteIdFromUrl(page);
    await typeAtEnd(page, "auto-source-text");
    // Stay in A: after 2 idle seconds the server auto-saves a version (kind=auto). The panel list does not poll, so reload and retry until the pill appears.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("versions-bubble").click();
      await expect(page.getByTestId("versions-panel").getByTestId("auto-badge")).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    // Set X back to the site value immediately: text typed afterwards will not be auto-split before the manual save of keeper (otherwise the toast becomes "Same content as ...").
    await setAutoWait(page, null);
    const autoLabel = await versionLabelOf(page.request, noteA, (v) => v.kind === "auto");
    const shortId = autoLabel.slice(-8, -1);
    const panel = page.getByTestId("versions-panel");
    const autoRow = panel.getByRole("button", { name: new RegExp(`^${reEscape(autoLabel)}`) });
    await expect(autoRow).toContainText("Auto-saved");
    await expect(autoRow).not.toContainText(/Manual|Auto\b(?!-)/);
    await typeAtEnd(page, "manual-line");
    await saveVersion(page, "keeper");
    await expect(page.getByText(/^Saved as keeper \([0-9a-f]{7}\)$/)).toBeVisible();
    const keeperRow = panel.getByRole("button", { name: /^keeper \(/ });
    await expect(keeperRow).toBeVisible();
    await expect(keeperRow).not.toContainText("Auto-saved");
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on keeper \([0-9a-f]{7}\) · no changes/, { timeout: 10_000 });

    const filter = panel.getByTestId("versions-filter");
    const allBtn = filter.getByRole("button", { name: "All", exact: true });
    const manualBtn = filter.getByRole("button", { name: "Manual only", exact: true });
    await expect(allBtn).toHaveAttribute("aria-pressed", "true");
    await autoRow.click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    await manualBtn.click();
    await expect(manualBtn).toHaveAttribute("aria-pressed", "true");
    await expect(allBtn).toHaveAttribute("aria-pressed", "false");
    await expect(autoRow).toHaveCount(0);
    await expect(keeperRow).toBeVisible();
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    await expect(page.getByRole("button", { name: "Left side" }).first()).toHaveText(autoLabel);
    await expect(panel.getByTestId("versions-footer").getByRole("button", { name: `Apply ${autoLabel}` })).toBeEnabled();
    await page.getByRole("button", { name: "Left side" }).first().click();
    const leftItems = page.getByRole("menuitemradio");
    await expect(leftItems).toHaveCount(1);
    await expect(leftItems.first()).toHaveText(/^keeper \(/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on keeper \([0-9a-f]{7}\) · no changes/);
    await allBtn.click();
    await expect(autoRow).toBeVisible();
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    // Clicking the already selected row again leaves the preview (toggle; the banner has no close button).
    await autoRow.click();
    await expect(banner).toBeHidden();

    await manualBtn.click();
    await expect(autoRow).toHaveCount(0);
    await allBtn.click();
    await expect(autoRow).toBeVisible();
    await panel.getByRole("button", { name: `Actions for ${autoLabel}` }).click();
    await page.getByRole("menuitem", { name: "Edit version name" }).click();
    const renameDlg = page.getByRole("dialog", { name: `Edit name of ${autoLabel}` });
    await renameDlg.getByRole("textbox").fill("promoted");
    await renameDlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(renameDlg).toBeHidden();
    const promotedRow = panel.getByRole("button", { name: new RegExp(`^promoted \\(${shortId}\\)`) });
    await expect(promotedRow).not.toContainText("Auto-saved");
    await manualBtn.click();
    await expect(promotedRow).toBeVisible();

    expect(await page.evaluate(() => window.localStorage.getItem("knotebook.versions.filter"))).toBe("manual");
    await page.reload();
    await page.getByTestId("versions-bubble").click();
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true })).toHaveAttribute("aria-pressed", "true");

    // `.first()` is a safeguard; after the revamp the sidebar renders only the current tab.
    await page.getByRole("link", { name: titleB }).first().click();
    await expect(page.getByTestId("versions-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter-empty")).toContainText("No manually saved versions");
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /^promoted \(/ })).toHaveCount(0);
    await page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /\([0-9a-f]{7}\)/ })).toHaveCount(0);
    await page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true }).click();
    await page.getByRole("link", { name: titleA }).first().click();
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /^promoted \(/ })).toBeVisible({ timeout: 15_000 });
  } finally {
    await setAutoWait(page, null).catch(() => undefined);
    await ctx.close();
  }
});
