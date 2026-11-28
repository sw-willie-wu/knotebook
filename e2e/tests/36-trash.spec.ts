import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import {
  ADMIN,
  chooseSelectOption,
  createNote,
  createUserViaInvite,
  editorLocator,
  expectWidePointer,
  loginAs,
  moveNoteToTrashFromSidebar,
  noteIdFromUrl,
  openGroupPanel,
  openListOnCompact,
  randomEmail,
  reEscape,
  showSidebarTab,
  solidPng,
  toastWithTitle,
} from "./helpers.js";

/**
 * The select-mode test (Shift range-select) also runs in the wide form; the accessible names of Restore / Delete permanently are the
 * same in both forms.
 * The stack is shared: other specs (e.g. 16) leave items in admin's trash, so totals are not asserted and rows are always
 * located by this file's titles (carrying RUN).
 * Groups and notes are left in place (as in 17): the e2e stack is reset by `stack:down -v` each time.
 */
const RUN = Date.now();
const PASSWORD = "e2e-trash-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const TRASH_HEADER = /^Trash · \d+ notes?$/;
/** ceil, minimum 1: there is no "less than 1 day". */
const DAYS_LEFT = /^\d+ days? left$/;
const LINK_INVALID = "This link is invalid or the note doesn't exist.";
/**
 * "Link invalid" is decided by a 404 from the resolution layer: react-query retries 3 times by default (backoff 1+2+4
 * seconds), so it turns to error and the toast appears after about 7 seconds (same as in 18). The "in the trash" card is not in
 * this class: the resolution layer's `in_trash` is not retried and the card appears immediately.
 */
const LINK_INVALID_TIMEOUT = 15_000;
const NO_UNDO_HINT = "Members of the group whose role can both edit and delete notes can restore it.";
const DELETE_WITHOUT_EDIT_HINT = "Without Edit, notes deleted with this role can't be restored from the trash by its holders.";

function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** Clicks the Trash tab and waits for the list header ("Trash · N notes", shown for 0 too), so negative assertions after it are safe; returns the tabpanel. */
async function openTrash(page: Page, scope?: Locator): Promise<Locator> {
  const panel = await showSidebarTab(page, "Trash", scope);
  await expect(panel.getByText(TRASH_HEADER)).toBeVisible({ timeout: 15_000 });
  return panel;
}

function trashRow(panel: Locator, title: string, section?: "My notes" | "Groups"): Locator {
  const root = section ? panel.getByRole("list", { name: section, exact: true }) : panel;
  return root.getByRole("listitem").filter({ hasText: title });
}

function trashCheckbox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

test("move to trash from the header more menu without confirmation, toast Undo returns to the note co-editable; moving in again from the sidebar more menu -> personal section of the Trash tab, N days left, footer days", async ({ page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Keep ${RUN}`;
  const title = `E2E Trash A ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, keep); // not moved in: the positive anchor for the later negative assertion
  await createNote(page, title);
  const noteUrl = page.url();
  const noteId = await noteIdFromUrl(page);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const moved = toastWithTitle(page, "Moved to the trash");
  await expect(moved).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(noteUrl, { timeout: 15_000 });
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
  const badge = page.getByRole("status").filter({ hasText: /^Connected/ });
  await expect(badge).toBeVisible({ timeout: 15_000 });
  const word = `undone${RUN}`;
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially(word);
  await expect(editor).toContainText(word);
  await expect(badge).toBeVisible();

  const sidebar = page.getByRole("complementary");
  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const panel = await openTrash(page);
  const row = trashRow(panel, title, "My notes");
  await expect(row).toBeVisible();
  await expect(row.getByText(DAYS_LEFT)).toBeVisible();
  await expect(row.getByRole("link")).toHaveAttribute("href", `/trash/${noteId}`);
  await expect(sidebar.getByTestId("trash-footer")).toHaveText(/Permanently deleted \d+ days? after deletion|isn't emptied automatically/);

  // My notes does not have it: a tab renders one list at a time, so wait for the positive anchor (the keep note created in this test) before the negative assertion
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(myNotes, title)).toHaveCount(0);
});

