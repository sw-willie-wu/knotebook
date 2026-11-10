import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, randomEmail, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * 並排排版 PR-1（columns-layout spec §13.2 的 PR-1 部分、§17 #1／#2／#3 側邊把手、plan Review Focus 4）：
 * C1 `/grid`、C2 D24＋撤銷、C3 D25＋取消並排、C4 堆疊、C5 寬表格、C6 欄內圖片把手、C7 側邊把手、C8 拖出唯一 block、
 * C9 公開頁／簡報／版本、C10 外部 HTML 不成列。
 *
 * - 內容一律貼 §11.1 正規形的 markdown（純文字剪貼簿 → `collab/paste.ts` 接手 → `pasteMarkdown`；同 22-presentation）。
 * - 文件形狀讀主編輯器的 ProseMirror 文件（`docShape`，格式同 web 的 `test/columns-fixtures.ts` 的 `shape`）：
 *   `paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z`（`paragraph` 無文字＝空段落）。
 * - e2e 不能 import web：堆疊門檻自算（`collab/columns/layout.ts` 的 COLUMN_MIN_TEXT_PX／COLUMN_GAP_PX，兩邊要一起改）。
 * - 每案收 `pageerror`，案尾斷言沒有（`ResizeObserver loop` 是瀏覽器已知的良性訊息，排除）。
 * - §17 的結果寫進 `test.info().annotations`（spec-17-1、spec-17-3），C4 的 768 寬、C5 的捲動量、C10 剪貼簿讀回的 HTML 也記（stack-768、review-focus-4、external-html）。
 */

const RUN = Date.now();
const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';
const COLUMN_MIN_TEXT_PX = 200;
const COLUMN_GAP_PX = 24;
/** 兩欄文字列：列寬 < 424 才堆疊（`shouldStack`：各欄最小寬度總和＋溝寬 > 可用寬）。 */
const TWO_TEXT_NEEDED = 2 * COLUMN_MIN_TEXT_PX + COLUMN_GAP_PX;

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

function expectNoPageErrors(errors: string[]): void {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

async function startNote(page: Page, label: string, creds: { email: string; password: string } = ADMIN): Promise<string[]> {
  const errors = collectPageErrors(page);
  await loginAs(page, creds.email, creds.password);
  await createNote(page, `E2E columns ${label} ${RUN}`);
  return errors;
}

/** §11.1 正規形的一列（各欄 `flex:1`）。 */
function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

/** 列前後各一段（`x`／`z`），同 web 單元測試的 fixture。 */
function rowDoc(cols: string[]): string {
  return ["x", "", columnsMarkdown(cols), "", "z", ""].join("\n");
}

/** 疊的 origin 取目前頁面（呼叫時已登入、導覽過），不另寫一份網址常數。 */
function originOf(page: Page): string {
  return new URL(page.url()).origin;
}

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: originOf(page) });
}

/** 在筆記最後貼上 markdown（22-presentation 的 pasteMarkdown；Ctrl+End 後等 ProseMirror 跟上再貼）。 */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await grantClipboard(page);
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

/** 主編輯器 ProseMirror 文件的頂層形狀（見檔頭）。 */
async function docShape(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; childCount: number; child(i: number): PmNode; firstChild: PmNode | null; textContent: string };
    const view = (el as Element & { editor?: { view?: { state: { doc: PmNode } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const kids = (n: PmNode): PmNode[] => Array.from({ length: n.childCount }, (_, i) => n.child(i));
    const shapeOf = (n: PmNode): string => {
      if (n.type.name === "columnList") return `ROW[${kids(n).map(shapeOf).join(" | ")}]`;
      if (n.type.name === "column") return `COL(${kids(n).map(shapeOf).join(",")})`;
      const content = n.firstChild!;
      const text = content.textContent;
      const group = n.childCount > 1 ? n.child(1) : null;
      return `${content.type.name}${text ? `:${text}` : ""}${group ? `{${kids(group).map(shapeOf).join(",")}}` : ""}`;
    };
    return kids(view.state.doc.firstChild!).map(shapeOf).join("  ");
  });
}

/** 文字恰為 `text` 的區塊外層（27-site-links 同名 helper；巢狀時取最內層）。 */
function blockOuter(page: Page, text: string): Locator {
  const root = editorLocator(page);
  return root
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

function inlineOf(page: Page, text: string): Locator {
  return blockOuter(page, text).locator(".bn-inline-content").first();
}

/** 點進某段文字、把游標放到開頭（Home）或結尾（End），等 ProseMirror 的 selection 跟上。 */
async function caretIn(page: Page, text: string, where: "Home" | "End"): Promise<void> {
  await inlineOf(page, text).click();
  await page.keyboard.press(where);
  await waitForEditorSelection(page);
}

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

/** 灰色 RGB PNG（22-presentation 的 tallPng 同法）。 */
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

/** 走 API 真上傳一張 PNG 到目前這篇（同 22-presentation E4），回傳 `/api/uploads/…` 網址。 */
async function uploadPng(page: Page, width: number, height: number): Promise<string> {
  const noteId = await noteIdFromUrl(page);
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: originOf(page) },
    multipart: { file: { name: `p${width}x${height}.png`, mimeType: "image/png", buffer: grayPng(width, height) } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

async function waitImageLoaded(img: Locator): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
}

/** slash 選單開著（浮層關閉淡出時包裝層 inline `opacity:0`、DOM 還在——全域 playwright-e2e-gotchas）。 */
async function slashMenuOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const menu = document.querySelector(".bn-suggestion-menu");
    if (!menu) return false;
    for (let el: Element | null = menu; el; el = el.parentElement) if ((el as HTMLElement).style?.opacity === "0") return false;
    return true;
  });
}

