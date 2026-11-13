import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  editorLocator,
  folderRow,
  loginAs,
  randomEmail,
  reEscape,
  showSidebarTab,
  waitForEditorSelection,
} from "./helpers.js";

/**
 * 手機（視窗窄於 640）的導覽：清單是首頁，筆記是它上面的一層。
 *
 * 55-1 清單畫面：頂列（頭像）、六顆只有圖示的 tab 排在同一列、底部列（搜尋框與 New note）貼著視窗下緣，沒有側欄鈕；筆記畫面藏起清單。
 * 55-2 全螢幕搜尋：聚焦搜尋框開層（Cancel 取代 New note、tab 與清單換成搜尋結果）；Cancel、Esc、點結果、系統返回都關層。
 * 55-3 「‹」回清單：清單的捲動位置、搜尋框的字、焦點（回到剛點的那一列）都保留；系統返回鍵與「‹」同一條歷史。
 * 55-4 深連結進來時「‹」換掉目前這一格、不新增歷史；清單→A→A 裡的連結→B 之後「‹」一次退回清單那一格。
 * 55-5 三段版面：639 是手機（有「‹」、沒有側欄鈕）、640 與 1279 是浮動側欄、1280 固定側欄；跨 640 時搜尋層與抽屜各自收起。
 * 55-6 位置副標：個人資料夾、群組資料夾、共享三種形狀；點了回清單、切到對應的 tab、展開資料夾（收合過的也會展開）、那一列在畫面內。
 * 55-7 筆記頁底部瀏覽列：搜尋按鈕開全螢幕搜尋（Cancel 回到這篇）；New note 建在這篇所在的空間與資料夾；
 *      擁有者、群組成員有；群組檢視者、共享給我的沒有；唯讀筆記點內文不影響它。
 * 55-8 編輯器取得焦點時瀏覽列整條不在，點頂列標題後回來。
 * 55-9 #313：NotePage 的 chunk 還在載入時開的抽屜，chunk 到了之後不會自己關。
 * 55-10 觸控尺寸：只量並印成 MEASURE 行（畫出來的框與實際點得到的範圍），不斷言。
 * 55-11 清單→筆記→重新整理→「‹」：照樣退回清單那一格（序號少一、歷史長度不變）。
 * 55-12 筆記上開著全螢幕搜尋層時按系統返回：回到清單，層是關的、搜尋框沒有焦點。
 *
 * 桌面版 Chromium 驗不到的：螢幕鍵盤把底部列頂起來（visualViewport）、瀏海與 Home 指示條的 safe area（只能查 class 與 CSS 字面，見單元測試）、
 * 滑入轉場的實際畫面、真手指的點擊範圍。這幾項要實機看。
 *
 * 每個測試用新建帳號（alice、bob 加 RUN 後綴），資料以 API 建、建完才縮到手機寬度（寬視窗建資料、窄視窗操作）。
 */

const RUN = Date.now();
const PASSWORD = "e2e-mobile-nav-pw";
const PHONE = { width: 390, height: 844 } as const;

interface Account {
  email: string;
  displayName: string;
}

/** admin 發邀請建帳號（admin 的 context 用完即關）。 */
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

/** 開新 context 以 `account` 登入（落在 `/`）。 */
async function openAs(browser: Browser, account: Account, viewport: { width: number; height: number } = PHONE): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

interface Created {
  id: string;
  slug: string;
  ownerHandle: string | null;
}

