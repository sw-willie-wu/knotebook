import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, selectionAiBox, solidPng, waitForEditorSelection } from "./helpers.js";

/**
 * 手機（< 640）編輯工具列：點內文就出現在鍵盤位置上方，取代底部瀏覽列。觸控 context（hasTouch＋isMobile）。
 *
 * 57-1 出現與收起（390、320）：點內文 → 工具列出現、瀏覽列不在；選字時沒有浮動格式工具列；每顆鈕捲進可視區後都在視窗內；
 *      收起鍵盤鈕 → 工具列消失、瀏覽列回來。
 * 57-2 Aa（390）：選字 → Aa → 粗體，筆記內容多了 `**`；返回回主列。
 * 57-3 ¶（390）：¶ → Heading 2 → 內容是 `## `；游標在表格、程式碼區塊時 ¶ 為 aria-disabled，按下去內容不變。
 * 57-4 復原、重做（390）：打字後復原回到原文、重做又回來。
 * 57-5 AI 鈕（390）：站台沒有 AI 動作時沒有 AI 鈕；有時沒選字 aria-disabled、選字後可按並開出 AI 框。
 * 57-6 「＋」（390）：有字的段落按 → 在後面開新空段並開 slash 選單、不插 `/`；空的程式碼區塊按 → 也開選單。
 * 57-7 slash 與 `[[` 選單（390）：沒有 Ctrl／Alt 字樣、每列高 ≥ 44、下緣不壓到工具列（游標在上方、下方與鍵盤升起三種位置）。
 * 57-8 色盤（390）：Aa → A → 色票 → ‹：選取不丟、焦點回編輯器、文字色已套用；色盤開著時工具列仍在、點內文色盤收起；
 *      自訂色碼（觸控）可套用、最近用過可再點。
 * 57-9 連結（390）：游標在連結裡按連結鈕 → 對話框預填目前網址 → 改網址只換 href，連結文字不變、不多一份。
 * 57-10 長文件（390）：點最後一行打字，那一行的下緣在工具列上緣之上。
 * 57-11 圖片（390、320）：點圖片 → 浮動工具列出現、含刪除鈕、在視窗內、不被編輯工具列蓋住。
 * 57-11b 高圖片（390、鍵盤升起）：圖片捲到內文區最上面、上方放不下浮動工具列時，工具列翻到圖片下方，且仍在編輯工具列之上。
 *      （flip 的下緣內縮量沒有守住：改成 0 這案照綠。）
 * 57-13 儲存格 Colors（320）：浮動工具列的顏色選單沒被裁掉，色票點得到。
 * 57-14 圖片 Replace（390）：浮動工具列的 Replace 面板沒被裁掉，面板裡的分頁點得到。
 * 57-12 儲存格（320）：跨儲存格選取時浮動工具列左右都在視窗內（留邊 8），超出的部分在工具列內橫捲。
 *
 * 螢幕鍵盤用假的 `visualViewport` 模擬（見 `emulateKeyboard`）；真實鍵盤動畫、safe area、iOS 的焦點行為、真手指落點量不到，列在實機清單。
 *
 * 帳號與資料：用邀請建一個帳號（alice），每個案例自己以 API 建筆記（內容各不相同，互不影響）。
 */

// Playwright 的動作預設沒有逾時：點不到就一直等到整個案例逾時，看不出卡在哪一步
test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-mobile-toolbar-pw";
const ORIGIN = E2E_ORIGIN;
const TOOLBAR = "[data-mobile-edit-toolbar]";
const BROWSE_BAR = '[data-testid="note-browse-bar"]';

let alice: { email: string; displayName: string };

type Phone = { width: number; height: number };
const P390: Phone = { width: 390, height: 844 };
const P320: Phone = { width: 320, height: 640 };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
  // `[[` 選單要夠高才量得出「下緣不壓到工具列」：先備幾篇可連結的筆記
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    for (let i = 0; i < 10; i++) {
      const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title: `Link target ${i} ${RUN}` } });
      expect(res.status(), await res.text()).toBe(201);
    }
  } finally {
    await context.close();
  }
});

interface NoteRef {
  id: string;
  path: string;
}

async function createNoteVia(page: Page, title: string, content?: string): Promise<NoteRef> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: content === undefined ? { title } : { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

/** 觸控 context 登入 alice。 */
async function phoneContext(browser: Browser, phone: Phone, withKeyboard = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: phone });
  const page = await context.newPage();
  if (withKeyboard) await emulateKeyboard(page);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

/** 開一篇內容為 `markdown` 的新筆記（手機寬度、觸控），等標題框與第一段文字出現。 */
async function openPhoneNote(
  browser: Browser,
  phone: Phone,
  label: string,
  markdown: string,
  waitFor: string,
  withKeyboard = false,
): Promise<{ context: BrowserContext; page: Page; note: NoteRef }> {
  const { context, page } = await phoneContext(browser, phone, withKeyboard);
  const note = await createNoteVia(page, `E2E mobile toolbar ${label} ${RUN}`, markdown);
  await page.goto(note.path);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(editorLocator(page).getByText(waitFor).first()).toBeVisible({ timeout: 15_000 });
  return { context, page, note };
}