/** 游標前剛打的 `typed` 逐字 Backspace 刪掉，等文件裡不再有 `/`。 */
async function clearTyped(page: Page, typed: string): Promise<void> {
  for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
  await expect.poll(() => docShape(page)).not.toContain("/");
}

async function slashTitles(page: Page): Promise<string[]> {
  return (await page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title").allTextContents()).map((t) => t.trim());
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * hover `text` 那一塊，等側邊選單移到它旁邊才回傳兩者的框：垂直範圍重疊，且選單中心在該塊左緣往左 100px 內
 * （同一列的另一欄 y 相同，只看垂直分不出是哪一欄的選單）。貼上時的點擊會讓選單先停在別塊，不等就會量／拖到錯的那塊。
 */
async function hoverForSideMenu(page: Page, text: string): Promise<{ menu: Rect; block: Rect }> {
  const block = blockOuter(page, text);
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  let got: { menu: Rect; block: Rect } | undefined;
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${text}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }, JSON.stringify({ menu, block: box })).toEqual({ overlap: true, nearLeft: true });
    got = { menu: menu!, block: box! };
  }).toPass({ timeout: 5_000 });
  return got!;
}

/** 把 `sourceText` 那個 block 的 ⋮⋮ 拖到 `targetText` 那段的下半部放開（core 預設拖放）。 */
async function dragBlockBelow(page: Page, sourceText: string, targetText: string): Promise<void> {
  await hoverForSideMenu(page, sourceText);
  const handle = page.getByRole("button", { name: "Open block menu" });
  const h = (await handle.boundingBox())!;
  const t = (await blockOuter(page, targetText).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10, h.y + h.height / 2 + 10, { steps: 5 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.75, { steps: 15 });
  await page.mouse.move(t.x + t.width / 2 + 2, t.y + t.height * 0.75);
  await page.mouse.up();
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("C1 /grid（§17 #1、驗收 3）：/grid 列出 2／3／4 欄；/grid 3 只剩 3 欄（空白關選單則改 /grid3）；Enter 建 3 欄、游標在第 1 欄", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "grid");
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);

  await page.keyboard.type("/grid");
  await expect.poll(() => slashMenuOpen(page)).toBe(true);
  await expect.poll(() => slashTitles(page)).toEqual(expect.arrayContaining(["2 columns", "3 columns", "4 columns"]));
  await page.keyboard.press("Escape");
  await expect.poll(() => slashMenuOpen(page)).toBe(false);
  // Esc 留下「/grid」字樣：逐字 Backspace 清掉（不用 Shift+Home：原生選取要等 selectionchange，Backspace 可能只刪一字）
  await clearTyped(page, "/grid");

  await page.keyboard.type("/grid 3");
  const menuState = async () => ((await slashMenuOpen(page)) ? (await slashTitles(page)).join("|") : "closed");
  let outcome = "";
  await expect.poll(async () => (outcome = await menuState()), { timeout: 5_000 }).toMatch(/^(closed|3 columns)$/);
  if (outcome === "closed") {
    test.info().annotations.push({ type: "spec-17-1", description: "space closes menu" });
    await clearTyped(page, "/grid 3");
    await page.keyboard.type("/grid3");
    await expect.poll(menuState).toBe("3 columns");
  } else {
    test.info().annotations.push({ type: "spec-17-1", description: "space keeps menu open" });
  }
  await page.keyboard.press("Enter");

  const rows = editor.locator(ROW);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(COL)).toHaveCount(3);
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph) | COL(paragraph) | COL(paragraph)]");
  await waitForEditorSelection(page);
  await page.keyboard.type("左");
  await expect(rows.first().locator(COL).first()).toHaveText("左");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:左) | COL(paragraph) | COL(paragraph)]");
  expectNoPageErrors(errors);
});