async function apiNote(page: Page, title: string, place: { groupId?: string; folderId?: string; content?: string } = {}): Promise<Created> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${res.status()} ${await res.text()}`).toBe(201);
  return (await res.json()) as Created;
}

async function apiFolder(page: Page, name: string, parent: { parentId: string } | { space: { kind: "personal" } | { kind: "group"; groupId: string } }): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${res.status()} ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function apiGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${res.status()} ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const pathOf = (note: Created, groupId?: string): string => (groupId === undefined ? `/n/${note.ownerHandle}/${note.slug}` : `/g/${groupId}/${note.slug}`);

/** 標題框用屬性選擇器：抽屜（Radix modal）開著時背景是 aria-hidden，role 查詢找不到它。 */
const titleBox = (page: Page): Locator => page.locator('[aria-label="Note title"]');
const backButton = (page: Page): Locator => page.getByRole("button", { name: "Back to notes", exact: true });
const openSidebar = (page: Page): Locator => page.getByRole("button", { name: "Open sidebar", exact: true });
const listBar = (page: Page): Locator => page.locator("[data-phone-list-bar]");
const browseBar = (page: Page): Locator => page.getByTestId("note-browse-bar");
const searchBox = (page: Page): Locator => page.getByRole("textbox", { name: "Search notes", exact: true });
const sidebarOf = (page: Page): Locator => page.getByRole("complementary").filter({ has: page.getByRole("tablist", { name: "Sidebar sections" }) });
const drawerOf = (page: Page): Locator => page.getByRole("dialog", { name: "Navigation" });
const noteLink = (scope: Locator, title: string): Locator => scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
const historyIdx = (page: Page): Promise<number | null> => page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? null);

/** 開筆記後等標題框：lazy NotePage 的 fallback 殼換成真的之前，頁面上的東西都還會被換掉。 */
async function waitForTitle(page: Page, title: string): Promise<void> {
  await expect(titleBox(page)).toHaveValue(title, { timeout: 15_000 });
}

test("55-1 清單畫面：頂列、六顆圖示 tab 同一列、底部列貼著下緣、沒有側欄鈕；筆記畫面藏起來", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn list ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");

    const sidebar = sidebarOf(page);
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(titleBox(page)).toHaveCount(0);

    // 頂列：頭像鈕（名稱是顯示名稱）在最上面
    const top = page.locator("[data-phone-top-bar]");
    await expect(top.getByRole("button", { name: alice.displayName, exact: true })).toBeVisible();

    // 六顆 tab 在同一個 tablist 裡、同一列、不橫向溢出
    const tabs = sidebar.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await expect(tabs).toHaveCount(6);
    const tops = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const box = (await tabs.nth(i).boundingBox())!;
      expect(box).not.toBeNull();
      tops.add(Math.round(box.y));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
    }
    expect(tops.size, `六顆 tab 的上緣 ${[...tops].join(",")}`).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

    // 底部列：搜尋框與 New note，下緣貼著視窗下緣（桌面 Chromium 沒有 safe area）
    const bar = listBar(page);
    await expect(bar.getByRole("textbox", { name: "Search notes", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "New note", exact: true })).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    expect(Math.abs(barBox.y + barBox.height - PHONE.height)).toBeLessThanOrEqual(1);

    // 點筆記：清單藏起來、筆記畫面出現、有「‹」
    await showSidebarTab(page, "My notes");
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    await expect(sidebarOf(page)).toHaveCount(0);
    await expect(backButton(page)).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(titleBox(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("55-2 全螢幕搜尋：Cancel、Esc、點結果、系統返回都關層；結果與提示句", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E mn search ${RUN}`;
    await apiNote(page, title);
    await page.goto("/");
    // 搜尋層裡沒有 tab 列，所以不能用 sidebarOf（它要求含 tab 列）。
    const sidebar = page.getByRole("complementary");
    const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
    const newNote = listBar(page).getByRole("button", { name: "New note", exact: true });
    const cancel = listBar(page).getByRole("button", { name: "Cancel", exact: true });
    await expect(tablist).toBeVisible({ timeout: 15_000 });

    // 開層：tab 列與清單換成提示句、Cancel 取代 New note
    await searchBox(page).click();
    await expect(cancel).toBeVisible();
    await expect(newNote).toHaveCount(0);
    await expect(tablist).toHaveCount(0);
    await expect(page.getByTestId("phone-search-hint")).toBeVisible();

    // 輸入：結果出現；Cancel 清字、關層、tab 與 New note 回來
    await searchBox(page).fill(title);
    await expect(noteLink(sidebar, title)).toBeVisible({ timeout: 15_000 });
    await cancel.click();
    await expect(searchBox(page)).toHaveValue("");
    await expect(cancel).toHaveCount(0);
    await expect(newNote).toBeVisible();
    await expect(tablist).toBeVisible();

    // Esc：同上
    await searchBox(page).click();
    await searchBox(page).fill(title);
    await expect(noteLink(sidebar, title)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(searchBox(page)).toHaveValue("");
    await expect(cancel).toHaveCount(0);
    await expect(tablist).toBeVisible();

    // 點結果：進筆記、層關；系統返回回到清單，這時層不開（Cancel 不在、New note 在）
    await searchBox(page).click();
    await searchBox(page).fill(title);
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(cancel).toHaveCount(0);
    await expect(newNote).toBeVisible();
  } finally {
    await context.close();
  }
});

