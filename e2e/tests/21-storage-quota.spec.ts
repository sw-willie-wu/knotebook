import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, adminNav, createNote, createUserViaInvite, editorLocator, loginAs, openSiteAdmin, randomEmail } from "./helpers.js";

/**
 * `finally` points the user back to the new-user default plan through the API (Basic on the e2e stack) and deletes the 1 MB plan.
 *
 * - The paste uses a synthetic `ClipboardEvent("paste")` with a real `DataTransfer`: the toast is the behaviour of
 *   `createUploadFile` (the paste/drop path); the FilePanel Upload tab shows an inline error instead, which is not the exit
 *   under test here.
 * - The file is a 1,100,000-byte "PNG": just the 8-byte PNG signature plus zero padding - the server looks only at magic
 *   bytes (`uploads/magic-bytes.ts`) and the browser does not decode it; it must be > 1 MiB (1,048,576) to not fit a 1 MB plan.
 * - The numbers in the usage sentence are an end-to-end guard: if the late-bound translate in `NoteEditor` dropped the
 *   interpolation parameters, `{{used}}` would show here.
 * - Names and emails are randomised: a failed run leaves the stack up and a re-run would otherwise hit dirty data.
 */

const PLAN_NAME = `E2E 1MB ${randomUUID().slice(0, 8)}`;
const BIG_FILE_BYTES = 1_100_000;

async function pasteFakePng(page: Page, size: number): Promise<void> {
  await editorLocator(page).click();
  await page.evaluate((n) => {
    const bytes = new Uint8Array(n);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "e2e-too-big.png", { type: "image/png" }));
    const target = document.querySelector('[data-testid="note-editor"] [contenteditable="true"]');
    if (!target) throw new Error("editor not found");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, size);
}

test("21 storage quota: 1 MB plan assigned to a user -> pasting an image > 1 MB -> \"Storage is full\" toast plus usage", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const userEmail = randomEmail();
  const password = "e2e-quota-user-pw";
  try {
    // admin: create the user by invitation first, and only afterwards open site admin, so the users table has them on its first load
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email: userEmail, password, displayName: "E2E Quota User" });
    await openSiteAdmin(adminPage);

    await adminNav(adminPage, "Storage plans");
    await adminPage.getByRole("button", { name: "New plan" }).click();
    const planDialog = adminPage.getByRole("dialog", { name: "New storage plan" });
    await planDialog.getByLabel("Name", { exact: true }).fill(PLAN_NAME);
    await planDialog.getByLabel("Limit", { exact: true }).fill("1");
    await chooseSelectOption(adminPage, planDialog.getByLabel("Unit", { exact: true }), "MB");
    await planDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(planDialog).not.toBeVisible();
    await expect(adminPage.getByRole("row", { name: PLAN_NAME, exact: true })).toContainText("1 MB");

    await adminNav(adminPage, "Users");
    const planSelect = adminPage.getByLabel(`Storage plan for ${userEmail}`, { exact: true });
    const assigned = adminPage.waitForResponse((r) => r.url().endsWith("/storage-plan") && r.request().method() === "PATCH");
    await chooseSelectOption(adminPage, planSelect, PLAN_NAME);
    expect((await assigned).status()).toBe(200);
    await expect(planSelect.locator("[data-select-text]")).toHaveText(PLAN_NAME);

    const userPage = await userContext.newPage();
    await loginAs(userPage, userEmail, password);
    await expect(userPage).toHaveURL(/\/$/);
    await createNote(userPage, `E2E quota ${Date.now()}`);

    const upload = userPage.waitForResponse((r) => /\/api\/notes\/[^/]+\/uploads$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await pasteFakePng(userPage, BIG_FILE_BYTES);
    expect((await upload).status()).toBe(409);
    await expect(userPage.getByText("Storage is full", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(userPage.getByText("0 B of 1 MB used. Ask a site admin for more space.", { exact: true })).toBeVisible();
  } finally {
    // Point the user back to the default plan and delete the 1 MB plan (API, not the UI, so cleanup does not depend on screen
    // state). Cleanup **must never throw**: a throw in `finally` would replace the body's original failure and Playwright would
    // report only the cleanup error; check res.ok() at every step and on failure only console.warn.
    try {
      const plansRes = await adminPage.request.get("/api/admin/storage-plans");
      const usersRes = await adminPage.request.get("/api/admin/users");
      if (!plansRes.ok() || !usersRes.ok()) {
        console.warn(`[21 cleanup] list failed: plans ${plansRes.status()}, users ${usersRes.status()}`);
      } else {
        const plans = (await plansRes.json()) as { plans: Array<{ id: string; name: string }>; defaults: { userPlanId: string } };
        const users = (await usersRes.json()) as Array<{ id: string; email: string; storage: { planId: string } }>;
        const user = users.find((u) => u.email === userEmail);
        if (user && user.storage.planId !== plans.defaults.userPlanId) {
          const r = await adminPage.request.patch(`/api/admin/users/${user.id}/storage-plan`, { data: { planId: plans.defaults.userPlanId } });
          if (!r.ok()) console.warn(`[21 cleanup] reassign failed: ${r.status()}`);
        }
        const plan = plans.plans.find((p) => p.name === PLAN_NAME);
        if (plan) {
          const r = await adminPage.request.delete(`/api/admin/storage-plans/${plan.id}`);
          if (!r.ok()) console.warn(`[21 cleanup] delete plan failed: ${r.status()}`);
        }
      }
    } catch (err) {
      console.warn("[21 cleanup] threw:", err);
    }
    await adminContext.close();
    await userContext.close();
  }
});

test("21 storage quota: a note with text -> Settings > Storage shows a non-zero \"Notes\" row in \"By type\" that doesn't count toward the limit", async ({ browser }) => {
  test.setTimeout(90_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const page = await userContext.newPage();
  const userEmail = randomEmail();
  const password = "e2e-content-user-pw";
  try {
    // A fresh account, so its noteBytes starts at 0 and the poll below proves this note was counted.
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email: userEmail, password, displayName: "E2E Content User" });

    await loginAs(page, userEmail, password);
    await expect(page).toHaveURL(/\/$/);
    const noteBytes = async () => {
      const res = await page.request.get("/api/storage");
      if (!res.ok()) return -1;
      const body = (await res.json()) as { content?: { noteBytes: number } };
      return body.content?.noteBytes ?? -1;
    };
    expect(await noteBytes()).toBe(0);

    await createNote(page, `E2E content usage ${Date.now()}`);
    await expect(page.getByLabel("Note title")).toBeVisible();
    await editorLocator(page).click();
    await page.keyboard.type("Some note text that takes a little space.");

    // The collaborative state is stored a moment after typing; poll the API instead of sleeping.
    await expect.poll(noteBytes, { timeout: 30_000 }).toBeGreaterThan(0);

    await page.goto("/settings/storage");
    const noteSize = page.getByTestId("by-kind-note");
    await expect(noteSize).toBeVisible({ timeout: 15_000 });
    await expect(noteSize).not.toContainText(/(^|[^\d.])0 B/);
    await expect(page.getByText("Notes don't count toward the storage limit.")).toBeVisible();
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
