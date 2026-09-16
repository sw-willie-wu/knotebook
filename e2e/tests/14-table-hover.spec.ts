import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #160 的迴歸守門：hover 表格時整頁多出一條 document 層級的滾軸、版面跳動。
 *
 * 成因（見 `NoteEditor.tsx` 置中 wrapper 上 #160 的註解）：BlockNote 表格 hover 的
 * 「新增列／欄」按鈕（`.bn-extend-button`）經 FloatingPortal 掛到
 * `editor.portalElement`，floating-ui 預設 `position: absolute`。往上找不到 positioned
 * 祖先，containing block 就落到 `<html>`，穿過所有 `overflow-hidden`／`overflow-y-auto`。
 * 只有在**表格下緣（或右緣）捲出視窗外**時才會露餡。
 *
 * ⚠ **為什麼 hover 最後一欄而不是最後一列**（開發期實測踩過的雷，別改回去）：兩顆
 * 「新增」按鈕（`TableHandlesController.tsx`）都是錨在 `references.tableReference`
 * ——**整張表格**的 bounding rect，不是被 hover 的那一格；`TableHandles.ts` 的
 * `mouseMoveHandler` 有兩條分支會把它們翻成 true：
 * - cell 分支（:337-340）：`showAddOrRemoveColumnsButton` 只看
 *   `colIndex === 最後一欄`（跟列無關），`showAddOrRemoveRowsButton` 只看
 *   `rowIndex === 最後一列`——各自獨立判斷，不要求同時成立。
 * - wrapper 分支（:287-309）：滑鼠貼著表格**下緣 20px 內**（`belowTable`）時
 *   `showAddOrRemoveRowsButton` 也會翻 true；貼著**右緣 20px 內**（`toRightOfTable`）
 *   時 `showAddOrRemoveColumnsButton` 同理。
 * 兩條分支的「新增列」觸發條件都蘊含「表格下緣在滑鼠底下、必然在視窗內」（cell 分支
 * 直接 hover 到那一列；wrapper 分支貼著下緣本身就要在視窗內才點得到），撐不出破綻。
 * 但「新增欄」的 cell 分支只看 `colIndex`，跟列無關——可以在 hover **最上面那列、
 * 最後一欄**時就成立，這時候按鈕拉伸到的表格「下緣」完全不需要在視窗附近。這才是
 * 能在不捲動、不需要 Playwright auto-scroll 的情況下重現 #160 的路徑。
 * 真正錨在被 hover 那一列／格、位置會跟著它走的是**列/格拖曳把手**
 *（`rowReference`／`cellReference`），不是這兩顆新增按鈕——它們不會往右／往下溢出
 * 視窗，產生不了滾軸（`columnReference` 在表格上緣捲出視窗上方時一樣在視窗外，只是
 * 往上溢出不長滾軸，不是這條測試要守的東西）。
 *
 * 第一版誤用「hover 最後一列最後一格」重現：`.hover()` 的 auto-scroll-into-view 會把
 * 目標（也就是最後一列）捲進視窗，順便讓表格下緣跟著捲回可見範圍，結果對修好前的
 * build 也量到假綠——已改用上面「hover 最上面那列、最後一欄」的路徑，見 I1 的前提
 * 斷言（確保 hover 目標不需要、也沒有觸發 auto-scroll）。
 *
 * 為什麼只有 e2e 驗得到：這是真實的 CSS containing block／floating-ui 幾何計算，
 * jsdom 沒有 layout，`getBoundingClientRect` 全部回 0——單元測試（見
 * `NoteEditor.layout.test.tsx`）只能守「wrapper 帶 `relative` 這個 class」，守不到
 * 「浮層真的被收在裡面」這件事本身。
 *
 * 重現手法（垂直案）：貼上一份夠長的 markdown 表格（純文字、不帶 text/html →
 * 落我們自己的 `collab/paste.ts` 出口 1，`decideMarkdownPaste`〔:151-180〕直接
 * `return source`、呼叫端接著 `editor.pasteMarkdown`——不是 BlockNote 的
 * `defaultPasteHandler`；跟 `06-mermaid.spec.ts` 的貼上手法同源），讓表格整體高度
 * 遠超過縮小過的視窗；把編輯器的捲動容器捲回頂端，此時表格下緣落在
 * 視窗外（用 `getBoundingClientRect().bottom > window.innerHeight` 驗證這個前提）。
 * 然後 hover 表頭最後一欄（在視窗內，完全不用捲動）。
 *
 * 水平孿生案（`showAddOrRemoveColumnsButton`／`showAddOrRemoveRowsButton` 互換
 * 軸向）：貼一份夠寬的表格，讓表格右緣落在視窗外，hover **最後一列第一欄**（在視窗
 * 內，不用捲動），觸發「新增列」按鈕拉伸成表格全寬，右緣落在視窗外。
 * #162 之前的殘留（已裁，見下面斷言旁的說明）：`.bn-extend-button` 掛在 `relative`
 * 的置中 wrapper 下，但 wrapper 本身沒有設 `overflow`——超出 wrapper 右緣的部分會
 * 變成**上一層捲動容器**（`overflow-y-auto`，CSS 規則讓 `overflow-x` 隨之升成
 * `auto`）的橫向可捲溢出，不是 document 層級的（本檔開發期實機量到：800px 視窗、
 * 20 欄表格，hover 最後一列前捲動容器 `scrollWidth` 506，hover 後變 2480——這兩個
 * 數字修好後不變，`scrollWidth` 不受 `overflow-x` 影響，見 (A)）。#162 起這層補上
 * `overflow-x-clip`（見 `NoteEditor.tsx` :423 附近的註解）裁掉它。
 */

