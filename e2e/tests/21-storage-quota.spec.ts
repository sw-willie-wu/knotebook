import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * 儲存配額 E1（spec §11.6）：管理員在 Site admin → Storage plans 建一個 1 MB 方案、在 Site admin → Users 指派給新建的
 * 測試使用者 → 該使用者在自己的筆記貼一張 > 1 MB 的圖 → toast「Storage is full」＋用量句（自己的個人空間看得到數字）。
 * `finally` 以 API 把使用者指回新使用者的預設方案（e2e 疊上就是 Basic）並刪掉 1 MB 方案。
 *
 * - 貼上走合成 `ClipboardEvent("paste")`＋真的 `DataTransfer`：toast 是 `createUploadFile`（貼上／拖放那條）的行為，
 *   FilePanel 的 Upload tab 走的是行內錯誤，不是本案要驗的出口。
 * - 檔案是 1,100,000 bytes 的「PNG」：只有 8 bytes PNG 簽名＋零填充——server 只看 magic bytes（`uploads/magic-bytes.ts`），
 *   瀏覽器端也不解碼；> 1 MiB（1,048,576）才放不下 1 MB 方案。
 * - 用量句的數字是 RF1 的端到端守衛：`NoteEditor` 的 late-bound translate 若丟掉插值參數，這裡會看到 `{{used}}`。
 * - 名稱與 email 隨機化：腳本失敗時不 down 疊，重跑會吃到髒資料（[[knotebook-local-workflow]]）。
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

test("21 儲存配額 E1：1 MB 方案指派給使用者 → 貼 > 1 MB 圖 → toast「Storage is full」＋用量", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const userEmail = randomEmail();
  const tempPassword = "e2e-quota-temp-pw";
  try {
    // ── admin：建使用者（同 15-groups）──────────────────────────────
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/admin\/users$/);
    await adminPage.getByRole("button", { name: "Create user" }).click();
    const createUser = adminPage.getByRole("dialog", { name: "Create user" });
    await createUser.locator("#admin-create-email").fill(userEmail);
    await createUser.locator("#admin-create-password").fill(tempPassword);
    await createUser.locator("#admin-create-display-name").fill("E2E Quota User");
    await createUser.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createUser).not.toBeVisible();

    // ── admin：建 1 MB 方案 ────────────────────────────────────────
    const nav = adminPage.getByRole("navigation", { name: "Site admin" });
    await nav.getByRole("link", { name: "Storage plans" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/storage$/);
    await adminPage.getByRole("button", { name: "New plan" }).click();
    const planDialog = adminPage.getByRole("dialog", { name: "New storage plan" });
    await planDialog.getByLabel("Name", { exact: true }).fill(PLAN_NAME);
    await planDialog.getByLabel("Limit", { exact: true }).fill("1");
    await planDialog.getByLabel("Unit", { exact: true }).selectOption("MB");
    await planDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(planDialog).not.toBeVisible();
    await expect(adminPage.getByRole("row").filter({ hasText: PLAN_NAME })).toContainText("1 MB");

    // ── admin：在使用者表指派 ──────────────────────────────────────
    await nav.getByRole("link", { name: "Users" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/users$/);
    const planSelect = adminPage.getByLabel(`Storage plan for ${userEmail}`, { exact: true });
    const assigned = adminPage.waitForResponse((r) => r.url().endsWith("/storage-plan") && r.request().method() === "PATCH");
    await planSelect.selectOption({ label: PLAN_NAME });
    expect((await assigned).status()).toBe(200);
    await expect(planSelect.locator("option:checked")).toHaveText(PLAN_NAME);

    // ── 使用者：首登改密 → 自己的筆記 → 貼 > 1 MB 圖 ─────────────────
    const userPage = await userContext.newPage();
    await loginAs(userPage, userEmail, tempPassword);
    await expect(userPage).toHaveURL(/\/change-password$/);
    const newPassword = "e2e-quota-user-pw-2";
    await userPage.locator("#change-password-current").fill(tempPassword);
    await userPage.locator("#change-password-new").fill(newPassword);
    await userPage.locator("#change-password-confirm").fill(newPassword);
    await userPage.getByRole("button", { name: "Change password" }).click();
    await expect(userPage).toHaveURL(/\/$/);
    await createNote(userPage, `E2E quota ${Date.now()}`);

    const upload = userPage.waitForResponse((r) => /\/api\/notes\/[^/]+\/uploads$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await pasteFakePng(userPage, BIG_FILE_BYTES);
    expect((await upload).status()).toBe(409);
    await expect(userPage.getByText("Storage is full", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(userPage.getByText("0 B of 1 MB used. Ask a site admin for more space.", { exact: true })).toBeVisible();
  } finally {
    // 指回預設方案、刪掉 1 MB 方案（API；不經 UI，讓清理不受畫面狀態影響）。清理**絕不 throw**（review m3）：
    // 在 finally 裡 throw 會蓋掉主體的原始失敗，Playwright 只會回報清理的錯——每一步先看 res.ok()，失敗只 console.warn。
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