test("C2 D24 與撤銷（驗收 4、5）：[a｜b] 在 b 開頭 Backspace → 攤平成 a b、中間沒有空段落；Ctrl+Z 一次 → 列回來", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "d24");
  const editor = editorLocator(page);
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");

  await caretIn(page, "b", "Home");
  await page.keyboard.press("Backspace");
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:a  paragraph:b  paragraph:z");

  await page.keyboard.press("Control+z");
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  expectNoPageErrors(errors);
});

test("C3 D25（驗收 3）：工具列刪掉欄內的圖 → 列不變、左欄留一個空段落；⋮⋮「Ungroup columns」→ 列攤平、r 還在", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "d25");
  const editor = editorLocator(page);
  const url = await uploadPng(page, 40, 40);
  await pasteMarkdown(page, rowDoc([`![x](${url})`, "r"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:r)]");
  const img = editor.locator(`${ROW} ${COL}`).first().locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);

  await img.click();
  const del = page.locator("[data-kb-file-delete]");
  await expect(del).toBeVisible();
  await del.click();
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph) | COL(paragraph:r)]");

  await blockOuter(page, "r").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Ungroup columns" }).click();
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:r");
  expectNoPageErrors(errors);
});

test("C4 堆疊（驗收 6、§13.2）：1440／1024 並排、390 堆疊、768 依實際；每個寬度整頁沒有水平捲動", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "stack");
  await pasteMarkdown(page, rowDoc(["left text", "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:left text) | COL(paragraph:right text)]");
  const row = editorLocator(page).locator(ROW).first();

  type Box = { y: number; bottom: number };
  type Layout = { rowWidth: number; stacked: boolean; cols: Box[]; scrollWidth: number };
  const measure = (): Promise<Layout> =>
    row.evaluate((el) => ({
      rowWidth: (el as HTMLElement).clientWidth,
      stacked: el.hasAttribute("data-stacked"),
      cols: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map((c) => {
        const r = c.getBoundingClientRect();
        return { y: r.y, bottom: r.bottom };
      }),
      scrollWidth: document.documentElement.scrollWidth,
    }));

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    let m: Layout | undefined;
    // 堆疊由 ResizeObserver 非同步重算：等 data-stacked 與當下列寬的規則一致
    await expect(async () => {
      m = await measure();
      expect(m.rowWidth).toBeGreaterThan(0);
      expect(m.stacked, `width ${width}: rowWidth ${m.rowWidth}`).toBe(m.rowWidth < TWO_TEXT_NEEDED);
    }).toPass({ timeout: 10_000 });
    const got = m!;
    expect(got.cols).toHaveLength(2);
    const [c1, c2] = got.cols as [Box, Box];
    if (width === 1440 || width === 1024) {
      expect(got.stacked, `width ${width} 應並排（rowWidth ${got.rowWidth}）`).toBe(false);
      expect(Math.abs(c2.y - c1.y)).toBeLessThanOrEqual(0.5);
    } else if (width === 390) {
      expect(got.stacked, `width 390 應堆疊（rowWidth ${got.rowWidth}）`).toBe(true);
      expect(c2.y).toBeGreaterThan(c1.bottom);
    } else {
      test.info().annotations.push({ type: "stack-768", description: JSON.stringify({ rowWidth: got.rowWidth, stacked: got.stacked }) });
    }
    expect(got.scrollWidth, `width ${width}：document scrollWidth`).toBeLessThanOrEqual(width);
  }
  expectNoPageErrors(errors);
});

