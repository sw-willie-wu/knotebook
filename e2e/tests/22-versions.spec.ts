import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * 版本歷史 e2e（spec §11.3）：存（命名）→ 改 → 存 → 改 → 預覽 v1 看到 diff 標記 → 套用（「不儲存」）→ 內容回到 v1 →
 * 再改並存 → 清單出現「從 v1 接著改」→ 預覽期間另一個 context 改字、✕ 回來後游標與浮層正常 → 窄視窗（390）整頁兩步套用。
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

    // 預覽 v2（vs 前一版 v1）：beta-two 那顆是新增
    await panel.getByRole("button", { name: /^v2(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toContainText("Previewing v2");
    const diffBlocks = page.getByTestId("diff-single").locator("[data-diff]");
    await expect(diffBlocks.filter({ hasText: "beta-two" })).toHaveAttribute("data-diff", "added");
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

    // 預覽期間另一個 context 改字；✕ 回來後看得到遠端的字，且還能打字、`/` 選單正常
    await panel.getByRole("button", { name: /^v3(?!\d)/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();

    // RF3（gate r1 I-3）真鍵盤：預覽中開著儲存對話框／⋯ 列選單按 Esc → 只關浮層，預覽橫幅留著；沒有浮層時 Esc＝✕
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
    await page.getByTestId("preview-banner").getByRole("button", { name: "Close preview" }).click();
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