test("public link is 404 while in the trash and works again after restoring from the trash row", async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  const title = `E2E Trash P ${RUN}`;
  // Use a new account as owner: PUT/DELETE of public-link allow 10 per user per 10 minutes (PUBLIC_LINK_LIMIT); in a serial run
  // admin has been used up by earlier specs by now and opening another public link would get a 429 (as in 31).
  const owner = { email: randomEmail(), password: PASSWORD };
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, owner);
  } finally {
    await adminContext.close();
  }
  await loginAs(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);

  await page.getByRole("button", { name: "Share", exact: true }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share note" });
  const publicRadio = shareDialog.getByRole("radio", { name: /^Public link/ });
  await expect(publicRadio).toBeEnabled();
  const publish = page.waitForResponse((res) => res.url().endsWith("/public-link") && res.request().method() === "PUT");
  await publicRadio.check();
  expect((await publish).status()).toBe(200);
  const urlInput = shareDialog.getByLabel("Public link URL");
  await expect(urlInput).toBeVisible();
  const token = await urlInput.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The `request` fixture carries no page cookie = anonymous
  const publicStatus = async (): Promise<number> => (await request.get(`/api/public/notes/${token}`)).status();
  await expect(async () => {
    expect(await publicStatus()).toBe(200);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(shareDialog).not.toBeVisible();

  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(async () => {
    expect(await publicStatus()).toBe(404);
  }).toPass({ timeout: 10_000 });

  const panel = await openTrash(page);
  const row = trashRow(panel, title, "My notes");
  await row.hover();
  await row.getByRole("button", { name: `Restore ${title}`, exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveCount(0);
  await expect(async () => {
    expect(await publicStatus()).toBe(200);
  }).toPass({ timeout: 10_000 });
});

test("select mode - Shift range-select three notes and restore; tick two and delete permanently (confirmation dialog), after which the original URL link is invalid", async ({ page }) => {
  test.setTimeout(150_000);
  const [s1, s2, s3] = [1, 2, 3].map((i) => `E2E Trash S${i} ${RUN}`) as [string, string, string];
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const urls: string[] = [];
  for (const title of [s1, s2, s3]) {
    await createNote(page, title);
    urls.push(page.url());
  }
  await showSidebarTab(page, "My notes");
  // Move in one by one: the list newest first is S3, S2, S1 (no other moves in between, so the three rows are adjacent). S3 is the open note, so after moving it goes home.
  for (const title of [s1, s2, s3]) await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  const sidebar = page.getByRole("complementary");
  let panel = await openTrash(page);
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, s3).click();
  await trashRow(panel, s1).click({ modifiers: ["Shift"] });
  await expect(panel.getByText("3 selected", { exact: true })).toBeVisible();
  for (const title of [s1, s2, s3]) await expect(trashCheckbox(panel, title)).toBeChecked();
  await sidebar.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 3 notes")).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  const myNotes = await showSidebarTab(page, "My notes");
  for (const title of [s1, s2, s3]) await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });

  for (const title of [s1, s2]) await moveNoteToTrashFromSidebar(page, title);
  panel = await openTrash(page);
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, s1).click();
  await trashRow(panel, s2).click();
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Delete permanently", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Permanently delete 2 notes?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(toastWithTitle(page, "Permanently deleted 2 notes")).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  await expect(trashRow(panel, s1)).toHaveCount(0);
  await expect(trashRow(panel, s2)).toHaveCount(0);

  await page.goto(urls[0]!);
  await expect(page.getByText(LINK_INVALID, { exact: true })).toBeVisible({ timeout: LINK_INVALID_TIMEOUT });
  await expect(page).toHaveURL(/\/$/);
});

