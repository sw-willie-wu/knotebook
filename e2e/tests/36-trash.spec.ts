import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  editorLocator,
  loginAs,
  moveNoteToTrashFromSidebar,
  openGroupPanel,
  randomEmail,
  reEscape,
  showSidebarTab,
  toastWithTitle,
} from "./helpers.js";

/**
 * #181 垃圾桶 PR-2b（spec 2026-10-21 §6.14 e2e 段；A2-1、A2-2、A2-3、A2-11、A2-12）：
 * 1. 頁首 ⋮「Delete」不確認、toast「Undo」回到該篇且可共編；側欄 ⋮ 再移入 → 垃圾桶 tab 個人區、「剩 N 天」、底部天數。
 * 2. 公開連結在垃圾桶期間 404，從垃圾桶列「還原」後恢復。
 * 3. 選取模式：Shift 範圍選三篇還原；勾兩篇永久刪除（確認框）後原網址連結無效。
 * 4. 390 寬抽屜：選取中按 Esc 只結束選取、焦點回抽屜內的「選取」鈕；確認框 Esc 只關框（jsdom 對這條假綠過，只有真瀏覽器守得住）。
 * 5. 群組：「只能刪」成員移入 → toast 沒有「Undo」、看不到群組垃圾桶、原網址無效；「編輯＋刪除」成員看得到、從卡片還原。
 * 6. 390 寬抽屜：在抽屜裡把別篇移入 → toast 以 role 找得到（抽屜開著時 toast 搬進抽屜，不在 aria-hidden 的背景裡）、按它的 Undo 抽屜不關、該篇回來。
 *
 * 共用疊：別的 spec（例如 16）會在 admin 的垃圾桶留下項目，所以不斷言總數、列一律以本檔的標題（帶 RUN）定位。
 * 群組與筆記留著不清（同 17）：e2e 疊每次 `stack:down -v` 重置。
 */
const RUN = Date.now();
const PASSWORD = "e2e-trash-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const TRASH_HEADER = /^Trash · \d+ notes?$/;
/** ceil、最小 1：沒有「不到 1 天」（總管裁定 2026-10-22）。 */
const DAYS_LEFT = /^\d+ days? left$/;
const LINK_INVALID = "This link is invalid or the note doesn't exist.";
/**
 * 「連結無效」由解析層的 404 決定：react-query 預設重試 3 次（退避 1＋2＋4 秒），約 7 秒才變 error、toast 才出現（先例 e2e 18）。
 * 「在垃圾桶裡」卡片不在此列：解析層 `in_trash` 不重試，卡片即時出現。
 */
const LINK_INVALID_TIMEOUT = 15_000;
const NO_UNDO_HINT = "Members of the group whose role can both edit and delete notes can restore it.";
const DELETE_WITHOUT_EDIT_HINT = "Without Edit, notes deleted with this role can't be restored from the trash by its holders.";

