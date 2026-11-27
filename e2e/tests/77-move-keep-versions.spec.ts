import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail } from "./helpers.js";

/**
 * Moving a personal note into a group brings its version history along when the dialog's box is checked and
 * clears it when the box is left unchecked (the default). A fresh user creates the group, so they are its admin and can open the group note's
 * versions. Versions are saved by hand (Ctrl+S): automatic saving waits minutes and is covered by server integration tests.
 */

const PASSWORD = "e2e-second-user-pw";
const KEEP_BOX = "Bring its version history and comments along";

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Creates a personal note, types a sentence and saves a named version; returns the note id. */
async function personalNoteWithVersion(page: Page, title: string, versionName: string): Promise<string> {
  await createNote(page, title);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially(`content of ${title}`);
  await saveVersion(page, versionName);
  await expect(page.getByText(new RegExp(`^Saved as ${versionName} \\([0-9a-f]{7}\\)$`))).toBeVisible();
  return noteIdFromUrl(page);
}

/** With the note's more menu: Move to… -> the group, then submit the confirmation, checking the keep-history box only when asked. */
async function moveToGroup(page: Page, groupName: string, keepHistory: boolean): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).click();
  const target = page.getByRole("menuitem", { name: groupName, exact: true });
  await expect(target).toBeVisible();
  // Move in steps like a pointer would, so the submenu stays open (see spec 16's pickFromSubmenu).
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 });
  await target.click();
  const confirm = page.getByRole("dialog").filter({ hasText: `Move this note into "${groupName}"?` });
  const keep = confirm.getByRole("checkbox", { name: KEEP_BOX });
  await expect(keep).not.toBeChecked();
  if (keepHistory) {
    await keep.check();
    await expect(keep).toBeChecked();
  } else {
    await expect(confirm).toContainText("Its version history and comments are cleared and don't come back.");
  }
  await confirm.getByRole("button", { name: "Move into group", exact: true }).click();
  await expect(page).toHaveURL(/\/g\/[0-9a-f-]{36}\//, { timeout: 15_000 });
}

async function openVersionsPanel(page: Page) {
  await page.reload();
  await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("versions-bubble").click();
  const panel = page.getByTestId("versions-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("77 moving a note into a group keeps its versions when the box is checked and clears them when it is left unchecked", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const groupName = `E2E keep versions ${Date.now()}`;
  let groupId: string | null = null;
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const email = randomEmail();
    await createUserViaInvite(adminPage, { email, password: PASSWORD, displayName: "E2E Mover" });

    const page = await userContext.newPage();
    await loginAs(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    const created = await page.request.post("/api/groups", { data: { name: groupName } });
    expect(created.status(), await created.text()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    // The sidebar loaded before the group existed; reload so the move menu lists it.
    await page.reload();
    await expect(page).toHaveURL(/\/$/);

    const stamp = Date.now();
    const keptId = await personalNoteWithVersion(page, `E2E keep ${stamp}`, "kept-milestone");
    await moveToGroup(page, groupName, true);
    const keptPanel = await openVersionsPanel(page);
    await expect(keptPanel.getByRole("button", { name: /^kept-milestone \(/ })).toBeVisible({ timeout: 15_000 });
    const keptList = await page.request.get(`/api/notes/${keptId}/versions?limit=100`);
    expect(keptList.status()).toBe(200);
    expect(((await keptList.json()) as { versions: Array<{ name: string | null }> }).versions.map((v) => v.name)).toContain("kept-milestone");

    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    const clearedId = await personalNoteWithVersion(page, `E2E clear ${stamp}`, "cleared-milestone");
    await moveToGroup(page, groupName, false);
    const clearedList = await page.request.get(`/api/notes/${clearedId}/versions?limit=100`);
    expect(clearedList.status()).toBe(200);
    expect(((await clearedList.json()) as { versions: unknown[] }).versions).toHaveLength(0);
  } finally {
    if (groupId !== null) {
      // Group delete in full-delete mode also removes the notes; a failure here must not hide the test's own error.
      try {
        await userContext.request.delete(`/api/groups/${encodeURIComponent(groupId)}`, { data: { mode: "delete" } });
      } catch {
        // ignore
      }
    }
    await userContext.close();
    await adminContext.close();
  }
});