test("C5 寬表格（Review Focus 4）：左欄 6 欄長字串表格、390 寬 → 整頁不出水平捲動、表格在欄內捲動", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "wide-table");
  const cells = (r: string) => `| ${Array.from({ length: 6 }, (_, i) => `${r}LongCellContent${i + 1}WithoutAnyBreaks`).join(" | ")} |`;
  const table = [cells("H"), `| ${Array.from({ length: 6 }, () => "---").join(" | ")} |`, cells("R")].join("\n");
  await pasteMarkdown(page, rowDoc([table, "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(table");
  await page.setViewportSize({ width: 390, height: 844 });
  const leftCol = editorLocator(page).locator(`${ROW} ${COL}`).first();
  await expect(leftCol.locator("table")).toBeVisible();

  // 量到的值（含表格包裝層 .tableWrapper 自己的捲動量）記進 annotation，紅的時候看得出是誰在捲
  // 量到的值（欄與 .tableWrapper 兩層、溢出的是哪一層、它的 overflowX、捲動後的 scrollLeft）記進 annotation，紅的時候也有
  const record: Record<string, unknown> = {};
  try {
    let layer = null as "wrapper" | "column" | null;
    await expect(async () => {
      const m = await leftCol.evaluate((col) => {
        const wrapper = col.querySelector<HTMLElement>(".tableWrapper");
        const table = col.querySelector("table")!;
        const overflows = (el: HTMLElement | null) => !!el && el.scrollWidth > el.clientWidth;
        // 溢出的那一層：先看欄內的 .tableWrapper（core 讓它自成捲動容器），再看欄本身
        const layer: "wrapper" | "column" | null = overflows(wrapper) ? "wrapper" : overflows(col as HTMLElement) ? "column" : null;
        const target = layer === "wrapper" ? wrapper : layer === "column" ? (col as HTMLElement) : null;
        return {
          page: document.documentElement.scrollWidth,
          col: { scrollWidth: col.scrollWidth, clientWidth: col.clientWidth, right: col.getBoundingClientRect().right },
          wrapper: wrapper ? { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth } : null,
          tableWidth: table.getBoundingClientRect().width,
          layer,
          overflowX: target ? getComputedStyle(target).overflowX : null,
        };
      });
      Object.assign(record, m);
      layer = m.layer;
      expect(m.page, "document scrollWidth").toBeLessThanOrEqual(390);
      expect(m.col.right, "左欄右緣不出視窗").toBeLessThanOrEqual(390);
      expect(m.tableWidth, "前提：表格比欄寬").toBeGreaterThan(m.col.clientWidth);
      expect(m.layer, "欄或欄內 .tableWrapper 有橫向溢出").not.toBeNull();
      // scrollWidth 不受 overflow 值影響（hidden／clip 也一樣），所以另斷溢出的那層真的是捲動容器
      expect(["auto", "scroll"], `溢出那層（${m.layer}）的 overflowX`).toContain(m.overflowX);
    }).toPass({ timeout: 10_000 });

    // 使用者可觀察的行為：滑鼠在那一層上橫向滾輪 → 它真的捲動（overflow:hidden 時 scrollLeft 不會動）
    const target = layer === "wrapper" ? leftCol.locator(".tableWrapper").first() : leftCol;
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const point = { x: box.x + Math.min(box.width, 390 - box.x) / 2, y: box.y + box.height / 2 };
    const hit = await target.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), point);
    expect(hit, "滾輪落點在溢出那一層裡").toBe(true);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(300, 0);
    await expect.poll(async () => (record.scrollLeft = await target.evaluate((el) => el.scrollLeft))).toBeGreaterThan(0);
  } finally {
    test.info().annotations.push({ type: "review-focus-4", description: JSON.stringify(record) });
  }
  expectNoPageErrors(errors);
});

