import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  loginAs,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * #181 垃圾桶 PR-2c：一般 tab 的選取模式（spec 2026-10-21 §6.11；plan 2026-10-25-trash-pr2c 的 A2c-2～A2c-8、A2-12 多選面）。
 * 1. 我的筆記 Shift 範圍選三篇 → 移動到群組（確認框焦點在框內、送出後焦點回「Select」）。
 * 2. 工作坊勾一篇群組筆記 → 有「Move to」（群組沒有資料夾、筆記在根層 → 停用）；複製到「My notes」（先確認）。
 * 3. 勾兩篇刪除（不確認）→ toast「Undo」整批復原。
 * 4. 一般成員（沒有刪除權）：刪除鈕 disabled、「Copy to」可按。
 * 5. 「能刪不能編輯」的角色勾兩篇刪除 → toast 沒有「Undo」、帶說明句。
 * 6. 最近 tab 沒有「Move to」；與我共享 tab 有「Copy to」與「Move to」（沒有共享資料夾 → 停用）、沒有刪除鈕。
 * 7. 390 寬抽屜：動作列排得進抽屜；Esc 只結束選取、抽屜不關、焦點回抽屜內的「Select」。
 * 8. 進入選取不改清單的捲動位置。
 * 9. Esc 的範圍：焦點在 body（滑鼠點過勾選框再點主內容區）時結束選取；在標題框裡不結束；開著 toast 時第一下只關 toast。
 *
 * 每個 test 自建所需資料（Playwright 失敗後換 worker、`RUN` 會變；`--grep` 也可能單跑一案）。資料以 API 建（建筆記不帶 content 不吃寫入節流；
 * 複製吃 30／分鐘的寫入節流，本檔只複製 1 篇），建完 `goto("/")` 讓側欄重抓。共用疊：admin 的清單裡有別的 spec 的筆記與群組，
 * 列一律以本檔的標題（帶 RUN）定位、不斷言總數。群組與筆記留著不清（同 36）。
 */
const RUN = Date.now();
const PASSWORD = "e2e-select-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const NO_UNDO_HINT = "Members of the group whose role can both edit and delete notes can restore it.";
/** 刪除鈕只有圖示，可及名稱帶篇數（`select.deleteSelected`）。 */
const DELETE_SELECTED = /^Delete \d+ selected items?$/;

/** 側欄筆記連結（可及名稱以標題開頭）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** 選取模式的勾選框（同 `toggleSelectedNote` 的找法）。 */
function noteCheckbox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

/** 側欄底部的選取動作列（在 tabpanel 外）。`scope` 預設靜態側欄。 */
function actionBar(page: Page, scope?: Locator): Locator {
  return (scope ?? page.getByRole("complementary")).locator("[data-select-action-bar]");
}

/** 選取模式已結束：標題列換回「Select」、勾選框都不在。 */
async function expectSelectionEnded(panel: Locator): Promise<void> {
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
}

