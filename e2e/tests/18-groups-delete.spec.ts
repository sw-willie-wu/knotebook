import { expect, test, type Page } from "@playwright/test";
import { ADMIN, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * #175 群組 v2 PR4（spec §12.3 第 18 條）：刪群組的兩個模式。
 *
 * 轉移段：A 建第二使用者 B → A 建群組 G1、在 G1 建筆記 X、打一句字、記下 `/g/` 網址 → A 在群組版分享面板打開
 * Public link、記下公開網址 → A 從設定加 B（內建一般成員）→ B 開 X（徽章 Editor）→ A 側欄 G1 ⋮ → Delete group，
 * 對話框預設「Give them to an admin」、接手者是 A → 確認 → B 10 秒內被踢回首頁、側欄沒有 X 也沒有 G1 →
 * A 的「My notes」出現 X；開舊的 `/g/` 網址收斂成 `/n/<A>/<slug>`、內容還在 → A 的分享面板是個人形、Private 已勾
 * （Willie 2026-10-02 裁決：轉移清掉公開連結）→ 匿名開舊公開網址顯示失效文案。
 *
 * 全刪段：A 建群組 G2、在 G2 建筆記 Y、加 B → B 開 Y → A 側欄 G2 ⋮ → Delete group → 選「Delete everything」、
 * 確認鈕在勾「I understand…」之前不能按 → 勾、按 → B 10 秒內「This note has been deleted.」→ A 側欄沒有 G2、
 * 開 Y 的 `/g/` 網址顯示無效連結文案。
 *
 * 斷言形沿用 15-groups／17-groups-roles（兩個 context、UI 建第二使用者、首登改密、`editorLocator`、10 秒 SLA）。
 * 群組與筆記留著不清：e2e 疊每次 `stack:down -v` 重置。
 */

const TEMP_PASSWORD = "e2e-delete-user-temp-pw";
const NEW_PASSWORD = "e2e-delete-user-pw-2";

/** A 用側欄工作坊「＋」建群組（同 15）。 */
async function createGroup(adminPage: Page, name: string): Promise<void> {
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: "New group", exact: true }).click();
  const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
  await groupDialog.getByLabel("Group name").fill(name);
  await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(groupDialog).not.toBeVisible();
  await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
}