test("700-wide drawer: Esc during selection only ends selection and focus returns to the \"Select\" button in the drawer; Esc on the confirmation dialog only closes it", async ({ page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Drawer Keep ${RUN}`;
  const title = `E2E Trash D ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, keep);
  const keepUrl = page.url();
  await createNote(page, title);
  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.setViewportSize({ width: 700, height: 844 });
  // Full page load (also clears the toast so it does not cover the bottom of the drawer); wait for the lazy NotePage to mount: the fallback's own AppShell is replaced (and the drawer closes with it).
  await page.goto(keepUrl);
  await expect(page.getByRole("textbox", NOTE_TITLE)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const panel = await openTrash(page, drawer);
  const selectButton = drawer.locator("button[data-sidebar-select]");
  const checkbox = trashCheckbox(panel, title);

  await selectButton.click();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(selectButton).toBeFocused();

  await selectButton.click();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  const purgeButton = drawer.getByRole("button", { name: "Delete permanently", exact: true });
  await purgeButton.click();
  const confirm = page.getByRole("dialog", { name: "Permanently delete 1 note?" });
  // Cancel gets focus in the same round the confirmation dialog's DismissableLayer registers, but the drawer's Esc listener is removed
  // only on the next render (Radix layer reordering), and that same render sets the drawer to pointer-events: none - wait for it before pressing Esc, otherwise the drawer handles Esc and ends selection.
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(page.locator("[data-sidebar-drawer]")).toHaveCSS("pointer-events", "none");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(purgeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(selectButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("moving another note in while the 700-wide drawer is open: toast and Undo are found by role, pressing Undo does not close the drawer, and the note returns to the list", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Toast Keep ${RUN}`;
  const title = `E2E Trash Toast ${RUN}`;
  const user = { email: randomEmail(), password: PASSWORD };
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, user);
  } finally {
    await adminContext.close();
  }
  await loginAs(page, user.email, user.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);
  await createNote(page, keep);
  const keepUrl = page.url();

  await page.setViewportSize({ width: 700, height: 844 });
  // Full page load, then wait for the lazy NotePage to mount before opening the drawer: the fallback's own AppShell is replaced (and the drawer closes with it).
  await page.goto(keepUrl);
  await expect(page.getByRole("textbox", NOTE_TITLE)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  await showSidebarTab(page, "My notes", drawer);

  // While the drawer is open the background is aria-hidden, so the toast is moved into the drawer; the helper finds it by role.
  const moved = await moveNoteToTrashFromSidebar(page, title, drawer);
  await expect(drawer).toBeVisible();
  // Reachable by keyboard: F8 hands focus to the toast region and the drawer's focus trap does not pull it back (before the fix the toast region was outside the drawer and focus was pulled back into it).
  await page.keyboard.press("F8");
  await expect(page.getByRole("region", { name: /^Notifications/ }).getByRole("list")).toBeFocused();
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(keepUrl);
  const myNotes = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });
});

test("wide screen (1280) trash select toolbar: close button focused and no footer note; select-all box half -> full; header \"Restore\" icon -> toast, focus back to \"Select\"", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const [w1, w2] = [1, 2].map((i) => `E2E Trash Wide${i} ${RUN}`) as [string, string];
  // One note stays in the trash: after restoring the trash is not empty and "Select" can still be pressed (with an empty trash it is disabled and focus cannot be handed over).
  const stay = `E2E Trash Wide Stay ${RUN}`;
  // New user: the trash holds only this case's three notes, so the select-all box's tri-state is not affected by items other specs left in admin's trash.
  const user = { email: randomEmail(), password: PASSWORD };
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, user);
  } finally {
    await adminContext.close();
  }
  await loginAs(page, user.email, user.password);
  await expect(page).toHaveURL(/\/$/);
  // Create through the API (no content, so the write throttle is not hit), then goto("/") so the sidebar refetches.
  for (const title of [stay, w1, w2]) {
    const res = await page.request.post("/api/notes", { data: { title } });
    expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  }
  await page.goto("/");
  await expectWidePointer(page, true);
  const sidebar = page.getByRole("complementary");
  const myNotes = await showSidebarTab(page, "My notes");
  for (const title of [stay, w1, w2]) await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });
  for (const title of [stay, w1, w2]) await moveNoteToTrashFromSidebar(page, title);

  const panel = await openTrash(page);
  for (const title of [stay, w1, w2]) await expect(trashRow(panel, title, "My notes")).toBeVisible();
  const footer = sidebar.getByTestId("trash-footer");
  await expect(footer).toBeVisible();

  const selectButton = panel.getByRole("button", { name: "Select", exact: true });
  await selectButton.click();
  await expect(panel.getByRole("button", { name: "Exit selection", exact: true })).toBeFocused();
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(footer).toHaveCount(0);

  const selectAll = panel.getByRole("checkbox", { name: "Select all", exact: true });
  await expect(selectAll).not.toBeChecked();
  await trashCheckbox(panel, w1).click();
  await expect(trashCheckbox(panel, w1)).toBeChecked();
  await expect(selectAll).toBeChecked({ indeterminate: true });
  await selectAll.click();
  for (const title of [stay, w1, w2]) await expect(trashCheckbox(panel, title)).toBeChecked();
  await expect(selectAll).toBeChecked();
  await expect(panel.getByText("3 selected", { exact: true })).toBeVisible();
  await trashCheckbox(panel, stay).click();
  await expect(trashCheckbox(panel, stay)).not.toBeChecked();
  await expect(selectAll).toBeChecked({ indeterminate: true });
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();

  await panel.locator("[data-sidebar-header]").getByRole("button", { name: "Restore", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 2 notes")).toBeVisible({ timeout: 15_000 });
  await expect(selectButton).toBeFocused();
  await expect(trashRow(panel, stay, "My notes")).toBeVisible();
  for (const title of [w1, w2]) await expect(trashRow(panel, title)).toHaveCount(0);
  await expect(footer).toBeVisible();
});

async function createRole(page: Page, name: string, flags: ReadonlyArray<"Edit" | "Delete">): Promise<void> {
  await page.getByRole("button", { name: "New role", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New role" });
  await dialog.getByLabel("Role name", { exact: true }).fill(name);
  for (const flag of flags) {
    const flagSwitch = dialog.getByRole("switch", { name: flag, exact: true });
    await flagSwitch.click();
    await expect(flagSwitch).toBeChecked();
  }
  const deleteOnly = flags.includes("Delete") && !flags.includes("Edit");
  await expect(dialog.getByText(DELETE_WITHOUT_EDIT_HINT, { exact: true })).toHaveCount(deleteOnly ? 1 : 0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
}

test("a \"delete-only\" member moves a group note in -> no Undo, group trash not visible, original URL invalid; an \"edit + delete\" member restores from the card", async ({ browser }) => {
  test.setTimeout(240_000);
  const groupName = `E2E Trash G ${RUN}`;
  const noteTitle = `E2E Trash GN ${RUN}`;
  const restorer = { email: randomEmail(), displayName: "E2E Trash Restorer" }; // B: edit + delete role
  const deleter = { email: randomEmail(), displayName: "E2E Trash Deleter" }; // C: delete-only role
  const adminContext = await browser.newContext();
  const contexts = [adminContext];
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    for (const user of [restorer, deleter]) await createUserViaInvite(adminPage, { ...user, password: PASSWORD });

    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
    await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const titleInput = adminPage.getByLabel("Note title");
    await titleInput.fill(noteTitle);
    await titleInput.blur();
    await adminPage.waitForURL(
      (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
      { timeout: 15_000 },
    );
    const noteUrl = adminPage.url();
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

    const groupId = await openGroupPanel(adminPage, groupName);
    const membersUrl = adminPage.url();
    const nav = adminPage.getByRole("navigation", { name: groupName, exact: true });
    await nav.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));
    await createRole(adminPage, "EditDelete", ["Edit", "Delete"]);
    await createRole(adminPage, "DeleteOnly", ["Delete"]);
    await nav.getByRole("link", { name: "Members", exact: true }).click();
    await expect(adminPage).toHaveURL(membersUrl);
    for (const [user, role] of [
      [restorer, "EditDelete"],
      [deleter, "DeleteOnly"],
    ] as const) {
      await adminPage.getByLabel("Email address", { exact: true }).fill(user.email);
      await adminPage.getByRole("button", { name: "Add", exact: true }).click();
      await expect(adminPage.getByRole("button", { name: `Remove ${user.email}` })).toBeVisible();
      // Wait for the role to be really saved (PATCH returned) before letting the member log in
      const saved = adminPage.waitForResponse(
        (res) => res.request().method() === "PATCH" && res.url().includes(`/api/groups/${groupId}/members/`),
      );
      await chooseSelectOption(adminPage, adminPage.getByLabel(`Role for ${user.email}`, { exact: true }), role);
      expect((await saved).ok()).toBe(true);
    }
    await adminPage.keyboard.press("Escape");

    const deleterContext = await browser.newContext();
    contexts.push(deleterContext);
    const deleterPage = await deleterContext.newPage();
    await loginAs(deleterPage, deleter.email, PASSWORD);
    await expect(deleterPage).toHaveURL(/\/$/);
    const deleterWorkspace = await showSidebarTab(deleterPage, "Groups");
    await expect(noteLink(deleterWorkspace, noteTitle)).toBeVisible({ timeout: 15_000 });
    const noUndoToast = await moveNoteToTrashFromSidebar(deleterPage, noteTitle);
    await expect(noUndoToast.getByText(NO_UNDO_HINT, { exact: true })).toBeVisible();
    await expect(noUndoToast.getByRole("button", { name: "Undo" })).toHaveCount(0);

    const deleterTrash = await openTrash(deleterPage);
    await expect(trashRow(deleterTrash, noteTitle)).toHaveCount(0);
    // Open the original URL directly: C has no trash permission, gets not_found -> link invalid (default retries; see LINK_INVALID_TIMEOUT)
    await deleterPage.goto(noteUrl);
    await expect(deleterPage.getByText(LINK_INVALID, { exact: true })).toBeVisible({ timeout: LINK_INVALID_TIMEOUT });

    const restorerContext = await browser.newContext();
    contexts.push(restorerContext);
    const restorerPage = await restorerContext.newPage();
    await loginAs(restorerPage, restorer.email, PASSWORD);
    await expect(restorerPage).toHaveURL(/\/$/);
    const restorerTrash = await openTrash(restorerPage);
    const row = trashRow(restorerTrash, noteTitle, "Groups");
    await expect(row).toBeVisible();
    await expect(
      row.getByText(new RegExp(`^${reEscape(groupName)} · Deleted by ${reEscape(deleter.displayName)} · \\d+ days? left$`)),
    ).toBeVisible();
    await restorerPage.goto(noteUrl);
    // The resolution layer's in_trash is not retried: the card appears immediately (no need to wait out the default retries).
    await expect(restorerPage.getByRole("heading", { name: "This note is in the trash", exact: true })).toBeVisible({ timeout: 10_000 });
    await restorerPage.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(restorerPage.getByRole("textbox", NOTE_TITLE)).toHaveValue(noteTitle, { timeout: 15_000 });

    await deleterPage.reload();
    const deleterWorkspaceAgain = await showSidebarTab(deleterPage, "Groups");
    await expect(noteLink(deleterWorkspaceAgain, noteTitle)).toBeVisible({ timeout: 15_000 });
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("phone (390) list: the Trash tab bottom has only the search box (no New note) and the retention note; the action bar is at the bottom of the list while selecting", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `E2E Trash Phone ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);
  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const list = await openListOnCompact(page);
  const panel = await openTrash(page, list);
  const fabs = page.locator("[data-phone-list-fabs]");
  await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeVisible();
  await expect(fabs.getByRole("button", { name: "New note", exact: true })).toHaveCount(0);
  await expect(list.getByText(/^Permanently deleted \d+ days? after deletion$|^The trash isn't emptied automatically$/)).toBeVisible();

  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, title).click();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const restore = list.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toBeVisible();
  await expect(list.getByRole("button", { name: "Delete permanently", exact: true })).toBeVisible();
  const box = (await restore.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(844 - 140);
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
});

async function createTrashedNoteWithImage(
  page: Page,
  title: string,
  bodyText: string,
): Promise<{ id: string; uploadId: string; path: string }> {
  const created = await page.request.post("/api/notes", { headers: { Origin: E2E_ORIGIN }, data: { title } });
  expect(created.status(), await created.text()).toBe(201);
  const note = (await created.json()) as { id: string; slug: string; ownerHandle: string };

  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: E2E_ORIGIN },
    multipart: { file: { name: "preview.png", mimeType: "image/png", buffer: solidPng(120, 80) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { id: uploadId, url } = (await upload.json()) as { id: string; url: string };

  const current = await page.request.get(`/api/notes/${note.id}/content`);
  expect(current.status(), await current.text()).toBe(200);
  const { fingerprint } = (await current.json()) as { fingerprint: string };
  const markdown = `${bodyText}\n\n<figure><img alt="preview" src="${url}" width="120"></figure>`;
  const written = await page.request.post(`/api/notes/${note.id}/edits`, {
    headers: { Origin: E2E_ORIGIN },
    data: { op: "replace_all", markdown, if_match: fingerprint },
  });
  expect(written.status(), await written.text()).toBeLessThan(300);

  const deleted = await page.request.delete(`/api/notes/${note.id}`, { headers: { Origin: E2E_ORIGIN } });
  expect(deleted.status(), await deleted.text()).toBe(204);

  return { id: note.id, uploadId, path: `/n/${note.ownerHandle}/${note.slug}` };
}

test("trash read-only preview: select mode stays on list, direct URL and row click show preview with uploaded image, Restore lands on the restored note", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `E2E Trash Preview ${RUN}`;
  const bodyText = `Trash preview body ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const note = await createTrashedNoteWithImage(page, title, bodyText);

  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await openTrash(page);
  await expect(trashRow(panel, title, "My notes")).toBeVisible();

  // Select mode: clicking a row toggles selection and must not navigate.
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, title).click();
  await expect(trashCheckbox(panel, title)).toBeChecked();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("trash-preview-editor")).toHaveCount(0);
  await panel.getByRole("button", { name: "Exit selection", exact: true }).click();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  // Direct URL to the trashed note shows both the banner and read-only note content.
  await page.goto(note.path);
  await expect(page).toHaveURL(new RegExp(`${reEscape(note.path)}$`));
  await expect(page.getByRole("heading", { name: "This note is in the trash", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({ timeout: 15_000 });
  const directPreview = page.getByTestId("trash-preview-editor");
  await expect(directPreview).toContainText(bodyText, { timeout: 15_000 });
  await expect(directPreview.locator('[contenteditable="true"]')).toHaveCount(0);

  // Clicking the trash row opens /trash/:id and loads the uploaded image via /api/trash/:id/uploads/:uploadId.
  await page.goto("/");
  const trashAgain = await openTrash(page);
  await trashRow(trashAgain, title, "My notes").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/trash/${note.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "This note is in the trash", exact: true })).toBeVisible();
  const preview = page.getByTestId("trash-preview-editor");
  await expect(preview).toContainText(bodyText, { timeout: 15_000 });
  await expect(preview.locator('[contenteditable="true"]')).toHaveCount(0);
  const img = preview.locator('[data-content-type="image"] img').first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveAttribute("src", `/api/trash/${note.id}/uploads/${note.uploadId}`);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);

  // Restoring from the preview lands on the restored note.
  await page.getByTestId("trash-preview-banner").getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${reEscape(note.path)}$`), { timeout: 15_000 });
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
  await expect(editorLocator(page)).toContainText(bodyText, { timeout: 15_000 });
});

test("phone (390) trash preview: tapping a row opens the read-only preview with Back to notes and no horizontal overflow, and Back returns to the list", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `E2E Trash Phone Preview ${RUN}`;
  const bodyText = `Phone preview body ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const note = await createTrashedNoteWithImage(page, title, bodyText);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const list = await openListOnCompact(page);
  const panel = await openTrash(page, list);
  await trashRow(panel, title).getByRole("link").click();

  await expect(page).toHaveURL(new RegExp(`/trash/${note.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "This note is in the trash", exact: true })).toBeVisible();
  await expect(page.getByTestId("trash-preview-editor")).toContainText(bodyText, { timeout: 15_000 });
  const back = page.getByRole("button", { name: "Back to notes", exact: true });
  await expect(back).toBeVisible();
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await back.click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.getByRole("complementary")).toBeVisible({ timeout: 15_000 });
});