const toolbarOf = (page: Page): Locator => page.locator(TOOLBAR);
const toolbarButton = (page: Page, name: string): Locator => toolbarOf(page).getByRole("button", { name, exact: true });
/** 區塊內文（`.bn-inline-content`）中文字剛好是 `text` 的那一段。 */
const blockText = (page: Page, text: string): Locator => editorLocator(page).locator(".bn-inline-content").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();

/**
 * 螢幕鍵盤的替身：Chromium 模擬不出鍵盤，所以把 `window.visualViewport` 換成可調高度的假物件（版面視窗不縮，同 iOS）。
 * 之後 `setKeyboard(page, 300)` 就等於升起 300px 的鍵盤，`setKeyboard(page, 0)` 收起。工具列與選單的定位都讀這個物件。
 */
async function emulateKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = new EventTarget();
    const state = { keyboard: 0 };
    const fake = target;
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - state.keyboard },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
    (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px) => {
      state.keyboard = px;
      target.dispatchEvent(new Event("resize"));
    };
  });
}

async function setKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(value), px);
  // 讓工具列跟上（`useKeyboardInset` 以 requestAnimationFrame 合併讀值）
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function readMarkdown(page: Page, noteId: string): Promise<string> {
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { markdown: string }).markdown;
}

/**
 * 編輯器目前的選取：PM 的 anchor／head 跟 DOM 的 anchor／focus 對齊、而且在同一個區塊裡時，回傳該區塊的文字與選取起訖（區塊內的字元位置）；
 * 否則回傳診斷值（`no-editor`、`focus-outside`、`{ pm, dom }`、`spans-blocks`）。只用在純文字段落（連結是 mark，不是 inline atom，可以）。
 */
async function blockSelection(page: Page): Promise<unknown> {
  return editorLocator(page).evaluate((el) => {
    type Resolved = { parentOffset: number; parent: { textContent: string } };
    type View = {
      state: { selection: { anchor: number; head: number; $from: Resolved; $to: Resolved } };
      posAtDOM(node: Node, offset: number): number;
    };
    const view = (el as Element & { editor?: { view?: View } }).editor?.view;
    if (!view) return "no-editor";
    const sel = window.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode) || !el.contains(document.activeElement)) return "focus-outside";
    const { anchor, head, $from, $to } = view.state.selection;
    let dom: [number, number] | string;
    try {
      dom = [view.posAtDOM(sel.anchorNode, sel.anchorOffset), view.posAtDOM(sel.focusNode, sel.focusOffset)];
    } catch (err) {
      dom = `posAtDOM threw: ${String(err)}`;
    }
    if (typeof dom === "string" || dom[0] !== anchor || dom[1] !== head) return { pm: [anchor, head], dom };
    if ($from.parent !== $to.parent) return "spans-blocks";
    return { text: $from.parent.textContent, from: $from.parentOffset, to: $to.parentOffset };
  });
}

/**
 * 觸控點進 `block`、按 `keys`，直到選取恰為該段的 `from`–`to`（PM 與 DOM 都是）；不是就整組重來。
 * 為什麼不能點完就按鍵、再等 PM 與 DOM 對齊：編輯器原本沒焦點時，點擊觸發 ProseMirror 的得焦計時器（20 ms），它會把 PM 手上的
 * 舊選取寫回 DOM。Home／方向鍵／Shift+End 若在計時器觸發前按下、PM 還沒讀到，游標就被拉回點的位置（對齊照樣成立），
 * 連結對話框沒預填、選字變成沒選。機制與量測見 helpers 的 `clickEndOfParagraph`。重來時編輯器已有焦點，計時器不再排。
 */
async function tapAndSelect(page: Page, block: Locator, keys: string[], from: number, to: number): Promise<void> {
  const text = (await block.textContent()) ?? "";
  await expect(async () => {
    await block.tap({ position: { x: 2, y: 4 } });
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    for (const key of keys) await page.keyboard.press(key);
    await expect
      .poll(() => blockSelection(page), { timeout: 1_000, message: `選取要是「${text}」的 ${from}–${to}（PM 與 DOM 對齊）` })
      .toEqual({ text, from, to });
  }).toPass({ timeout: 20_000 });
}

/** 觸控點內文最左邊（避開連結），把游標放到該段的第 `offset` 個字元前。 */
async function placeCaret(page: Page, block: Locator, offset: number): Promise<void> {
  await tapAndSelect(page, block, ["Home", ...Array.from({ length: offset }, () => "ArrowRight")], offset, offset);
}

/** 選取整段（點進去、Home、Shift+End）。 */
async function selectBlock(page: Page, block: Locator): Promise<void> {
  const length = ((await block.textContent()) ?? "").length;
  await tapAndSelect(page, block, ["Home", "Shift+End"], 0, length);
}

function rectOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number; bottom: number; right: number }> {
  return locator.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  });
}

/** 工具列外框（含膠囊與色盤）的上緣：選單與內文都不該越過它。 */
async function toolbarTop(page: Page): Promise<number> {
  return (await toolbarOf(page).first().evaluate((el) => {
    // 外框 `pointer-events-none` 且高度是內容的總和；膠囊才是看得見的那一塊，色盤開著時另算
    const pill = el.firstElementChild as HTMLElement | null;
    return (pill ?? el).getBoundingClientRect().top;
  })) as number;
}

