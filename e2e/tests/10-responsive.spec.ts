import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * #115 版面改版：窄視窗（<768）的抽屜導覽與 AI bubble 浮層。
 *
 * 佈局策略：provider/model 的建立與筆記內容輸入都在**預設 1280 視窗**完成（設定
 * modal 的表單在 390 下擁擠，且不是本檔要驗的東西），然後 `setViewportSize(390×844)`
 * 驗窄視窗行為。AI provider **自建**（流程照 04-ai 的建置段）——不依賴 04 殘留
 * 狀態（plan gate M4）；在已跑過 01 的疊上單獨 `--grep` 本檔會綠。
 *
 * ⚠ 與 04 有一處刻意不同：**這裡的「Default model」勾選是承重的**。04 的註解說
 * isDefault 不是那條鏈的必要條件（該檔只有一顆 model），但全套順序下 04 留下的
 * model createdAt 較早、且其 provider 已被 04 第二支測試改指 `/slow`——本檔靠
 * admin-ai 建立時「unset 其他 chat model 的 default」讓 auto 解析選到自己的
 * `/fast`。拿掉 `.check()` 的話 Rewrite 會靜默改走 `/slow`（~11s 串流對 15s
 * 預算），綠但測錯東西。
 *
 * 幾何斷言帶 ±2px 容差：bubble 距視窗右下 20px（<md）、48px 圓鈕；浮層滿寬
 * （inset-x-3＝視窗寬 −24）、底緣與 bubble 同線（bottom-5＝20px）。
 */

const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E RWD Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E RWD Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // ai-stub 固定輸出（e2e/stubs/ai-stub.mjs FINAL_CONTENT）

async function openAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
}

function providerCardLocator(page: Page, name: string) {
  return page.locator("div.rounded-md.border.border-border.p-4").filter({
    has: page.getByRole("heading", { name, level: 3 }),
  });
}

test("窄視窗：靜態側欄隱藏、抽屜導覽、AI bubble 展開成滿寬浮層並跑完整動作", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.newPassword);
    await expect(page).toHaveURL(/\/$/);

    // ── 1280：建 provider（ai-stub /fast）＋ model（照 04-ai 慣例）────────────
    await openAiSettings(page);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const createProviderDialog = page.getByRole("dialog", { name: "Add provider" });
    await createProviderDialog.locator("#ai-provider-name").fill(PROVIDER_NAME);
    await createProviderDialog.locator("#ai-provider-type").selectOption("openai_compatible");
    await createProviderDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/fast");
    await createProviderDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createProviderDialog).not.toBeVisible();

    const providerCard = providerCardLocator(page, PROVIDER_NAME);
    await expect(providerCard).toBeVisible();
    await providerCard.getByRole("button", { name: "Add model", exact: true }).click();
    const createModelDialog = page.getByRole("dialog", { name: "Add model" });
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-rwd-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    await page.keyboard.press("Escape"); // 關設定 modal，回背景頁
    // modal 沒關的話 Radix 會把背景 aria-hidden，後面 createNote 的「New note」
    // 永遠找不到、症狀是逾時＋誤導訊息——這裡先把「真的回到背景頁」釘住。
    await expect(page).toHaveURL(/\/$/);

    // ── 1280：建筆記＋打一段文字 ─────────────────────────────────────────────
    const title = `E2E rwd ${RUN_ID}`;
    await createNote(page, title);
    const original = "Narrow viewport paragraph for the whole-note rewrite.";
    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially(original);

    // ── 縮到 390×844：窄視窗行為 ────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });

    // 靜態側欄（hidden）：New note 鈕不可見；頁首漢堡（md:hidden）可見。
    await expect(page.getByRole("button", { name: "New note" })).toBeHidden();
    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible();

    // 抽屜（在首頁開，點筆記連結 → 真的導航＋route change 自動關）。先回首頁：
    // 停在同一篇筆記上點自己的連結 pathname 不變、不會觸發自動關。
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "New note" })).toBeVisible();
    // `.first()`：NoteList 的「Recent」與主清單刻意重複顯示同一篇（該檔檔頭明訂），
    // 單數查詢會 strict-mode violation。
    await drawer.getByRole("link", { name: title }).first().click();
    await page.waitForURL(/\/notes\//, { timeout: 15_000 });
    await expect(drawer).not.toBeVisible();
    // 回到筆記頁再驗 Escape 這條關法（頁首漢堡開）。
    await hamburger.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();

    // AI bubble：位置（距右下各 20px、48px 圓鈕）。
    const bubble = page.getByTestId("ai-bubble");
    await expect(bubble).toBeVisible();
    const bubbleBox = (await bubble.boundingBox())!;
    expect(Math.abs(bubbleBox.width - 48)).toBeLessThanOrEqual(2);
    expect(Math.abs(390 - (bubbleBox.x + bubbleBox.width) - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(844 - (bubbleBox.y + bubbleBox.height) - 20)).toBeLessThanOrEqual(2);

    // 點開 → 滿寬底部浮層（inset-x-3：寬＝390−24；底緣與 bubble 同線 20px）。
    await bubble.click();
    const panel = page.getByTestId("ai-panel");
    await expect(panel).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    expect(Math.abs(panelBox.x - 12)).toBeLessThanOrEqual(2);
    expect(Math.abs(panelBox.width - (390 - 24))).toBeLessThanOrEqual(2);
    expect(Math.abs(844 - (panelBox.y + panelBox.height) - 20)).toBeLessThanOrEqual(2);

    // 浮層裡跑全文 Rewrite（無選取 → 強制 preview）→ Apply → 內文換字。
    await panel.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Apply", exact: true })).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(editor).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
    await expect(editor).not.toContainText(original);

    // 收合回 bubble。
    await panel.getByRole("button", { name: "Collapse AI panel" }).click();
    await expect(panel).not.toBeVisible();
    await expect(bubble).toBeVisible();
  } finally {
    await context.close();
  }
});
