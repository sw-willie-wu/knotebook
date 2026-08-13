import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * §14.5 流程 4：設定 modal 建 provider（指向 ai-stub）＋ model → AI 動作 apply →
 * revert → 守門（ai-stub 拉長串流、另一 context 改錨點 block → 中止提示）。
 * 「admin AI 三層 CRUD」（provider 建立＋編輯／model 建立）順帶獲得覆蓋。
 *
 * ai-stub base URL 一律填 app 容器視角（`http://ai-stub:9500/...`，見
 * `docker-compose.e2e.yml` 的 compose 網路，非瀏覽器視角的 `localhost`）。內建動作
 * 「Rewrite」（`applyMode: "direct"`，`modelId` 留空＝auto——見
 * `apps/server/src/db/seed-ai.ts`）：選取文字時 `forcePreview=false`，串流結束會
 * 自動套用，不需要手動按「Apply」；auto-apply 失敗（守門）才會出現「Apply」鈕讓
 * 使用者自行決定。auto 解析 model 靠 `apps/server/src/ai/resolve.ts` 的
 * `ORDER BY isDefault DESC, createdAt ASC, id ASC` 排序取第一筆——`isDefault`
 * **只是排序偏好**，不是可用性開關（該檔頭註解逐字明訂）；本檔全程只建這一顆
 * enabled 的 chat model，即使不勾「Default model」它也會是唯一候選、一樣被選中。
 * 建 model 時仍勾它，純粹是照真實 admin 操作流程走（多 model 情境下才會實際影響
 * 排序），不是這條鏈能不能吃到的必要條件。
 */

// 模組層 `RUN_ID`：兩支 `serial` 測試共用同一顆 provider/model（第二支只 PATCH
// baseUrl），名稱寫死會在「失敗保留疊、手動重跑」時撞名——`providerCardLocator`
// 用 provider 名稱鎖定範圍，重跑撞出兩張同名卡片會是 strict-mode violation，
// 蓋掉真正的失敗原因（fix round 1 Minor-2）。
const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E AI Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E AI Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // ai-stub 固定輸出（e2e/stubs/ai-stub.mjs FINAL_CONTENT）
const REASONING_MARKER = "internal reasoning"; // ai-stub 固定塞進 reasoning_content 的字樣，server 絕不轉送給 client（apps/server/src/routes/ai.ts）

/** UserMenu →「Settings」→ 設定 modal 內點 nav link 到 `/settings/ai`（帶著
 * `backgroundLocation`，Esc 關閉時才回得去呼叫端目前所在的背景頁，不會落回 `/`）。 */
async function openAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
}

/** provider 卡片（`ProviderCard`，`space-y-3 rounded-md border border-border p-4`）——
 * 用卡片內的 `<h3>` provider 名稱鎖定範圍，避免誤中卡片內嵌的 model 列（同樣有
 * 「Edit」/「Delete」等同名按鈕）。 */
function providerCardLocator(page: Page, name: string) {
  return page.locator("div.rounded-md.border.border-border.p-4").filter({
    has: page.getByRole("heading", { name, level: 3 }),
  });
}

test.describe.configure({ mode: "serial" }); // 兩支測試共用同一顆 provider（第二支改它的 baseUrl）——單 worker 下本已序列，這裡把意圖寫明。

