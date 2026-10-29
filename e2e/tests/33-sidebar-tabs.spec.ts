import { expect, test } from "@playwright/test";
import { ADMIN, createNote, loginAs, reEscape, showSidebarTab } from "./helpers.js";

/**
 * 側欄 tab（PR-1；#181 PR-2b 加第五顆「Trash」）：五顆 tab 的 DOM／預設 tab、選擇重整後保留（A1-1）、方向鍵與 Home／End（A1-5）、
 * 搜尋視圖與 Esc／清除鈕（A1-4）、390 寬抽屜的 tab 觸控高度與不橫捲（A1-6）。
 * 本檔不斷言點搜尋結果後字串保留（AppShell 會重掛、搜尋字串本來就掉），所以搜尋段一律在筆記頁上做。
 */
const RUN = Date.now();

test("sidebar tabs: roles, persistence, keyboard, search view, narrow drawer", async ({ page }) => {
  const title = `E2E Tabs ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  // 無空白長標題（不含 RUN，免得搜尋 RUN 時多一筆）：390 寬抽屜的清單不得橫向溢出。
  const longTitle = `E2E${Math.random().toString(36).replace(/[0-9]/g, "").slice(0, 6)}${"x".repeat(120)}`;
  await createNote(page, longTitle);
  await createNote(page, title);
  const noteUrl = page.url();

  // ── 靜態側欄：五顆 tab、預設 My notes ─────────────────────────────────────
  const sidebar = page.getByRole("complementary");
  const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(5);
  const names = ["Recent", "My notes", "Workspace", "Shared with me", "Trash"];
  for (const [i, name] of names.entries()) await expect(tabs.nth(i)).toHaveAttribute("aria-label", name);
  await expect(tablist.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("tabpanel").getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();

  // ── A1-1：選擇重整後仍在 ──────────────────────────────────────────────────
  await showSidebarTab(page, "Workspace");
  await page.reload();
  // 等 lazy NotePage 掛上：fallback 自帶的 AppShell 會被換掉（drawerOpen／搜尋字串跟著重設）。
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await expect(tablist.getByRole("tab", { name: "Workspace", exact: true })).toHaveAttribute("aria-selected", "true");

  // ── A1-5：方向鍵（循環、同時切換並移焦點）與 Home ─────────────────────────
  const workspaceTab = tablist.getByRole("tab", { name: "Workspace", exact: true });
  const sharedTab = tablist.getByRole("tab", { name: "Shared with me", exact: true });
  const recentTab = tablist.getByRole("tab", { name: "Recent", exact: true });
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
  await page.keyboard.press("End");
  await expect(trashTab).toHaveAttribute("aria-selected", "true");
  await expect(trashTab).toBeFocused();
  await showSidebarTab(page, "Workspace");

  // ── A1-4：搜尋視圖 ────────────────────────────────────────────────────────
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(String(RUN));
  await expect(tablist).toHaveCount(0);
  // 限定在側欄：筆記頁的 ConnectionBadge 也是 role="status"。
  await expect(sidebar.getByRole("status")).toHaveText("1 result");
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

  // ── A1-6：390 寬抽屜 ─────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(noteUrl);
  // 等 lazy NotePage 掛上：fallback 自帶的 AppShell 會被換掉（drawerOpen／搜尋字串跟著重設）。
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerTabs = drawer.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
  await expect(drawerTabs).toHaveCount(5);
  // 與靜態卡一致：Workspace 仍選中（tab 存在 localStorage、兩份實例共用）
  await expect(drawer.getByRole("tab", { name: "Workspace", exact: true })).toHaveAttribute("aria-selected", "true");
  for (let i = 0; i < 5; i++) {
    const box = await drawerTabs.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.height).toBeLessThanOrEqual(44.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(drawer.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(drawerPanel.getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();
  await expect(drawerPanel.getByRole("link", { name: new RegExp("^" + reEscape(longTitle)) })).toBeVisible();
  // fixed 的抽屜溢出量不到 documentElement.scrollWidth，直接量清單內容。資料夾 PR-3b 起清單內層包層是 `overflow-x-clip`（安全網），
  // 清單本身恆不溢出；改量包層（`[data-sidebar-list] > div`）的內容寬度。
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
