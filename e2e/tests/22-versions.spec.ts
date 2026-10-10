import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * 並排逐區塊對齊（spec rev 12 §8.4）：兩欄頂層區塊帶 `data-diff-row`。同列兩側 top 相差 ≤ 1 px；只在一側出現的列，
 * 對面欄有一塊 `.kb-diff-spacer` 蓋住那一列的高度（容差 1 px）。`minSingle`：至少要有幾個單側列（避免空斷言）。
 * 版面在 layout effect／ResizeObserver＋rAF 裡寫，所以用 toPass 重試。一次 evaluate 讀完兩欄（同一個 layout 快照）。
 */
async function expectSplitAligned(page: Page, minSingle: number) {
  const split = page.getByTestId("diff-split");
  await expect(async () => {
    const m = await split.evaluate((root) => {
      const secs = Array.from(root.querySelectorAll<HTMLElement>(":scope > section"));
      return secs.map((sec) => ({
        blocks: Array.from(sec.querySelectorAll<HTMLElement>(".bn-editor > .bn-block-group > .bn-block-outer[data-diff-row]")).map((el) => ({
          row: el.dataset.diffRow!,
          top: el.getBoundingClientRect().top,
          height: el.offsetHeight,
        })),
        spacers: Array.from(sec.querySelectorAll<HTMLElement>(":scope > .kb-diff-spacer")).map((el) => ({ top: el.getBoundingClientRect().top, height: el.offsetHeight })),
      }));
    });
    expect(m).toHaveLength(2);
    const [L, R] = m;
    expect(L.blocks.length + R.blocks.length).toBeGreaterThan(0);
    let single = 0;
    for (const [mine, other] of [
      [L, R],
      [R, L],
    ] as const) {
      for (const blk of mine.blocks) {
        const twin = other.blocks.find((o) => o.row === blk.row);
        if (twin) {
          expect(Math.abs(twin.top - blk.top), `row ${blk.row} 兩側 top`).toBeLessThanOrEqual(1);
          continue;
        }
        single += 1;
        const covered = other.spacers.some((s) => s.top <= blk.top + 1 && s.top + s.height >= blk.top + blk.height - 1);
        expect(covered, `row ${blk.row} 單側列對面要有 spacer 蓋住 ${JSON.stringify(blk)}；spacers=${JSON.stringify(other.spacers)}`).toBe(true);
      }
    }
    expect(single).toBeGreaterThanOrEqual(minSingle);
  }).toPass({ timeout: 10_000 });
}

/**
 * 版本歷史 e2e（spec §11.3）：存（命名）→ 改 → 存 → 改 → 預覽 v1 看到 diff 標記 → 套用（「不儲存」）→ 內容回到 v1 →
 * 再改並存 → 清單出現「從 v1 接著改」→ 預覽期間另一個 context 改字、再點選中列離開預覽後游標與浮層正常 → 窄視窗（390）整頁兩步套用。
 * 自動切版要安靜 5 分鐘，本案只用手動儲存（Ctrl+S）建版；三切點的自動行為由 server 整合測試守（PR1）。
 *
 * 列的可及名稱是「v1 ＋（基底版的 sr-only 說明）＋名稱＋第二行」連成一串（例：`v1Manual · …`），所以列一律用
 * `/^vN(?!\d)/` 找（不讓 v1 撞到 v10 以後）；列的 ⋯ 是「Actions for vN」，不會被 `^vN` 撞到。
 * toast 斷言一律 `exact: true`（Radix toast 的 live region 會播報含子字串的文案）。
 */

