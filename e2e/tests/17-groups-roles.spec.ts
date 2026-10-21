import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/**
 * #175 群組 v2 PR3（spec §12.3 第 17 條）：自訂角色即時生效。
 * A 以邀請建第二使用者 B → A 建群組、在群組建筆記 → A 從群組面板加 B（內建一般成員）→ B 開那篇：徽章 Editor、可編輯 →
 * A 到「Roles」項次新增角色 Reader（對話框沒有 Read 開關、六個旗標預設全關＝只能閱讀）→ A 在「Members」項次把 B 改成
 * Reader → B 10 秒內徽章 Viewer、編輯器不可編輯 → A 改回 Member → B 10 秒內徽章 Editor、打字 A 看得到。
 * 斷言形沿用 15-groups（兩個 context、邀請建第二使用者、`editorLocator`、10 秒 SLA）。
 * 群組與筆記留著不清：e2e 疊每次 `stack:down -v` 重置。
 *
 * 目視用截圖：設了 `PR3_SCREENSHOT_DIR` 才截圖，未設就略過；本檔不寫任何絕對路徑。
 */
test("群組角色：新增自訂角色 → 改成員角色即時變唯讀 → 改回即時可編輯", async ({ browser }) => {
  const shotDir = process.env.PR3_SCREENSHOT_DIR;
  const shot = async (page: Page, name: string): Promise<void> => {
    if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
  };
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 1. A 以邀請建第二使用者 B（同 15）────────────────────────────────────
    const secondEmail = randomEmail();
    const password = "e2e-role-user-pw";
    await createUserViaInvite(adminPage, { email: secondEmail, password, displayName: "E2E Role Member" });

    // ── 2. A 建群組、在群組建筆記、改標題（同 15）──────────────────────────
    const groupName = `E2E Roles ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Workspace");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
    await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const title = `E2E role note ${Date.now()}`;
    const titleInput = adminPage.getByLabel("Note title");
    await titleInput.fill(title);
    await titleInput.blur();
    await adminPage.waitForURL(
      (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
      { timeout: 15_000 },
    );
    const noteUrl = adminPage.url();
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await editorLocator(adminPage).waitFor({ timeout: 15_000 });

    // ── 3. A：側欄群組 ⋮ →「Members & settings」（群組面板）→ 加 B（預設內建一般成員）──
    const groupId = await openGroupPanel(adminPage, groupName);
    const membersUrl = adminPage.url();
    await adminPage.getByLabel("Email address", { exact: true }).fill(secondEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toBeVisible();

    // ── 4. B：登入 → 側欄 Workspace 開那篇 → 徽章 Editor、可編輯 ──────────
    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, password);
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = await showSidebarTab(userPage, "Workspace", userSidebar);
    await expect(userWorkspace.getByRole("button", { name: groupName, exact: true })).toBeVisible({ timeout: 15_000 });
    await userWorkspace.getByRole("link", { name: title }).click();
    await expect(userPage).toHaveURL(noteUrl);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible();
    const userEditable = userPage.locator('[data-testid="note-editor"] [contenteditable="true"]');
    await expect(userEditable).toHaveCount(1, { timeout: 15_000 });
    if (shotDir) {
      // 目視第 11 項的對照組：內建一般成員（能建能改）的群組列有「＋」。
      await userWorkspace.getByRole("button", { name: groupName, exact: true }).hover();
      await shot(userPage, "pr3-sidebar-member-hover.png");
    }

    // ── 5. A：「Roles」項次 → 新增角色 Reader（預設＝只能閱讀）──────────────
    // 群組面板左卡項次的 nav 可及名稱＝面板標題（群組名）。
    const tabs = adminPage.getByRole("navigation", { name: groupName, exact: true });
    await tabs.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));
    await adminPage.getByRole("button", { name: "New role", exact: true }).click();
    const newRoleDialog = adminPage.getByRole("dialog", { name: "New role" });
    await newRoleDialog.getByLabel("Role name", { exact: true }).fill("Reader");
    await expect(newRoleDialog.getByRole("switch", { name: "Read", exact: true })).toHaveCount(0);
    const dialogSwitches = newRoleDialog.getByRole("switch");
    await expect(dialogSwitches).toHaveCount(6);
    for (let i = 0; i < 6; i += 1) await expect(dialogSwitches.nth(i)).not.toBeChecked();
    await newRoleDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(newRoleDialog).not.toBeVisible();
    // 角色卡是以角色名為名的 region；名稱輸入框（「Name of Reader」）只在按鉛筆後才出現。
    await expect(adminPage.getByRole("region", { name: "Reader", exact: true })).toBeVisible();

    // ── 6. A：「Members」項次 → B 改成 Reader ───────────────────────────
    await tabs.getByRole("link", { name: "Members", exact: true }).click();
    await expect(adminPage).toHaveURL(membersUrl);
    const roleSelect = adminPage.getByLabel(`Role for ${secondEmail}`, { exact: true });
    await roleSelect.selectOption({ label: "Reader" });

    // ── 7. B：10 秒內變唯讀 ────────────────────────────────────────────
    // 有效斷言是這兩條：徽章 Viewer、編輯器沒有 `contenteditable="true"`。
    await expect(userBadge.getByText("Viewer", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userEditable).toHaveCount(0, { timeout: 10_000 });
    // spec 字面的「⋮ 沒有 Delete note」：**這條沒有鑑別力**——內建一般成員本來就沒有刪除旗標，第 4 步 B 的 ⋮ 裡
    // 就已經沒有 Delete note；Reader 前後都一樣。Willie 2026-10-01 裁決照 spec 保留（主檔 spec 疑點 8）。
    await userPage.getByRole("button", { name: "More", exact: true }).click();
    await expect(userPage.getByRole("menuitem", { name: "Delete note" })).toHaveCount(0);
    await userPage.keyboard.press("Escape");
    // Q14：唯讀讀者仍有分享鈕（群組版面板只說明＋連到群組設定）
    await expect(userPage.getByRole("button", { name: "Share", exact: true })).toBeVisible();

    if (shotDir) {
      // 目視第 9 項：刪除確認對話框（此時 Reader 有 1 人，人數說明走 description_one）。只截圖、按 Cancel 關。
      await tabs.getByRole("link", { name: "Roles", exact: true }).click();
      await adminPage.getByRole("button", { name: "Delete Reader", exact: true }).click();
      await shot(adminPage, "pr3-delete-role-dialog.png");
      await adminPage.getByRole("dialog", { name: "Delete role?" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await tabs.getByRole("link", { name: "Members", exact: true }).click();
    }

    // ── 8. A：同一個下拉選回 Member ────────────────────────────────────
    await roleSelect.selectOption({ label: "Member" });

    // ── 9. B：10 秒內恢復可編輯；B 打字 A 看得到 ────────────────────────
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userEditable).toHaveCount(1, { timeout: 10_000 });
    const sentence = `typed by restored member ${Date.now()}`;
    await editorLocator(userPage).click();
    await userPage.keyboard.type(sentence);
    await expect(editorLocator(adminPage)).toContainText(sentence, { timeout: 15_000 });

    // ── 10. A 回到角色頁截圖（Task 8 Step 4.3 的視覺檢查）────────────────
    await tabs.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage.getByRole("region", { name: "Reader", exact: true })).toBeVisible();
    await shot(adminPage, "pr3-roles-page.png");
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
