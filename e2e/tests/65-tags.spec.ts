import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  editorLocator,
  loginAs,
  noteIdFromUrl,
  openListOnCompact,
  randomEmail,
  reEscape,
  showSidebarTab,
  waitForEditorSelection,
} from "./helpers.js";

/**
 * Tags: the row above the note text, the three ways to add the first tag, sidebar dots and filter, who may change tags, the management page, tags following a note into a group, and the phone layout.
 * Every test uses freshly created accounts (alice, bob plus the RUN suffix), so tag lists never overlap between tests; notes, tags and groups are left in place (the stack is reset by `stack:down -v` each time).
 * Button lookups use `exact: true` because Playwright's default name match is a case-insensitive substring match.
 */

const RUN = Date.now();
const PASSWORD = "e2e-tags-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;

interface Account {
  email: string;
  displayName: string;
}

async function createAccount(browser: Browser, name: string): Promise<Account> {
  const account: Account = { email: randomEmail(), displayName: `${name} ${RUN}` };
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...account, password: PASSWORD });
  } finally {
    await context.close();
  }
  return account;
}

async function openAs(browser: Browser, account: Account, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return { context, page };
}

function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

function tagRow(page: Page): Locator {
  return page.getByRole("group", { name: "Tags", exact: true });
}

function tagInput(page: Page): Locator {
  return page.getByRole("combobox", { name: "Tag name", exact: true });
}

function dots(scope: Locator, names: string): Locator {
  return scope.getByRole("img", { name: `Tags: ${names}`, exact: true });
}

/** After a full page load of a note page, wait for the title box first: the lazy note page's fallback shell replaces the sidebar and resets the drawer. */
async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
}

