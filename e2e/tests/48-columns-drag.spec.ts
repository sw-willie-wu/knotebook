import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, noteIdFromUrl, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * 並排的拖曳：⋮⋮ 拖到 block 左右緣建列、加欄，拖曳中的直線提示，自動等高，溝裡的檔案拖放，拖放中 ⋮⋮ 不吃指標；
 * 欄間分隔線調寬（滑鼠、鍵盤）、欄內圖片拉寬時擠壓其他欄，分隔線與 ⋮⋮、選單、表格延伸鈕的命中關係。真滑鼠、1440×900。
 *
 * - 內容一律貼 markdown（純文字剪貼簿 → `collab/paste.ts` 接手，同 34-columns）；文件形狀讀主編輯器的 ProseMirror 文件（`docShape`，
 *   格式 `paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z`，`paragraph` 無文字＝空段落）。
 * - 拖曳照 34 `dragBlockBelow` 的分段移動（按下、小移一段、15 步移到終點、再微動一下才放開）。直線提示是 core DropCursor 畫的
 *   `.prosemirror-dropcursor-vertical` 元素（左／右緣各帶 `prosemirror-dropcursor-block-vertical-left|right`）。
 * - 量幾何只比相對值（欄與列、圖與圖、提示線與 block）：headless 的 overlay 捲軸會讓絕對值偏。
 * - 每案收 `pageerror`，案尾斷言沒有（`ResizeObserver loop` 是瀏覽器已知的良性訊息，排除）。
 * - 量到、但還不能斷言對錯的行為寫進 `test.info().annotations`（type 說明量的是什麼）。R 開頭的案是真瀏覽器的量測：
 *   結果固定的部分一律斷言；溝裡提示線與落點的對照（R2）因 Chromium 在溝裡的 `posAtCoords` 不穩定，只記錄。
 */

const RUN = Date.now();
const ROW = '[data-node-type="columnList"]';
/** 欄間的溝（`collab/columns/layout.ts` 的 COLUMN_GAP_PX；e2e 不能 import web，兩邊要一起改）。 */
const COLUMN_GAP_PX = 24;
const VERTICAL = ".prosemirror-dropcursor-vertical";
const ANY_CURSOR = ".prosemirror-dropcursor-vertical, .prosemirror-dropcursor-block, .prosemirror-dropcursor-inline";

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
  await createNote(page, `E2E columns drag ${label} ${RUN}`);
  return errors;
}

/** 正規形的一列（各欄 `flex:1`）。 */
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

function originOf(page: Page): string {
  return new URL(page.url()).origin;
}

/** 在筆記最後貼上 markdown（Ctrl+End 後等 ProseMirror 跟上再貼）。 */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: originOf(page) });
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

/** 文字恰為 `text` 的區塊外層（巢狀時取最內層）。 */
function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

/** 裝著 `url` 那張圖的區塊外層。 */
function imageOuter(page: Page, url: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(`img[src*="${url}"]`) })
    .last();
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

/** 灰色 RGB PNG（同 34-columns）。 */
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

/** 走 API 真上傳一張 PNG 到目前這篇，回傳 `/api/uploads/…` 網址。 */
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

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/**
 * hover `block`，等側邊選單移到它旁邊才回傳兩者的框：垂直範圍重疊，且選單中心在該塊左緣往左 100px 內
 * （同一列的另一欄 y 相同，只看垂直分不出是哪一欄的選單）。貼上時的點擊會讓選單先停在別塊，不等就會拖到錯的那塊。
 */
async function hoverForSideMenu(page: Page, block: Locator, label: string): Promise<{ menu: Rect; block: Rect }> {
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  let got: { menu: Rect; block: Rect } | undefined;
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${label}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }, JSON.stringify({ menu, block: box })).toEqual({ overlap: true, nearLeft: true });
    got = { menu: menu!, block: box! };
  }).toPass({ timeout: 5_000 });
  return got!;
}

/** 從目前的滑鼠位置 `from` 以 `steps` 步直線移到 `to`（同 Playwright `mouse.move` 的 `steps` 內插），每一步之後呼叫 `after`。 */
async function moveInSteps(page: Page, from: Point, to: Point, steps: number, after?: (p: Point) => Promise<void>): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await page.mouse.move(p.x, p.y);
    await after?.(p);
  }
}

/**
 * 按住 `source` 的 ⋮⋮，照 `dragBlockBelow` 的分段移到 `end`（最後再往下微動 1px），在放開前呼叫 `beforeUp`。
 * `end` 給函式時拿到 ⋮⋮ 中心（直直往下拖要用它的 x）；`nudge` 是按下後第一小段的位移（預設右下各 10px）。
 * `steps` 是移到終點那一段的步數（預設 15）。`watch` 在每一段 `mouse.move` 之後被呼叫（P3 用來檢查全程沒有直線提示）。
 */
async function dragHandleTo(
  page: Page,
  source: Locator,
  label: string,
  end: Point | ((handle: Point) => Point),
  opts: { nudge?: Point; steps?: number; watch?: (p: Point) => Promise<void>; beforeUp?: () => Promise<void> } = {},
): Promise<void> {
  await hoverForSideMenu(page, source, label);
  const h = (await page.getByRole("button", { name: "Open block menu" }).boundingBox())!;
  const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  if (typeof end === "function") end = end(start);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const nudge = { x: start.x + (opts.nudge?.x ?? 10), y: start.y + (opts.nudge?.y ?? 10) };
  await moveInSteps(page, start, nudge, 5, opts.watch);
  await moveInSteps(page, nudge, end, opts.steps ?? 15, opts.watch);
  await moveInSteps(page, end, { x: end.x, y: end.y + 1 }, 1, opts.watch);
  await opts.beforeUp?.();
  await page.mouse.up();
}

/** 把 `sourceText` 那個 block 的 ⋮⋮ 拖到 `targetText` 那段的下半部放開（core 預設拖放，同 34 `dragBlockBelow`）。 */
async function dragBlockBelow(page: Page, sourceText: string, targetText: string, watch?: (p: Point) => Promise<void>): Promise<void> {
  const t = (await blockOuter(page, targetText).boundingBox())!;
  await dragHandleTo(page, blockOuter(page, sourceText), sourceText, { x: t.x + t.width / 2, y: t.y + t.height * 0.75 }, { watch });
}

/**
 * ⋮⋮ 拖到 `target` 的左／右緣：終點 x＝右緣往內 8px 或左緣往內 8px、y＝框的中線。放開前斷言直線提示：
 * `expectVertical`（預設 true）→ 該側的直線看得見；false → 沒有任何直線。
 */
async function dragToEdge(page: Page, source: Locator, sourceLabel: string, target: Locator, side: "left" | "right", opts: { expectVertical?: boolean } = {}): Promise<void> {
  const box = (await target.boundingBox())!;
  const end = { x: side === "right" ? box.x + box.width - 8 : box.x + 8, y: box.y + box.height / 2 };
  await dragHandleTo(page, source, sourceLabel, end, {
    beforeUp: async () => {
      if (opts.expectVertical ?? true) await expect(page.locator(`${VERTICAL}.prosemirror-dropcursor-block-vertical-${side}`)).toBeVisible();
      else await expect(page.locator(VERTICAL)).toHaveCount(0);
    },
  });
}

async function dragBlockToEdge(page: Page, sourceText: string, targetText: string, side: "left" | "right", opts?: { expectVertical?: boolean }): Promise<void> {
  await dragToEdge(page, blockOuter(page, sourceText), sourceText, blockOuter(page, targetText), side, opts);
}

/** 主編輯器的列（第 `index` 個）每一欄的框與列框。 */
async function rowGeometry(page: Page, index = 0): Promise<{ row: Rect; cols: Rect[] }> {
  return editorLocator(page)
    .locator(ROW)
    .nth(index)
    .evaluate((el) => {
      const r = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      return { row: r(el), cols: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map(r) };
    });
}

/** 畫面上的拖放提示（core DropCursor 的元素）：class 與框；沒有 → null。 */
async function dropCursorState(page: Page): Promise<{ classes: string; rect: Rect } | null> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { classes: el.className, rect: { x: b.x, y: b.y, width: b.width, height: b.height } };
  }, ANY_CURSOR);
}

/** `view.posAtCoords` 的結果與該位置的父節點型別（量 Chromium 在某點把座標對到文件的哪裡）。 */
async function posInfo(page: Page, p: Point): Promise<{ pos: number; inside: number; parent: string; path: string[] } | null> {
  return editorLocator(page).evaluate((el, pt) => {
    type Resolved = { depth: number; node(d: number): { type: { name: string } }; parent: { type: { name: string } } };
    type View = { posAtCoords(c: { left: number; top: number }): { pos: number; inside: number } | null; state: { doc: { resolve(p: number): Resolved } } };
    const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
    const hit = view.posAtCoords({ left: pt.x, top: pt.y });
    if (!hit) return null;
    const $pos = view.state.doc.resolve(hit.pos);
    return { pos: hit.pos, inside: hit.inside, parent: $pos.parent.type.name, path: Array.from({ length: $pos.depth + 1 }, (_, d) => $pos.node(d).type.name) };
  }, p);
}

/** 元素在 `p` 的命中結果：標籤與 class、在不在 `view.dom` 內。 */
async function hitAt(page: Page, p: Point): Promise<{ tag: string; inEditor: boolean }> {
  return editorLocator(page).evaluate((root, pt) => {
    const el = document.elementFromPoint(pt.x, pt.y);
    return { tag: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "none", inEditor: !!el && root.contains(el) };
  }, p);
}

/**
 * 放下前一刻 `posAtCoords` 落在哪：父節點型別、所在欄的序號（不在欄裡 → null）、包住它的直接子 block 的 id，
 * 以及父節點是欄時它前後的 block id。
 */
type DropPos = { pos: number; parent: string; column: number | null; block: string | null; before: string | null; after: string | null } | null;

/**
 * 頁內建只帶一個 PNG 檔的 `DataTransfer`（不經 dragstart，如同作業系統拖進來），在 `p` 的命中元素上依序 dispatch
 * dragenter → 重新取命中元素、記下 `posAtCoords` → dragover → drop。回傳每一步命中的元素、放下前的 `posAtCoords`，
 * 與 dragover／drop 是否被 `preventDefault`。
 */