test("C6 欄內圖片：圖寬不超過欄；右把手往右拖 400px → 圖片欄變寬、文字欄讓出寬度但不小於 200px、寫入的 data-preview-width＝圖片顯示寬；往左拖 50px 圖片變小、欄寬不縮回", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await startNote(page, "image");
  const url = await uploadPng(page, 800, 200);
  await pasteMarkdown(page, rowDoc([`![wide](${url})`, "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const leftCol = editorLocator(page).locator(`${ROW} ${COL}`).first();
  const imageBlock = leftCol.locator('[data-content-type="image"]');
  const img = imageBlock.locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);

  const rightCol = editorLocator(page).locator(`${ROW} ${COL}`).nth(1);
  const colWidth = async () => (await leftCol.boundingBox())!.width;
  const rightWidth = async () => (await rightCol.boundingBox())!.width;
  expect((await img.boundingBox())!.width).toBeLessThanOrEqual((await colWidth()) + 0.5);
  const leftBefore = await colWidth();
  const rightBefore = await rightWidth();

  const dragRightHandle = async (dx: number) => {
    await img.hover();
    const handle = imageBlock.locator(".bn-resize-handle").nth(1); // 第二個是 right:4px 那顆
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 10 });
    await page.mouse.up();
  };
  const previewWidth = async () => Number(await imageBlock.getAttribute("data-preview-width"));

  await dragRightHandle(400);
  await expect(imageBlock).toHaveAttribute("data-preview-width", /^\d+$/);
  const widened = await previewWidth();
  const imgWidened = (await img.boundingBox())!.width;
  const leftWidened = await colWidth();
  const rightWidened = await rightWidth();
  test.info().annotations.push({ type: "image-expands-column", description: JSON.stringify({ leftBefore, rightBefore, widened, imgWidened, leftWidened, rightWidened }) });
  // 圖片超過原欄寬時圖片欄跟著變寬、文字欄讓出寬度，但不小於文字欄最小寬度。
  expect(leftWidened, "圖片欄變寬").toBeGreaterThan(leftBefore + 50);
  expect(rightWidened, "文字欄讓出寬度").toBeLessThan(rightBefore - 50);
  expect(rightWidened, "文字欄不小於 200px").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - 1);
  expect(Math.abs(widened - imgWidened), "data-preview-width＝圖片顯示寬").toBeLessThanOrEqual(1);
  expect(imgWidened).toBeLessThanOrEqual(leftWidened + 0.5);

  // 縮小圖片只改圖、不把欄縮回去。
  await dragRightHandle(-50);
  await expect.poll(previewWidth).toBeLessThan(widened);
  expect(Math.abs((await colWidth()) - leftWidened), "欄寬不縮回").toBeLessThanOrEqual(1);
  expectNoPageErrors(errors);
});

test("C7 側邊把手（§17 #3 的 PR-1 部分、§13.2）：第 2 欄的 ⋮⋮ 落在溝裡、不蓋進第 1 欄", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await startNote(page, "side-menu");
  await pasteMarkdown(page, rowDoc(["first column", "second column"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:first column) | COL(paragraph:second column)]");
  const row = editorLocator(page).locator(ROW).first();
  // 前提（硬）：列已排版、並排——列寬夠兩欄、沒有 data-stacked、兩欄 y 相同（RO 還沒跑時 data-stacked 本來就不存在，只斷它會空真）
  await expect(async () => {
    const m = await row.evaluate((el) => ({
      rowWidth: (el as HTMLElement).clientWidth,
      stacked: el.getAttribute("data-stacked"),
      ys: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map((c) => c.getBoundingClientRect().y),
    }));
    expect(m.rowWidth).toBeGreaterThanOrEqual(TWO_TEXT_NEEDED);
    expect(m.stacked).toBeNull();
    expect(m.ys).toHaveLength(2);
    expect(Math.abs(m.ys[0]! - m.ys[1]!)).toBeLessThanOrEqual(0.5);
  }).toPass({ timeout: 10_000 });

  // 正向對照：欄外的 block 有 "Add block"，下面斷「不可見」才不會因找不到元素而空真
  await blockOuter(page, "x").hover();
  const addBlock = page.getByRole("button", { name: "Add block" });
  await expect(addBlock).toBeVisible();

  let aligned: { menu: Rect; block: Rect } | undefined;
  try {
    aligned = await hoverForSideMenu(page, "second column");
  } finally {
    if (!aligned) test.info().annotations.push({ type: "spec-17-3", description: "side menu never aligned with the hovered block (see failure message)" });
  }
  const { menu, block } = aligned!;
  // 欄內只留 ⋮⋮（Willie 2026-10-22）：兩顆鈕共 48px，比 24px 的溝寬。
  await expect(addBlock).toBeHidden();
  const col1 = (await row.locator(COL).nth(0).boundingBox())!;
  const col2 = (await row.locator(COL).nth(1).boundingBox())!;
  const measured = {
    sideMenuLeft: menu.x,
    sideMenuRight: menu.x + menu.width,
    col1Right: col1.x + col1.width,
    col2Left: col2.x,
    sideMenuTop: menu.y,
    blockTop: block.y,
  };
  test.info().annotations.push({ type: "spec-17-3", description: JSON.stringify(measured) });
  expect(measured.sideMenuRight).toBeLessThanOrEqual(measured.col2Left + 2);
  expect(measured.sideMenuRight).toBeGreaterThan(measured.col1Right - 2);
  expect(measured.sideMenuLeft).toBeGreaterThanOrEqual(measured.col1Right - 2);
  expectNoPageErrors(errors);
});

