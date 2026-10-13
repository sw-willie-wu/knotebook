import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, adminNav, createNote, editorLocator, loginAs, openSelectionAiBox, openSiteAdmin, waitForEditorSelection } from "./helpers.js";

/**
 * #263 框選 AI 框的幾何守衛（spec 2026-10-12 §7 e2e「幾何」）。provider 自建（流程照 10-responsive）——「Default model」的勾選承重：
 * 全套順序下 04 留下的 provider 已被改指 `/slow`，不勾的話 auto 解析會選到它。
 * 量法（memory knotebook-blocknote-floating-containing-block）：全頁滾軸量 `documentElement.scrollHeight <= clientHeight`；捲動後不固定等待，
 * 以 expect.poll 等框的位置跟上（floating-ui 的 ancestorScroll 回呼下一幀才派送）。捲動容器＝note-editor 的祖父（同 14-table-hover 的節點鏈）。
 * 位置分兩種（#263 後續 2026-10-13）：輸入／串流／錯誤態浮在首區塊上方（可 flip 到下方）；結果態（done）蓋在首區塊上——框頂＝首區塊
 * `.bn-block-outer` 頂、左緣對齊、不 flip，區塊頂捲出容器頂時夾在容器頂。
 */

const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E Box Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E Box Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // ai-stub 固定輸出

test.describe.configure({ mode: "serial" });

const para = (n: number) => `Paragraph number ${n} of the selection box geometry note.`;

async function writeParagraphs(page: Page, paragraphs: string[]): Promise<void> {
  const editor = editorLocator(page);
  await editor.waitFor({ timeout: 15_000 });
  await editor.click();
  for (let i = 0; i < paragraphs.length; i += 1) {
    await editor.pressSequentially(paragraphs[i]!);
    if (i < paragraphs.length - 1) {
      await waitForEditorSelection(page);
      await page.keyboard.press("Enter");
    }
  }
}

async function scrollContainerTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.parentElement?.parentElement;
    return scroller ? scroller.getBoundingClientRect().top : Number.NaN;
  });
}

async function scrollContainerBy(page: Page, dy: number): Promise<void> {
  await page.evaluate((delta) => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.parentElement?.parentElement as HTMLElement | null | undefined;
    if (scroller) scroller.scrollTop += delta;
  }, dy);
}

async function scrollContainerRect(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.parentElement?.parentElement;
    const r = scroller?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom } : { top: Number.NaN, bottom: Number.NaN };
  });
}

/** 主編輯器裡含該段文字的 `.bn-block-outer`（本檔的筆記全是平的段落，不會有巢狀外層一起中）。 */
function mainBlock(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-block-outer").filter({ hasText: text });
}

/** 框與區塊的視窗座標差：框頂－區塊頂、框左－區塊左。 */
async function boxVsBlock(box: Locator, block: Locator): Promise<{ dy: number; dx: number }> {
  const [b, r] = [(await box.boundingBox())!, (await block.boundingBox())!];
  return { dy: b.y - r.y, dx: b.x - r.x };
}

/** 在框裡送一條指令，等預覽出現 stub 的固定輸出（結果態）。 */
async function runInstruction(box: Locator): Promise<void> {
  const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
  await input.fill("Shorten it");
  await input.press("Enter");
  await expect(box.getByTestId("selection-ai-preview")).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
}

async function scrollContainerScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.parentElement?.parentElement;
    return scroller ? scroller.scrollTop : Number.NaN;
  });
}

async function noPageScrollbar(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight);
}

/** 框的內容整個放得下（框內不捲動）。框的 `size()` 會把最大高度壓到可用高度，所以「放不下」不會表現成 top 越界，而是框被壓扁。 */
async function boxContentFits(box: Locator): Promise<boolean> {
  return box.evaluate((el) => el.scrollHeight <= el.clientHeight);
}