async function dropFileAt(
  page: Page,
  p: Point,
  png: Buffer,
): Promise<{ first: string; afterEnter: string; afterEnterInEditor: boolean; pos: DropPos; overPrevented: boolean; dropPrevented: boolean }> {
  return editorLocator(page).evaluate(
    (root, { pt, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "gutter.png", { type: "image/png" }));
      const describe = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "none");
      const fire = (el: Element, type: string) => {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const first = document.elementFromPoint(pt.x, pt.y)!;
      fire(first, "dragenter");
      const target = document.elementFromPoint(pt.x, pt.y)!;
      type Node = { type: { name: string }; attrs: { id?: unknown } } | null;
      type Resolved = { depth: number; parent: Node; nodeBefore: Node; nodeAfter: Node; node(d: number): Node; index(d: number): number };
      type View = { posAtCoords(c: { left: number; top: number }): { pos: number } | null; state: { doc: { resolve(p: number): Resolved } } };
      const view = (root as Element & { editor?: { view?: View } }).editor!.view!;
      let pos = null as { pos: number; parent: string; column: number | null; block: string | null; before: string | null; after: string | null } | null;
      // 在編輯器父元素的 capture 階段量，也就是產品的 drop handler（掛在 `view.dom`）之前一刻：document capture 的 drop 已經清掉
      // `kb-dragging`（⋮⋮ 等浮層又吃指標），core SideMenu 也已經改過選取，`posAtCoords` 量到的才與產品同一個狀態。在 dragover
      // 之前或 window capture 量都不準：Chromium 在溝裡的 `posAtCoords` 會跟著浮層與版面變。
      const capture = () => {
        const hit = view.posAtCoords({ left: pt.x, top: pt.y });
        if (!hit) return;
        const $pos = view.state.doc.resolve(hit.pos);
        const idOf = (n: Node) => (n && typeof n.attrs.id === "string" ? n.attrs.id : null);
        let column: number | null = null;
        let block: string | null = null;
        for (let d = $pos.depth; d > 0; d--) {
          if ($pos.node(d)!.type.name !== "column") continue;
          column = $pos.index(d - 1);
          block = d < $pos.depth ? idOf($pos.node(d + 1)) : null;
          break;
        }
        const columnLevel = $pos.parent!.type.name === "column";
        pos = {
          pos: hit.pos,
          parent: $pos.parent!.type.name,
          column,
          block,
          before: columnLevel ? idOf($pos.nodeBefore) : null,
          after: columnLevel ? idOf($pos.nodeAfter) : null,
        };
      };
      root.parentElement!.addEventListener("drop", capture, { capture: true, once: true });
      const overPrevented = fire(target, "dragover");
      const dropPrevented = fire(target, "drop");
      return { first: describe(first), afterEnter: describe(target), afterEnterInEditor: root.contains(target), pos, overPrevented, dropPrevented };
    },
    { pt: p, b64: png.toString("base64") },
  );
}

/** 依「先比水平距離、相同再比垂直距離、完全相同取前面」找 `p` 最近的欄（溝裡的檔案拖放以這個規則改到最近的欄）。 */
function nearestColumn(cols: Rect[], p: Point): number {
  const dist = (v: number, from: number, to: number) => (v < from ? from - v : v > to ? v - to : 0);
  let best = -1;
  let bestD: [number, number] = [Infinity, Infinity];
  cols.forEach((c, i) => {
    const d: [number, number] = [dist(p.x, c.x, c.x + c.width), dist(p.y, c.y, c.y + c.height)];
    if (d[0] < bestD[0] || (d[0] === bestD[0] && d[1] < bestD[1])) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * 放下時 `posAtCoords` 的父節點是列（落在兩欄之間）→ 溝裡改座標的規則選的欄：先比水平距離、再比垂直距離、完全相同取前面。
 * 水平距離相差在 0.5px 內（指標幾乎在溝的正中央）時兩欄都算對：浮點的欄框差一點就換邊。
 * 否則 → `posAtCoords` 所在的那一欄（core 照它插入、不改座標）。
 */
function expectedColumns(cols: Rect[], p: Point, pos: NonNullable<DropPos>): number[] {
  if (pos.parent !== "columnList") return pos.column === null ? [] : [pos.column];
  const dx = cols.map((c) => (p.x < c.x ? c.x - p.x : p.x > c.x + c.width ? p.x - c.x - c.width : 0));
  const min = Math.min(...dx);
  const near = dx.flatMap((d, i) => (d - min <= 0.5 ? [i] : []));
  return near.length > 1 ? near : [nearestColumn(cols, p)];
}

/** 同一欄裡，垂直距離最近的直接子 block（溝裡改座標的規則；相同取前面）。 */
function nearestBlockByY(blocks: Array<{ id: string; rect: Rect }>, y: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const b of blocks) {
    const d = y < b.rect.y ? b.rect.y - y : y > b.rect.y + b.rect.height ? y - b.rect.y - b.rect.height : 0;
    if (!best || d < best.d) best = { id: b.id, d };
  }
  return best?.id ?? null;
}

/** `ROW[COL(…) | COL(…)]` 裡每一欄的內容字串（只看文件裡第一個列）。 */
function columnsOf(shape: string): string[] {
  const m = /ROW\[(.*?)\](?=\s{2}|$)/.exec(shape);
  return m ? m[1]!.split(" | ") : [];
}

test("P1 x y z 拖 z 到 x 右緣 → 兩欄 [x｜z]；左緣 → [z｜x]；Ctrl+Z 一次還原 [sc:columnsDragBeside]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p1");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");

  await dragBlockToEdge(page, "z", "x", "right");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y");
  await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:y  paragraph:z");
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);

  await dragBlockToEdge(page, "z", "x", "left");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph:y");
  await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:y  paragraph:z");
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);
  expectNoPageErrors(errors);
});

test("P2 [a｜b] 外的 z 拖到 b 右緣 → 三欄；4 欄的列拖到第 1 欄右緣 → 沒有直線、結果同橫線放置", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p2");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await dragBlockToEdge(page, "z", "b", "right");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:z)]");
  expect(await docShape(page)).not.toContain("paragraph:z  ");

  // 4 欄：先拖到第 1 欄右緣（不出直線），再在另一篇同內容的筆記做同目標的橫線放置，兩邊結果相同。
  const four = rowDoc(["a", "b", "c", "d"]);
  const fourShape = "ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]";
  await createNote(page, `E2E columns drag p2-four ${RUN}`);
  await pasteMarkdown(page, four);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(fourShape);
  await dragBlockToEdge(page, "z", "a", "right", { expectVertical: false });
  await expect.poll(() => docShape(page)).not.toContain(`${fourShape}  paragraph:z`);
  const edgeResult = await docShape(page);

  await createNote(page, `E2E columns drag p2-control ${RUN}`);
  await pasteMarkdown(page, four);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(fourShape);
  await dragBlockBelow(page, "z", "a");
  await expect.poll(() => docShape(page)).toBe(edgeResult);
  expect(columnsOf(edgeResult)).toHaveLength(4);
  expectNoPageErrors(errors);
});

