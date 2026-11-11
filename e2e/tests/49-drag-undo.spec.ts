import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, noteIdFromUrl, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * ⋮⋮ 拖放之後的撤銷與焦點：U1 橫線放進既有欄之後立刻 Ctrl+Z（#428）、U2 排序之後焦點留在編輯器（#430）、
 * U3 多選拖曳途中協作者打字（#429）、U4／U5／U7 焦點不在編輯器時頁面上的 Ctrl+Z（#430）、U6 複製拖之後立刻 Ctrl+Z（#428）、
 * U8 刪掉選取的圖片、撤銷、立刻重做（#428）、U9 協作者刪掉你選取的圖片（#428）。
 * 真滑鼠、1440×900。
 *
 * - 內容一律貼 markdown（同 34／48）。文件形狀讀主編輯器的 ProseMirror 文件：`docShape` 同 48 的格式，`docIds` 是頂層
 *   block（含列裡每一欄的 block）的 `文字#id 前 8 碼`。
 * - 拖曳照 48 的分段（hover → 等 ⋮⋮ 移到該 block 旁 → 按住 → 小移 5 步 → 15 步到終點 → 再下移 1px → 放開）。
 * - 協作者是另一個 browser context，用同一個帳號開同一篇。
 * - 貼上與拖曳之間等 1 秒，兩者是不同的撤銷步驟；拖完等 800ms 再按 Ctrl+Z（使用者的節奏，不靠撤銷合併窗口）。
 * - 每案收 `pageerror`，案尾斷言沒有（`ResizeObserver loop` 是瀏覽器已知的良性訊息，排除）。
 */

const RUN = Date.now();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

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
  await createNote(page, `E2E drag undo ${label} ${RUN}`);
  return errors;
}

/** 協作者：另一個 context 以同一個帳號開同一篇，等連上、編輯器掛好。 */
async function openCollaborator(browser: Browser, url: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await page.goto(url);
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
  return { context, page, errors };
}

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

/** 在筆記最後貼上 markdown，等 1 秒讓貼上自成一個撤銷步驟。 */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

type PmNode = { type: { name: string }; attrs: { id?: unknown }; childCount: number; child(i: number): PmNode; firstChild: PmNode | null; textContent: string };

/** 主編輯器 ProseMirror 文件的頂層形狀（同 48）。 */
async function docShape(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type Node = { type: { name: string }; childCount: number; child(i: number): Node; firstChild: Node | null; textContent: string };
    const view = (el as Element & { editor?: { view?: { state: { doc: Node } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const kids = (n: Node): Node[] => Array.from({ length: n.childCount }, (_, i) => n.child(i));
    const shapeOf = (n: Node): string => {
      if (n.type.name === "columnList") return `ROW[${kids(n).map(shapeOf).join(" | ")}]`;
      if (n.type.name === "column") return `COL(${kids(n).map(shapeOf).join(",")})`;
      const text = n.firstChild!.textContent;
      return `${n.firstChild!.type.name}${text ? `:${text}` : ""}`;
    };
    return kids(view.state.doc.firstChild!).map(shapeOf).join("  ");
  });
}

/** 每個 blockContainer（含列裡的）依文件順序：`文字#id 前 8 碼`。 */
async function docIds(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((el) => {
    type Node = PmNode & { descendants(f: (n: Node) => boolean | void): void };
    const view = (el as Element & { editor?: { view?: { state: { doc: Node } } } }).editor!.view!;
    const out: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === "blockContainer") out.push(`${n.firstChild!.textContent}#${String(n.attrs.id).slice(0, 8)}`);
    });
    return out;
  });
}

/** 焦點在不在主編輯器裡。 */
const focusInEditor = (page: Page) => editorLocator(page).evaluate((el) => el.contains(document.activeElement));

function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

type Point = { x: number; y: number };

/** hover `block`，等側邊選單移到它旁邊（同 48 `hoverForSideMenu`）。 */
async function hoverForSideMenu(page: Page, block: Locator, label: string): Promise<void> {
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${label}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }).toEqual({ overlap: true, nearLeft: true });
  }).toPass({ timeout: 5_000 });
}

async function moveInSteps(page: Page, from: Point, to: Point, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
}

