import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * 側欄與版本面板的三段版面（真瀏覽器量測）：
 * - 視窗 ≥ 1280：側欄固定在左側，版本面板是筆記右側的第三欄（`position: relative`）。
 * - 視窗 640–1279：沒有固定側欄，頁首側欄鈕（Open sidebar）開抽屜；版本面板浮在筆記上（`position: absolute`），
 *   上緣在頁首下緣，頁首的分享與 ⋮ 不被蓋；抽屜寬度吃 sidebar.width，至少讓出 4rem。
 * - 視窗 < 640：版本歷史由 ⋮ 開整頁。
 * 邊界（1279／1280、639／640）兩側各量一格；浮動面板的收起規則：只開清單時點筆記收起、差異檢視中點筆記不收、面板內 Esc 收起。
 * 頁首與寬度的細部量測在 52-header-policy。
 *
 * - L1 768 與 1024：沒有固定側欄；抽屜的開關（遮罩、Esc、選筆記）與焦點回側欄鈕。
 * - L2 抽屜寬度吃 sidebar.width：768 寬 400；390 寬至少讓出 4rem。
 * - L3 768 與 1024 的版本面板：在頁首下方；只開清單時點筆記收起；差異檢視中點筆記不收；面板內 Esc 收起。
 * - L4 1279 浮動、1280 固定：側欄與面板的形態各量一格。
 * - L5 640：由歷史泡泡開浮動面板（⋮ 沒有 Version history）；639 改由 ⋮ 開整頁。
 * - L6 1024 開著面板拉到 1400：面板還在、清單捲動位置不變。
 * - L7 預覽時右側讓出面板寬度：1024 預覽區、1270 並排右欄都不被蓋住。
 * - L8 面板載入失敗的錯誤外框：重試鈕沒有被擋住。
 * - L9 面板開著時 Ctrl+K 開抽屜，點遮罩只關抽屜。
 */

const RUN = Date.now();
const SIDEBAR_KEY = "sidebar.width";

const headerOf = (page: Page): Locator => page.locator("header").filter({ has: page.getByRole("button", { name: "More", exact: true }) }).first();
const panelOf = (page: Page): Locator => page.getByTestId("versions-panel");
const drawerOf = (page: Page): Locator => page.getByRole("dialog", { name: "Navigation" });
const openSidebar = (page: Page): Locator => page.getByRole("button", { name: "Open sidebar" });
/** 固定側欄：含「New note」鈕的 complementary（版本面板也是 aside，不能只數 complementary）。 */
const dockedSidebarOf = (page: Page): Locator => page.getByRole("complementary").filter({ has: page.getByRole("button", { name: "New note", exact: true }) });

async function setViewport(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
}

async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title, { timeout: 15_000 });
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("Control+End");
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** 點筆記內文（點文字本身：編輯器左上角常被區塊的拖曳把手蓋住）。 */
const clickNoteText = (page: Page): Promise<void> => editorLocator(page).getByText("paragraph 2", { exact: true }).click();

const positionOf = (el: Locator): Promise<string> => el.evaluate((node) => getComputedStyle(node).position);

async function openPanel(page: Page): Promise<Locator> {
  await page.getByTestId("versions-bubble").click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** 浮動面板開著時：上緣落在頁首下緣（框線重疊 1 px 以內），頁首的分享與 ⋮ 右緣不被面板蓋住。 */
async function expectPanelBelowHeader(page: Page, tag: string): Promise<void> {
  const header = headerOf(page);
  const headerBox = (await header.boundingBox())!;
  const panelBox = (await panelOf(page).boundingBox())!;
  const detail = JSON.stringify({ tag, headerBottom: headerBox.y + headerBox.height, panelTop: panelBox.y });
  expect(panelBox.y, `面板上緣應在頁首下緣之下 ${detail}`).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  for (const name of ["Share", "More"]) {
    const box = (await header.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.y + box.height, `${name} 不該在面板底下 ${detail}`).toBeLessThanOrEqual(panelBox.y + 1);
  }
}

let page: Page;
let noteUrl: string;
let otherTitle: string;
let title: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  otherTitle = `E2E tiers other ${RUN}`;
  await createNote(page, otherTitle);
  title = `E2E tiers ${RUN}`;
  await createNote(page, title);
  noteUrl = page.url();
  // 十幾個版本：清單夠長才捲得動（捲動位置在跨 1280 時要保留）
  for (let i = 1; i <= 14; i += 1) {
    await typeAtEnd(page, `paragraph ${i}`);
    await saveVersion(page, `v-${String(i).padStart(2, "0")}`);
  }
  await typeAtEnd(page, "unsaved tail");
  // 「Saved as …」的 toast 開著時，Esc 先關 toast；等它自己消失，後面的 Esc 才會落在抽屜與面板上。
  await expect(page.getByText(/^Saved as /)).toHaveCount(0, { timeout: 20_000 });
});

