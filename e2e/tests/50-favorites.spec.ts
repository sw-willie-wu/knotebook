import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  expectWidePointer,
  loginAs,
  moveNoteToTrashFromSidebar,
  noteIdFromUrl,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * 側欄的「Favorites」tab 與筆記頁頁首的星號：
 * 1. 頁首星號加入、最愛 tab 依加入時間新到舊、每列第二行是位置；側欄 ⋮ 移出要先確認（取消不移、確認後沒有 Undo、焦點落在相鄰的一列）；
 *    頁首星號移出同樣先確認，再加入不確認；移到垃圾桶的最愛從側欄消失，toast 的 Undo 讓它回到原位。
 * 2. 最愛是每個人自己的：群組成員 alice 加入的群組筆記，同群組的 bob 看不到。
 * 3. 窄寬：390 寬抽屜裡六顆 tab 放得下不橫向捲動；側欄縮到最窄（200）時六顆都在 tab 列內。
 * 4. 390 寬、兩位其他人在同一篇時，頁首的星號、分享、⋮ 都不被卡片裁掉、也不擠進頁首的右內距；鍵盤 Space 切換後焦點仍在星號；
 *    320 寬星號收起，⋮ 選單的第一項接手。
 * 5. 公開分享頁沒有星號。
 * 6. 最愛 tab 的選取模式：勾兩篇移出（先確認、沒有 Undo、動作列沒有 Move to）；剩下的全部移出後清單空了，焦點留在面板而不是掉到 body；
 *    390 寬抽屜的動作列（只放圖示、靠可及名稱找鈕）同樣先確認再移出。
 *
 * 每個測試都用新建的帳號（alice、bob、carol 加 RUN 後綴），最愛清單不受別支 spec 影響；群組與筆記留著不清（疊每次 `stack:down -v` 重置）。
 * 所有按鈕查詢都用 `exact: true`：Playwright 預設是不分大小寫的子字串比對，「Favorite」會撞到「Add to favorites」「Remove from favorites」。
 */

const RUN = Date.now();
const PASSWORD = "e2e-favorites-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const EMPTY_FAVORITES = "No favorites yet. Click the star at the top of a note, or choose Add to favorites in its ⋮ menu.";

interface Account {
  email: string;
  displayName: string;
}

/** 以 admin 的邀請建一個帳號（admin 的 context 用完即關）。 */
async function createAccount(browser: Browser, name: string): Promise<Account> {
  const account: Account = { email: randomEmail(), displayName: `${name} ${RUN}` };
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...account, password: PASSWORD });
  } finally {
    await context.close();
  }
  return account;
}

async function openAs(browser: Browser, account: Account, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return { context, page };
}

/** 側欄裡某篇筆記的連結（可及名稱以標題開頭，後面接位置行）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** 最愛 tab 的列文字：標題＋第二行位置。 */
function favoriteRow(title: string, location: string): RegExp {
  return new RegExp("^" + reEscape(title) + "\\s*" + reEscape(location) + "$");
}

function star(page: Page): Locator {
  return page.getByRole("button", { name: "Favorite", exact: true });
}

/** 整頁載入筆記頁後先等標題框：lazy 筆記頁的 fallback 殼會換掉側欄、重設抽屜。 */
async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
}

async function openNoteFromSidebar(page: Page, tab: "My notes" | "Favorites", title: string): Promise<void> {
  const panel = await showSidebarTab(page, tab);
  await noteLink(panel, title).click();
  await waitForNoteTitle(page, title);
}

/** 檢視者連上：標題（h1）與徽章只寫「Read-only」。 */
async function waitViewerConnected(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
}

