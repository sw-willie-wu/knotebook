import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, reEscape, setAutoWait, versionLabelOf, waitForEditorSelection } from "./helpers.js";

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
 * 版本歷史 e2e（spec §11.3；#272 起 UI 不顯示 vN）：存（milestone）→ 改 → 存（second）→ 改 → 預覽 second 看到 diff 標記 →
 * 套用 milestone（「不儲存」）→ 內容回到 milestone → 再改並存（third）→ 清單出現「沿自 milestone (…)」→ 預覽期間另一個 context 改字、
 * 再點選中列離開預覽後游標與浮層正常 → 窄視窗（390）整頁兩步套用。
 * 自動存版要停手 X 分鐘（站台預設 5），本案只用手動儲存（Ctrl+S）建版；自動存版由 server 整合測試與 22c（測試縫把 X 壓成秒）守。
 *
 * #272：列的可及名稱是「名稱 (短 id)＋（自動版本的「Auto-saved」pill）＋第二行」連成一串，所以手動版本一律帶名稱、列一律用
 * `/^名稱 \(/` 找；列的 ⋯ 是「Actions for 名稱 (短 id)」，不會被 `^名稱` 撞到。短 id 是 uuid 前 7 碼，斷言用 `[0-9a-f]{7}`。
 * toast 斷言一律整句錨定（`/^…$/`；Radix toast 的 live region 會播報含子字串的文案）。
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

