import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  clickMenuItemByPointer,
  createFolder,
  createUserViaInvite,
  expectWidePointer,
  folderRow,
  loginAs,
  openedSubmenu,
  pickDestination,
  pickNoteMenuDestination,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * 資料夾（e2e 列中本 PR 的部分）：⋮「Move to…／Copy to…」逐層子選單、
 * 選取模式的批次移動、與我共享的私人資料夾、群組 tab 跨群組、刪群組的資料夾說明。
 * 每個 test 以 `createUserViaInvite` 開自己的使用者並登入它（資料夾排在根層筆記前、預設展開，留在共用的 ADMIN 帳號會改變其他 spec
 * 的可見列）；ADMIN 只發邀請。資料以 API 建（建筆記不帶 content 不吃寫入節流；本檔只複製 2 篇），建完 `goto("/")` 讓側欄重抓——
 * 只有 41-3 的群組資料夾用群組列「New folder in」建。負向斷言前先等正向錨點；toast 斷言錨定全字。
 * 不斷言子選單換層後的焦點，只有 41-2 斷鍵盤進層後的聚焦。
 *
 * （寬窄判準見 helpers 的 `expectWidePointer`）：e2e 預設視窗 1280 落在寬——⋮ 的「Move to…／
 * Copy to…」是往旁層疊的 Radix 巢狀子選單（SubTrigger 不帶「, open」、沒有「Back」）、選取工具列在標題列；41-6、41-12 用 390 走窄形。
 * 41-10～41-13 是本 PR 新增。點 `aria-disabled` 的鈕一律 `click({ force: true })`（Playwright 的 click 會等 enabled，aria-disabled 算停用）。
 */

const RUN = Date.now();
const PASSWORD = "e2e-folders-move-pw";
type FolderParent = { parentId: string } | { space: { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string } };

/** ADMIN 發邀請建一個新使用者，在 `page` 以它登入（落在 `/`）。回傳 email。 */
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

/** POST /api/folders（根層帶 `space`、子資料夾帶 `parentId`）；回傳 id。 */
async function apiCreateFolder(page: Page, name: string, parent: FolderParent): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 建一篇筆記（不帶 content：不吃寫入節流）；可帶 `groupId`、`folderId`。回傳 id。 */
async function apiCreateNote(page: Page, title: string, place: { groupId?: string; folderId?: string } = {}): Promise<string> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 建群組（建立者＝內建管理員）；回傳 id。 */
async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 以 `page` 的身分讀 `GET /api/notes`，回傳那篇的 `folderId`（呼叫者視角的放置）。 */
async function folderIdOf(page: Page, noteId: string): Promise<string | null> {
  const res = await page.request.get("/api/notes");
  expect(res.status()).toBe(200);
  const note = ((await res.json()) as Array<{ id: string; folderId: string | null }>).find((n) => n.id === noteId);
  if (note === undefined) throw new Error(`GET /api/notes 裡沒有 ${noteId}`);
  return note.folderId;
}