async function saveVersion(page: Page, name?: string) {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  if (name) await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("Control+End");
  // Ctrl+End 是瀏覽器原生移游標，ProseMirror 要等 selectionchange 才跟上；沒等到就按 Enter 會在舊位置分段（見 helper 註解）
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

test("22 版本歷史：存、改、預覽 diff、套用、從 vX 接著改、遠端改字、窄視窗整頁", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const other = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E versions ${Date.now()}`);
    const url = page.url();

    await typeAtEnd(page, "alpha-one");
    await saveVersion(page, "milestone");
    await expect(page.getByText("Saved as v1", { exact: true })).toBeVisible();

    await typeAtEnd(page, "beta-two");
    await saveVersion(page);
    await expect(page.getByText("Saved as v2", { exact: true })).toBeVisible();
    await typeAtEnd(page, "gamma-three");

    // 面板：泡泡 → 清單有 v2、v1 milestone；目前狀態寫「v2 之後有未儲存的修改」（面板去抖動 1 s）
    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: /^v1(?!\d)/ })).toContainText("milestone");
    await expect(panel.getByTestId("versions-current")).toContainText("Unsaved changes after v2", { timeout: 10_000 });

    // 預覽 v2（rev 10：預設 vs 目前狀態）：v2 之後才打的 gamma-three 是新增，beta-two、alpha-one 未變
    await panel.getByRole("button", { name: /^v2(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toContainText("Previewing v2");
    // 1400 px 開面板：預覽區約 774 px ≥ 720 → 自動並排；兩欄標頭是左右一對下拉（rev 10）。切單欄再看 data-diff。
    await expect(page.getByTestId("diff-split")).toBeVisible();
    const splitHead = page.getByTestId("diff-split-head");
    await expect(splitHead.getByRole("button", { name: "Left side" })).toHaveText(/v2/);
    await expect(splitHead.getByRole("button", { name: "Right side" })).toHaveText(/Current state/);
    // rev 12 並排逐區塊對齊：v2 之後才打的 gamma-three 只在右欄 → 至少一個單側列，左欄同位置有斜紋 spacer。
    await expectSplitAligned(page, 1);
    await page.getByTestId("preview-banner").getByRole("button", { name: "Single column" }).click();
    const diffBlocks = page.getByTestId("diff-single").locator("[data-diff]");
    await expect(diffBlocks.filter({ hasText: "gamma-three" })).toHaveAttribute("data-diff", "added");
    await expect(diffBlocks.filter({ hasText: "beta-two" })).toHaveAttribute("data-diff", "context");
    await expect(diffBlocks.filter({ hasText: "alpha-one" })).toHaveAttribute("data-diff", "context");
    await expect(editorLocator(page)).toBeHidden();

    // 預覽 v1 → 套用 → dirty → 三選一「不儲存，直接套用」
    await panel.getByRole("button", { name: /^v1(?!\d)/ }).click();
    const applyV1 = page.getByTestId("versions-footer").getByRole("button", { name: "Apply v1" });
    // I-4／起草裁定 22：面板開著時右下泡泡堆疊讓到面板外側，不得蓋住「Apply v1」（04-ai 在共用疊上設好 AI 動作，AI 泡泡會在）
    const stack = page.getByTestId("corner-stack");
    if ((await stack.count()) > 0) {
      const s = (await stack.boundingBox())!;
      const btn = (await applyV1.boundingBox())!;
      const overlap = s.x < btn.x + btn.width && btn.x < s.x + s.width && s.y < btn.y + btn.height && btn.y < s.y + s.height;
      expect(overlap).toBe(false);
    }
    await applyV1.click();
    const applyDialog = page.getByRole("dialog", { name: "Apply v1" });
    await expect(applyDialog).toBeVisible();
    await applyDialog.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText("Applied v1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await expect(editorLocator(page)).toContainText("alpha-one");
    await expect(editorLocator(page)).not.toContainText("beta-two");
    await expect(editorLocator(page)).not.toContainText("gamma-three");

    // 再改 → 存 → v3 的副標有「continued from v1」
    await typeAtEnd(page, "delta-four");
    await saveVersion(page);
    await expect(panel.getByRole("button", { name: /^v3(?!\d)/ })).toContainText("continued from v1", { timeout: 10_000 });

    // 預覽期間另一個 context 改字；離開預覽後看得到遠端的字，且還能打字、`/` 選單正常
    await panel.getByRole("button", { name: /^v3(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    // RF3（gate r1 I-3）真鍵盤：預覽中開著儲存對話框／⋯ 列選單按 Esc → 只關浮層，預覽橫幅留著；沒有浮層時 Esc＝離開預覽
    // 先等 toast（「Saved as v3」，5 s）消失：toast 還在時第一下 Esc 被 Radix Toast 吃掉（關的是 toast、對話框留著），
    // 量的就不是本段要守的東西（Task 14 首跑實測：toast 在 → Esc 後對話框仍開；toast 不在 → 對話框關）。
    await expect(page.getByRole("region", { name: /^Notifications/ }).getByRole("listitem")).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press("Control+s");
    const saveDlg = page.getByRole("dialog", { name: "Save current version" });
    await expect(saveDlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(saveDlg).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await panel.getByRole("button", { name: "Actions for v3" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await panel.getByRole("button", { name: /^v3(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    const otherPage = await other.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.password);
    await otherPage.goto(url);
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await typeAtEnd(otherPage, "remote-five");
    // Task 19：橫幅沒有 ✕；再點已選中的 v3 列＝離開預覽（toggle）。
    await panel.getByRole("button", { name: /^v3(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await expect(editorLocator(page)).toContainText("remote-five", { timeout: 15_000 });
    await typeAtEnd(page, "local-six");
    await expect(editorLocator(otherPage)).toContainText("local-six", { timeout: 15_000 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    // slash 選單的 locator 同 22-presentation（`.bn-suggestion-menu`）
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".bn-suggestion-menu")).toBeHidden();

    // 窄視窗（390）：沒有歷史泡泡；⋮ → 版本歷史 → 整頁兩步 → 套用 v2
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("versions-bubble")).toBeHidden();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^v2(?!\d)/ }).click();
    await expect(sheet.getByTestId("diff-single")).toBeVisible();
    await sheet.getByTestId("sheet-footer").getByRole("button", { name: "Apply v2" }).click();
    // 一定 dirty：remote-five／local-six 在 v3 之後、且上面已在另一個 context 讀到 local-six（＝server 已收到），
    // 自動切版要安靜 5 分鐘不會插進來——所以三選一對話框必出，不寫成條件分支。
    const narrowApply = page.getByRole("dialog", { name: "Apply v2" });
    await expect(narrowApply).toBeVisible();
    await narrowApply.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText("Applied v2", { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Back", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(editorLocator(page)).toContainText("beta-two");
    await expect(editorLocator(page)).not.toContainText("local-six");
  } finally {
    await other.close();
    await ctx.close();
  }
});

test("22b 並排逐區塊對齊（spec rev 12）：中間插一段＋前一段改長 → 左 2 與右 3 同列、插入那列左欄留斜紋", async ({ browser }) => {
  test.setTimeout(120_000);
  const shotDir = process.env.VERSIONS_SCREENSHOT_DIR; // 目視截圖：設了才截，本檔不寫絕對路徑
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E split align ${Date.now()}`);
    await typeAtEnd(page, "one-top");
    await typeAtEnd(page, "two-bottom");
    await saveVersion(page);
    await expect(page.getByText("Saved as v1", { exact: true })).toBeVisible();

    const editor = editorLocator(page);
    // 中間插一段（one-top 之後）；再把 one-top 改長到在並排欄裡換行 → 同列兩側高度不同（矮側要補留白）。
    // 游標要確定落在 one-top 才按 Enter：插入曾跑到 two-bottom 之後（修正輪 1 本機一次、CI run 38047114343 一次）。
    // 原因不是存版對話框的焦點還原，而是 ProseMirror 還沒收到點擊／End 的 selectionchange（不經對話框也重現，見
    // `waitForEditorSelection` 註解）：DOM selection 已在 one-top，state.selection 還在 two-bottom 尾。所以除了 DOM
    // selection，還要等 ProseMirror 的 state 對齊；預覽前再斷言三段的順序。
    const caretAtEndOf = async (text: string) => {
      await expect(async () => {
        await editor.getByText(text).click();
        await page.keyboard.press("End");
        expect(await page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? "")).toContain(text);
        await waitForEditorSelection(page, 1_000);
      }).toPass({ timeout: 10_000 });
    };
    await caretAtEndOf("one-top");
    await page.keyboard.press("Enter");
    await page.keyboard.type("inserted-middle paragraph that exists only in the current state");
    await caretAtEndOf("one-top");
    await page.keyboard.type(" and now a much longer tail that wraps over several lines in the narrow side-by-side column of the preview");
    const order = await editor.innerText();
    expect(order).toContain("one-top and now a much longer tail");
    expect(order.indexOf("one-top")).toBeLessThan(order.indexOf("inserted-middle"));
    expect(order.indexOf("inserted-middle")).toBeLessThan(order.indexOf("two-bottom"));

    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await panel.getByRole("button", { name: /^v1(?!\d)/ }).click();
    await expect(page.getByTestId("diff-split")).toBeVisible();
    const split = page.getByTestId("diff-split");
    await expect(split.locator("section").nth(1).getByText("inserted-middle", { exact: false })).toBeVisible();
    await expectSplitAligned(page, 1);
    // 「左 2 跟右 3 對齊」：two-bottom 在兩欄同一列、top 相同
    const left = split.locator("section").nth(0).locator(".bn-block-outer", { hasText: "two-bottom" }).last();
    const right = split.locator("section").nth(1).locator(".bn-block-outer", { hasText: "two-bottom" }).last();
    await expect(left).toHaveAttribute("data-diff-row", (await right.getAttribute("data-diff-row"))!);
    expect(Math.abs((await left.boundingBox())!.y - (await right.boundingBox())!.y)).toBeLessThanOrEqual(1);
    await expect(split.locator("section").nth(0).locator(".kb-diff-spacer")).toHaveCount(1);
    if (shotDir) {
      await page.screenshot({ path: path.join(shotDir, "task-2-split-align.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await expectSplitAligned(page, 1);
      await page.screenshot({ path: path.join(shotDir, "task-2-split-align-dark.png") });
    }
  } finally {
    await ctx.close();
  }
});
