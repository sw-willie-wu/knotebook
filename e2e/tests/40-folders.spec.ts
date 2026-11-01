import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createFolder,
  createUserViaInvite,
  folderMenuButton,
  folderMenuItem,
  folderRow,
  loginAs,
  openGroupPanel,
  randomEmail,
  reEscape,
  showSidebarTab,
  submitFolderName,
  toastWithTitle,
} from "./helpers.js";

/**
 * 資料夾 PR-3b-1（spec §6.18 e2e 列中本 PR 的部分；A3-1、A3-2、A3-4、A3-5、A3-8、§6.14）。
 * 每個 test 以 `createUserViaInvite` 開自己的使用者並登入它：資料夾排在根層筆記前、預設展開，留在共用的 ADMIN 帳號會改變其他 spec
 * 的可見列（plan M-8）。ADMIN 只用來發邀請。整頁載入筆記頁後碰側欄前先等「Note title」（lazy NotePage 的 fallback 會換殼）；
 * 負向斷言前先等正向錨點；toast 斷言錨定全字。
 */

const RUN = Date.now();
const PASSWORD = "e2e-folders-pw";

/** ADMIN 發邀請建一個新使用者，在 `page` 以它登入（落在 `/`）。 */
async function asNewUser(page: Page, displayName: string): Promise<string> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return email;
}

/**
 * 從資料夾的「＋」或 ⋮「New note」建的筆記：等網址第一跳（untitled）與新筆記的標題框（Untitled）→ 改標題 → 等第二跳。
 * 群組筆記走 `/g/`，個人筆記走 `/n/`。
 */
async function titleNewNote(page: Page, title: string, kind: "n" | "g"): Promise<void> {
  const first = kind === "n" ? /\/n\/[^/]+\/untitled-[0-9a-f]{8}$/ : /\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/;
  await page.waitForURL(first, { timeout: 15_000 });
  const titleInput = page.getByLabel("Note title");
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await page.waitForURL((url) => !/\/untitled-[0-9a-f]{8}$/.test(url.pathname), { timeout: 15_000 });
}