test("頁首星號與側欄 ⋮：加入、依時間排序、移出先確認、移到垃圾桶再還原", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const a = `E2E fav A ${RUN}`;
    const b = `E2E fav B ${RUN}`;
    await createNote(page, a);
    await createNote(page, b);

    // 1. B 頁按頁首星號，再到 A 頁按；最愛 tab 新加入的在前
    await expect(star(page)).toBeEnabled();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await openNoteFromSidebar(page, "My notes", a);
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");

    const favorites = await showSidebarTab(page, "Favorites");
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(a, "My notes"), favoriteRow(b, "My notes")]);

    // 2. 側欄 ⋮ 移出 B：取消不動，再來一次按確認；沒有 Undo，焦點落在上一列（A）
    const actionsB = favorites.getByRole("button", { name: `Note actions for ${b}`, exact: true });
    await actionsB.hover();
    await actionsB.click();
    await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(noteLink(favorites, b)).toBeVisible();

    await actionsB.hover();
    await actionsB.click();
    await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(noteLink(favorites, b)).toHaveCount(0, { timeout: 15_000 });
    await expect(noteLink(favorites, a)).toBeFocused();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);

    // 3. A 頁（已加入）：星號要確認才移出；再按加入不確認
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await star(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await expect(dialog).toBeHidden();
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toHaveCount(0);

    // 4. 開著 B（對開著的那篇從側欄移到垃圾桶會導回首頁，所以不停在 A），把 B 再加入；A 從最愛 tab 移到垃圾桶，Undo 讓它回到原位
    await openNoteFromSidebar(page, "My notes", b);
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await showSidebarTab(page, "Favorites");
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes"), favoriteRow(a, "My notes")]);

    const toast = await moveNoteToTrashFromSidebar(page, a);
    await expect(noteLink(favorites, a)).toHaveCount(0);
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes")]);
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes"), favoriteRow(a, "My notes")], { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test("最愛是每個人自己的：同群組的 bob 看不到 alice 加入的群組筆記", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  try {
    const groupRes = await a.page.request.post("/api/groups", { data: { name: `E2E fav group ${RUN}` } });
    expect(groupRes.status(), await groupRes.text()).toBe(201);
    const groupId = ((await groupRes.json()) as { id: string }).id;
    const added = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBeLessThan(300);
    const title = `E2E fav C ${RUN}`;
    const created = await a.page.request.post("/api/notes", { data: { title, groupId } });
    expect(created.status(), await created.text()).toBe(201);
    const note = (await created.json()) as { id: string; slug: string };

    await a.page.goto(`/g/${groupId}/${note.slug}`);
    await waitForNoteTitle(a.page, title);
    await expect(star(a.page)).toBeEnabled();
    await star(a.page).click();
    await expect(star(a.page)).toHaveAttribute("aria-pressed", "true");
    const mine = await showSidebarTab(a.page, "Favorites");
    await expect(mine.getByRole("link")).toHaveText([favoriteRow(title, `Groups › E2E fav group ${RUN}`)]);

    // bob 讀得到這篇，但最愛 tab 是空的
    const readable = await b.page.request.get(`/api/notes/${note.id}`);
    expect(readable.status()).toBe(200);
    const theirs = await showSidebarTab(b.page, "Favorites");
    await expect(theirs.getByText(EMPTY_FAVORITES)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(theirs, title)).toHaveCount(0);
    const list = await b.page.request.get("/api/favorites");
    expect(await list.json()).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("窄寬：390 抽屜與側欄縮到最窄時六顆 tab 都放得下", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 390, height: 844 });
  try {
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    const drawerTabs = drawer.getByRole("tablist", { name: "Sidebar sections" });
    await expect(drawerTabs.getByRole("tab")).toHaveCount(6);
    const overflow = await drawerTabs.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);

    // 靜態側欄要視窗 ≥ 768 才有：改成 1280×800，把分隔線一路拖到最窄
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });
    const sidebar = page.getByRole("complementary");
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.move(x - 300, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())!.width, { timeout: 5_000 }).toBeLessThanOrEqual(201);

    const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(6);
    const listBox = (await tablist.boundingBox())!;
    for (let i = 0; i < 6; i += 1) {
      const tabBox = (await tabs.nth(i).boundingBox())!;
      const name = await tabs.nth(i).innerText();
      expect(tabBox.x, `tab ${i} (${name}) left`).toBeGreaterThanOrEqual(listBox.x - 0.5);
      expect(tabBox.x + tabBox.width, `tab ${i} (${name}) right`).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
    }
  } finally {
    await context.close();
  }
});