test("C8 拖出唯一 block（§13.2、§5.4 M）：[a｜b] 拖 b 到 z 下方 → 仍兩欄、第 2 欄空段落；[a｜b｜c] 同動作 → 剩 a、c 兩欄", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "drag-two");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph)]");
  expect(await docShape(page)).toContain("paragraph:b");

  await createNote(page, `E2E columns drag-three ${RUN}`);
  await pasteMarkdown(page, rowDoc(["a", "b", "c"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph:c)]");
  expect(await docShape(page)).toContain("paragraph:b");
  expectNoPageErrors(errors);
});

/** C9 三案共用：登入、建筆記、貼兩欄（沒有任何標題：整篇含列都在封面），等列出現。回 pageerror 收集與兩欄文字。 */
async function startSurfacesNote(
  page: Page,
  label: string,
  creds?: { email: string; password: string },
): Promise<{ errors: string[]; left: string; right: string }> {
  const errors = await startNote(page, label, creds);
  const left = `colL${RUN}`;
  const right = `colR${RUN}`;
  await pasteMarkdown(page, rowDoc([left, right]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(`ROW[COL(paragraph:${left}) | COL(paragraph:${right})]`);
  return { errors, left, right };
}

test("C9a 公開頁（驗收 9、§11.7）：匿名開公開連結 → 有一列兩欄、兩欄文字都在", async ({ page, browser, request }) => {
  // 用新註冊的帳號：public-link 的 PUT 每人 10 次/10 分鐘，整套序跑到這裡 admin 已被用滿 → 429（同 31-note-width E3）。
  const creds = { email: randomEmail(), password: "e2e-columns-pw" };
  expect((await request.post("/api/auth/register", { data: creds })).status()).toBe(201);
  const { errors, left, right } = await startSurfacesNote(page, "public", creds);
  // 同 11-public-share／22-presentation E3 的 ShareDialog 操作
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
  await expect(publicRadio).toBeEnabled();
  const publish = page.waitForResponse((r) => r.url().includes("/public-link") && r.request().method() === "PUT");
  await publicRadio.check();
  expect((await publish).status()).toBe(200);
  const tokenInput = dialog.getByLabel("Public link URL");
  await expect(tokenInput).toBeVisible();
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.keyboard.press("Escape");
  await expect(async () => {
    const res = await page.request.get(`/api/public/notes/${token}`);
    expect(res.status()).toBe(200);
    expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(right);
  }).toPass({ timeout: 20_000 });

  const anonContext = await browser.newContext();
  try {
    const anon = await anonContext.newPage();
    const anonErrors = collectPageErrors(anon);
    await anon.goto(`/p/${token}`);
    const publicRow = anon.locator(ROW);
    await expect(publicRow).toHaveCount(1, { timeout: 15_000 });
    await expect(publicRow.locator(COL)).toHaveCount(2);
    await expect(publicRow).toContainText(left);
    await expect(publicRow).toContainText(right);
    expectNoPageErrors(anonErrors);
  } finally {
    await anonContext.close();
  }
  expectNoPageErrors(errors);
});

test("C9b 簡報（驗收 9、§11.8）：封面的列保留正規 style；390 寬開 → data-stacked，1440 寬重新進入 → 沒有", async ({ page }) => {
  const { errors, left, right } = await startSurfacesNote(page, "present");
  const noteUrl = page.url();
  const slideRow = page.locator("section.present [data-kb-columns]");

  // 落盤屏障（同 01-bootstrap 的 toPass(reload…)）：goto 會掐掉本頁唯一的共編連線、重載時內容由 server 讀回，
  // server 落盤有 debounce——重整到讀回的文件裡有這一列才往下走。
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await editorLocator(page).waitFor({ timeout: 5_000 });
    expect(await docShape(page)).toContain(`ROW[COL(paragraph:${left}) | COL(paragraph:${right})]`);
  }).toPass({ timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${noteUrl}?present`);
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
  await expect(slideRow).toHaveCount(1);
  expect(await slideRow.getAttribute("style")).toBe("display:flex;gap:16px");
  await expect(slideRow).toHaveAttribute("data-stacked", "");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${noteUrl}?present`);
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
  await expect(slideRow).toHaveCount(1);
  expect(await slideRow.getAttribute("style")).toBe("display:flex;gap:16px");
  await expect(slideRow).not.toHaveAttribute("data-stacked", "");
  expectNoPageErrors(errors);
});

test("C9c 版本（驗收 9、§11.9）：手動存版 → 改右欄 → split view 兩側列 y 差 ≤ 1px；單欄＋只看變更不出錯", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 }); // 1400 開面板：預覽區夠寬，自動 split（同 22-versions）
  const { errors, left, right } = await startSurfacesNote(page, "versions");
  await caretIn(page, left, "End");
  await saveVersion(page, "cols-base");
  await expect(page.getByText(/^Saved as cols-base \([0-9a-f]{7}\)$/)).toBeVisible();
  await caretIn(page, right, "End");
  await page.keyboard.type(" edited");
  await expect.poll(() => docShape(page)).toContain(`COL(paragraph:${right} edited)`);

  await page.getByTestId("versions-bubble").click();
  const panel = page.getByTestId("versions-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^cols-base \(/ }).click();
  await expect(page.getByTestId("preview-banner")).toContainText(/Previewing cols-base \([0-9a-f]{7}\)/);
  await expect(page.getByTestId("diff-split")).toBeVisible();
  await expect(async () => {
    const ys = await page.getByTestId("diff-split").evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>(":scope > section")).map(
        (sec) => sec.querySelector<HTMLElement>('.bn-editor > .bn-block-group > [data-node-type="columnList"]')?.getBoundingClientRect().y ?? null,
      ),
    );
    expect(ys).toHaveLength(2);
    const [l, r] = ys;
    expect(l, "左側的列").not.toBeNull();
    expect(r, "右側的列").not.toBeNull();
    expect(Math.abs(l! - r!)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });

  const banner = page.getByTestId("preview-banner");
  await banner.getByRole("button", { name: "Single column" }).click();
  await banner.getByRole("button", { name: "Only changes" }).click();
  const single = page.getByTestId("diff-single");
  await expect(single).toBeVisible();
  await expect(single.locator(ROW)).toHaveCount(1);
  // final review M-1：data-diff 直接寫在 PM 管的欄 DOM 上，真瀏覽器裡不得被重繪掉（值照 T9：欄本身 context、欄內改過的段落 changed）。
  await expect(single.locator(`${ROW} > ${COL}`)).toHaveCount(2);
  await expect(single.locator(`${ROW} > ${COL}[data-diff="context"]`)).toHaveCount(2);
  await expect(single.locator(`${COL}[data-diff="context"] .bn-block-outer[data-diff="changed"]`, { hasText: right })).toHaveCount(1);
  await expect(page.getByText("Version history couldn't be shown.")).toHaveCount(0);
  expectNoPageErrors(errors);
});