const TABLE_ROWS = 30;
const HEADERS = ["Col1", "Col2", "Col3"];
const LAST_HEADER = HEADERS[HEADERS.length - 1];

function buildMarkdownTable(rows: number): string {
  const header = `| ${HEADERS.join(" | ")} |`;
  const separator = `| ${HEADERS.map(() => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, i) => `| R${i + 1}C1 | R${i + 1}C2 | R${i + 1}C3 |`);
  return [header, separator, ...body].join("\n") + "\n";
}

// 20 欄：`@blocknote/core/src/blocks/Table/TableExtension.ts` 的
// `EMPTY_CELL_WIDTH = 120`，經 `editor.css`（`td:not([colwidth])` 規則）套成
// `min-width: 120px`——沒有明確設欄寬的 td/th 一律至少 120px。20 欄 × 120px =
// 2400px，遠超過下面 800px 的視窗寬，不看內容長度也穩定觸發水平溢出。
const WIDE_TABLE_COLS = 20;
const WIDE_TABLE_ROWS = 2;
const WIDE_LAST_ROW_FIRST_CELL = `W${WIDE_TABLE_ROWS}C1`;

function buildWideMarkdownTable(cols: number, rows: number): string {
  const headers = Array.from({ length: cols }, (_, i) => `WideHeader${i + 1}`);
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = Array.from(
    { length: rows },
    (_, r) => `| ${Array.from({ length: cols }, (_, c) => `W${r + 1}C${c + 1}`).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n") + "\n";
}

async function documentScrollGeometry(page: Page) {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/**
 * 等一輪，讓剛才那次程式化捲動（`scrollTop`／`scrollLeft` 賦值）觸發的原生 `scroll`
 * 事件先燒完，再讓呼叫端去 hover。
 *
 * 機制（有行號可查，不是猜測）：`TableHandlesController.tsx:146-174` 的
 * `whileElementsMounted` 等於 `autoUpdate(reference, floating, callback,
 * { ancestorScroll: true, ... })`——表格浮層一旦掛上去，之後每次祖先捲動都會呼叫
 * `hideHandlesIfNotFrozen()`（`TableHandles.ts:916-923`），把 `show` 與兩個
 * `showAddOrRemove*Button` 設回 false、`emitUpdate()`，浮層卸載。若我們自己觸發的
 * `scrollTop`／`scrollLeft` 賦值所排出的 `scroll` 事件還沒燒完就呼叫 `.hover()`，
 * 剛掛上去的浮層會在下一輪立刻被這個「祖先一捲動就收起來」的安全機制拆掉——開發期
 * 實測：拿掉這個等待，`.bn-extend-button` 穩定量到 0 顆（連續多次都是 0，不是偶發
 * flake）。`.tableWrapper`（`scrollTableWrapperToLeft` 捲的那層）跟編輯器捲動容器
 * （`scrollEditorToTop` 捲的那層）一樣，都是 `ancestorScroll: true` 會盯上的祖先，
 * 同一個機制、同一顆等待。
 */
async function waitForScrollEventsToSettle(page: Page) {
  await page.waitForTimeout(100);
}

/** 把編輯器的捲動容器捲回頂端。節點鏈同 `NoteEditor.layout.test.tsx`（那份單元測試
 * 守著這條鏈的 class；這裡沿用同一條鏈找節點，兩邊改動要一起看）：note-editor 的
 * parent 是置中 wrapper，再上一層才是真正會捲動的容器（`overflow-y-auto`）。 */
async function scrollEditorToTop(page: Page) {
  await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.parentElement?.parentElement as HTMLElement | null | undefined;
    if (scrollWrapper) scrollWrapper.scrollTop = 0;
  });
  await waitForScrollEventsToSettle(page);
}

