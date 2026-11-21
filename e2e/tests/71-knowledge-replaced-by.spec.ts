import { expect, test, type Page } from "@playwright/test";
import { clickEndOfParagraph } from "./helpers.js";
import {
  RUN,
  apiAddGroupMember,
  apiCreateGroup,
  apiCreateNote,
  apiTrashNote,
  createAccount,
  headingLine,
  hoverCardOf,
  iconOf,
  indexRow,
  openAs,
  openIndexUrl,
  openNote,
  makeKnowledge,
  expectIndexRow,
} from "./knowledge-helpers.js";

/**
 * Naming another note's knowledge as the replacement: picking it, how it reads on the card and in the index, and what someone who can't see that note gets.
 * Every test uses freshly created accounts, so notes never overlap between tests.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const NOT_VISIBLE_TEXT = "knowledge in another note";

/** The server builds its knowledge table a few seconds after a save; the picker and the index read from it. */
async function waitUntilSearchable(page: Page, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/knowledge/refs?q=${encodeURIComponent(text)}`);
        return res.ok() ? ((await res.json()) as { candidates: unknown[] }).candidates.length : -1;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBeGreaterThan(0);
}

/** Every response body the page receives from now on, to look for text that must not be in any of them. */
function recordBodies(page: Page): () => Promise<string[]> {
  const pending: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
    pending.push(response.text().catch(() => ""));
  });
  return () => Promise.all(pending);
}

test("71-1 the replacement picker lists another note's knowledge under Other notes; the saved card links to it", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const target = await apiCreateNote(page, `E2E target ${RUN}`, "## Newer rule\n\nBody text.");
    await openNote(page, target, `E2E target ${RUN}`);
    await makeKnowledge(page, "Newer rule", { when: "Whenever the newer rule applies" });
    await waitUntilSearchable(page, "Newer rule");

    const oldNote = await apiCreateNote(page, `E2E source ${RUN}`, "## Older rule\n\nBody text.");
    await openNote(page, oldNote, `E2E source ${RUN}`);
    await makeKnowledge(page, "Older rule", { when: "Until the newer rule exists", status: "Outdated", replacedByOther: "Newer rule" });

    await iconOf(page, "Outdated").hover();
    const card = hoverCardOf(page);
    await expect(card.getByRole("button", { name: "Newer rule", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Newer rule", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${target.path}#b-`));
    await expect(headingLine(page, "Newer rule")).toBeVisible({ timeout: 15_000 });

    // The index row of the source note names the replacement and links to its heading.
    await openIndexUrl(page, "/knowledge/me", "My notes");
    const row = await expectIndexRow(page, "Until the newer rule exists");
    const link = row.getByRole("link", { name: "→ replaced by Newer rule", exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${target.path}#b-`));
  } finally {
    await context.close();
  }
});