/** 側欄筆記連結（可及名稱以標題開頭）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** 點「Trash」tab、等清單到（標題列「Trash · N notes」；0 篇也有）；回傳 tabpanel。 */
async function openTrash(page: Page, scope?: Locator): Promise<Locator> {
  const panel = await showSidebarTab(page, "Trash", scope);
  await expect(panel.getByText(TRASH_HEADER)).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** 垃圾桶列（`<li>`，不是連結）；給 `section` 就限定在「My notes」／「Workspace」那一區。 */
function trashRow(panel: Locator, title: string, section?: "My notes" | "Workspace"): Locator {
  const root = section ? panel.getByRole("list", { name: section, exact: true }) : panel;
  return root.getByRole("listitem").filter({ hasText: title });
}

/** 選取模式的勾選框（整列是 `<label>`，可及名稱以標題開頭）。 */
function trashCheckbox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

test("A2-1／A2-2：頁首 ⋮ 移入不確認、toast 復原回到該篇可共編；側欄 ⋮ 再移入 → 垃圾桶 tab 個人區、剩 N 天、底部天數", async ({ page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Keep ${RUN}`;
  const title = `E2E Trash A ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, keep); // 不移入：第 2 段負向斷言的正向錨點
  await createNote(page, title);
  const noteUrl = page.url();

  // ── A2-1：頁首 ⋮ → Delete：不跳確認框、回首頁、toast 帶 Undo ─────────────────
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const moved = toastWithTitle(page, "Moved to the trash");
  await expect(moved).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Undo（選單已隨筆記頁卸載）→ 回到該篇、可共編（不被刪除閘門擋）
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(noteUrl, { timeout: 15_000 });
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
  const badge = page.getByRole("status").filter({ hasText: /^Connected/ });
  await expect(badge).toBeVisible({ timeout: 15_000 });
  const word = `undone${RUN}`;
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially(word);
  await expect(editor).toContainText(word);
  await expect(badge).toBeVisible();

  // ── A2-2：側欄 ⋮ 再移入同一篇（開著的那篇：同樣回首頁）→ 垃圾桶 tab ─────────────────
  const sidebar = page.getByRole("complementary");
  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  const panel = await openTrash(page);
  const row = trashRow(panel, title, "My notes");
  await expect(row).toBeVisible();
  await expect(row.getByText(DAYS_LEFT)).toBeVisible();
  await expect(row.getByRole("link")).toHaveCount(0); // 垃圾桶列不是連結（spec §6.10.1）
  await expect(sidebar.getByTestId("trash-footer")).toHaveText(/Permanently deleted \d+ days? after deletion|isn't emptied automatically/);

  // My notes 沒有它：tab 一次只渲染一份清單，先等正向錨點（同測試先建的 keep）到了才斷負向
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(myNotes, title)).toHaveCount(0);
});

test("A2-11：公開連結在垃圾桶期間 404，從垃圾桶列還原後恢復", async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  const title = `E2E Trash P ${RUN}`;
  // 用新帳號當 owner：public-link 的 PUT/DELETE 每人 10 次/10 分鐘（PUBLIC_LINK_LIMIT），
  // 整套序跑到這裡時 admin 已被前面的 spec 用滿，再開公開連結會吃 429（同 31 E3）。
  const owner = { email: randomEmail(), password: PASSWORD };
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, owner);
  } finally {
    await adminContext.close();
  }
  await loginAs(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);

  // ShareDialog 開公開連結（同 31 E3；輸入框只放 token）
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const shareDialog = page.getByRole("dialog", { name: "Share note" });
  const publicRadio = shareDialog.getByRole("radio", { name: /^Public link/ });
  await expect(publicRadio).toBeEnabled(); // latch 完成才可點
  const publish = page.waitForResponse((res) => res.url().endsWith("/public-link") && res.request().method() === "PUT");
  await publicRadio.check();
  expect((await publish).status()).toBe(200);
  const urlInput = shareDialog.getByLabel("Public link URL");
  await expect(urlInput).toBeVisible();
  const token = await urlInput.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // `request` fixture 不帶 page 的 cookie＝匿名
  const publicStatus = async (): Promise<number> => (await request.get(`/api/public/notes/${token}`)).status();
  await expect(async () => {
    expect(await publicStatus()).toBe(200);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(shareDialog).not.toBeVisible();

  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(async () => {
    expect(await publicStatus()).toBe(404);
  }).toPass({ timeout: 10_000 });

  // 垃圾桶列 hover 浮出「還原」
  const panel = await openTrash(page);
  const row = trashRow(panel, title, "My notes");
  await row.hover();
  await row.getByRole("button", { name: `Restore ${title}`, exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveCount(0);
  await expect(async () => {
    expect(await publicStatus()).toBe(200);
  }).toPass({ timeout: 10_000 });
});

test("A2-3：選取模式——Shift 範圍選三篇還原；勾兩篇永久刪除（確認框）後原網址連結無效", async ({ page }) => {
  test.setTimeout(150_000);
  const [s1, s2, s3] = [1, 2, 3].map((i) => `E2E Trash S${i} ${RUN}`) as [string, string, string];
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const urls: string[] = [];
  for (const title of [s1, s2, s3]) {
    await createNote(page, title);
    urls.push(page.url());
  }
  await showSidebarTab(page, "My notes");
  // 依序移入：清單新到舊是 S3、S2、S1（期間沒有別的移入，三列相鄰）。S3 是開著的那篇，移完回首頁。
  for (const title of [s1, s2, s3]) await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // ── 點 S3、Shift＋點 S1 → 3 selected → 底部 Restore ───────────────────────────
  const sidebar = page.getByRole("complementary");
  let panel = await openTrash(page);
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, s3).click();
  await trashRow(panel, s1).click({ modifiers: ["Shift"] });
  await expect(panel.getByText("3 selected", { exact: true })).toBeVisible();
  for (const title of [s1, s2, s3]) await expect(trashCheckbox(panel, title)).toBeChecked();
  await sidebar.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 3 notes")).toBeVisible({ timeout: 15_000 });
  // 成功後離開選取模式
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  const myNotes = await showSidebarTab(page, "My notes");
  for (const title of [s1, s2, s3]) await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });

  // ── 再移入 S1、S2 → 勾兩篇 → Delete permanently → 確認框 ─────────────────────────
  for (const title of [s1, s2]) await moveNoteToTrashFromSidebar(page, title);
  panel = await openTrash(page);
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await trashRow(panel, s1).click();
  await trashRow(panel, s2).click();
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Delete permanently", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Permanently delete 2 notes?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(toastWithTitle(page, "Permanently deleted 2 notes")).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  await expect(trashRow(panel, s1)).toHaveCount(0);
  await expect(trashRow(panel, s2)).toHaveCount(0);

  // 原網址：連結無效（解析層 404 走預設重試，見 LINK_INVALID_TIMEOUT）
  await page.goto(urls[0]!);
  await expect(page.getByText(LINK_INVALID, { exact: true })).toBeVisible({ timeout: LINK_INVALID_TIMEOUT });
  await expect(page).toHaveURL(/\/$/);
});

