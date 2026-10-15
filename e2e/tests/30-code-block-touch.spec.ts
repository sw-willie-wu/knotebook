import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * 2026-10-15：code block 的語言下拉搬進方塊內右上角，平常隱形。觸控沒有 hover，叫出它的路是「點進程式碼」
 * （`apps/web/src/collab/code-block-caret.ts` 掛 `data-caret-inside` → `index.css` 讓下拉現身）。
 * 單元測試守得到屬性有沒有掛、CSS 規則在不在；這裡守**只有真瀏覽器才有**的三件事：
 * (a) 隱形時 `pointer-events:none` 真的讓點擊穿過（hit-test），點那一角不會被看不見的下拉吃掉；
 * (b) 點進程式碼後下拉真的現身、且點得到——**不靠 hover**：Chromium 的觸控模擬點擊本身也會把 `:hover`
 *     掛到被點的元素上，所以斷言前先把滑鼠位置移開並確認 block 沒有 `:hover`，現身只能來自 caret 那條；
 * (c) 點下拉時焦點從編輯器交給 select：編輯器 blur → caret 屬性拿掉，清單展開後焦點又移進 option，
 *     下拉本體必須靠 `select:open`（`index.css` 的 `@supports (appearance: base-select)` 裡）繼續現身、
 *     繼續吃得到點擊，不能在交接時退回 `pointer-events:none`；最後在展開的清單裡點一個語言，確認真的改得到。
 *     （這段只在支援 base-select 的瀏覽器成立；Playwright 的 Chromium 支援。）
 */

const codeBlock = (page: Page) => page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("元素沒有 bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, locator: Locator): Promise<void> {
  const at = await center(locator);
  await page.touchscreen.tap(at.x, at.y);
}

/** 下拉的計算樣式與「它中心點的 hit-test 是不是它自己」。 */
function selectState(page: Page) {
  return codeBlock(page)
    .locator("select")
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { opacity: s.opacity, pointerEvents: s.pointerEvents, hitIsSelect: hit === el, hit: hit?.tagName ?? null };
    });
}

test("30 觸控：語言下拉隱形時不吃點擊；點進程式碼就現身、點得到；點它時焦點交接不讓它縮回去", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E code block touch ${Date.now()}`);

    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially("intro");
    await waitForEditorSelection(page);
    await page.keyboard.press("Enter");
    // ``` 圍欄 input rule（同 08-code-highlight）。
    await editor.pressSequentially("```ts ");
    await expect(codeBlock(page)).toHaveCount(1);
    await editor.pressSequentially("const answer = 42;");
    const select = codeBlock(page).locator("select");
    await expect(select).toHaveValue("typescript");

    // (a) 游標移出程式碼（點上面那段）、滑鼠也不在 block 上 ⇒ 隱形，且中心點的點擊穿過它。
    await tap(page, editor.getByText("intro", { exact: true }));
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await expect.poll(async () => (await selectState(page)).opacity).toBe("0");
    const hidden = await selectState(page);
    expect(hidden.pointerEvents, "隱形時要 pointer-events:none").toBe("none");
    expect(hidden.hitIsSelect, `隱形的下拉不得吃掉那一角的點擊（命中 ${hidden.hit}）`).toBe(false);

    // (b) 點進程式碼（第一行左段，離右上角的下拉很遠）⇒ 現身且點得到；hover 先移開，證明不是 :hover 撐的。
    const code = codeBlock(page).locator("code");
    const codeBox = await code.boundingBox();
    if (!codeBox) throw new Error("code 沒有 bounding box");
    await page.touchscreen.tap(codeBox.x + 12, codeBox.y + 10);
    await waitForEditorSelection(page);
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await expect(codeBlock(page)).toHaveAttribute("data-caret-inside", "true");
    await expect.poll(async () => (await selectState(page)).opacity).toBe("1");
    const shown = await selectState(page);
    expect(shown.pointerEvents, "現身時要點得到").toBe("auto");
    expect(shown.hitIsSelect, `現身的下拉中心點要命中它自己（命中 ${shown.hit}）`).toBe(true);

    // (c) 點下拉：清單展開、焦點交給它（base-select 會再移進被選中的 option），編輯器 blur ⇒ caret 屬性拿掉。
    //     手指一離開 block，下拉本體要靠 `select:open` 留著、仍點得到（`:focus` 撐不住：焦點在 option 上）。
    await tap(page, select);
    await expect.poll(() => select.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect(codeBlock(page)).not.toHaveAttribute("data-caret-inside");
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await page.waitForTimeout(300); // 等過 0.15s 的 opacity transition：要縮回去的話這時已經縮了
    const handedOver = await selectState(page);
    expect(handedOver.opacity, "清單開著時下拉本體不得淡出").toBe("1");
    expect(handedOver.pointerEvents, "焦點交接後不得縮回 pointer-events:none").toBe("auto");

    // 在展開的清單裡點 Python（headless Chromium 的 base-select 清單是真 DOM，tap 得到）。
    const python = select.locator('option[value="python"]');
    await expect(python).toBeInViewport();
    await tap(page, python);
    await expect(select).toHaveValue("python");
  } finally {
    await context.close();
  }
});