test("390 寬頁首：星號、分享、⋮ 不被裁、不擠進右內距；鍵盤切換焦點不掉；320 寬星號收起、改由 ⋮ 進入", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const carol = await createAccount(browser, "carol");
  const a = await openAs(browser, alice);
  const others: BrowserContext[] = [];
  try {
    const title = `E2E fav header ${RUN}`;
    await createNote(a.page, title);
    const noteUrl = a.page.url();
    const noteId = await noteIdFromUrl(a.page);
    for (const who of [bob, carol]) {
      const shared = await a.page.request.put(`/api/notes/${noteId}/shares`, { data: { email: who.email, role: "viewer" } });
      expect(shared.status(), await shared.text()).toBe(200);
      const other = await openAs(browser, who);
      others.push(other.context);
      await other.page.goto(noteUrl);
      await waitViewerConnected(other.page, title);
    }

    const page = a.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
    // 兩位其他人：窄螢幕頭像列有兩格，是頁首最擠的情況
    await expect(page.getByRole("group", { name: "Also viewing this note" }).getByRole("button")).toHaveCount(2, { timeout: 15_000 });
    await expect(star(page)).toBeEnabled();

    const share = page.getByRole("button", { name: "Share", exact: true });
    const more = page.getByRole("button", { name: "More", exact: true });
    await expect(share).toBeVisible();
    await expect(more).toBeVisible();
    await expect(star(page)).toBeVisible();

    const frames = await star(page).evaluate((el) => {
      const header = el.closest("header")!;
      let card: Element | null = header.parentElement;
      while (card && getComputedStyle(card).overflowX !== "hidden") card = card.parentElement;
      const style = getComputedStyle(header);
      return {
        cardRight: card ? card.getBoundingClientRect().right : null,
        contentRight: header.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
      };
    });
    expect(frames.cardRight, "沒有找到 overflow 為 hidden 的卡片").not.toBeNull();
    for (const [name, button] of [["Favorite", star(page)], ["Share", share], ["More", more]] as const) {
      const box = (await button.boundingBox())!;
      const right = box.x + box.width;
      const measured = JSON.stringify({ name, box, ...frames });
      expect(right, `${name} 被卡片裁掉 ${measured}`).toBeLessThanOrEqual(frames.cardRight! + 0.5);
      expect(right, `${name} 擠進頁首右內距 ${measured}`).toBeLessThanOrEqual(frames.contentRight + 0.5);
    }

    // 鍵盤：Tab 到星號、Space 切換，焦點仍在星號
    await page.getByRole("textbox", NOTE_TITLE).focus();
    const isFocused = () => star(page).evaluate((el) => el === document.activeElement);
    for (let i = 0; i < 12 && !(await isFocused()); i += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(star(page)).toBeFocused();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Space");
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await expect(star(page)).toBeFocused();

    // 320 寬：星號收起，⋮ 的第一項接手
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(star(page)).toBeHidden();
    await more.click();
    await expect(page.getByRole("menuitem").first()).toHaveAccessibleName("Remove from favorites");
  } finally {
    await a.context.close();
    for (const context of others) await context.close();
  }
});

test("公開分享頁沒有星號", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  const anonymous = await browser.newContext();
  try {
    const title = `E2E fav public ${RUN}`;
    await createNote(page, title);
    const noteId = await noteIdFromUrl(page);
    await expect(star(page)).toBeVisible();
    const published = await page.request.put(`/api/notes/${noteId}/public-link`);
    expect(published.status(), await published.text()).toBe(200);
    const { token } = (await published.json()) as { token: string };

    const publicPage = await anonymous.newPage();
    await publicPage.goto(`/p/${token}`);
    await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(star(publicPage)).toHaveCount(0);
  } finally {
    await anonymous.close();
    await context.close();
  }
});

/** 以 API 建筆記並加入最愛（依序，所以後建的在最愛 tab 的前面）；回傳 id。 */
async function apiCreateFavorite(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/notes", { data: { title } });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const added = await page.request.put(`/api/favorites/${id}`);
  expect(added.status(), await added.text()).toBe(200);
  return id;
}