async function expectNoPageErrors(errors: string[]): Promise<void> {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

for (const phone of [P390, P320]) {
  test(`57-1 ${phone.width} 觸控：點內文工具列出現、瀏覽列不在；選字沒有浮動工具列；每顆鈕在視窗內；收起鍵盤瀏覽列回來`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openPhoneNote(browser, phone, `appear ${phone.width}`, "alpha bravo charlie\n\ndelta echo", "alpha bravo charlie");
    try {
      // 還沒碰內文：瀏覽列在、工具列不在
      await expect(page.locator(`${BROWSE_BAR} [data-phone-fab=\"search\"]`)).toBeVisible();
      await expect(toolbarOf(page)).toHaveCount(0);

      await selectBlock(page, blockText(page, "alpha bravo charlie"));
      await expect(toolbarOf(page)).toBeVisible();
      await expect(page.locator(BROWSE_BAR)).toHaveCount(0);
      // 選字時桌機那條浮動格式工具列不出現（它在選取後的下一個 tick 才會開，所以先等一下再斷言不存在）
      await page.waitForTimeout(600);
      await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);

      // 工具列每顆鈕捲進可視區後，整顆都在視窗內
      const buttons = toolbarOf(page).getByRole("button");
      const count = await buttons.count();
      expect(count, "主列按鈕數").toBeGreaterThanOrEqual(7);
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        const name = (await button.getAttribute("aria-label")) ?? `#${i}`;
        lines.push(`${name} ${box.x.toFixed(0)}-${(box.x + box.width).toFixed(0)}`);
        expect(box.x, `${name} 左緣`).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, `${name} 右緣`).toBeLessThanOrEqual(phone.width + 0.5);
        expect(box.y + box.height, `${name} 下緣`).toBeLessThanOrEqual(phone.height + 0.5);
        expect(box.width, `${name} 寬`).toBeGreaterThanOrEqual(43.5);
      }
      console.log(`MEASURE 57-1 ${phone.width} ${lines.join(" | ")}`);
      // 整條膠囊左右各留邊，沒有撐出視窗
      const pill = await rectOf(toolbarOf(page).locator("> div").first());
      expect(pill.x).toBeGreaterThanOrEqual(0);
      expect(pill.right).toBeLessThanOrEqual(phone.width + 0.5);

      // 收起鍵盤：工具列走、瀏覽列回來
      await toolbarButton(page, "Hide keyboard").tap();
      await expect(page.locator(`${BROWSE_BAR} [data-phone-fab=\"search\"]`)).toBeVisible();
      await expect(toolbarOf(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("57-2 Aa：選字 → Aa → 粗體，內容多 `**`；返回回主列", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, note } = await openPhoneNote(browser, P390, "bold", "alpha bravo charlie", "alpha bravo charlie");
  try {
    await selectBlock(page, blockText(page, "alpha bravo charlie"));
    await toolbarButton(page, "Text formatting").tap();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "format");
    // 格式列裡有粗體、斜體、連結、顏色；主列的鈕（插入、復原…）不在
    for (const name of ["Bold", "Italic", "Create link", "Colors"]) await expect(toolbarButton(page, name)).toBeVisible();
    await expect(toolbarButton(page, "Undo")).toHaveCount(0);
    await toolbarButton(page, "Bold").tap();
    await expect(toolbarButton(page, "Bold")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toContain("**alpha bravo charlie**");
    // 選字期間編輯器沒有失焦，浮動工具列也沒有冒出來（等一下再斷言不存在，同 57-1）
    await page.waitForTimeout(600);
    await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
    await toolbarButton(page, "Back").tap();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "main");
    await expect(toolbarButton(page, "Undo")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-3 ¶：改成 Heading 2；游標在表格、程式碼區塊時 ¶ 停用且按了內容不變", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  {
    const { context, page, note } = await openPhoneNote(browser, P390, "heading", "alpha bravo charlie", "alpha bravo charlie");
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await placeCaret(page, blockText(page, "alpha bravo charlie"), 3);
      await expect(toolbarButton(page, "Change block type")).not.toHaveAttribute("aria-disabled", "true");
      await toolbarButton(page, "Change block type").tap();
      await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "blockType");
      await toolbarButton(page, "Heading 2").tap();
      await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toMatch(/^## alpha bravo charlie/m);
    } finally {
      await context.close();
    }
  }
  const table = "<table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>";
  for (const [label, markdown, waitFor, target] of [
    ["table", `intro\n\n${table}\n\nouter`, "c1", "c1"],
    ["code", "intro\n\n```js\nconst a = 1;\n```\n\nouter", "const a = 1;", "const a = 1;"],
  ] as const) {
    const { context, page, note } = await openPhoneNote(browser, P390, label, markdown, waitFor);
    try {
      const before = await readMarkdown(page, note.id);
      const cell = editorLocator(page).getByText(target, { exact: true }).first();
      await cell.tap();
      await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
      const pilcrow = toolbarButton(page, "Change block type");
      await expect(pilcrow, `${label}：游標在這裡 ¶ 停用`).toHaveAttribute("aria-disabled", "true");
      await pilcrow.tap({ force: true });
      // 停用的鈕按了不換模式、內容不被清掉
      await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "main");
      await page.waitForTimeout(500);
      expect(await readMarkdown(page, note.id), `${label}：內容不變`).toBe(before);
    } finally {
      await context.close();
    }
  }
  await expectNoPageErrors(errors);
});