test("建 provider（/fast，勾 Default model）", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await openSiteAdmin(page);
    await adminNav(page, "AI agents");
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const providerDialog = page.getByRole("dialog", { name: "Add provider" });
    await providerDialog.locator("#ai-provider-name").fill(PROVIDER_NAME);
    await providerDialog.locator("#ai-provider-type").selectOption("openai_compatible");
    await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/fast");
    await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(providerDialog).not.toBeVisible();
    const card = page.getByRole("region", { name: PROVIDER_NAME });
    await card.getByRole("button", { name: "Add model", exact: true }).click();
    const modelDialog = page.getByRole("dialog", { name: "Add model" });
    await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-box-model");
    await modelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await modelDialog.getByLabel("Default model", { exact: true }).check();
    await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(modelDialog).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await context.close();
  }
});

test("開框不長全頁滾軸；點內文（空選取）框仍在；在別段拖選後框消失", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box geometry ${RUN_ID}`);
    const paragraphs = Array.from({ length: 9 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);

    const box = await openSelectionAiBox(page, paragraphs[4]!);
    expect(await noPageScrollbar(page)).toBe(true);

    // 空選取：單擊第 7 段（只放游標）→ 框不關（D6）
    await editorLocator(page).getByText(paragraphs[7]!, { exact: true }).click();
    await waitForEditorSelection(page); // 等 PM 的選取真的落到第 7 段（D12 的判定已跑過）再斷言
    // 只斷言 toBeVisible 判不出「框被關了」：關閉時 BlockNote 的 GenericPopover 跑淡出轉場，轉場期間改顯示框最後一次的 innerHTML 複本（輸入框也在），
    // DOM 晚一點才卸（e2e 探針實量：關框後 50ms 框仍在 DOM、500ms 時已卸；只斷言可見時，「空選取也關框」的突變照綠）。
    // 所以等兩個畫格讓 React 提交選取變更排下的更新，再看外層 popover 的 inline opacity：關閉轉場把它設成 "0"（floating-ui useTransitionStyles 的預設，GenericPopover 沒改）。
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(box).toBeVisible();
    expect(await box.evaluate((el) => (el.parentElement as HTMLElement).style.opacity)).not.toBe("0");

    // 拖選第 8 段（滑鼠非空選取）→ 框關（D12；store 在 pointerdown 期間恆為 false，這條是 onSelectionChange 判定的守衛）
    const target = editorLocator(page).getByText(paragraphs[8]!, { exact: true });
    const r = (await target.boundingBox())!;
    await page.mouse.move(r.x + 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width - 2, r.y + r.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(box).toBeHidden();
  } finally {
    await context.close();
  }
});

test("捲動內文後框的 top 跟著變（釘在框選區塊旁）", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    const box = await openSelectionAiBox(page, paragraphs[8]!);
    const before = (await box.boundingBox())!.y;
    await scrollContainerBy(page, 120);
    await expect.poll(async () => Math.abs(before - (await box.boundingBox())!.y - 120)).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("Ctrl+A 後開框、只框選首區塊時開框：框的 top ≥ 捲動容器的 top 且內容放得下；全選時內建工具列被壓住", async ({ browser }) => {
  // 首區塊上方只剩 24px（捲動容器 top 70、首區塊 top 94；1280×720 實量），框（輸入態約 50px）得 flip 到區塊下方。拿掉 flip() 時框不會越過
  // 容器頂（size() 把最大高度壓成可用的 14px、top 剛好貼齊 70，e2e 突變實量），所以除了 top 還要斷言框沒被壓扁（boxContentFits）。
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box select-all ${RUN_ID}`);
    const paragraphs = Array.from({ length: 6 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    const containerTop = await scrollContainerTop(page);

    await editorLocator(page).getByText(paragraphs[2]!, { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "AI", exact: true }).click();
    const box = page.getByTestId("selection-ai-box");
    await expect(box).toBeVisible();
    expect((await box.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
    expect(await boxContentFits(box)).toBe(true);
    // 全選也算在框選目標內 → 內建工具列被壓住、不和框疊在一起（toHaveCount 會等工具列的收合轉場跑完）。註：Chromium 裡實按 Ctrl+A 後
    // PM 的選取實量是 TextSelection（anchor 3、head 347，doc size 350），不是 AllSelection（from 0）——selectionInsideAnchor 對 from 的
    // 夾回在這條路徑上不承重（e2e 突變拿掉它此案照綠），AllSelection 那半由 Task 6／8 的單元測試守；本行守的是壓制公式本身。
    await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
    await expect(box).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();

    const firstOnly = await openSelectionAiBox(page, paragraphs[0]!);
    expect((await firstOnly.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
    expect(await boxContentFits(firstOnly)).toBe(true);
    // 結果態改蓋在首區塊上：框頂＝首區塊頂（仍在容器頂之下）
    await runInstruction(firstOnly);
    await expect.poll(async () => Math.abs((await boxVsBlock(firstOnly, mainBlock(page, paragraphs[0]!))).dy)).toBeLessThanOrEqual(1);
    expect((await firstOnly.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
  } finally {
    await context.close();
  }
});

test("換行一致（D7）：同一段長文在預覽框內與正文中的渲染高度差 ≤ 1px", async ({ browser }) => {
  // 視窗加高到 1000：框高上限 min(40vh, 可用高度)＝400px，預覽（原文一塊 126px＋一行新增＋按鈕列，整框實量 205px）放得下、不出捲軸。出捲軸時捲軸寬
  // 會吃掉文字欄、換行就跟正文不同（spec §10 #11，列 known-limitations）——那不是本案要驗的，所以下面先斷言框內不捲動（前置條件）。
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box wrap ${RUN_ID}`);
    const long = Array.from({ length: 6 }, (_, i) => `Sentence ${i} keeps this paragraph long enough to wrap over several lines.`).join(" ");
    await writeParagraphs(page, [long]);

    const box = await openSelectionAiBox(page, long);
    await runInstruction(box);
    const preview = box.getByTestId("selection-ai-preview");
    expect(await boxContentFits(box)).toBe(true); // 前置條件：框內沒有捲動

    // 原文與 stub 輸出不配對（相似度低）→ 預覽裡原文是一整塊 deleted，內容逐字等於正文
    const previewBlock = preview.locator('[data-diff="deleted"] .bn-block-content').first();
    await expect(previewBlock).toContainText(long.slice(0, 40));
    const mainBlock = editorLocator(page).locator(".bn-block-content").filter({ hasText: long.slice(0, 40) }).first();
    const [mainHeight, previewHeight] = await Promise.all([
      mainBlock.evaluate((el) => el.getBoundingClientRect().height),
      previewBlock.evaluate((el) => el.getBoundingClientRect().height),
    ]);
    expect(mainHeight).toBeGreaterThan(40); // 真的換了行（守衛不是單行的空轉）
    expect(Math.abs(mainHeight - previewHeight)).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test("結果態蓋在被改區塊上：框頂＝首區塊頂 ±1px、左緣對齊、往下蓋住後面的段落；區塊貼近容器底也不 flip，框高壓到框頂以下的可用高度", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box overlay ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    // ── 中段：輸入態在區塊上方，結果態蓋上去 ──
    const box = await openSelectionAiBox(page, paragraphs[4]!);
    const block = mainBlock(page, paragraphs[4]!);
    expect((await boxVsBlock(box, block)).dy).toBeLessThan(-10); // 前置：輸入態浮在區塊上方（位置不變）
    await runInstruction(box);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);
    expect(Math.abs((await boxVsBlock(box, block)).dx)).toBeLessThanOrEqual(1);
    // 往下延伸、蓋住下一段：框底在下一段的頂之下
    const boxRect = (await box.boundingBox())!;
    const nextRect = (await mainBlock(page, paragraphs[5]!).boundingBox())!;
    expect(boxRect.y + boxRect.height).toBeGreaterThan(nextRect.y + 1);
    await box.press("Escape");
    await expect(box).toBeHidden();

    // ── 貼近容器底：區塊頂距容器底只剩 60px，放不下整個結果——不 flip 到區塊上方，框頂仍＝區塊頂、框內捲動 ──
    const target = mainBlock(page, paragraphs[20]!);
    const container = await scrollContainerRect(page);
    await scrollContainerBy(page, (await target.boundingBox())!.y - (container.bottom - 60));
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - (container.bottom - 60))).toBeLessThanOrEqual(1);
    const low = await openSelectionAiBox(page, paragraphs[20]!);
    await runInstruction(low);
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - (container.bottom - 60))).toBeLessThanOrEqual(1); // 開框／送出／完成都沒捲動
    await expect.poll(async () => Math.abs((await boxVsBlock(low, target)).dy)).toBeLessThanOrEqual(1);
    const lowRect = (await low.boundingBox())!;
    expect(lowRect.y + lowRect.height).toBeLessThanOrEqual(container.bottom + 1);
    expect(await boxContentFits(low)).toBe(false); // 前置：真的放不下（否則 flip 不會觸發，「沒 flip」不證明什麼）
  } finally {
    await context.close();
  }
});

test("結果態隨捲動跟著區塊走；區塊頂捲出捲動容器頂時，框頂夾在容器頂", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box overlay scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    const box = await openSelectionAiBox(page, paragraphs[8]!);
    const block = mainBlock(page, paragraphs[8]!);
    await runInstruction(box);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);

    // 小捲一段（區塊頂仍在容器內）：框跟著區塊走
    const startY = (await block.boundingBox())!.y;
    await scrollContainerBy(page, 50);
    await expect.poll(async () => (await block.boundingBox())!.y).toBeLessThan(startY - 40);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);

    // 把區塊頂捲到容器頂之上 40px：框頂夾在容器頂，不越過
    const containerTop = await scrollContainerTop(page);
    await scrollContainerBy(page, (await block.boundingBox())!.y - containerTop + 40);
    await expect.poll(async () => (await block.boundingBox())!.y).toBeLessThan(containerTop - 30);
    await expect.poll(async () => Math.abs((await box.boundingBox())!.y - containerTop)).toBeLessThanOrEqual(1);
    expect((await box.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop - 0.5);
  } finally {
    await context.close();
  }
});

test("開框、送出、完成都不改變筆記的捲動位置（框內焦點轉移一律 preventScroll）", async ({ browser }) => {
  // 開框當下框還沒被 floating-ui 定位（還在 portal 原點），textarea.focus() 不帶 preventScroll 就把筆記捲過去：e2e 突變（開框焦點拿掉
  // preventScroll）在本案量到開框那一步 scrollTop 150→0（1280×720、30 段、第 12 段）。第 12 段開框前後都在
  // 可視範圍內，Playwright 的 click／fill／press 不需要自己捲動；量開框、送出、完成三個時點。
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box no-scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);
    await scrollContainerBy(page, 150);
    await expect.poll(() => scrollContainerScrollTop(page)).toBe(150); // 前置：真的捲在非零位置
    const scrolled = await scrollContainerScrollTop(page);
    const stays = async () => expect.poll(async () => Math.abs((await scrollContainerScrollTop(page)) - scrolled)).toBeLessThanOrEqual(1);

    // 開框（焦點進輸入框）
    const box = await openSelectionAiBox(page, paragraphs[12]!);
    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await expect(input).toBeFocused();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await stays();
    // 送出（焦點移到取消鈕）
    await input.fill("Shorten it");
    await input.press("Enter");
    await stays();
    // 完成（焦點移到框容器）
    await expect(box.getByTestId("selection-ai-preview")).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
    await expect(box).toBeFocused();
    await stays();
  } finally {
    await context.close();
  }
});