/** 建一篇筆記（不帶 content：不吃寫入節流）；給 `groupId` 就建在群組裡。回傳 id。 */
async function apiCreateNote(page: Page, title: string, groupId?: string): Promise<string> {
  const res = await page.request.post("/api/notes", { data: groupId === undefined ? { title } : { title, groupId } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 建群組（建立者＝內建管理員）；回傳 id。 */
async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 加成員；不給 `roleId` 是內建一般成員（讀、新建、編輯，沒有刪除）。 */
async function apiAddMember(page: Page, groupId: string, email: string, roleId?: string): Promise<void> {
  const res = await page.request.put(`/api/groups/${groupId}/members`, { data: roleId === undefined ? { email } : { email, roleId } });
  expect(res.ok(), `PUT /api/groups/${groupId}/members → ${res.status()} ${await res.text()}`).toBe(true);
}

/** 建只開「刪除」的自訂角色（六個旗標都要給）；回傳 role id。 */
async function apiCreateDeleteOnlyRole(page: Page, groupId: string, name: string): Promise<string> {
  const permissions = { create: false, edit: false, delete: true, managePublicLink: false, manageMembers: false, manageGroup: false };
  const res = await page.request.post(`/api/groups/${groupId}/roles`, { data: { name, permissions } });
  expect(res.status(), `POST /api/groups/${groupId}/roles → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 新 context 以 admin 登入，停在 "/"。 */
async function adminSession(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

/** 新 context 以 `email` 登入，停在 "/"。 */
async function userSession(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

/**
 * 點主內容區左下角的空白（首頁的引導卡；toast 在右下，避開），讓焦點離開側欄、落到 body——macOS Safari 點勾選框不聚焦它，
 * 焦點本來就在 body；這裡在 Chromium 以「點不可聚焦的地方」重現那個狀態。
 */
async function clickMainBlank(page: Page): Promise<void> {
  const main = page.getByRole("main");
  const box = await main.boundingBox();
  expect(box).not.toBeNull();
  await main.click({ position: { x: 24, y: box!.height - 24 } });
}

async function activeIsBody(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement === document.body);
}

test("A2c-3：我的筆記 Shift 範圍選三篇 → 移動到群組；確認框焦點在框內，送出後焦點回「Select」", async ({ page }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel G ${RUN}`;
  const [m1, m2, m3] = [1, 2, 3].map((i) => `E2E Sel M${i} ${RUN}`) as [string, string, string];
  const keep = `E2E Sel Keep1 ${RUN}`; // 不移：移完後「Select」仍可按，也是負向斷言的正向錨點
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const groupId = await apiCreateGroup(page, groupName);
  // 依序建：清單新到舊是 M3、M2、M1（期間沒有別的建立，三列相鄰），keep 最早建、不在範圍內。
  for (const title of [keep, m1, m2, m3]) await apiCreateNote(page, title);
  await page.goto("/");

  await showSidebarTab(page, "My notes");
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, m1);
  await toggleSelectedNote(panel, m3, { shift: true });
  await expect(panel.getByText("3 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, m2)).toBeChecked();
  await expect(noteCheckbox(panel, keep)).not.toBeChecked();

  await actionBar(page).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: groupName, exact: true }).click();
  await expect(picker).toHaveCount(0);

  // 目的地框 → 確認框：焦點交給確認框自己的自動聚焦（第一個可聚焦的是「Cancel」；✕ 在 DOM 最後），不被拉回背後的「Move to」。
  const confirm = page.getByRole("dialog", { name: "Move into group" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(confirm.getByText(`Move 3 notes into "${groupName}"?`, { exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "Move into group", exact: true }).click();
  await expect(toastWithTitle(page, `Moved 3 notes into "${groupName}"`)).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  // 送出後焦點在 body（Chromium／Firefox：送出鈕 disabled）或確認框容器（WebKit）都算「沒移到別處」→ 交給本實例的「Select」。
  // 本斷言驗最終落點；守衛的 `confirmEl` 那一支由元件測試 SA3／SA12／SA22 守。
  await expect(panel.locator("button[data-sidebar-select]")).toBeFocused();
  await expectSelectionEnded(panel);

  // 工作坊：三篇都在該群組下。
  const workspace = await showSidebarTab(page, "Workspace");
  const groupNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${groupId}"]`);
  for (const title of [m1, m2, m3]) await expect(noteLink(groupNode, title)).toBeVisible({ timeout: 15_000 });
  // 我的筆記：先等正向錨點（keep）再斷三篇不在。
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  for (const title of [m1, m2, m3]) await expect(noteLink(myNotes, title)).toHaveCount(0);
});

test("A2c-4：工作坊勾一篇群組筆記 → 有「Move to」；複製到「My notes」（目的地叫 My notes、先確認）", async ({ page }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel C ${RUN}`;
  const title = `E2E Sel C1 ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await apiCreateGroup(page, groupName);
  await page.goto("/");

  // 群組列「New note in …」建群組筆記（同 36 A2-12）：網址先換、畫面稍後才換，等新筆記的標題框（Untitled）再改標題。
  const sidebar = page.getByRole("complementary");
  await showSidebarTab(page, "Workspace");
  await sidebar.getByRole("button", { name: `New note in ${groupName}`, exact: true }).click();
  await page.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
  const titleInput = page.getByRole("textbox", NOTE_TITLE);
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await page.waitForURL(
    (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );

  const workspace = await showSidebarTab(page, "Workspace");
  await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, title);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const copyTo = actionBar(page).getByRole("button", { name: "Copy to", exact: true });
  await expect(copyTo).toBeEnabled();
  // 資料夾 PR-3b-2：工作坊有「移動到」（只在本群組的資料夾間移動）。這個群組沒有資料夾、筆記在根層 → 第一層是空的 → 停用。
  await expect(actionBar(page).getByRole("button", { name: "Move to", exact: true })).toBeDisabled();

  await copyTo.click();
  const picker = page.getByRole("dialog", { name: "Copy to" });
  const myNotesTarget = picker.getByRole("button", { name: "My notes", exact: true });
  await expect(myNotesTarget).toBeVisible();
  // 上半部（目前的群組）第一顆是「Make a copy」；分隔線之後的下半部第一顆是個人目的地，叫「My notes」（命名統一，Willie Q5；舊名不再出現）。
  const targets = picker.getByRole("list").getByRole("button");
  await expect(targets.first()).toHaveAccessibleName("Make a copy");
  await expect(targets.nth(1)).toHaveAccessibleName("My notes");
  await myNotesTarget.click();

  const confirm = page.getByRole("dialog", { name: "Copy to my notes" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "Copy to my notes", exact: true }).click();
  await expect(toastWithTitle(page, "Copied 1 note to My notes")).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  await expectSelectionEnded(panel);

  // 我的筆記多一篇同標題的副本；原篇仍在群組下。
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, title)).toHaveCount(1, { timeout: 15_000 });
  const workspaceAgain = await showSidebarTab(page, "Workspace");
  await expect(noteLink(workspaceAgain, title)).toHaveCount(1);
});

test("A2c-5：勾兩篇刪除 → 不確認、toast「Undo」→ 兩篇回到我的筆記", async ({ page }) => {
  test.setTimeout(120_000);
  const [d1, d2] = [1, 2].map((i) => `E2E Sel D${i} ${RUN}`) as [string, string];
  const keep = `E2E Sel Keep3 ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of [keep, d1, d2]) await apiCreateNote(page, title);
  await page.goto("/");

  await showSidebarTab(page, "My notes");
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, d1);
  await toggleSelectedNote(panel, d2);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await actionBar(page).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();

  const trashed = toastWithTitle(page, "Moved 2 notes to the trash");
  await expect(trashed).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0); // 移到垃圾桶不確認
  await expectSelectionEnded(panel);
  await expect(noteLink(panel, keep)).toBeVisible();
  for (const title of [d1, d2]) await expect(noteLink(panel, title)).toHaveCount(0);

  await trashed.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 2 notes")).toBeVisible({ timeout: 15_000 });
  const myNotes = await showSidebarTab(page, "My notes");
  for (const title of [d1, d2]) await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });
});

test("A2c-6：群組一般成員（沒有刪除權）勾群組筆記 → 刪除鈕 disabled、「Copy to」可按", async ({ browser }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel P ${RUN}`;
  const title = `E2E Sel P1 ${RUN}`;
  const member = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Member" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, member);
    const groupId = await apiCreateGroup(admin.page, groupName);
    await apiAddMember(admin.page, groupId, member.email);
    await apiCreateNote(admin.page, title, groupId);

    const user = await userSession(browser, member.email);
    contexts.push(user.context);
    const workspace = await showSidebarTab(user.page, "Workspace");
    await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
    const panel = await startSidebarSelection(user.page);
    await toggleSelectedNote(panel, title);
    await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
    const bar = actionBar(user.page);
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(bar.getByRole("button", { name: "Delete 1 selected item", exact: true })).toBeDisabled();
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("A2-12（多選）：「能刪不能編輯」的角色勾兩篇群組筆記刪除 → toast 沒有「Undo」、有說明句", async ({ browser }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel X ${RUN}`;
  const [x1, x2] = [1, 2].map((i) => `E2E Sel X${i} ${RUN}`) as [string, string];
  const deleter = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Deleter" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, deleter);
    const groupId = await apiCreateGroup(admin.page, groupName);
    const roleId = await apiCreateDeleteOnlyRole(admin.page, groupId, "DeleteOnly");
    await apiAddMember(admin.page, groupId, deleter.email, roleId);
    for (const title of [x1, x2]) await apiCreateNote(admin.page, title, groupId);

    const user = await userSession(browser, deleter.email);
    contexts.push(user.context);
    const workspace = await showSidebarTab(user.page, "Workspace");
    for (const title of [x1, x2]) await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
    const panel = await startSidebarSelection(user.page);
    await toggleSelectedNote(panel, x1);
    await toggleSelectedNote(panel, x2);
    await actionBar(user.page).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();

    const trashed = toastWithTitle(user.page, "Moved 2 notes to the trash");
    await expect(trashed).toBeVisible({ timeout: 15_000 });
    await expect(trashed.getByText(NO_UNDO_HINT, { exact: true })).toBeVisible();
    await expect(trashed.getByRole("button", { name: "Undo" })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("A2c-2：最近 tab 的動作列沒有「Move to」；與我共享 tab 有「Copy to」與「Move to」（沒有共享資料夾 → 停用）、沒有刪除鈕", async ({ browser }) => {
  test.setTimeout(120_000);
  const recentTitle = `E2E Sel R ${RUN}`;
  const sharedTitle = `E2E Sel S ${RUN}`;
  const guest = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Guest" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, guest);
    const sharedId = await apiCreateNote(admin.page, sharedTitle);
    const share = await admin.page.request.put(`/api/notes/${sharedId}/shares`, { data: { email: guest.email, role: "viewer" } });
    expect(share.ok(), `PUT /api/notes/${sharedId}/shares → ${share.status()} ${await share.text()}`).toBe(true);
    await apiCreateNote(admin.page, recentTitle); // 最後建：最近 tab 的第一篇
    await admin.page.goto("/");

    // ── admin 最近 tab：複製到、刪除，沒有移動到 ─────────────────────────────
    await showSidebarTab(admin.page, "Recent");
    const recentPanel = await startSidebarSelection(admin.page);
    await toggleSelectedNote(recentPanel, recentTitle);
    const adminBar = actionBar(admin.page);
    await expect(adminBar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(adminBar.getByRole("button", { name: "Delete 1 selected item", exact: true })).toBeEnabled();
    await expect(adminBar.getByRole("button", { name: "Move to" })).toHaveCount(0);

    // ── B 與我共享 tab：複製到可按；移動到（只在自己的共享資料夾間）——B 沒有共享資料夾、那篇在根層 → 停用；沒有刪除鈕 ─────
    const user = await userSession(browser, guest.email);
    contexts.push(user.context);
    const shared = await showSidebarTab(user.page, "Shared with me");
    await expect(noteLink(shared, sharedTitle)).toBeVisible({ timeout: 15_000 });
    const sharedPanel = await startSidebarSelection(user.page);
    await toggleSelectedNote(sharedPanel, sharedTitle);
    const userBar = actionBar(user.page);
    await expect(userBar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(userBar.getByRole("button", { name: "Move to", exact: true })).toBeDisabled();
    // 與我共享的刪除鈕只在選的全是資料夾時才渲染（「移除選取的資料夾」）；只選筆記 → 沒有。
    await expect(userBar.getByRole("button", { name: DELETE_SELECTED })).toHaveCount(0);
    await expect(userBar.getByRole("button", { name: /^Remove \d+ selected folders?$/ })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("A2c-7：390 寬抽屜——動作列排得進抽屜；Esc 只結束選取、抽屜不關、焦點回抽屜內的「Select」", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `E2E Sel W ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await apiCreateNote(page, title);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const myNotes = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });

  const panel = await startSidebarSelection(page, drawer);
  await toggleSelectedNote(panel, title);
  const bar = actionBar(page, drawer);
  await expect(bar).toBeVisible();
  // 三顆鈕都在抽屜的框內（T5 review r1 I1：刪除鈕曾被擠出卡片）；頁面不橫捲。
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  for (const name of ["Move to", "Copy to", "Delete 1 selected item"]) {
    const button = bar.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(drawerBox!.x);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(drawerBox!.x + drawerBox!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // 焦點在勾選框（抽屜內）：抽屜的 Esc 先結束選取、不關抽屜。
  await expect(noteCheckbox(panel, title)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeVisible();
  await expectSelectionEnded(panel);
  await expect(drawer.locator("button[data-sidebar-select]")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("A2c-8：進入選取模式不改清單的捲動位置", async ({ page }) => {
  test.setTimeout(120_000);
  const titles = Array.from({ length: 20 }, (_, i) => `E2E Sel L${String(i + 1).padStart(2, "0")} ${RUN}`);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of titles) await apiCreateNote(page, title);
  // 矮一點的視窗：單跑本案（admin 只有這 20 篇）時清單也一定可捲。
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");

  const sidebar = page.getByRole("complementary");
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, titles[0]!)).toBeVisible({ timeout: 15_000 });
  const list = sidebar.locator("[data-sidebar-list]");
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const before = await list.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(100);

  const panel = await startSidebarSelection(page);
  await expect(panel.getByRole("checkbox").first()).toBeAttached(); // 勾選樹已換上（chunk 到了）
  await expect(async () => {
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  }).toPass({ timeout: 5_000 });
});

test("A2c-7：Esc 的範圍——焦點在 body 時結束選取；標題框裡不結束；開著 toast 時第一下只關 toast", async ({ page }) => {
  test.setTimeout(150_000);
  const keep = `E2E Sel Esc K ${RUN}`;
  const opened = `E2E Sel Esc T ${RUN}`;
  const doomed = `E2E Sel Esc D ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of [keep, opened, doomed]) await apiCreateNote(page, title);
  await page.goto("/");

  // ── 第一段：滑鼠點勾選框 → 點主內容區空白（焦點落到 body）→ Esc 結束選取、焦點回「Select」 ─────────
  let myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await clickMainBlank(page);
  expect(await activeIsBody(page)).toBe(true); // 走的是 body 這條，不是焦點碰巧還在側欄
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectSelectionEnded(panel);
  await expect(panel.locator("button[data-sidebar-select]")).toBeFocused();

  // ── 第二段（順序寫死：進筆記頁會讓 AppShell 換殼、選取歸零）：先開筆記、等標題框，再進選取 → 標題框裡的 Esc 不結束選取 ──
  await noteLink(myNotes, opened).click();
  const titleInput = page.getByRole("textbox", NOTE_TITLE);
  await expect(titleInput).toHaveValue(opened, { timeout: 15_000 });
  myNotes = await showSidebarTab(page, "My notes");
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await titleInput.click();
  await page.keyboard.type("x");
  await expect(titleInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(titleInput).toBeFocused();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, keep)).toBeChecked();

  // ── 第三段：回首頁；選取刪一篇（toast 出現）→ 立刻再選取、勾一篇、焦點回 body → 第一下 Esc 只關 toast，第二下才離開 ────
  await page.goto("/");
  myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, doomed)).toBeVisible({ timeout: 15_000 });
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, doomed);
  await actionBar(page).getByRole("button", { name: "Delete 1 selected item", exact: true }).click();
  const toast = toastWithTitle(page, "Moved 1 note to the trash");
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expectSelectionEnded(panel);

  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await clickMainBlank(page);
  expect(await activeIsBody(page)).toBe(true);
  // 前提：toast 還開著（5 秒；CI 慢時失敗在這裡，不會誤判成「離開了選取」）。
  await expect(toast).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toast).toBeHidden();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, keep)).toBeChecked();
  await page.keyboard.press("Escape");
  await expectSelectionEnded(panel);
});