/**
 * 按住 `sourceText` 的 ⋮⋮，照 48 的分段拖到 `targetText` 那段的下半部（橫線放置）放開。`midDrag` 在小移之後、移到終點之前跑
 * （拖曳中途讓協作者打字）。
 */
async function dragBlockBelow(page: Page, sourceText: string, targetText: string, midDrag?: () => Promise<void>, opts: { copy?: boolean } = {}): Promise<void> {
  await hoverForSideMenu(page, blockOuter(page, sourceText), sourceText);
  const h = (await page.getByRole("button", { name: "Open block menu" }).boundingBox())!;
  const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const nudge = { x: start.x + 10, y: start.y + 10 };
  await moveInSteps(page, start, nudge, 5);
  await midDrag?.();
  const t = (await blockOuter(page, targetText).boundingBox())!;
  const end = { x: t.x + t.width / 2, y: t.y + t.height * 0.75 };
  // 複製拖：按住 Ctrl 移到終點、放開（PM 在 drop 時看修飾鍵）。
  if (opts.copy) await page.keyboard.down("Control");
  await moveInSteps(page, nudge, end, 15);
  await moveInSteps(page, end, { x: end.x, y: end.y + 1 }, 1);
  await page.mouse.up();
  if (opts.copy) await page.keyboard.up("Control");
}

/** document 有沒有收到這次拖曳的 dragend（⋮⋮ 在放下時被換掉的話收不到）。 */
async function watchDragEnd(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const w = window as unknown as { kbDragEnd?: boolean };
    w.kbDragEnd = false;
    document.addEventListener("dragend", () => void (w.kbDragEnd = true), { once: true });
  });
  return () => page.evaluate(() => !!(window as unknown as { kbDragEnd?: boolean }).kbDragEnd);
}

test("U1 #428 z 橫線放進 [a｜b] 的第 1 欄，不點編輯器直接 Ctrl+Z → 一下還原、沒有 pageerror、協作者看到的相同、id 不變", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u1");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b"]), "", "z", ""].join("\n"));
  const original = "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z";
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(original);
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const before = await docShape(page);
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    const dragEnded = await watchDragEnd(page);
    await dragBlockBelow(page, "z", "a");
    const moved = "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page)).toContain(moved);
    await expect.poll(() => docShape(peer.page)).toBe(await docShape(page));
    expect(await focusInEditor(page), "放下後焦點在編輯器").toBe(true);
    test.info().annotations.push({ type: "dragend-reached-document-after-drop-into-column", description: String(await dragEnded()) });

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(before);
    expect(await docIds(page)).toEqual(idsBefore);
    await expect.poll(() => docShape(peer.page), { message: "共享文件也還原" }).toBe(before);
    // 再打一個字：本機與共享文件一致的話，打字不會把撤銷前的狀態寫回去。
    await clickEndOfParagraph(page, blockOuter(page, "x").locator(".bn-inline-content").first());
    await page.keyboard.type("T");
    await expect.poll(() => docShape(peer.page)).toContain("paragraph:xT  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

test("U2 #430 x y z 拖 x 到 z 下方 → 焦點留在編輯器、游標在 x；不點編輯器直接 Ctrl+Z → 一下還原、id 不變", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u2");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const before = await docShape(page);
  const idsBefore = await docIds(page);
  await page.waitForTimeout(1_000);

  const dragEnded = await watchDragEnd(page);
  await dragBlockBelow(page, "x", "z");
  await expect.poll(() => docShape(page)).toContain("paragraph:y  paragraph:z  paragraph:x");
  await expect.poll(() => focusInEditor(page), { message: "放下後焦點在編輯器" }).toBe(true);
  test.info().annotations.push({ type: "dragend-reached-document-after-top-level-sort", description: String(await dragEnded()) });
  const cursor = await editorLocator(page).evaluate((el) => {
    type View = { state: { selection: { toJSON(): { type: string }; $from: { parent: { textContent: string }; parentOffset: number } } } };
    const sel = (el as Element & { editor?: { view?: View } }).editor!.view!.state.selection;
    return { type: sel.toJSON().type, text: sel.$from.parent.textContent, offset: sel.$from.parentOffset };
  });
  expect(cursor).toEqual({ type: "text", text: "x", offset: 0 });

  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toBe(before);
  expect(await docIds(page)).toEqual(idsBefore);
  expectNoPageErrors(errors);
});

