import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * #175 PR2（spec §12.3 第 16 條，改寫自 #103 PR3 版）：移入群組與複製到個人。
 * A 建群組、從設定加 B（內建一般成員）→ A 建個人筆記（打字＋**真上傳**一張圖）、逐人分享給 C、開公開連結 →
 * C 開著那篇 → A 從 ⋮「Move to…」第二層選單選群組把它移進群組（確認框列出 C、說公開連結會關）→
 * A 的網址列變 `/g/<group id>/<slug>`、面板換成群組版；C ≤10 秒被踢回首頁；公開網址 404 →
 * B 開**舊的** `/n/<A handle>/<slug>` → 網址列變 `/g/…`、內容正確 → B 在 ⋮「Copy to… → Personal space」→ toast「Open copy」→
 * 副本頁的圖是**新的**上傳網址、真的載得出來 → A 刪群組筆記（原圖的上傳端點 404）→ B 重整副本頁，圖仍載得出來。
 *
 * 不斷言 A 搬完的角色（主檔規格落差 17：create-only 角色搬完是 viewer；A 是群組建立者＝內建管理員，本支不測
 * create-only——那條由 server Task 3 案 9 與 web Task 9 案 14 守）。v2 沒有「移出群組」（W4），舊版的移出段整段刪除。
 * 斷言形沿用 03（10 秒 SLA、exact toast）、11（真上傳、`naturalWidth` 輪詢、公開端點 `toPass`）、15（設定加成員）。
 * 收尾以全刪模式（`{ mode: "delete" }`）刪掉這支建的群組——群組裡還有筆記也刪得掉（#175 PR4）。主體中途失敗時
 * 清理的錯誤被吞（不蓋掉原始失敗）；主體通過時清理失敗照常讓測試紅。
 */

const TEMP_PASSWORD = "e2e-second-user-temp-pw";
const NEW_PASSWORD = "e2e-second-user-pw-2";

/** 1×1 紅色 PNG（同 11）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * ⋮ 選單開著時，點第二層觸發項（「Move to…」／「Copy to…」）再點子選單裡的項目（桌面 flyout 形）。
 *
 * 不能直接 `target.click()`：Playwright 的 click 會把滑鼠**一步瞬移**到目標中心。Radix 的子選單靠「指標水平移動方向」
 * 判斷使用者是不是正往子選單走（`pointerDirRef` 只在父選單內的 pointermove 更新，`lastPointerXRef` 初值 0，
 * 所以從 ⋮ 鈕第一次移進父選單那一下必記成 `right`）。1280 寬的視窗裡 ⋮ 貼右緣，子選單碰撞翻到**左側**
 * （`data-side="left"`）——瞬移離開觸發項時方向 `right` ≠ 子選單側 `left`，Radix 判定「沒往子選單走」→ 焦點回父選單 →
 * 子選單 `onFocusOutside` 關掉、項目被卸載，click 無限重試到測試逾時（CI run 37732016391 就是這樣卡滿 180 秒）。
 * 真人的滑鼠是連續移動，離開觸發項前最後幾筆 pointermove 就在觸發項內、方向正確，不會遇到。
 * 所以這裡分段移動（`steps`）模擬真人：第一段仍落在觸發項內，把方向更新成實際往子選單的方向，之後才離開觸發項。
 */
async function pickFromSubmenu(page: Page, triggerName: string, itemName: string): Promise<void> {
  await page.getByRole("menuitem", { name: triggerName, exact: true }).click();
  const target = page.getByRole("menuitem", { name: itemName, exact: true });
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 });
  await target.click();
}

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

/** 依名字找群組 id（`context.request` 帶該 context 的 session cookie）；找不到回 null。 */
async function groupIdNamed(context: BrowserContext, name: string): Promise<string | null> {
  const list = await context.request.get("/api/groups");
  expect(list.status()).toBe(200);
  const group = ((await list.json()) as Array<{ id: string; name: string }>).find((g) => g.name === name);
  return group?.id ?? null;
}