test("P3 排序不誤觸：同一欄內與頂層各一次 ⋮⋮ 往下拖，指標在 block 框外與溝裡時沒有直線提示、結果是橫線排序", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "p3");
  /** `updated`：這一點有收到 dragover（DropCursor 依它重畫）；沒有的話畫面上的提示是上一點留下的，不拿來判斷這一點。 */
  type Step = { at: Point; vertical: number; updated: boolean };
  let seen: Step[] = [];
  // 拖曳中的 dragover 比 `mouse.move` 晚到，所以每一步先等這一點的 dragover 再讀提示：document 冒泡階段記下每一筆非合成的
  // dragover（DropCursor 掛在 `view.dom`，冒泡到 document 時已經畫好；core SideMenu 夾進框內的合成事件不算）。DragEvent 的座標是
  // 捨去小數的整數，所以比對 `Math.floor`。換到新元素的那一步 Chromium 只送 dragenter、不送 dragover，等不到就記成沒更新。
  const installDragoverProbe = () =>
    page.evaluate(() => {
      const w = window as unknown as { kbOvers?: string[]; kbOversOn?: boolean };
      w.kbOvers = [];
      if (w.kbOversOn) return;
      w.kbOversOn = true;
      document.addEventListener("dragover", (e) => {
        if ((e as DragEvent & { synthetic?: boolean }).synthetic) return;
        w.kbOvers!.push(`${e.clientX},${e.clientY}`);
      });
    });
  const watch = async (at: Point) => {
    const key = `${Math.floor(at.x)},${Math.floor(at.y)}`;
    const updated = await page
      .waitForFunction((k) => ((window as unknown as { kbOvers?: string[] }).kbOvers ?? []).includes(k), key, { timeout: 1_000 })
      .then(
        () => true,
        () => false,
      );
    seen.push({ at, vertical: await page.locator(VERTICAL).count(), updated });
    await page.evaluate(() => void ((window as unknown as { kbOvers?: string[] }).kbOvers = []));
  };
  /** 每一步落在哪：第 1 欄框外（左邊）、溝、某欄的左右緣區、欄內其他地方。 */
  const regionOf = (cols: Rect[], p: Point): "outside" | "gutter" | "edge-zone" | "inner" => {
    if (p.x < cols[0]!.x) return "outside";
    const col = cols.find((c) => p.x >= c.x && p.x <= c.x + c.width);
    if (!col) return "gutter";
    const zone = Math.min(64, Math.max(24, 0.2 * col.width));
    return p.x < col.x + zone || p.x > col.x + col.width - zone ? "edge-zone" : "inner";
  };
  const report: Record<string, unknown> = {};

  // 第 1 欄內：[a,q｜b] 把 a 拖到 q 下方。⋮⋮ 在列的左邊（框外）。
  await pasteMarkdown(page, rowDoc(["a\n\nq", "b"]));
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:q) | COL(paragraph:b)]");
  let { cols } = await rowGeometry(page);
  // 欄內的 ⋮⋮ 只有 16px 寬、右緣貼著第 1 欄左緣：按下後先往左下移，前幾步才在框外。
  const q = (await blockOuter(page, "q").boundingBox())!;
  await dragHandleTo(page, blockOuter(page, "a"), "a", { x: q.x + q.width / 2, y: q.y + q.height * 0.75 }, { nudge: { x: -10, y: 10 }, watch });
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:q,paragraph:a) | COL(paragraph:b)]  paragraph:z");
  expect(seen.length).toBe(21);
  let tagged = seen.filter((s) => s.updated).map((s) => ({ ...s, region: regionOf(cols, s.at) }));
  expect(tagged.filter((s) => s.region === "outside").length, "前提：框外有收到 dragover 的點").toBeGreaterThan(0);
  expect(tagged.filter((s) => s.vertical > 0 && (s.region === "outside" || s.region === "inner")), "框外或欄中央出現直線").toEqual([]);
  expect(seen.at(-1)!.updated, "放開的那一點收到 dragover").toBe(true);
  expect(seen.at(-1)!.vertical, "放開的那一點沒有直線").toBe(0);
  report.column1 = { cols, withVertical: tagged.filter((s) => s.vertical > 0), notUpdated: seen.filter((s) => !s.updated).map((s) => s.at) };

  // 第 2 欄內：[b｜a,q] 把 a 拖到 q 下方。⋮⋮ 在溝裡。
  seen = [];
  await createNote(page, `E2E columns drag p3-col2 ${RUN}`);
  await pasteMarkdown(page, rowDoc(["b", "a\n\nq"]));
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:b) | COL(paragraph:a,paragraph:q)]");
  ({ cols } = await rowGeometry(page));
  // ⋮⋮ 在溝的右側 16px：同樣先往左下移，前幾步才在溝裡。
  const q2 = (await blockOuter(page, "q").boundingBox())!;
  await dragHandleTo(page, blockOuter(page, "a"), "a", { x: q2.x + q2.width / 2, y: q2.y + q2.height * 0.75 }, { nudge: { x: -10, y: 10 }, watch });
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q,paragraph:a)]  paragraph:z");
  expect(seen.length).toBe(21);
  tagged = seen.filter((s) => s.updated).map((s) => ({ ...s, region: regionOf(cols, s.at) }));
  expect(tagged.filter((s) => s.region === "gutter").length, "前提：溝裡有收到 dragover 的點").toBeGreaterThan(0);
  expect(tagged.filter((s) => s.vertical > 0 && (s.region === "gutter" || s.region === "inner")), "溝裡或欄中央出現直線").toEqual([]);
  expect(seen.at(-1)!.updated, "放開的那一點收到 dragover").toBe(true);
  expect(seen.at(-1)!.vertical, "放開的那一點沒有直線").toBe(0);
  report.column2 = { cols, withVertical: tagged.filter((s) => s.vertical > 0), notUpdated: seen.filter((s) => !s.updated).map((s) => s.at) };

  // 頂層：x y z 把 x 拖到 z 下方。穿過左緣區的那幾步都還在 x 自己上面，全程沒有直線。
  seen = [];
  await createNote(page, `E2E columns drag p3-top ${RUN}`);
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await dragBlockBelow(page, "x", "z", watch);
  await expect.poll(() => docShape(page)).toContain("paragraph:y  paragraph:z  paragraph:x");
  expect(seen.length).toBe(21);
  expect(seen.filter((s) => s.updated).length, "前提：有收到 dragover 的點").toBeGreaterThan(10);
  expect(seen.filter((s) => s.updated && s.vertical > 0), "頂層排序途中出現直線").toEqual([]);
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);

  // 欄內排序時，從欄外的 ⋮⋮ 斜著拖到中央會穿過目標欄的左緣區（框內）：那幾步照判準出直線，放開在中央時照樣是橫線排序。
  test.info().annotations.push({ type: "in-column-sort-path-crosses-edge-zone", description: JSON.stringify(report) });
  expectNoPageErrors(errors);
});

test("P4 [a｜b] 拖 b 到列外 z 的右緣 → 新列 [z｜b]、原列 [a｜空]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p4");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await dragBlockToEdge(page, "b", "z", "right");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph:z) | COL(paragraph:b)]");
  expectNoPageErrors(errors);
});

/** 列裡每張 `<img>` 的高度與寬度，以及列寬、各欄寬。 */
async function imageRowMetrics(page: Page): Promise<{ heights: number[]; widths: number[]; rowWidth: number; colWidths: number[] }> {
  return editorLocator(page)
    .locator(ROW)
    .first()
    .evaluate((row) => {
      const cols = Array.from(row.querySelectorAll<HTMLElement>(':scope > [data-node-type="column"]'));
      const imgs = cols.map((c) => c.querySelector("img")!.getBoundingClientRect());
      return {
        heights: imgs.map((r) => r.height),
        widths: imgs.map((r) => r.width),
        rowWidth: row.getBoundingClientRect().width,
        colWidths: cols.map((c) => c.getBoundingClientRect().width),
      };
    });
}

/** 列裡各圖高度差 ≤ 2px、各欄寬總和＋溝＝列寬（±1px）；回傳量到的值。 */
async function expectEqualHeights(page: Page, n: number, opts: { skip?: number } = {}): Promise<Awaited<ReturnType<typeof imageRowMetrics>>> {
  let m: Awaited<ReturnType<typeof imageRowMetrics>> | undefined;
  await expect(async () => {
    m = await imageRowMetrics(page);
    expect(m.heights).toHaveLength(n);
    const others = m.heights.filter((_, i) => i !== opts.skip);
    expect(Math.max(...others) - Math.min(...others), JSON.stringify(m)).toBeLessThanOrEqual(2);
    const sum = m.colWidths.reduce((a, b) => a + b, 0) + COLUMN_GAP_PX * (n - 1);
    expect(Math.abs(sum - m.rowWidth), JSON.stringify(m)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });
  return m!;
}

test("P5 自動等高：400×200 與 200×200 建列、再加 300×300 → 各圖高度差 ≤ 2px、欄寬總和＋溝＝列寬；加一張 80×80 小圖 → 小圖寬 80、其他等高", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "p5");
  const record: Record<string, unknown> = {};
  try {
    const [u1, u2, u3] = [await uploadPng(page, 400, 200), await uploadPng(page, 200, 200), await uploadPng(page, 300, 300)];
    await pasteMarkdown(page, `![a](${u1})\n\n![b](${u2})\n\n![c](${u3})\n`);
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  image  image");
    for (const u of [u1, u2, u3]) await waitImageLoaded(editorLocator(page).locator(`img[src*="${u}"]`));

    await dragToEdge(page, imageOuter(page, u2), "200×200", imageOuter(page, u1), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image)]  image");
    record.two = await expectEqualHeights(page, 2);

    await dragToEdge(page, imageOuter(page, u3), "300×300", imageOuter(page, u2), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image) | COL(image)]");
    record.three = await expectEqualHeights(page, 3);

    await createNote(page, `E2E columns drag p5-small ${RUN}`);
    const [s1, s2, s3] = [await uploadPng(page, 400, 200), await uploadPng(page, 200, 200), await uploadPng(page, 80, 80)];
    await pasteMarkdown(page, `![a](${s1})\n\n![b](${s2})\n\n![s](${s3})\n`);
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  image  image");
    for (const u of [s1, s2, s3]) await waitImageLoaded(editorLocator(page).locator(`img[src*="${u}"]`));
    await dragToEdge(page, imageOuter(page, s2), "200×200", imageOuter(page, s1), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image)]  image");
    await dragToEdge(page, imageOuter(page, s3), "80×80", imageOuter(page, s2), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image) | COL(image)]");
    const small = await expectEqualHeights(page, 3, { skip: 2 });
    record.small = small;
    expect(Math.abs(small.widths[2]! - 80), JSON.stringify(small)).toBeLessThanOrEqual(0.5);
  } finally {
    const spread = (m: unknown, skip?: number) => {
      const h = (m as { heights?: number[] } | undefined)?.heights?.filter((_, i) => i !== skip);
      return h && h.length ? Math.max(...h) - Math.min(...h) : null;
    };
    const v = { ...record, heightSpread: { two: spread(record.two), three: spread(record.three), small: spread(record.small, 2) } };
    test.info().annotations.push({ type: "equal-height-measurements", description: JSON.stringify(v) });
    console.log("P5=" + JSON.stringify(v));
  }
  expectNoPageErrors(errors);
});

test("P10 溝裡的檔案（⋮⋮ 顯示中）：⋮⋮ 中心命中 ⋮⋮，dragenter 之後同一點命中編輯器、dragover 被接受，放下 → 圖片進最近的欄、網址不變", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p10");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  const url = page.url();
  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  const handle = page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const center = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  const onHandle = await handle.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), center);
  expect(onHandle, "前提：⋮⋮ 中心命中的是 ⋮⋮").toBe(true);

  const { cols } = await rowGeometry(page);
  const result = await dropFileAt(page, center, grayPng(40, 40));
  expect(result.pos, "放下前 posAtCoords 有結果").not.toBeNull();
  const expected = expectedColumns(cols, center, result.pos!);
  test.info().annotations.push({ type: "gutter-file-drop-on-handle", description: JSON.stringify({ center, cols, expected, result }) });
  expect(expected.length, `預期的欄 ${JSON.stringify(result.pos)}`).toBeGreaterThan(0);
  expect(result.afterEnterInEditor, `dragenter 之後命中 ${result.afterEnter}`).toBe(true);
  expect(result.overPrevented, "dragover 被接受").toBe(true);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toMatch(/ROW\[COL\([^)]*image[^)]*\) \| COL\(paragraph:b\)\]|ROW\[COL\(paragraph:a\) \| COL\([^)]*image[^)]*\)\]/);
  const columns = columnsOf(await docShape(page));
  expect(expected, `圖片所在的欄 ${JSON.stringify(columns)}`).toContain(columns.findIndex((c) => c.includes("image")));
  expect(page.url()).toBe(url);
  expectNoPageErrors(errors);
});

