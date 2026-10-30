import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, adminNav, createNote, editorLocator, loginAs, noteIdFromUrl, openSiteAdmin, selectionAiBox, waitForEditorSelection } from "./helpers.js";

/**
 * 並排排版 PR-2（讀寫面，columns-layout spec §13.3 驗收 10／11 的真瀏覽器半、plan 讀碼發現 12／13）：
 * E1 REST 讀出 §11.1 的 div 形、原樣寫回不變、5 欄被拒；E2 #305 REST 改字、圖片寬度與表格欄寬不變；
 * E3 站內 AI（Rewrite，ai-stub `/echo`）改字、寬度不變；E4 從左欄拖選到右欄 → 錨點擴大成整列，套用後列仍在（§7.5）。
 *
 * - 內容一律貼 markdown（純文字剪貼簿 → `collab/paste.ts` 接手；同 34-columns 的 `pasteMarkdown`）。
 * - e2e 不能 import shared：正規字面（`COLUMNS_OPEN_TAG`、`columnOpenTag`）在本檔逐字另寫一份，兩邊要一起改。
 * - REST 走頁面的 session cookie（`page.request`），寫入帶 Origin（同 27-site-links）。
 * - `/echo` 回最後一則 user 訊息、第一個 `Original` 換成 `Rewritten`；內建動作的 user template 是 `{{text}}`，所以回的是選取的 markdown。
 *   E3、E4 都要走「預覽 → Apply」：E3 的錨點含圖片，`hasNonTextBlock` 擋下自動套用；E4 的錨點是並排列，裡面只有文字 block，不擋，
 *   Rewrite 是 direct 時會自動套用、沒有 Apply 鈕。所以 describe 的 beforeAll 以 admin API 把內建 Rewrite 設成 preview（04 的
 *   `setRewriteApplyMode` 同法），afterAll 還原成改之前讀到的值——不依賴 04 的 afterAll 有沒有改回、也不依賴新安裝的預設。
 * - provider 在 describe 的 beforeAll 自建並勾「Default model」（理由同 25-selection-ai-box：全套順序下別的 spec 留下的 provider 指向 `/slow`）。
 *   跑完後站台的預設 model 留在 `/echo` 這顆（同 04／10／25 的慣例：各 spec 自建 provider、勾自己的預設）。
 */

const RUN = Date.now();
const ORIGIN = "http://localhost:3100";
const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';
const IMAGE = '[data-content-type="image"]';
const COLUMNS_OPEN_TAG = '<div data-kb-columns style="display:flex;gap:16px">';
const columnOpenTag = (width: string) => `<div data-kb-column style="flex:${width}">`;
/** 1×1 RGBA PNG。 */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const TABLE_120 = '<table><tr><th colwidth="120">h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>';

type Content = { markdown: string; fingerprint: string };
type Section = { section: { id: string; markdown: string; fingerprint: string } };

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

