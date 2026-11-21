import { expect, test, type Browser, type Page } from "@playwright/test";
import { chooseSelectOption, folderMenuButton, folderMenuItem, folderRow, openListOnCompact, showSidebarTab } from "./helpers.js";
import {
  RUN,
  apiAddGroupMember,
  apiCreateFolder,
  apiCreateGroup,
  apiCreateNote,
  apiRestoreNote,
  apiTrashNote,
  createAccount,
  expectIndexRow,
  indexRow,
  indexRows,
  indexTitle,
  makeKnowledge,
  openAs,
  openIndexUrl,
  openNote,
  type Account,
  type KnowledgeFields,
} from "./knowledge-helpers.js";
import { apiAddTags } from "./tag-helpers.js";

/**
 * The knowledge index: its entries in the sidebar and menus, what it lists and how it reads, grouping and filters, who can open it, and the phone layout.
 * Every test uses freshly created accounts, so notes never overlap between tests.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

interface Seed {
  heading: string;
  fields: KnowledgeFields;
}

/** A note made through the API, then given its knowledge the way a person does. */
async function seedNote(page: Page, title: string, content: string, place: { groupId?: string; folderId?: string }, knowledge: Seed[]) {
  const note = await apiCreateNote(page, title, content, place);
  if (knowledge.length > 0) {
    await openNote(page, note, title);
    for (const k of knowledge) await makeKnowledge(page, k.heading, k.fields);
  }
  return note;
}

