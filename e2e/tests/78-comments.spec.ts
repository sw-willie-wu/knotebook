import { expect, test, type Locator, type Page } from "@playwright/test";
import { RUN, apiCreateNote, createAccount, openAs, openNote } from "./knowledge-helpers.js";

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const PASSAGE = `The passage to discuss ${RUN}.`;

function blockWithText(page: Page, text: string): Locator {
  return page.getByTestId("note-editor").locator(".bn-block-outer").filter({ has: page.locator(".bn-inline-content", { hasText: text }) }).last();
}

function commentsPanel(page: Page): Locator {
  return page.getByTestId("comments-panel");
}

test("78-1 a reader comments on a passage with a mention; the owner sees it live and the quote jumps to the passage", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const title = `E2E passage comments ${RUN}`;
    // Enough text above the passage that it starts out of view in the owner's tab, so the jump has to scroll.
    const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
    const note = await apiCreateNote(a.page, title, `${filler}\n\n${PASSAGE}\n\nThe last paragraph.`);
    const aliceHandle = note.path.split("/")[2]!;
    const shared = await a.page.request.put(`/api/notes/${note.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await openNote(a.page, note, title);
    await a.page.getByTestId("comments-bubble").click();
    await expect(commentsPanel(a.page).getByText("No comments yet.")).toBeVisible({ timeout: 15_000 });
    const aliceBlock = blockWithText(a.page, PASSAGE);
    await expect(aliceBlock).not.toBeInViewport();

    // A reader's title is a heading, not the title box; it marks the note page past its lazy fallback shell all the same.
    await b.page.goto(note.path);
    await expect(b.page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const bobBlock = blockWithText(b.page, PASSAGE);
    await bobBlock.scrollIntoViewIfNeeded();
    await bobBlock.locator(".bn-inline-content").selectText();
    await b.page.getByRole("button", { name: "Comment", exact: true }).click();

    const bobPanel = commentsPanel(b.page);
    const composer = bobPanel.getByRole("textbox", { name: "Comment" });
    await expect(composer).toBeFocused({ timeout: 15_000 });
    await expect(bobPanel.getByTestId("composer-anchor")).toContainText(PASSAGE);
    await b.page.keyboard.type(`@${aliceHandle} please check this ${RUN}`);
    await bobPanel.getByRole("button", { name: "Send", exact: true }).click();
    const bobComment = bobPanel.getByTestId("comment").filter({ hasText: `please check this ${RUN}` });
    await expect(bobComment).toBeVisible({ timeout: 15_000 });
    await expect(bobComment.getByTestId("comment-quote")).toContainText(PASSAGE);
    await expect(bobComment.getByTestId("mention-chip")).toHaveAttribute("title", `@${aliceHandle}`);

    // The owner's tab was never reloaded: the comment comes in over the note's live connection.
    const aliceComment = commentsPanel(a.page).getByTestId("comment").filter({ hasText: `please check this ${RUN}` });
    await expect(aliceComment).toBeVisible({ timeout: 20_000 });
    await expect(aliceComment.getByTestId("mention-chip")).toHaveAttribute("title", `@${aliceHandle}`);
    const blockId = await aliceBlock.getAttribute("data-id");
    expect(blockId).toBeTruthy();
    await aliceComment.getByTestId("comment-quote").click();
    await expect(aliceBlock).toBeInViewport({ timeout: 15_000 });
    await expect(a.page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`)).toBeAttached({ timeout: 15_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("78-2 the corner bubbles switch between the comments and the version history at every wide width; the floating panel ends above them, and an unsent comment survives", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: { width: 1024, height: 800 } });
  const b = await openAs(browser, bob);
  try {
    const title = `E2E panel switch ${RUN}`;
    const note = await apiCreateNote(a.page, title, "Some text to talk about.");
    const shared = await a.page.request.put(`/api/notes/${note.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);
    await openNote(a.page, note, title);
    const page = a.page;
    const box = (locator: Locator) => locator.boundingBox().then((b) => b!);

    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByTestId("comments-bubble").click();
      const composer = commentsPanel(page).getByRole("textbox", { name: "Comment" });
      await expect(composer).toBeFocused({ timeout: 15_000 });
      await composer.fill(`half a thought ${width}`);

      await page.getByTestId("versions-bubble").click();
      const versions = page.getByTestId("versions-panel");
      await expect(versions).toBeVisible();
      await expect(commentsPanel(page)).toHaveCount(0);
      await expect(page.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
      // Neither the floating panel (1024) nor the third column (1440) covers the stack.
      const stack = await box(page.getByTestId("corner-stack"));
      const panel = await box(versions);
      const overlaps = stack.x < panel.x + panel.width && panel.x < stack.x + stack.width && stack.y < panel.y + panel.height && panel.y < stack.y + stack.height;
      expect(overlaps, `${width}: the panel leaves the stack uncovered`).toBe(false);

      await page.getByTestId("comments-bubble").click();
      await expect(versions).toHaveCount(0);
      await expect(commentsPanel(page).getByRole("textbox", { name: "Comment" })).toHaveValue(`half a thought ${width}`);

      // Collapsing only hides the bubbles; the panel stays.
      await page.getByTestId("corner-toggle").click();
      await expect(page.getByTestId("comments-bubble")).toHaveCount(0);
      await expect(commentsPanel(page)).toBeVisible();
      await expect(page.getByTestId("corner-toggle")).toBeFocused();
      await page.getByTestId("corner-toggle").click();
      await page.getByTestId("comments-bubble").click();
      await expect(commentsPanel(page)).toHaveCount(0);
    }

    // The collapsed state is remembered across a reload, and the collapsed toggle tells of a comment someone else posted.
    await page.getByTestId("corner-toggle").click();
    const posted = await b.page.request.post(`/api/notes/${note.id}/comments`, { data: { body: `from bob ${RUN}` } });
    expect(posted.status(), await posted.text()).toBe(201);
    await page.reload();
    const toggle = page.getByTestId("corner-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 15_000 });
    await expect(page.getByTestId("versions-bubble")).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName("Note panels, unread comments");
    await expect(page.getByTestId("corner-unread-dot")).toBeVisible();
    await toggle.click();
    await expect(page.getByTestId("comments-bubble")).toHaveAccessibleName("Comments (1)");
    await page.getByTestId("comments-bubble").click();
    await expect(commentsPanel(page).getByTestId("comment").filter({ hasText: `from bob ${RUN}` })).toBeVisible({ timeout: 15_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("78-3 a short window (844x390): with a panel open only the toggle stays and the panel ends above it; pressing the toggle shows the bubbles without saving it", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const a = await openAs(browser, alice, { viewport: { width: 1024, height: 800 } });
  try {
    const title = `E2E short window ${RUN}`;
    const note = await apiCreateNote(a.page, title, "Some text to talk about.");
    await openNote(a.page, note, title);
    const page = a.page;
    await page.getByTestId("comments-bubble").click();
    await expect(commentsPanel(page)).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    const toggle = page.getByTestId("corner-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("comments-bubble")).toHaveCount(0);
    const panel = (await commentsPanel(page).boundingBox())!;
    const stack = (await page.getByTestId("corner-stack").boundingBox())!;
    expect(panel.y + panel.height, "the panel ends above the toggle").toBeLessThanOrEqual(stack.y);
    expect(await page.evaluate(() => localStorage.getItem("cornerStack.collapsed"))).toBeNull();

    await toggle.click();
    await expect(page.getByTestId("comments-bubble")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("cornerStack.collapsed"))).toBeNull();
    await toggle.click();
    await expect(page.getByTestId("comments-bubble")).toHaveCount(0);

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByTestId("comments-bubble")).toHaveAttribute("aria-pressed", "true");
    await expect(commentsPanel(page)).toBeVisible();
  } finally {
    await a.context.close();
  }
});
