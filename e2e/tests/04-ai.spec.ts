import { test, expect, type Page } from "@playwright/test";
import { ADMIN, adminNav, createNote, editorLocator, loginAs, openSelectionAiBox, openSiteAdmin, waitForEditorSelection } from "./helpers.js";

/**
 * §14.5 流程 4（#263 改版）：站台管理 modal（`/admin/ai`）建 provider（指向 ai-stub）＋ model → 框選文字 → 工具列 AI 鈕開框 →
 * 自由指令（Instruct）→ 串流 → diff 預覽 → 套用（框關閉）→ Ctrl+Z；chip（direct 的 Rewrite）自動套用 → 還原；守門（ai-stub 拉長串流、
 * 第二個 context 改錨點 → 框顯示「原文已變更」、沒有套用鈕、direct 自動套用失敗的 toast；同一支順帶驗串流中捲走後、完成時焦點移進框
 * 不把筆記捲回去）。
 *
 * ai-stub base URL 一律填 app 容器視角（`http://ai-stub:9500/...`）。ai-stub 不看請求內容，任何動作（含 Instruct）都回固定的
 * FINAL_CONTENT。auto 解析 model 靠 `apps/server/src/ai/resolve.ts` 的排序取第一筆；本檔全程只建這一顆 enabled 的 chat model。
 * 三支測試 `serial`：第一支建 provider，第二支沿用 `/fast`，第三支把它改成 `/slow`。
 */

// 模組層 `RUN_ID`：三支 `serial` 測試共用同一顆 provider/model，名稱寫死會在「失敗保留疊、手動重跑」時撞名。
const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E AI Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E AI Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // ai-stub 固定輸出（e2e/stubs/ai-stub.mjs FINAL_CONTENT）
const REASONING_MARKER = "internal reasoning"; // ai-stub 固定塞進 reasoning_content 的字樣，server 絕不轉送
const STALE_TEXT = "The original text has changed since this was opened.";
const GUARD_TOAST = "The original text changed since this result was generated, so it wasn't applied.";

async function openAiSettings(page: Page): Promise<void> {
  await openSiteAdmin(page);
  await adminNav(page, "AI agents");
}

async function leaveAdmin(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
}

/** provider 列：#247 起每個供應商是以名稱為可及名稱的 `region`。 */
function providerCardLocator(page: Page, name: string) {
  return page.getByRole("region", { name });
}

/**
 * 筆記頁的捲動容器＝主編輯器最近一個會捲的祖先（筆記卡 `overflow-y-auto`；頁面本身不捲，`window.scrollY` 恆 0）。
 * `to` 有給就先捲到那裡（`"nearBottom"`＝離底 40px，留餘裕給內容高度的小幅變動）。回傳捲動後的 scrollTop、`window.scrollY`、
 * 以及框底緣與容器頂緣的視窗座標（框底緣在容器頂緣之上＝框已捲出可視範圍）。
 */
async function noteScroll(page: Page, to?: "nearBottom") {
  return editorLocator(page).evaluate((el, target) => {
    let node: HTMLElement | null = el.parentElement;
    while (node && !(/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight)) node = node.parentElement;
    if (!node) throw new Error("找不到筆記的捲動容器");
    if (target === "nearBottom") node.scrollTop = node.scrollHeight - node.clientHeight - 40;
    const boxEl = document.querySelector('[data-testid="selection-ai-box"]');
    return {
      scrollTop: node.scrollTop,
      windowScrollY: window.scrollY,
      boxBottom: boxEl ? boxEl.getBoundingClientRect().bottom : null,
      scrollerTop: node.getBoundingClientRect().top,
    };
  }, to);
}

test.describe.configure({ mode: "serial" });

test("建 provider/model → 框選 → 指令 → 串流不洩漏 reasoning → diff 預覽 → 套用（框關閉）→ Ctrl+Z 還原", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);

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
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    await expect(providerCard.getByRole("listitem").filter({ hasText: MODEL_DISPLAY_NAME })).toBeVisible();

    await leaveAdmin(page);
    await createNote(page, `E2E ai ${Date.now()}`);
    await expect(page).toHaveURL(/\/n\//);
    const original = "Selecting this phrase should trigger a rewrite action.";
    const editor = editorLocator(page);
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    await editor.pressSequentially(original);

    // ── 框選 → AI 鈕 → 框（焦點在指令輸入框）→ 打指令 Enter ──
    const box = await openSelectionAiBox(page, original);
    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await expect(input).toBeFocused();
    await input.fill("Make it shorter");
    await input.press("Enter");

    // ── 串流完成 → diff 預覽（/fast 幾乎同步寫完，不釘中繼的 Generating…）。reasoning 不洩漏只能在這支驗。──
    const preview = box.getByTestId("selection-ai-preview");
    await expect(preview).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
    await expect(box).not.toContainText(REASONING_MARKER);
    const apply = box.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();

    // ── 手動套用 → 框關閉（S1）；Ctrl+Z 還原（undo 生命線 #97）──
    await expect(box).toBeHidden();
    await expect(editor).toContainText(REWRITTEN_TEXT);
    await expect(editor).not.toContainText(original);
    await page.keyboard.press("Control+z");
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText(REWRITTEN_TEXT);
  } finally {
    await context.close();
  }
});

