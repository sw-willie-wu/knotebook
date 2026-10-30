import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, openGroupPanel, randomEmail } from "./helpers.js";

/**
 * 群組成員批次加入（純前端，逐一呼叫既有的 `PUT /api/groups/:id/members`）：
 * 1. 在加人輸入框一次填三個地址（其中一個沒有帳號）→ 開「Add members」對話框 → 加入 2 人、結果列出「沒有這個帳號」那一個
 *    （那個地址留在輸入框）→ 完成。
 * 2. 「從其他群組匯入」：選另一個群組 → 勾選清單只列不在這裡、也不是自己的人 → 確認 → 同一個對話框換成結果 → 完成 → 名單人數正確。
 * 群組以 API 建（`page.request` 與頁面共用 session cookie），人用邀請建；疊每次 `stack:down -v` 重置，不清。
 */

async function createGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.ok(), `POST /api/groups → HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addMemberViaApi(page: Page, groupId: string, email: string): Promise<void> {
  const res = await page.request.put(`/api/groups/${groupId}/members`, { data: { email } });
  expect(res.ok(), `PUT /api/groups/${groupId}/members → HTTP ${res.status()} ${await res.text()}`).toBe(true);
}

test("群組成員批次加入：貼三個地址（一個沒帳號）→ 加 2 人並列出沒帳號的那個；從其他群組匯入 → 人數正確", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  const password = "e2e-bulk-add-user-pw";
  const [first, second, third] = [randomEmail(), randomEmail(), randomEmail()];
  await createUserViaInvite(page, { email: first, password, displayName: "E2E Bulk One" });
  await createUserViaInvite(page, { email: second, password, displayName: "E2E Bulk Two" });
  await createUserViaInvite(page, { email: third, password, displayName: "E2E Bulk Three" });
  const ghost = randomEmail(); // 沒有這個帳號

  const stamp = Date.now();
  const targetName = `E2E Bulk Target ${stamp}`;
  const sourceName = `E2E Bulk Source ${stamp}`;
  await createGroup(page, targetName);
  const sourceId = await createGroup(page, sourceName);
  // 來源群組：admin（自己）＋ first（之後已在目標群組）＋ third（要被匯入的那個）
  await addMemberViaApi(page, sourceId, first);
  await addMemberViaApi(page, sourceId, third);
  await page.reload();

  // ── 1. 一次填三個地址（逗號＋分號分隔）──────────────────────────────
  await openGroupPanel(page, targetName);
  const dialog = page.getByRole("dialog", { name: targetName });
  await dialog.getByLabel("Email address", { exact: true }).fill(`${first}, ${ghost}; ${second}`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  const addDialog = page.getByRole("dialog", { name: "Add members" });
  await expect(addDialog.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 15_000 });
  await expect(addDialog.locator('[data-outcome="added"]')).toContainText(first);
  await expect(addDialog.locator('[data-outcome="added"]')).toContainText(second);
  await expect(addDialog.locator('[data-outcome="notFound"]')).toContainText("No account with this email (1):");
  await expect(addDialog.locator('[data-outcome="notFound"] li')).toHaveText([ghost]);
  await addDialog.getByRole("button", { name: "Done" }).click();
  await expect(addDialog).not.toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${first}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${second}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(3); // admin＋2
  // 沒有帳號的那個留在輸入框（方便修正）
  await expect(dialog.getByLabel("Email address", { exact: true })).toHaveValue(ghost);

  // ── 2. 從其他群組匯入 ─────────────────────────────────────────
  await dialog.getByRole("button", { name: "Import from another group…" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import members from another group" });
  await expect(importDialog).toBeVisible();
  await importDialog.getByLabel("Group to import from").selectOption({ label: sourceName });
  const list = importDialog.getByRole("list", { name: "People to add" });
  // admin 是自己、first 已在目標群組 → 只剩 third，預設勾選
  await expect(list.getByRole("checkbox")).toHaveCount(1);
  await expect(list.getByRole("checkbox", { name: third })).toBeChecked();
  await importDialog.getByRole("button", { name: "Add 1 person" }).click();

  // 對話框不關：同一個對話框換成結果
  await expect(importDialog.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 15_000 });
  await expect(importDialog.locator('[data-outcome="added"]')).toContainText("Added (1):");
  await expect(importDialog.locator('[data-outcome="added"] li')).toHaveText([third]);
  await importDialog.getByRole("button", { name: "Done" }).click();
  await expect(importDialog).not.toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${third}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(4); // admin＋first＋second＋third
});