test("S6 拖放中 ⋮⋮ 不吃指標：對 document 的 dragenter（沒有 dragstart）→ 欄上掛 kb-dragging，⋮⋮、選單、外包層、popover 各自 pointer-events:none；drop、dragend、pointermove 清掉，dragleave 不清，dragover 補回", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "s6");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  await expect(page.locator("[data-kb-column-side-menu]")).toBeVisible();

  /** 每個實際命中層各自的 computed pointer-events；掛 class 的元素數、它包不包住編輯器。 */
  const state = () =>
    page.evaluate(() => {
      const wrapper = document.querySelector("[data-kb-column-side-menu]");
      const pick = {
        button: wrapper?.querySelector("button") ?? null,
        sideMenu: wrapper?.querySelector(".bn-side-menu") ?? null,
        wrapper,
        popover: wrapper?.closest("[data-kb-side-menu-popover]") ?? null,
      };
      const pe = Object.fromEntries(Object.entries(pick).map(([k, el]) => [k, el ? getComputedStyle(el).pointerEvents : "missing"]));
      const marked = Array.from(document.querySelectorAll(".kb-dragging"));
      const editor = document.querySelector('[data-testid="note-editor"]');
      return { pe, marked: marked.length, wrapsEditor: marked.length === 1 && !!editor && marked[0]!.contains(editor) };
    });
  const fire = (type: string) =>
    page.evaluate((t) => {
      const e = t.startsWith("drag") || t === "drop" ? new DragEvent(t, { bubbles: true, cancelable: true }) : new Event(t, { bubbles: true });
      document.dispatchEvent(e);
    }, type);
  const NONE = { button: "none", sideMenu: "none", wrapper: "none", popover: "none" };

  const before = await state();
  expect(before.marked).toBe(0);
  for (const [k, v] of Object.entries(before.pe)) expect(v, `拖放前 ${k}`).not.toMatch(/^(none|missing)$/);

  await fire("dragenter");
  const during = await state();
  expect(during).toEqual({ pe: NONE, marked: 1, wrapsEditor: true });
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })));
  expect((await state()).marked, "dragleave 不清").toBe(1);
  await fire("drop");
  expect((await state()).marked, "drop 清掉").toBe(0);

  await fire("dragenter");
  expect((await state()).marked).toBe(1);
  await fire("dragend");
  expect((await state()).marked, "dragend 清掉").toBe(0);

  await fire("dragenter");
  expect((await state()).marked).toBe(1);
  const h = (await page.locator("[data-kb-column-side-menu]").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 1);
  await expect.poll(async () => (await state()).marked, { message: "pointermove 清掉" }).toBe(0);
  await fire("dragover");
  expect((await state()).marked, "dragover 補回").toBe(1);
  await fire("dragend");
  expect((await state()).marked).toBe(0);
  expectNoPageErrors(errors);
});

test("S6b 拖放中，檔案面板（floating-ui portal 裡）的 file input 仍是指標命中的元素：外部檔案可以直接拖進去", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "s6b");
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await editor.pressSequentially("/image");
  await page.getByText("Resizable image with caption").click();
  await page.getByText("Add image", { exact: true }).click();
  const input = page.getByLabel("Choose an image file to upload");
  await expect(input).toBeVisible();
  const box = (await input.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hitsInput = () => input.evaluate((el, pt) => el === document.elementFromPoint(pt.x, pt.y), center);
  expect(await hitsInput(), "前提：拖放前命中 file input").toBe(true);
  const portal = await input.evaluate((el) => !!el.closest("[data-floating-ui-portal]"));
  expect(portal, "前提：檔案面板在 floating-ui portal 裡").toBe(true);

  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true })));
  await expect(page.locator(".kb-dragging")).toHaveCount(1);
  expect(await hitsInput(), "拖放中仍命中 file input").toBe(true);
  expect(await input.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragend", { bubbles: true })));
  await expect(page.locator(".kb-dragging")).toHaveCount(0);
  expectNoPageErrors(errors);
});

// ─── 真瀏覽器量測：jsdom 定不了的幾個點 ───────────────────────────────────────────────────

/** 在 document 上（capture）數拖放事件，看一次手勢是否真的開始拖放、有幾筆 dragover。重複呼叫會歸零。 */
async function resetDragLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { kbDragLog?: Record<string, number>; kbDragLogOn?: boolean };
    w.kbDragLog = {};
    if (w.kbDragLogOn) return;
    w.kbDragLogOn = true;
    for (const type of ["dragstart", "dragover", "drop", "dragend"]) {
      document.addEventListener(type, () => void (w.kbDragLog![type] = (w.kbDragLog![type] ?? 0) + 1), true);
    }
  });
}

const dragLog = (page: Page) => page.evaluate(() => (window as unknown as { kbDragLog?: Record<string, number> }).kbDragLog ?? {});

/** ⋮⋮ 拖 `source` 到 `p`，放開前記下提示線；回傳量到的值。放下後文件與 `original` 不同就點回編輯器、Ctrl+Z 還原。 */
async function probeDrop(page: Page, sourceText: string, p: Point, original: string, undoAnchor: string): Promise<Record<string, unknown>> {
  await resetDragLog(page);
  const pos = await posInfo(page, p);
  let cursor: Awaited<ReturnType<typeof dropCursorState>> = null;
  let hit: Awaited<ReturnType<typeof hitAt>> | null = null;
  await dragHandleTo(page, blockOuter(page, sourceText), sourceText, p, {
    beforeUp: async () => {
      cursor = await dropCursorState(page);
      hit = await hitAt(page, p);
    },
  });
  // R1、R2、R4 的每一點都會改文件：等它變了再量。
  await expect.poll(() => docShape(page), { message: "放下後文件有變" }).not.toBe(original);
  const after = await docShape(page);
  const landed = await blockOuter(page, sourceText).boundingBox();
  const out = { p, pos, hitDuringDrag: hit, cursor, events: await dragLog(page), after, landed };
  if (after !== original) {
    await clickEndOfParagraph(page, blockOuter(page, undoAnchor).locator(".bn-inline-content").first());
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(original);
  }
  return out;
}