test("55-3 「‹」回清單：捲動位置、搜尋字、焦點都保留；系統返回與「‹」同一條歷史", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const titles = Array.from({ length: 30 }, (_, i) => `E2E mn scroll ${String(i + 1).padStart(2, "0")} ${RUN}`);
    for (const t of titles) await apiNote(page, t);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    const sidebar = sidebarOf(page);
    await showSidebarTab(page, "My notes");
    await expect(noteLink(sidebar, titles[0]!)).toBeVisible({ timeout: 15_000 });
    const list = sidebar.locator("[data-sidebar-list]");
    await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
    await list.evaluate((el) => {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
    });
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);

    // 點目前畫面上的某一篇（捲動後第一篇看得見的）
    const target = await list.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => {
        const r = a.getBoundingClientRect();
        return r.top >= box.top + 4 && r.bottom <= box.bottom - 4;
      });
      return { href: link?.getAttribute("href") ?? null, text: link?.textContent ?? "" };
    });
    expect(target.href).not.toBeNull();
    const listIdx = await historyIdx(page);
    const historyBefore = await page.evaluate(() => history.length);
    await sidebar.locator(`a[href="${target.href}"]`).click();
    await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);

    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    // 沒有新增 entry（退一格，不是 push 一個 `/`）
    expect(await historyIdx(page)).toBe(listIdx);
    expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
    // 捲動位置還在
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(before);
    // 焦點回到剛點的那一列
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("href") ?? null)).toBe(target.href);

    // 系統返回鍵：清單 → 筆記 → goBack → 清單，與「‹」同一格
    await sidebar.locator(`a[href="${target.href}"]`).click();
    await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(before);

    // 搜尋框的字：點結果進筆記、「‹」回來，字還在
    const query = titles[4]!;
    await searchBox(page).click();
    await searchBox(page).fill(query);
    await noteLink(page.getByRole("complementary"), query).click();
    await waitForTitle(page, query);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(searchBox(page)).toHaveValue(query);
  } finally {
    await context.close();
  }
});

test("55-4 深連結與連結鏈：深連結的「‹」換掉這一格（不新增歷史）；清單→A→B 之後「‹」一次回清單", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const stamp = Date.now();
    const a = await apiNote(page, `E2E mn chain A ${stamp}`);
    await apiNote(page, `E2E mn chain B ${stamp}`);
    await page.setViewportSize(PHONE);

    // 深連結：整頁載入筆記 → 「‹」→ `/`，history.length 與 idx 都不變
    await page.goto(pathOf(a));
    await waitForTitle(page, `E2E mn chain A ${stamp}`);
    const lengthBefore = await page.evaluate(() => history.length);
    const idxBefore = await historyIdx(page);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
    expect(await historyIdx(page)).toBe(idxBefore);
    // 換掉的這一格是清單：返回鍵之後不會又落在同一篇筆記
    await page.goBack();
    expect(new URL(page.url()).pathname).not.toBe(pathOf(a));

    // 連結鏈：清單 → A →（A 裡的 wikilink）→ B →「‹」→ 清單那一格
    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    const listIdx = await historyIdx(page);
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), `E2E mn chain A ${stamp}`).click();
    await waitForTitle(page, `E2E mn chain A ${stamp}`);
    const editor = editorLocator(page);
    await editor.click();
    await waitForEditorSelection(page);
    await page.keyboard.type("see [[");
    await page.keyboard.type(`chain B ${stamp}`);
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText(`E2E mn chain B ${stamp}`, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    const wikilink = editor.locator('[data-inline-content-type="wikilink"]');
    await expect(wikilink).toHaveCount(1, { timeout: 10_000 });
    await wikilink.click();
    await waitForTitle(page, `E2E mn chain B ${stamp}`);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 2);

    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
  } finally {
    await context.close();
  }
});