/** The sidebar's note list is fetched once and reloaded here until the folder row has its index button. */
async function reloadUntilIndexButton(page: Page, folder: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    const panel = await showSidebarTab(page, "My notes");
    await expect(folderRow(panel, folder).getByRole("link", { name: `Open the index of ${folder}`, exact: true })).toHaveCount(1, { timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
}

async function oneFolderAccount(browser: Browser, name: string): Promise<{ alice: Account; context: Awaited<ReturnType<typeof openAs>>["context"]; page: Page }> {
  const alice = await createAccount(browser, name);
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  return { alice, context, page };
}

test("70-1 a folder with knowledge shows the index button on hover and Open index in its menu; a folder without knowledge has neither", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await oneFolderAccount(browser, "alice");
  try {
    const withKnowledge = `Roadmap ${RUN}`;
    const without = `Quiet ${RUN}`;
    const rich = await apiCreateFolder(page, withKnowledge, { space: { kind: "personal" } });
    const quiet = await apiCreateFolder(page, without, { space: { kind: "personal" } });
    await seedNote(page, `E2E index entry ${RUN}`, "## Sync rule\n\nBody text.", { folderId: rich }, [{ heading: "Sync rule", fields: { when: "Before touching the sync code" } }]);
    await apiCreateNote(page, `E2E plain ${RUN}`, "Nothing special.", { folderId: quiet });

    await reloadUntilIndexButton(page, withKnowledge);
    const panel = await showSidebarTab(page, "My notes");
    const row = folderRow(panel, withKnowledge);
    await row.hover();
    const button = row.getByRole("link", { name: `Open the index of ${withKnowledge}`, exact: true });
    await expect(button).toBeVisible();
    await expect(folderRow(panel, without).getByRole("link", { name: /^Open the index of / })).toHaveCount(0);

    await button.click();
    await expect(page).toHaveURL(`/knowledge/f/${rich}`);
    await expect(indexTitle(page, withKnowledge)).toBeVisible({ timeout: 15_000 });

    // The menu entry takes the same road; the quiet folder's menu has none.
    await page.goBack();
    const again = await showSidebarTab(page, "My notes");
    await folderMenuItem(page, again, withKnowledge, "Open index");
    await expect(page).toHaveURL(`/knowledge/f/${rich}`);

    await page.goBack();
    const third = await showSidebarTab(page, "My notes");
    const trigger = folderMenuButton(third, without);
    await trigger.hover();
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open index", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("70-2 the folder index lists when and conclusion with note and heading, nests a child under its parent, includes subfolders, and a row opens its heading", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await oneFolderAccount(browser, "alice");
  try {
    const parentName = `Roadmap ${RUN}`;
    const parent = await apiCreateFolder(page, parentName, { space: { kind: "personal" } });
    const child = await apiCreateFolder(page, "Sub", { parentId: parent });
    const title = `E2E index rows ${RUN}`;
    await seedNote(page, title, "## Sync rule\n\n### Child rule\n\nBody text.", { folderId: parent }, [
      { heading: "Sync rule", fields: { when: "Before touching the sync code", conclusion: "Run the full suite" } },
      { heading: "Child rule", fields: { conclusion: "Retry twice" } },
    ]);
    const deepTitle = `E2E index deep ${RUN}`;
    await seedNote(page, deepTitle, "## Deep rule\n\nBody text.", { folderId: child }, [
      { heading: "Deep rule", fields: { when: "When the deep path is slow", conclusion: "Use the cache" } },
    ]);

    await openIndexUrl(page, `/knowledge/f/${parent}`, parentName);
    // The last note seeded is the last to reach the index, so its row appearing means the others are in.
    await expectIndexRow(page, "When the deep path is slow");
    const top = indexRow(page, "Before touching the sync code");
    await expect(top).toContainText("Run the full suite");
    await expect(top).toContainText(`${title} › Sync rule`);
    await expect(top).toContainText("1 below: 0 verified, 1 not verified, 0 need review");

    // A child without a "when to read" sits under its parent instead of in the flat list.
    const childRow = indexRow(page, "Retry twice");
    await expect(childRow).toHaveCount(1);
    await expect(top.locator("xpath=ancestor::li[1]").locator("[data-kb-index-row]", { hasText: "Retry twice" })).toHaveCount(1);

    // A subfolder's knowledge counts in the parent's index, under its own section.
    await expect(page.getByRole("heading", { level: 2, name: /^Sub\b/ })).toBeVisible();
    const deep = indexRow(page, "When the deep path is slow");
    await expect(deep).toContainText(`${deepTitle} › Deep rule`);

    await deep.getByRole("link").first().click();
    await expect(page).toHaveURL(/#b-/);
    const blockId = new URL(page.url()).hash.slice("#b-".length);
    await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`)).toBeAttached({ timeout: 15_000 });
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(deepTitle);
  } finally {
    await context.close();
  }
});

test("70-3 needs review is flagged, outdated sits last and faded; the status and basis filters narrow the list, survive a reload and clear, and don't add history", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await oneFolderAccount(browser, "alice");
  try {
    const folderName = `Filtered ${RUN}`;
    const folder = await apiCreateFolder(page, folderName, { space: { kind: "personal" } });
    // Two notes in one section: the first note's outdated row has to land after the second note's current rows.
    await seedNote(page, `E2E index filters A ${RUN}`, "## Old rule\n\n## Fresh rule\n\nBody text.", { folderId: folder }, [
      { heading: "Fresh rule", fields: { when: "When it is fresh" } },
      { heading: "Old rule", fields: { when: "While it was current", status: "Outdated", replacedBy: "Fresh rule" } },
    ]);
    const second = await seedNote(page, `E2E index filters B ${RUN}`, "## Review rule\n\nBody text.", { folderId: folder }, [
      { heading: "Review rule", fields: { when: "When it needs a look", status: "Needs review", evidence: "Tested" } },
    ]);
    const indexPath = `/knowledge/f/${folder}`;
    await openIndexUrl(page, indexPath, folderName);
    // The last note seeded is the last to reach the index, so its row appearing means the others are in.
    await expectIndexRow(page, "When it needs a look");
    await expect(indexRows(page)).toHaveCount(3);

    // Document order is Old, Fresh (first note), Review (second note); the outdated one moves to the end of the section and is faded.
    await expect(indexRows(page).first()).toHaveAttribute("data-kind", "noVerifiedDate");
    await expect(indexRows(page).nth(1)).toHaveAttribute("data-kind", "needsReview");
    await expect(indexRows(page).nth(1)).toContainText("Needs review");
    const last = indexRows(page).last();
    await expect(last).toHaveAttribute("data-kind", "outdated");
    await expect(last).toHaveCSS("opacity", "0.6");
    await expect(last.getByRole("link", { name: "→ replaced by Fresh rule", exact: true })).toBeVisible();

    await chooseSelectOption(page, page.getByLabel("Status", { exact: true }), "Status: Outdated");
    await expect(page).toHaveURL(/[?&]status=outdated\b/);
    await expect(indexRows(page)).toHaveCount(1);
    await page.reload();
    await expect(indexTitle(page, folderName)).toBeVisible({ timeout: 15_000 });
    await expect(indexRows(page)).toHaveCount(1);
    await expect(indexRows(page).first()).toHaveAttribute("data-kind", "outdated");

    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(indexRows(page)).toHaveCount(3);
    await expect(page).not.toHaveURL(/status=/);

    await chooseSelectOption(page, page.getByLabel("Basis", { exact: true }), "Basis: Tested");
    await expect(page).toHaveURL(/[?&]evidence=tested\b/);
    await expect(indexRows(page)).toHaveCount(1);
    await expect(indexRows(page).first()).toContainText("When it needs a look");

    // Filter steps replace each other: going back leaves the index.
    await page.goBack();
    await expect(page).toHaveURL(second.path);
  } finally {
    await context.close();
  }
});

test("70-4 grouping by tag lists a note under each of its tags and untagged notes under No tag; ticking two tags keeps notes that have both", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await oneFolderAccount(browser, "alice");
  try {
    const folderName = `Tagged ${RUN}`;
    const folder = await apiCreateFolder(page, folderName, { space: { kind: "personal" } });
    const both = await seedNote(page, `E2E both tags ${RUN}`, "## Both rule\n\nBody text.", { folderId: folder }, [{ heading: "Both rule", fields: { when: "When both tags apply" } }]);
    const one = await seedNote(page, `E2E one tag ${RUN}`, "## One rule\n\nBody text.", { folderId: folder }, [{ heading: "One rule", fields: { when: "When one tag applies" } }]);
    await seedNote(page, `E2E no tag ${RUN}`, "## Bare rule\n\nBody text.", { folderId: folder }, [{ heading: "Bare rule", fields: { when: "When nothing is tagged" } }]);
    await apiAddTags(page, both.id, ["alpha", "beta"]);
    await apiAddTags(page, one.id, ["alpha"]);

    await openIndexUrl(page, `/knowledge/f/${folder}`, folderName);
    await expectIndexRow(page, "When nothing is tagged");
    await expect(indexRows(page)).toHaveCount(3);

    await page.getByRole("radio", { name: "Tag", exact: true }).click();
    const section = (name: string | RegExp) => page.getByRole("region", { name });
    await expect(section(/^alpha/).locator("[data-kb-index-row]")).toHaveCount(2);
    await expect(section(/^beta/).locator("[data-kb-index-row]")).toHaveCount(1);
    await expect(section(/^No tag/).locator("[data-kb-index-row]")).toHaveCount(1);
    await expect(indexRows(page)).toHaveCount(4);

    await page.getByRole("button", { name: /^Tags/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "alpha", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "beta", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/tags=/);
    await expect(indexRow(page, "When both tags apply").first()).toBeVisible();
    await expect(indexRow(page, "When one tag applies")).toHaveCount(0);
    await expect(indexRow(page, "When nothing is tagged")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("70-5 an index of a space or folder you can't open, including through a shared note, reads Index not found; an index with no knowledge explains itself", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const folderName = `Private ${RUN}`;
    const folder = await apiCreateFolder(a.page, folderName, { space: { kind: "personal" } });
    const note = await seedNote(a.page, `E2E private index ${RUN}`, "## Private rule\n\nBody text.", { folderId: folder }, [{ heading: "Private rule", fields: { when: "Only for the owner" } }]);
    const groupId = await apiCreateGroup(a.page, `E2E closed group ${RUN}`);
    const emptyFolder = await apiCreateFolder(a.page, `Empty ${RUN}`, { space: { kind: "personal" } });
    const shared = await a.page.request.put(`/api/notes/${note.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await openIndexUrl(a.page, `/knowledge/f/${folder}`, folderName);
    await expectIndexRow(a.page, "Only for the owner");

    // Having been shown one note of that folder doesn't open the folder's index.
    for (const path of [`/knowledge/f/${folder}`, `/knowledge/g/${groupId}`, "/knowledge/f/00000000-0000-4000-a000-000000000000"]) {
      await b.page.goto(path);
      await expect(b.page.getByText("Index not found", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(b.page.getByText("Only for the owner")).toHaveCount(0);
      await expect(b.page.getByRole("heading", { level: 1 })).toHaveCount(0);
    }

    await openIndexUrl(a.page, `/knowledge/f/${emptyFolder}`, `Empty ${RUN}`);
    await expect(a.page.getByText("No knowledge here yet", { exact: true })).toBeVisible();
    await expect(indexRows(a.page)).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("70-6 a note moved to the trash leaves the index and comes back when restored", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await oneFolderAccount(browser, "alice");
  try {
    const folderName = `Bin ${RUN}`;
    const folder = await apiCreateFolder(page, folderName, { space: { kind: "personal" } });
    const note = await seedNote(page, `E2E index trash ${RUN}`, "## Bin rule\n\nBody text.", { folderId: folder }, [{ heading: "Bin rule", fields: { when: "While it is in use" } }]);
    await openIndexUrl(page, `/knowledge/f/${folder}`, folderName);
    await expectIndexRow(page, "While it is in use");

    await apiTrashNote(page, note.id);
    await page.reload();
    await expect(indexTitle(page, folderName)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("No knowledge here yet", { exact: true })).toBeVisible();
    await expect(indexRow(page, "While it is in use")).toHaveCount(0);

    await apiRestoreNote(page, note.id);
    await expectIndexRow(page, "While it is in use");
  } finally {
    await context.close();
  }
});

test("70-7 My notes' title row and a group row open their space's index; a group member sees the group's knowledge and My notes leaves out notes shared with you", async ({ browser }) => {
  test.setTimeout(300_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const groupName = `E2E index group ${RUN}`;
    const groupId = await apiCreateGroup(a.page, groupName);
    await apiAddGroupMember(a.page, groupId, bob.email);
    await seedNote(a.page, `E2E index mine ${RUN}`, "## Mine rule\n\nBody text.", {}, [{ heading: "Mine rule", fields: { when: "When it is my note" } }]);
    await seedNote(a.page, `E2E index in group ${RUN}`, "## Team rule\n\nBody text.", { groupId }, [{ heading: "Team rule", fields: { when: "When the team decides" } }]);
    const bobNote = await seedNote(b.page, `E2E index bobs ${RUN}`, "## Bobs rule\n\nBody text.", {}, [{ heading: "Bobs rule", fields: { when: "When bob says so" } }]);
    const shared = await b.page.request.put(`/api/notes/${bobNote.id}/shares`, { data: { email: alice.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await expect(async () => {
      await a.page.reload();
      const panel = await showSidebarTab(a.page, "My notes");
      await expect(panel.getByRole("link", { name: "Open the index of My notes", exact: true })).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    const panel = await showSidebarTab(a.page, "My notes");
    const mine = panel.getByRole("link", { name: "Open the index of My notes", exact: true });
    await mine.locator("xpath=ancestor::div[contains(@class, 'group/tabheader')][1]").hover();
    await mine.click();
    await expect(a.page).toHaveURL("/knowledge/me");
    await expect(indexTitle(a.page, "My notes")).toBeVisible({ timeout: 15_000 });
    await expectIndexRow(a.page, "When it is my note");
    // Alice can see bob's knowledge elsewhere, so its absence here is the index's doing.
    await expect
      .poll(async () => ((await (await a.page.request.get("/api/knowledge/refs?q=Bobs%20rule")).json()) as { candidates: unknown[] }).candidates.length, { timeout: 30_000, intervals: [1_000] })
      .toBeGreaterThan(0);
    await a.page.reload();
    await expect(indexRow(a.page, "When it is my note")).toHaveCount(1, { timeout: 15_000 });
    await expect(indexRow(a.page, "When bob says so")).toHaveCount(0);
    await expect(indexRow(a.page, "When the team decides")).toHaveCount(0);

    const groups = await showSidebarTab(a.page, "Groups");
    const row = groups.getByRole("button", { name: groupName, exact: true }).locator("xpath=ancestor::li[1]");
    await row.hover();
    await row.getByRole("link", { name: `Open the index of ${groupName}`, exact: true }).click();
    await expect(a.page).toHaveURL(`/knowledge/g/${groupId}`);
    await expect(indexTitle(a.page, groupName)).toBeVisible({ timeout: 15_000 });
    await expect(indexRow(a.page, "When the team decides")).toHaveCount(1);
    await expect(indexRow(a.page, "When it is my note")).toHaveCount(0);

    await openIndexUrl(b.page, `/knowledge/g/${groupId}`, groupName);
    await expectIndexRow(b.page, "When the team decides");
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("70-8 on a phone, Open index from the folder menu shows the index page and Back to notes returns to the list", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const wide = await openAs(browser, alice, { viewport: DESKTOP });
  const folderName = `Phone ${RUN}`;
  let folder: string;
  try {
    folder = await apiCreateFolder(wide.page, folderName, { space: { kind: "personal" } });
    await seedNote(wide.page, `E2E index phone ${RUN}`, "## Phone rule\n\nBody text.", { folderId: folder }, [{ heading: "Phone rule", fields: { when: "When reading on a phone" } }]);
    await openIndexUrl(wide.page, `/knowledge/f/${folder}`, folderName);
    await expectIndexRow(wide.page, "When reading on a phone");
  } finally {
    await wide.context.close();
  }

  const phone = await openAs(browser, alice, PHONE);
  try {
    const page = phone.page;
    await expect(async () => {
      await page.reload();
      const list = await openListOnCompact(page);
      const panel = await showSidebarTab(page, "My notes", list);
      await expect(folderRow(panel, folderName).getByRole("link", { name: `Open the index of ${folderName}`, exact: true })).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    const panel = await showSidebarTab(page, "My notes");
    await folderMenuItem(page, panel, folderName, "Open index");
    await expect(page).toHaveURL(`/knowledge/f/${folder}`);
    await expect(indexTitle(page, folderName)).toBeVisible({ timeout: 15_000 });
    await expect(indexRow(page, "When reading on a phone")).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: "Back to notes", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Sidebar sections" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/knowledge\//);
  } finally {
    await phone.context.close();
  }
});