// R1：最後一個 block 下方，`posAtCoords` 落在文件結尾（父節點是頂層 blockGroup，找不到合格的 Y）或根本不在 `view.dom` 內
// （core SideMenu 改發夾進框內的合成事件，直線判斷不收合成事件），所以 x 在右緣區也只出橫線、放下是橫線放置。
test("R1 最後一個 block 下方、x 在右緣區：只出橫線、放下不建列，x 移到文件結尾", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r1");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    const last = editorLocator(page).locator(":scope > .bn-block-group > .bn-block-outer").last();
    for (const below of [8, 25, 40, 120]) {
      const box = (await last.boundingBox())!;
      const editorBox = (await editorLocator(page).boundingBox())!;
      const p = { x: box.x + box.width - 8, y: box.y + box.height + below };
      const before = { lastBox: box, editorBottom: editorBox.y + editorBox.height, hitBefore: await hitAt(page, p) };
      const probe = await probeDrop(page, "x", p, original, "y");
      results.push({ below, ...before, ...probe });
      const cursor = probe.cursor as { classes: string } | null;
      expect(cursor?.classes ?? "", `below ${below}: 提示線`).not.toContain("vertical");
      expect(probe.after, `below ${below}: 放下的結果`).toContain("paragraph:y  paragraph:z  paragraph:x");
      expect(probe.after).not.toContain("ROW[");
    }
  } finally {
    test.info().annotations.push({ type: "below-last-block-edge-zone", description: JSON.stringify(results) });
    console.log("R1=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R2：⋮⋮ 拖到溝裡。拖曳中的提示線由 DropCursor 依 `posAtCoords`＋`dropPoint` 畫；放下時落點的父節點是列的話，會先改到最近欄的
// 最近 block 再放。兩者可能不同（提示線畫在列下方、block 卻進了某一欄），而且 Chromium 在溝裡的 `posAtCoords` 同一點也會時而
// 落進某欄、時而落在兩欄之間，落點跟著變。斷言固定的部分：每一點都有 drop、z 一定進到列裡的某一欄（不留在列外）、沒有 pageerror。
// 提示線與落點的對照只記錄：每一點的 `posAtCoords`、放開前的提示線、放下後的文件與 block 的框。
test("R2 ⋮⋮ 拖到溝裡：每一點都放得下、z 進到列裡的某一欄；記錄提示線位置與實際落點", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r2");
  await pasteMarkdown(page, rowDoc(["a\n\na2\n\na3", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:a2,paragraph:a3) | COL(paragraph:b)]");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    for (const where of ["a-level", "b-lower", "a3-level", "a3-level-near-col2"] as const) {
      const { cols } = await rowGeometry(page);
      const a = (await blockOuter(page, "a").boundingBox())!;
      const b = (await blockOuter(page, "b").boundingBox())!;
      const a3 = (await blockOuter(page, "a3").boundingBox())!;
      const col1Right = cols[0]!.x + cols[0]!.width;
      const x = where === "a3-level-near-col2" ? col1Right + COLUMN_GAP_PX - 6 : col1Right + COLUMN_GAP_PX / 2;
      const y = where === "a-level" ? a.y + a.height * 0.25 : where === "b-lower" ? b.y + b.height * 0.75 : a3.y + a3.height / 2;
      const probe = await probeDrop(page, "z", { x, y }, original, "x");
      results.push({ where, cols, ...probe });
      expect((probe.events as Record<string, number>).drop, `${where}：有 drop`).toBeGreaterThanOrEqual(1);
      const after = probe.after as string;
      expect(columnsOf(after).some((c) => c.includes("paragraph:z")), `${where}：z 在列裡 ${after}`).toBe(true);
      expect(after, `${where}：列外沒有 z`).not.toMatch(/(^|\s{2})paragraph:z(\s{2}|$)/);
    }
  } finally {
    test.info().annotations.push({ type: "gutter-guide-vs-landing", description: JSON.stringify(results) });
    console.log("R2=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

/** 列裡每一欄的直接子 block：id 與框。 */
async function rowBlocks(page: Page): Promise<Array<Array<{ id: string; rect: Rect }>>> {
  return editorLocator(page)
    .locator(ROW)
    .first()
    .evaluate((row) =>
      Array.from(row.querySelectorAll(':scope > [data-node-type="column"]')).map((col) =>
        Array.from(col.querySelectorAll(":scope > .bn-block-outer")).map((b) => {
          const r = b.getBoundingClientRect();
          return { id: b.getAttribute("data-id") ?? "", rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }),
      ),
    );
}

// R3：溝裡（欄與欄之間）放下只帶檔案的拖放。Chromium 的 `posAtCoords` 在溝裡有時落進某一欄、有時落在兩欄之間（父節點是列），
// 以放下前一刻的值決定預期：落在兩欄之間 → 改座標的規則選的欄（先比水平、再比垂直距離）裡垂直最近的 block；落進某一欄 →
// 包住 `posAtCoords` 的那個 block（或欄層級時它前後的 block）。新的圖片 block 要緊鄰預期的 block；沒有 pageerror、dragover 被接受。
test("R3 檔案拖進溝裡（沒有 ⋮⋮）：沒有 pageerror、圖片緊鄰改座標規則或 posAtCoords 指到的 block", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r3");
  await pasteMarkdown(page, rowDoc(["a\n\na2\n\na3", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:a2,paragraph:a3) | COL(paragraph:b)]");
  const results: unknown[] = [];
  try {
    // 把滑鼠移開，免得 ⋮⋮ 蓋在溝上。
    await page.mouse.move(5, 5);
    for (const where of ["center-a-level", "near-col1-a2", "near-col2-b-level", "near-col2-below-b"] as const) {
      const { cols } = await rowGeometry(page);
      const a = (await blockOuter(page, "a").boundingBox())!;
      const a2 = (await blockOuter(page, "a2").boundingBox())!;
      const a3 = (await blockOuter(page, "a3").boundingBox())!;
      const b = (await blockOuter(page, "b").boundingBox())!;
      const col1Right = cols[0]!.x + cols[0]!.width;
      const p =
        where === "center-a-level"
          ? { x: col1Right + COLUMN_GAP_PX / 2, y: a.y + a.height * 0.25 }
          : where === "near-col1-a2"
            ? { x: col1Right + 8, y: a2.y + a2.height * 0.75 }
            : where === "near-col2-b-level"
              ? { x: col1Right + COLUMN_GAP_PX - 8, y: b.y + b.height * 0.75 }
              : { x: col1Right + COLUMN_GAP_PX - 8, y: a3.y + a3.height / 2 };
      const before = await docShape(page);
      const blocks = await rowBlocks(page);
      const known = new Set(blocks.flat().map((b) => b.id));
      const hit = await hitAt(page, p);
      const result = await dropFileAt(page, p, grayPng(40, 40));
      const pos = result.pos;
      expect(pos, `${where}：放下前 posAtCoords 有結果`).not.toBeNull();
      const expectedBlocks =
        pos!.parent === "columnList"
          ? expectedColumns(cols, p, pos!).map((k) => nearestBlockByY(blocks[k] ?? [], p.y))
          : [pos!.block, pos!.before, pos!.after];
      const expected = expectedBlocks.filter((id): id is string => !!id);
      let neighbours: string[] = [];
      await expect(async () => {
        const now = await rowBlocks(page);
        const column = now.find((c) => c.some((b) => !known.has(b.id)));
        expect(column, "新的 block 在列裡").toBeDefined();
        const i = column!.findIndex((b) => !known.has(b.id));
        neighbours = [column![i - 1]?.id, column![i + 1]?.id].filter((id): id is string => !!id);
      }).toPass({ timeout: 15_000 });
      const after = await docShape(page);
      results.push({ where, p, pos, hit, expected, neighbours, result, before, after });
      expect(result.overPrevented, "dragover 被接受").toBe(true);
      expect(after.split("image").length, "多一個圖片 block").toBe(before.split("image").length + 1);
      expect(expected.length, `${where}：預期的 block ${JSON.stringify(pos)}`).toBeGreaterThan(0);
      expect(neighbours.filter((id) => expected.includes(id)), `${where}：緊鄰預期的 block`).not.toEqual([]);
    }
  } finally {
    test.info().annotations.push({ type: "gutter-file-drop", description: JSON.stringify(results) });
    console.log("R3=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R4：指標在欄的左右緣區、緊貼溝（離欄界 0–3px）。Chromium 的 `posAtCoords` 在這些點都落進該欄的段落（父節點不是列），
// 溝裡改座標那條路本來就不會走到；這裡守的是結果：每一點都有 drop、直線提示在該側、放下建新欄，沒有被改成橫線放進最近的 block。
test("R4 欄的左右緣區緊貼溝：直線提示在該側、放下建新欄 [a｜z｜b]，不被改成橫線放置", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await startNote(page, "r4");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    for (const [label, dx] of [
      ["col2-left+3", 3],
      ["col2-left+1", 1],
      ["col2-left+0", 0],
      ["col1-right-0", -0.001],
      ["col1-right-1", -1],
      ["col1-right-3", -3],
    ] as const) {
      const { cols } = await rowGeometry(page);
      const b = (await blockOuter(page, "b").boundingBox())!;
      const x = dx >= 0 ? cols[1]!.x + dx : cols[0]!.x + cols[0]!.width + Math.round(dx);
      const probe = await probeDrop(page, "z", { x, y: b.y + b.height / 2 }, original, "x");
      results.push({ label, cols, ...probe });
      expect((probe.events as Record<string, number>).drop, `${label}：有 drop`).toBeGreaterThanOrEqual(1);
      const side = dx >= 0 ? "left" : "right";
      expect((probe.cursor as { classes: string } | null)?.classes ?? "", `${label}：提示線`).toContain(`prosemirror-dropcursor-block-vertical-${side}`);
      expect(probe.after, `${label}：放下的結果`).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]");
    }
  } finally {
    test.info().annotations.push({ type: "edge-zone-next-to-gutter", description: JSON.stringify(results) });
    console.log("R4=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R5：⋮⋮ 拖曳開始時 core 會選取被拖的 block，格式工具列跟著出現在它正上方，蓋住上一個 block 的左半部。拖放中工具列（與它外面
// floating-ui 的包裝層）不吃指標，放開點命中底下的 block，drop 照常發生。前提先斷言工具列真的蓋在放開的點上。
// 工具列只在拖曳開始後的一小段時間在畫面上（量到約 25ms 後出現、再約 250ms 收起），所以這裡一步就移到終點、等它出現就放開。
test("R5 x y z 拖 z 到正上方 y 的左緣（格式工具列蓋在上面）→ 放開點命中 y、建列 [z｜y]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "r5");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await resetDragLog(page);
  const box = (await blockOuter(page, "y").boundingBox())!;
  const p = { x: box.x + 8, y: box.y + box.height / 2 };
  let during: unknown = null;
  await dragHandleTo(page, blockOuter(page, "z"), "z", p, {
    steps: 1,
    beforeUp: async () => {
      await expect(page.locator(".bn-formatting-toolbar"), "前提：拖曳中有格式工具列").toBeVisible({ timeout: 1_000 });
      during = await page.evaluate((pt) => {
        const el = document.elementFromPoint(pt.x, pt.y);
        const toolbar = document.querySelector(".bn-formatting-toolbar");
        const bar = toolbar?.getBoundingClientRect();
        // 標記要掛在 floating-ui 的包裝層（接走 drop 的那一層），不是工具列本身。
        const marked = toolbar?.closest("[data-kb-formatting-toolbar-popover]") ?? null;
        return {
          hit: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` : "none",
          onToolbar: !!el?.closest(".bn-formatting-toolbar, [data-kb-formatting-toolbar-popover]"),
          toolbar: bar ? { x: bar.x, y: bar.y, right: bar.right, bottom: bar.bottom } : null,
          markerOnFloatingWrapper: !!marked && marked !== toolbar && marked.hasAttribute("data-floating-ui-focusable"),
          markerPointerEvents: marked ? getComputedStyle(marked).pointerEvents : null,
        };
      }, p);
    },
  });
  await expect.poll(() => docShape(page), { message: "放下後建列" }).toContain("paragraph:x  ROW[COL(paragraph:z) | COL(paragraph:y)]");
  const record = { p, target: box, during, events: await dragLog(page), after: await docShape(page) };
  test.info().annotations.push({ type: "formatting-toolbar-over-drop-point", description: JSON.stringify(record) });
  const seen = during as unknown as {
    onToolbar: boolean;
    toolbar: { x: number; y: number; right: number; bottom: number } | null;
    markerOnFloatingWrapper: boolean;
    markerPointerEvents: string | null;
  };
  const bar = seen.toolbar;
  expect(bar, "前提：拖曳中有格式工具列").not.toBeNull();
  expect(seen.markerOnFloatingWrapper, "標記在 floating-ui 的包裝層上").toBe(true);
  expect(seen.markerPointerEvents, "拖放中包裝層不吃指標").toBe("none");
  expect(p.x >= bar!.x && p.x <= bar!.right && p.y >= bar!.y && p.y <= bar!.bottom, `前提：工具列蓋住放開的點 ${JSON.stringify(record)}`).toBe(true);
  expect(seen.onToolbar, "放開點不命中工具列").toBe(false);
  expect(record.events.drop, "有 drop").toBeGreaterThanOrEqual(1);
  expect(record.after).toContain("paragraph:x  ROW[COL(paragraph:z) | COL(paragraph:y)]");
  expectNoPageErrors(errors);
});

// ─── 分隔線調寬、欄內圖片擴欄 ───────────────────────────────────────────────────────────────

/** 欄間分隔線（頁面上還有側欄的 `Resize sidebar` 分隔線，所以限在浮層裡）。 */
const DIVIDER = '.kb-column-dividers [role="separator"]';

function divider(page: Page, index = 0): Locator {
  return page.locator(DIVIDER).nth(index);
}

/** 主編輯器第一個列每一欄的文件欄寬（column 節點的 `width`）。 */
async function docWidths(page: Page): Promise<number[]> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; attrs: { width?: number }; childCount: number; child(i: number): PmNode };
    type View = { state: { doc: { descendants(f: (n: PmNode) => boolean | void): void } } };
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

/** 從現在起數主編輯器 Y.Doc 的 update 事件（y-prosemirror 綁定的那份；本地交易與遠端更新都算）。重複呼叫會歸零。 */
async function resetYUpdates(page: Page): Promise<void> {
  await editorLocator(page).evaluate((el) => {
    type YDoc = { on(ev: "update", f: () => void): void };
    type Plugin = { key: string; getState(s: unknown): { doc?: YDoc } | undefined };
    const view = (el as Element & { editor?: { view?: { state: { plugins: Plugin[] } } } }).editor!.view!;
    const w = window as unknown as { kbYUpdates?: number; kbYDoc?: YDoc };
    w.kbYUpdates = 0;
    const doc = view.state.plugins.find((p) => String(p.key).startsWith("y-sync$"))!.getState(view.state)!.doc!;
    if (w.kbYDoc === doc) return;
    w.kbYDoc = doc;
    doc.on("update", () => void (w.kbYUpdates = (w.kbYUpdates ?? 0) + 1));
  });
}

const yUpdates = (page: Page) => page.evaluate(() => (window as unknown as { kbYUpdates?: number }).kbYUpdates ?? 0);

/** 拖分隔線時的旁觀狀態：body 的 user-select、拖曳中的分隔線數、預覽樣式表數。 */
async function dragState(page: Page): Promise<{ userSelect: string; dragging: number; preview: number }> {
  return page.evaluate(
    (sel) => ({
      userSelect: document.body.style.userSelect,
      dragging: document.querySelectorAll(`${sel}[data-dragging]`).length,
      preview: document.querySelectorAll("style[data-kb-col-preview]").length,
    }),
    DIVIDER,
  );
}

const IDLE = { userSelect: "", dragging: 0, preview: 0 };

/**
 * 按住第 `index` 條分隔線命中區的中心、以 10 步水平移 `dx` 再放開；放開前呼叫 `beforeUp`。按下前先在命中區上移一下：
 * 分隔線在 `pointerenter` 時重量位置，位置變了的那一下 `pointerdown` 不開始拖曳。
 */
async function dragDivider(page: Page, dx: number, opts: { index?: number; beforeUp?: () => Promise<void> } = {}): Promise<void> {
  const box = (await divider(page, opts.index).boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y - 2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await moveInSteps(page, start, { x: start.x + dx, y: start.y }, 10);
  await opts.beforeUp?.();
  await page.mouse.up();
}

type HitKind = { separator: boolean; sideMenuButton: boolean; menuItem: string | null; extend: boolean; desc: string };

/** `p` 命中的元素是哪一種：欄間分隔線、欄內 ⋮⋮ 按鈕、`/` 選單項（回它的文字）、表格「加一欄」延伸鈕；`desc` 是標籤與 class。 */
async function hitKind(page: Page, p: Point): Promise<HitKind> {
  return page.evaluate(
    ({ pt, sel }) => {
      const el = document.elementFromPoint(pt.x, pt.y);
      const item = el?.closest(".bn-suggestion-menu-item");
      const cls = el ? (el.getAttribute("class") ?? "") : "";
      return {
        separator: !!el?.closest(sel),
        sideMenuButton: !!el?.closest("[data-kb-column-side-menu] button"),
        menuItem: item ? (item.textContent ?? "").trim() : null,
        extend: !!el?.closest(".bn-extend-button-add-remove-columns"),
        desc: el ? `${el.tagName.toLowerCase()}.${cls.slice(0, 60)}` : "none",
      };
    },
    { pt: p, sel: DIVIDER },
  );
}

/** 第一個列兩欄的像素寬比例：左／(左＋右)。 */
async function leftShare(page: Page): Promise<number> {
  const { cols } = await rowGeometry(page);
  return cols[0]!.width / (cols[0]!.width + cols[1]!.width);
}

/** 帶寬度的圖片（貼上後成為 `previewWidth`）。 */
function figure(url: string, width: number): string {
  return `<figure><img alt="pic" src="${url}" width="${width}"></figure>`;
}

const toRect = (b: { x: number; y: number; width: number; height: number }): Rect => ({ x: b.x, y: b.y, width: b.width, height: b.height });

const inlineOf = (page: Page, text: string): Locator => blockOuter(page, text).locator(".bn-inline-content").first();

test("P6 [文字｜文字] 拖分隔線到左欄碰 200px 停住、放開只寫一次欄寬，不點回編輯器直接 Ctrl+Z 還原；[圖｜文字] 拉窄圖片欄 → 圖變小，拖回 → 長回 previewWidth", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p6");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await expect(divider(page)).toHaveCount(1);
  expect(await docWidths(page)).toEqual([1, 1]);
  const before = (await rowGeometry(page)).cols;
  const record: Record<string, unknown> = { before };

  // 貼上的交易都落定才開始數 Y update：隔 300ms 讀兩次文件形狀相同。
  await expect
    .poll(async () => {
      const first = await docShape(page);
      await page.waitForTimeout(300);
      return first === (await docShape(page));
    })
    .toBe(true);
  // 往左拖超過左欄能讓的寬度：左欄停在文字欄最小寬度 200px。
  await resetYUpdates(page);
  await dragDivider(page, -(before[0]!.width - 200) - 150, {
    beforeUp: async () => {
      const during = { cols: (await rowGeometry(page)).cols, widths: await docWidths(page), updates: await yUpdates(page), state: await dragState(page) };
      record.during = during;
      expect(during.widths, "拖曳中文件不變").toEqual([1, 1]);
      expect(during.updates, "拖曳中沒有 Y update").toBe(0);
      expect(during.state, "拖曳中 body 不能選字、預覽表在").toEqual({ userSelect: "none", dragging: 1, preview: 1 });
      expect(during.cols[0]!.width, "左欄停在 200px").toBeGreaterThanOrEqual(199);
      expect(during.cols[0]!.width).toBeLessThanOrEqual(201);
    },
  });
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  const written = await docWidths(page);
  const after = (await rowGeometry(page)).cols;
  record.written = written;
  record.after = after;
  expect(written[0]!).toBeLessThan(written[1]!);
  expect(Math.round((written[0]! + written[1]!) * 100) / 100).toBe(2);
  expect(after[0]!.width, "放開後左欄仍是 200px").toBeGreaterThanOrEqual(199);
  expect(after[0]!.width).toBeLessThanOrEqual(201);
  expect(await dragState(page), "放開後清掉預覽與 user-select").toEqual(IDLE);
  // 寫入只發生一次：放開那一下一個 Y update，之後沒有再改。
  await page.waitForTimeout(500);
  record.updates = await yUpdates(page);
  expect(record.updates, "放開後恰一次 Y update").toBe(1);
  expect(await docWidths(page)).toEqual(written);

  // 分隔線按下時不搶焦點：不點回編輯器，Ctrl+Z 直接撤銷這次調寬。
  record.focusInEditor = await editorLocator(page).evaluate((el) => el.contains(document.activeElement));
  expect(record.focusInEditor, "拖完焦點仍在編輯器").toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);
  await expect.poll(() => leftShare(page)).toBeCloseTo(0.5, 2);

  // [圖｜文字]：圖片寬 300（previewWidth），左欄拉到約 150px → 圖片跟著變窄；拖回原寬 → 圖片長回 300。
  await createNote(page, `E2E columns drag p6-image ${RUN}`);
  const url = await uploadPng(page, 600, 300);
  await pasteMarkdown(page, rowDoc([figure(url, 300), "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const img = editorLocator(page).locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);
  const imageBlock = editorLocator(page).locator('[data-content-type="image"]');
  await expect(imageBlock).toHaveAttribute("data-preview-width", "300");
  await expect(divider(page)).toHaveCount(1);
  const imgBefore = (await img.boundingBox())!.width;
  const colBefore = (await rowGeometry(page)).cols[0]!.width;
  const image: Record<string, unknown> = { imgBefore, colBefore };
  record.image = image;
  expect(Math.abs(imgBefore - 300), "前提：圖片顯示 300px").toBeLessThanOrEqual(0.5);
  expect(colBefore, "前提：左欄比圖片寬").toBeGreaterThan(300);

  await dragDivider(page, 150 - colBefore);
  await expect.poll(async () => (await rowGeometry(page)).cols[0]!.width).toBeLessThan(160);
  image.narrowCol = (await rowGeometry(page)).cols[0]!.width;
  image.narrowImg = (await img.boundingBox())!.width;
  expect(image.narrowImg as number, "欄變窄、圖片跟著變窄").toBeLessThan(imgBefore);
  expect(image.narrowImg as number).toBeLessThanOrEqual((image.narrowCol as number) + 0.5);
  await expect(imageBlock, "previewWidth 不變").toHaveAttribute("data-preview-width", "300");

  await dragDivider(page, colBefore - (image.narrowCol as number));
  await expect.poll(async () => Math.abs((await rowGeometry(page)).cols[0]!.width - colBefore)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await img.boundingBox())!.width - 300), { message: "圖片長回 previewWidth" }).toBeLessThanOrEqual(0.5);
  image.backImg = (await img.boundingBox())!.width;
  test.info().annotations.push({ type: "divider-drag-measurements", description: JSON.stringify(record) });
  expectNoPageErrors(errors);
});

test("P6b 列上方的圖片晚載入、把列往下推（columnEl 高度不變）→ 分隔線跟著下移、仍貼左欄右緣；在原位置按下不開始拖曳、點回內文游標進得去", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p6b");
  const url = await uploadPng(page, 400, 200);
  // 圖片的回應由測試放行：放行前量一次版面（圖片還沒有高度），放行後再量。
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (u) => u.pathname === url,
    async (route) => {
      await released;
      await route.continue();
    },
  );
  await pasteMarkdown(page, [`![late](${url})`, "", columnsMarkdown(["a", "b"]), ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  // 滑鼠移開：滑過分隔線會觸發它的重量，這裡要量的是 ResizeObserver 自己跟上。
  await page.mouse.move(5, 5);
  const measure = () =>
    page.evaluate((sel) => {
      const r = (e: Element | null | undefined) => {
        const b = e!.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const row = document.querySelector('[data-node-type="columnList"]');
      return {
        sep: r(document.querySelector(sel)),
        row: r(row),
        col1: r(row!.querySelector('[data-node-type="column"]')),
        columnEl: r(document.querySelector(".kb-column-dividers")!.parentElement),
        natural: (document.querySelector(".bn-editor img") as HTMLImageElement | null)?.naturalWidth ?? -1,
      };
    }, DIVIDER);
  const before = await measure();
  expect(before.natural, "前提：圖片還沒載入").toBe(0);
  expect(Math.abs(before.sep.x - (before.col1.x + before.col1.width))).toBeLessThanOrEqual(1);

  release();
  await waitImageLoaded(editorLocator(page).locator(`img[src*="${url}"]`));
  await expect.poll(async () => (await measure()).row.y - before.row.y, { message: "前提：列被圖片往下推" }).toBeGreaterThan(100);
  let after = await measure();
  try {
    await expect(async () => {
      after = await measure();
      expect(Math.abs(after.sep.x - (after.col1.x + after.col1.width)), JSON.stringify(after)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.sep.y - after.row.y), JSON.stringify(after)).toBeLessThanOrEqual(1);
      expect(after.sep.width).toBe(8);
    }).toPass({ timeout: 5_000 });
  } finally {
    test.info().annotations.push({ type: "late-image-divider", description: JSON.stringify({ before, after }) });
  }
  expect(Math.abs(after.columnEl.height - before.columnEl.height), "前提：columnEl 高度不變").toBeLessThanOrEqual(0.5);

  // 分隔線原本的位置現在是圖片那一段：不命中分隔線，按下也不開始拖曳。
  const old = { x: before.sep.x + before.sep.width / 2, y: before.sep.y + before.sep.height / 2 };
  expect((await hitKind(page, old)).separator, "原位置不再命中分隔線").toBe(false);
  await page.mouse.move(old.x, old.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "在原位置按下沒有開始拖分隔線").toEqual(IDLE);

  // 那一下選取了圖片，圖片工具列蓋在左欄上方，所以點右欄的內文。
  await clickEndOfParagraph(page, inlineOf(page, "b"));
  expect(await dragState(page)).toEqual(IDLE);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("P7 聚焦分隔線按 → 兩次 → 左欄比例增約 10%、右欄變窄；回到編輯器 Ctrl+Z 一次還原；← 一次 → 左欄比例減約 5% [sc:columnResizeKeys]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p7");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const share0 = await leftShare(page);
  const right0 = (await rowGeometry(page)).cols[1]!.width;
  expect(share0).toBeCloseTo(0.5, 2);

  await divider(page).focus();
  // 兩次之間不等待：落在撤銷的合併時間窗內。
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => leftShare(page)).toBeGreaterThan(share0 + 0.09);
  const share2 = await leftShare(page);
  expect(Math.abs(share2 - share0 - 0.1), `左欄比例 ${share0} → ${share2}`).toBeLessThanOrEqual(0.01);
  expect((await rowGeometry(page)).cols[1]!.width, "右欄變窄").toBeLessThan(right0);
  const written = await docWidths(page);
  expect(written).not.toEqual([1, 1]);

  await clickEndOfParagraph(page, inlineOf(page, "a"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page), { message: "一次 Ctrl+Z 還原兩次按鍵" }).toEqual([1, 1]);
  await expect.poll(() => leftShare(page)).toBeCloseTo(0.5, 2);

  await divider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => leftShare(page)).toBeLessThan(share0 - 0.04);
  const shareLeft = await leftShare(page);
  expect(Math.abs(share0 - shareLeft - 0.05), `左欄比例 ${share0} → ${shareLeft}`).toBeLessThanOrEqual(0.01);
  test.info().annotations.push({ type: "divider-keyboard", description: JSON.stringify({ share0, share2, written, shareLeft }) });
  expectNoPageErrors(errors);
});

test("P8 [圖｜文字] 拉圖右把手：先在欄內變大，超過欄寬後文字欄變窄、到 200px 停住；放開後 Ctrl+Z 一次還原圖寬與欄寬", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p8");
  const url = await uploadPng(page, 1200, 300);
  await pasteMarkdown(page, rowDoc([figure(url, 200), "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const img = editorLocator(page).locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);
  const imageBlock = editorLocator(page).locator('[data-content-type="image"]');
  await expect(imageBlock).toHaveAttribute("data-preview-width", "200");
  const before = (await rowGeometry(page)).cols;
  const ck = await imageBlock.evaluate((el) => (el.closest(".bn-block-content") as HTMLElement).clientWidth);
  const record: Record<string, unknown> = { before, ck };
  const snap = async () => ({ img: (await img.boundingBox())!.width, cols: (await rowGeometry(page)).cols });

  try {
    await img.hover();
    const handle = imageBlock.locator(".bn-resize-handle").nth(1); // 第二個是右把手
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    // 欄內：+40 → 圖片 240、欄寬不變。
    const inside = { x: start.x + 40, y: start.y };
    await moveInSteps(page, start, inside, 5);
    const step1 = await snap();
    record.inside = step1;
    expect(Math.abs(step1.img - 240), "欄內先變大").toBeLessThanOrEqual(1);
    expect(Math.abs(step1.cols[1]!.width - before[1]!.width), "欄內時文字欄不變").toBeLessThanOrEqual(0.5);

    // 超過可用寬 60px：文字欄讓出 60px。
    const over = { x: start.x + (ck - 200) + 60, y: start.y };
    await moveInSteps(page, inside, over, 10);
    const step2 = await snap();
    record.over = step2;
    expect(step2.cols[1]!.width, "超過欄寬後文字欄變窄").toBeLessThan(before[1]!.width - 50);
    expect(step2.cols[0]!.width, "圖片欄變寬").toBeGreaterThan(before[0]!.width + 50);

    // 再往右拉很遠：文字欄停在 200px；再拉也不變。
    const far = { x: over.x + 600, y: start.y };
    await moveInSteps(page, over, far, 10);
    const step3 = await snap();
    await moveInSteps(page, far, { x: far.x + 100, y: start.y }, 2);
    const step4 = await snap();
    record.far = { step3, step4 };
    expect(step3.cols[1]!.width, "文字欄停在 200px").toBeGreaterThanOrEqual(199);
    expect(step3.cols[1]!.width).toBeLessThanOrEqual(201);
    expect(Math.abs(step4.img - step3.img), "再拉也不變").toBeLessThanOrEqual(0.5);
    await page.mouse.up();

    await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
    const written = { widths: await docWidths(page), previewWidth: await imageBlock.getAttribute("data-preview-width") };
    record.written = written;
    expect(Math.abs(Number(written.previewWidth) - step4.img), "寫入的 previewWidth＝放開時的圖寬").toBeLessThanOrEqual(1);
    const afterUp = (await rowGeometry(page)).cols;
    expect(afterUp[1]!.width, "放開後文字欄仍是 200px").toBeGreaterThanOrEqual(199);
    expect(afterUp[1]!.width).toBeLessThanOrEqual(201);
  } finally {
    test.info().annotations.push({ type: "image-expands-column", description: JSON.stringify(record) });
  }

  await clickEndOfParagraph(page, inlineOf(page, "right text"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page), { message: "一次 Ctrl+Z 還原欄寬" }).toEqual([1, 1]);
  await expect(imageBlock, "同一次 Ctrl+Z 還原圖寬").toHaveAttribute("data-preview-width", "200");
  await expect.poll(async () => Math.abs((await img.boundingBox())!.width - 200)).toBeLessThanOrEqual(0.5);
  expectNoPageErrors(errors);
});

test("P9 分隔線與第 2 欄 ⋮⋮：按鈕寬 ≤ 16、兩者不重疊、⋮⋮ 右緣貼右欄左緣；⋮⋮ 顯示中命中區仍命中分隔線、拖得動；⋮⋮ 點得到也拖得動", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p9");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await expect(divider(page)).toHaveCount(1);
  const v: Record<string, unknown> = {};
  try {
    const { menu } = await hoverForSideMenu(page, blockOuter(page, "b"), "b");
    const button = page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" });
    await expect(button).toBeVisible();
    const btn = toRect((await button.boundingBox())!);
    const sep = toRect((await divider(page).boundingBox())!);
    const { row, cols } = await rowGeometry(page);
    const midY = row.y + row.height / 2;
    // 命中區每一個像素欄各量一點（命中區中心是 +4）。
    const hits: Array<{ p: Point } & HitKind> = [];
    for (let dx = 0.5; dx < sep.width; dx++) {
      const p = { x: sep.x + dx, y: midY };
      hits.push({ p, ...(await hitKind(page, p)) });
    }
    Object.assign(v, { btn, sideMenu: menu, sep, cols, hits });
    expect(btn.width, "⋮⋮ 按鈕寬 ≤ 16").toBeLessThanOrEqual(16.01);
    expect(Math.abs(sep.x - (cols[0]!.x + cols[0]!.width)), "命中區左緣＝左欄右緣").toBeLessThanOrEqual(1);
    expect(sep.width).toBe(8);
    expect(Math.abs(menu.x + menu.width - cols[1]!.x), "⋮⋮ 右緣貼右欄左緣").toBeLessThanOrEqual(1);
    // side menu 的 popover 以整數像素的 translate 定位（floating-ui 依 devicePixelRatio 捨入），相對的 columnEl 左緣帶小數時，
    // ⋮⋮ 會比右欄左緣再往左最多 0.5px，蓋到命中區最右邊那一個像素欄（side menu 的 z-index 高於分隔線浮層）。
    expect(btn.x, "⋮⋮ 按鈕最多蓋到命中區 0.5px").toBeGreaterThanOrEqual(sep.x + sep.width - 0.5);
    for (const h of hits.slice(0, -1)) expect(h.separator, `⋮⋮ 顯示中命中區 ${JSON.stringify(h)}`).toBe(true);
  } finally {
    test.info().annotations.push({ type: "divider-vs-side-menu", description: JSON.stringify(v) });
    console.log("P9=" + JSON.stringify(v));
  }

  // ⋮⋮ 顯示中，在命中區按下拖得動。先把滑鼠移進命中區，確認 ⋮⋮ 仍在畫面上。
  const band = (await divider(page).boundingBox())!;
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
  await expect(page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" })).toBeVisible();
  await dragDivider(page, -60);
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  await clickEndOfParagraph(page, inlineOf(page, "a"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);

  // ⋮⋮ 點得到：選單打開。
  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  await page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Ungroup columns" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Ungroup columns" })).toBeHidden();

  // ⋮⋮ 拖得動：b 拖到 z 下方。
  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z  paragraph:b");
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("P9b 第 1 欄靠右的 block 打 / 讓選單蓋住溝：命中區那一點命中選單項，點下 → 選單項生效、沒有開始拖分隔線", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p9b");
  // 第 2 欄放六段，列（也就是分隔線命中區）比選單項所在的高度還高。
  await pasteMarkdown(page, rowDoc(["a", "b\n\nb2\n\nb3\n\nb4\n\nb5\n\nb6"]));
  await expect
    .poll(() => docShape(page), { timeout: 15_000 })
    .toContain("ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:b2,paragraph:b3,paragraph:b4,paragraph:b5,paragraph:b6)]");
  await expect(divider(page)).toHaveCount(1);
  const { cols } = await rowGeometry(page);
  const col1Right = cols[0]!.x + cols[0]!.width;
  await clickEndOfParagraph(page, inlineOf(page, "a"));
  // 打字讓游標靠近第 1 欄右緣（不換行），選單從游標往右展開就會蓋到溝。
  const caret = () =>
    page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
  const y0 = (await caret()).y;
  for (let i = 0; i < 120 && (await caret()).x < col1Right - 120; i++) await page.keyboard.type("m");
  expect(Math.abs((await caret()).y - y0), "前提：沒有換行").toBeLessThanOrEqual(1);
  await page.keyboard.type(" /heading");
  const item = page.locator(".bn-suggestion-menu-item").filter({ hasText: "Heading 1" }).first();
  await expect(item).toBeVisible();
  const box = toRect((await item.boundingBox())!);
  const sep = toRect((await divider(page).boundingBox())!);
  const p = { x: sep.x + sep.width / 2, y: box.y + box.height / 2 };
  const hit = await hitKind(page, p);
  test.info().annotations.push({ type: "slash-menu-over-divider", description: JSON.stringify({ item: box, sep, p, hit }) });
  expect(box.x <= p.x && p.x <= box.x + box.width, `前提：選單項蓋住命中區 ${JSON.stringify({ box, sep })}`).toBe(true);
  expect(p.y >= sep.y && p.y <= sep.y + sep.height, `前提：量的點在命中區的高度內 ${JSON.stringify({ p, sep })}`).toBe(true);
  expect(hit.separator, "命中的不是分隔線").toBe(false);
  expect(hit.menuItem, `命中選單項 ${hit.desc}`).toContain("Heading 1");

  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "沒有開始拖分隔線").toEqual(IDLE);
  // 選單關掉後，同一點命中的是分隔線：剛才命中選單項是因為選單蓋在上面，不是那一點本來就沒有分隔線。
  await expect(item).toBeHidden();
  await expect.poll(async () => (await hitKind(page, p)).separator, { message: "選單關掉後同一點命中分隔線" }).toBe(true);
  // 段落有字時，選單項在它後面插入新的標題 block。
  await expect.poll(() => docShape(page)).toMatch(/ROW\[COL\(paragraph:am+ ?,heading\) \| COL\(paragraph:b,paragraph:b2/);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("P9c 第 1 欄的表格 hover 出「加一欄」延伸鈕：量它與分隔線命中區的關係（有重疊就斷言重疊處命中延伸鈕）；點下 → 表格多一欄、沒有開始拖分隔線", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p9c");
  // 欄寬給得比欄寬大：表格撐到欄內能放的最寬，延伸鈕最靠近溝。
  const table = '<table><tr><th colwidth="300">h1</th><th colwidth="300">h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>';
  await pasteMarkdown(page, rowDoc([table, "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(table:h1h2c1c2) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const headerCells = () => editorLocator(page).locator(`${ROW} table tr`).first().locator("th, td").count();
  expect(await headerCells()).toBe(2);
  await editorLocator(page).locator(`${ROW} table tr`).last().locator("td").last().hover();
  const extend = page.locator(".bn-extend-button-add-remove-columns");
  await expect(extend).toBeVisible();
  const ext = toRect((await extend.boundingBox())!);
  const sep = toRect((await divider(page).boundingBox())!);
  const { cols } = await rowGeometry(page);
  const y = ext.y + ext.height / 2;
  // 延伸鈕與命中區的水平交集；沒有交集時量命中區在延伸鈕那一列高度的命中結果。
  const overlap = { from: Math.max(ext.x, sep.x), to: Math.min(ext.x + ext.width, sep.x + sep.width) };
  const overlaps = overlap.to - overlap.from > 0.5;
  const probe = overlaps ? { x: (overlap.from + overlap.to) / 2, y } : { x: sep.x + sep.width / 2, y };
  const hit = await hitKind(page, probe);
  const record = { ext, sep, col1: cols[0], overlap, overlaps, probe, hit };
  test.info().annotations.push({ type: "table-extend-vs-divider", description: JSON.stringify(record) });
  console.log("P9c=" + JSON.stringify(record));
  if (overlaps) expect(hit.extend, `重疊處命中延伸鈕 ${hit.desc}`).toBe(true);
  else expect(hit.separator, `延伸鈕沒蓋到溝時，命中區仍命中分隔線 ${hit.desc}`).toBe(true);

  const target = overlaps ? probe : { x: ext.x + ext.width / 2, y };
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "沒有開始拖分隔線").toEqual(IDLE);
  await expect.poll(headerCells, { message: "表格多一欄" }).toBe(3);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("P10b 溝裡的檔案（分隔線命中區）：命中區中心先命中分隔線，dragenter 之後同一點命中編輯器、dragover 被接受，放下 → 圖片進最近的欄、網址不變", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p10b");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const url = page.url();
  // 滑鼠移開：⋮⋮ 不顯示，命中區那一點只有分隔線。
  await page.mouse.move(5, 5);
  const sep = toRect((await divider(page).boundingBox())!);
  const b = (await blockOuter(page, "b").boundingBox())!;
  const p = { x: sep.x + 4, y: b.y + b.height / 2 };
  const before = await hitKind(page, p);
  expect(before.separator, `前提：命中區中心命中分隔線 ${before.desc}`).toBe(true);

  const { cols } = await rowGeometry(page);
  const result = await dropFileAt(page, p, grayPng(40, 40));
  expect(result.pos, "放下前 posAtCoords 有結果").not.toBeNull();
  const expected = expectedColumns(cols, p, result.pos!);
  test.info().annotations.push({ type: "gutter-file-drop-on-divider", description: JSON.stringify({ p, sep, cols, expected, result }) });
  expect(expected.length, `預期的欄 ${JSON.stringify(result.pos)}`).toBeGreaterThan(0);
  expect(result.afterEnterInEditor, `dragenter 之後命中 ${result.afterEnter}`).toBe(true);
  expect(result.overPrevented, "dragover 被接受").toBe(true);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toMatch(/ROW\[COL\([^)]*image[^)]*\) \| COL\(paragraph:b\)\]|ROW\[COL\(paragraph:a\) \| COL\([^)]*image[^)]*\)\]/);
  const columns = columnsOf(await docShape(page));
  expect(expected, `圖片所在的欄 ${JSON.stringify(columns)}`).toContain(columns.findIndex((c) => c.includes("image")));
  expect(page.url()).toBe(url);
  expectNoPageErrors(errors);
});

/** 欄開標籤的正規形（shared `canonicalColumnsLine`；e2e 不能 import shared，兩邊要一起改）。 */
const COLUMNS_OPEN_TAG = '<div data-kb-columns style="display:flex;gap:16px">';
const COLUMN_LINE_RE = /^<div data-kb-column style="flex:((?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?)">$/;

test("P11 拖分隔線後 REST 讀出：欄開標籤是正規形、值＝文件欄寬；原樣 replace_all 寫回 → 201、欄寬不變、再讀逐字相同", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p11");
  const noteId = await noteIdFromUrl(page);
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  await dragDivider(page, -150);
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  const widths = await docWidths(page);

  type Content = { markdown: string; fingerprint: string };
  const read = async (): Promise<Content> => {
    const res = await page.request.get(`/api/notes/${noteId}/content`);
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Content;
  };
  const columnLines = (md: string) => md.split("\n").filter((l) => l.startsWith("<div data-kb-column"));
  // 調寬經共編送到 server 有時間差：讀到的欄寬等於文件的值才算 server 看到了。
  let original!: Content;
  await expect(async () => {
    original = await read();
    expect(columnLines(original.markdown).slice(1).map((l) => Number(COLUMN_LINE_RE.exec(l)?.[1]))).toEqual(widths);
  }).toPass({ timeout: 20_000 });
  const lines = columnLines(original.markdown);
  test.info().annotations.push({ type: "columns-markdown-after-resize", description: JSON.stringify({ widths, lines }) });
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(COLUMNS_OPEN_TAG);
  for (const l of lines.slice(1)) {
    const m = COLUMN_LINE_RE.exec(l);
    expect(m, `正規形 ${l}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0.1);
    expect(Number(m![1])).toBeLessThanOrEqual(10);
  }

  const rowIdBefore = await editorLocator(page).locator(ROW).first().getAttribute("data-id");
  const same = await page.request.post(`/api/notes/${noteId}/edits`, {
    headers: { Origin: originOf(page) },
    data: { op: "replace_all", markdown: original.markdown, if_match: original.fingerprint },
  });
  expect(same.status(), await same.text()).toBe(201);
  // replace_all 換掉每個 block 的 id：列的 data-id 換掉＝頁面收到這次寫入。
  await expect.poll(() => editorLocator(page).locator(ROW).first().getAttribute("data-id"), { timeout: 10_000 }).not.toBe(rowIdBefore);
  expect(await docWidths(page)).toEqual(widths);
  expect((await read()).markdown).toBe(original.markdown);
  expectNoPageErrors(errors);
});