/** 資料夾列裡的筆記連結（可及名稱以標題開頭）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

test("40-1 個人資料夾全流程：建資料夾與子資料夾、在子資料夾建筆記、路徑行、改名（焦點回 ⋮）、撞名、刪除與還原", async ({ page }) => {
  test.setTimeout(180_000);
  const F = `F ${RUN}`;
  const S = `S ${RUN}`;
  const T = `T ${RUN}`;
  const title = `E2E Fold N ${RUN}`;
  await asNewUser(page, "E2E Folders One");
  const sidebar = page.getByRole("complementary");
  let panel = await showSidebarTab(page, "My notes");

  // ── 建 F、F ⋮ New subfolder → S ─────────────────────────────────────────────
  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), F);
  await folderMenuItem(page, panel, F, "New subfolder");
  await submitFolderName(page, "New folder", S);
  await expect(folderRow(folderRow(panel, F), S)).toBeVisible();

  // ── S ⋮ New note → 改標題 → 側欄 S 底下有那篇 ─────────────────────────────────
  await folderMenuItem(page, panel, S, "New note");
  await titleNewNote(page, title, "n");
  panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, S), title)).toBeVisible({ timeout: 15_000 });

  // ── 搜尋標題 → 第二行「My notes › F › S」──────────────────────────────────────
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(title);
  const result = sidebar.getByTestId("sidebar-search").getByRole("link", { name: new RegExp("^" + reEscape(title)) });
  await expect(result).toContainText(`My notes › ${F} › ${S}`);
  await search.fill("");
  panel = await showSidebarTab(page, "My notes");

  // ── 改名：先 Esc 取消 → 焦點回 S 的 ⋮（T4 審查 M-2 的長期守衛）→ 再改名成 T ──────
  await folderMenuItem(page, panel, S, "Rename");
  const renameDialog = page.getByRole("dialog", { name: "Rename folder", exact: true });
  const renameInput = renameDialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(renameInput).toBeFocused({ timeout: 15_000 });
  await expect(renameInput).toHaveValue(S);
  await page.keyboard.press("Escape");
  await expect(renameDialog).not.toBeVisible();
  await expect(folderMenuButton(panel, S)).toBeFocused();
  await folderMenuItem(page, panel, S, "Rename");
  await submitFolderName(page, "Rename folder", T);
  await expect(folderMenuButton(panel, T)).toBeFocused();
  await expect(noteLink(folderRow(panel, T), title)).toBeVisible();

  // ── 在 F 底下建只差大小寫的 t → 行內撞名錯誤、框不關 ───────────────────────────
  await folderMenuItem(page, panel, F, "New subfolder");
  const createDialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const createInput = createDialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(createInput).toBeFocused({ timeout: 15_000 });
  await createInput.fill(`t ${RUN}`);
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(createDialog.getByRole("alert")).toHaveText("There's already a folder with this name here.");
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(createDialog).not.toBeVisible();

  // ── 刪 F：確認框內文含「1 note」與「1 subfolder」→ toast → 開著的那篇在裡面 → 回首頁 ──
  await folderMenuItem(page, panel, F, "Delete folder");
  const deleteDialog = page.getByRole("dialog", { name: `Delete folder “${F}”?`, exact: true });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText("The folder and its 1 subfolder will be deleted.");
  await expect(deleteDialog).toContainText("The 1 note in it will move to the trash.");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toastWithTitle(page, "Folder deleted; 1 note moved to the trash")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/$/);

  // ── 垃圾桶 tab：那篇第二行以「F › T · 」開頭 → 還原 ─────────────────────────────
  const trash = await showSidebarTab(page, "Trash");
  const row = trash.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText(`${F} › ${T} · `, { timeout: 15_000 });
  await row.hover();
  await row.getByRole("button", { name: `Restore ${title}`, exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });

  // ── 我的筆記重新出現 F › T 與那篇（還原照原路徑重建資料夾）──────────────────────
  panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), T)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(folderRow(panel, T), title)).toBeVisible();
});

test("40-2 深度：5 層鏈的第 5 層 ⋮「New subfolder」不可執行並說明上限", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Folders Depth");
  const panel = await showSidebarTab(page, "My notes");
  const names = [1, 2, 3, 4, 5].map((i) => `D${i} ${RUN}`);
  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), names[0]!);
  for (let i = 1; i < names.length; i++) {
    await folderMenuItem(page, panel, names[i - 1]!, "New subfolder");
    await submitFolderName(page, "New folder", names[i]!);
  }
  const trigger = folderMenuButton(panel, names[4]!);
  await trigger.hover();
  await trigger.click();
  const menu = page.getByRole("menu");
  const item = menu.getByRole("menuitem", { name: "New subfolder", exact: true });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByText("Folders can be nested up to 5 levels", { exact: true })).toBeVisible();
  // 被擋項仍在焦點序裡（aria-disabled、不是 Radix disabled）；Enter 不開框、選單仍開。
  // 不用 click：Playwright 把 aria-disabled="true" 視為 disabled，click 會等到逾時。
  await item.focus();
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
});

test("40-3 排序保留：資料夾內依名稱排序，重新整理後仍是名稱、⋮ 裡 Name 已選", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `Sort ${RUN}`;
  // 依序建立 C、A、B：預設「最近修改」是 B、A、C；依名稱是 A、B、C。
  const titles = { a: `E2E Sort A ${RUN}`, b: `E2E Sort B ${RUN}`, c: `E2E Sort C ${RUN}` };
  await asNewUser(page, "E2E Folders Sort");
  let panel = await showSidebarTab(page, "My notes");
  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), F);
  for (const title of [titles.c, titles.a, titles.b]) {
    panel = await showSidebarTab(page, "My notes");
    await folderMenuItem(page, panel, F, "New note");
    await titleNewNote(page, title, "n");
  }
  panel = await showSidebarTab(page, "My notes");
  const links = folderRow(panel, F).getByRole("link");
  await expect(links).toHaveText([titles.b, titles.a, titles.c], { timeout: 15_000 });

  const trigger = folderMenuButton(panel, F);
  await trigger.hover();
  await trigger.click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true }).click();
  // 選了不關選單
  await expect(page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(links).toHaveText([titles.a, titles.b, titles.c]);

  // 整頁載入首頁（page.goto 是完整的文件載入，等同重新整理；不再另外 reload）
  await page.goto("/");
  panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(panel, F).getByRole("link")).toHaveText([titles.a, titles.b, titles.c], { timeout: 15_000 });
  const again = folderMenuButton(panel, F);
  await again.hover();
  await again.click();
  await expect(page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
});

test("40-4 群組資料夾：群組列建資料夾、在裡面建筆記；一般成員的 ⋮「Delete folder」被擋下並說明", async ({ browser }) => {
  test.setTimeout(180_000);
  const groupName = `E2E Fold G ${RUN}`;
  const GF = `GF ${RUN}`;
  const title = `E2E Fold GN ${RUN}`;
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const aPage = await aContext.newPage();
    // ADMIN 發兩張邀請：A（建群組的人）、B（之後以內建一般成員加入）
    await loginAs(aPage, ADMIN.email, ADMIN.password);
    await expect(aPage).toHaveURL(/\/$/);
    const aEmail = randomEmail();
    const bEmail = randomEmail();
    await createUserViaInvite(aPage, { email: aEmail, password: PASSWORD, displayName: "E2E Folders A" });
    await createUserViaInvite(aPage, { email: bEmail, password: PASSWORD, displayName: "E2E Folders B" });
    await aContext.clearCookies();
    await loginAs(aPage, aEmail, PASSWORD);
    await expect(aPage).toHaveURL(/\/$/);

    // ── A 建群組 G（同 15／17）─────────────────────────────────────────────────
    const sidebar = aPage.getByRole("complementary");
    let workspace = await showSidebarTab(aPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = aPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(workspace.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    // ── 群組列「New folder in G」建 GF → GF ⋮ New note ─────────────────────────────
    await createFolder(aPage, workspace.getByRole("button", { name: `New folder in ${groupName}`, exact: true }), GF);
    await folderMenuItem(aPage, workspace, GF, "New note");
    await titleNewNote(aPage, title, "g");
    workspace = await showSidebarTab(aPage, "Groups");
    await expect(noteLink(folderRow(workspace, GF), title)).toBeVisible({ timeout: 15_000 });

    // ── A 把 B 加進群組（預設內建一般成員 Member：能編輯、不能刪除）───────────────────
    await openGroupPanel(aPage, groupName);
    await aPage.getByLabel("Email address", { exact: true }).fill(bEmail);
    await aPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(aPage.getByRole("button", { name: `Remove ${bEmail}` })).toBeVisible();

    // ── B：GF ⋮ → Delete folder 不可執行、說明「This folder has notes you can't delete」──
    const bPage = await bContext.newPage();
    await loginAs(bPage, bEmail, PASSWORD);
    await expect(bPage).toHaveURL(/\/$/);
    const bWorkspace = await showSidebarTab(bPage, "Groups");
    await expect(noteLink(folderRow(bWorkspace, GF), title)).toBeVisible({ timeout: 15_000 });
    const trigger = folderMenuButton(bWorkspace, GF);
    await trigger.hover();
    await trigger.click();
    const menu = bPage.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Delete folder", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(menu.getByText("This folder has notes you can't delete", { exact: true })).toBeVisible();
    await bPage.keyboard.press("Escape");
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("40-5 390 抽屜：長名稱資料夾、用它的「＋」建筆記，清單內層包層沒有任何列超出", async ({ page }) => {
  test.setTimeout(120_000);
  const longName = `F ${RUN} ${"Long folder name for the narrow drawer ".repeat(2).slice(0, 60)}`.trimEnd();
  const title = `E2E Fold Narrow ${RUN}`;
  await asNewUser(page, "E2E Folders Narrow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const openDrawer = async (): Promise<Locator> => {
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    return drawer;
  };

  let drawer = await openDrawer();
  let drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await createFolder(page, drawerPanel.getByRole("button", { name: "New folder", exact: true }), longName);
  const plus = drawerPanel.getByRole("button", { name: `New note in ${longName}`, exact: true });
  await plus.hover();
  await plus.click();
  await titleNewNote(page, title, "n");

  // 整頁換成筆記頁：碰側欄前先等「Note title」，再重開抽屜
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  if (!(await page.getByRole("dialog", { name: "Navigation" }).isVisible())) drawer = await openDrawer();
  drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(folderRow(drawerPanel, longName), title)).toBeVisible({ timeout: 15_000 });
  // 清單內層包層是 overflow-x-clip（安全網）：清單本身恆不溢出，量包層的內容寬度。淺層在 256 寬抽屜裡不該有任何列超出。
  const wrapper = drawerPanel.locator("[data-sidebar-list] > div");
  expect(await wrapper.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