test.afterAll(async () => {
  await page.context().close();
});

test.beforeEach(async () => {
  await page.evaluate((k) => window.localStorage.removeItem(k), SIDEBAR_KEY);
  await setViewport(page, 1440);
});

test("L1 768 與 1024：沒有固定側欄；側欄鈕開抽屜，點遮罩、Esc、選筆記都收，焦點回側欄鈕", async () => {
  test.setTimeout(120_000);
  for (const vw of [768, 1024]) {
    await setViewport(page, vw);
    await expect(dockedSidebarOf(page), `${vw}：固定側欄不顯示`).toHaveCount(0);
    const opener = openSidebar(page);
    await expect(opener).toBeVisible();

    await opener.click();
    await expect(drawerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawerOf(page)).toBeHidden();
    await expect(opener, `${vw}：Esc 關閉後焦點回側欄鈕`).toBeFocused();

    await opener.click();
    await expect(drawerOf(page)).toBeVisible();
    await page.mouse.click(vw - 10, 450); // 抽屜右側露出的遮罩
    await expect(drawerOf(page)).toBeHidden();
    await expect(opener, `${vw}：點遮罩關閉後焦點回側欄鈕`).toBeFocused();

    await opener.click();
    await drawerOf(page).getByRole("link", { name: otherTitle }).first().click();
    await expect(drawerOf(page)).toBeHidden();
    await waitForNoteTitle(page, otherTitle);
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
  }
});

test("L2 抽屜寬度吃 sidebar.width：768 寬 400；390 寬至少讓出 4rem（≤ 326）", async () => {
  test.setTimeout(90_000);
  await page.evaluate((k) => window.localStorage.setItem(k, "400"), SIDEBAR_KEY);
  await page.reload();
  await waitForNoteTitle(page, title);
  await setViewport(page, 768);
  await openSidebar(page).click();
  const wide = (await drawerOf(page).boundingBox())!;
  expect(Math.abs(wide.width - 400), `768 寬的抽屜寬 ${wide.width}`).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(drawerOf(page)).toBeHidden();

  await setViewport(page, 390, 844);
  await openSidebar(page).click();
  const narrow = (await drawerOf(page).boundingBox())!;
  expect(narrow.width, `390 寬的抽屜寬 ${narrow.width}`).toBeLessThanOrEqual(390 - 64 + 1);
  await page.keyboard.press("Escape");
  await expect(drawerOf(page)).toBeHidden();
  // 還原：記憶體裡的側欄寬度只有重整才會跟著 localStorage 回預設，後面的案子不該帶著 400 跑。
  await page.evaluate((k) => window.localStorage.removeItem(k), SIDEBAR_KEY);
  await page.reload();
  await waitForNoteTitle(page, title);
});