/** A 在群組段「＋」建筆記、改標題，等網址收斂成 `/g/<id>/<title slug>`、共編連上；回傳 canonical 網址（同 15／17）。 */
async function createGroupNote(adminPage: Page, groupName: string, title: string): Promise<string> {
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
  await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
  const titleInput = adminPage.getByLabel("Note title");
  await titleInput.fill(title);
  await titleInput.blur();
  await adminPage.waitForURL(
    (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );
  await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(adminPage).waitFor({ timeout: 15_000 });
  return adminPage.url();
}

/** A：設定 → Groups → 該群組 → 以 email 加成員（預設內建一般成員）→ Escape 關設定（同 15）。 */
async function addMember(adminPage: Page, groupName: string, email: string): Promise<void> {
  await adminPage.getByRole("button", { name: "admin", exact: true }).click();
  await adminPage.getByRole("menuitem", { name: "Settings" }).click();
  await adminPage.getByRole("link", { name: "Groups", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/settings\/groups$/);
  await adminPage.getByRole("link", { name: groupName, exact: true }).click();
  await expect(adminPage).toHaveURL(/\/settings\/groups\/[0-9a-f-]{36}$/);
  await adminPage.getByLabel("Email address", { exact: true }).fill(email);
  await adminPage.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adminPage.getByRole("button", { name: `Remove ${email}` })).toBeVisible();
  await adminPage.keyboard.press("Escape");
  await expect(adminPage.getByRole("button", { name: `Remove ${email}` })).toHaveCount(0);
}

/** A：側欄群組 ⋮ → Delete group，回傳對話框。 */
async function openDeleteGroupDialog(adminPage: Page, groupName: string) {
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: `Group actions for ${groupName}` }).click();
  await adminPage.getByRole("menuitem", { name: "Delete group" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Delete group?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("刪群組：轉移給管理員（成員被踢、舊網址轉址、公開連結關閉）→ 全部刪除（勾選才能按、成員看到已刪除）", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.newPassword);
    await expect(adminPage).toHaveURL(/\/$/);
    const sidebar = adminPage.getByRole("complementary");

    // ── 1. A 建第二使用者 B（同 15／17）──────────────────────────────────
    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/admin\/users$/);
    const secondEmail = randomEmail();
    await adminPage.getByRole("button", { name: "Create user" }).click();
    const createUserDialog = adminPage.getByRole("dialog", { name: "Create user" });
    await createUserDialog.locator("#admin-create-email").fill(secondEmail);
    await createUserDialog.locator("#admin-create-password").fill(TEMP_PASSWORD);
    await createUserDialog.locator("#admin-create-display-name").fill("E2E Delete Member");
    await createUserDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createUserDialog).not.toBeVisible();
    await adminPage.getByRole("link", { name: "Back to notes", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 2. 轉移段：A 建 G1、在 G1 建 X、打一句字、記下 /g/ 網址 ──────────────────
    const g1 = `E2E Transfer ${Date.now()}`;
    await createGroup(adminPage, g1);
    const titleX = `E2E transfer note ${Date.now()}`;
    const groupUrlX = await createGroupNote(adminPage, g1, titleX);
    const slugX = new URL(groupUrlX).pathname.split("/").pop()!;
    const sentenceX = `transferred content ${Date.now()}`;
    await editorLocator(adminPage).click();
    await adminPage.keyboard.type(sentenceX);
    await expect(editorLocator(adminPage)).toContainText(sentenceX);

    //    A：群組版分享面板打開 Public link，記下公開網址（寫法同 16 的 `Public link URL`）
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await shareDialog.getByRole("switch", { name: "Public link", exact: true }).click();
    const urlInput = shareDialog.getByLabel("Public link URL");
    await expect(urlInput).toBeVisible({ timeout: 10_000 });
    const token = await urlInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const publicPath = `/p/${token}`;
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    // 轉移前公開網址是活的（否則後面的「失效」沒有鑑別力）
    const anonPage = await anonContext.newPage();
    await anonPage.goto(publicPath);
    await expect(anonPage.getByRole("heading", { name: titleX })).toBeVisible({ timeout: 15_000 });

    // ── 3. A 加 B；B 首登改密 → 側欄開 X → 徽章 Editor ────────────────────────
    await addMember(adminPage, g1, secondEmail);
    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, TEMP_PASSWORD);
    await expect(userPage).toHaveURL(/\/change-password$/);
    await userPage.locator("#change-password-current").fill(TEMP_PASSWORD);
    await userPage.locator("#change-password-new").fill(NEW_PASSWORD);
    await userPage.locator("#change-password-confirm").fill(NEW_PASSWORD);
    await userPage.getByRole("button", { name: "Change password" }).click();
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = userSidebar.getByTestId("notegroup-workspace");
    await expect(userWorkspace.getByRole("button", { name: g1, exact: true })).toBeVisible({ timeout: 15_000 });
    await userWorkspace.getByRole("link", { name: titleX }).click();
    await expect(userPage).toHaveURL(groupUrlX);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible();

    // ── 4. A：G1 ⋮ → Delete group → 預設轉移、接手者是 A → 確認 ──────────────────
    const deleteG1 = await openDeleteGroupDialog(adminPage, g1);
    await expect(deleteG1.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    const adminSelect = deleteG1.getByLabel("Admin who gets the notes");
    await expect(adminSelect).toBeEnabled();
    await expect(adminSelect.locator("option:checked")).toHaveText(`admin (${ADMIN.email})`);
    await deleteG1.getByRole("button", { name: "Delete group", exact: true }).click();
    await expect(deleteG1).not.toBeVisible({ timeout: 15_000 });

    // ── 5. B：10 秒內被踢回 "/"、側欄沒有 X、沒有 G1（形同 15 的 B 段）───────────────
    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(userSidebar.getByRole("link", { name: titleX })).toHaveCount(0, { timeout: 10_000 });
    await expect(userSidebar.getByRole("button", { name: g1, exact: true })).toHaveCount(0, { timeout: 10_000 });

    // ── 6. A：「My notes」出現 X；開舊 /g/ 網址 → 收斂成 /n/<A>/<slug>、內容還在 ─────────
    await expect(sidebar.getByRole("button", { name: g1, exact: true })).toHaveCount(0, { timeout: 10_000 });
    await expect(sidebar.getByTestId("notegroup-myNotes").getByRole("link", { name: titleX })).toBeVisible({ timeout: 10_000 });
    await adminPage.goto(groupUrlX);
    await expect(adminPage).toHaveURL(new RegExp(`/n/[^/]+/${slugX}$`), { timeout: 15_000 });
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await expect(editorLocator(adminPage)).toContainText(sentenceX, { timeout: 15_000 });

    // ── 7. A：分享面板是個人形、Private 已勾；匿名開舊公開網址 → 失效文案 ─────────────
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    const accessGroup = shareDialog.getByRole("radiogroup", { name: "Access" });
    await expect(accessGroup).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });
    await expect(shareDialog.getByRole("radio", { name: /^Private/ })).toBeChecked();
    await expect(shareDialog.getByRole("radio", { name: /^Public link/ })).not.toBeChecked();
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    await anonPage.goto(publicPath);
    await expect(anonPage.getByText("This link doesn't exist or is no longer active.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // ── 8. 全刪段：A 建 G2、在 G2 建 Y、加 B；B 開 Y（徽章 Editor）──────────────────
    const g2 = `E2E Purge ${Date.now()}`;
    await createGroup(adminPage, g2);
    const titleY = `E2E purge note ${Date.now()}`;
    const groupUrlY = await createGroupNote(adminPage, g2, titleY);
    await addMember(adminPage, g2, secondEmail);
    // B 直接開網址：B 的側欄清單不一定已重抓到新群組，這段要測的是刪除，不是側欄。
    await userPage.goto(groupUrlY);
    await expect(userPage).toHaveURL(groupUrlY);
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge.getByText("Editor", { exact: true })).toBeVisible();

    // ── 9. A：G2 ⋮ → Delete group → Delete everything → 勾選前確認鈕 disabled → 勾 → 按 ──
    const deleteG2 = await openDeleteGroupDialog(adminPage, g2);
    await deleteG2.getByRole("radio", { name: "Delete everything" }).check();
    const confirmG2 = deleteG2.getByRole("button", { name: "Delete group", exact: true });
    await expect(confirmG2).toBeDisabled();
    await deleteG2.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }).click();
    await expect(confirmG2).toBeEnabled();
    await confirmG2.click();
    await expect(deleteG2).not.toBeVisible({ timeout: 15_000 });

    // ── 10. B：10 秒內「This note has been deleted.」──────────────────────────
    await expect(userPage.getByText("This note has been deleted.", { exact: true })).toBeVisible({ timeout: 10_000 });

    // ── 11. A：側欄沒有 G2；開 Y 的 /g/ 網址 → 無效連結文案 ──────────────────────
    await expect(sidebar.getByRole("button", { name: g2, exact: true })).toHaveCount(0, { timeout: 10_000 });
    await adminPage.goto(groupUrlY);
    await expect(adminPage.getByText("This link is invalid or the note doesn't exist.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await adminContext.close();
    await userContext.close();
    await anonContext.close();
  }
});
