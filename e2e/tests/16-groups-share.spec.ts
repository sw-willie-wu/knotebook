import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * #103 PR3（spec §11.3 第 2 條）：A 有一篇逐人分享給 C、且開了公開連結的個人筆記 → 從分享面板的
 * 「所屬群組」列搬進群組（確認文案列出 C 與「撤銷公開連結」）→ C 被踢、公開網址 404 → 分享面板
 * 變兩態 → A 把 B 加進群組 → B 可編輯 → A 改唯讀 → B 留在該頁、編輯器變唯讀 → A 移出群組 → B 被踢、
 * 該篇從 B 的側欄消失。斷言形沿用 03（10 秒 SLA、exact toast）與 11（公開端點 toPass 輪詢）。
 * 「B 留在該頁」只斷言網址與編輯器狀態：分不出「沒斷線」與「斷線後又重連」，所以這支不宣稱前者。
 * 結束時（含失敗）刪掉這支建的群組，不讓 admin 留在 `E2E Move Group …` 裡。
 */

const TEMP_PASSWORD = "e2e-second-user-temp-pw";
const NEW_PASSWORD = "e2e-second-user-pw-2";

/** admin 在站台管理 → 使用者建一個帳號（同 03／15）。呼叫前後都停在 "/"。 */
async function createUser(adminPage: Page, email: string, displayName: string): Promise<void> {
  await adminPage.getByRole("button", { name: "admin", exact: true }).click();
  await adminPage.getByRole("menuitem", { name: "Site admin", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/admin\/users$/);
  await adminPage.getByRole("button", { name: "Create user" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Create user" });
  await dialog.locator("#admin-create-email").fill(email);
  await dialog.locator("#admin-create-password").fill(TEMP_PASSWORD);
  await dialog.locator("#admin-create-display-name").fill(displayName);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await adminPage.getByRole("link", { name: "Back to notes", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/$/);
}

/**
 * 刪掉名為 `name` 的群組（final review T5-M4）。走 API 而不是 15 的 UI 路徑（側欄 ⋮ → Delete group）：
 * 這段在 `finally` 裡跑，失敗時頁面可能停在任何狀態（分享面板開著、確認列懸掛），UI 步驟不可靠。
 * `context.request` 帶該 context 的 session cookie。回傳是否找到並刪掉。
 */
async function deleteGroupNamed(context: BrowserContext, name: string): Promise<boolean> {
  const list = await context.request.get("/api/groups");
  expect(list.status()).toBe(200);
  const group = ((await list.json()) as Array<{ id: string; name: string }>).find((g) => g.name === name);
  if (!group) return false;
  expect((await context.request.delete(`/api/groups/${encodeURIComponent(group.id)}`)).status()).toBe(204);
  return true;
}

/** 新 context 首登強改密，停在 "/"（同 03／15）。 */
async function firstLogin(browser: Browser, email: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, TEMP_PASSWORD);
  await expect(page).toHaveURL(/\/change-password$/);
  await page.locator("#change-password-current").fill(TEMP_PASSWORD);
  await page.locator("#change-password-new").fill(NEW_PASSWORD);
  await page.locator("#change-password-confirm").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page).toHaveURL(/\/$/);
  return { page, close: () => context.close() };
}

test("所屬群組：個人筆記搬進群組（清逐人分享與公開連結）→ 兩態 → 改唯讀 → 移出群組", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const closers: Array<() => Promise<void>> = [];
  const groupName = `E2E Move Group ${Date.now()}`;
  let passed = false;
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.newPassword);
    await expect(adminPage).toHaveURL(/\/$/);

    const memberEmail = randomEmail(); // B：之後加進群組
    const guestEmail = randomEmail(); // C：個人筆記的逐人分享對象
    await createUser(adminPage, memberEmail, "E2E Group Member");
    await createUser(adminPage, guestEmail, "E2E Share Guest");

    // ── A：建群組（側欄工作坊「＋」）──────────────────────────────────
    const sidebar = adminPage.getByRole("complementary");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    // ── A：個人筆記 → 分享給 C（Members only）→ 開公開連結、記下 token ─────────
    const title = `E2E move note ${Date.now()}`;
    await createNote(adminPage, title);
    const noteUrl = adminPage.url();
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();
    await shareDialog.getByLabel("Email address").fill(guestEmail);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByText(guestEmail)).toBeVisible();
    await shareDialog.getByRole("radio", { name: /^Public link/ }).click();
    const urlInput = shareDialog.getByLabel("Public link URL");
    await expect(urlInput).toBeVisible();
    const token = await urlInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(async () => {
      expect((await request.get(`/api/public/notes/${token}`)).status()).toBe(200);
    }).toPass({ timeout: 10_000 });
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    // ── C：首登、打開那篇、等共編連上（viewer）──────────────────────────
    const guest = await firstLogin(browser, guestEmail);
    closers.push(guest.close);
    await guest.page.goto(noteUrl);
    await expect(guest.page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

    // ── A：所屬群組列選群組 → 確認列出 C 與撤銷公開連結 → 移入 ──────────────
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    await shareDialog.getByRole("combobox", { name: "Group this note belongs to" }).selectOption({ label: groupName });
    const confirm = shareDialog.getByRole("alert").filter({ hasText: "will be able to open and edit this note" });
    await expect(confirm).toContainText(guestEmail);
    await expect(confirm).toContainText("The public link will be turned off");
    await confirm.getByRole("button", { name: "Move to group", exact: true }).click();
    await expect(confirm).toHaveCount(0);

    // ── C：≤10 秒被踢回 "/"；公開網址 404 ────────────────────────────────
    await expect(guest.page.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(guest.page).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(async () => {
      expect((await request.get(`/api/public/notes/${token}`)).status()).toBe(404);
    }).toPass({ timeout: 10_000 });

    // ── A：分享面板變兩態；把 B 加進群組 ──────────────────────────────────
    await expect(shareDialog.getByRole("radio", { name: /Group members/ })).toBeChecked();
    await expect(shareDialog.getByRole("radio", { name: /Private/ })).toHaveCount(0);
    await expect(shareDialog.getByLabel("Public link URL")).toHaveCount(0);
    await shareDialog.getByLabel("Email address").fill(memberEmail);
    await shareDialog.getByRole("button", { name: "Add to group", exact: true }).click();
    await expect(shareDialog.getByText(memberEmail)).toBeVisible();
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    // ── B：首登 → 工作坊段看得到那篇 → 可編輯 ─────────────────────────────
    const member = await firstLogin(browser, memberEmail);
    closers.push(member.close);
    const memberSidebar = member.page.getByRole("complementary");
    await memberSidebar.getByTestId("notegroup-workspace").getByRole("link", { name: title }).click({ timeout: 15_000 });
    await expect(member.page).toHaveURL(noteUrl);
    const memberBadge = member.page.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(memberBadge).toBeVisible({ timeout: 15_000 });
    await expect(memberBadge.getByText("Editor", { exact: true })).toBeVisible();
    await expect(editorLocator(member.page)).toBeVisible();

    // ── A：改唯讀 → B 留在該頁、編輯器變唯讀 ─────────────────────────────
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    const levelSelect = shareDialog.getByRole("combobox", { name: "What group members can do" });
    await levelSelect.selectOption("viewer");
    await expect(levelSelect).toHaveValue("viewer");
    await expect(member.page.getByText("Your access changed to viewer. This note is now read-only.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(memberBadge.getByText("Viewer", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(member.page.locator('[data-testid="note-editor"] [contenteditable="true"]')).toHaveCount(0);
    await expect(member.page).toHaveURL(noteUrl);

    // ── A：移出群組（選 None → 確認）→ B 被踢、該篇從側欄消失 ─────────────────
    await shareDialog.getByRole("combobox", { name: "Group this note belongs to" }).selectOption({ label: "None — personal note" });
    const leave = shareDialog.getByRole("alert").filter({ hasText: "will lose access to this note" });
    await leave.getByRole("button", { name: "Remove from group", exact: true }).click();
    await expect(leave).toHaveCount(0);
    await expect(shareDialog.getByRole("radio", { name: /Private/ })).toBeVisible();

    await expect(member.page.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(member.page).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(memberSidebar.getByRole("link", { name: title })).toHaveCount(0, { timeout: 10_000 });
    passed = true;
  } finally {
    // 清理不得蓋掉真正的失敗：主體已失敗時清理的錯誤吞掉（`finally` 裡再 throw 會取代原本的錯誤）；
    // 主體通過時清理失敗照常讓測試紅——群組必須找得到、刪得掉。
    try {
      const deleted = await deleteGroupNamed(adminContext, groupName);
      if (passed) expect(deleted).toBe(true);
    } catch (err) {
      if (passed) throw err;
    } finally {
      for (const close of closers) await close();
      await adminContext.close();
    }
  }
});