/**
 * 把表格自己的橫向捲動容器（BlockNote 的 `.tableWrapper`，跟 `scrollEditorToTop`
 * 捲的那個垂直容器是不同層——開發期實測發現的第三層捲動）捲回最左邊。
 *
 * 貼上夠寬的表格後，游標落在最後一格，瀏覽器會把 `.tableWrapper` 的
 * `scrollLeft` 自動捲到接近表格尾端以保持游標可見（跟垂直案「貼上後看到的是
 * 表格尾端」是同一種瀏覽器行為，只是這次是水平的、發生在表格自己的 wrapper
 * 上，不是編輯器的捲動容器）。不捲回左邊的話，表格右緣一開始就已經在視窗內，
 * 水平孿生案量不到 #160 的現象（開發期實測：這裡不重設，`tableRight` 量到
 * 775 < 800 的視窗寬，前提斷言直接紅）。
 */
async function scrollTableWrapperToLeft(page: Page) {
  await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    const wrapper = tableEl?.closest(".tableWrapper") as HTMLElement | null;
    if (wrapper) wrapper.scrollLeft = 0;
  });
  await waitForScrollEventsToSettle(page);
}

test("hover 表格最後一欄（下緣在視窗外）不會撐出全頁滾軸", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3100" });

  // 縮小視窗高度：不用打幾十行填充文字也能可靠讓表格下緣落在視窗外，寬度不動
  // 避免碰到 <768 的窄視窗版面（見 10-responsive.spec.ts）。
  await page.setViewportSize({ width: 1280, height: 500 });

  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E table hover ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate((text) => navigator.clipboard.writeText(text), buildMarkdownTable(TABLE_ROWS));
  await page.keyboard.press("ControlOrMeta+v");

  const table = editor.locator("table").first();
  await expect(table).toBeVisible({ timeout: 10_000 });
  // 表格真的解析成表格（不是逐字貼成程式碼區塊）：最後一格的內容要看得到。
  await expect(editor.getByText(`R${TABLE_ROWS}C3`)).toBeVisible();

  await scrollEditorToTop(page);

  // 前提：表格下緣真的在視窗外，否則這條測試量不到 #160 的現象。
  const { tableBottom, viewportHeight } = await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    return {
      tableBottom: tableEl?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
    };
  });
  expect(tableBottom, "表格下緣必須在視窗外，測試才量得到 #160").toBeGreaterThan(viewportHeight);

  // 對照：hover 前，document 本身不該有可捲溢出（表格自己的捲動由編輯器的
  // overflow-y-auto 容器吃掉）。
  const before = await documentScrollGeometry(page);
  expect(before.scrollHeight, "hover 前 document 就不該溢出（高度）").toBeLessThanOrEqual(before.clientHeight);
  expect(before.scrollWidth, "hover 前 document 就不該溢出（寬度）").toBeLessThanOrEqual(before.clientWidth);

  // hover 表頭最後一欄：這格本身就在視窗內（第一列，捲回頂端後一定看得到），不需要
  // Playwright 幫忙捲動——這正是我們要的：hover 的目標在畫面上，但「新增欄」按鈕的
  // 錨點（整張表格）下緣不在。
  const lastHeaderCell = editor.getByText(LAST_HEADER, { exact: true }).first();

  // ⚠ 前提斷言（I1）：hover 目標本身必須已經在視窗內，`.hover()` 才不會先幫我們
  // auto-scroll——一旦 Playwright 覺得目標不在視窗內而自動捲動，很可能連帶把表格
  // 下緣也捲回可見範圍，這條測試就會對「沒修好」的 build 量出假綠（開發期第一版
  // 用「hover 最後一列最後一格」正是這樣踩雷的，見檔頭）。
  // ⚠ 這條只是便宜的早退檢查（在已知的建置條件下應該恆真，紅了代表測試本身的假設
  // 被破壞，不代表 #160 本身）——真正擋住「auto-scroll 把 bug 現象捲沒」這個假綠
  // 通道的，是 hover **之後**那條複驗（下面 `tableBottomAfterHover`）。
  const targetBox = await lastHeaderCell.boundingBox();
  expect(targetBox, "hover 目標必須有幾何（已渲染）").not.toBeNull();
  expect(
    targetBox!.y + targetBox!.height,
    "hover 目標本身必須已經在視窗內，否則 .hover() 會 auto-scroll、讓表格下緣跟著捲回可見範圍",
  ).toBeLessThan(viewportHeight);

  await lastHeaderCell.hover();

  // BlockNote 表格 hover 的按鈕/把手是真實 DOM mousemove 監聽觸發（見
  // `TableHandles.ts` 的 `mouseMoveHandler`），`.hover()` 送出的是真實輸入事件，會
  // 命中。用 `toBeAttached`（不用 `toBeVisible`）：這裡只需要確認浮層真的掛載了
  // （代表 hover 命中、`showAddOrRemoveColumnsButton` 翻成 true），至於它在不在畫面
  // 上不是這條測試要驗的性質——`toBeVisible` 不看祖先的 overflow 裁切，修好之後這顆
  // 按鈕的上半段其實仍看得見，用 `toBeVisible` 反而測不出「有沒有掛載」跟「有沒有
  // 露到 document 外」的差別。
  await expect(page.locator(".bn-extend-button-add-remove-columns").first()).toBeAttached({ timeout: 5_000 });

  // 複驗（I1 的另一半）：hover 完之後，表格下緣依然必須在視窗外——如果 hover 這個
  // 動作本身把表格捲回了可見範圍，下面的「document 不溢出」斷言就會對任何 build
  // 都恆綠，量不到 #160。
  const tableBottomAfterHover = await page.evaluate(
    () => document.querySelector('[data-testid="note-editor"] table')?.getBoundingClientRect().bottom ?? 0,
  );
  expect(tableBottomAfterHover, "hover 不得把表格下緣捲回視窗內，否則本案退化成恆綠").toBeGreaterThan(
    viewportHeight,
  );

  // 核心斷言：hover 之後 document 仍然不該有可捲溢出。這是 #160 修好/沒修好的分野。
  const after = await documentScrollGeometry(page);
  expect(after.scrollHeight, "hover 後 document 不該多出一條全頁滾軸（#160）").toBeLessThanOrEqual(
    after.clientHeight,
  );
  // N3：修法不得把「全頁滾軸」換成「內文捲動容器的橫向滾軸」——這裡量的是
  // document 本身，跟下面水平孿生案量捲動容器是兩個不同層級，互相補位。
  expect(after.scrollWidth, "hover 後 document 不該多出橫向滾軸").toBeLessThanOrEqual(after.clientWidth);

  // N3（補）：再往下一層量捲動容器本身（節點鏈同 `scrollEditorToTop`：note-editor
  // 的 parent 是置中 wrapper，再上一層才是捲動容器）——這裡的表格沒有超寬（垂直案
  // 只把表格撐高，不撐寬），所以捲動容器不該因為這次 hover 多出橫向可捲溢出；水平
  // 孿生案的表格本身就超寬，那條測試在它自己的核心斷言裡驗這一層（見 #162）。
  const scrollWrapperGeo = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.parentElement?.parentElement as HTMLElement | null | undefined;
    return { scrollWidth: scrollWrapper?.scrollWidth ?? 0, clientWidth: scrollWrapper?.clientWidth ?? 0 };
  });
  expect(scrollWrapperGeo.scrollWidth, "修法不得把全頁滾軸換成內文的橫向滾軸").toBeLessThanOrEqual(
    scrollWrapperGeo.clientWidth,
  );
});