test("57-4 復原、重做：打字後復原回原文，重做又回來", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openPhoneNote(browser, P390, "undo", "alpha bravo", "alpha bravo");
  try {
    await placeCaret(page, blockText(page, "alpha bravo"), 0);
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" zulu");
    await expect(blockText(page, "alpha bravo zulu")).toBeVisible();
    await toolbarButton(page, "Undo").tap();
    await expect(blockText(page, "alpha bravo")).toBeVisible({ timeout: 10_000 });
    await expect(editorLocator(page).getByText("zulu")).toHaveCount(0);
    // 滑鼠點擊會先送 mousedown：按鈕若不擋掉它，編輯器就失焦（觸控的 tap 在 Chromium 不經過這一步，量不出來）
    await toolbarButton(page, "Redo").click();
    await expect(blockText(page, "alpha bravo zulu")).toBeVisible({ timeout: 10_000 });
    // 按鈕沒有搶走編輯器的焦點
    expect(await editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  } finally {
    await context.close();
  }
});

/** 站台有一組 AI 動作：admin 以 API 建 provider（指向 ai-stub）與預設 model。 */
async function ensureAiAction(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const provider = await page.request.post("/api/admin/ai/providers", {
      headers: { Origin: ORIGIN },
      data: { name: `E2E mobile toolbar provider ${RUN}`, type: "openai_compatible", baseUrl: "http://ai-stub:9500/fast" },
    });
    expect(provider.status(), await provider.text()).toBe(201);
    const { id } = (await provider.json()) as { id: string };
    const model = await page.request.post("/api/admin/ai/models", {
      headers: { Origin: ORIGIN },
      data: { providerId: id, modelId: "e2e-mobile-toolbar-model", displayName: `E2E mobile toolbar model ${RUN}`, isDefault: true },
    });
    expect(model.status(), await model.text()).toBe(201);
  } finally {
    await context.close();
  }
}

