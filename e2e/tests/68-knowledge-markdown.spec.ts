import { expect, test } from "@playwright/test";
import { editorLocator } from "./helpers.js";
import { RUN, apiCreateNote, createAccount, hoverCardOf, iconOf, iconsIn, openAs, openNote, waitForNoteTitle } from "./knowledge-helpers.js";
import { callTool, callToolOk, closeAgent, createAgent, errorText, expectHoverCard, headingWithText, knowledgeComment, knowledgeIdIn, readSection, restMarkdown, type Agent } from "./markdown-helpers.js";

/**
 * Knowledge info in the markdown an agent reads and writes through MCP and REST, checked against what an open browser tab shows.
 * Every test uses its own account and PAT, and the agent's requests come from a cookie-less context.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const WHEN = "When a job fails twice";
const CONCLUSION = "Back off before the third try";

const NOTE_MARKDOWN = [
  "## Retry policy",
  knowledgeComment([`when: ${WHEN}`, `conclusion: ${CONCLUSION}`, "evidence: tested"]),
  "",
  "Body text.",
  "",
  "## Other",
  "",
  "Plain section.",
  "",
].join("\n");

test("68-1 a note's knowledge info is in the markdown read_note_section and the REST content return, under its heading only", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  try {
    const title = `E2E knowledge read ${RUN}`;
    const note = await apiCreateNote(page, title, NOTE_MARKDOWN);
    await openNote(page, note, title);
    await expect(iconOf(page, "Not verified")).toHaveCount(1);
    agent = await createAgent(browser, page);

    const section = await readSection(agent, note.id, "Retry policy");
    expect(section.markdown).toMatch(/^## Retry policy\n<!-- knotebook:knowledge\nid: k_[0-9a-f]{8}\n/);
    expect(section.markdown).toContain(`\nwhen: ${WHEN}\n`);
    expect(section.markdown).toContain(`\nconclusion: ${CONCLUSION}\n`);
    expect(section.markdown).toContain("\nevidence: tested\n-->\n\nBody text.");

    const other = await readSection(agent, note.id, "Other");
    expect(other.markdown).not.toContain("knotebook:knowledge");

    const whole = await restMarkdown(agent, note.id);
    expect(knowledgeIdIn(whole)).toBe(knowledgeIdIn(section.markdown));
  } finally {
    await closeAgent(agent);
    await context.close();
  }
});

test("68-2 edit_note replace_section keeps the knowledge without a comment, follows a comment that changed a field, and refuses a bad comment without touching the note", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  try {
    const title = `E2E knowledge rewrite ${RUN}`;
    const note = await apiCreateNote(page, title, NOTE_MARKDOWN);
    await openNote(page, note, title);
    agent = await createAgent(browser, page);
    const original = await readSection(agent, note.id, "Retry policy");
    const knowledgeId = knowledgeIdIn(original.markdown);

    // No comment: the heading has the same text and level, so the knowledge stays.
    const kept = await callToolOk(agent, "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: original.sectionId,
      markdown: "## Retry policy\n\nRewritten body.\n",
      if_match: original.fingerprint,
    });
    expect((kept.structuredContent!.knowledge as { kept: unknown }).kept).toEqual([{ id: knowledgeId, heading: "Retry policy" }]);
    await expect(editorLocator(page).getByText("Rewritten body.", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(iconsIn(page)).toHaveCount(1);
    await expectHoverCard(page, WHEN);
    await expect(hoverCardOf(page)).toContainText(CONCLUSION);

    // A comment that changes `when`: the card shows the new text.
    const second = await readSection(agent, note.id, "Retry policy");
    expect(knowledgeIdIn(second.markdown)).toBe(knowledgeId);
    const newWhen = "Only after the second failure";
    await callToolOk(agent, "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: second.sectionId,
      markdown: second.markdown.replace(`when: ${WHEN}`, `when: ${newWhen}`),
      if_match: second.fingerprint,
    });
    expect((await readSection(agent, note.id, "Retry policy")).markdown).toContain(`
when: ${newWhen}
`);
    await expectHoverCard(page, newWhen);
    await expect(hoverCardOf(page)).not.toContainText(WHEN);

    // A comment that isn't valid: an error, and the note stays as it was.
    const third = await readSection(agent, note.id, "Retry policy");
    const before = await restMarkdown(agent, note.id);
    const bad = await callTool(agent, "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: third.sectionId,
      markdown: "## Retry policy\n<!-- knotebook:knowledge\nstatus: bogus\n-->\n\nShould not appear.\n",
      if_match: third.fingerprint,
    });
    expect(bad.isError).toBe(true);
    const problem = JSON.parse(errorText(bad)) as { code: string; message: string };
    expect(problem.code).toBe("invalid_knowledge");
    expect(problem.message).toContain('"Retry policy"');
    expect(problem.message).toContain("Nothing was written");
    expect(await restMarkdown(agent, note.id)).toBe(before);
    await expect(editorLocator(page).getByText("Rewritten body.", { exact: true })).toBeVisible();
    await expect(editorLocator(page).getByText("Should not appear.", { exact: true })).toHaveCount(0);
    await expectHoverCard(page, newWhen);
  } finally {
    await closeAgent(agent);
    await context.close();
  }
});

test("68-3 create_note with a knowledge comment opens with the icon and the card in the browser", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  try {
    agent = await createAgent(browser, page);
    const title = `E2E knowledge create ${RUN}`;
    const created = await callToolOk(agent, "create_note", { title, content: NOTE_MARKDOWN });
    const note = (created.structuredContent as { note: { id: string; url: string } }).note;
    const report = created.structuredContent!.knowledge as { created: Array<{ heading: string }> };
    expect(report.created.map((c) => c.heading)).toEqual(["Retry policy"]);

    await page.goto(note.url);
    await waitForNoteTitle(page, title);
    await expect(iconOf(page, "Not verified")).toBeVisible({ timeout: 15_000 });
    await expectHoverCard(page, WHEN);
    await expect(iconsIn(page)).toHaveCount(1);
  } finally {
    await closeAgent(agent);
    await context.close();
  }
});

test("68-4 reverting an AI edit that dropped the knowledge brings the icon, the card and the id back", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
  let agent: Agent | undefined;
  try {
    const title = `E2E knowledge revert ${RUN}`;
    const note = await apiCreateNote(page, title, NOTE_MARKDOWN);
    await openNote(page, note, title);
    agent = await createAgent(browser, page);
    const original = await readSection(agent, note.id, "Retry policy");
    const knowledgeId = knowledgeIdIn(original.markdown);

    // The heading's text changes and no comment comes with it, so the knowledge goes.
    const dropped = await callToolOk(agent, "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: original.sectionId,
      markdown: "## Retry rules\n\nBody text.\n",
      if_match: original.fingerprint,
    });
    const editId = dropped.structuredContent!.editId as string;
    expect((dropped.structuredContent!.knowledge as { removed: unknown }).removed).toEqual([{ id: knowledgeId, heading: "Retry policy" }]);
    await expect(headingWithText(page, "Retry rules")).toBeVisible({ timeout: 15_000 });
    await expect(iconsIn(page)).toHaveCount(0);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI edit history" }).click();
    const history = page.getByRole("dialog", { name: "AI edits on this note" });
    await history.getByTestId(`ai-edit-${editId}`).getByRole("button", { name: "Revert", exact: true }).click();
    await expect(page.getByText("Edit reverted.", { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await expect(history).toBeHidden();

    await expect(headingWithText(page, "Retry policy")).toBeVisible({ timeout: 15_000 });
    await expect(iconOf(page, "Not verified")).toBeVisible();
    await expectHoverCard(page, WHEN);
    const restored = await readSection(agent, note.id, "Retry policy");
    expect(knowledgeIdIn(restored.markdown)).toBe(knowledgeId);
    expect(restored.markdown).toContain(`\nwhen: ${WHEN}\n`);
  } finally {
    await closeAgent(agent);
    await context.close();
  }
});