function expectNoPageErrors(errors: string[]): void {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

async function startNote(page: Page, label: string): Promise<string[]> {
  const errors = collectPageErrors(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E columns-rw ${label} ${RUN}`);
  return errors;
}

function figure(url: string, alt: string): string {
  return `<figure><img alt="${alt}" src="${url}" width="300"></figure>`;
}

/** plan 的 `ROW2`（Task 2 G1-cols-spec）：兩欄寬 1／1.5，右欄 H2「設備規格」＋段落「型號：x」；左欄內容由呼叫端給。 */
function row2(left: string): string {
  return [COLUMNS_OPEN_TAG, columnOpenTag("1"), "", left, "", "</div>", columnOpenTag("1.5"), "", "## 設備規格", "", "型號：x", "", "</div>", "</div>"].join("\n");
}

/** 在筆記最後貼上 markdown（34-columns 的 pasteMarkdown）。 */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

/** 走 API 上傳一張 1×1 PNG 到這篇（同 22-presentation），回傳 `/api/uploads/…`。 */
async function uploadPng(page: Page, noteId: string): Promise<string> {
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "p1x1.png", mimeType: "image/png", buffer: PNG_1X1 } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

async function readContent(page: Page, noteId: string): Promise<Content> {
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Content;
}

async function postEdit(page: Page, noteId: string, data: Record<string, string>) {
  return page.request.post(`/api/notes/${noteId}/edits`, { headers: { Origin: ORIGIN }, data });
}

/** 主編輯器第一張表格第一欄的 `col` 寬（prosemirror-tables 的 TableView 把 colwidth 寫成 `style.width`）。 */
function firstColWidth(page: Page): Promise<string> {
  return editorLocator(page).locator("table colgroup col").first().evaluate((el) => (el as HTMLElement).style.width);
}

/**
 * E2／E3 共用：貼「一段開頭文字 ＋ 圖片寬 300 ＋ 第一欄寬 120 的表格 ＋ 一段文字」，等兩個尺寸都在編輯器裡（讀碼發現 13 的瀏覽器端 parse）。
 * 開頭文字讓 E3 的全選從文字起頭（Chromium 的 Ctrl+A 落成 TextSelection，見 25-selection-ai-box），圖片一定在選取內。
 */
async function pasteSized(page: Page, noteId: string, paragraph: string): Promise<void> {
  const url = await uploadPng(page, noteId);
  await pasteMarkdown(page, ["Lead line", "", figure(url, "p"), "", TABLE_120, "", paragraph, ""].join("\n"));
  const editor = editorLocator(page);
  await expect(editor.getByText(paragraph, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator(IMAGE)).toHaveCount(1);
  await expect(editor.locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect.poll(() => firstColWidth(page)).toBe("120px");
}

/** 圖片與表格所在 block 的 id（寫入或 AI 套用換掉 block 時 id 會變——用來證明它們真的被重寫過，不是原地沒動）。 */
async function sizedBlockIds(page: Page): Promise<Array<string | null>> {
  const editor = editorLocator(page);
  const idOf = (el: Element) => el.closest("[data-id]")?.getAttribute("data-id") ?? null;
  return [await editor.locator(IMAGE).first().evaluate(idOf), await editor.locator("table").first().evaluate(idOf)];
}

/** 圖片與表格都換成新 block（id 都不在 `before` 裡），且寬度 300、第一欄 120px 照舊。 */
async function expectSizesKept(page: Page, before: Array<string | null>): Promise<void> {
  const editor = editorLocator(page);
  await expect.poll(async () => (await sizedBlockIds(page)).map((id) => id !== null && !before.includes(id))).toEqual([true, true]);
  await expect(editor.locator(IMAGE)).toHaveCount(1);
  await expect(editor.locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect(editor.locator("table")).toHaveCount(1);
  await expect.poll(() => firstColWidth(page)).toBe("120px");
}

test("E1（驗收 10）：REST 讀出 §11.1 的 div 形 → 原樣 replace_all 送回 201、列不變、再讀逐字相同 → 5 欄 400 unsupported_columns、筆記沒變", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "E1");
  const noteId = await noteIdFromUrl(page);
  const url = await uploadPng(page, noteId);
  const editor = editorLocator(page);
  await pasteMarkdown(page, [row2(figure(url, "A 點")), "", "after", ""].join("\n"));
  const rows = editor.locator(ROW);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first().locator(COL)).toHaveCount(2);
  await expect(editor.getByText("after", { exact: true })).toBeVisible();

  // 貼上經共編送到 server 有時間差：讀到含「after」與圖片寬度才算 server 看到了
  let original!: Content;
  await expect(async () => {
    original = await readContent(page, noteId);
    expect(original.markdown).toContain("after");
    expect(original.markdown).toContain('width="300"></figure>');
  }).toPass({ timeout: 20_000 });
  const lines = original.markdown.split("\n");
  expect(lines[0]).toBe(COLUMNS_OPEN_TAG);
  expect(lines.filter((l) => l.startsWith("<div data-kb-column "))).toEqual([columnOpenTag("1"), columnOpenTag("1.5")]);
  expect(original.markdown).toContain(figure(url, "A 點"));

  // 原樣寫回：201；replace_all 換掉每個 block 的 id，等列的 data-id 換掉＝頁面收到這次寫入，再看列與兩欄內容
  const rowIdBefore = await rows.first().getAttribute("data-id");
  expect(rowIdBefore).toBeTruthy();
  const same = await postEdit(page, noteId, { op: "replace_all", markdown: original.markdown, if_match: original.fingerprint });
  expect(same.status(), await same.text()).toBe(201);
  await expect.poll(() => rows.first().getAttribute("data-id"), { timeout: 10_000 }).not.toBe(rowIdBefore);
  await expect(rows).toHaveCount(1);
  const cols = editor.locator(`${ROW} > ${COL}`);
  await expect(cols).toHaveCount(2);
  await expect(cols.nth(0).locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect(cols.nth(1)).toContainText("設備規格");
  await expect(cols.nth(1)).toContainText("型號：x");
  await expect(editor.getByText("after", { exact: true })).toBeVisible();
  const reread = await readContent(page, noteId);
  expect(reread.markdown).toBe(original.markdown);

  // 5 欄：400 unsupported_columns，再讀逐字相同
  const fiveCols = [COLUMNS_OPEN_TAG, ...["k1", "k2", "k3", "k4", "k5"].flatMap((t) => [columnOpenTag("1"), "", t, "", "</div>"]), "</div>", ""].join("\n");
  // 指紋比對在剖析之前：讀與送之間若有別的更新進來會回 409——只在 409 時重讀指紋再送，最後一發必須是 400 unsupported_columns
  let status = 0;
  let body = "";
  await expect(async () => {
    const fresh = await readContent(page, noteId);
    const rejected = await postEdit(page, noteId, { op: "replace_all", markdown: fiveCols, if_match: fresh.fingerprint });
    status = rejected.status();
    body = await rejected.text();
    expect(status, body).not.toBe(409);
  }).toPass({ timeout: 15_000 });
  expect(status, body).toBe(400);
  expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe("unsupported_columns");
  const after = await readContent(page, noteId);
  expect(after.markdown).toBe(reread.markdown);
  await expect(rows).toHaveCount(1);
  await expect(editor).not.toContainText("k5");
  expectNoPageErrors(errors);
});

test("E2（讀碼發現 13、#305）：貼 figure 寬 300 與第一欄寬 120 的表格 → REST 讀 _top、old 換 new、replace_section → 文字變、寬度與欄寬不變", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "E2");
  const noteId = await noteIdFromUrl(page);
  await pasteSized(page, noteId, "old words");
  const idsBefore = await sizedBlockIds(page);
  expect(idsBefore.every((id) => id !== null), "image／table 的 block id").toBe(true);

  let top!: Section["section"];
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${noteId}/content?section=_top`);
    expect(res.status(), await res.text()).toBe(200);
    top = ((await res.json()) as Section).section;
    expect(top.markdown).toContain("old words");
    expect(top.markdown).toContain('width="300"></figure>');
    expect(top.markdown).toContain('colwidth="120"');
  }).toPass({ timeout: 20_000 });

  const res = await postEdit(page, noteId, {
    op: "replace_section",
    section_id: "_top",
    markdown: top.markdown.replace("old words", "new words"),
    if_match: top.fingerprint,
  });
  expect(res.status(), await res.text()).toBe(201);
  const editor = editorLocator(page);
  await expect(editor.getByText("new words", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(editor).not.toContainText("old words");
  await expectSizesKept(page, idsBefore);
  expectNoPageErrors(errors);
});