/** 選取動作列（寬形在標題列、窄形在側欄底部；兩形都有 `data-select-action-bar`）。 */
function actionBar(scope: Locator): Locator {
  return scope.locator("[data-select-action-bar]");
}

test("最愛 tab 選取模式：勾兩篇移出（先確認、沒有 Undo、沒有 Move to）；全部移出後焦點留在面板", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    const titles = [1, 2, 3].map((n) => `E2E fav select ${n} ${RUN}`);
    for (const title of titles) await apiCreateFavorite(page, title);
    await page.goto("/");

    const sidebar = page.getByRole("complementary");
    const panel = await showSidebarTab(page, "Favorites");
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[2]!, "My notes"), favoriteRow(titles[1]!, "My notes"), favoriteRow(titles[0]!, "My notes")]);

    // 1. 勾第三、第一篇：動作列有「Copy to」與「Remove from favorites」，沒有「Move to」
    await startSidebarSelection(page);
    await toggleSelectedNote(panel, titles[2]!);
    await toggleSelectedNote(panel, titles[0]!);
    await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
    const bar = actionBar(sidebar);
    await expect(bar.getByRole("button", { name: "Remove from favorites", exact: true })).toBeEnabled();
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Move to/ })).toHaveCount(0);

    // 2. 先確認：框裡寫著篇數；確認後只剩中間那篇、沒有 Undo、離開選取
    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove 2 notes from favorites?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toastWithTitle(page, "Removed 2 notes from favorites")).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[1]!, "My notes")]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeFocused();
    const afterFirst = await page.request.get("/api/favorites");
    expect(((await afterFirst.json()) as Array<{ noteId: string }>).length).toBe(1);

    // 3. 剩下的一篇也移出：清單空了，「Select」鈕停用，焦點在面板（不掉到 body）
    await startSidebarSelection(page);
    await toggleSelectedNote(panel, titles[1]!);
    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove 1 note from favorites?" }).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(panel.getByText(EMPTY_FAVORITES)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeDisabled();
    await expect(panel).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    const afterAll = await page.request.get("/api/favorites");
    expect(await afterAll.json()).toEqual([]);
  } finally {
    await context.close();
  }
});

test("最愛 tab 選取模式：390 寬抽屜的動作列先確認再移出", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 390, height: 844 });
  try {
    await expectWidePointer(page, false);
    const titles = [1, 2].map((n) => `E2E fav drawer ${n} ${RUN}`);
    for (const title of titles) await apiCreateFavorite(page, title);
    await page.goto("/");

    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    const panel = await showSidebarTab(page, "Favorites", drawer);
    await expect(panel.getByRole("link")).toHaveCount(2);
    await startSidebarSelection(page, drawer);
    await toggleSelectedNote(panel, titles[0]!);

    const bar = actionBar(drawer);
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeVisible();
    // 窄形的鈕只放圖示：可及名稱在，可見文字沒有。
    for (const name of ["Remove from favorites", "Copy to"]) await expect(bar.getByRole("button", { name, exact: true })).toHaveText("");
    await expect(bar.getByRole("button", { name: /^Move to/ })).toHaveCount(0);
    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove 1 note from favorites?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toastWithTitle(page, "Removed 1 note from favorites")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[1]!, "My notes")]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("最近 tab 選取模式：把清單全部刪除後，焦點落在面板而不是 body", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    for (const n of [1, 2]) {
      const created = await page.request.post("/api/notes", { data: { title: `E2E recent delete ${n} ${RUN}` } });
      expect(created.status(), await created.text()).toBe(201);
    }
    await page.goto("/");

    const panel = await showSidebarTab(page, "Recent");
    await startSidebarSelection(page);
    // 新帳號的最近清單只有上面兩篇：全選後刪除，清單就空了。
    await panel.getByRole("checkbox", { name: "Select all", exact: true }).click();
    await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
    await actionBar(page.getByRole("complementary")).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();
    await expect(toastWithTitle(page, "Moved 2 notes to the trash")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("link")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeDisabled();
    await expect(panel).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  } finally {
    await context.close();
  }
});
