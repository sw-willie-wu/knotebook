import { expect, test } from "@playwright/test";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/**
 * #175 群組 v2（spec §12.3 第 15 條，PR1 改寫自 #103 版）：A 建群組 → A 在群組建筆記（群組持有、
 * 網址 `/g/<group_id>/<slug>`）→ 分享面板是群組版（無 radio、只說明＋連到群組設定）→ A 從側欄群組 ⋮ →
 *『成員與設定』（群組面板）以 email 加 B（內建一般成員）→ B 側欄看得到、能編輯（共編互見）、也有分享鈕 → A 移除 B → B 連線
 * 被踢、該篇從 B 的側欄消失 → A 開刪除群組對話框：兩模式、預設「轉移給管理員」→ Cancel → 群組與該篇仍在
 * （PR4 起非空群組也刪得掉，真的刪除由 18-groups-delete 測）。
 * 斷言形沿用 03-share-revoke（兩個 context、邀請建第二使用者、10 秒 SLA、exact toast）。
 * 群組與筆記留著不清：e2e 疊每次 `stack:down -v` 重置。
 */
test("群組：建立 → 群組建筆記（/g/ 網址）→ 設定加人 → 成員共編 → 移除即踢 → 刪除對話框預設轉移、取消後群組仍在", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    // ── admin 以邀請建第二使用者（API 建邀請＋另開 context 兌換）──────────────────────────────────────
    const secondEmail = randomEmail();
    const password = "e2e-second-user-pw";
    await createUserViaInvite(adminPage, { email: secondEmail, password, displayName: "E2E Group Member" });

    // ── A：側欄工作坊「＋」建群組 ─────────────────────────────────────
    const groupName = `E2E Group ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Workspace");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    const groupHeader = sidebar.getByRole("button", { name: groupName, exact: true });
    await expect(groupHeader).toBeVisible();
    await expect(groupHeader).toHaveAttribute("aria-expanded", "true");

    // ── A：在群組建筆記（段標「＋」；「＋」預設 opacity-0，Playwright 仍視為可見）──
    await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
    await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const title = `E2E group note ${Date.now()}`;
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
    // 該篇落在群組段（不是「我的筆記」）
    const groupSection = sidebar.locator(`[data-node-kind="group"]`).filter({ has: adminPage.getByRole("button", { name: groupName, exact: true }) });
    await expect(groupSection.getByRole("link", { name: title })).toBeVisible();

    // ── A：分享面板是群組版（§8.4）：沒有 radio、沒有加人表單，只說明存取由角色決定 ──────
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await expect(shareDialog.getByRole("radio")).toHaveCount(0);
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    // ── A：側欄群組 ⋮ →「Members & settings」（群組面板）→ 以 email 加 B（角色預設內建一般成員）──
    await openGroupPanel(adminPage, groupName);
    await adminPage.getByLabel("Email address", { exact: true }).fill(secondEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toBeVisible();
    await adminPage.keyboard.press("Escape");
    // #179：改標題換網址走 router navigate，開群組面板時記下的 backgroundLocation 已是改名後的網址，
    // 關群組面板必須回到 canonical（不得退回改標題前的 untitled-…）。
    await expect(adminPage).toHaveURL(noteUrl);
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);

    // ── B：登入 → 側欄工作坊看得到那篇 → 開啟、可編輯、共編互見 ──────────
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
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible(); // 內建一般成員 → editor
    // Q14：群組筆記的讀者也有分享鈕（群組版面板只說明＋連到群組設定）
    await expect(userPage.getByRole("button", { name: "Share", exact: true })).toBeVisible();

    const sentence = `typed by member ${Date.now()}`;
    await editorLocator(userPage).click();
    await userPage.keyboard.type(sentence);
    await expect(editorLocator(adminPage)).toContainText(sentence, { timeout: 15_000 });

    // ── A：側欄群組 ⋮ →「Members & settings」（群組面板）→ 移除 B ──────────────
    await openGroupPanel(adminPage, groupName);
    await adminPage.getByRole("button", { name: `Remove ${secondEmail}` }).click();
    // 等那顆移除鈕消失＝那一列已移除。移除鈕自 #183 起是圖示鈕，email 只在它的 aria-label
    // （「Remove <email>」）裡、不在可見文字裡；用可及名稱找它，對到的就是那一列的操作。
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);

    // ── B：≤10 秒被踢、回 "/"、該篇從側欄消失、群組段也消失 ─────────────────
    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
    await showSidebarTab(userPage, "Recent", userSidebar);
    await expect(userSidebar.getByRole("link", { name: title })).toHaveCount(0, { timeout: 10_000 });
    await showSidebarTab(userPage, "Workspace", userSidebar);
    await expect(userSidebar.getByRole("button", { name: groupName, exact: true })).toHaveCount(0, { timeout: 10_000 });

    // ── A：關群組面板 → 側欄群組 ⋮ → 刪除群組 → 對話框預設「轉移給管理員」→ Cancel → 群組與該篇仍在 ──
    await adminPage.keyboard.press("Escape");
    // #179：backgroundLocation 就是 canonical（改名換網址走 router navigate），關群組面板直接回到它。
    await expect(adminPage).toHaveURL(noteUrl);
    await showSidebarTab(adminPage, "Workspace");
    await sidebar.getByRole("button", { name: `Group actions for ${groupName}` }).click();
    await adminPage.getByRole("menuitem", { name: "Delete group" }).click();
    const deleteDialog = adminPage.getByRole("dialog", { name: "Delete group?" });
    // §8.6 PR4：兩模式、預設轉移（不丟資料的那條）。
    await expect(deleteDialog.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    await expect(deleteDialog.getByRole("radio", { name: "Delete everything" })).not.toBeChecked();
    await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();
    await expect(groupSection.getByRole("link", { name: title })).toBeVisible();
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