test("L3 768 與 1024 開版本面板：面板在頁首下方；只開清單時點筆記收起；差異檢視中點筆記不收；面板內 Esc 收起", async () => {
  test.setTimeout(120_000);
  for (const vw of [768, 1024]) {
    await setViewport(page, vw);
    const panel = await openPanel(page);
    await expectPanelBelowHeader(page, `L3 ${vw}`);

    // 只開清單：點筆記內文 → 收起
    await clickNoteText(page);
    await expect(panel, `${vw}：只開清單時點筆記要收起`).toBeHidden();

    // 差異檢視中：點筆記內文不收
    await openPanel(page);
    await panel.getByRole("button", { name: /^v-03 \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await page.getByTestId("preview-slot").getByText("paragraph 2").first().click();
    await expect(panel, `${vw}：差異檢視中點筆記不收`).toBeVisible();

    // 面板內 Esc：連預覽一起收起，焦點回歷史泡泡
    await panel.getByRole("button", { name: /^v-03 \(/ }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await expect(page.getByTestId("versions-bubble")).toBeFocused();
  }
});

test("L4 1279 浮動、1280 固定：側欄與版本面板的形態各量一格", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1279);
  await expect(dockedSidebarOf(page)).toHaveCount(0);
  await expect(openSidebar(page)).toBeVisible();
  const floating = await openPanel(page);
  expect(await positionOf(floating), "1279：面板浮在筆記上").toBe("absolute");
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
  await expect(floating).toBeHidden();

  await setViewport(page, 1280);
  await expect(dockedSidebarOf(page)).toBeVisible();
  await expect(openSidebar(page)).toBeHidden();
  const docked = await openPanel(page);
  expect(await positionOf(docked), "1280：面板是第三欄").toBe("relative");
  // 並排：頁首不被切
  const headerBox = (await headerOf(page).boundingBox())!;
  for (const name of ["Share", "More"]) {
    const box = (await headerOf(page).getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.x + box.width, `1280：${name} 超出頁首`).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);
  }
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});

test("L5 640 由歷史泡泡開浮動面板（⋮ 沒有 Version history）；639 改由 ⋮ 開整頁", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 640);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Width", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Version history" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const floating = await openPanel(page);
  expect(await positionOf(floating)).toBe("absolute");
  await expectPanelBelowHeader(page, "L5 640");

  // 跨 640：面板與預覽都關，改走 ⋮
  await setViewport(page, 639, 800);
  await expect(page.getByTestId("versions-panel")).toHaveCount(0);
  await expect(page.getByTestId("versions-bubble")).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const sheet = page.getByRole("dialog", { name: "Version history" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.width, `639 寬整頁 ${box.width}`).toBeGreaterThanOrEqual(639 - 1);
  expect(box.height, `整頁高 ${box.height}`).toBeGreaterThanOrEqual(800 - 1);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("L6 1024 開著面板拉到 1400：面板還在、清單捲動位置不變", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 600);
  const panel = await openPanel(page);
  const list = panel.locator("ul").first();
  await list.evaluate((el) => {
    el.scrollTop = 150; // 低於兩段版面各自的最大捲動量，才不會被夾住而誤判成位置變了
  });
  const before = await list.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(before.max, "清單要夠長才捲得動").toBeGreaterThan(200);
  expect(before.top).toBe(150);
  await setViewport(page, 1400, 600);
  await expect(panelOf(page)).toBeVisible();
  expect(await positionOf(panelOf(page)), "1400 面板是第三欄").toBe("relative");
  const after = await panelOf(page).locator("ul").first().evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before.top), `捲動位置 ${before.top} → ${after}`).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});

test("L7 預覽時右側讓出面板寬度：1024 預覽區右緣不超過面板；1270 夠寬並排，右欄也不被蓋住", async () => {
  test.setTimeout(90_000);
  for (const vw of [1024, 1270]) {
    await setViewport(page, vw, 900);
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: /^v-05 \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    const slotBox = (await page.getByTestId("preview-slot").boundingBox())!;
    expect(slotBox.x + slotBox.width, `${vw}：預覽區右緣 ${slotBox.x + slotBox.width} 應 ≤ 面板左緣 ${panelBox.x} + 1`).toBeLessThanOrEqual(panelBox.x + 1);
    if (vw === 1270) {
      const split = page.getByTestId("diff-split");
      await expect(split, "1270 的預覽區夠寬，預設並排").toBeVisible();
      const splitBox = (await split.boundingBox())!;
      expect(splitBox.x + splitBox.width, `並排右緣 ${splitBox.x + splitBox.width} 應 ≤ 面板左緣 ${panelBox.x} + 1`).toBeLessThanOrEqual(panelBox.x + 1);
    }
    await page.getByRole("button", { name: "Close version history", exact: true }).click();
    await expect(panel).toBeHidden();
  }
});

test("L8 面板載入失敗的錯誤外框：重試鈕沒有被擋住，可以按", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 900);
  await page.route(/\/assets\/VersionsLazy-[^/]*\.js/, (route) => route.abort());
  try {
    await page.reload();
    await waitForNoteTitle(page, title);
    // 第一次載入失敗會自動重整一次（sessionStorage 旗標防迴圈，重整後面板是關的）；擋著不放，重新開第二次才停在「Try again」。
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(async () => {
      await waitForNoteTitle(page, title);
      if ((await retry.count()) === 0) await page.getByTestId("versions-bubble").click({ timeout: 3_000 });
      await expect(retry).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await retry.click({ trial: true });
  } finally {
    await page.unroute(/\/assets\/VersionsLazy-[^/]*\.js/);
    await page.evaluate(() => window.sessionStorage.removeItem("knotebook:chunk-reload:versions"));
  }
  await page.reload();
  await waitForNoteTitle(page, title);
});

test("L9 面板開著時 Ctrl+K 開抽屜，點遮罩只關抽屜，面板留在原位", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 900);
  const panel = await openPanel(page);
  await page.keyboard.press("Control+k");
  await expect(drawerOf(page)).toBeVisible();
  await page.mouse.click(1024 - 10, 450);
  await expect(drawerOf(page)).toBeHidden();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});