test("22 版本歷史：存、改、預覽 diff、套用、沿自「名稱 (短 id)」接著改、遠端改字、窄視窗整頁", async ({ browser }) => {
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
    await expect(page.getByText(/^Saved as milestone \([0-9a-f]{7}\)$/)).toBeVisible();

    await typeAtEnd(page, "beta-two");
    await saveVersion(page, "second");
    await expect(page.getByText(/^Saved as second \([0-9a-f]{7}\)$/)).toBeVisible();
    await typeAtEnd(page, "gamma-three");

    // 面板：泡泡 → 清單有 second、milestone；目前狀態寫「Based on second (…) · unsaved changes」（面板去抖動 1 s）
    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: /^milestone \(/ })).toContainText("milestone");
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on second \([0-9a-f]{7}\) · unsaved changes/, { timeout: 10_000 });
    // #258：手動版本的列沒有「Auto-saved」pill、沒有「Manual／Auto」文字、沒有基底綠點。
    await expect(panel.getByTestId("auto-badge")).toHaveCount(0);
    await expect(panel.getByTestId("base-dot")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^second \(/ })).not.toContainText(/Manual|Auto/);

    // 預覽 second（rev 10：預設 vs 目前狀態）：second 之後才打的 gamma-three 是新增，beta-two、alpha-one 未變
    await panel.getByRole("button", { name: /^second \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toContainText(/Previewing second \([0-9a-f]{7}\)/);
    // 1400 px 開面板：預覽區約 774 px ≥ 720 → 自動並排；兩欄標頭是左右一對下拉（rev 10）。切單欄再看 data-diff。
    await expect(page.getByTestId("diff-split")).toBeVisible();
    const splitHead = page.getByTestId("diff-split-head");
    await expect(splitHead.getByRole("button", { name: "Left side" })).toHaveText(/^second \(/);
    await expect(splitHead.getByRole("button", { name: "Right side" })).toHaveText(/Current state/);
    // rev 12 並排逐區塊對齊：second 之後才打的 gamma-three 只在右欄 → 至少一個單側列，左欄同位置有斜紋 spacer。
    await expectSplitAligned(page, 1);
    await page.getByTestId("preview-banner").getByRole("button", { name: "Single column" }).click();
    const diffBlocks = page.getByTestId("diff-single").locator("[data-diff]");
    await expect(diffBlocks.filter({ hasText: "gamma-three" })).toHaveAttribute("data-diff", "added");
    await expect(diffBlocks.filter({ hasText: "beta-two" })).toHaveAttribute("data-diff", "context");
    await expect(diffBlocks.filter({ hasText: "alpha-one" })).toHaveAttribute("data-diff", "context");
    await expect(editorLocator(page)).toBeHidden();

    // 預覽 milestone → 套用 → dirty → 三選一「不儲存，直接套用」
    await panel.getByRole("button", { name: /^milestone \(/ }).click();
    const applyV1 = page.getByTestId("versions-footer").getByRole("button", { name: /^Apply milestone \(/ });
    // I-4／起草裁定 22：面板開著時右下泡泡堆疊讓到面板外側，不得蓋住「Apply milestone (…)」（#263 起容器裡只剩歷史泡泡，面板開著時整個容器不渲染；容器若在，就不得蓋住）
    const stack = page.getByTestId("corner-stack");
    if ((await stack.count()) > 0) {
      const s = (await stack.boundingBox())!;
      const btn = (await applyV1.boundingBox())!;
      const overlap = s.x < btn.x + btn.width && btn.x < s.x + s.width && s.y < btn.y + btn.height && btn.y < s.y + s.height;
      expect(overlap).toBe(false);
    }
    await applyV1.click();
    const applyDialog = page.getByRole("dialog", { name: /^Apply milestone \(/ });
    await expect(applyDialog).toBeVisible();
    await applyDialog.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText(/^Applied milestone \([0-9a-f]{7}\)$/)).toBeVisible();
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await expect(editorLocator(page)).toContainText("alpha-one");
    await expect(editorLocator(page)).not.toContainText("beta-two");
    await expect(editorLocator(page)).not.toContainText("gamma-three");

    // 再改 → 存 third → 它的副標有「based on milestone (…)」；目前狀態寫「Based on third (…) · no changes」
    await typeAtEnd(page, "delta-four");
    await saveVersion(page, "third");
    await expect(panel.getByRole("button", { name: /^third \(/ })).toContainText(/based on milestone \([0-9a-f]{7}\)/, { timeout: 10_000 });
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on third \([0-9a-f]{7}\) · no changes/, { timeout: 10_000 });

    // 預覽期間另一個 context 改字；離開預覽後看得到遠端的字，且還能打字、`/` 選單正常
    await panel.getByRole("button", { name: /^third \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    // RF3（gate r1 I-3）真鍵盤：預覽中開著儲存對話框／⋯ 列選單按 Esc → 只關浮層，預覽橫幅留著；沒有浮層時 Esc＝離開預覽
    // 先等 toast（「Saved as third (…)」，5 s）消失：toast 還在時第一下 Esc 被 Radix Toast 吃掉（關的是 toast、對話框留著），
    // 量的就不是本段要守的東西（Task 14 首跑實測：toast 在 → Esc 後對話框仍開；toast 不在 → 對話框關）。
    await expect(page.getByRole("region", { name: /^Notifications/ }).getByRole("listitem")).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press("Control+s");
    const saveDlg = page.getByRole("dialog", { name: "Save current version" });
    await expect(saveDlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(saveDlg).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await panel.getByRole("button", { name: /^Actions for third \(/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await panel.getByRole("button", { name: /^third \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    const otherPage = await other.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.password);
    await otherPage.goto(url);
    await expect(otherPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await typeAtEnd(otherPage, "remote-five");
    // Task 19：橫幅沒有 ✕；再點已選中的 third 列＝離開預覽（toggle）。
    await panel.getByRole("button", { name: /^third \(/ }).click();
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

    // 窄視窗（390）：沒有歷史泡泡；⋮ → 版本歷史 → 整頁兩步 → 套用 second
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("versions-bubble")).toBeHidden();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^second \(/ }).click();
    await expect(sheet.getByTestId("diff-single")).toBeVisible();
    await sheet.getByTestId("sheet-footer").getByRole("button", { name: /^Apply second \(/ }).click();
    // 一定 dirty：remote-five／local-six 在 third 之後、且上面已在另一個 context 讀到 local-six（＝server 已收到），
    // 自動存版要停手 5 分鐘（站台預設）不會插進來——所以三選一對話框必出，不寫成條件分支。
    const narrowApply = page.getByRole("dialog", { name: /^Apply second \(/ });
    await expect(narrowApply).toBeVisible();
    await narrowApply.getByRole("button", { name: "Apply without saving" }).click();
    await expect(page.getByText(/^Applied second \([0-9a-f]{7}\)$/)).toBeVisible();
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
    await saveVersion(page, "base");
    await expect(page.getByText(/^Saved as base \([0-9a-f]{7}\)$/)).toBeVisible();

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
    await panel.getByRole("button", { name: /^base \(/ }).click();
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

test("22c 版本清單篩選（#258）＋停手 X 才自動存（#272）：自動版本標 pill、全部／僅手動切換、預覽不受影響、localStorage 記憶、切筆記不關面板", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginAs(page, ADMIN.email, ADMIN.password);
    // #272：測試縫把等待 X 壓到 2 秒（e2e 疊每秒掃一次）；看到自動版本後、以及 finally，一律設回 null（＝站台設定 5 分鐘）。
    await setAutoWait(page, 2);
    const titleA = `E2E vfilter A ${Date.now()}`;
    const titleB = `E2E vfilter B ${Date.now()}`;
    // B 先建（之後切筆記用，沒有任何版本）；再建 A、在 A 打字。
    await createNote(page, titleB);
    await createNote(page, titleA);
    const noteA = await noteIdFromUrl(page);
    await typeAtEnd(page, "auto-source-text");
    // 不離開 A：停手 2 秒後 server 自動存一版（kind=auto）。面板清單不輪詢，所以重整重試到 pill 出現為止。
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("versions-bubble").click();
      await expect(page.getByTestId("versions-panel").getByTestId("auto-badge")).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
    // 立刻把 X 設回站台值：之後打的字在手動存 keeper 之前不會被自動切走（否則 toast 會變成「Same content as …」）。
    await setAutoWait(page, null);
    const autoLabel = await versionLabelOf(page.request, noteA, (v) => v.kind === "auto");
    const shortId = autoLabel.slice(-8, -1);
    const panel = page.getByTestId("versions-panel");
    const autoRow = panel.getByRole("button", { name: new RegExp(`^${reEscape(autoLabel)}`) });
    await expect(autoRow).toContainText("Auto-saved");
    await expect(autoRow).not.toContainText(/Manual|Auto\b(?!-)/);
    await typeAtEnd(page, "manual-line");
    await saveVersion(page, "keeper");
    await expect(page.getByText(/^Saved as keeper \([0-9a-f]{7}\)$/)).toBeVisible();
    const keeperRow = panel.getByRole("button", { name: /^keeper \(/ });
    await expect(keeperRow).toBeVisible();
    await expect(keeperRow).not.toContainText("Auto-saved");
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on keeper \([0-9a-f]{7}\) · no changes/, { timeout: 10_000 });

    // 預覽自動版本，再切「僅手動」：清單只剩 keeper，但預覽（橫幅、左下拉的自動版本）不受影響。
    const filter = panel.getByTestId("versions-filter");
    const allBtn = filter.getByRole("button", { name: "All", exact: true });
    const manualBtn = filter.getByRole("button", { name: "Manual only", exact: true });
    await expect(allBtn).toHaveAttribute("aria-pressed", "true");
    await autoRow.click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    await manualBtn.click();
    await expect(manualBtn).toHaveAttribute("aria-pressed", "true");
    await expect(allBtn).toHaveAttribute("aria-pressed", "false");
    await expect(autoRow).toHaveCount(0);
    await expect(keeperRow).toBeVisible();
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    await expect(page.getByRole("button", { name: "Left side" }).first()).toHaveText(autoLabel);
    await expect(panel.getByTestId("versions-footer").getByRole("button", { name: `Apply ${autoLabel}` })).toBeEnabled();
    // 比較下拉跟著篩選：左邊只列 keeper（自動版本被篩掉）、右邊是「Current state」＋ keeper。
    await page.getByRole("button", { name: "Left side" }).first().click();
    const leftItems = page.getByRole("menuitemradio");
    await expect(leftItems).toHaveCount(1);
    await expect(leftItems.first()).toHaveText(/^keeper \(/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    // 目前狀態副標不受篩選影響。
    await expect(panel.getByTestId("versions-current")).toContainText(/Based on keeper \([0-9a-f]{7}\) · no changes/);
    // 切回「全部」：自動版本回來，預覽仍在。
    await allBtn.click();
    await expect(autoRow).toBeVisible();
    await expect(banner).toContainText(`Previewing ${autoLabel}`);
    await autoRow.click(); // 再點已選中的列＝離開預覽
    await expect(banner).toBeHidden();

    // 自動版本改名＝轉手動：「僅手動」立刻出現它（改名後的標籤是「promoted (同一個短 id)」）。
    await manualBtn.click();
    await expect(autoRow).toHaveCount(0);
    await allBtn.click();
    await expect(autoRow).toBeVisible();
    await panel.getByRole("button", { name: `Actions for ${autoLabel}` }).click();
    await page.getByRole("menuitem", { name: "Edit version name" }).click();
    const renameDlg = page.getByRole("dialog", { name: `Edit name of ${autoLabel}` });
    await renameDlg.getByRole("textbox").fill("promoted");
    await renameDlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(renameDlg).toBeHidden();
    const promotedRow = panel.getByRole("button", { name: new RegExp(`^promoted \\(${shortId}\\)`) });
    await expect(promotedRow).not.toContainText("Auto-saved");
    await manualBtn.click();
    await expect(promotedRow).toBeVisible();

    // localStorage 記憶：重整後面板一開就是「僅手動」。
    expect(await page.evaluate(() => window.localStorage.getItem("knotebook.versions.filter"))).toBe("manual");
    await page.reload();
    await page.getByTestId("versions-bubble").click();
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true })).toHaveAttribute("aria-pressed", "true");

    // 切筆記不關面板、篩選不重設：點側欄的 B（沒有任何版本）→ 面板還在、仍是「僅手動」、顯示篩選空狀態。
    // 側欄同一篇會出現在「最近」與「我的筆記」兩區，取第一個。
    await page.getByRole("link", { name: titleB }).first().click();
    await expect(page.getByTestId("versions-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("versions-panel").getByTestId("versions-filter-empty")).toContainText("No manually saved versions");
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /^promoted \(/ })).toHaveCount(0);
    // 切到全部：B 沒有版本，清單空（沒有 A 的列殘留）——任何「… (短 id)」形的列都不該在。
    await page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /\([0-9a-f]{7}\)/ })).toHaveCount(0);
    await page.getByTestId("versions-panel").getByTestId("versions-filter").getByRole("button", { name: "Manual only", exact: true }).click();
    // 回 A：面板仍開著，列回來。
    await page.getByRole("link", { name: titleA }).first().click();
    await expect(page.getByTestId("versions-panel").getByRole("button", { name: /^promoted \(/ })).toBeVisible({ timeout: 15_000 });
  } finally {
    await setAutoWait(page, null).catch(() => undefined);
    await ctx.close();
  }
});
