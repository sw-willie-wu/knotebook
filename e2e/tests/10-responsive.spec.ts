import { test, expect, type Page } from "@playwright/test";
import { ADMIN, adminNav, createNote, editorLocator, loginAs, openSelectionAiBox, openSiteAdmin } from "./helpers.js";

/**
 * #115 版面改版：窄視窗（<768）的抽屜導覽；#263 起 AI 段驗框選 AI 框的寬度。
 *
 * 佈局策略：provider/model 的建立與筆記內容輸入都在**預設 1280 視窗**完成（站台
 * 管理 modal 的表單在 390 下擁擠，且不是本檔要驗的東西），然後 `setViewportSize(390×844)`
 * 驗窄視窗行為。AI provider **自建**（流程照 04-ai 的建置段）——不依賴 04 殘留
 * 狀態（plan gate M4）。
 *
 * 自建 provider 讓工具列的 AI 鈕出現（動作清單非空），並勾「Default model」：本檔跑一次 Instruct 到結果態，auto 解析要選到這顆
 * 指向 `/fast` 的 model（全套順序下 04 留下的 provider 已被改指 `/slow`，同 25 的說法）。
 *
 * 幾何：框選 AI 框寬度 ≤ 視窗寬減 16（框寬＝區塊寬＋外框，上限 calc(100vw - 16px)），左右都不出視窗；結果態（框蓋在區塊上）同樣不出視窗。
 */

const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E RWD Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E RWD Model ${RUN_ID}`;

async function openAiSettings(page: Page): Promise<void> {
  await openSiteAdmin(page);
  await adminNav(page, "AI agents");
}

/** 供應商的明細列（spec 2026-10-13 settings-table §3 #1：「＜名稱＞ details」，模型子表與「Add model」在這裡；同 04-ai）。 */
function providerDetailsLocator(page: Page, name: string) {
  return page.getByRole("row", { name: `${name} details`, exact: true });
}

test("窄視窗：靜態側欄隱藏、抽屜導覽、框選 AI 框不超出視窗", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
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

    const providerDetails = providerDetailsLocator(page, PROVIDER_NAME);
    await expect(providerDetails).toBeVisible();
    await providerDetails.getByRole("button", { name: "Add model", exact: true }).click();
    const createModelDialog = page.getByRole("dialog", { name: "Add model" });
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-rwd-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    // 站台管理 modal 蓋在首頁上，後面 createNote 要先關掉它——把『真的回到 /』釘住。
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);

    // ── 1280：建筆記＋打一段文字 ─────────────────────────────────────────────
    const title = `E2E rwd ${RUN_ID}`;
    await createNote(page, title);
    const original = "Narrow viewport paragraph for the AI box.";
    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially(original);

    // ── 縮到 390×844：窄視窗行為 ────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });

    // 靜態側欄（hidden）：New note 鈕不可見；頁首漢堡（md:hidden）可見。
    await expect(page.getByRole("button", { name: "New note", exact: true })).toBeHidden();
    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible();

    // 抽屜（在首頁開，點筆記連結 → 真的導航＋route change 自動關）。先回首頁：
    // 停在同一篇筆記上點自己的連結 pathname 不變、不會觸發自動關。
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "New note", exact: true })).toBeVisible();
    // `.first()` 保險用；改版後側欄只渲染目前 tab。
    await drawer.getByRole("link", { name: title }).first().click();
    await page.waitForURL(/\/n\//, { timeout: 15_000 }); // #122：側欄連結是 /n/<handle>/<slug> 新形
    await expect(drawer).not.toBeVisible();
    // 回到筆記頁再驗 Escape 這條關法（頁首漢堡開）。
    await hamburger.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();

    // #263：窄視窗下框選 AI 框照樣出現，寬度不超過視窗寬減 16、左右不出視窗；框內 Esc 關閉。
    const box = await openSelectionAiBox(page, original);
    const boxRect = (await box.boundingBox())!;
    expect(boxRect.width).toBeLessThanOrEqual(390 - 16);
    // 寬度＝錨點區塊 `.bn-block-outer` 寬＋左右外框 2px。390 寬實量：區塊 324、框 326、框 x=33——上面的 ≤ 374 離得太遠，寬度邏輯壞掉也照綠
    // （e2e 突變把框寬固定成 302px 時，≤ 374 照過、紅在下一行：差 24）。
    const anchorWidth = (await editor.locator(".bn-block-outer").filter({ hasText: original }).boundingBox())!.width;
    expect(Math.abs(boxRect.width - (anchorWidth + 2))).toBeLessThanOrEqual(1);
    expect(boxRect.x).toBeGreaterThanOrEqual(0);
    expect(boxRect.x + boxRect.width).toBeLessThanOrEqual(390);

    // 結果態（#263 後續：框改蓋在區塊上、placement 換成 bottom-start）：左右仍不出視窗（容差 1px）。
    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await input.fill("Shorten it");
    await input.press("Enter");
    await expect(box.getByTestId("selection-ai-preview")).toContainText("E2E rewritten text", { timeout: 15_000 });
    const doneRect = (await box.boundingBox())!;
    expect(doneRect.x).toBeGreaterThanOrEqual(-1);
    expect(doneRect.x + doneRect.width).toBeLessThanOrEqual(390 + 1);
    await box.press("Escape");
    await expect(box).toBeHidden();
  } finally {
    await context.close();
  }
});