test("chip（direct 的 Rewrite）：串流完自動套用、框留著顯示 Revert；Revert 後回到 Apply／Discard／Retry", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E ai chip ${Date.now()}`);
    const original = "Chip rewrite paragraph that gets replaced automatically.";
    const editor = editorLocator(page);
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    await editor.pressSequentially(original);

    const box = await openSelectionAiBox(page, original);
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    const revert = box.getByRole("button", { name: "Revert", exact: true });
    await expect(revert).toBeVisible({ timeout: 15_000 });
    await expect(editor).toContainText(REWRITTEN_TEXT);
    await expect(editor).not.toContainText(original);

    await revert.click();
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText(REWRITTEN_TEXT);
    await expect(box).toBeVisible();
    await expect(revert).toHaveCount(0);
    for (const name of ["Apply", "Discard", "Retry"]) await expect(box.getByRole("button", { name, exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("守門：provider 改指向 /slow → 串流中第二個 context 改錨點 → 框顯示原文已變更、沒有套用鈕；direct 自動套用失敗的 toast", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, ADMIN.email, ADMIN.password);
    await expect(ownerPage).toHaveURL(/\/$/);

    await openAiSettings(ownerPage);
    const providerCard = providerCardLocator(ownerPage, PROVIDER_NAME);
    await expect(providerCard).toBeVisible();
    await providerCard.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editProviderDialog = ownerPage.getByRole("dialog", { name: "Edit provider" });
    await editProviderDialog.getByLabel("Base URL", { exact: true }).fill("http://ai-stub:9500/slow");
    await editProviderDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editProviderDialog).not.toBeVisible();
    await expect(providerCard).toContainText("http://ai-stub:9500/slow");
    await leaveAdmin(ownerPage);

    await createNote(ownerPage, `E2E ai guard ${Date.now()}`);
    const noteUrl = ownerPage.url();
    const original = "Guarded paragraph awaiting a concurrent edit mid stream.";
    const ownerEditor = editorLocator(ownerPage);
    await ownerEditor.click();
    await ownerEditor.pressSequentially(original);
    // 段落下方墊 50 個空段落，讓筆記卡捲得動（下面驗「完成時焦點移進框不捲動頁面」用）。
    for (let i = 0; i < 50; i += 1) await ownerPage.keyboard.press("Enter");

    const otherPage = await otherContext.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.password);
    await otherPage.goto(noteUrl);
    const otherEditor = editorLocator(otherPage);
    await expect(otherEditor).toContainText(original, { timeout: 15_000 });

    // ── owner：框選 → Rewrite chip（/slow：~11 秒的串流窗口）──
    const box = await openSelectionAiBox(ownerPage, original);
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(box.getByText("Generating…", { exact: true })).toBeVisible();

    // ── 串流中：第二個 context 改同一個錨點段落（點在段落文字本身，不能點容器空白處——會落到尾端的 trailing block）──
    const editedMarker = "EDITED BY SECOND CONTEXT";
    await otherEditor.getByText(original, { exact: true }).click();
    await waitForEditorSelection(otherPage); // click→End→打字前等 PM 讀進 DOM caret（helpers 檔頭：不等會落在舊位置）
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(` ${editedMarker}`);
    await expect(ownerEditor).toContainText(editedMarker, { timeout: 10_000 });

    // ── 框：串流中就顯示「原文已變更」；串流結束時自動套用撞守門 → toast，框裡沒有套用鈕、只剩捨棄 ──
    await expect(box.getByText(STALE_TEXT, { exact: true })).toBeVisible();

    // ── 串流中把筆記捲到底（框捲出可視範圍）；完成時焦點移進框容器（焦點原在框內的取消鈕）用 preventScroll，捲動位置不得變（§5.3）──
    const scrolled = await noteScroll(ownerPage, "nearBottom");
    await expect(box.getByText("Generating…", { exact: true })).toBeVisible(); // 前提：捲動發生在串流完成之前
    expect(scrolled.boxBottom).not.toBeNull();
    expect(scrolled.boxBottom!).toBeLessThan(scrolled.scrollerTop);
    await expect(ownerPage.getByText(GUARD_TOAST, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(box).toBeFocused(); // 完成時焦點確實移進了框容器（不然「沒捲動」不證明什麼）
    expect(await noteScroll(ownerPage)).toMatchObject({ scrollTop: scrolled.scrollTop, windowScrollY: scrolled.windowScrollY });
    await expect(box.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    await expect(box.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0); // 錨點已變：重試也收掉（§5.2）
    await expect(box.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(ownerEditor).toContainText(editedMarker);
    await expect(ownerEditor).not.toContainText(REWRITTEN_TEXT);
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});