test("390 寬抽屜：選取中按 Esc 只結束選取、焦點回抽屜內的「選取」鈕；確認框 Esc 只關框", async ({ page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Drawer Keep ${RUN}`;
  const title = `E2E Trash D ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, keep);
  const keepUrl = page.url();
  await createNote(page, title);
  await showSidebarTab(page, "My notes");
  await moveNoteToTrashFromSidebar(page, title);
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  // 整頁載入（toast 也一併清掉，不會蓋住抽屜底部）；等 lazy NotePage 掛上：fallback 自帶的 AppShell 會被換掉（抽屜跟著關）。
  await page.goto(keepUrl);
  await expect(page.getByRole("textbox", NOTE_TITLE)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const panel = await openTrash(page, drawer);
  const selectButton = drawer.locator("button[data-sidebar-select]");
  const checkbox = trashCheckbox(panel, title);

  // ── 勾選框上按 Esc：結束選取、抽屜不關、焦點回抽屜內的「選取」鈕 ─────────────────
  await selectButton.click();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(selectButton).toBeFocused();

  // ── 確認框開著按 Esc：只關框，選取保留、焦點回開框的鈕 ───────────────────────────
  await selectButton.click();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  const purgeButton = drawer.getByRole("button", { name: "Delete permanently", exact: true });
  await purgeButton.click();
  const confirm = page.getByRole("dialog", { name: "Permanently delete 1 note?" });
  // Cancel 在確認框的 DismissableLayer 登記那一輪就拿到焦點，但抽屜的 Esc listener 要等下一次 render（Radix 的 layer 重排）
  // 才拆掉；那次 render 同時把抽屜設成 pointer-events: none——等到它才按 Esc，否則 Esc 由抽屜處理、選取被結束。
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(page.locator("[data-sidebar-drawer]")).toHaveCSS("pointer-events", "none");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(purgeButton).toBeFocused();

  // ── 動作列上再按 Esc：結束選取、抽屜仍開；下一次 Esc 才關抽屜 ───────────────────
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(selectButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("390 寬抽屜開著時移入別篇：toast 與 Undo 以 role 找得到、按 Undo 抽屜不關、該篇回到清單", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const keep = `E2E Trash Toast Keep ${RUN}`;
  const title = `E2E Trash Toast ${RUN}`;
  const user = { email: randomEmail(), password: PASSWORD };
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, user);
  } finally {
    await adminContext.close();
  }
  await loginAs(page, user.email, user.password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);
  await createNote(page, keep);
  const keepUrl = page.url();

  await page.setViewportSize({ width: 390, height: 844 });
  // 整頁載入後等 lazy NotePage 掛上再開抽屜：fallback 自帶的 AppShell 會被換掉（抽屜跟著關）。
  await page.goto(keepUrl);
  await expect(page.getByRole("textbox", NOTE_TITLE)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  await showSidebarTab(page, "My notes", drawer);

  // 移的是別篇：不換頁、抽屜不關，toast 在抽屜開著時跳出（helper 以 role 找它——修正前它在 aria-hidden 的背景裡、找不到）。
  const moved = await moveNoteToTrashFromSidebar(page, title, drawer);
  await expect(drawer).toBeVisible();
  // 鍵盤到得了：F8 把焦點交給 toast 區，抽屜的 focus trap 不把它拉回去（修正前 toast 區在抽屜外、焦點被拉回抽屜）。
  await page.keyboard.press("F8");
  await expect(page.getByRole("region", { name: /^Notifications/ }).getByRole("list")).toBeFocused();
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(keepUrl);
  const myNotes = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });
});