test("設定 modal 建 provider/model → toolbar 改寫 → 串流不洩漏 reasoning → 套用 → revert", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.newPassword);
    await expect(page).toHaveURL(/\/$/);

    const title = `E2E ai ${Date.now()}`;
    await createNote(page, title);
    const original = "Selecting this phrase should trigger a rewrite action.";
    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially(original);

    // ── 設定 modal：建 provider（openai_compatible，指向 ai-stub /fast，無 key）──
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

    // ── 建 model：勾「Default model」──────────────────────────────────
    // 不是「auto 解析挑中它」的必要條件（這是本檔唯一一顆 enabled 的 chat
    // model，isDefault 與否都會是唯一候選，見檔頭 `apps/server/src/ai/resolve.ts`
    // 排序規則的說明），純粹照真實 admin 操作流程勾選。內建 Rewrite 動作
    // modelId 留空（auto）才是它吃得到任何 model 的必要條件。
    await providerCard.getByRole("button", { name: "Add model", exact: true }).click();
    const createModelDialog = page.getByRole("dialog", { name: "Add model" });
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    await expect(providerCard.getByText(MODEL_DISPLAY_NAME)).toBeVisible();

    // ── 回編輯器：Esc 關 modal（不重整，SPA 導回 backgroundLocation＝這篇筆記）──
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/notes/`));
    await editor.waitFor({ timeout: 15_000 });

    // ── 選取文字 → toolbar AI 動作（內建「Rewrite」）───────────────────
    await editor.getByText(original, { exact: true }).click({ clickCount: 3 }); // 三擊選取整段（非 collapsed selection，getSelection() 才吃得到）
    await page.getByRole("button", { name: "AI", exact: true }).click(); // FormattingToolbar 上的 AI 觸發鈕
    await page.locator('[aria-label="AI actions"]').getByRole("button", { name: "Rewrite", exact: true }).click();

    // ── 側欄自動展開。/fast 是 0ms 間隔的 8 個 delta，整輪串流在單一 microtask
    // 迴圈內近乎同步寫完（見 e2e/stubs/ai-stub.mjs streamCompletions）——「streaming」
    // 這個中繼態的可觀察窗口短到不可靠斷言（實測：偶爾在第一次 poll 前就已經翻到
    // done），不釘「Generating…」，只釘頭尾：面板可見 → 最終 done 態的結果文字。
    // reasoning 不洩漏的斷言就在**這支測試自己**的 done 態收斂驗證（下面）：
    // 守門測試（provider 打 /slow）沒有任何 reasoning 相關斷言，別誤讀成兩支
    // 測試分工覆蓋——不洩漏這條全靠這裡的 exact 比對＋`not.toContainText`。
    const aiPanel = page.getByTestId("ai-panel");
    await expect(aiPanel).toBeVisible();

    // ── done：applyMode direct + 有選取（非全文）→ 串流結束自動套用，側欄直接
    // 顯示「Revert」（不是「Apply」）。結果段落斷言 exact，順帶證明沒有任何
    // reasoning 文字混進最終文字。────────────────────────────────────
    await expect(aiPanel.getByText(REWRITTEN_TEXT, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(aiPanel).not.toContainText(REASONING_MARKER);
    await expect(aiPanel.getByRole("button", { name: "Revert", exact: true })).toBeVisible();
    await expect(editor).toContainText(REWRITTEN_TEXT);
    await expect(editor).not.toContainText(original);

    // ── revert：內容還原 ───────────────────────────────────────────
    await aiPanel.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText(REWRITTEN_TEXT);
  } finally {
    await context.close();
  }
});

test("守門：provider 改指向 /slow → 串流中錨點被第二個 context 改動 → 套用中止", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, ADMIN.email, ADMIN.newPassword);
    await expect(ownerPage).toHaveURL(/\/$/);

    // ── admin PATCH：把上一支測試建立的 provider baseUrl 改成 /slow ─────────
    await openAiSettings(ownerPage);
    const providerCard = providerCardLocator(ownerPage, PROVIDER_NAME);
    await expect(providerCard).toBeVisible();
    // provider 層的「Edit」是卡片內第一顆同名鈕（model 列的「Edit」在它下方、DOM 順序更後）。
    await providerCard.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editProviderDialog = ownerPage.getByRole("dialog", { name: "Edit provider" });
    const baseUrlInput = editProviderDialog.getByLabel("Base URL", { exact: true });
    await baseUrlInput.fill("http://ai-stub:9500/slow");
    await editProviderDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editProviderDialog).not.toBeVisible();
    await expect(providerCard).toContainText("http://ai-stub:9500/slow");

    await ownerPage.keyboard.press("Escape");
    await expect(ownerPage).toHaveURL(/\/$/);

    // ── owner 建筆記，第二個 context（同一 admin 帳號另一台裝置）開同一篇 ─────
    const title = `E2E ai guard ${Date.now()}`;
    await createNote(ownerPage, title);
    const noteUrl = ownerPage.url();
    const original = "Guarded paragraph awaiting a concurrent edit mid stream.";
    const ownerEditor = editorLocator(ownerPage);
    await ownerEditor.click();
    await ownerEditor.pressSequentially(original);

    const otherPage = await otherContext.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.newPassword);
    await otherPage.goto(noteUrl);
    const otherEditor = editorLocator(otherPage);
    await expect(otherEditor).toContainText(original, { timeout: 15_000 });

    // ── owner：選取整段 → 觸發 Rewrite（現在打 /slow，~11 秒的串流窗口）──────
    await ownerEditor.getByText(original, { exact: true }).click({ clickCount: 3 });
    await ownerPage.getByRole("button", { name: "AI", exact: true }).click();
    await ownerPage.locator('[aria-label="AI actions"]').getByRole("button", { name: "Rewrite", exact: true }).click();

    const aiPanel = ownerPage.getByTestId("ai-panel");
    await expect(aiPanel.getByText("Generating…", { exact: true })).toBeVisible();

    // ── 串流中：第二個 context 改動同一個錨點 block（append 文字）──────────
    // 透過即時共編同步回 owner 的編輯器，讓 owner 端 `verifyAnchor` 在串流結束時
    // 讀到跟 `captureAnchor` 當下不同的快照 → reason "changed"。
    // 必須點在錨點段落的文字本身，**不能**點編輯器容器空白處——BlockNote 在內容
    // 下方留了一段可點擊空白（點了會把游標放進文件尾端的空白 trailing block），
    // 點容器會讓這次編輯落在另一個新 block，owner 端錨點段落因此「看起來沒變」，
    // 守門永遠不會觸發（fix round 1 實測：容器點法讓 guard 恆假、auto-apply 誤判成功）。
    const editedMarker = "EDITED BY SECOND CONTEXT";
    await otherEditor.getByText(original, { exact: true }).click();
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(` ${editedMarker}`);
    await expect(ownerEditor).toContainText(editedMarker, { timeout: 10_000 }); // 確認已同步回 owner 端（守門要讀到的正是這份快照）

    // ── 串流結束：自動套用因錨點已變而失敗 → 守門中止文案 ──────────────────
    await expect(
      ownerPage.getByText("The original text changed since this result was generated, so it wasn't applied.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // ── 未套用：編輯器仍是第二個 context 改過的內容，AI 改寫結果沒有覆蓋上去；
    // 側欄回到「pendingPreview」態，顯示「Apply」而非已套用的「Revert」。──────
    await expect(ownerEditor).toContainText(editedMarker);
    await expect(ownerEditor).not.toContainText(REWRITTEN_TEXT);
    await expect(aiPanel.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});