test("57-5 AI 鈕：站台沒有 AI 動作時沒有；有時沒選字停用、選字後可按並開出 AI 框", async ({ browser }) => {
  test.setTimeout(150_000);
  // 沒有 AI 動作：攔下動作清單（站台上別的 spec 可能已經建過 provider，不能靠實際狀態）
  {
    const { context, page } = await phoneContext(browser, P390);
    try {
      await page.route("**/api/ai/actions", (route) => route.fulfill({ json: { actions: [] } }));
      const note = await createNoteVia(page, `E2E mobile toolbar no-ai ${RUN}`, "alpha bravo");
      await page.goto(note.path);
      await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
      await placeCaret(page, blockText(page, "alpha bravo"), 0);
      await expect(toolbarButton(page, "Insert block")).toBeVisible();
      await expect(toolbarButton(page, "AI")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
  await ensureAiAction(browser);
  const { context, page } = await openPhoneNote(browser, P390, "ai", "alpha bravo", "alpha bravo");
  try {
    await placeCaret(page, blockText(page, "alpha bravo"), 0);
    const ai = toolbarButton(page, "AI");
    await expect(ai).toBeVisible({ timeout: 10_000 });
    // 游標收合、沒有選取：停用，按了沒有反應
    await expect(ai).toHaveAttribute("aria-disabled", "true");
    await ai.tap({ force: true });
    // 停用的鈕按下去不會有任何狀態變化可等；等一下再斷言 AI 框沒開
    await page.waitForTimeout(600);
    await expect(selectionAiBox(page)).toHaveCount(0);
    // 選字後可按
    await selectBlock(page, blockText(page, "alpha bravo"));
    await expect(ai).not.toHaveAttribute("aria-disabled", "true");
    await ai.tap();
    await expect(selectionAiBox(page)).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.close();
  }
});

const slashMenu = (page: Page): Locator => page.locator(".bn-suggestion-menu");

test("57-6 ＋：有字的段落在後面開新空段並開 slash 選單、不插 `/`；空的程式碼區塊也開選單", async ({ browser }) => {
  test.setTimeout(150_000);
  {
    const { context, page } = await openPhoneNote(browser, P390, "plus", "alpha bravo\n\nomega", "alpha bravo");
    try {
      const blocks = editorLocator(page).locator(".bn-block-outer");
      const before = await blocks.count();
      await placeCaret(page, blockText(page, "alpha bravo"), 5);
      await toolbarButton(page, "Insert block").tap();
      await expect(slashMenu(page)).toBeVisible({ timeout: 10_000 });
      // 新的一段插在「alpha bravo」後面；原本那段沒被動到、沒有 `/`
      await expect(blocks).toHaveCount(before + 1);
      await expect(blockText(page, "alpha bravo")).toBeVisible();
      expect(await editorLocator(page).innerText()).not.toContain("/");
      const order = await blocks.evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
      expect(order.slice(0, 3), "區塊順序").toEqual(["alpha bravo", "", "omega"]);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPhoneNote(browser, P390, "plus-code", "intro\n\n```js\n```\n\nouter", "intro");
  try {
    const code = editorLocator(page).locator('[data-content-type="codeBlock"]').first();
    await expect(code).toBeVisible();
    await code.tap();
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    await toolbarButton(page, "Insert block").tap();
    await expect(slashMenu(page)).toBeVisible({ timeout: 10_000 });
    // 程式碼區塊裡沒有多一個字面 `/`
    expect(await code.innerText()).not.toContain("/");
  } finally {
    await context.close();
  }
});

/** 選單裡每一列的高度與整個選單的下緣，對照工具列上緣。 */
async function expectMenuAboveToolbar(page: Page, label: string, minRowHeight: number | null): Promise<{ rows: number; minRow: number; bottom: number; top: number }> {
  const menu = slashMenu(page);
  await expect(menu).toBeVisible({ timeout: 10_000 });
  // 位置在選單出現後還會量一次（floating-ui 先放再算），等穩定
  let last = -1;
  await expect
    .poll(async () => {
      const bottom = (await rectOf(menu)).bottom;
      const stable = Math.abs(bottom - last) < 0.5;
      last = bottom;
      return stable;
    })
    .toBe(true);
  const items = menu.locator(".bn-suggestion-menu-item");
  const rows = await items.count();
  expect(rows, `${label} 選單項數`).toBeGreaterThanOrEqual(3);
  const heights = await items.evaluateAll((els) => els.map((el) => `${(el.textContent ?? "").trim().slice(0, 20)}=${el.getBoundingClientRect().height.toFixed(1)}`));
  console.log(`MEASURE rows ${label} ${heights.join(" | ")}`);
  console.log(`MEASURE cls ${label} ${await items.first().evaluate((el) => `${el.className} min=${getComputedStyle(el).minHeight} h=${getComputedStyle(el).height}`)}`);
  const minRow = Math.min(...heights.map((h) => Number(h.split("=").pop())));
  const text = await menu.innerText();
  expect(text, `${label} 沒有快捷鍵字樣`).not.toMatch(/ctrl|alt/i);
  if (minRowHeight !== null) expect(minRow, `${label} 最矮的一列`).toBeGreaterThanOrEqual(minRowHeight);
  const menuRect = await rectOf(menu);
  const viewportHeight = page.viewportSize()!.height;
  expect(menuRect.height, `${label} 選單高度 ${menuRect.height.toFixed(1)} ≤ 視窗高的一半`).toBeLessThanOrEqual(viewportHeight / 2 + 1);
  const bottom = menuRect.bottom;
  const top = await toolbarTop(page);
  expect(bottom, `${label} 選單下緣 ${bottom.toFixed(1)} ≤ 工具列上緣 ${top.toFixed(1)}`).toBeLessThanOrEqual(top + 0.5);
  return { rows, minRow, bottom, top };
}

test("57-7 slash 與 [[ 選單：沒有快捷鍵字樣、列高 ≥ 44、下緣不壓到工具列", async ({ browser }) => {
  test.setTimeout(180_000);
  const lines: string[] = [];
  const filler = Array.from({ length: 30 }, (_, i) => `filler line ${i}`).join("\n\n");
  for (const [label, markdown, anchor] of [
    // 游標在文件最上面：選單開在下方，高度要被工具列限制住
    ["top", `alpha bravo\n\n${filler}`, "alpha bravo"],
    // 游標在文件下半：空間不夠，選單開在游標上方
    ["bottom", `${filler}\n\nlast words`, "last words"],
    // 螢幕鍵盤升起 300px：可視區只剩上半，選單的可用高度與翻上翻下都以鍵盤上緣的工具列為底
    ["keyboard", `${filler}\n\nlast words`, "last words"],
  ] as const) {
    const { context, page } = await openPhoneNote(browser, P390, `menus-${label}`, markdown, anchor, label === "keyboard");
    try {
      const target = blockText(page, anchor);
      await target.scrollIntoViewIfNeeded();
      await placeCaret(page, target, anchor.length);
      if (label === "keyboard") await setKeyboard(page, 300);
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      const slash = await expectMenuAboveToolbar(page, `/ ${label}`, 44);
      lines.push(`/ ${label} rows ${slash.rows} minRow ${slash.minRow.toFixed(1)} bottom ${slash.bottom.toFixed(1)} toolbarTop ${slash.top.toFixed(1)}`);
      await page.keyboard.press("Escape");
      await expect(slashMenu(page)).toHaveCount(0);
      await page.keyboard.press("Backspace");

      await page.keyboard.type("[[");
      const link = await expectMenuAboveToolbar(page, `[[ ${label}`, 44);
      lines.push(`[[ ${label} rows ${link.rows} minRow ${link.minRow.toFixed(1)} bottom ${link.bottom.toFixed(1)} toolbarTop ${link.top.toFixed(1)}`);
    } finally {
      await context.close();
    }
  }
  console.log(`MEASURE 57-7 ${lines.join(" | ")}`);
});

const hexInput = (page: Page): Locator => page.getByRole("textbox", { name: "Hex color" });
const colorPanel = (page: Page): Locator => page.locator("[data-mobile-color-panel]");

test("57-8 色盤：Aa → A → 色票 → ‹，選取不丟、焦點回編輯器、文字色已套用；色盤開著工具列仍在，點內文色盤收起", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openPhoneNote(browser, P390, "colors", "alpha bravo charlie\n\nsecond words here", "alpha bravo charlie");
  try {
    await selectBlock(page, blockText(page, "alpha bravo charlie"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await expect(colorPanel(page)).toBeVisible();
    await expect(toolbarOf(page)).toBeVisible();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "color");
    await expect(toolbarButton(page, "Colors")).toHaveAttribute("aria-pressed", "true");
    // 色盤與工具列都在視窗內，色盤沒有蓋到上方的文字行（選取的那一行仍看得到）
    const panelRect = await rectOf(colorPanel(page));
    expect(panelRect.bottom).toBeLessThanOrEqual(P390.height + 0.5);
    const selectedLine = await rectOf(blockText(page, "alpha bravo charlie"));
    expect(selectedLine.bottom, "選取的那一行在色盤之上").toBeLessThanOrEqual(panelRect.y + 0.5);

    // 文字色那列選 Red
    const textRow = colorPanel(page).getByRole("group", { name: "Text", exact: true });
    await textRow.getByRole("button", { name: "Red", exact: true }).tap();
    await expect(editorLocator(page).locator('[data-style-type="textColor"][data-value="red"]')).toHaveText("alpha bravo charlie", { timeout: 10_000 });
    // 色盤還開著、選取沒丟（外框畫在編輯器上）
    await expect(colorPanel(page)).toBeVisible();
    await expect(page.locator("[data-mobile-color-open]")).toHaveCount(1);

    // ‹：回格式列，焦點回編輯器，選取仍是那一整段
    await toolbarButton(page, "Back").tap();
    await expect(colorPanel(page)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "format");
    await expect.poll(() => editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("alpha bravo charlie");
    await expect(page.locator("[data-mobile-color-open]")).toHaveCount(0);

    // 色盤開著時點內文：色盤收起、工具列還在
    await toolbarButton(page, "Colors").tap();
    await expect(colorPanel(page)).toBeVisible();
    await blockText(page, "second words here").tap({ position: { x: 2, y: 4 } });
    await expect(colorPanel(page)).toHaveCount(0);
    await expect(toolbarOf(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-8b 色盤（觸控）：自訂色碼可套用，最近用過可再點；開自訂頁時色碼框不自動取得焦點", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openPhoneNote(browser, P390, "colors-custom", "first words here\n\nsecond words here", "first words here");
  const custom = "#ff6600";
  try {
    await selectBlock(page, blockText(page, "first words here"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await colorPanel(page).getByRole("group", { name: "Text", exact: true }).getByRole("button", { name: "Custom…", exact: true }).tap();
    await expect(hexInput(page)).toBeVisible();
    // 觸控不叫出螢幕鍵盤：色碼框沒有焦點，焦點仍在色盤裡
    await expect(hexInput(page)).not.toBeFocused();
    expect(await colorPanel(page).evaluate((el) => el.contains(document.activeElement)), "焦點留在色盤").toBe(true);
    await hexInput(page).tap();
    await hexInput(page).fill(custom);
    await page.getByRole("button", { name: "Apply", exact: true }).tap();
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`)).toHaveText("first words here", { timeout: 10_000 });
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`)).toHaveCSS("color", "rgb(255, 102, 0)");

    // 另一段選取，開自訂頁，從最近用過點同一個色碼
    await toolbarButton(page, "Back").tap();
    await toolbarButton(page, "Back").tap();
    await selectBlock(page, blockText(page, "second words here"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await colorPanel(page).getByRole("group", { name: "Text", exact: true }).getByRole("button", { name: "Custom…", exact: true }).tap();
    await expect(colorPanel(page).getByText("Recent", { exact: true })).toBeVisible();
    await colorPanel(page).getByRole("button", { name: custom, exact: true }).tap();
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`).filter({ hasText: "second words here" })).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("57-9 連結：游標在連結裡按連結鈕，對話框預填網址；改網址只換 href，文字不變也不多一份", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page, note } = await openPhoneNote(browser, P390, "link", "see [docs](https://example.com/old) end", "see docs end");
  try {
    // 游標放在「docs」中間（「see 」4 字元＋2）
    await placeCaret(page, blockText(page, "see docs end"), 6);
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Create link").tap();
    const dialog = page.getByRole("dialog", { name: "Insert link" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel("URL", { exact: true })).toHaveValue("https://example.com/old");
    await expect(dialog.getByLabel("Display text", { exact: true })).toHaveValue("docs");
    await dialog.getByLabel("URL", { exact: true }).fill("https://example.com/new");
    await dialog.getByRole("button", { name: "Insert", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toContain("see [docs](https://example.com/new) end");
    expect(await readMarkdown(page, note.id)).not.toContain("example.com/old");
    await expect(blockText(page, "see docs end")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-10 長文件：點最後一行打字，那一行的下緣在工具列上緣之上", async ({ browser }) => {
  test.setTimeout(150_000);
  const lines = Array.from({ length: 50 }, (_, i) => `line number ${i}`);
  const { context, page } = await openPhoneNote(browser, P390, "long", lines.join("\n\n"), "line number 0", true);
  try {
    const last = blockText(page, "line number 49");
    await last.scrollIntoViewIfNeeded();
    await last.tap({ position: { x: 2, y: 4 } });
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    // 鍵盤升起（300px）：工具列浮到鍵盤上方，游標那一行要被推到工具列之上
    await setKeyboard(page, 300);
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" typed at the very end");
    const typed = blockText(page, "line number 49 typed at the very end");
    await expect(typed).toBeVisible();
    // 捲動是 ProseMirror 在打字後做的，等位置穩定再量
    let previous = -1;
    await expect
      .poll(async () => {
        const bottom = (await rectOf(typed)).bottom;
        const stable = Math.abs(bottom - previous) < 0.5;
        previous = bottom;
        return stable;
      })
      .toBe(true);
    const bottom = (await rectOf(typed)).bottom;
    const top = await toolbarTop(page);
    console.log(`MEASURE 57-10 line bottom ${bottom.toFixed(1)} toolbarTop ${top.toFixed(1)}`);
    expect(top, "工具列浮在鍵盤上方").toBeLessThan(P390.height - 300);
    expect(bottom, "最後一行的下緣").toBeLessThanOrEqual(top + 0.5);
  } finally {
    await context.close();
  }
});

/** 建一篇有圖片與表格的筆記（圖片先上傳，再整篇寫入）。 */
async function createNoteWithImageAndTable(page: Page, label: string, image = { width: 200, height: 120 }): Promise<NoteRef> {
  const note = await createNoteVia(page, `E2E mobile toolbar ${label} ${RUN}`);
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "box.png", mimeType: "image/png", buffer: solidPng(image.width, image.height) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { url } = (await upload.json()) as { url: string };
  const current = await page.request.get(`/api/notes/${note.id}/content`);
  const { fingerprint } = (await current.json()) as { fingerprint: string };
  const markdown = [
    "lead words",
    "",
    `<figure><img alt="box" src="${url}" width="${image.width}"></figure>`,
    "",
    "<table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>",
    "",
    "tail words",
    "",
    // 後面接一段長文，內文區才捲得動（測圖片捲到最上面的位置）
    ...Array.from({ length: 30 }, (_, i) => `filler line ${i}\n`),
  ].join("\n");
  const written = await page.request.post(`/api/notes/${note.id}/edits`, { headers: { Origin: ORIGIN }, data: { op: "replace_all", markdown, if_match: fingerprint } });
  expect(written.status(), await written.text()).toBeLessThan(300);
  return note;
}

for (const phone of [P390, P320]) {
  test(`57-11 ${phone.width} 圖片：點圖片出現浮動工具列，含刪除鈕、在視窗內、不被編輯工具列蓋住`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page } = await phoneContext(browser, phone);
    try {
      const note = await createNoteWithImageAndTable(page, `image ${phone.width}`);
      await page.goto(note.path);
      await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
      const image = editorLocator(page).locator('[data-content-type="image"]').first();
      await expect(image).toBeVisible({ timeout: 15_000 });
      await image.scrollIntoViewIfNeeded();
      await image.locator("img").tap();
      const floating = page.locator(".bn-formatting-toolbar");
      await expect(floating).toBeVisible({ timeout: 10_000 });
      await expect(floating.getByRole("button", { name: /delete/i })).toBeVisible();
      // 浮動工具列定位後再量
      let previous = -1;
      await expect
        .poll(async () => {
          const x = (await rectOf(floating)).x;
          const stable = Math.abs(x - previous) < 0.5;
          previous = x;
          return stable;
        })
        .toBe(true);
      const rect = await rectOf(floating);
      console.log(`MEASURE 57-11 ${phone.width} floating x ${rect.x.toFixed(1)} right ${rect.right.toFixed(1)} y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)}`);
      expect(rect.x, "浮動工具列左緣").toBeGreaterThanOrEqual(-0.5);
      expect(rect.right, "浮動工具列右緣").toBeLessThanOrEqual(phone.width + 0.5);
      expect(rect.y, "浮動工具列上緣").toBeGreaterThanOrEqual(-0.5);
      // 點圖片時編輯工具列也在：兩條不重疊（浮動的在它上方）
      await expect(toolbarOf(page)).toBeVisible();
      expect(rect.bottom, "浮動工具列下緣在編輯工具列上緣之上").toBeLessThanOrEqual((await toolbarTop(page)) + 0.5);
      expect(rect.bottom, "浮動工具列下緣").toBeLessThanOrEqual(phone.height);
    } finally {
      await context.close();
    }
  });
}

test("57-11b 390 高圖片、鍵盤升起：上方放不下時浮動工具列翻到圖片下方，且仍在編輯工具列之上", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P390, true);
  try {
    // 寬 200、高 300 的圖：捲到最上面時，它上方放不下浮動工具列
    const note = await createNoteWithImageAndTable(page, "tall image", { width: 200, height: 300 });
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const image = editorLocator(page).locator('[data-content-type="image"]').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await setKeyboard(page, 300);
    // 把圖片頂端捲到內文區最上面：上方沒有空間放工具列，只能翻到下方
    await image.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await image.locator("img").tap();
    const floating = page.locator(".bn-formatting-toolbar");
    await expect(floating).toBeVisible({ timeout: 10_000 });
    await expect(toolbarOf(page)).toBeVisible();
    let previous = -1;
    await expect
      .poll(async () => {
        const y = (await rectOf(floating)).y;
        const stable = Math.abs(y - previous) < 0.5;
        previous = y;
        return stable;
      })
      .toBe(true);
    const rect = await rectOf(floating);
    const imageRect = await rectOf(image);
    const top = await toolbarTop(page);
    console.log(`MEASURE 57-11b floating y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)} image y ${imageRect.y.toFixed(1)} bottom ${imageRect.bottom.toFixed(1)} toolbarTop ${top.toFixed(1)}`);
    expect(rect.y, "浮動工具列翻到圖片下方").toBeGreaterThanOrEqual(imageRect.bottom - 0.5);
    expect(rect.bottom, "浮動工具列下緣在編輯工具列上緣之上").toBeLessThanOrEqual(top + 0.5);
  } finally {
    await context.close();
  }
});

/** 拖過表格第一列的兩格，選成儲存格選取，回傳出現的浮動工具列。 */
async function selectTwoCells(page: Page): Promise<Locator> {
  const cell1 = editorLocator(page).getByText("c1", { exact: true }).first();
  const cell2 = editorLocator(page).getByText("c2", { exact: true }).first();
  await expect(cell1).toBeVisible({ timeout: 15_000 });
  await cell1.scrollIntoViewIfNeeded();
  const a = (await cell1.boundingBox())!;
  const b = (await cell2.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  const floating = page.locator(".bn-formatting-toolbar");
  await expect(floating).toBeVisible({ timeout: 10_000 });
  await expect(editorLocator(page).locator(".selectedCell")).not.toHaveCount(0);
  return floating;
}

/** 元素中心點在視窗內，而且那一點命中的就是它（沒被別的元素蓋住、也沒被裁掉）。 */
async function expectReachable(target: Locator, viewport: Phone, label: string): Promise<void> {
  await expect(target, `${label} 可見`).toBeVisible({ timeout: 10_000 });
  const hit = await target.first().evaluate((el, size) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, inside: x >= 0 && x <= size.width && y >= 0 && y <= size.height, hit: top !== null && (el === top || el.contains(top)) };
  }, viewport);
  expect(hit.inside, `${label} 中心 (${hit.x.toFixed(0)}, ${hit.y.toFixed(0)}) 在視窗內`).toBe(true);
  expect(hit.hit, `${label} 中心點命中它自己`).toBe(true);
}

test("57-12 320 儲存格：跨儲存格選取時浮動工具列右緣在視窗內", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P320);
  try {
    const note = await createNoteWithImageAndTable(page, "cells 320");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const floating = await selectTwoCells(page);
    let previous = -1;
    await expect
      .poll(async () => {
        const x = (await rectOf(floating)).x;
        const stable = Math.abs(x - previous) < 0.5;
        previous = x;
        return stable;
      })
      .toBe(true);
    const rect = await rectOf(floating);
    console.log(`MEASURE 57-12 320 floating x ${rect.x.toFixed(1)} right ${rect.right.toFixed(1)} y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)}`);
    expect(rect.x, "浮動工具列左緣").toBeGreaterThanOrEqual(8 - 0.5);
    expect(rect.right, "浮動工具列右緣").toBeLessThanOrEqual(320 - 8 + 0.5);
  } finally {
    await context.close();
  }
});

test("57-13 320 儲存格：浮動工具列的 Colors 選單沒被裁掉，色票點得到並套用後選單收起", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P320);
  try {
    const note = await createNoteWithImageAndTable(page, "cells colors");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const floating = await selectTwoCells(page);
    const colors = floating.locator('[data-test="colors"]');
    await colors.scrollIntoViewIfNeeded();
    await colors.tap();
    const swatch = page.locator('[data-test="text-color-red"]');
    await expectReachable(swatch, P320, "紅色色票");
    await swatch.tap();
    await expect(swatch).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("57-14 390 圖片：浮動工具列的 Replace 面板沒被裁掉，面板裡的分頁點得到", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P390);
  try {
    const note = await createNoteWithImageAndTable(page, "image replace");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const image = editorLocator(page).locator('[data-content-type="image"]').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await image.locator("img").tap();
    const floating = page.locator(".bn-formatting-toolbar");
    await expect(floating).toBeVisible({ timeout: 10_000 });
    const replace = floating.getByRole("button", { name: /replace/i });
    await replace.scrollIntoViewIfNeeded();
    await replace.tap();
    const panel = page.locator(".bn-panel").first();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const tabs = panel.getByRole("tab");
    console.log(`MEASURE 57-14 panel ${JSON.stringify(await rectOf(panel))} tabs ${await tabs.count()}`);
    expect(await tabs.count(), "面板分頁數").toBeGreaterThanOrEqual(1);
    await expectReachable(tabs.first(), P390, "面板第一個分頁");
  } finally {
    await context.close();
  }
});