test("C10 外部 HTML 不成列（§11.10）：剪貼簿 text/html 是沒有 data-kb-* 的並列 div（帶 display:flex 與不帶各一次）→ 貼上後都沒有 columnList", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "external-html");
  const editor = editorLocator(page);
  await grantClipboard(page);
  // 帶 style 那份：Chromium 寫入 async clipboard 時會消毒 HTML，讀回記下 display:flex 是否還在（被剝的話，不帶 style 那份仍守住結構）
  const cases = [
    { label: "styled", html: '<div style="display:flex"><div><p>A</p></div><div><p>B</p></div></div>', texts: ["A", "B"] },
    { label: "plain", html: "<div><div><p>C</p></div><div><p>D</p></div></div>", texts: ["C", "D"] },
  ];
  for (const c of cases) {
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await waitForEditorSelection(page);
    const readBack = await page.evaluate(async (html) => {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]);
      const [item] = await navigator.clipboard.read();
      return item && item.types.includes("text/html") ? await (await item.getType("text/html")).text() : null;
    }, c.html);
    test.info().annotations.push({ type: "external-html", description: JSON.stringify({ case: c.label, readBack }) });
    await page.keyboard.press("ControlOrMeta+v");
    for (const t of c.texts) await expect(editor).toContainText(t, { timeout: 10_000 });
    await expect(editor.locator(ROW), `${c.label}：不得成列`).toHaveCount(0);
    expect(await docShape(page)).not.toContain("ROW[");
  }
  expectNoPageErrors(errors);
});
