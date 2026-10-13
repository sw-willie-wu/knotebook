import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createNote, loginAs, openGroupPanel, openSiteAdmin } from "./helpers.js";

/**
 * #247 §11.3：三個管理面板（個人設定、群組、站台管理）的外殼在真瀏覽器裡的行為——
 * 1440×900 三面板截圖、390×844 雙層（開啟即內容層、返回到項次層）與兩條焦點時序（§4.6 的 useLayoutEffect，jsdom 測不到）、
 * 開啟焦點落點（§4.7：寬在 ✕、窄在返回鈕）、內容層 `getByRole("dialog", { name })`（左卡 hidden 時標題仍是
 * aria-labelledby 直接引用的節點）、Esc 回背景頁、舊網址轉址、§4.8 全站 outline hover 填色三處。
 * 目視用截圖：設了 `PANELS_SCREENSHOT_DIR` 才截，未設就略過；本檔不寫任何絕對路徑。
 */
const shotDir = process.env.PANELS_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
}

async function createGroup(page: Page, name: string): Promise<void> {
  const sidebar = page.getByRole("complementary");
  const newGroup = sidebar.getByRole("button", { name: "New group", exact: true });
  // 全新的疊（單獨跑本檔）上 admin 一篇筆記都沒有：側欄只有「No notes yet.」空狀態、沒有 Workspace 區段與「New group」鈕。
  // 先建一篇再回 `/`，讓本檔不依賴前面 spec 留下的資料。
  const empty = sidebar.getByText("No notes yet.", { exact: true });
  await expect(newGroup.or(empty)).toBeVisible();
  if (await empty.isVisible()) {
    await createNote(page, `E2E Panels seed ${Date.now()}`);
    await page.goto("/");
  }
  await newGroup.click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByLabel("Group name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * 外框 outline 鈕 hover 要填色（§4.8，W17）：hover 後背景要「等於」`--brand-deep` 的實際色（`button.tsx` outline 變體的
 * `hover:bg-brand-deep`）。只斷「不是透明」不夠：`transition-colors` 的第一個中間影格就會過關（截圖會截到半途），
 * 呼叫端若另加了底色（at rest 就不透明）也會過關——兩者都讓斷言失去鑑別力。期望色在頁內用暫時元素解析 CSS 變數得到。
 */
async function expectOutlineHoverFilled(page: Page, scope: ReturnType<Page["locator"]>, name: string): Promise<void> {
  const button = scope.getByRole("button", { name, exact: true });
  const brandDeep = await button.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--brand-deep)";
    el.parentElement!.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  expect(brandDeep).not.toBe("rgba(0, 0, 0, 0)");
  await button.hover();
  await expect.poll(async () => button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(brandDeep);
}

/** 元素的框整個落在視窗內（不只是「部分可見」）。用框量、不用 `toBeInViewport()`：後者有一點交集就過關。 */
async function expectInViewport(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test.describe.serial("24 管理面板（#247）", () => {
  test("24-1 1440×900：三個面板各開一次（標題、左卡項次 aria-current；個人設定另驗開啟焦點在 ✕）→ Esc 回背景頁", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Panels ${Date.now()}`;
      await createGroup(page, groupName);

      // 個人設定
      await page.getByRole("button", { name: "admin", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Account info" })).toHaveAttribute("aria-current", "page");
      await expect(settings.getByRole("button", { name: "Close" })).toBeFocused();
      // 截圖前等右卡 lazy 區塊真的畫出來（否則截到「Loading…」）。
      await expect(settings.getByRole("heading", { level: 1 })).toBeVisible();
      await shot(page, "24-settings-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await expect(settings).toHaveCount(0);

      // 群組
      await openGroupPanel(page, groupName);
      const group = page.getByRole("dialog", { name: groupName });
      await expect(group.getByRole("navigation", { name: groupName }).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
      await expect(group.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
      await shot(page, "24-group-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);

      // 站台管理
      const admin = await openSiteAdmin(page);
      await expect(admin.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
      await expect(admin.getByRole("heading", { level: 1, name: "User management" })).toBeVisible();
      // #267：「最後活動」欄——管理員自己剛才的 session 請求就是活動，那列顯示 Online（欄序同表頭：第 6 欄）。
      await expect(admin.getByRole("columnheader").nth(5)).toHaveText("Last active");
      const selfRow = admin.getByRole("row").filter({ has: page.getByText(ADMIN.email, { exact: true }) });
      await expect(selfRow.getByRole("cell").nth(5)).toHaveText("Online");
      await shot(page, "24-admin-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await context.close();
    }
  });

  test("24-2 390×844：開啟即內容層（dialog 可及名稱仍在、焦點在返回鈕）→ 返回到項次層（焦點在 aria-current 項次）→ 再點該項次回內容層（焦點在內容容器）", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      await page.goto("/admin/users");
      const dialog = page.getByRole("dialog", { name: "Site admin" });
      await expect(dialog).toBeVisible();
      const back = dialog.getByRole("button", { name: "Back to sections" });
      await expect(back).toBeVisible();
      await expect(back).toBeFocused();
      await expect(dialog.getByRole("navigation", { name: "Site admin" })).toBeHidden();
      await expect(dialog.getByRole("heading", { level: 1, name: "User management" })).toBeVisible();
      // 窄視窗內容層：使用者表比 390 寬，曾把右卡（連同 ✕）推出視窗右緣——✕ 要整顆在視窗內。
      await expect(dialog.getByText(ADMIN.email, { exact: true })).toBeVisible();
      await expectInViewport(page, dialog.getByRole("button", { name: "Close" }));
      await shot(page, "24-admin-390-content.png");

      await back.click();
      const current = dialog.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: "Users" });
      await expect(current).toBeVisible();
      await expect(current).toHaveAttribute("aria-current", "page");
      await expect(current).toBeFocused();
      await expect(dialog.locator("[data-management-content]")).toBeHidden();
      await expect(page).toHaveURL(/\/admin\/users$/);
      await shot(page, "24-admin-390-items.png");

      await current.click();
      await expect(dialog.locator("[data-management-content]")).toBeVisible();
      await expect(dialog.locator("[data-management-content]")).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("24-3 舊網址轉址：/settings/groups/<id> → /groups/<id>；/settings/users → /admin/users；/admin、/admin/auth、/admin/versions → 站台 modal 對應項次", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Redirect ${Date.now()}`;
      await createGroup(page, groupName);
      const groupId = await openGroupPanel(page, groupName);
      await page.keyboard.press("Escape");

      await page.goto(`/settings/groups/${groupId}`);
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`));
      await expect(page.getByRole("dialog", { name: groupName })).toBeVisible();
      await page.goto(`/settings/groups/${groupId}/roles`);
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));

      for (const [from, to] of [
        ["/settings/users", /\/admin\/users$/],
        ["/admin", /\/admin\/users$/],
        ["/admin/auth", /\/admin\/login$/],
        ["/admin/versions", /\/admin\/storage$/],
      ] as const) {
        await page.goto(from);
        await expect(page).toHaveURL(to);
        await expect(page.getByRole("dialog", { name: "Site admin" })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });

  test("24-4 §4.8 全站 outline hover 填色（三處截圖）：分享面板、改密碼頁、刪除群組確認框的取消鈕", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Outline ${Date.now()}`;
      await createGroup(page, groupName);

      // 1. 刪除群組確認框的 Cancel（outline）
      await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
      await page.getByRole("menuitem", { name: "Delete group" }).click();
      const del = page.getByRole("dialog", { name: "Delete group?" });
      await expectOutlineHoverFilled(page, del, "Cancel");
      await shot(page, "24-outline-delete-cancel.png");
      await del.getByRole("button", { name: "Cancel", exact: true }).click();

      // 2. 分享面板：群組筆記的分享面板沒有 outline 鈕（只有說明、連結與公開連結 switch）——改在個人筆記的分享面板，
      //    選「Members only」後出現的加人表單送出鈕「Add」（`ShareDialog.tsx:181`，variant outline）做 hover 斷言。
      await createNote(page, `E2E Outline note ${Date.now()}`);
      await page.getByRole("button", { name: "Share", exact: true }).click();
      const share = page.getByRole("dialog", { name: "Share note" });
      await expect(share).toBeVisible();
      await share.getByRole("radio", { name: "Members only" }).check();
      await expectOutlineHoverFilled(page, share, "Add");
      await shot(page, "24-outline-share.png");
      await page.keyboard.press("Escape");

      // 3. 改密碼頁（整頁，`tone="page"`）：只有 brandSolid 送出鈕、沒有 outline 鈕——只截圖（spec §4.8「抽三處截圖」），不做 hover 斷言。
      await page.goto("/change-password");
      // 截圖前等頁面真的畫出來（lazy chunk）：未旗標的帳號也能直接開這頁（路由不擋）。
      await expect(page.getByRole("button", { name: "Change password", exact: true })).toBeVisible();
      await shot(page, "24-outline-change-password.png");
    } finally {
      await context.close();
    }
  });

  test("24-5 1280×720：右卡內容長過面板時在右卡內捲動，托盤不撐出面板、✕ 留在視窗內（panel 的 grid 軌道 minmax(0,1fr)）", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      // 「Authorization」頁有 API token 區＋MCP 接法三步，空帳號也比 720 高的面板長，不必另外灌資料。
      await page.goto("/settings/authorization");
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog.getByRole("heading", { level: 1, name: "Authorization" })).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 2, name: "Connect Claude with MCP" })).toBeVisible();
      const content = dialog.locator("[data-management-content]");
      await expect
        .poll(async () => content.evaluate((el) => el.scrollHeight - el.clientHeight), {
          message: "右卡內容區要自己捲動（scrollHeight > clientHeight）；軌道被內容撐大時兩者相等、整塊溢出視窗",
        })
        .toBeGreaterThan(0);
      // 托盤（內容區的祖父）不得超出 DialogContent（role=dialog 本身）的框。
      const overflow = await content.evaluate((el) => {
        const tray = el.parentElement!.parentElement!.getBoundingClientRect();
        const box = el.closest('[role="dialog"]')!.getBoundingClientRect();
        return Math.max(box.left - tray.left, box.top - tray.top, tray.right - box.right, tray.bottom - box.bottom);
      });
      expect(overflow).toBeLessThanOrEqual(0.5);
      await expectInViewport(page, dialog.getByRole("button", { name: "Close" }));
    } finally {
      await context.close();
    }
  });
});