test("U6 #428 按住 Ctrl 把 x 複製到 z 下方（文件結尾），不點編輯器直接 Ctrl+Z → 一下還原、沒有 pageerror、協作者看到的相同 [sc:dragBlockCopy]", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u6");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const before = await docShape(page);
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    await dragBlockBelow(page, "x", "z", undefined, { copy: true });
    await expect.poll(() => docShape(page)).toBe("paragraph:x  paragraph:y  paragraph:z  paragraph:x");
    await expect.poll(() => docShape(peer.page)).toBe(await docShape(page));
    await expect.poll(() => focusInEditor(page), { message: "放下後焦點在編輯器" }).toBe(true);
    const idsCopied = await docIds(page);

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(before);
    const idsUndone = await docIds(page);
    // 複製拖是 PM 預設的放置，兩份 x 的 id 怎麼分配不歸這裡管，只記下；沒被複製的 y、z 的 id 不變。
    test.info().annotations.push({ type: "ids-before-copied-undone", description: JSON.stringify({ idsBefore, idsCopied, idsUndone }) });
    expect(idsUndone.slice(1)).toEqual(idsBefore.slice(1));
    await expect.poll(() => docShape(peer.page), { message: "共享文件也還原" }).toBe(before);
    expect(await docIds(peer.page)).toEqual(idsUndone);
    // 本機與共享文件一致的話，之後打字不會把複本寫回去。
    await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
    await page.keyboard.type("T");
    await expect.poll(() => docShape(peer.page)).toBe("paragraph:x  paragraph:yT  paragraph:z");
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

test("U3 #429 a b 多選拖到 c 下方，拖曳途中協作者在 d 打字 → a b 整塊搬走、沒有空段落、兩邊相同；Ctrl+Z 一下還原", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u3");
  await pasteMarkdown(page, "a\n\nb\n\nc\n\nd\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:a  paragraph:b  paragraph:c  paragraph:d");
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    // 選取從 a 跨到 b（core 在 dragstart 把它換成兩個 block 的多選）。
    await clickEndOfParagraph(page, blockOuter(page, "a").locator(".bn-inline-content").first());
    await page.keyboard.press("Shift+ArrowDown");
    await waitForEditorSelection(page);
    const selectionType = () =>
      editorLocator(page).evaluate((el) => (el as Element & { editor?: { view?: { state: { selection: { toJSON(): { type: string } } } } } }).editor!.view!.state.selection.toJSON().type);
    let midType = "";
    await dragBlockBelow(page, "a", "c", async () => {
      expect(await selectionType(), "前提：dragstart 後是多選").toBe("multiple-node");
      await clickEndOfParagraph(peer.page, blockOuter(peer.page, "d").locator(".bn-inline-content").first());
      await peer.page.keyboard.type("Q");
      await expect.poll(() => docShape(page), { timeout: 10_000 }).toContain("paragraph:dQ");
      midType = await selectionType();
    });
    test.info().annotations.push({ type: "selection-after-remote-update-mid-drag", description: midType });
    expect(midType, "前提：遠端更新之後多選退化成文字選取").toBe("text");
    const moved = "paragraph:c  paragraph:a  paragraph:b  paragraph:dQ";
    await expect.poll(() => docShape(page)).toBe(moved);
    await expect.poll(() => docShape(peer.page)).toBe(moved);
    const idsMoved = await docIds(page);
    expect(idsMoved.map((s) => s.split("#")[1])).toEqual([idsBefore[2], idsBefore[0], idsBefore[1], idsBefore[3]].map((s) => s!.split("#")[1]));
    expect(await docIds(peer.page)).toEqual(idsMoved);

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    await expect.poll(() => docShape(peer.page)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    const idsUndone = await docIds(page);
    test.info().annotations.push({ type: "ids-before-moved-undone", description: JSON.stringify({ idsBefore, idsMoved, idsUndone }) });
    expect(idsUndone.map((s) => s.split("#")[1]), "撤銷後 id 回到拖曳前").toEqual(idsBefore.map((s) => s.split("#")[1]));
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

/** 頁首左上角的 padding（不是任何控制項）：點下去焦點落到 `<body>`。 */
async function clickHeaderBlank(page: Page): Promise<void> {
  const header = page.locator("header").filter({ has: page.getByLabel("Note title") });
  const box = (await header.boundingBox())!;
  const p = { x: box.x + 3, y: box.y + 3 };
  const hit = await header.evaluate((el, pt) => document.elementFromPoint(pt.x, pt.y) === el, p);
  expect(hit, "前提：點的是頁首本身").toBe(true);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body), { message: "焦點在 body" }).toBe(true);
}

test("U4 #430 排序之後點頁首空白處（焦點在 body）→ Ctrl+Z 照樣撤銷這篇、焦點回到編輯器；Ctrl+Shift+Z 重做", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u4");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const before = await docShape(page);
  await page.waitForTimeout(1_000);
  await dragBlockBelow(page, "x", "z");
  const moved = "paragraph:y  paragraph:z  paragraph:x";
  await expect.poll(() => docShape(page)).toContain(moved);

  await clickHeaderBlank(page);
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toBe(before);
  await expect.poll(() => focusInEditor(page), { message: "撤銷後焦點回到編輯器" }).toBe(true);

  await clickHeaderBlank(page);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => docShape(page)).toBe(moved);
  expectNoPageErrors(errors);
});