/** 側欄筆記連結（可及名稱以標題開頭）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** 側欄筆記列的 ⋮（hover 浮出，先 hover 再點）；同名多篇時取第一篇。等選單出現。 */
async function openNoteActions(page: Page, scope: Locator, title: string): Promise<void> {
  const button = scope.getByRole("button", { name: `Note actions for ${title}`, exact: true }).first();
  await button.hover();
  await button.click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** 選取動作列（窄形在側欄底部、tabpanel 外；寬形在標題列）。`scope` 預設靜態側欄。 */
function actionBar(page: Page, scope?: Locator): Locator {
  return (scope ?? page.getByRole("complementary")).locator("[data-select-action-bar]");
}

/** 選取模式的勾選框（整列是 `<label>`，可及名稱以標題／資料夾名開頭；同 `toggleSelectedNote` 的找法）。 */
function selectionBox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

/** ⋮ 開著、寬形：打開「Move to…」子選單，回傳它的第一層（層疊）。 */
async function openMoveCascade(page: Page): Promise<Locator> {
  await pickNoteMenuDestination(page, "Move to…", []);
  return openedSubmenu(page, page.getByRole("menuitem", { name: "Move to…", exact: true }));
}

test("41-1 ⋮ 寬形層疊移動與復原（1280）：第一層沒有 Top level、F 是 SubTrigger（不帶「, open」）→ 第二層 Move here／F1、沒有 Back → toast → Undo 回根層", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv One ${RUN}`;
  await asNewUser(page, "E2E Move One");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), F1)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  // ── 第一層：N 在根層 → 沒有「Top level」；F 有子資料夾 → SubTrigger（aria-haspopup），名稱就是「F」──────────
  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  const fTrigger = first.getByRole("menuitem", { name: F, exact: true });
  await expect(fTrigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(first.getByRole("menuitem", { name: "Top level", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /, open$/ })).toHaveCount(0);

  // ── 移到 F → 往旁再疊一層（第一層仍開）：恰是 Move here、F1（F1 沒有子資料夾 → 一般項）；沒有「Back」────────
  await clickMenuItemByPointer(page, F, first);
  const second = await openedSubmenu(page, fTrigger);
  await expect(second.getByRole("menuitem")).toHaveCount(2);
  for (const name of ["Move here", F1]) await expect(second.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await expect(first).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);

  // ── 選 F1 → 同空間移動不確認 → toast「Moved to “F1”」、N 在 F1 底下 → Undo → 回根層 ─────────
  await clickMenuItemByPointer(page, F1, second);
  const moved = toastWithTitle(page, `Moved to “${F1}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // 指標停在 toast 上：Radix 的 5 秒計時暫停，側欄斷言與 Undo 之間 toast 不會自己收掉。
  await moved.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("41-2 寬形層疊鍵盤：ArrowRight 開子選單與下一層（Move here 聚焦）、ArrowLeft 收一層、Esc 每次只收一層、第三下才關選單", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv Keys ${RUN}`;
  await asNewUser(page, "E2E Move Keys");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), F1)).toBeVisible({ timeout: 15_000 });

  // ── 鍵盤開 ⋮（Enter：第一項聚焦）→ 方向鍵移到「Move to…」────────────────────────────
  const trigger = panel.getByRole("button", { name: `Note actions for ${N}`, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const moveTo = page.getByRole("menuitem", { name: "Move to…", exact: true });
  await expect(moveTo).toBeVisible();
  // Radix 的方向鍵是在 keydown 之後用 setTimeout 才搬焦點，按完鍵立刻讀 activeElement 會讀到舊值。
  // 所以每按一下都等焦點真的落到下一項再按下一次，不然會多按，停在「Copy to…」。
  const mainItems = page.getByRole("menu").locator('[role="menuitem"]:not([data-disabled])');
  await expect(mainItems.first()).toBeFocused();
  const moveToIndex = await moveTo.evaluate((el) => {
    const menu = el.closest('[role="menu"]');
    return menu === null ? -1 : Array.from(menu.querySelectorAll('[role="menuitem"]:not([data-disabled])')).indexOf(el);
  });
  expect(moveToIndex).toBeGreaterThan(0);
  for (let i = 1; i <= moveToIndex; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(mainItems.nth(i)).toBeFocused();
  }
  await expect(moveTo).toBeFocused();

  // ── ArrowRight 開「Move to…」子選單（焦點進第一項 F）→ 在 F（SubTrigger）上 ArrowRight 再疊一層 →「Move here」聚焦 ────
  // 鍵盤開子選單時 Radix 把焦點交給新層的第一個可用項（滑鼠 hover 開則不會）。
  const fItem = page.getByRole("menuitem", { name: F, exact: true });
  const moveHere = page.getByRole("menuitem", { name: "Move here", exact: true });
  await page.keyboard.press("ArrowRight");
  await expect(fItem).toBeFocused();
  await expect(fItem).toHaveAttribute("aria-haspopup", "menu");
  await page.keyboard.press("ArrowRight");
  await expect(moveHere).toBeFocused();
  await expect(page.getByRole("menuitem", { name: F1, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);

  // ── ArrowLeft：只收 F 那一層、焦點回 F，「Move to…」的子選單仍開 ──────────────────────────────
  await page.keyboard.press("ArrowLeft");
  await expect(fItem).toBeFocused();
  await expect(moveHere).toHaveCount(0);

  // ── 再進 F 那一層 → Esc 只收 F 那一層→ 再 Esc 收「Move to…」、主選單仍開 → 第三下才關整個選單 ────
  await page.keyboard.press("ArrowRight");
  await expect(moveHere).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(moveHere).toHaveCount(0);
  await expect(fItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fItem).toHaveCount(0);
  await expect(moveTo).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("41-3 ⋮ 複製：Make a copy 落在同一資料夾；Copy to… 群組資料夾（確認框帶完整路徑）", async ({ page }) => {
  test.setTimeout(180_000);
  const F = `F ${RUN}`;
  const G = `E2E Mv G3 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Copy ${RUN}`;
  await asNewUser(page, "E2E Move Copy");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N, { folderId: fId });
  await apiCreateGroup(page, G);
  await page.goto("/");

  // ── 群組列「New folder in G」建 GF ───────────────────────────────────────────────
  const workspace = await showSidebarTab(page, "Groups");
  await createFolder(page, workspace.getByRole("button", { name: `New folder in ${G}`, exact: true }), GF);

  // ── N（在 F）⋮ → Copy to… → Make a copy → 確認 → F 底下兩篇同名 ───────────────────────
  let panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await openNoteActions(page, panel, N);
  await pickNoteMenuDestination(page, "Copy to…", ["Make a copy"]);
  const makeCopy = page.getByRole("dialog", { name: "Make a copy" });
  await expect(makeCopy).toBeVisible();
  await makeCopy.getByRole("button", { name: "Make a copy", exact: true }).click();
  await expect(toastWithTitle(page, "Copied to your notes")).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(2, { timeout: 15_000 });

  // ── Copy to… →「G, open」→「GF」→ 確認框說明含「G › GF」→ 確認 → 群組 G › GF 底下有副本 ─────────
  await openNoteActions(page, panel, N);
  await pickNoteMenuDestination(page, "Copy to…", [`${G}, open`, GF]);
  const copyInto = page.getByRole("dialog", { name: "Copy into group" });
  await expect(copyInto).toBeVisible();
  await expect(copyInto).toContainText(`This creates a copy in "${G} › ${GF}"; the original stays as it is.`);
  await copyInto.getByRole("button", { name: "Copy into group", exact: true }).click();
  await expect(toastWithTitle(page, `Copied into "${G}"`)).toBeVisible({ timeout: 15_000 });
  const workspaceAgain = await showSidebarTab(page, "Groups");
  await expect(noteLink(folderRow(workspaceAgain, GF), N)).toBeVisible({ timeout: 15_000 });
  // 原篇仍在 F（兩篇：原篇＋同資料夾副本）
  panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(2);
});

test("41-4 ⋮ 個人筆記移入群組資料夾：確認框帶完整路徑、焦點在 Cancel → 網址變 /g/…、G › GF 底下有它", async ({ page }) => {
  test.setTimeout(150_000);
  const G = `E2E Mv G4 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Into ${RUN}`;
  await asNewUser(page, "E2E Move Into");
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await apiCreateNote(page, N);
  await page.goto("/");

  // ── 開那篇（SPA 導覽：等標題框是 N 才碰別的）→ 頁首 ⋮ → Move to… →「G, open」→「GF」─────────────
  const panel = await showSidebarTab(page, "My notes");
  await noteLink(panel, N).click();
  const titleInput = page.getByRole("textbox", { name: "Note title" });
  await expect(titleInput).toHaveValue(N, { timeout: 15_000 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await pickNoteMenuDestination(page, "Move to…", [`${G}, open`, GF]);

  const confirm = page.getByRole("dialog", { name: "Move into group" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`Move this note into "${G} › ${GF}"?`);
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  // 送出鈕在 shares／public-link 兩支都到之前停用；click 會等它可用。
  await confirm.getByRole("button", { name: "Move into group", exact: true }).click();
  await expect(toastWithTitle(page, `Moved into "${G} › ${GF}"`)).toBeVisible({ timeout: 15_000 });

  // ── 網址變 /g/<G>/…，且畫面已換成那篇 ────────────────────────────────────────────
  await expect(page).toHaveURL(new RegExp(`/g/${groupId}/[^/]+$`), { timeout: 15_000 });
  await expect(titleInput).toHaveValue(N, { timeout: 15_000 });
  const workspace = await showSidebarTab(page, "Groups");
  await expect(noteLink(folderRow(workspace, GF), N)).toBeVisible({ timeout: 15_000 });
});

test("41-5 選取模式：勾兩篇 → Move to → F → Move here（不確認）→ toast → Undo 回根層；勾資料夾時 Copy to 停用", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const [a, b] = [`E2E Mv Sel A ${RUN}`, `E2E Mv Sel B ${RUN}`];
  await asNewUser(page, "E2E Move Select");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const aId = await apiCreateNote(page, a);
  const bId = await apiCreateNote(page, b);
  await page.goto("/");
  await showSidebarTab(page, "My notes");

  // ── 勾兩篇 → Move to → 目的地框「F, open」→「Move here」→ 沒有確認框 → toast ──────────────
  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, a);
  await toggleSelectedNote(panel, b);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await actionBar(page).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  const moved = toastWithTitle(page, `Moved 2 items to “${F}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // 指標停在 toast 上：Radix 的 5 秒計時暫停，側欄斷言與 Undo 之間 toast 不會自己收掉。
  await moved.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const title of [a, b]) await expect(noteLink(folderRow(panel, F), title)).toBeVisible({ timeout: 15_000 });

  // ── Undo → 兩篇回根層 ───────────────────────────────────────────────────────────
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  for (const id of [aId, bId]) await expect.poll(() => folderIdOf(page, id), { timeout: 15_000 }).toBeNull();
  panel = await showSidebarTab(page, "My notes");
  for (const title of [a, b]) {
    await expect(noteLink(panel, title)).toBeVisible();
    await expect(noteLink(folderRow(panel, F), title)).toHaveCount(0, { timeout: 15_000 });
  }

  // ── 勾資料夾 F1 → Copy to 停用、說明「Folders can't be copied」──────────────────────
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, F1);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const copyTo = actionBar(page).getByRole("button", { name: "Copy to", exact: true });
  await expect(copyTo).toBeDisabled();
  await expect(copyTo).toHaveAttribute("title", "Folders can't be copied");
});

