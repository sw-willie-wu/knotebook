import { expect, test } from "@playwright/test";
import { ADMIN, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * #103 群組（spec §11.3 第 1 條）：A 建群組 → 加 B → A 在群組建筆記 → B 側欄看得到、能編輯
 * （共編互見）→ A 移除 B → B 連線被踢、該篇從 B 的側欄消失 → A 刪群組 → 筆記在 A 的「我的筆記」。
 * 斷言形沿用 03-share-revoke（兩個 context、UI 建第二使用者、10 秒 SLA、exact toast）。
 */
test("群組：建立 → 加人 → 群組建筆記 → 成員共編 → 移除即踢 → 刪群組後回個人筆記", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.newPassword);
    await expect(adminPage).toHaveURL(/\/$/);

    // ── admin 建第二使用者（同 03）──────────────────────────────────────
    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/admin\/users$/);
    const secondEmail = randomEmail();
    const tempPassword = "e2e-second-user-temp-pw";
    await adminPage.getByRole("button", { name: "Create user" }).click();
    const createUserDialog = adminPage.getByRole("dialog", { name: "Create user" });
    await createUserDialog.locator("#admin-create-email").fill(secondEmail);
    await createUserDialog.locator("#admin-create-password").fill(tempPassword);
    await createUserDialog.locator("#admin-create-display-name").fill("E2E Group Member");
    await createUserDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createUserDialog).not.toBeVisible();
    await adminPage.getByRole("link", { name: "Back to notes", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/$/);

    // ── A：側欄工作坊「＋」建群組 ─────────────────────────────────────
    const groupName = `E2E Group ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
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
    await adminPage.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const title = `E2E group note ${Date.now()}`;
    const titleInput = adminPage.getByLabel("Note title");
    await titleInput.fill(title);
    await titleInput.blur();
    await adminPage.waitForURL(
      (url) => /^\/n\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
      { timeout: 15_000 },
    );
    const noteUrl = adminPage.url();
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await editorLocator(adminPage).waitFor({ timeout: 15_000 });
    // 該篇落在群組段（不是「我的筆記」）
    const groupSection = sidebar.locator(`[data-testid^="notegroup-group-"]`).filter({ has: adminPage.getByRole("button", { name: groupName, exact: true }) });
    await expect(groupSection.getByRole("link", { name: title })).toBeVisible();

    // ── A：分享面板＝兩態＋群組成員；admin 從這裡把 B 加進群組 ─────────────
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog.getByRole("radio", { name: /Group members/ })).toBeChecked();
    await expect(shareDialog.getByRole("radio", { name: /Private/ })).toHaveCount(0);
    await shareDialog.getByLabel("Email address").fill(secondEmail);
    await shareDialog.getByRole("button", { name: "Add to group", exact: true }).click();
    await expect(shareDialog.getByText(secondEmail)).toBeVisible();
    await adminPage.keyboard.press("Escape");

    // ── B：首登改密 → 側欄工作坊看得到那篇 → 開啟、可編輯、共編互見 ──────────
    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, tempPassword);
    await expect(userPage).toHaveURL(/\/change-password$/);
    const newPassword = "e2e-second-user-pw-2";
    await userPage.locator("#change-password-current").fill(tempPassword);
    await userPage.locator("#change-password-new").fill(newPassword);
    await userPage.locator("#change-password-confirm").fill(newPassword);
    await userPage.getByRole("button", { name: "Change password" }).click();
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = userSidebar.getByTestId("notegroup-workspace");
    await expect(userWorkspace.getByRole("button", { name: groupName, exact: true })).toBeVisible({ timeout: 15_000 });
    await userWorkspace.getByRole("link", { name: title }).click();
    await expect(userPage).toHaveURL(noteUrl);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible(); // 預設 group_role=editor
    // 非 owner 沒有分享鈕
    await expect(userPage.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

    const sentence = `typed by member ${Date.now()}`;
    await editorLocator(userPage).click();
    await userPage.keyboard.type(sentence);
    await expect(editorLocator(adminPage)).toContainText(sentence, { timeout: 15_000 });

    // ── A：設定 → 群組 → 該群組 → 移除 B ──────────────────────────────
    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Settings" }).click();
    await adminPage.getByRole("link", { name: "Groups", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/groups$/);
    await adminPage.getByRole("link", { name: groupName, exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/groups\/[0-9a-f-]{36}$/);
    await adminPage.getByRole("button", { name: `Remove ${secondEmail}` }).click();
    // ⚠ 不能 getByText(secondEmail)：email 同時出現在儲存格與「Remove <email>」鈕文字裡，
    // 子字串比對會命中兩個 → strict mode 直接 throw 不重試。等那顆移除鈕消失即可。
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);

    // ── B：≤10 秒被踢、回 "/"、該篇從側欄消失、群組段也消失 ─────────────────
    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(userSidebar.getByRole("link", { name: title })).toHaveCount(0, { timeout: 10_000 });
    await expect(userSidebar.getByRole("button", { name: groupName, exact: true })).toHaveCount(0, { timeout: 10_000 });

    // ── A：關設定 → 側欄群組 ⋮ → 刪除群組（確認）→ 筆記在「我的筆記」──────────
    await adminPage.keyboard.press("Escape");
    // backgroundLocation 是 react-router 的 location，可能還是 untitled-… 那個（標題改網址走
    // replaceState）；先確認回到筆記頁，再等 NotePage 收斂到 canonical。
    await expect(adminPage).toHaveURL(/\/n\//);
    await expect(adminPage).toHaveURL(noteUrl, { timeout: 15_000 });
    await sidebar.getByRole("button", { name: `Group actions for ${groupName}` }).click();
    await adminPage.getByRole("menuitem", { name: "Delete group" }).click();
    const deleteDialog = adminPage.getByRole("dialog", { name: "Delete group?" });
    await expect(deleteDialog).toContainText("become personal notes");
    await deleteDialog.getByRole("button", { name: "Delete group", exact: true }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toHaveCount(0, { timeout: 10_000 });
    await expect(sidebar.getByTestId("notegroup-myNotes").getByRole("link", { name: title })).toBeVisible({ timeout: 10_000 });
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
