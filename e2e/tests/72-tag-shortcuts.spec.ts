import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { createNote, editorLocator, loginAs, noteIdFromUrl, openListOnCompact, showSidebarTab, toastWithTitle, waitForEditorSelection } from "./helpers.js";
import { apiCreateNote as apiCreateNoteWithPath, openNote } from "./knowledge-helpers.js";
import {
  PASSWORD,
  RUN,
  apiAddTags,
  apiCreateGroup,
  apiCreateNote,
  createAccount,
  dots,
  noteLink,
  openAs,
  tagRow,
  waitForNoteTitle,
} from "./tag-helpers.js";

/**
 * Tag shortcuts: `#name` plus a space on the first line, pasting a line of `#names`, the menu behind a tag in the row, and `#` in the sidebar search box.
 * Every test uses freshly created accounts, so tag lists never overlap between tests; notes, tags and groups are left in place (the stack is reset by `stack:down -v` each time).
 * The search box is located by its `aria-label` on the input: while the completion list is open the input's role is combobox, not textbox.
 */

const PHONE = devices["iPhone 13"];

function searchBox(scope: Locator): Locator {
  return scope.locator('input[aria-label="Search notes"]');
}

function pill(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Tag ${name}`, exact: true });
}

function hashOption(page: Page, name: string, count: number): Locator {
  return page.getByRole("option", { name: `${name} ${count} ${count === 1 ? "note" : "notes"}`, exact: true });
}

function tokenButton(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name: `Remove tag filter ${name}`, exact: true });
}

/** Puts the caret at the end of the first block of an empty note and types, the way a person starts a note. */
async function typeInEditor(page: Page, text: string): Promise<void> {
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.keyboard.type(text);
}

/** A paste event carrying only plain text, the way a copy from a text editor arrives. */
async function pastePlain(page: Page, text: string): Promise<void> {
  await editorLocator(page).click();
  await waitForEditorSelection(page);
  await editorLocator(page).evaluate((target, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function apiTagList(page: Page): Promise<Array<{ name: string; color: string; noteCount: number }>> {
  const list = await page.request.get("/api/tags");
  expect(list.status(), await list.text()).toBe(200);
  return (await list.json()) as Array<{ name: string; color: string; noteCount: number }>;
}

test("typing #name and a space in the first paragraph adds the tag, clears the line and shows a toast; a second #name adds another; # and a space still makes a heading", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E hash type ${RUN}`;
    await createNote(page, title);
    await typeInEditor(page, "#alpha ");
    await expect(tagRow(page).getByText("alpha", { exact: true })).toBeVisible();
    await expect(toastWithTitle(page, "Tags added: alpha")).toBeVisible();
    await expect(editorLocator(page)).not.toContainText("#alpha");
    const panel = await showSidebarTab(page, "My notes");
    await expect(dots(noteLink(panel, title).locator("xpath=ancestor::li[1]"), "alpha")).toBeVisible();

    await typeInEditor(page, "#beta ");
    await expect(tagRow(page).getByText("beta", { exact: true })).toBeVisible();
    await expect(editorLocator(page)).not.toContainText("#beta");
    await expect.poll(async () => (await apiTagList(page)).map((tag) => [tag.name, tag.noteCount])).toEqual([
      ["alpha", 1],
      ["beta", 1],
    ]);

    // Still the first line of the note, but not a tag: `# ` is the heading shortcut.
    await typeInEditor(page, "# Heading text");
    await expect(editorLocator(page).locator("h1")).toHaveText("Heading text");
    await expect(tagRow(page).getByText("alpha", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("full-width ＃name followed by a full-width space adds the tag", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E hash wide ${RUN}`);
    await typeInEditor(page, "＃全形　");
    await expect(tagRow(page).getByText("全形", { exact: true })).toBeVisible();
    await expect(editorLocator(page)).not.toContainText("全形");
  } finally {
    await context.close();
  }
});

test("a #name in a later block or after other text stays text and adds no tag", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E hash later ${RUN}`);
    await typeInEditor(page, "Intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("#second ");
    await expect(editorLocator(page)).toContainText("#second");
    await page.keyboard.press("Enter");
    await page.keyboard.type("#third ");
    await expect(editorLocator(page)).toContainText("#third");
    // The tags are checked last: a conversion would have removed the text above before the tag arrived.
    expect(await apiTagList(page)).toEqual([]);
    await expect(tagRow(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Ctrl+Z after the conversion brings only the text back and leaves the tag; the toast's Undo then removes the tag and leaves one copy of the text", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E hash undo ${RUN}`);
    await typeInEditor(page, "#alpha ");
    await expect(tagRow(page).getByText("alpha", { exact: true })).toBeVisible();
    const toast = toastWithTitle(page, "Tags added: alpha");
    await expect(toast).toBeVisible();
    // Pointing at the toast pauses its timer, so the click below doesn't race the five seconds it stays.
    await toast.hover();

    await page.keyboard.press("ControlOrMeta+z");
    await expect(editorLocator(page)).toHaveText("#alpha");
    await expect(tagRow(page).getByText("alpha", { exact: true })).toBeVisible();
    expect((await apiTagList(page)).map((tag) => [tag.name, tag.noteCount])).toEqual([["alpha", 1]]);

    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(tagRow(page)).toHaveCount(0);
    await expect(editorLocator(page)).toHaveText("#alpha");
    await expect.poll(async () => (await apiTagList(page)).map((tag) => [tag.name, tag.noteCount])).toEqual([["alpha", 0]]);
  } finally {
    await context.close();
  }
});

test("the toast's Undo puts the line back when Ctrl+Z wasn't used", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E hash undo only ${RUN}`);
    await typeInEditor(page, "#alpha ");
    await expect(editorLocator(page)).not.toContainText("#alpha");
    const toast = toastWithTitle(page, "Tags added: alpha");
    await expect(toast).toBeVisible();
    await toast.hover();
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(tagRow(page)).toHaveCount(0);
    await expect(editorLocator(page)).toHaveText("#alpha");
  } finally {
    await context.close();
  }
});

test("someone who can edit only through a share gets plain text for #name, no tag and no menu on the tags", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  try {
    const title = `E2E hash share ${RUN}`;
    await createNote(a.page, title);
    const noteUrl = a.page.url();
    const noteId = await noteIdFromUrl(a.page);
    await apiAddTags(a.page, noteId, ["Shared tag"]);
    const shared = await a.page.request.put(`/api/notes/${noteId}/shares`, { data: { email: bob.email, role: "editor" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await b.page.goto(noteUrl);
    await waitForNoteTitle(b.page, title);
    await expect(editorLocator(b.page)).toBeVisible({ timeout: 15_000 });
    await expect(tagRow(b.page).getByText("Shared tag", { exact: true })).toBeVisible();
    // The owner's pill opens a menu, so its absence for bob is a difference the test can see.
    await expect(pill(b.page, "Shared tag")).toHaveCount(0);
    await a.page.reload();
    await waitForNoteTitle(a.page, title);
    await expect(pill(a.page, "Shared tag")).toBeVisible();

    await typeInEditor(b.page, "#bobtag ");
    await expect(editorLocator(b.page)).toContainText("#bobtag");
    await expect(b.page.getByRole("button", { name: "Add a tag", exact: true })).toHaveCount(0);
    expect((await apiTagList(a.page)).map((tag) => tag.name)).toEqual(["Shared tag"]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("pasting '#alpha #beta' and a blank line before the text adds both tags and leaves only the text; a line with other words, or only a line break before the text, stays text", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await createNote(page, `E2E hash paste ${RUN}`);
    await pastePlain(page, "#alpha   #beta\n\nBody after the tags");
    await expect(tagRow(page).getByText("alpha", { exact: true })).toBeVisible();
    await expect(tagRow(page).getByText("beta", { exact: true })).toBeVisible();
    await expect(editorLocator(page)).toContainText("Body after the tags");
    await expect(editorLocator(page)).not.toContainText("#alpha");
    await expect(toastWithTitle(page, "Tags added: alpha, beta")).toBeVisible();

    await createNote(page, `E2E hash paste words ${RUN}`);
    await pastePlain(page, "#gamma delta");
    await expect(editorLocator(page)).toContainText("#gamma delta");
    await expect(tagRow(page)).toHaveCount(0);

    await createNote(page, `E2E hash paste break ${RUN}`);
    await pastePlain(page, "#gamma #delta\nBody on the next line");
    await expect(editorLocator(page)).toContainText("#gamma #delta");
    await expect(editorLocator(page)).toContainText("Body on the next line");
    await expect(tagRow(page)).toHaveCount(0);
    expect((await apiTagList(page)).map((tag) => tag.name)).toEqual(["alpha", "beta"]);
  } finally {
    await context.close();
  }
});

test("a manager clicks a tag to rename it, recolor it for every note and take it off this note", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const first = `E2E pill menu first ${RUN}`;
    const second = `E2E pill menu second ${RUN}`;
    const firstNote = await apiCreateNoteWithPath(page, first, "Body of the first note.");
    const secondId = await apiCreateNote(page, second);
    await apiAddTags(page, firstNote.id, ["work"]);
    await apiAddTags(page, secondId, ["work"]);

    await openNote(page, firstNote, first);
    await pill(page, "work").click();
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename tag" });
    await rename.getByRole("textbox", { name: "Tag name", exact: true }).fill("Job");
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(pill(page, "Job")).toBeVisible();

    await pill(page, "Job").click();
    await page.getByRole("menuitemradio", { name: "Red", exact: true }).click();
    // The menu stays open after a color so colors can be compared.
    await expect(page.getByRole("menuitemradio", { name: "Red", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tagRow(page).locator('[data-tag-color="red"]')).toHaveCount(1);
    expect((await apiTagList(page)).map((tag) => [tag.name, tag.color, tag.noteCount])).toEqual([["Job", "red", 2]]);

    const panel = await showSidebarTab(page, "My notes");
    await expect(dots(noteLink(panel, second).locator("xpath=ancestor::li[1]"), "Job")).toBeVisible({ timeout: 15_000 });

    await pill(page, "Job").click();
    await page.getByRole("menuitem", { name: "Remove from this note", exact: true }).click();
    await expect(tagRow(page)).toHaveCount(0);
    await expect.poll(async () => (await apiTagList(page)).map((tag) => [tag.name, tag.noteCount])).toEqual([["Job", 1]]);
    await expect(dots(noteLink(panel, second).locator("xpath=ancestor::li[1]"), "Job")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a group member who can edit but not manage the group only gets Remove from this note in a tag's menu", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  try {
    const groupId = await apiCreateGroup(a.page, `E2E pill group ${RUN}`);
    const added = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBe(200);
    const title = `E2E pill group note ${RUN}`;
    const created = await a.page.request.post("/api/notes", { data: { title, content: "Group note body.", groupId } });
    expect(created.status(), await created.text()).toBe(201);
    const { id: groupNoteId, slug } = (await created.json()) as { id: string; slug: string };
    await apiAddTags(a.page, groupNoteId, ["spec"]);
    const path = `/g/${groupId}/${slug}`;

    // The manager's menu is complete.
    await a.page.goto(path);
    await waitForNoteTitle(a.page, title);
    await pill(a.page, "spec").click();
    await expect(a.page.getByRole("menuitem", { name: "Rename…", exact: true })).toBeVisible();
    await expect(a.page.getByRole("menuitem", { name: "Remove from this note", exact: true })).toBeVisible();
    await a.page.keyboard.press("Escape");

    await b.page.goto(path);
    await waitForNoteTitle(b.page, title);
    await expect(pill(b.page, "spec")).toBeVisible({ timeout: 15_000 });
    await pill(b.page, "spec").click();
    await expect(b.page.getByRole("menuitem", { name: "Remove from this note", exact: true })).toBeVisible();
    await expect(b.page.getByRole("menuitem", { name: "Rename…", exact: true })).toHaveCount(0);
    await expect(b.page.getByRole("menuitemradio")).toHaveCount(0);
    await b.page.getByRole("menuitem", { name: "Remove from this note", exact: true }).click();
    await expect(tagRow(b.page)).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("# in the search box lists tags; picking two keeps only notes with both, a keyword narrows them, and Backspace takes the last tag off", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const both = `E2E hs both ${RUN}`;
    const onlyAlpha = `E2E hs alphaonly ${RUN}`;
    const onlyBeta = `E2E hs betaonly ${RUN} alphaonly`;
    const plain = `E2E hs plain ${RUN}`;
    await apiAddTags(page, await apiCreateNote(page, both), ["alpha", "beta"]);
    await apiAddTags(page, await apiCreateNote(page, onlyAlpha), ["alpha"]);
    await apiAddTags(page, await apiCreateNote(page, onlyBeta), ["beta"]);
    await apiCreateNote(page, plain);

    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    const panel = await showSidebarTab(page, "My notes");
    for (const title of [both, onlyAlpha, onlyBeta, plain]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });

    const search = searchBox(sidebar);
    await search.click();
    await search.pressSequentially("#alp");
    await expect(hashOption(page, "alpha", 2)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    await expect(tokenButton(sidebar, "alpha")).toBeVisible();
    await expect(search).toHaveValue("");
    await expect(noteLink(sidebar, both)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(sidebar, onlyAlpha)).toBeVisible();
    await expect(noteLink(sidebar, onlyBeta)).toHaveCount(0);
    await expect(noteLink(sidebar, plain)).toHaveCount(0);
    await expect(sidebar.getByText("My notes · alpha · 2 notes", { exact: true })).toBeVisible();

    await search.pressSequentially("#bet");
    await expect(hashOption(page, "beta", 2)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(tokenButton(sidebar, "beta")).toBeVisible();
    await expect(noteLink(sidebar, both)).toBeVisible();
    await expect(noteLink(sidebar, onlyAlpha)).toHaveCount(0);
    await expect(noteLink(sidebar, onlyBeta)).toHaveCount(0);

    await page.keyboard.press("Backspace");
    await expect(tokenButton(sidebar, "beta")).toHaveCount(0);
    await expect(tokenButton(sidebar, "alpha")).toBeVisible();
    await expect(noteLink(sidebar, onlyAlpha)).toBeVisible();

    // The keyword is also in the beta-only note's title, which the alpha token keeps out.
    await search.pressSequentially("alphaonly");
    await expect(noteLink(sidebar, onlyAlpha)).toBeVisible();
    await expect(noteLink(sidebar, both)).toHaveCount(0);
    await expect(noteLink(sidebar, onlyBeta)).toHaveCount(0);

    await tokenButton(sidebar, "alpha").click();
    await expect(noteLink(sidebar, onlyBeta)).toBeVisible();
    await expect(noteLink(sidebar, onlyAlpha)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a # word that is no tag, or that Esc keeps as text, is searched as plain text", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const issue = `E2E hs issue #105 ${RUN}`;
    const tagged = `E2E hs tagged ${RUN}`;
    const named = `E2E hs #topic notes ${RUN}`;
    await apiCreateNote(page, issue);
    await apiAddTags(page, await apiCreateNote(page, tagged), ["topic"]);
    await apiCreateNote(page, named);

    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    const panel = await showSidebarTab(page, "My notes");
    for (const title of [issue, tagged, named]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });

    const search = searchBox(sidebar);
    await search.click();
    await search.pressSequentially("#105");
    await expect(noteLink(sidebar, issue)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(sidebar, tagged)).toHaveCount(0);
    await expect(sidebar.getByRole("option")).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: /^Remove tag filter/ })).toHaveCount(0);

    await search.fill("");
    await search.pressSequentially("#topic");
    // The list and the text search answer at the same time: the tag is offered and the note whose title has "#topic" is found.
    await expect(hashOption(page, "topic", 1)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(sidebar, named)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(sidebar, tagged)).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(search).toHaveValue("#topic");
    await expect(noteLink(sidebar, named)).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /^Remove tag filter/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("choosing a tag of another space replaces the tags in the search box", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const groupName = `E2E hs group ${RUN}`;
    const groupId = await apiCreateGroup(page, groupName);
    const mine = `E2E hs mine ${RUN}`;
    const theirs = `E2E hs theirs ${RUN}`;
    await apiAddTags(page, await apiCreateNote(page, mine), ["ptag"]);
    await apiAddTags(page, await apiCreateNote(page, theirs, { groupId }), ["gtag"]);

    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    const panel = await showSidebarTab(page, "My notes");
    await expect(noteLink(panel, mine)).toBeVisible({ timeout: 15_000 });

    const search = searchBox(sidebar);
    await search.click();
    await search.pressSequentially("#pt");
    await expect(hashOption(page, "ptag", 1)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    await expect(tokenButton(sidebar, "ptag")).toBeVisible();
    await expect(noteLink(sidebar, mine)).toBeVisible({ timeout: 15_000 });

    await search.pressSequentially("#gt");
    const option = hashOption(page, "gtag", 1);
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("group", { name: groupName, exact: true })).toBeVisible();
    await expect(page.getByText("Tags of another space replace the current ones", { exact: true })).toBeVisible();
    await option.click();
    await expect(tokenButton(sidebar, "gtag")).toBeVisible();
    await expect(tokenButton(sidebar, "ptag")).toHaveCount(0);
    await expect(noteLink(sidebar, theirs)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(sidebar, mine)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on a phone the # list opens inside the screen, a tapped tag becomes a token and the list shows only its notes", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  try {
    await loginAs(page, alice.email, PASSWORD);
    const tagged = `E2E hs phone tagged ${RUN}`;
    const other = `E2E hs phone other ${RUN}`;
    await apiAddTags(page, await apiCreateNote(page, tagged), ["Travel"]);
    await apiCreateNote(page, other);

    await page.goto("/");
    const list = await openListOnCompact(page);
    const panel = await showSidebarTab(page, "My notes", list);
    await expect(noteLink(panel, tagged)).toBeVisible({ timeout: 15_000 });
    const input = searchBox(list);
    if (!(await input.isVisible())) await list.getByRole("button", { name: "Search notes", exact: true }).click();
    await input.click();
    await input.pressSequentially("#tra");

    const option = hashOption(page, "Travel", 1);
    await expect(option).toBeVisible({ timeout: 15_000 });
    const box = (await option.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    await option.click();

    await expect(tokenButton(list, "Travel")).toBeVisible();
    await expect(noteLink(list, tagged)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(list, other)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("on a phone tapping a tag opens a bottom sheet with Rename, Color and Remove from this note, and Remove takes it off", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  try {
    await loginAs(page, alice.email, PASSWORD);
    const title = `E2E pill phone ${RUN}`;
    const note = await apiCreateNoteWithPath(page, title, "Phone body.");
    await apiAddTags(page, note.id, ["Travel"]);

    await openNote(page, note, title);
    await expect(pill(page, "Travel")).toBeVisible({ timeout: 15_000 });
    // A touch screen has no × on the pill; the menu holds the removal.
    await expect(page.getByRole("button", { name: "Remove tag Travel", exact: true })).toBeHidden();
    await pill(page, "Travel").click();
    await expect(page.getByRole("menuitem", { name: "Rename…", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Red", exact: true })).toBeVisible();
    const remove = page.getByRole("menuitem", { name: "Remove from this note", exact: true });
    await expect(remove).toBeVisible();
    // The sheet rises into place, so the position is polled rather than read once.
    const height = page.viewportSize()!.height;
    await expect.poll(async () => (await remove.boundingBox())!.y + (await remove.boundingBox())!.height).toBeLessThanOrEqual(height);
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await remove.click();
    await expect(tagRow(page)).toHaveCount(0);
    await expect.poll(async () => (await apiTagList(page)).map((tag) => [tag.name, tag.noteCount])).toEqual([["Travel", 0]]);
  } finally {
    await context.close();
  }
});