/** 群組面板「Roles」項次上新增自訂角色，打開 `flags` 那幾個旗標（其餘預設關）。 */
async function createRole(page: Page, name: string, flags: ReadonlyArray<"Edit" | "Delete">): Promise<void> {
  await page.getByRole("button", { name: "New role", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New role" });
  await dialog.getByLabel("Role name", { exact: true }).fill(name);
  for (const flag of flags) {
    const flagSwitch = dialog.getByRole("switch", { name: flag, exact: true });
    await flagSwitch.click();
    await expect(flagSwitch).toBeChecked();
  }
  // §6.10.7：勾了刪除、沒勾編輯 → 提示（只提示、不阻擋）
  const deleteOnly = flags.includes("Delete") && !flags.includes("Edit");
  await expect(dialog.getByText(DELETE_WITHOUT_EDIT_HINT, { exact: true })).toHaveCount(deleteOnly ? 1 : 0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
}

test("A2-12：「只能刪」成員移入群組筆記 → 沒有 Undo、看不到群組垃圾桶、原網址無效；「編輯＋刪除」成員從卡片還原", async ({ browser }) => {
  test.setTimeout(240_000);
  const groupName = `E2E Trash G ${RUN}`;
  const noteTitle = `E2E Trash GN ${RUN}`;
  const restorer = { email: randomEmail(), displayName: "E2E Trash Restorer" }; // B：EditDelete
  const deleter = { email: randomEmail(), displayName: "E2E Trash Deleter" }; // C：DeleteOnly
  const adminContext = await browser.newContext();
  const contexts = [adminContext];
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    for (const user of [restorer, deleter]) await createUserViaInvite(adminPage, { ...user, password: PASSWORD });

    // ── admin：建群組、在群組建筆記（同 17）────────────────────────────────────
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
    const titleInput = adminPage.getByLabel("Note title");
    await titleInput.fill(noteTitle);
    await titleInput.blur();
    await adminPage.waitForURL(
      (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
      { timeout: 15_000 },
    );
    const noteUrl = adminPage.url();
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

    // ── admin：群組面板建兩個自訂角色 → 加 B、C 並設角色 ─────────────────────────
    const groupId = await openGroupPanel(adminPage, groupName);
    const membersUrl = adminPage.url();
    const nav = adminPage.getByRole("navigation", { name: groupName, exact: true });
    await nav.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));
    await createRole(adminPage, "EditDelete", ["Edit", "Delete"]);
    await createRole(adminPage, "DeleteOnly", ["Delete"]);
    await nav.getByRole("link", { name: "Members", exact: true }).click();
    await expect(adminPage).toHaveURL(membersUrl);
    for (const [user, role] of [
      [restorer, "EditDelete"],
      [deleter, "DeleteOnly"],
    ] as const) {
      await adminPage.getByLabel("Email address", { exact: true }).fill(user.email);
      await adminPage.getByRole("button", { name: "Add", exact: true }).click();
      await expect(adminPage.getByRole("button", { name: `Remove ${user.email}` })).toBeVisible();
      // 等角色真的存好（PATCH 回來）才讓成員登入
      const saved = adminPage.waitForResponse(
        (res) => res.request().method() === "PATCH" && res.url().includes(`/api/groups/${groupId}/members/`),
      );
      await adminPage.getByLabel(`Role for ${user.email}`, { exact: true }).selectOption({ label: role });
      expect((await saved).ok()).toBe(true);
    }
    await adminPage.keyboard.press("Escape");

    // ── C（DeleteOnly）：工作坊 tab ⋮ 移入 → toast 沒有 Undo、有說明句 ───────────────
    const deleterContext = await browser.newContext();
    contexts.push(deleterContext);
    const deleterPage = await deleterContext.newPage();
    await loginAs(deleterPage, deleter.email, PASSWORD);
    await expect(deleterPage).toHaveURL(/\/$/);
    const deleterWorkspace = await showSidebarTab(deleterPage, "Workspace");
    await expect(noteLink(deleterWorkspace, noteTitle)).toBeVisible({ timeout: 15_000 });
    const noUndoToast = await moveNoteToTrashFromSidebar(deleterPage, noteTitle);
    await expect(noUndoToast.getByText(NO_UNDO_HINT, { exact: true })).toBeVisible();
    await expect(noUndoToast.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // C 看不到群組垃圾桶：先等清單到（標題列），再斷該列不在
    const deleterTrash = await openTrash(deleterPage);
    await expect(trashRow(deleterTrash, noteTitle)).toHaveCount(0);
    // 直接開原網址：C 沒有垃圾桶權，拿到 not_found → 連結無效（預設重試，見 LINK_INVALID_TIMEOUT）
    await deleterPage.goto(noteUrl);
    await expect(deleterPage.getByText(LINK_INVALID, { exact: true })).toBeVisible({ timeout: LINK_INVALID_TIMEOUT });

    // ── B（EditDelete）：垃圾桶工作坊區有它、刪除者是 C → 開原網址是「在垃圾桶裡」卡片 → 還原 ─────
    const restorerContext = await browser.newContext();
    contexts.push(restorerContext);
    const restorerPage = await restorerContext.newPage();
    await loginAs(restorerPage, restorer.email, PASSWORD);
    await expect(restorerPage).toHaveURL(/\/$/);
    const restorerTrash = await openTrash(restorerPage);
    const row = trashRow(restorerTrash, noteTitle, "Workspace");
    await expect(row).toBeVisible();
    await expect(
      row.getByText(new RegExp(`^${reEscape(groupName)} · Deleted by ${reEscape(deleter.displayName)} · \\d+ days? left$`)),
    ).toBeVisible();
    await restorerPage.goto(noteUrl);
    // 解析層 in_trash 不重試：卡片即時出現（不必等預設重試）。
    await expect(restorerPage.getByRole("heading", { name: "This note is in the trash", exact: true })).toBeVisible({ timeout: 10_000 });
    await restorerPage.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(restorerPage.getByRole("textbox", NOTE_TITLE)).toHaveValue(noteTitle, { timeout: 15_000 });

    // ── C 重整 → 工作坊 tab 又看得到 ───────────────────────────────────────────
    await deleterPage.reload();
    const deleterWorkspaceAgain = await showSidebarTab(deleterPage, "Workspace");
    await expect(noteLink(deleterWorkspaceAgain, noteTitle)).toBeVisible({ timeout: 15_000 });
  } finally {
    for (const context of contexts) await context.close();
  }
});