test("41-6 390 抽屜：⋮ Move to… 就地展開、點「F, open」縮排區出現 Back → 選 F1；同抽屜選取模式移到 F", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv Narrow ${RUN}`;
  const M = `E2E Mv Narrow Sel ${RUN}`;
  await asNewUser(page, "E2E Move Narrow");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, N);
  await apiCreateNote(page, M);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectWidePointer(page, false);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(drawerPanel, N)).toBeVisible({ timeout: 15_000 });

  // ── ⋮ → Move to…（就地展開，不是 flyout）→「F, open」→ 縮排區出現 Back → F1 → toast ────────────
  await openNoteActions(page, drawerPanel, N);
  await expect(page.getByRole("menuitem", { name: "Move to…", exact: true })).not.toHaveAttribute("aria-haspopup", "menu");
  await pickNoteMenuDestination(page, "Move to…", [`${F}, open`]);
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: F1, exact: true }).click();
  await expect(toastWithTitle(page, `Moved to “${F1}”`)).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(noteLink(folderRow(drawerPanel, F1), N)).toBeVisible({ timeout: 15_000 });

  // ── 同一抽屜：Select → 勾 M → Move to →「F, open」→「Move here」→ toast ──────────────────
  const panel = await startSidebarSelection(page, drawer);
  await toggleSelectedNote(panel, M);
  await actionBar(page, drawer).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  await expect(toastWithTitle(page, `Moved 1 item to “${F}”`)).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(noteLink(folderRow(drawerPanel, F), M)).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("41-7 與我共享：B 建共享資料夾 SF、把 A 分享的那篇移進去；A 那邊 folderId 仍是 null", async ({ browser }) => {
  test.setTimeout(150_000);
  const SF = `SF ${RUN}`;
  const title = `E2E Mv Shared ${RUN}`;
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const aPage = await aContext.newPage();
    await loginAs(aPage, ADMIN.email, ADMIN.password);
    await expect(aPage).toHaveURL(/\/$/);
    const aEmail = randomEmail();
    const bEmail = randomEmail();
    await createUserViaInvite(aPage, { email: aEmail, password: PASSWORD, displayName: "E2E Move Sharer" });
    await createUserViaInvite(aPage, { email: bEmail, password: PASSWORD, displayName: "E2E Move Guest" });
    await aContext.clearCookies();
    await loginAs(aPage, aEmail, PASSWORD);
    await expect(aPage).toHaveURL(/\/$/);

    // ── A 建一篇、逐人分享給 B（viewer）──────────────────────────────────────────────
    const noteId = await apiCreateNote(aPage, title);
    const share = await aPage.request.put(`/api/notes/${noteId}/shares`, { data: { email: bEmail, role: "viewer" } });
    expect(share.ok(), `PUT /api/notes/${noteId}/shares → ${share.status()} ${await share.text()}`).toBe(true);

    // ── B：與我共享 → New folder SF → 那篇 ⋮ → Move to… → SF → toast、SF 底下有它 ─────────────
    const bPage = await bContext.newPage();
    await loginAs(bPage, bEmail, PASSWORD);
    await expect(bPage).toHaveURL(/\/$/);
    const shared = await showSidebarTab(bPage, "Shared with me");
    await expect(noteLink(shared, title)).toBeVisible({ timeout: 15_000 });
    await createFolder(bPage, shared.getByRole("button", { name: "New folder", exact: true }), SF);
    await openNoteActions(bPage, shared, title);
    await pickNoteMenuDestination(bPage, "Move to…", [SF]);
    await expect(toastWithTitle(bPage, `Moved to “${SF}”`)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(folderRow(shared, SF), title)).toBeVisible({ timeout: 15_000 });

    // ── 放置只是 B 自己的分類：B 看得到 folderId（正向錨點）、A 看到的仍是 null ──────────────────
    await expect.poll(() => folderIdOf(bPage, noteId), { timeout: 15_000 }).not.toBeNull();
    expect(await folderIdOf(aPage, noteId)).toBeNull();
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("41-8 群組 tab 跨群組：勾 G、H 各一篇 → Move to 停用、title 說明不同群組不能一起移", async ({ page }) => {
  test.setTimeout(120_000);
  const G = `E2E Mv G8 ${RUN}`;
  const H = `E2E Mv H8 ${RUN}`;
  const [inG, inH] = [`E2E Mv InG ${RUN}`, `E2E Mv InH ${RUN}`];
  await asNewUser(page, "E2E Move Across");
  const gId = await apiCreateGroup(page, G);
  const hId = await apiCreateGroup(page, H);
  await apiCreateNote(page, inG, { groupId: gId });
  await apiCreateNote(page, inH, { groupId: hId });
  await page.goto("/");

  const workspace = await showSidebarTab(page, "Groups");
  for (const title of [inG, inH]) await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, inG);
  await toggleSelectedNote(panel, inH);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  const bar = actionBar(page);
  await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
  const moveTo = bar.getByRole("button", { name: "Move to", exact: true });
  await expect(moveTo).toBeDisabled();
  await expect(moveTo).toHaveAttribute("title", "The selected notes are in different groups and can't be moved together");
});

test("41-9 刪群組說明：有資料夾的群組 ⋮ → Delete group → 轉移模式說明資料夾會移到接手者的筆記", async ({ page }) => {
  test.setTimeout(120_000);
  const displayName = "E2E Move Owner";
  const G = `E2E Mv G9 ${RUN}`;
  const GF = `GF ${RUN}`;
  await asNewUser(page, displayName);
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await page.goto("/");

  const workspace = await showSidebarTab(page, "Groups");
  await expect(folderRow(workspace, GF)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${G}` }).click();
  await page.getByRole("menuitem", { name: "Delete group" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete group?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
  await expect(
    dialog.getByText(`The group's folders move into ${displayName}'s notes, under a folder named after the group.`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("41-10 寬形層疊的反灰與群組根目錄：N 在 F1 → F1 那一層 Move here 反灰、F2 可按；群組 G 那一層第一項 Top level、第二項 GF", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const F2 = `F2 ${RUN}`;
  const G = `E2E Mv G10 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Cascade ${RUN}`;
  await asNewUser(page, "E2E Move Cascade");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const f1Id = await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateFolder(page, F2, { parentId: f1Id });
  await apiCreateNote(page, N, { folderId: f1Id });
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });

  // ── Move to… → F：「Move here」可按（N 不在 F 本身）、F1 是 SubTrigger 且可按（A 本身仍可展開）────────────
  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  const fTrigger = first.getByRole("menuitem", { name: F, exact: true });
  await clickMenuItemByPointer(page, F, first);
  const fLevel = await openedSubmenu(page, fTrigger);
  await expect(fLevel.getByRole("menuitem", { name: "Move here", exact: true })).toBeEnabled();
  const f1Trigger = fLevel.getByRole("menuitem", { name: F1, exact: true });
  await expect(f1Trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(f1Trigger).toBeEnabled();

  // ── F1（N 所在）那一層：「Move here」反灰（Radix disabled＝aria-disabled）、F2 可按 ─────────────────────
  await clickMenuItemByPointer(page, F1, fLevel);
  const f1Level = await openedSubmenu(page, f1Trigger);
  await expect(f1Level.getByRole("menuitem", { name: F2, exact: true })).toBeEnabled();
  await expect(f1Level.getByRole("menuitem", { name: "Move here", exact: true })).toBeDisabled();

  // ── Esc 兩下回到第一層（每下只收一層）──────────────────────────────────────────
  await page.keyboard.press("Escape");
  await expect(f1Level).toHaveCount(0);
  await expect(fLevel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fLevel).toHaveCount(0);
  await expect(first).toBeVisible();

  // ── 群組 G（有資料夾 GF → SubTrigger）那一層：第一項「Top level」、第二項 GF ────────────────────────
  const gTrigger = first.getByRole("menuitem", { name: G, exact: true });
  await expect(gTrigger).toHaveAttribute("aria-haspopup", "menu");
  await clickMenuItemByPointer(page, G, first);
  const gLevel = await openedSubmenu(page, gTrigger);
  const gItems = gLevel.getByRole("menuitem");
  await expect(gItems.nth(0)).toHaveAccessibleName("Top level");
  await expect(gItems.nth(1)).toHaveAccessibleName(GF);
});

test("41-11 寬形選取工具列（1280）：✕ 聚焦、三態全選框、底部沒有 New note；標題列 Move to 批次移動 → 焦點回 Select；✕ 上按 Esc 結束", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const [n1, n2] = [`E2E Mv Tb N1 ${RUN}`, `E2E Mv Tb N2 ${RUN}`];
  await asNewUser(page, "E2E Move Toolbar");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, n1);
  await apiCreateNote(page, n2);
  await page.goto("/");
  await expectWidePointer(page, true);
  const sidebar = page.getByRole("complementary");
  const newNote = sidebar.getByRole("button", { name: "New note", exact: true });
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(myNotes, F), F1)).toBeVisible({ timeout: 15_000 });
  for (const title of [n1, n2]) await expect(noteLink(myNotes, title)).toBeVisible();
  await expect(newNote).toBeVisible();

  // ── Select → 焦點在 ✕（沒有「Done」）、全選框未勾、底部不顯示（沒有 New note）→ 焦點在 ✕ 上按 Esc → 結束、焦點回 Select ─────
  let panel = await startSidebarSelection(page);
  const exit = panel.getByRole("button", { name: "Exit selection", exact: true });
  const selectButton = panel.locator("button[data-sidebar-select]");
  const selectAll = panel.getByRole("checkbox", { name: "Select all", exact: true });
  await expect(exit).toBeFocused();
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(selectAll).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty("indeterminate", false);
  await expect(newNote).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selectButton).toBeFocused();
  await expect(selectAll).toHaveCount(0);
  await expect(newNote).toBeVisible();

  // ── 再 Select → 勾 N1 → 全選框半勾 → 點它：可見列（F、F1、N1、N2）全勾 → 再點：全不勾 ──────────────────
  panel = await startSidebarSelection(page);
  await expect(exit).toBeFocused();
  await toggleSelectedNote(panel, n1);
  await expect(selectAll).toBeChecked({ indeterminate: true });
  await selectAll.click();
  for (const name of [F, F1, n1, n2]) await expect(selectionBox(panel, name)).toBeChecked();
  await expect(selectAll).toBeChecked();
  await expect(panel.getByText("4 selected", { exact: true })).toBeVisible();
  await selectAll.click();
  await expect(panel.getByText("0 selected", { exact: true })).toBeVisible();
  for (const name of [F, F1, n1, n2]) await expect(selectionBox(panel, name)).not.toBeChecked();
  await expect(selectAll).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty("indeterminate", false);

  // ── 勾 N1、N2 → 標題列工具列的「Move to」→ 目的地框 F → Move here → toast → 焦點回 Select、New note 回來 ───────────
  await toggleSelectedNote(panel, n1);
  await toggleSelectedNote(panel, n2);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  const toolbar = panel.locator("[data-sidebar-header] [data-select-action-bar]");
  await toolbar.getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  await expect(toastWithTitle(page, `Moved 2 items to “${F}”`)).toBeVisible({ timeout: 15_000 });
  await expect(selectButton).toBeFocused();
  await expect(newNote).toBeVisible();
  for (const title of [n1, n2]) await expect(noteLink(folderRow(myNotes, F), title)).toBeVisible({ timeout: 15_000 });
});