test("hover 表格最後一列第一欄（右緣在視窗外，水平孿生案）不會撐出全頁滾軸，內文區也不長橫向滾軸", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3100" });

  // 縮小視窗寬度（不動高度）：讓 20 欄的表格右緣可靠地落在視窗外，同時列數壓在 2
  // 列就好——不需要像垂直案那樣捲動，表格本來就矮到整張都在預設視窗高度內。
  await page.setViewportSize({ width: 800, height: 700 });

  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E table hover wide ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    buildWideMarkdownTable(WIDE_TABLE_COLS, WIDE_TABLE_ROWS),
  );
  await page.keyboard.press("ControlOrMeta+v");

  const table = editor.locator("table").first();
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(editor.getByText(WIDE_LAST_ROW_FIRST_CELL, { exact: true })).toBeVisible();

  await scrollTableWrapperToLeft(page);

  // 前提：表格右緣真的在視窗外，否則這條測試量不到水平孿生案的現象。
  const { tableRight, viewportWidth } = await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    return {
      tableRight: tableEl?.getBoundingClientRect().right ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(tableRight, "表格右緣必須在視窗外，測試才量得到水平孿生案").toBeGreaterThan(viewportWidth);

  const before = await documentScrollGeometry(page);
  expect(before.scrollHeight, "hover 前 document 就不該溢出（高度）").toBeLessThanOrEqual(before.clientHeight);
  expect(before.scrollWidth, "hover 前 document 就不該溢出（寬度）").toBeLessThanOrEqual(before.clientWidth);

  // hover 最後一列第一欄：這格在視窗內（表格左緣貼著文章欄左側，不需要橫向捲動就
  // 看得到），觸發 `showAddOrRemoveRowsButton`（跟欄無關，只看 rowIndex 是不是最後
  // 一列）——「新增列」按鈕會拉伸成表格全寬，右緣落在視窗外。
  const lastRowFirstCell = editor.getByText(WIDE_LAST_ROW_FIRST_CELL, { exact: true });

  // 前提斷言（同 I1 的精神，換成水平軸）：hover 目標本身必須已經在視窗內，
  // `.hover()` 才不會 auto-scroll 把表格右緣也捲回可見範圍。
  // ⚠ 這條只是便宜的早退檢查——真正擋住假綠通道的是 hover 之後那條複驗（下面
  // `tableRightAfterHover`）。
  const targetBox = await lastRowFirstCell.boundingBox();
  expect(targetBox, "hover 目標必須有幾何（已渲染）").not.toBeNull();
  expect(
    targetBox!.x + targetBox!.width,
    "hover 目標本身必須已經在視窗內，否則 .hover() 會 auto-scroll、讓表格右緣跟著捲回可見範圍",
  ).toBeLessThan(viewportWidth);

  await lastRowFirstCell.hover();

  await expect(page.locator(".bn-extend-button-add-remove-rows").first()).toBeAttached({ timeout: 5_000 });

  const tableRightAfterHover = await page.evaluate(
    () => document.querySelector('[data-testid="note-editor"] table')?.getBoundingClientRect().right ?? 0,
  );
  expect(tableRightAfterHover, "hover 不得把表格右緣捲回視窗內，否則本案退化成恆綠").toBeGreaterThan(
    viewportWidth,
  );

  const after = await documentScrollGeometry(page);
  expect(after.scrollHeight, "hover 後 document 不該多出全頁滾軸（高度）").toBeLessThanOrEqual(after.clientHeight);
  expect(after.scrollWidth, "hover 後 document 不該多出全頁滾軸（寬度）").toBeLessThanOrEqual(after.clientWidth);

  // issue #162：再往下一層量捲動容器本身（節點鏈同 `scrollEditorToTop`：note-editor
  // 的 parent 是置中 wrapper，再上一層才是捲動容器）——這裡的表格本身就超寬，是這條
  // 測試唯一能量到「橫向可捲溢出」殘留的地方（垂直案的表格不超寬，量不到）。
  // 斷言分兩層，缺一即弱化：
  //
  // (A) 計算後的 `overflow-x`：守「Tailwind 的 `overflow-x-clip` utility 真的產出了
  //     規則」這件事本身——這是**靜態屬性**，跟有沒有 hover 無關（拿掉上面整段 hover
  //     這條也會綠）。⚠ 不能斷言 `scrollWidth <= clientWidth`：開發期拋棄式腳本量過
  //     （三個 `width:200px` 的 div，內容都放 `width:1000px` 子節點），Chromium 的
  //     `scrollWidth` 完全不受 `overflow-x` 是 `auto`／`hidden`／`clip` 影響，三者
  //     都回 1000——量的是內容本身的幾何範圍，不是「有沒有可捲/可見的溢出」，修好
  //     前後這個數字不會變（本檔第一版斷言用它，對修好的 build 也判紅，已改用這
  //     道）。真正決定「有沒有橫向捲軸」的是計算後的 `overflow-x` 本身：CSS
  //     Overflow Module Level 3 §3.1
  //     （https://www.w3.org/TR/css-overflow-3/#overflow-properties）「The
  //     visible/clip values of overflow compute to auto/hidden (respectively) if
  //     one of overflow-x or overflow-y is neither visible nor clip」——本層
  //     `overflow-y` 是 `auto`，所以我們寫的 `overflow-x: clip` 計算值會被推成
  //     `hidden`（見 `NoteEditor.tsx` :423 附近的註解）。下面斷言的計算值是對這條
  //     e2e 自己的節點鏈量的，不是套用合成 div 腳本的結果——拿掉 `overflow-x-clip`
  //     重跑本檔（突變驗證）量到 `Received: "auto"`。
  const scrollWrapperOverflowX = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.parentElement?.parentElement as HTMLElement | null | undefined;
    return scrollWrapper ? getComputedStyle(scrollWrapper).overflowX : null;
  });
  expect(scrollWrapperOverflowX, "捲動容器必須有幾何（已渲染），否則下面兩條斷言恆綠").not.toBeNull();
  expect(
    scrollWrapperOverflowX,
    "#162：捲動容器的橫向 overflow 不該計算成 auto/scroll（有溢出時就會長捲軸）",
  ).not.toBe("auto");
  expect(
    scrollWrapperOverflowX,
    "#162：捲動容器的橫向 overflow 不該計算成 auto/scroll（有溢出時就會長捲軸）",
  ).not.toBe("scroll");

  // (B) 使用者真的摸不摸得到：(A) 只守「class 有沒有生效」，不守「hover 之後使用者
  //     實際滾不滾得動」。把游標移到捲動容器內、但落在 `.tableWrapper`／extend
  //     按鈕**下方**空白處的點（這裡的表格只有 2 列很矮，下面有空白），送一次橫向
  //     滾輪，量 `scrollWrapper.scrollLeft` 有沒有被推動。真瀏覽器實測（見
  //     `NoteEditor.tsx` :423 附近的註解）：`hidden` 下這個動作 `scrollLeft` 恆為
  //     0，`auto` 下同動作是 300。
  const scrollWrapperBox = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const sw = editorRoot?.parentElement?.parentElement as HTMLElement | null;
    const r = sw?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  const tableBoxForWheel = await table.boundingBox();
  const extendBtnBoxForWheel = await page.locator(".bn-extend-button-add-remove-rows").first().boundingBox();
  expect(scrollWrapperBox, "捲動容器必須有幾何（已渲染）").not.toBeNull();
  expect(tableBoxForWheel, "表格必須有幾何（已渲染）").not.toBeNull();
  // extend 按鈕必須有幾何——沒有的話 `wheelY` 會退回表格下緣＋20，落進 `.tableWrapper`
  // 的 22px 下內距（`editor.css:137-146` 的 `--bn-table-widget-size`），滾輪被它吃掉，
  // (B) 對任何 build 都恆綠。
  expect(
    extendBtnBoxForWheel,
    "extend 按鈕必須有幾何——沒有的話 wheelY 會退回表格下緣+20，落進 .tableWrapper 的 22px 下內距而被它吃掉滾輪",
  ).not.toBeNull();
  if (scrollWrapperBox && tableBoxForWheel) {
    const lowestEdge = Math.max(
      tableBoxForWheel.y + tableBoxForWheel.height,
      extendBtnBoxForWheel ? extendBtnBoxForWheel.y + extendBtnBoxForWheel.height : 0,
    );
    let wheelY = lowestEdge + 20;
    if (wheelY >= scrollWrapperBox.y + scrollWrapperBox.height) {
      wheelY = scrollWrapperBox.y + scrollWrapperBox.height / 2;
    }
    // 滾輪測試點刻意落在捲動容器左緣附近（`scrollWrapperBox.x + 8`），不是水平置中——
    // 置中的點落在文章欄（ARTICLE_COLUMN 置中 wrapper）內，可能踩進 `.bn-editor`
    // （pmView.dom）內部，會被下面 (204-209)/(230-238) 的機制卸載 extend 按鈕（量測見
    // 下方註解）。實測（見下方 `wheelPointHit`）：本測試 800px 視窗下，文章欄的
    // `clamp` 下限（680px）比捲動容器可用寬度（約 506px）還寬，wrapper 因此撐滿
    // 捲動容器整寬（不是縮窄置中），`.bn-editor` 縮在 wrapper 自己的 `px-4`
    // （`ARTICLE_COLUMN_PADDING`，16px）內距裡面；`+8` 還沒推進到內距內側的
    // `.bn-editor`，命中的是 wrapper 自己（`elementFromPoint` 量到 class 含
    // `max-w-[clamp(...)]`／`px-4` 那個 div），不是它的子孫、也不是 `.tableWrapper`。
    const wheelX = scrollWrapperBox.x + 8;
    expect(
      wheelY,
      "滾輪測試點必須落在捲動容器可視範圍內，才量得到使用者真的能不能滾",
    ).toBeLessThan(scrollWrapperBox.y + scrollWrapperBox.height);

    await page.mouse.move(wheelX, wheelY);

    // 前提（已用 `document.elementFromPoint(wheelX, wheelY)` 量測，不是猜）：這個點
    // 必須落在 pmView.dom（`.bn-editor`）之外，且不在 `.tableWrapper` 內——
    // `TableHandles.ts:204-209` 對「`event.target` 不在 `pmView.dom` 內」的
    // mousemove 直接 `return`，完全不動 `show`／`showAddOrRemove*Button`，extend
    // 按鈕留住。反例（開發期量過，換成水平置中的點）：命中的是 TrailingNode 的
    // `.bn-trailing-block` widget（在 `.bn-editor` 內部，鏈：widget →
    // `.bn-block-group` → `.bn-editor`），會落進 `domCellAround`
    // （`TableHandles.ts:104-134`）回傳 `undefined`、`:230-238` 卸載按鈕的路徑——
    // 量測證實真的會卸載，只是不是同一個 tick：`mouse.move()` 剛結束、還沒等待就查
    // 按鈕仍掛著，插入 `waitForTimeout(300)` 後按鈕才從 DOM 消失（重繪送達要時間）。
    // 這裡選在 wrapper 自己的內距，從根本上不會進 `domCellAround` 的判斷，不必依賴
    // 那個窄窗口。
    const wheelPointHit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const bnEditor = document.querySelector(".bn-editor");
        const tableWrapper = document.querySelector(".tableWrapper");
        return {
          tag: el?.tagName ?? null,
          className: el ? String((el as HTMLElement).className || "") : null,
          insideBnEditor: !!(el && bnEditor && bnEditor.contains(el)),
          insideTableWrapper: !!(el && tableWrapper && tableWrapper.contains(el)),
        };
      },
      [wheelX, wheelY],
    );
    // 除錯用：滾輪測試點實際命中的元素
    console.log("wheel point hit:", wheelPointHit);
    expect(
      wheelPointHit.insideBnEditor,
      `滾輪測試點必須落在 pmView.dom 之外，否則 TableHandles.ts:230-238 會卸載按鈕、(B) 恆綠——命中元素 class="${wheelPointHit.className}"`,
    ).toBe(false);
    expect(
      wheelPointHit.insideTableWrapper,
      `滾輪測試點不得落在 .tableWrapper 內——命中元素 class="${wheelPointHit.className}"`,
    ).toBe(false);

    // 等 300ms 再斷言：這個點在 `.bn-editor` 外，理論上按鈕完全不受這次 mousemove
    // 影響，所以不管等多久都該還掛著——跟上面反例「在 `.bn-editor` 內的點 300ms 後
    // 消失」對照，這才是真正測到「點在外面」這件事本身，不是賭一個時序窗口。
    await page.waitForTimeout(300);
    await expect(
      page.locator(".bn-extend-button-add-remove-rows").first(),
      "滑到滾輪測試點、等 300ms 後 extend 按鈕仍必須掛著，否則橫向溢出源已消失、(B) 會對任何 build 都恆綠",
    ).toBeAttached();

    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(100);
  }
  const scrollLeftAfterWheel = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const sw = editorRoot?.parentElement?.parentElement as HTMLElement | null;
    return sw?.scrollLeft ?? -1;
  });
  expect(scrollLeftAfterWheel, "使用者不得能把內文區橫向捲走").toBe(0);
});