test("71-2 renaming the other heading shows the new name, and trashing its note turns the card into the plain text", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  try {
    const target = await apiCreateNote(page, `E2E target ${RUN}`, "## Stable rule\n\nBody text.");
    await openNote(page, target, `E2E target ${RUN}`);
    await makeKnowledge(page, "Stable rule", { when: "Whenever it is stable" });
    await waitUntilSearchable(page, "Stable rule");
    const oldNote = await apiCreateNote(page, `E2E source ${RUN}`, "## Shaky rule\n\nBody text.");
    await openNote(page, oldNote, `E2E source ${RUN}`);
    await makeKnowledge(page, "Shaky rule", { when: "Until the stable rule", status: "Outdated", replacedByOther: "Stable rule" });

    await openNote(page, target, `E2E target ${RUN}`);
    await clickEndOfParagraph(page, headingLine(page, "Stable rule"));
    await page.keyboard.type(" renamed");
    await expect(headingLine(page, "Stable rule renamed")).toBeVisible();
    await waitUntilSearchable(page, "Stable rule renamed");

    await openNote(page, oldNote, `E2E source ${RUN}`);
    await iconOf(page, "Outdated").hover();
    await expect(hoverCardOf(page).getByRole("button", { name: "Stable rule renamed", exact: true })).toBeVisible();

    await apiTrashNote(page, target.id);
    await openNote(page, oldNote, `E2E source ${RUN}`);
    await iconOf(page, "Outdated").hover();
    const card = hoverCardOf(page);
    await expect(card).toContainText(`replaced by ${NOT_VISIBLE_TEXT}`);
    await expect(card.getByRole("button", { name: NOT_VISIBLE_TEXT })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("71-3 someone who can't see the other note gets the same plain text as for a missing one, and no response carries its title", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const secret = `Secret target ${RUN}`;
    const target = await apiCreateNote(a.page, `E2E hidden ${RUN}`, `## ${secret}\n\nBody text.`);
    await openNote(a.page, target, `E2E hidden ${RUN}`);
    await makeKnowledge(a.page, secret, { when: "Whenever the secret applies" });
    await waitUntilSearchable(a.page, secret);
    const oldNote = await apiCreateNote(a.page, `E2E shared ${RUN}`, "## Visible rule\n\nBody text.");
    await openNote(a.page, oldNote, `E2E shared ${RUN}`);
    await makeKnowledge(a.page, "Visible rule", { when: "Until the secret rule", status: "Outdated", replacedByOther: secret });
    const shared = await a.page.request.put(`/api/notes/${oldNote.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    const bodies = recordBodies(b.page);
    await b.page.goto(oldNote.path);
    await expect(b.page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    await iconOf(b.page, "Outdated").hover();
    const card = hoverCardOf(b.page);
    await expect(card).toContainText(`replaced by ${NOT_VISIBLE_TEXT}`);
    await expect(card.getByRole("button", { name: NOT_VISIBLE_TEXT })).toHaveCount(0);
    const whileHidden = (await card.textContent()) ?? "";

    // What bob sees now is what he sees when the note is gone.
    await apiTrashNote(a.page, target.id);
    await b.page.reload();
    await expect(iconOf(b.page, "Outdated")).toBeVisible({ timeout: 15_000 });
    await iconOf(b.page, "Outdated").hover();
    await expect(hoverCardOf(b.page)).toContainText(`replaced by ${NOT_VISIBLE_TEXT}`);
    expect(((await hoverCardOf(b.page).textContent()) ?? "").trim()).toBe(whileHidden.trim());

    for (const body of await bodies()) expect(body).not.toContain(secret);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("71-4 in a group index a member who can't see the personal replacement gets the plain text and no link; its owner gets the title and a link", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const groupName = `E2E group ${RUN}`;
    const groupId = await apiCreateGroup(a.page, groupName);
    await apiAddGroupMember(a.page, groupId, bob.email);
    const secret = `Private target ${RUN}`;
    const personal = await apiCreateNote(a.page, `E2E private ${RUN}`, `## ${secret}\n\nBody text.`);
    await openNote(a.page, personal, `E2E private ${RUN}`);
    await makeKnowledge(a.page, secret, { when: "Whenever the private rule applies" });
    await waitUntilSearchable(a.page, secret);
    const groupNote = await apiCreateNote(a.page, `E2E group note ${RUN}`, "## Group rule\n\nBody text.", { groupId });
    await openNote(a.page, groupNote, `E2E group note ${RUN}`);
    await makeKnowledge(a.page, "Group rule", { when: "Until the private rule", status: "Outdated", replacedByOther: secret });

    await openIndexUrl(a.page, `/knowledge/g/${groupId}`, groupName);
    const aliceRow = await expectIndexRow(a.page, "Until the private rule");
    await expect(aliceRow.getByRole("link", { name: `→ replaced by ${secret}`, exact: true })).toBeVisible();

    const bodies = recordBodies(b.page);
    await openIndexUrl(b.page, `/knowledge/g/${groupId}`, groupName);
    const bobRow = await expectIndexRow(b.page, "Until the private rule");
    await expect(bobRow).toContainText(`→ replaced by ${NOT_VISIBLE_TEXT}`);
    await expect(bobRow.getByRole("link", { name: /replaced by/ })).toHaveCount(0);
    await expect(indexRow(b.page, "Until the private rule")).toHaveCount(1);
    for (const body of await bodies()) expect(body).not.toContain(secret);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