async function apiCreateNote(page: Page, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await page.request.post("/api/notes", { data: { title, ...extra } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function apiAddTags(page: Page, noteId: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const added = await page.request.post(`/api/notes/${noteId}/tags`, { data: { name } });
    expect(added.status(), await added.text()).toBe(200);
  }
}

async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const created = await page.request.post("/api/groups", { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function slashTitles(page: Page): Promise<string[]> {
  return (await page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title").allTextContents()).map((t) => t.trim());
}

async function openSlashTag(page: Page): Promise<void> {
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.keyboard.type("/tag");
  await expect.poll(() => slashTitles(page)).toContain("Tag");
}

test("a note without tags looks the same as before: no tag row above the text, no Add button, no filter in the sidebar", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E tags none ${RUN}`;
    await createNote(page, title);
    await expect(tagRow(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a tag", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-note-content-top]")).toBeHidden();
    const panel = await showSidebarTab(page, "My notes");
    await expect(noteLink(panel, title)).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter by tag", exact: true })).toHaveCount(0);
    await expect(panel.locator("[data-tag-dots]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("add the first tag with /tag, see its dot in the sidebar, and reuse it on a second note", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const first = `E2E tags first ${RUN}`;
    const second = `E2E tags second ${RUN}`;
    await createNote(page, first);
    await openSlashTag(page);
    await page.keyboard.press("Enter");
    await expect(tagInput(page)).toBeFocused();
    await page.keyboard.type("Alpha");
    await page.keyboard.press("Enter");
    await expect(tagRow(page).getByText("Alpha", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tagInput(page)).toHaveCount(0);
    // The slash text is removed and nothing was inserted into the document.
    await expect(editorLocator(page)).not.toContainText("/tag");
    await expect(editorLocator(page)).not.toContainText("Alpha");

    const panel = await showSidebarTab(page, "My notes");
    await expect(dots(noteLink(panel, first).locator("xpath=ancestor::li[1]"), "Alpha")).toBeVisible();

    await createNote(page, second);
    await expect(tagRow(page)).toHaveCount(0);
    await openSlashTag(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("alp");
    // The existing tag is offered with its own spelling, ahead of creating a new "alp".
    const option = page.getByRole("option", { name: "Alpha", exact: true });
    await expect(option).toBeVisible();
    await expect(page.getByRole("option")).toHaveText(["Alpha", 'Create "alp"']);
    await option.click();
    await expect(tagRow(page).getByText("Alpha", { exact: true })).toBeVisible();

    await expect
      .poll(async () => {
        const list = await page.request.get("/api/tags");
        const tags = (await list.json()) as Array<{ name: string; noteCount: number }>;
        return tags.map((tag) => [tag.name, tag.noteCount]);
      })
      .toEqual([["Alpha", 2]]);
  } finally {
    await context.close();
  }
});

test("Add tag in the note's ⋮ menu opens the tag input, and leaving it empty folds the row away again", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E tags menu ${RUN}`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add tag", exact: true }).click();
    await expect(tagInput(page)).toBeFocused();
    await expect(tagRow(page)).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(tagRow(page)).toHaveCount(0);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add tag", exact: true }).click();
    await expect(tagInput(page)).toBeFocused();
    await page.getByRole("textbox", NOTE_TITLE).click();
    await expect(tagRow(page)).toHaveCount(0);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add tag", exact: true }).click();
    await page.keyboard.type("Menu tag");
    await page.keyboard.press("Enter");
    await expect(tagRow(page).getByText("Menu tag", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a tag", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Add a tag", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("filtering My notes by two tags shows only notes having both; the chip × and Clear undo it", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const both = `E2E tags both ${RUN}`;
    const onlyWork = `E2E tags work ${RUN}`;
    const onlyTodo = `E2E tags todo ${RUN}`;
    const plain = `E2E tags plain ${RUN}`;
    await apiAddTags(page, await apiCreateNote(page, both), ["work", "todo"]);
    await apiAddTags(page, await apiCreateNote(page, onlyWork), ["work"]);
    await apiAddTags(page, await apiCreateNote(page, onlyTodo), ["todo"]);
    await apiCreateNote(page, plain);

    await page.goto("/");
    const panel = await showSidebarTab(page, "My notes");
    for (const title of [both, onlyWork, onlyTodo, plain]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });
    await expect(dots(panel, "work, todo")).toHaveCount(1);

    await panel.getByRole("button", { name: "Filter by tag", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox", { name: /^work\s*2$/ })).toBeVisible();
    await menu.getByRole("menuitemcheckbox", { name: /^work\s*2$/ }).click();
    // Choosing keeps the menu open so a second tag can be added.
    await menu.getByRole("menuitemcheckbox", { name: /^todo\s*2$/ }).click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await expect(noteLink(panel, both)).toBeVisible();
    await expect(noteLink(panel, onlyWork)).toHaveCount(0);
    await expect(noteLink(panel, onlyTodo)).toHaveCount(0);
    await expect(noteLink(panel, plain)).toHaveCount(0);
    const bar = panel.locator("[data-tag-filter-bar]");
    await expect(bar.getByText("1 note", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Filter by tag, 2 applied", exact: true })).toBeVisible();

    await bar.getByRole("button", { name: "Remove work from the filter", exact: true }).click();
    await expect(noteLink(panel, both)).toBeVisible();
    await expect(noteLink(panel, onlyTodo)).toBeVisible();
    await expect(noteLink(panel, onlyWork)).toHaveCount(0);
    await expect(bar.getByText("2 notes", { exact: true })).toBeVisible();

    await bar.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(bar).toHaveCount(0);
    for (const title of [both, onlyWork, onlyTodo, plain]) await expect(noteLink(panel, title)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Filter by tag", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Groups tab filter keeps to one group and hides the others", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const groupA = `E2E tags GA ${RUN}`;
    const groupB = `E2E tags GB ${RUN}`;
    const idA = await apiCreateGroup(page, groupA);
    const idB = await apiCreateGroup(page, groupB);
    const noteA = `E2E tags note in A ${RUN}`;
    const noteB = `E2E tags note in B ${RUN}`;
    const noteA2 = `E2E tags other in A ${RUN}`;
    await apiAddTags(page, await apiCreateNote(page, noteA, { groupId: idA }), ["spec"]);
    await apiAddTags(page, await apiCreateNote(page, noteB, { groupId: idB }), ["book"]);
    await apiCreateNote(page, noteA2, { groupId: idA });

    await page.goto("/");
    const panel = await showSidebarTab(page, "Groups");
    for (const title of [noteA, noteB, noteA2]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });
    const groupRow = (name: string) => panel.getByRole("button", { name, exact: true });
    await expect(groupRow(groupB)).toBeVisible();

    await panel.getByRole("button", { name: "Filter by tag", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("group", { name: groupA, exact: true })).toBeVisible();
    await expect(menu.getByRole("group", { name: groupB, exact: true })).toBeVisible();
    await menu.getByRole("menuitemcheckbox", { name: /^spec\s*1$/ }).click();
    await page.keyboard.press("Escape");

    await expect(noteLink(panel, noteA)).toBeVisible();
    await expect(noteLink(panel, noteA2)).toHaveCount(0);
    await expect(noteLink(panel, noteB)).toHaveCount(0);
    await expect(groupRow(groupA)).toBeVisible();
    await expect(groupRow(groupB)).toHaveCount(0);
    await expect(panel.getByText(`Showing only ${groupA}; other groups are hidden while filtering`, { exact: true })).toBeVisible();

    await panel.locator("[data-tag-filter-bar]").getByRole("button", { name: "Clear", exact: true }).click();
    for (const title of [noteA, noteB, noteA2]) await expect(noteLink(panel, title)).toBeVisible();
    await expect(groupRow(groupB)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a person with an edit share sees the tags but has no Add, no × and no /tag", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  try {
    const title = `E2E tags shared ${RUN}`;
    await createNote(a.page, title);
    const noteUrl = a.page.url();
    const noteId = await noteIdFromUrl(a.page);
    await apiAddTags(a.page, noteId, ["Shared tag"]);
    const shared = await a.page.request.put(`/api/notes/${noteId}/shares`, { data: { email: bob.email, role: "editor" } });
    expect(shared.status(), await shared.text()).toBe(200);

    // The owner gets all three entry points; this proves the checks below can see them.
    await a.page.reload();
    await waitForNoteTitle(a.page, title);
    await expect(tagRow(a.page).getByText("Shared tag", { exact: true })).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Add a tag", exact: true })).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Remove tag Shared tag", exact: true })).toHaveCount(1);
    await openSlashTag(a.page);
    await a.page.keyboard.press("Escape");

    await b.page.goto(noteUrl);
    await waitForNoteTitle(b.page, title);
    await expect(editorLocator(b.page)).toBeVisible({ timeout: 15_000 });
    await expect(tagRow(b.page).getByText("Shared tag", { exact: true })).toBeVisible();
    await expect(b.page.getByRole("button", { name: "Add a tag", exact: true })).toHaveCount(0);
    await expect(b.page.getByRole("button", { name: /^Remove tag/ })).toHaveCount(0);
    await editorLocator(b.page).click();
    await b.page.keyboard.press("ControlOrMeta+End");
    await waitForEditorSelection(b.page);
    await b.page.keyboard.type("/tag");
    // The menu is open once it reports that nothing matches "/tag"; waiting for the absence alone would pass before it opens.
    await expect.poll(() => slashTitles(b.page)).toEqual(["No items found"]);
    await b.page.keyboard.press("Escape");
    await b.page.getByRole("button", { name: "More", exact: true }).click();
    await expect(b.page.getByRole("menuitem", { name: "Add tag", exact: true })).toHaveCount(0);
    await b.page.keyboard.press("Escape");

    const denied = await b.page.request.post(`/api/notes/${noteId}/tags`, { data: { name: "Intruder" } });
    expect(denied.status()).toBe(403);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("rename, merge and delete in Settings → Tags change the note page and the sidebar", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const n1 = `E2E tags manage 1 ${RUN}`;
    const n2 = `E2E tags manage 2 ${RUN}`;
    const n3 = `E2E tags manage 3 ${RUN}`;
    const id1 = await apiCreateNote(page, n1);
    const id2 = await apiCreateNote(page, n2);
    const id3 = await apiCreateNote(page, n3);
    await apiAddTags(page, id1, ["first"]);
    await apiAddTags(page, id2, ["second"]);
    await apiAddTags(page, id3, ["third"]);

    await page.goto("/settings/tags");
    const settings = page.getByRole("dialog");
    await expect(settings.getByText("3 notes", { exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Rename first", exact: true })).toBeVisible({ timeout: 15_000 });

    await settings.getByRole("button", { name: "Rename first", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename tag" });
    await rename.getByRole("textbox", { name: "Tag name", exact: true }).fill("Renamed");
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Rename Renamed", exact: true })).toBeVisible();

    await settings.getByRole("button", { name: "Merge second into another tag", exact: true }).click();
    const merge = page.getByRole("dialog", { name: 'Merge "second" into another tag' });
    await merge.getByRole("combobox", { name: "Merge into", exact: true }).click();
    await page.getByRole("option", { name: "third", exact: true }).click();
    await merge.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(merge).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Rename second", exact: true })).toHaveCount(0);
    await expect(settings.getByText("2 notes", { exact: true })).toBeVisible();

    await page.goto("/");
    const panel = await showSidebarTab(page, "My notes");
    await expect(dots(noteLink(panel, n1).locator("xpath=ancestor::li[1]"), "Renamed")).toBeVisible({ timeout: 15_000 });
    await expect(dots(noteLink(panel, n2).locator("xpath=ancestor::li[1]"), "third")).toBeVisible();
    await expect(dots(noteLink(panel, n3).locator("xpath=ancestor::li[1]"), "third")).toBeVisible();
    await noteLink(panel, n2).click();
    await waitForNoteTitle(page, n2);
    await expect(tagRow(page).getByText("third", { exact: true })).toBeVisible();
    await expect(tagRow(page).getByText("second", { exact: true })).toHaveCount(0);

    await page.goto("/settings/tags");
    await page.getByRole("dialog").getByRole("button", { name: "Delete Renamed", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: 'Delete tag "Renamed"?' });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("dialog").getByRole("button", { name: "Delete Renamed", exact: true })).toHaveCount(0);

    await page.goto("/");
    const after = await showSidebarTab(page, "My notes");
    await expect(noteLink(after, n1)).toBeVisible({ timeout: 15_000 });
    await expect(after.locator("[data-tag-dots]")).toHaveCount(2);
    await noteLink(after, n1).click();
    await waitForNoteTitle(page, n1);
    await expect(tagRow(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("moving a note into a group keeps its tags as the group's tags", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E tags move ${RUN}`;
    const group = `E2E tags move group ${RUN}`;
    const groupId = await apiCreateGroup(page, group);
    const noteId = await apiCreateNote(page, title);
    await apiAddTags(page, noteId, ["carry", "along"]);
    const personal = (await (await page.request.get("/api/tags")).json()) as Array<{ name: string; color: string }>;

    const moved = await page.request.post(`/api/notes/${noteId}/move`, { data: { groupId } });
    expect(moved.status(), await moved.text()).toBe(200);

    const groupTags = (await (await page.request.get(`/api/groups/${groupId}/tags`)).json()) as Array<{ name: string; color: string; noteCount: number }>;
    expect(groupTags.map((tag) => [tag.name, tag.color, tag.noteCount])).toEqual(
      ["along", "carry"].map((name) => [name, personal.find((tag) => tag.name === name)!.color, 1]),
    );

    await page.goto("/");
    const panel = await showSidebarTab(page, "Groups");
    await noteLink(panel, title).click();
    await waitForNoteTitle(page, title);
    await expect(tagRow(page).getByText("carry", { exact: true })).toBeVisible();
    await expect(tagRow(page).getByText("along", { exact: true })).toBeVisible();
    await expect(dots(noteLink(panel, title).locator("xpath=ancestor::li[1]"), "carry, along")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the public page shows no tags", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  const anonymous = await browser.newContext();
  try {
    const title = `E2E tags public ${RUN}`;
    const noteId = await apiCreateNote(page, title, { content: "Some public text." });
    await apiAddTags(page, noteId, ["Hidden tag"]);
    const published = await page.request.put(`/api/notes/${noteId}/public-link`);
    expect(published.status(), await published.text()).toBe(200);
    const { token } = (await published.json()) as { token: string };

    const publicPage = await anonymous.newPage();
    await publicPage.goto(`/p/${token}`);
    await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(publicPage.getByText("Some public text.", { exact: true })).toBeVisible();
    await expect(publicPage.getByText("Hidden tag")).toHaveCount(0);
    await expect(tagRow(publicPage)).toHaveCount(0);
  } finally {
    await anonymous.close();
    await context.close();
  }
});

test("on a phone the tags sit in one row at the top of the note text, scroll away with it, and the rest fold into +N; the filter opens as a bottom sheet with Done", async ({ browser }) => {
  test.setTimeout(150_000);
  const phone = devices["iPhone 13"];
  const alice = await createAccount(browser, "alice");
  const context = await browser.newContext({ ...phone });
  const page = await context.newPage();
  try {
    await loginAs(page, alice.email, PASSWORD);
    const title = `E2E tags phone ${RUN}`;
    const other = `E2E tags phone other ${RUN}`;
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the phone note.`).join("\n\n");
    const noteId = await apiCreateNote(page, title, { content: body });
    await apiCreateNote(page, other);
    const names = ["Quarterly planning review", "Reading list for the summer", "Customer interviews", "Release checklist", "Travel", "Budget review meeting"];
    await apiAddTags(page, noteId, names);

    await page.goto("/");
    const list = await openListOnCompact(page);
    const panel = await showSidebarTab(page, "My notes", list);
    await noteLink(panel, title).click();
    await waitForNoteTitle(page, title);

    const row = tagRow(page);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const more = row.getByRole("button", { name: /^Show \d+ more tags$/ });
    await expect(more).toBeVisible();
    const pillTops = await row.evaluate((el) =>
      Array.from(el.querySelectorAll("[data-tag-color]"))
        .filter((pill) => !pill.closest("[data-pill-hidden]"))
        .map((pill) => Math.round(pill.getBoundingClientRect().top)),
    );
    expect(pillTops.length).toBeGreaterThan(0);
    expect(new Set(pillTops).size).toBe(1);

    const firstParagraph = editorLocator(page).getByText("Paragraph 1 of the phone note.", { exact: true });
    await expect(firstParagraph).toBeVisible({ timeout: 15_000 });
    const rowBox = (await row.boundingBox())!;
    const textBox = (await firstParagraph.boundingBox())!;
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(textBox.y + 1);

    await page.evaluate(() => window.scrollBy(0, 400));
    await expect.poll(async () => (await row.boundingBox())!.y).toBeLessThan(rowBox.y - 100);

    await page.evaluate(() => window.scrollTo(0, 0));
    await more.click();
    await expect(row.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
    await expect(more).toHaveCount(0);
    const wrapped = await row.evaluate((el) => new Set(Array.from(el.querySelectorAll("[data-tag-color]")).map((pill) => Math.round(pill.getBoundingClientRect().top))).size);
    expect(wrapped).toBeGreaterThan(1);

    const sidebar = await openListOnCompact(page);
    const myNotes = await showSidebarTab(page, "My notes", sidebar);
    await myNotes.getByRole("button", { name: "Filter by tag", exact: true }).click();
    const done = page.getByRole("menuitem", { name: "Done", exact: true });
    await expect(done).toBeVisible();
    // The sheet is modal, so the list behind it is out of the accessibility tree until Done closes it; the choice itself takes effect at once.
    await page.getByRole("menuitemcheckbox", { name: /^Travel/ }).click();
    await done.click();
    await expect(done).toHaveCount(0);
    await expect(noteLink(myNotes, title)).toBeVisible();
    await expect(noteLink(myNotes, other)).toHaveCount(0);
    await expect(myNotes.getByRole("button", { name: "Filter by tag, 1 applied", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("on a phone a very long first tag is cut short so the +N and Add buttons stay inside the row", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  try {
    await loginAs(page, alice.email, PASSWORD);
    const title = `E2E tags long ${RUN}`;
    const noteId = await apiCreateNote(page, title, { content: "Body." });
    await apiAddTags(page, noteId, ["長".repeat(40), "Travel"]);

    await page.goto("/");
    const list = await openListOnCompact(page);
    const panel = await showSidebarTab(page, "My notes", list);
    await noteLink(panel, title).click();
    await waitForNoteTitle(page, title);

    const row = tagRow(page);
    await expect(row.getByRole("button", { name: /^Show \d+ more tags$/ })).toBeVisible({ timeout: 15_000 });
    const rowBox = (await row.boundingBox())!;
    const addBox = (await row.getByRole("button", { name: "Add a tag", exact: true }).boundingBox())!;
    expect(addBox.x + addBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  } finally {
    await context.close();
  }
});
