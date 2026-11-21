import { expect, test, type Page } from "@playwright/test";
import { clickEndOfParagraph, editorLocator, noteIdFromUrl } from "./helpers.js";
import {
  RUN,
  apiCreateNote,
  createAccount,
  formOf,
  headingLine,
  hoverCardOf,
  iconOf,
  iconsIn,
  makeKnowledge,
  openAs,
  openNote,
} from "./knowledge-helpers.js";

/**
 * Who sees knowledge info and where: a read-only person gets the icon and the card but nothing to edit; the public page, its response and presentation mode carry no knowledge; a version preview draws the icons of that version.
 * Every test uses freshly created accounts, so notes never overlap between tests.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const WIDE = { width: 1500, height: 900 };

/** Types a marker paragraph after the note's last paragraph and returns once it is part of what the server stores: a later state in the same document includes everything before it. */
async function typeMarker(page: Page, marker: string, lastParagraph: string): Promise<void> {
  const editor = editorLocator(page);
  await clickEndOfParagraph(page, editor.getByText(lastParagraph, { exact: true }));
  await page.keyboard.press("Enter");
  await page.keyboard.type(marker);
  await expect(editor.getByText(marker, { exact: true })).toBeVisible();
}

/** Looks at the slides' markup, not just their text: the values could sit in attributes. */
async function expectNoKnowledgeInSlides(page: Page, secrets: readonly string[]): Promise<void> {
  const markup = await page.locator(".reveal .slides").evaluate((el) => el.innerHTML);
  expect(markup).toContain("slide");
  expect(markup).not.toMatch(/data-knowledge/i);
  for (const secret of secrets) expect(markup).not.toContain(secret);
}

