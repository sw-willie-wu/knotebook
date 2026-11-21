import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createUserViaInvite, editorLocator, loginAs, randomEmail, reEscape } from "./helpers.js";

/** Shared by the knowledge-info specs (66, 67): accounts, note setup through the API, and the form driven the way a person drives it. */

export const RUN = Date.now();
export const PASSWORD = "e2e-knowledge-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;

export interface Account {
  email: string;
  displayName: string;
}

export async function createAccount(browser: Browser, name: string): Promise<Account> {
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

export async function openAs(
  browser: Browser,
  account: Account,
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return { context, page };
}

/** After a full page load of a note page, wait for the title box first: the lazy note page's fallback shell replaces the sidebar and resets the drawer. */
export async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
}

export async function apiCreateNote(page: Page, title: string, content: string): Promise<{ id: string; path: string }> {
  const created = await page.request.post("/api/notes", { data: { title, content } });
  expect(created.status(), await created.text()).toBe(201);
  const note = (await created.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

/** Opens a note by path and waits until the title box has the note's title; an editable note also waits for the editor. */
export async function openNote(page: Page, note: { path: string }, title: string, editable = true): Promise<void> {
  await page.goto(note.path);
  await waitForNoteTitle(page, title);
  if (editable) await expect(editorLocator(page)).toBeVisible({ timeout: 15_000 });
}

export function headingLine(page: Page, text: string): Locator {
  return editorLocator(page).getByText(text, { exact: true });
}

/** The `.bn-block-outer` whose own text is exactly `text`. */
export function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

export function iconsIn(scope: Page | Locator): Locator {
  return scope.getByRole("button", { name: /^Knowledge info: / });
}

export function iconOf(scope: Page | Locator, status: "Verified" | "Not verified" | "Needs review" | "Outdated"): Locator {
  return scope.getByRole("button", { name: `Knowledge info: ${status}`, exact: true });
}

/** Finds a block by id, which stays the same while its text is being typed. */
export function outerById(page: Page, blockId: string): Locator {
  return editorLocator(page).locator(`.bn-block-outer[data-id="${blockId}"]`);
}

export async function blockIdOfHeading(page: Page, text: string): Promise<string> {
  const id = await blockOuter(page, text).getAttribute("data-id");
  expect(id).toBeTruthy();
  return id!;
}

export function iconForBlock(page: Page, blockId: string): Locator {
  return page.locator(`[data-kb-knowledge-icon][data-block-id="${blockId}"]`);
}

export function formOf(page: Page): Locator {
  return page.locator("[data-kb-knowledge-form]");
}

export function hoverCardOf(page: Page): Locator {
  return page.locator('[data-kb-knowledge-card="hover"]');
}

export interface KnowledgeFields {
  when?: string;
  conclusion?: string;
  status?: "Needs review" | "Outdated";
  replacedBy?: string;
  verifiedToday?: boolean;
}

/** Local calendar date as the browser sees it, in the format the form stores. */
export async function localToday(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
}

export async function fillForm(page: Page, fields: KnowledgeFields): Promise<void> {
  const form = formOf(page);
  if (fields.when !== undefined) await form.getByLabel("When to read", { exact: true }).fill(fields.when);
  if (fields.conclusion !== undefined) await form.getByLabel("Conclusion", { exact: true }).fill(fields.conclusion);
  if (fields.status) await form.getByRole("radio", { name: fields.status, exact: true }).click();
  if (fields.replacedBy !== undefined) {
    await form.getByRole("combobox", { name: "Replaced by" }).click();
    await form.getByRole("option", { name: new RegExp(`^${reEscape(fields.replacedBy)}`) }).click();
  }
  if (fields.verifiedToday) await form.getByRole("button", { name: "Mark verified today", exact: true }).click();
}

export async function saveForm(page: Page): Promise<void> {
  const form = formOf(page);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toBeHidden();
}

/** Types `/info` at the end of a heading and picks the item, which opens the form for that heading. */
export async function openFormFromSlash(page: Page, headingText: string): Promise<void> {
  await clickEndOfParagraph(page, headingLine(page, headingText));
  await page.keyboard.type("/info");
  const item = page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title", { hasText: /^Knowledge info$/ });
  await expect(item).toBeVisible();
  await item.click();
  await expect(formOf(page)).toBeVisible();
  // The slash text is gone once the item ran; the heading must read as before.
  await expect(headingLine(page, headingText)).toBeVisible();
}

/** Makes a plain heading knowledge through `/info`, the way a person would. */
export async function makeKnowledge(page: Page, headingText: string, fields: KnowledgeFields): Promise<void> {
  await openFormFromSlash(page, headingText);
  await fillForm(page, fields);
  await saveForm(page);
}