/**
 * 刪掉名為 `name` 的群組（final review T5-M4）。走 API 而不是 15 的 UI 路徑（側欄 ⋮ → Delete group）：
 * 這段在 `finally` 裡跑，失敗時頁面可能停在任何狀態，UI 步驟不可靠。回傳是否找到並刪掉。
 */
async function deleteGroupNamed(context: BrowserContext, name: string): Promise<boolean> {
  const id = await groupIdNamed(context, name);
  if (id === null) return false;
  const res = await context.request.delete(`/api/groups/${encodeURIComponent(id)}`, { data: { mode: "delete" } });
  expect(res.status()).toBe(204);
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

/** `naturalWidth > 0` ＝瀏覽器真的抓到並解碼了圖（404／破圖時是 0；同 11）。 */
async function expectImageLoaded(img: Locator): Promise<void> {
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

test("移入群組（踢逐人分享、關公開連結、舊網址轉址）→ 成員複製到我的筆記 → 刪原筆記後副本的圖仍在", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const closers: Array<() => Promise<void>> = [];
  const groupName = `E2E Move Group ${Date.now()}`;
  let passed = false;
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    const memberEmail = randomEmail(); // B：群組一般成員
    const guestEmail = randomEmail(); // C：個人筆記的逐人分享對象
    const guestName = "E2E Share Guest";
    await createUser(adminPage, memberEmail, "E2E Group Member");
    await createUser(adminPage, guestEmail, guestName);

    // ── A：建群組（側欄工作坊「＋」）→ 設定 → 群組 → 以 email 加 B（同 15）────────────
    const sidebar = adminPage.getByRole("complementary");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();
    const groupId = await groupIdNamed(adminContext, groupName);
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/);

    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Settings" }).click();
    await adminPage.getByRole("link", { name: "Groups", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/groups$/);
    await adminPage.getByRole("link", { name: groupName, exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/groups\/[0-9a-f-]{36}$/);
    await adminPage.getByLabel("Email address", { exact: true }).fill(memberEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${memberEmail}` })).toBeVisible();
    await adminPage.keyboard.press("Escape");
    await expect(adminPage).toHaveURL(/\/$/);

    // ── A：個人筆記 → 打字＋真上傳一張圖（同 11）────────────────────────────
    const title = `E2E move note ${Date.now()}`;
    await createNote(adminPage, title);
    const personalUrl = adminPage.url();
    const personalPath = new URL(personalUrl).pathname;
    const slug = personalPath.slice(personalPath.lastIndexOf("/") + 1);
    const sentence = `moved content ${Date.now()}`;
    const editor = editorLocator(adminPage);
    await editor.click();
    await editor.pressSequentially(sentence);
    await adminPage.keyboard.press("Enter");
    await editor.pressSequentially("/image");
    await adminPage.getByText("Resizable image with caption").click();
    await adminPage.getByText("Add image", { exact: true }).click();
    await expect(adminPage.getByRole("tab", { name: "Upload" })).toBeVisible();
    await adminPage
      .getByLabel("Choose an image file to upload")
      .setInputFiles({ name: "e2e-move.png", mimeType: "image/png", buffer: PNG_1X1 });
    const originalImg = adminPage.locator('img[src*="/api/uploads/"]');
    await expect(originalImg).toBeVisible({ timeout: 15_000 });
    await expectImageLoaded(originalImg);
    const originalSrc = await originalImg.getAttribute("src");
    expect(originalSrc).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);

    // ── A：分享給 C（Members only）→ 開公開連結、記下 token ─────────────────────
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

    // ── C：首登、打開那篇、等共編連上（viewer）──────────────────────────────
    const guest = await firstLogin(browser, guestEmail);
    closers.push(guest.close);
    await guest.page.goto(personalUrl);
    await expect(guest.page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

    // ── A：⋮ → Move to…（第二層選單，桌面 hover／點開）→ 選群組 → 確認框 → Move into group ──
    await adminPage.getByRole("button", { name: "More", exact: true }).click();
    await pickFromSubmenu(adminPage, "Move to…", groupName);
    const confirm = adminPage.getByRole("dialog").filter({ hasText: `Move this note into "${groupName}"?` });
    // 提交鈕在 shares 與 public-link 兩支都到之前停用；確認文案也要等它們到才完整。
    await expect(confirm).toContainText(
      `Per-person sharing with ${guestName} is removed; if they aren't in the group, they lose access.`,
    );
    await expect(confirm).toContainText("Its public link will be turned off.");
    await confirm.getByRole("button", { name: "Move into group", exact: true }).click();

    // A：網址列換成群組形（新群組裡沒有撞名，slug 沿用）；再開分享面板確認已是群組版（無 radio、說明存取看角色）。
    await expect(adminPage).toHaveURL(new RegExp(`/g/${groupId}/${slug}$`), { timeout: 15_000 });
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await expect(shareDialog.getByRole("radio")).toHaveCount(0);
    const groupUrl = adminPage.url();

    // ── C：≤10 秒被踢回 "/"；公開網址 404 ────────────────────────────────────
    await expect(guest.page.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(guest.page).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(async () => {
      expect((await request.get(`/api/public/notes/${token}`)).status()).toBe(404);
    }).toPass({ timeout: 10_000 });
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    // ── B：首登 → 開**舊的** /n/<A handle>/<slug> → 轉到 /g/…、內容正確 ──────────────
    const member = await firstLogin(browser, memberEmail);
    closers.push(member.close);
    await member.page.goto(personalUrl);
    await expect(member.page).toHaveURL(groupUrl, { timeout: 15_000 });
    await expect(member.page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 }); // B 是 editor：標題是輸入框
    await expect(member.page.locator('[data-testid="note-editor"]')).toContainText(sentence, { timeout: 15_000 });

    // ── B：⋮ → Copy to… → Personal space → 確認 → toast「Open copy」→ 副本頁的圖是新上傳、載得出來 ─────────
    await member.page.getByRole("button", { name: "More", exact: true }).click();
    await pickFromSubmenu(member.page, "Copy to…", "Personal space");
    await member.page.getByRole("dialog").getByRole("button", { name: "Copy to my notes", exact: true }).click();
    await expect(member.page.getByText("Copied to your notes", { exact: true })).toBeVisible({ timeout: 15_000 });
    await member.page.getByRole("button", { name: "Open copy", exact: true }).click();
    await member.page.waitForURL(
      (url) => url.pathname.startsWith("/n/") && url.pathname !== personalPath,
      { timeout: 15_000 },
    );
    const copyUrl = member.page.url();
    await expect(member.page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 }); // 副本的 owner 是 B
    await expect(member.page.locator('[data-testid="note-editor"]')).toContainText(sentence, { timeout: 15_000 });
    const copyImg = member.page.locator('img[src*="/api/uploads/"]');
    await expect(copyImg).toBeVisible({ timeout: 15_000 });
    const copySrc = await copyImg.getAttribute("src");
    expect(copySrc).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);
    expect(copySrc).not.toBe(originalSrc); // 附件複製成新 id、網址改寫
    await expectImageLoaded(copyImg);

    // ── A：刪群組筆記（⋮ → Delete note）→ 原圖的上傳端點 404 ─────────────────────
    await adminPage.getByRole("button", { name: "More", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Delete note", exact: true }).click();
    const deleteDialog = adminPage.getByRole("dialog", { name: "Delete note?" });
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(async () => {
      expect((await adminContext.request.get(originalSrc!)).status()).toBe(404);
    }).toPass({ timeout: 10_000 });

    // ── B：重整副本頁 → 圖仍載得出來 ────────────────────────────────────────
    await member.page.reload();
    await expect(member.page).toHaveURL(copyUrl);
    const copyImgAfter = member.page.locator(`img[src="${copySrc}"]`);
    await expect(copyImgAfter).toBeVisible({ timeout: 15_000 });
    await expectImageLoaded(copyImgAfter);
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
