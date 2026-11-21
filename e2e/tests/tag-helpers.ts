import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail, reEscape } from "./helpers.js";

/** Shared by the tag specs (`65-tags`, `72-tag-shortcuts`): accounts, API setup and the locators of the tag row. */

export const RUN = Date.now();
export const PASSWORD = "e2e-tags-user-pw";
export const NOTE_TITLE = { name: "Note title" } as const;

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

export async function openAs(browser: Browser, account: Account, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return { context, page };
}

export function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

export function tagRow(page: Page): Locator {
  return page.getByRole("group", { name: "Tags", exact: true });
}

export function tagInput(page: Page): Locator {
  return page.getByRole("combobox", { name: "Tag name", exact: true });
}

export function dots(scope: Locator, names: string): Locator {
  return scope.getByRole("img", { name: `Tags: ${names}`, exact: true });
}

/** After a full page load of a note page, wait for the title box first: the lazy note page's fallback shell replaces the sidebar and resets the drawer. */
export async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
}

export async function apiCreateNote(page: Page, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await page.request.post("/api/notes", { data: { title, ...extra } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

export async function apiAddTags(page: Page, noteId: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const added = await page.request.post(`/api/notes/${noteId}/tags`, { data: { name } });
    expect(added.status(), await added.text()).toBe(200);
  }
}

export async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const created = await page.request.post("/api/groups", { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}