async function publicLinkOf(page: Page, noteId: string): Promise<string> {
  const res = await page.request.put(`/api/notes/${noteId}/public-link`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

test("67-1 a viewer sees the icon and a card without Edit, and has no editor, handle or slash menu", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const title = `E2E knowledge viewer ${RUN}`;
    const note = await apiCreateNote(a.page, title, "## Shared rule\n\nBody text.");
    await openNote(a.page, note, title);
    await makeKnowledge(a.page, "Shared rule", { when: "Whenever the rule is quoted", conclusion: "It holds for every region", status: "Needs review" });
    await typeMarker(a.page, `persisted ${RUN}`, "Body text.");
    const shared = await a.page.request.put(`/api/notes/${await noteIdFromUrl(a.page)}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    // The owner's card has Edit; this proves the viewer's check below can see it.
    await iconOf(a.page, "Needs review").hover();
    await expect(hoverCardOf(a.page).getByRole("button", { name: "Edit" })).toBeVisible();

    await b.page.goto(note.path);
    await expect(b.page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const icon = iconOf(b.page, "Needs review");
    await expect(icon).toBeVisible({ timeout: 15_000 });

    await icon.hover();
    const card = hoverCardOf(b.page);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Whenever the rule is quoted");
    await expect(card).toContainText("It holds for every region");
    await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);

    // A click opens the card, never the form.
    await icon.click();
    await expect(b.page.locator('[data-kb-knowledge-card="hover"]')).toBeVisible();
    await expect(b.page.locator('[data-kb-knowledge-card="hover"]').getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(formOf(b.page)).toHaveCount(0);
    await b.page.keyboard.press("Escape");

    // A read-only editor has no caret to type `/info` into and no drag handle to open a menu from.
    await expect(editorLocator(b.page)).toHaveCount(0);
    await b.page.getByTestId("note-editor").getByText("Shared rule", { exact: true }).hover();
    await expect(b.page.getByRole("button", { name: "Open block menu" })).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("67-2 the public page shows no icon and no strike-through, and its response has no knowledge value", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const anon = await browser.newContext();
  try {
    const title = `E2E knowledge public ${RUN}`;
    const when = `read when public ${RUN}`;
    const conclusion = `public conclusion ${RUN}`;
    const note = await apiCreateNote(a.page, title, "## Replacement rule\n\n## Retired rule\n\nBody text.");
    await openNote(a.page, note, title);
    await makeKnowledge(a.page, "Replacement rule", { when: "Newer" });
    await makeKnowledge(a.page, "Retired rule", { when, conclusion, status: "Outdated", replacedBy: "Replacement rule" });
    await expect(iconOf(a.page, "Outdated")).toBeVisible();
    const marker = `marker ${RUN}`;
    await typeMarker(a.page, marker, "Body text.");
    const token = await publicLinkOf(a.page, await noteIdFromUrl(a.page));

    const page = await anon.newPage();
    const responsePromise = page.waitForResponse((res) => res.url().includes(`/api/public/notes/${token}`) && res.request().method() === "GET");
    // The marker is typed after the knowledge was saved, so a response holding it was built from a document that already had the knowledge in it.
    await expect(async () => {
      const res = await page.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(marker);
    }).toPass({ timeout: 20_000 });

    await page.goto(`/p/${token}`);
    const response = await responsePromise;
    const bytes = Buffer.from(((await response.json()) as { ydoc: string }).ydoc, "base64").toString("latin1");
    expect(bytes).toContain("Retired rule");
    for (const secret of [when, conclusion]) expect(bytes).not.toContain(secret);
    expect(bytes.toLowerCase()).not.toContain("knowledge");

    await expect(page.getByText("Retired rule", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-kb-knowledge-icon]")).toHaveCount(0);
    await expect(page.locator("[data-kb-knowledge-outdated]")).toHaveCount(0);
    await expect(page.locator("[data-knowledge-id], [data-knowledge-when]")).toHaveCount(0);
    await expect(page.getByText(conclusion)).toHaveCount(0);
    const decoration = await page.getByText("Retired rule", { exact: true }).evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(decoration).not.toContain("line-through");
  } finally {
    await a.context.close();
    await anon.close();
  }
});

test("67-3 presentation mode shows no knowledge value", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const anon = await browser.newContext({ viewport: DESKTOP });
  try {
    const title = `E2E knowledge slides ${RUN}`;
    const when = `slides when ${RUN}`;
    const conclusion = `slides conclusion ${RUN}`;
    const note = await apiCreateNote(a.page, title, "## First slide\n\nFirst text.\n\n## Second slide\n\nSecond text.");
    await openNote(a.page, note, title);
    await makeKnowledge(a.page, "First slide", { when, conclusion, status: "Needs review" });
    await makeKnowledge(a.page, "Second slide", { when: "Second reading", status: "Outdated", replacedBy: "First slide" });
    const marker = `slides marker ${RUN}`;
    await typeMarker(a.page, marker, "Second text.");
    const token = await publicLinkOf(a.page, await noteIdFromUrl(a.page));

    await a.page.getByRole("button", { name: "More", exact: true }).click();
    await a.page.getByRole("menuitem", { name: "Present" }).click();
    const owner = a.page.getByRole("dialog", { name: `${title} — presentation` });
    await expect(owner).toBeVisible();
    await expect(a.page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    await expect(a.page.locator(".reveal .slides").getByText("First slide", { exact: true })).toBeAttached();
    for (const secret of [when, conclusion, "Second reading"]) await expect(owner.getByText(secret)).toHaveCount(0);
    await expect(owner.locator("[data-kb-knowledge-icon], [data-kb-knowledge-outdated]")).toHaveCount(0);
    await expectNoKnowledgeInSlides(a.page, [when, conclusion, "Second reading"]);

    const page = await anon.newPage();
    await expect(async () => {
      const res = await page.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(marker);
    }).toPass({ timeout: 20_000 });
    await page.goto(`/p/${token}`);
    await page.getByRole("button", { name: "Present" }).click();
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".reveal .slides").getByText("Second slide", { exact: true })).toBeAttached();
    await expectNoKnowledgeInSlides(page, [when, conclusion, "Second reading"]);
    await expect(page.locator("[data-kb-knowledge-icon], [data-kb-knowledge-outdated]")).toHaveCount(0);
  } finally {
    await a.context.close();
    await anon.close();
  }
});

test("67-4 the version preview shows the icon of that version and a card without Edit", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const a = await openAs(browser, alice, { viewport: WIDE });
  try {
    const title = `E2E knowledge version ${RUN}`;
    const when = `Version one reading ${RUN}`;
    const note = await apiCreateNote(a.page, title, "## Versioned rule\n\nBody text.");
    await openNote(a.page, note, title);
    await makeKnowledge(a.page, "Versioned rule", { when });
    await expect(iconOf(a.page, "Not verified")).toBeVisible();

    await clickEndOfParagraph(a.page, editorLocator(a.page).getByText("Body text.", { exact: true }));
    await a.page.keyboard.press("Control+s");
    const saveDialog = a.page.getByRole("dialog", { name: "Save current version" });
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByLabel("Version name (optional)").fill("with-info");
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saveDialog).not.toBeVisible();

    // The current note drops the knowledge info, so only the saved version still has an icon.
    await iconOf(a.page, "Not verified").click();
    await formOf(a.page).getByRole("button", { name: "Remove knowledge info" }).click();
    await expect(iconsIn(a.page)).toHaveCount(0);
    await expect(headingLine(a.page, "Versioned rule")).toBeVisible();
    await typeMarker(a.page, "later text", "Body text.");

    await a.page.getByTestId("versions-bubble").click();
    const panel = a.page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: /^with-info \(/ }).click();
    await expect(a.page.getByTestId("preview-banner")).toContainText(/Previewing with-info/);
    const split = a.page.getByTestId("diff-split");
    await expect(split).toBeVisible();

    const icon = iconOf(split, "Not verified");
    await expect(icon).toHaveCount(1);
    await expect(iconsIn(split)).toHaveCount(1);
    await icon.click();
    const card = a.page.locator('[data-kb-knowledge-card="hover"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText(when);
    await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(formOf(a.page)).toHaveCount(0);
  } finally {
    await a.context.close();
  }
});
