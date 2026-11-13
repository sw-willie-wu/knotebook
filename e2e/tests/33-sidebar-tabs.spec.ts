import { expect, test } from "@playwright/test";
import { ADMIN, createNote, loginAs, openListOnCompact, reEscape, showSidebarTab } from "./helpers.js";

/**
 * 側欄 tab（#181 加「Trash」、#334 加第二顆「Favorites」）：六顆 tab 的 DOM／預設 tab、選擇重整後保留、方向鍵與 Home／End、
 * 搜尋視圖與 Esc／清除鈕、手機（390、360）清單與 700 寬抽屜的 tab 觸控高度與不橫捲。
 * 本檔不斷言點搜尋結果後字串保留（AppShell 會重掛、搜尋字串本來就掉），所以搜尋段一律在筆記頁上做。
 */
const RUN = Date.now();

test("sidebar tabs: roles, persistence, keyboard, search view, phone list and narrow drawer", async ({ page }) => {
  const title = `E2E Tabs ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  // 無空白長標題（不含 RUN，免得搜尋 RUN 時多一筆）：390 寬抽屜的清單不得橫向溢出。
  const longTitle = `E2E${Math.random().toString(36).replace(/[0-9]/g, "").slice(0, 6)}${"x".repeat(120)}`;
  await createNote(page, longTitle);
  await createNote(page, title);
  const noteUrl = page.url();

  // ── 靜態側欄：六顆 tab、預設 My notes ─────────────────────────────────────
  const sidebar = page.getByRole("complementary");
  const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(6);
  const names = ["Recent", "Favorites", "My notes", "Groups", "Shared with me", "Trash"];
  for (const [i, name] of names.entries()) await expect(tabs.nth(i)).toHaveAttribute("aria-label", name);
  await expect(tablist.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("tabpanel").getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();

  // ── 選擇重整後仍在 ──────────────────────────────────────────────────
  await showSidebarTab(page, "Groups");
  await page.reload();
  // 等 lazy NotePage 掛上：fallback 自帶的 AppShell 會被換掉（drawerOpen 跟著重設；搜尋字串 #369 起住在 App 層、不重設）。
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await expect(tablist.getByRole("tab", { name: "Groups", exact: true })).toHaveAttribute("aria-selected", "true");

  // ── 方向鍵（循環、同時切換並移焦點）與 Home ─────────────────────────
  const workspaceTab = tablist.getByRole("tab", { name: "Groups", exact: true });
  const sharedTab = tablist.getByRole("tab", { name: "Shared with me", exact: true });
  const recentTab = tablist.getByRole("tab", { name: "Recent", exact: true });
  const favoritesTab = tablist.getByRole("tab", { name: "Favorites", exact: true });
  const trashTab = tablist.getByRole("tab", { name: "Trash", exact: true });
  await workspaceTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sharedTab).toHaveAttribute("aria-selected", "true");
  await expect(sharedTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recentTab).toHaveAttribute("aria-selected", "true");
  await expect(recentTab).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(trashTab).toHaveAttribute("aria-selected", "true");
  await expect(trashTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recentTab).toHaveAttribute("aria-selected", "true");
  // Recent 的右邊是 Favorites
  await page.keyboard.press("ArrowRight");
  await expect(favoritesTab).toHaveAttribute("aria-selected", "true");
  await expect(favoritesTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(trashTab).toHaveAttribute("aria-selected", "true");
  await expect(trashTab).toBeFocused();
  await showSidebarTab(page, "Groups");

  // ── 搜尋視圖 ────────────────────────────────────────────────────────
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(String(RUN));
  await expect(tablist).toHaveCount(0);
  // 限定在側欄：筆記頁的 ConnectionBadge 也是 role="status"。
  await expect(sidebar.getByRole("status")).toHaveText(/^1 (title match|result)$/);
  // 結果連結的可及名稱是「標題 位置」。
  const hit = sidebar.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("My notes");
  await expect(hit.locator("mark")).toHaveText(String(RUN));
  // Esc：清空、回 tab 列，原 tab 仍選中
  await search.press("Escape");
  await expect(tablist).toBeVisible();
  await expect(workspaceTab).toHaveAttribute("aria-selected", "true");
  // 清除鈕：清空並把焦點還給搜尋框
  await search.fill(String(RUN));
  await expect(tablist).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(tablist).toBeVisible();
  // 無命中
  await search.fill(`zz-no-match-${RUN}`);
  await expect(sidebar.getByText("No notes match your search.", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(tablist).toBeVisible();

  // ── 手機（390、360）：清單是整個側欄，六顆 tab 在 tablist 內、清單不橫向溢出 ─────────────────────
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(noteUrl);
    // 等 lazy NotePage 掛上再碰側欄（fallback 與真頁面雖是同一個側欄，標題框出現才表示載入完成）。
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    const list = await openListOnCompact(page);
    const phoneTabs = list.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await expect(phoneTabs).toHaveCount(6);
    // 與桌面側欄一致：Groups 仍選中（tab 存在 localStorage、同一份側欄）
    // 第一輪沿用上面選的 Groups；本輪結束時換成 My notes，所以第二輪從 My notes 開始。
    await expect(list.getByRole("tab", { name: width === 390 ? "Groups" : "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    const tablistBox = (await list.getByRole("tablist", { name: "Sidebar sections" }).boundingBox())!;
    for (let i = 0; i < 6; i++) {
      const box = await phoneTabs.nth(i).boundingBox();
      expect(box, `${width} 寬第 ${i} 顆 tab`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
      expect(box!.height).toBeLessThanOrEqual(44.5);
      expect(box!.x, `${width} 寬第 ${i} 顆 tab 的左緣`).toBeGreaterThanOrEqual(tablistBox.x - 0.5);
      expect(box!.x + box!.width, `${width} 寬第 ${i} 顆 tab 的右緣`).toBeLessThanOrEqual(tablistBox.x + tablistBox.width + 0.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const phonePanel = await showSidebarTab(page, "My notes", list);
    await expect(list.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(phonePanel.getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();
    await expect(phonePanel.getByRole("link", { name: new RegExp("^" + reEscape(longTitle)) })).toBeVisible();
    // 清單內層包層是 `overflow-x-clip`（安全網），清單本身恆不溢出；改量包層（`[data-sidebar-list] > div`）的內容寬度。
    const wrapper = phonePanel.locator("[data-sidebar-list] > div");
    expect(await wrapper.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // 點 tab 不離開清單（tab 在清單上，不是導覽）
    await expect(page).toHaveURL(/\/$/);
  }

  // ── 700 寬抽屜（640–767，tab 高 44；768 起 tab 是 36）：六顆 tab 的高度與不橫捲、Esc 關 ─────────────────
  await page.setViewportSize({ width: 700, height: 844 });
  await page.goto(noteUrl);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerTabs = drawer.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
  await expect(drawerTabs).toHaveCount(6);
  await expect(drawer.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  for (let i = 0; i < 6; i++) {
    const box = await drawerTabs.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.height).toBeLessThanOrEqual(44.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700);
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  const list = drawerPanel.locator("[data-sidebar-list] > div");
  expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("complementary").getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