test("55-5 三段版面：639 手機、640 與 1279 浮動側欄、1280 固定側欄；跨 640 時搜尋層與抽屜各自收起", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn tiers ${RUN}`;
    const note = await apiNote(page, title);
    await page.goto(pathOf(note));
    await waitForTitle(page, title);

    const setWidth = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
    };

    // 1280：固定側欄（含 New note 鈕的 complementary）、沒有側欄鈕、沒有「‹」
    await expect(page.getByRole("complementary").getByRole("button", { name: "New note", exact: true })).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(backButton(page)).toHaveCount(0);

    for (const width of [1279, 640]) {
      await setWidth(width);
      await expect(openSidebar(page), `${width}`).toBeVisible();
      await expect(backButton(page), `${width}`).toHaveCount(0);
      await expect(page.getByRole("complementary").getByRole("button", { name: "New note", exact: true }), `${width}`).toHaveCount(0);
      await expect(browseBar(page), `${width}`).toHaveCount(0);
    }

    await setWidth(639);
    await expect(backButton(page)).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(browseBar(page)).toBeVisible();

    // 手機 → 640：搜尋層開著（蓋在筆記上）時跨過去，層收起、側欄不是滿版
    await browseBar(page).getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await setWidth(640);
    await expect(listBar(page)).toHaveCount(0);
    await expect(openSidebar(page)).toBeVisible();
    await expect(titleBox(page)).toBeVisible();

    // 640 開抽屜 → 縮到 639：抽屜收起，仍停在這篇筆記；再回 640 不自動開
    await openSidebar(page).click();
    await expect(drawerOf(page)).toBeVisible();
    await setWidth(639);
    await expect(drawerOf(page)).toHaveCount(0);
    await expect(titleBox(page)).toBeVisible();
    await expect(sidebarOf(page)).toHaveCount(0);
    await setWidth(640);
    await expect(drawerOf(page)).toHaveCount(0);

    // 清單畫面（手機）→ 640：HomePage 在浮動段，側欄鈕在
    await backToHome(page, setWidth);
  } finally {
    await context.close();
  }
});

async function backToHome(page: Page, setWidth: (width: number) => Promise<void>): Promise<void> {
  await setWidth(639);
  await backButton(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(sidebarOf(page)).toBeVisible();
  await setWidth(640);
  await expect(sidebarOf(page)).toHaveCount(0);
  await expect(openSidebar(page)).toBeVisible();
  await openSidebar(page).click();
  await expect(drawerOf(page)).toBeVisible();
  await setWidth(639);
  await expect(drawerOf(page)).toHaveCount(0);
  await expect(sidebarOf(page)).toBeVisible();
}

test("55-6 位置副標三形：個人資料夾、群組資料夾、共享；點了回清單、切到對應 tab、展開資料夾、那一列在畫面內", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { width: 1280, height: 800 });
  const b = await openAs(browser, bob);
  try {
    const group = `E2E mn Grp ${RUN}`;
    const groupId = await apiGroup(a.page, group);
    const added = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.ok(), await added.text()).toBe(true);

    const folder = `E2E mn Fold ${RUN}`;
    const personalFolder = await apiFolder(a.page, folder, { space: { kind: "personal" } });
    const personal = await apiNote(a.page, `E2E mn personal ${RUN}`, { folderId: personalFolder });
    const groupFolder = await apiFolder(a.page, folder, { space: { kind: "group", groupId } });
    const inGroup = await apiNote(a.page, `E2E mn group ${RUN}`, { groupId, folderId: groupFolder });
    const shared = await apiNote(a.page, `E2E mn shared ${RUN}`);
    const share = await a.page.request.put(`/api/notes/${shared.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(share.ok(), await share.text()).toBe(true);

    const location = (page: Page): Locator => page.getByTestId("note-header-subline").getByRole("button", { name: /^Show in list: / });

    // alice：個人資料夾
    await a.page.setViewportSize(PHONE);
    await a.page.goto(pathOf(personal));
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await expect(location(a.page)).toHaveAccessibleName(`Show in list: My notes › ${folder}`);
    await expect(location(a.page)).toContainText(`My notes › ${folder}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    const sidebarA = sidebarOf(a.page);
    await expect(sidebarA.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(folderRow(sidebarA, folder).getByRole("button", { name: folder, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(noteLink(sidebarA, `E2E mn personal ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    // 資料夾收合之後再點副標：會重新展開。退回清單收合資料夾，前進回筆記，再點副標。
    const folderButton = folderRow(sidebarA, folder).getByRole("button", { name: folder, exact: true });
    await noteLink(sidebarA, `E2E mn personal ${RUN}`).click();
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await backButton(a.page).click();
    await expect(sidebarOf(a.page)).toBeVisible();
    await folderButton.click();
    await expect(folderButton).toHaveAttribute("aria-expanded", "false");
    await a.page.goForward();
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    await expect(folderButton).toHaveAttribute("aria-expanded", "true");
    await expect(noteLink(sidebarOf(a.page), `E2E mn personal ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    // alice：群組資料夾
    await a.page.goto(pathOf(inGroup, groupId));
    await waitForTitle(a.page, `E2E mn group ${RUN}`);
    await expect(location(a.page)).toHaveAccessibleName(`Show in list: ${group} › ${folder}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    await expect(sidebarOf(a.page).getByRole("tab", { name: "Groups", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(noteLink(sidebarOf(a.page), `E2E mn group ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    // bob：共享給我（沒有放置）
    await b.page.goto(pathOf(shared));
    // 檢視者的標題是 h1（沒有標題框）
    await expect(b.page.getByRole("heading", { name: `E2E mn shared ${RUN}`, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(location(b.page)).toHaveAccessibleName(`Show in list: Shared with me · @${shared.ownerHandle}`);
    await expect(location(b.page)).toContainText(`Shared with me · @${shared.ownerHandle}`);
    await location(b.page).click();
    await expect(b.page).toHaveURL(/\/$/);
    await expect(sidebarOf(b.page).getByRole("tab", { name: "Shared with me", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(noteLink(sidebarOf(b.page), `E2E mn shared ${RUN}`)).toBeInViewport({ timeout: 10_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("55-7 筆記頁瀏覽列：搜尋開層、Cancel 回這篇；New note 建在這篇旁邊；顯示矩陣（擁有者、群組成員有；群組檢視者、共享的沒有）", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const carol = await createAccount(browser, "carol");
  const a = await openAs(browser, alice, { width: 1280, height: 800 });
  const b = await openAs(browser, bob);
  const c = await openAs(browser, carol);
  try {
    const group = `E2E mn BGrp ${RUN}`;
    const groupId = await apiGroup(a.page, group);
    // bob＝一般成員（讀、新建、編輯）；carol＝只讀的自訂角色
    const memberAdd = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(memberAdd.ok(), await memberAdd.text()).toBe(true);
    const roleRes = await a.page.request.post(`/api/groups/${groupId}/roles`, {
      data: { name: "Reader", permissions: { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false } },
    });
    expect(roleRes.status(), await roleRes.text()).toBe(201);
    const readerRole = ((await roleRes.json()) as { id: string }).id;
    const viewerAdd = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: carol.email, roleId: readerRole } });
    expect(viewerAdd.ok(), await viewerAdd.text()).toBe(true);

    const folder = `E2E mn BFold ${RUN}`;
    const folderId = await apiFolder(a.page, folder, { space: { kind: "personal" } });
    const owned = await apiNote(a.page, `E2E mn owned ${RUN}`, { folderId });
    const groupNote = await apiNote(a.page, `E2E mn gnote ${RUN}`, { groupId });
    const sharedNote = await apiNote(a.page, `E2E mn bshared ${RUN}`);
    const share = await a.page.request.put(`/api/notes/${sharedNote.id}/shares`, { data: { email: bob.email, role: "editor" } });
    expect(share.ok(), await share.text()).toBe(true);

    const newNote = (page: Page): Locator => browseBar(page).getByRole("button", { name: "New note", exact: true });
    const searchButton = (page: Page): Locator => browseBar(page).getByRole("button", { name: "Search notes", exact: true });

    // ── 擁有者：有；搜尋開層、Cancel 回到這篇、焦點回搜尋鈕 ───────────────────────────────
    await a.page.setViewportSize(PHONE);
    await a.page.goto(pathOf(owned));
    await waitForTitle(a.page, `E2E mn owned ${RUN}`);
    await expect(browseBar(a.page)).toBeVisible();
    await expect(newNote(a.page)).toBeVisible();
    await searchButton(a.page).click();
    await expect(searchBox(a.page)).toBeFocused();
    await expect(listBar(a.page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await searchBox(a.page).fill(`E2E mn gnote ${RUN}`);
    await expect(noteLink(a.page.getByRole("complementary"), `E2E mn gnote ${RUN}`)).toBeVisible({ timeout: 15_000 });
    await listBar(a.page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(a.page).toHaveURL(new RegExp(reEscape(pathOf(owned)) + "$"));
    await expect(titleBox(a.page)).toHaveValue(`E2E mn owned ${RUN}`);
    await expect(sidebarOf(a.page)).toHaveCount(0);
    await expect(searchButton(a.page)).toBeFocused();

    // New note：建在同一個資料夾（回清單看那個資料夾底下）
    await newNote(a.page).click();
    await a.page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    await expect(titleBox(a.page)).toHaveValue("Untitled", { timeout: 15_000 });
    await backButton(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    const sidebarA = sidebarOf(a.page);
    await showSidebarTab(a.page, "My notes");
    await expect(folderRow(sidebarA, folder).getByRole("link", { name: /^Untitled/ })).toHaveCount(1, { timeout: 15_000 });

    // ── 群組成員：有；新筆記在群組裡 ─────────────────────────────────────────────────────
    await b.page.goto(pathOf(groupNote, groupId));
    await waitForTitle(b.page, `E2E mn gnote ${RUN}`);
    await expect(newNote(b.page)).toBeVisible({ timeout: 15_000 });
    await newNote(b.page).click();
    await b.page.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    expect(new URL(b.page.url()).pathname.split("/")[2]).toBe(groupId);

    // ── 共享給我的（bob 是編輯者）：瀏覽列在、沒有 New note ────────────────────────────────
    await b.page.goto(pathOf(sharedNote));
    await waitForTitle(b.page, `E2E mn bshared ${RUN}`);
    await expect(browseBar(b.page)).toBeVisible();
    await expect(searchButton(b.page)).toBeVisible();
    await expect(newNote(b.page)).toHaveCount(0);

    // ── 群組檢視者（carol）：沒有 New note；唯讀筆記點內文瀏覽列仍在 ─────────────────────────
    await c.page.goto(pathOf(groupNote, groupId));
    await expect(c.page.getByRole("heading", { name: `E2E mn gnote ${RUN}`, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(browseBar(c.page)).toBeVisible();
    await expect(newNote(c.page)).toHaveCount(0);
    // 唯讀筆記沒有可編輯的內文節點：直接點內文區域的座標（頁首之下、瀏覽列之上）。
    await c.page.mouse.click(PHONE.width / 2, 400);
    await expect(browseBar(c.page)).toBeVisible();
    await expect(newNote(c.page)).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
    await c.context.close();
  }
});

test("55-8 編輯時瀏覽列讓位：編輯器取得焦點整條不在，點頂列標題後回來", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E mn edit ${RUN}`;
    const note = await apiNote(page, title);
    await page.goto(pathOf(note));
    await waitForTitle(page, title);
    await expect(browseBar(page)).toBeVisible();

    // 編輯器可編輯後點進去（唯讀期間的點擊不算編輯中）
    await expect(editorLocator(page)).toBeVisible({ timeout: 15_000 });
    await editorLocator(page).click();
    await waitForEditorSelection(page);
    await expect(browseBar(page)).toHaveCount(0);

    // 點頂列標題（焦點離開編輯器）：瀏覽列回來
    await titleBox(page).click();
    await expect(browseBar(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("55-9 #313：NotePage 的程式碼還在載入時開的抽屜，載入完成後不會自己關", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn slow ${RUN}`;
    const note = await apiNote(page, title);
    await page.setViewportSize({ width: 768, height: 800 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(/\/assets\/NotePage-[^/]+\.js(\?.*)?$/, async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });
    await page.goto(pathOf(note), { waitUntil: "commit" });

    // chunk 被擋住：還沒有標題框，頁面上只有載入中的佔位；這時開抽屜
    await expect(openSidebar(page)).toBeVisible({ timeout: 15_000 });
    await expect(titleBox(page)).toHaveCount(0);
    expect(held, "NotePage 的 chunk 請求必須真的被攔到，否則這案沒有測到任何事").toBeGreaterThan(0);
    await openSidebar(page).click();
    await expect(drawerOf(page)).toBeVisible();

    release();
    await waitForTitle(page, title);
    // 換成真的筆記頁之後抽屜還在（同一份殼）
    await expect(drawerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawerOf(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("55-10 觸控尺寸只量不斷言：清單與筆記畫面的主要控制項印成 MEASURE 行", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn measure ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    const sidebar = sidebarOf(page);
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    const lines: string[] = [];
    /**
     * `visual`＝畫出來的框；`tap`＝點擊範圍：從框的中心往四個方向一格一格找，最遠還點得到這顆鈕（或它裡面的東西）的位置
     * （`elementFromPoint`，最多往外 24px），所以用 `after:` 擴大點擊範圍的鈕會量到比 visual 大。
     */
    const measure = async (screen: string, name: string, target: Locator): Promise<void> => {
      const handle = await target.first().elementHandle({ timeout: 10_000 });
      const result = await handle!.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hits = (x: number, y: number): boolean => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (el === hit || el.contains(hit));
        };
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const reach = (dx: number, dy: number, start: number): number => {
          let d = 0;
          while (d < 24 && hits(cx + dx * (start + d + 1), cy + dy * (start + d + 1))) d += 1;
          return d;
        };
        const extra = {
          left: reach(-1, 0, box.width / 2),
          right: reach(1, 0, box.width / 2),
          up: reach(0, -1, box.height / 2),
          down: reach(0, 1, box.height / 2),
        };
        return {
          visual: [box.width, box.height],
          tap: [box.width + extra.left + extra.right, box.height + extra.up + extra.down],
        };
      });
      const fmt = (v: number[]): string => `${v[0]!.toFixed(1)}x${v[1]!.toFixed(1)}`;
      lines.push(`MEASURE ${screen} ${name} visual ${fmt(result.visual)} tap ${fmt(result.tap)}`);
    };
    const tabs = sidebar.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await measure("list", "tab", tabs);
    await measure("list", "avatar", page.locator("[data-phone-top-bar]").getByRole("button"));
    await measure("list", "search", listBar(page).getByRole("textbox"));
    await measure("list", "new-note", listBar(page).getByRole("button", { name: "New note", exact: true }));
    await showSidebarTab(page, "My notes");
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    await measure("note", "back", backButton(page));
    await measure("note", "star", page.locator("header").getByRole("button", { name: "Favorite", exact: true }));
    await measure("note", "share", page.locator("header").getByRole("button", { name: "Share", exact: true }));
    await measure("note", "more", page.locator("header").getByRole("button", { name: "More", exact: true }));
    const locationButton = page.getByTestId("note-header-subline").getByRole("button", { name: /^Show in list: / });
    await measure("note", "location", locationButton);
    await measure("note", "browse-search", browseBar(page).getByRole("button", { name: "Search notes", exact: true }));
    await measure("note", "browse-new-note", browseBar(page).getByRole("button", { name: "New note", exact: true }));
    // 標題框加位置副標合起來的高度（兩者上下相鄰，點哪一個都開對應的東西）。
    const titleRect = (await titleBox(page).boundingBox())!;
    const locationRect = (await locationButton.boundingBox())!;
    const union = { width: Math.max(titleRect.x + titleRect.width, locationRect.x + locationRect.width) - Math.min(titleRect.x, locationRect.x), height: locationRect.y + locationRect.height - titleRect.y };
    lines.push(`MEASURE note title+location visual ${union.width.toFixed(1)}x${union.height.toFixed(1)}`);
    for (const line of lines) console.log(line);
    expect(lines.filter((line) => line.includes("missing"))).toEqual([]);
  } finally {
    await context.close();
  }
});

test("55-11 清單→筆記→重新整理→「‹」：照樣退回清單那一格（序號少一、歷史長度不變）", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn reload ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    const listIdx = await historyIdx(page);
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), title).click();
    await waitForTitle(page, title);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);

    await page.reload();
    await waitForTitle(page, title);
    const lengthBefore = await page.evaluate(() => history.length);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  } finally {
    await context.close();
  }
});

test("55-12 筆記上開著全螢幕搜尋層時按系統返回：回到清單，層是關的、搜尋框沒有焦點", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn backsearch ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), title).click();
    await waitForTitle(page, title);
    await browseBar(page).getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(searchBox(page)).toBeFocused();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(listBar(page).getByRole("button", { name: "New note", exact: true })).toBeVisible();
    await expect(searchBox(page)).not.toBeFocused();
  } finally {
    await context.close();
  }
});