test("U5 #430 排序之後焦點在標題框 → Ctrl+Z 不動筆記內容", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u5");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await page.waitForTimeout(1_000);
  await dragBlockBelow(page, "x", "z");
  const moved = "paragraph:y  paragraph:z  paragraph:x";
  await expect.poll(() => docShape(page)).toContain(moved);
  const title = page.getByLabel("Note title");

  await title.click();
  await expect(title).toBeFocused();
  await page.keyboard.press("Control+z");
  // 撤銷是同步的：等一段時間確定筆記沒有晚到的改動。
  await page.waitForTimeout(800);
  expect(await docShape(page)).toBe(moved);
  // 鍵沒有被攔下：標題框自己的撤銷收到了它，退回 `createNote` 填標題之前的值。
  await expect(title).toHaveValue("Untitled");
  await expect(title).toBeFocused();
  expectNoPageErrors(errors);
});

/** 主編輯器第一個列每一欄的文件欄寬（column 節點的 `width`；同 48）。 */
async function docWidths(page: Page): Promise<number[]> {
  return editorLocator(page).evaluate((el) => {
    type Node = { type: { name: string }; attrs: { width?: number }; childCount: number; child(i: number): Node };
    type View = { state: { doc: { descendants(f: (n: Node) => boolean | void): void } } };
    const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
    let widths: number[] | null = null;
    view.state.doc.descendants((n) => {
      if (widths) return false;
      if (n.type.name !== "columnList") return true;
      widths = Array.from({ length: n.childCount }, (_, i) => Number(n.child(i).attrs.width));
      return false;
    });
    return widths ?? [];
  });
}