test("41-12 390 窄形：勾資料夾 → 底部 Copy to 反灰（aria-disabled、title 說明）、點了出同字 toast、不開目的地框；Move to 與 Copy to 同為外框鈕", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Mv Soft ${RUN}`;
  const reason = "Folders can't be copied";
  await asNewUser(page, "E2E Move Soft");
  await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectWidePointer(page, false);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(folderRow(drawerPanel, F)).toBeVisible({ timeout: 15_000 });

  const panel = await startSidebarSelection(page, drawer);
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await toggleSelectedNote(panel, F);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const bar = actionBar(page, drawer);
  const copyTo = bar.getByRole("button", { name: "Copy to", exact: true });
  const moveTo = bar.getByRole("button", { name: "Move to", exact: true });
  await expect(moveTo).toBeVisible();
  await expect(copyTo).toBeDisabled();
  await expect(copyTo).toHaveAttribute("aria-disabled", "true");
  await expect(copyTo).toHaveAttribute("title", reason);

  // ── 點反灰的 Copy to（aria-disabled：force）→ 出同字 toast、不開目的地框、選取保留 ─────────────────────
  await copyTo.click({ force: true });
  await expect(toastWithTitle(page, reason)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Copy to" })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();

  // ── 兩顆同為外框鈕：不斷言顏色，只斷言 class 字面相同（反灰的樣子是 aria-disabled: 變體，兩顆恆帶）─────────────
  expect(await moveTo.getAttribute("class")).toBe(await copyTo.getAttribute("class"));
});

test("41-13 跨寬窄判準：⋮ 層疊開著時縮到 700 → 選單全關；選取中縮到 390 → 抽屜裡是窄形（1 selected、Done、底部動作列）", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Mv Flip ${RUN}`;
  await asNewUser(page, "E2E Move Flip");
  await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(panel, N)).toBeVisible({ timeout: 15_000 });
  await expect(folderRow(panel, F)).toBeVisible();

  // ── ⋮ → Move to… 層疊開著 → 寬度縮到 700（< 48rem）→ 整個選單關掉 ─────────────────────────────────
  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  await expect(first.getByRole("menuitem", { name: F, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 700, height: 720 });
  await expectWidePointer(page, false);
  await expect(page.getByRole("menu")).toHaveCount(0);

  // ── 回 1280 → Select → 勾 N → 縮到 390 → 開抽屜：選取與已勾保留、標題列是窄形、底部動作列在 ─────────────────
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectWidePointer(page, true);
  const selecting = await startSidebarSelection(page);
  await toggleSelectedNote(selecting, N);
  await expect(selecting.getByText("1 selected", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectWidePointer(page, false);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerPanel = drawer.getByRole("tabpanel");
  await expect(drawerPanel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(drawerPanel.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(drawerPanel.getByRole("button", { name: "Exit selection", exact: true })).toHaveCount(0);
  await expect(selectionBox(drawerPanel, N)).toBeChecked();
  const bar = actionBar(page, drawer);
  await expect(bar.getByRole("button", { name: "Move to", exact: true })).toBeVisible();
  await expect(drawerPanel.locator("[data-sidebar-header] [data-select-action-bar]")).toHaveCount(0);
});
