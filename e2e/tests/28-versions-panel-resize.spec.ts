import { test, expect, type Page, type Locator } from "@playwright/test";
import { ADMIN, createNote, loginAs } from "./helpers.js";

/**
 * #274 版本面板右欄可拖曳調寬（真瀏覽器量測）：預設 320、拖曳／上下限／雙擊／鍵盤、localStorage 重整後仍在、
 * 把手命中（elementFromPoint）、與側欄把手互不影響、窄視窗沒有可見的版本面板把手。
 * 寬度一律用 boundingBox 實測；拖曳用真滑鼠（pointer capture）。
 */

const PANEL_KEY = "versions.panelWidth";

function panelOf(page: Page): Locator {
  return page.getByTestId("versions-panel");
}
function handleOf(page: Page): Locator {
  return panelOf(page).getByRole("separator", { name: "Resize versions panel" });
}
function sidebarHandleOf(page: Page): Locator {
  return page.getByRole("separator", { name: "Resize sidebar" });
}
async function widthOf(loc: Locator): Promise<number> {
  return (await loc.boundingBox())!.width;
}
async function openPanel(page: Page): Promise<void> {
  if (!(await panelOf(page).isVisible())) await page.getByTestId("versions-bubble").click();
  await expect(panelOf(page)).toBeVisible();
  await expect(handleOf(page)).toBeVisible();
}
/** 抓把手中心、水平拖 dx px（先走兩步讓 pointermove 連發），放開。 */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}
async function expectWidth(loc: Locator, expected: number, tol = 1): Promise<void> {
  await expect.poll(async () => Math.abs((await widthOf(loc)) - expected), { timeout: 5_000, message: `寬度應約 ${expected}` }).toBeLessThanOrEqual(tol);
}

test("28 版本面板調寬：預設 320、拖曳、重整保留、上下限、雙擊、鍵盤、命中、與側欄獨立", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E panel resize ${Date.now()}`);
    await page.evaluate((k) => window.localStorage.removeItem(k), PANEL_KEY);
    await page.reload();
    await openPanel(page);
    const panel = panelOf(page);
    const handle = handleOf(page);

    // 1. 預設 320
    await expectWidth(panel, 320);
    await expect(handle).toHaveAttribute("aria-valuenow", "320");

    // 6. 把手命中：中心點的最上層元素是把手本身或其子孫
    const hit = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { isHandle: !!top && (top === el || el.contains(top)), top: top ? `${top.tagName}.${top.className}` : null };
    });
    expect(hit.isHandle, `elementFromPoint=${hit.top}`).toBe(true);
    // 把手上下兩端也要命中（不只中心）
    const hitEnds = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.y + 8, r.y + r.height - 8].map((y) => {
        const top = document.elementFromPoint(r.x + r.width / 2, y);
        return !!top && (top === el || el.contains(top));
      });
    });
    expect(hitEnds).toEqual([true, true]);

    // 2. 往左拖 100 → 420；重整後仍 420
    await dragBy(page, handle, -100);
    await expectWidth(panel, 420);
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    expect(await page.evaluate((k) => window.localStorage.getItem(k), PANEL_KEY)).toBe("420");
    await page.reload();
    await openPanel(page);
    await expectWidth(panel, 420);

    // 3. 上限 560、下限 240
    await dragBy(page, handleOf(page), -400);
    await expectWidth(panel, 560);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), PANEL_KEY)).toBe("560");
    await dragBy(page, handleOf(page), 600);
    await expectWidth(panel, 240);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), PANEL_KEY)).toBe("240");

    // 4. 雙擊回 320（預設值＝移除鍵）
    await handleOf(page).dblclick();
    await expectWidth(panel, 320);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), PANEL_KEY)).toBeNull();

    // 5. 鍵盤：聚焦後 ArrowLeft 變寬 16、ArrowRight 變窄 16
    await handleOf(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expectWidth(panel, 336);
    await page.keyboard.press("ArrowRight");
    await expectWidth(panel, 320);
    await page.keyboard.press("End");
    await expectWidth(panel, 560);
    await page.keyboard.press("Home");
    await expectWidth(panel, 240);
    await handleOf(page).dblclick();
    await expectWidth(panel, 320);

    // 7. 側欄把手仍可拖，且兩個寬度互不影響
    const sidebar = page.locator("aside").first();
    const sideBefore = await widthOf(sidebar);
    await dragBy(page, handleOf(page), -80);
    await expectWidth(panel, 400);
    expect(Math.abs((await widthOf(sidebar)) - sideBefore)).toBeLessThanOrEqual(1);
    await dragBy(page, sidebarHandleOf(page), 40);
    await expectWidth(sidebar, sideBefore + 40);
    await expectWidth(panel, 400);
    await dragBy(page, sidebarHandleOf(page), -40);
    await expectWidth(sidebar, sideBefore);
    await expectWidth(panel, 400);
  } finally {
    await ctx.close();
  }
});

test("28b 窄視窗（390）開版本：沒有可見的版本面板把手（含寬視窗開著面板再縮窄）", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E panel narrow ${Date.now()}`);
    const anyHandle = page.getByRole("separator", { name: "Resize versions panel" });
    // 寬視窗開著面板 → 把手可見；縮到 390 → 面板（與把手）離開寬版配置，不得留可見把手
    await openPanel(page);
    await expect(anyHandle.filter({ visible: true })).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("versions-bubble")).toBeHidden();
    await expect(anyHandle.filter({ visible: true })).toHaveCount(0);
    // 窄視窗從 ⋮ 開整頁版本歷史：同樣沒有可見把手
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByRole("dialog", { name: "Version history" })).toBeVisible();
    await expect(anyHandle.filter({ visible: true })).toHaveCount(0);
    const boxes = await anyHandle.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height, display: getComputedStyle(e).display };
      }),
    );
    for (const b of boxes) expect(b.display === "none" || b.w === 0 || b.h === 0, JSON.stringify(b)).toBe(true);
  } finally {
    await ctx.close();
  }
});