test("U7 #430 欄間分隔線有焦點時用 → 調寬，不點回筆記直接 Ctrl+Z → 欄寬還原、焦點回到編輯器", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u7");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await page.waitForTimeout(1_000);
  const divider = page.locator('.kb-column-dividers [role="separator"]').first();
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  await expect(divider).toBeFocused();
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);
  await expect.poll(() => focusInEditor(page), { message: "撤銷後焦點回到編輯器" }).toBe(true);
  expectNoPageErrors(errors);
});

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** 灰色 RGB PNG（同 34／48）。 */
function grayPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 走 API 真上傳一張 PNG 到目前這篇，回傳 `/api/uploads/…` 網址（同 48）。 */
async function uploadPng(page: Page): Promise<string> {
  const noteId = await noteIdFromUrl(page);
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: new URL(page.url()).origin },
    multipart: { file: { name: "u8.png", mimeType: "image/png", buffer: grayPng(120, 80) } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

const selectionJSON = (page: Page) =>
  editorLocator(page).evaluate((el) => (el as Element & { editor?: { view?: { state: { selection: { toJSON(): { type: string } } } } } }).editor!.view!.state.selection.toJSON().type);

for (const where of ["end", "column"] as const) {
  test(`U8 #428 點選圖片（${where === "end" ? "文件結尾" : "第 1 欄最後一個 block"}）→ Backspace 刪掉 → Ctrl+Z → 立刻 Ctrl+Shift+Z → 沒有 pageerror、重做生效、協作者看到的相同`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const errors = await startNote(page, `u8-${where}`);
    const url = await uploadPng(page);
    const image = `![a](${url})`;
    await pasteMarkdown(page, where === "end" ? `x\n\n${image}\n` : ["x", "", columnsMarkdown([`a\n\n${image}`, "b"]), ""].join("\n"));
    const withImage = where === "end" ? "paragraph:x  image" : "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]";
    const without = where === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(withImage);
    const img = editorLocator(page).locator(`img[src*="${url}"]`);
    await expect(img).toBeVisible({ timeout: 15_000 });
    const peer = await openCollaborator(browser, page.url());
    try {
      await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
      await page.waitForTimeout(1_000);

      await img.click();
      await expect.poll(() => selectionJSON(page), { message: "前提：點圖片之後是 NodeSelection" }).toBe("node");
      await page.keyboard.press("Backspace");
      await expect.poll(() => docShape(page)).toBe(without);
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+z");
      await expect.poll(() => docShape(page)).toBe(withImage);
      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => docShape(page)).toBe(without);
      await expect.poll(() => docShape(peer.page), { message: "共享文件也重做了" }).toBe(without);
      // 本機與共享文件一致的話，之後打字兩邊都看得到。
      await clickEndOfParagraph(page, blockOuter(page, "x").locator(".bn-inline-content").first());
      await page.keyboard.type("T");
      await expect.poll(() => docShape(peer.page)).toBe(without.replace("paragraph:x", "paragraph:xT"));
      expectNoPageErrors(errors);
      expectNoPageErrors(peer.errors);
    } finally {
      await peer.context.close();
    }
  });

  test(`U9 #428 點選圖片（${where === "end" ? "文件結尾" : "第 1 欄最後一個 block"}）之後協作者刪掉它 → 沒有 pageerror、本機與協作者看到的相同、之後打字兩邊一致`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const errors = await startNote(page, `u9-${where}`);
    const url = await uploadPng(page);
    const image = `![a](${url})`;
    await pasteMarkdown(page, where === "end" ? `x\n\n${image}\n` : ["x", "", columnsMarkdown([`a\n\n${image}`, "b"]), ""].join("\n"));
    const withImage = where === "end" ? "paragraph:x  image" : "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]";
    const without = where === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(withImage);
    const img = editorLocator(page).locator(`img[src*="${url}"]`);
    await expect(img).toBeVisible({ timeout: 15_000 });
    const peer = await openCollaborator(browser, page.url());
    try {
      await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
      const peerImg = editorLocator(peer.page).locator(`img[src*="${url}"]`);
      await expect(peerImg).toBeVisible({ timeout: 15_000 });

      await img.click();
      await expect.poll(() => selectionJSON(page), { message: "前提：點圖片之後是 NodeSelection" }).toBe("node");
      await peerImg.click();
      await expect.poll(() => selectionJSON(peer.page)).toBe("node");
      await peer.page.keyboard.press("Backspace");
      await expect.poll(() => docShape(peer.page)).toBe(without);
      await expect.poll(() => docShape(page), { message: "本機收到刪除" }).toBe(without);
      // 本機與共享文件一致的話，之後打字兩邊都看得到。協作者的游標標籤可能就在 x 裡（x 的文字不再只是 "x"），所以用鍵盤移到
      // 第一段（x）的結尾，不點它。
      expect(await focusInEditor(page), "焦點還在編輯器").toBe(true);
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("End");
      await waitForEditorSelection(page);
      await page.keyboard.type("T");
      await expect.poll(() => docShape(peer.page)).toBe(without.replace("paragraph:x", "paragraph:xT"));
      await expect.poll(() => docShape(page)).toBe(await docShape(peer.page));
      expectNoPageErrors(errors);
      expectNoPageErrors(peer.errors);
    } finally {
      await peer.context.close();
    }
  });
}
