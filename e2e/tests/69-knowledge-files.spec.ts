import { expect, test, type Page } from "@playwright/test";
import { ADMIN, adminNav, chooseSelectOption, editorLocator, loginAs, openSiteAdmin, selectionAiBox, showSidebarTab } from "./helpers.js";
import { RUN, apiCreateNote, createAccount, iconOf, iconsIn, openAs, openNote, waitForNoteTitle } from "./knowledge-helpers.js";
import {
  closeAgent,
  createAgent,
  downloadFile,
  expectHoverCard,
  headingWithText,
  knowledgeComment,
  knowledgeIdIn,
  openFiles,
  readSection,
  replaceLine,
  replaceLineStartingWith,
  revokeFiles,
  writeFile,
  type Agent,
  type FileAccess,
} from "./markdown-helpers.js";
import { apiAddTags, dots, noteLink, tagRow } from "./tag-helpers.js";

/**
 * The downloaded file's `tags:` line and knowledge comments, sent back, against what an open browser tab shows; and the selection AI keeping a heading's knowledge info.
 * Every test uses its own accounts. The agent's requests come from a cookie-less context, so the PAT and the bulk token are the only credentials.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const WHEN = "When a job fails twice";
const CONCLUSION = "Back off before the third try";

const noteMarkdown = (heading: string) =>
  [`## ${heading}`, knowledgeComment([`when: ${WHEN}`, `conclusion: ${CONCLUSION}`]), "", "Body text.", ""].join("\n");

test("69-1 a file's tags line and knowledge comment come down with the note; a changed tags line sent back shows in the tag row and the sidebar dots; sending the file again changes nothing", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  let files: FileAccess | undefined;
  try {
    const title = `E2E file tags ${RUN}`;
    const note = await apiCreateNote(page, title, noteMarkdown("Retry policy"));
    await apiAddTags(page, note.id, ["Alpha"]);
    await openNote(page, note, title);
    await expect(tagRow(page).getByText("Alpha", { exact: true })).toBeVisible();
    agent = await createAgent(browser, page);
    files = await openFiles(agent, { space: "personal" });

    const file = await downloadFile(files, note.id);
    expect(file).toContain('\ntags: ["Alpha"]\n');
    expect(file).toMatch(/\n## Retry policy\n<!-- knotebook:knowledge\nid: k_[0-9a-f]{8}\n/);
    expect(file).toContain(`\nwhen: ${WHEN}\n`);

    const written = await writeFile(files, replaceLine(file, 'tags: ["Alpha"]', 'tags: ["Alpha", "Beta"]'));
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ result: "tagged", tagsChanged: true });
    expect(written.body.tagsFailed).toBeUndefined();

    await page.reload();
    await waitForNoteTitle(page, title);
    await expect(tagRow(page).getByText("Beta", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(tagRow(page).getByText("Alpha", { exact: true })).toBeVisible();
    const panel = await showSidebarTab(page, "My notes");
    await expect(dots(noteLink(panel, title).locator("xpath=ancestor::li[1]"), "Alpha, Beta")).toBeVisible();
    // The text and the knowledge were not touched.
    await expect(iconOf(page, "Not verified")).toBeVisible();

    const again = await writeFile(files, await downloadFile(files, note.id));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ result: "unchanged", tagsChanged: false });
  } finally {
    await revokeFiles(files);
    await closeAgent(agent);
    await context.close();
  }
});

test("69-2 a person who has only an edit share gets 403 for a changed tags line, and the note's tags stay", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  let agent: Agent | undefined;
  let files: FileAccess | undefined;
  try {
    const title = `E2E file tags shared ${RUN}`;
    const note = await apiCreateNote(a.page, title, noteMarkdown("Retry policy"));
    await apiAddTags(a.page, note.id, ["Shared tag"]);
    const shared = await a.page.request.put(`/api/notes/${note.id}/shares`, { data: { email: bob.email, role: "editor" } });
    expect(shared.status(), await shared.text()).toBe(200);
    agent = await createAgent(browser, b.page);
    files = await openFiles(agent, { space: "shared" });

    const file = await downloadFile(files, note.id);
    expect(file).toContain('\ntags: ["Shared tag"]\n');
    const refused = await writeFile(files, replaceLine(file, 'tags: ["Shared tag"]', 'tags: ["Shared tag", "Extra"]'));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "forbidden" } });

    await openNote(a.page, note, title);
    await expect(tagRow(a.page).getByText("Shared tag", { exact: true })).toBeVisible();
    await expect(tagRow(a.page).getByText("Extra", { exact: true })).toHaveCount(0);
    const listed = await a.page.request.get("/api/tags");
    expect(((await listed.json()) as Array<{ name: string }>).map((t) => t.name)).toEqual(["Shared tag"]);
  } finally {
    await revokeFiles(files);
    await closeAgent(agent);
    await a.context.close();
    await b.context.close();
  }
});

test("69-3 a changed knowledge comment sent back updates the card, and a file with the comment taken out removes the icon", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  let files: FileAccess | undefined;
  try {
    const title = `E2E file knowledge ${RUN}`;
    const note = await apiCreateNote(page, title, noteMarkdown("Retry policy"));
    await openNote(page, note, title);
    await expect(iconOf(page, "Not verified")).toBeVisible();
    agent = await createAgent(browser, page);
    files = await openFiles(agent, { space: "personal" });

    const first = await downloadFile(files, note.id);
    const knowledgeId = knowledgeIdIn(first);
    const newWhen = "Only after the second failure";
    const changed = await writeFile(files, replaceLine(first, `when: ${WHEN}`, `when: ${newWhen}`));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ result: "applied" });
    await expectHoverCard(page, newWhen);
    await expect(iconsIn(page)).toHaveCount(1);
    expect(knowledgeIdIn((await readSection(agent, note.id, "Retry policy")).markdown)).toBe(knowledgeId);

    // The file is the whole content, so a heading without its comment is a heading without knowledge info.
    const second = await downloadFile(files, note.id);
    const start = second.indexOf("<!-- knotebook:knowledge");
    const end = second.indexOf("-->\n", start) + "-->\n".length;
    expect(start).toBeGreaterThan(0);
    const stripped = await writeFile(files, second.slice(0, start) + second.slice(end));
    expect(stripped.status, JSON.stringify(stripped.body)).toBe(200);
    expect(stripped.body).toMatchObject({ result: "applied", knowledge: { removed: [{ id: knowledgeId, heading: "Retry policy" }] } });
    await expect(iconsIn(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(headingWithText(page, "Retry policy")).toBeVisible();
    await expect(editorLocator(page).getByText("Body text.", { exact: true })).toBeVisible();
  } finally {
    await revokeFiles(files);
    await closeAgent(agent);
    await context.close();
  }
});

test("69-4 a file whose comment is not valid is refused with invalid_knowledge and the note stays as it was", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  let files: FileAccess | undefined;
  try {
    const title = `E2E file bad comment ${RUN}`;
    const note = await apiCreateNote(page, title, noteMarkdown("Retry policy"));
    await openNote(page, note, title);
    agent = await createAgent(browser, page);
    files = await openFiles(agent, { space: "personal" });

    const file = await downloadFile(files, note.id);
    const bad = await writeFile(files, replaceLineStartingWith(file, "conclusion: ", "status: bogus").replace("Body text.", "Should not appear."));
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "invalid_knowledge" } });
    await expect(editorLocator(page).getByText("Body text.", { exact: true })).toBeVisible();
    await expect(editorLocator(page).getByText("Should not appear.", { exact: true })).toHaveCount(0);
    await expectHoverCard(page, CONCLUSION);
    // The base line is salted per download, so it differs even when the note is the same.
    const withoutBase = (text: string): string => text.replace(/^base: .*$/m, "");
    expect(withoutBase(await downloadFile(files, note.id))).toBe(withoutBase(file));
  } finally {
    await revokeFiles(files);
    await closeAgent(agent);
    await context.close();
  }
});

type ApplyMode = "direct" | "preview";
let originalRewriteMode: ApplyMode | undefined;

async function setRewriteApplyMode(page: Page, applyMode: ApplyMode): Promise<void> {
  const listed = await page.request.get("/api/admin/ai/actions");
  expect(listed.status()).toBe(200);
  const { actions } = (await listed.json()) as { actions: { id: string; name: string; builtin: boolean; applyMode: ApplyMode }[] };
  const rewrite = actions.find((action) => action.builtin && action.name === "Rewrite");
  expect(rewrite, "the built-in Rewrite action").toBeDefined();
  originalRewriteMode ??= rewrite!.applyMode;
  const res = await page.request.patch(`/api/admin/ai/actions/${rewrite!.id}`, { data: { applyMode } });
  expect(res.status()).toBe(200);
}

test.describe("selection AI (ai-stub /echo)", () => {
  test.afterAll(async ({ browser }) => {
    if (originalRewriteMode === undefined) return;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await setRewriteApplyMode(page, originalRewriteMode);
    } finally {
      await context.close();
    }
  });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await openSiteAdmin(page);
      await adminNav(page, "AI agents");
      await page.getByRole("button", { name: "Add provider", exact: true }).click();
      const providerDialog = page.getByRole("dialog", { name: "Add provider" });
      const providerName = `E2E Knowledge Echo Provider ${RUN}`;
      await providerDialog.locator("#ai-provider-name").fill(providerName);
      await chooseSelectOption(page, providerDialog.locator("#ai-provider-type"), "OpenAI-compatible");
      await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/echo");
      await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(providerDialog).not.toBeVisible();
      await page.getByRole("row", { name: `${providerName} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
      const modelDialog = page.getByRole("dialog", { name: "Add model" });
      await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-knowledge-echo-model");
      await modelDialog.getByLabel("Display name", { exact: true }).fill(`E2E Knowledge Echo Model ${RUN}`);
      await modelDialog.getByLabel("Default model", { exact: true }).check();
      await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(modelDialog).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await setRewriteApplyMode(page, "preview");
    } finally {
      await context.close();
    }
  });

  test("69-5 the selection AI rewrites a knowledge heading's text and the knowledge info stays with it", async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await createAccount(browser, "alice");
    const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
    let agent: Agent | undefined;
    try {
      const title = `E2E selection AI knowledge ${RUN}`;
      const note = await apiCreateNote(page, title, noteMarkdown("Original rule"));
      await openNote(page, note, title);
      await expect(iconOf(page, "Not verified")).toBeVisible();
      agent = await createAgent(browser, page);
      const knowledgeId = knowledgeIdIn((await readSection(agent, note.id, "Original rule")).markdown);

      await editorLocator(page).getByText("Body text.", { exact: true }).click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.getByRole("button", { name: "AI", exact: true }).click();
      const box = selectionAiBox(page);
      await expect(box).toBeVisible();
      await box.getByRole("button", { name: "Rewrite", exact: true }).click();
      await expect(box.getByTestId("selection-ai-preview")).toContainText("Rewritten rule", { timeout: 15_000 });
      await box.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(box).toBeHidden();

      await expect(headingWithText(page, "Rewritten rule")).toBeVisible({ timeout: 15_000 });
      await expect(iconsIn(page)).toHaveCount(1);
      await expectHoverCard(page, WHEN);
      const after = await readSection(agent, note.id, "Rewritten rule");
      expect(knowledgeIdIn(after.markdown)).toBe(knowledgeId);
      expect(after.markdown).toContain(`\nconclusion: ${CONCLUSION}\n`);
    } finally {
      await closeAgent(agent);
      await context.close();
    }
  });
});