type ApplyMode = "direct" | "preview";
/** beforeAll 改 Rewrite 之前讀到的 applyMode；afterAll 還原成它。 */
let originalRewriteMode: ApplyMode | undefined;

/** 04 的 `setRewriteApplyMode` 同法（那支沒 export）：以 admin API 改內建 Rewrite 的 applyMode；第一次呼叫時記下原值。 */
async function setRewriteApplyMode(page: Page, applyMode: ApplyMode): Promise<void> {
  const listed = await page.request.get("/api/admin/ai/actions");
  expect(listed.status()).toBe(200);
  const { actions } = (await listed.json()) as { actions: { id: string; name: string; builtin: boolean; applyMode: ApplyMode }[] };
  const rewrite = actions.find((action) => action.builtin && action.name === "Rewrite");
  expect(rewrite, "內建 Rewrite 動作").toBeDefined();
  originalRewriteMode ??= rewrite!.applyMode;
  const res = await page.request.patch(`/api/admin/ai/actions/${rewrite!.id}`, { data: { applyMode } });
  expect(res.status()).toBe(200);
}

test.describe("站內 AI（ai-stub /echo）", () => {
  test.afterAll(async ({ browser }) => {
    if (originalRewriteMode === undefined) return; // beforeAll 沒走到改值那步
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await setRewriteApplyMode(page, originalRewriteMode);
    } finally {
      await context.close();
    }
  });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await openSiteAdmin(page);
      await adminNav(page, "AI agents");
      await page.getByRole("button", { name: "Add provider", exact: true }).click();
      const providerDialog = page.getByRole("dialog", { name: "Add provider" });
      const providerName = `E2E Echo Provider ${RUN}`;
      await providerDialog.locator("#ai-provider-name").fill(providerName);
      await providerDialog.locator("#ai-provider-type").selectOption("openai_compatible");
      await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/echo");
      await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(providerDialog).not.toBeVisible();
      await page.getByRole("row", { name: `${providerName} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
      const modelDialog = page.getByRole("dialog", { name: "Add model" });
      await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-echo-model");
      await modelDialog.getByLabel("Display name", { exact: true }).fill(`E2E Echo Model ${RUN}`);
      await modelDialog.getByLabel("Default model", { exact: true }).check();
      await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(modelDialog).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await setRewriteApplyMode(page, "preview"); // E4 的錨點沒有非文字 block，direct 會自動套用（見檔頭）
    } finally {
      await context.close();
    }
  });

  /** 框裡按 Rewrite → 等預覽出現 `expected` → Apply → 框關。 */
  async function rewriteAndApply(box: Locator, expected: string): Promise<void> {
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(box.getByTestId("selection-ai-preview")).toContainText(expected, { timeout: 15_000 });
    const apply = box.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(box).toBeHidden();
  }

  test("E3（驗收 11 站內 AI 半）：圖片寬 300＋第一欄寬 120 的表格＋「Original words」→ 全選 → Rewrite → 套用 → 「Rewritten words」、寬度與欄寬不變", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await startNote(page, "E3");
    const noteId = await noteIdFromUrl(page);
    await pasteSized(page, noteId, "Original words");
    const editor = editorLocator(page);
    const idsBefore = await sizedBlockIds(page);
    expect(idsBefore.every((id) => id !== null), "image／table 的 block id").toBe(true);

    await editor.getByText("Original words", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "AI", exact: true }).click();
    const box = selectionAiBox(page);
    await expect(box).toBeVisible();
    await rewriteAndApply(box, "Rewritten words");

    await expect(editor.getByText("Rewritten words", { exact: true })).toBeVisible();
    await expect(editor).not.toContainText("Original words");
    await expectSizesKept(page, idsBefore);
    expectNoPageErrors(errors);
  });

  test("E4（§7.5）：從左欄文字拖選到右欄文字 → 工具列有 AI 鈕 → Rewrite → 套用 → 仍一列兩欄、左欄「Rewritten left」", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await startNote(page, "E4");
    const editor = editorLocator(page);
    await pasteMarkdown(page, [row2("Original left"), ""].join("\n"));
    const rows = editor.locator(ROW);
    const cols = editor.locator(`${ROW} > ${COL}`);
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0)).toHaveText("Original left");
    const rowIdBefore = await rows.first().getAttribute("data-id");
    expect(rowIdBefore).toBeTruthy();

    // 滑鼠從左欄文字開頭拖到右欄段落結尾（跨欄的 TextSelection）
    const from = (await editor.getByText("Original left", { exact: true }).boundingBox())!;
    const to = (await editor.getByText("型號：x", { exact: true }).boundingBox())!;
    await page.mouse.move(from.x + 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    const aiButton = page.getByRole("button", { name: "AI", exact: true });
    await expect(aiButton).toBeVisible();
    await aiButton.click();
    const box = selectionAiBox(page);
    await expect(box).toBeVisible();
    await rewriteAndApply(box, "Rewritten left");

    // 整列被 AI 結果換掉（錨點擴大成整列）：新列、仍只有一列（沒有巢狀列）、兩欄
    await expect.poll(() => rows.first().getAttribute("data-id")).not.toBe(rowIdBefore);
    await expect(rows).toHaveCount(1);
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0)).toHaveText("Rewritten left");
    await expect(cols.nth(1)).toContainText("設備規格");
    await expect(cols.nth(1)).toContainText("型號：x");
    await expect(editor).not.toContainText("Original left");
    expectNoPageErrors(errors);
  });
});
