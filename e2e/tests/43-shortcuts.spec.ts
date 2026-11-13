import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  adminNav,
  createNote,
  editorLocator,
  loginAs,
  openSelectionAiBox,
  openSiteAdmin,
  selectionAiBox,
  showSidebarTab,
  startSidebarSelection,
  toggleSelectedNote,
  waitForEditorSelection,
} from "./helpers.js";
import { E2E_ORIGIN } from "../ports.js";

/**
 * 快捷鍵介紹頁（Ctrl+/ modal）的事實驗證。
 *
 * 清單上的每一條快捷鍵／打字觸發字，都要有一支在真瀏覽器跑過的 e2e：test 名稱尾端的 `[sc:<id>]` 標籤把條目與測試連起來
 * （`shortcut-e2e-coverage.test.ts` 會掃本目錄 `*.spec.ts` 的原始文字，清單 id ⇔ 標籤雙向核對）。說明文字裡寫的行為都在這裡量過；
 * BlockNote／Tiptap 升級後若行為變了，這裡會先紅，提醒回頭改說明。
 *
 * - 一支 test 一個分類，各自 `createNote` 建一篇（不共用 page、互不污染）。按鍵用 `ControlOrMeta`（疊跑在 Linux＝Control）。
 * - 標題一律是純字串字面（不用 template literal）：守衛只認 `test("…")` 的第一個引數。
 * - 只有 Chromium 驗過；Firefox／Safari 未驗。
 * - 借用既有 e2e 的條目（presentOverview、presentExit → 22；dragNoteToEditor → 42-7；dragNoteToFolder → 42-1、42-4；dragBlockCopy → 49 U6）不在這裡重寫。
 */

const RUN = Date.now();
const ORIGIN = E2E_ORIGIN;

// ── 編輯器 helper ─────────────────────────────────────────────────────────────────────────────

/** 登入、建一篇筆記、游標放進編輯器。 */
async function startNote(page: Page, label: string): Promise<Locator> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E sc ${label} ${RUN}`);
  const editor = editorLocator(page);
  await editor.click();
  await waitForEditorSelection(page);
  return editor;
}

/** 游標所在的最內層 blockContainer 的內容型別（paragraph／heading／bulletListItem…）。 */
async function caretBlockType(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; firstChild: PmNode | null };
    type View = { state: { selection: { $head: { depth: number; node(d: number): PmNode } } } };
    const view = (el as Element & { editor?: { view?: View } }).editor?.view;
    if (!view) return "no-editor";
    const $h = view.state.selection.$head;
    for (let d = $h.depth; d >= 0; d--) {
      const node = $h.node(d);
      if (node.type.name === "blockContainer") return node.firstChild!.type.name;
    }
    return "none";
  });
}

/** 在筆記最後開一個空的一般段落（前一塊是清單、標題、引言時，用 Backspace 轉回段落）。 */
async function freshParagraph(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 3; i++) {
    await waitForEditorSelection(page);
    if ((await caretBlockType(page)) === "paragraph") return;
    await page.keyboard.press("Backspace");
  }
  expect(await caretBlockType(page), "freshParagraph：游標所在區塊轉不回一般段落").toBe("paragraph");
}

/** 該型別的區塊（`.bn-block-content[data-content-type]`）。 */
function blocksOf(page: Page, type: string): Locator {
  return editorLocator(page).locator(`.bn-block-content[data-content-type="${type}"]`);
}

/** 游標前的整段文字用 Shift+Home 選起來，等 ProseMirror 讀回非空選取。 */
async function selectToLineStart(page: Page): Promise<void> {
  await page.keyboard.press("Shift+Home");
  await expect
    .poll(() =>
      editorLocator(page).evaluate((el) => {
        const view = (el as Element & { editor?: { view?: { state: { selection: { empty: boolean } } } } }).editor?.view;
        return view ? !view.state.selection.empty : null;
      }),
    )
    .toBe(true);
}

/** 主編輯器 ProseMirror 文件裡 `.bn-block-outer` 的純文字（依文件順序）。 */
async function blockTexts(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((el) => {
    const view = (el as Element & { editor?: { view?: { state: { doc: { descendants(f: (n: { type: { name: string }; isTextblock: boolean; textContent: string }) => void): void } } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const out: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.isTextblock) out.push(n.textContent);
    });
    return out;
  });
}

async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** 在筆記最後貼上 markdown（Ctrl+End 後等 ProseMirror 跟上再貼；同 22／34 的 pasteMarkdown）。 */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

// ── 全站 ──────────────────────────────────────────────────────────────────────────────────────

test("全站：Ctrl+K 聚焦側欄搜尋框；Esc 清除搜尋並回到分頁清單 [sc:search] [sc:searchClear]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "global-search");
  const search = page.getByRole("textbox", { name: "Search notes" });
  await expect(search).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();

  const tabs = page.getByRole("tablist", { name: "Sidebar sections" });
  await expect(tabs).toBeVisible();
  await page.keyboard.type("zzz-no-such-note");
  await expect(search).toHaveValue("zzz-no-such-note");
  await expect(tabs).toHaveCount(0); // 搜尋中：分頁清單換成搜尋結果

  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).not.toBeFocused();
  await expect(tabs).toBeVisible();
});

test("全站：Ctrl+S 在可編輯的筆記頁存一個版本 [sc:saveVersion]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "global-save");
  await page.keyboard.type("version body");
  await expect(editor).toContainText("version body");
  await page.keyboard.press("ControlOrMeta+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  const name = `sc-version-${RUN}`;
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const noteId = await noteIdFromUrl(page);
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${noteId}/versions?limit=100`);
    expect(res.ok()).toBe(true);
    const { versions } = (await res.json()) as { versions: Array<{ name: string | null }> };
    expect(versions.some((v) => v.name === name)).toBe(true);
  }).toPass({ timeout: 15_000 });
});

// ── 打字觸發 ───────────────────────────────────────────────────────────────────────────────────

test("打字觸發：/ 開插入選單 [sc:slashMenu]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "typing-slash");
  await page.keyboard.type("/");
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const titles = (await menu.locator(".bn-mt-suggestion-menu-item-title").allTextContents()).map((s) => s.trim());
  for (const wanted of ["Heading 1", "Bullet List", "Table", "Image"]) expect(titles, `選單項 ${wanted}`).toContain(wanted);
  expect(titles.some((s) => /diagram/i.test(s)), "選單有流程圖項").toBe(true);
  expect(titles.some((s) => /columns/.test(s)), "選單有並排項").toBe(true);
});

test("打字觸發：[[ 連到別篇筆記，對方出現反向連結 [sc:wikilink]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const stamp = String(Date.now());
  const targetTitle = `E2E sc wiki target ${stamp}`;
  await createNote(page, targetTitle);
  const targetId = await noteIdFromUrl(page);
  await createNote(page, `E2E sc wiki source ${stamp}`);
  const sourceId = await noteIdFromUrl(page);
  await editorLocator(page).click();
  await waitForEditorSelection(page);
  await page.keyboard.type("[[");
  await page.keyboard.type(`wiki target ${stamp}`); // 只打 target 的標題：source 自己的標題也含 stamp，會被選到
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByText(targetTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  const wikilink = editorLocator(page).locator('[data-inline-content-type="wikilink"]');
  await expect(wikilink).toHaveCount(1, { timeout: 10_000 });
  await expect(wikilink).toContainText(targetTitle);
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${targetId}/backlinks`);
    expect(res.status()).toBe(200);
    const { backlinks } = (await res.json()) as { backlinks: Array<{ id: string }> };
    expect(backlinks.map((b) => b.id)).toContain(sourceId);
  }).toPass({ timeout: 20_000 });
});

test("打字觸發：[文字](網址) 打完右括號變成外部連結 [sc:markdownLink]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "typing-mdlink");
  await page.keyboard.type("go [example](https://example.com)");
  const link = editor.locator('a[href="https://example.com"]');
  await expect(link).toHaveCount(1, { timeout: 10_000 });
  await expect(link).toHaveText("example");
  expect(await blockTexts(page)).toEqual(["go example"]); // 括號與網址被吃掉，只剩顯示文字
});

// ── Markdown 速記 ──────────────────────────────────────────────────────────────────────────────

test("Markdown 速記：區塊開頭的 # - 1. [] > ``` --- [sc:heading] [sc:bullet] [sc:numbered] [sc:checklist] [sc:quote] [sc:codeBlock] [sc:divider]", async ({ page }) => {
  test.setTimeout(150_000);
  await startNote(page, "md-blocks");

  // 標題：逐級試 # … ######，記下實際最高幾級
  const levels: Array<number | null> = [];
  for (let n = 1; n <= 6; n++) {
    await freshParagraph(page);
    await page.keyboard.type(`${"#".repeat(n)} h${n}`);
    const h = editorLocator(page).locator(".bn-block-content[data-content-type='heading']", { hasText: `h${n}` });
    // 一級標題是預設值，BlockNote 不寫 data-level；沒有屬性＝1
    levels.push((await h.count()) === 0 ? null : Number((await h.first().getAttribute("data-level")) ?? "1"));
  }
  test.info().annotations.push({ type: "heading-levels", description: JSON.stringify(levels) });
  expect(levels, "# 到 ###### 對應標題 1 到 6 級").toEqual([1, 2, 3, 4, 5, 6]);

  // 項目清單：- 、* 、+ 都行
  for (const mark of ["-", "*", "+"]) {
    await freshParagraph(page);
    await page.keyboard.type(`${mark} b${mark === "-" ? "d" : mark === "*" ? "s" : "p"}`);
  }
  await expect(blocksOf(page, "bulletListItem")).toHaveCount(3);

  await freshParagraph(page);
  await page.keyboard.type("1. num");
  await expect(blocksOf(page, "numberedListItem")).toHaveCount(1);

  await freshParagraph(page);
  await page.keyboard.type("[] todo");
  await freshParagraph(page);
  await page.keyboard.type("[x] done");
  const checks = blocksOf(page, "checkListItem");
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0).locator("input[type=checkbox]")).not.toBeChecked();
  await expect(checks.nth(1).locator("input[type=checkbox]")).toBeChecked();

  await freshParagraph(page);
  await page.keyboard.type("> quoted");
  await expect(blocksOf(page, "quote")).toHaveCount(1);

  // 程式碼區塊：``` 之後要接空白才成立；可接語言
  await freshParagraph(page);
  await page.keyboard.type("```ts");
  await expect(blocksOf(page, "codeBlock"), "``` 後沒打空白時還不是程式碼區塊").toHaveCount(0);
  await page.keyboard.type(" ");
  await expect(blocksOf(page, "codeBlock")).toHaveCount(1);
  // 語言：``` 後面接的 ts 被認成 typescript
  await expect(blocksOf(page, "codeBlock").first()).toHaveAttribute("data-language", "typescript");

  await freshParagraph(page);
  await page.keyboard.type("---");
  await expect(blocksOf(page, "divider")).toHaveCount(1);
});

test("Markdown 速記：行內的 `code` **粗體** *斜體* ~~刪除線~~ [sc:inlineCode] [sc:inlineMarks]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "md-inline");
  const cases: Array<[string, string, string]> = [
    ["`mono`", "code", "mono"],
    ["**bolded**", "strong", "bolded"],
    ["*slanted*", "em", "slanted"],
    ["~~struck~~", "s", "struck"],
  ];
  for (const [typed, tag, text] of cases) {
    await freshParagraph(page);
    await page.keyboard.type(typed);
    await expect(editor.locator(tag, { hasText: new RegExp(`^${text}$`) }), `${typed} → <${tag}>`).toHaveCount(1);
  }
  // 標記符號被吃掉：文字只剩內容
  expect((await blockTexts(page)).filter((s) => s !== "")).toEqual(["mono", "bolded", "slanted", "struck"]);
});

// ── 文字格式 ───────────────────────────────────────────────────────────────────────────────────

test("文字格式：Ctrl+B／I／U、Ctrl+Shift+S、Ctrl+E [sc:bold] [sc:italic] [sc:underline] [sc:strike] [sc:codeMark]", async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await startNote(page, "fmt-marks");
  const cases: Array<[string, string, string]> = [
    ["ControlOrMeta+b", "strong", "wbold"],
    ["ControlOrMeta+i", "em", "witalic"],
    ["ControlOrMeta+u", "u", "wunder"],
    ["ControlOrMeta+Shift+s", "s", "wstrike"],
    ["ControlOrMeta+e", "code", "wcode"],
  ];
  for (const [combo, tag, word] of cases) {
    await freshParagraph(page);
    await page.keyboard.type(word);
    await selectToLineStart(page);
    await page.keyboard.press(combo);
    await expect(editor.locator(tag, { hasText: new RegExp(`^${word}$`) }), `${combo} → <${tag}>`).toHaveCount(1);
    await page.keyboard.press("ArrowRight"); // 收起選取，下一輪從這段尾開新段
  }
});

test("文字格式：選取文字後 Ctrl+K 加連結（不跳去搜尋） [sc:link]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "fmt-link");
  await page.keyboard.type("linkword");
  await selectToLineStart(page);
  await page.keyboard.press("ControlOrMeta+k");
  const urlInput = page.getByPlaceholder("Edit URL");
  await expect(urlInput).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: "Search notes" })).not.toBeFocused();
  await urlInput.fill("https://example.com/sc");
  await urlInput.press("Enter");
  await expect(editorLocator(page).locator('a[href="https://example.com/sc"]')).toHaveText("linkword");
});

test("文字格式：Ctrl+Z 復原、Ctrl+Y／Ctrl+Shift+Z 重做 [sc:undo] [sc:redo]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "fmt-undo");
  // 只量「撤銷後 second 消失、重做後回來」。連續輸入（含 Enter）在 y-prosemirror 的 captureTimeout（500 ms）內會併成同一個撤銷步，
  // 所以 Ctrl+Z 可能連 first 一起撤掉——這裡刻意不斷言 first 留著，也不聲稱「一次只撤一段」。
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect(editor).toContainText("second");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).not.toContain("second");
  await page.keyboard.press("ControlOrMeta+y");
  await expect.poll(() => blockTexts(page)).toContain("second");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).not.toContain("second");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => blockTexts(page)).toContain("second");
});

test("文字格式：Tab／Shift+Tab 縮排、Shift+Enter 段內換行 [sc:indent] [sc:lineBreak]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "fmt-indent");
  await page.keyboard.type("- top");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await expect(blocksOf(page, "bulletListItem")).toHaveCount(2);
  const nestedGroups = editor.locator(".bn-block-group .bn-block-group");
  await expect(nestedGroups).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(nestedGroups).toHaveCount(1); // 第二項成為第一項的子區塊
  await page.keyboard.press("Shift+Tab");
  await expect(nestedGroups).toHaveCount(0);

  // 一般段落也能縮排
  await freshParagraph(page);
  await page.keyboard.type("plain child");
  await page.keyboard.press("Tab");
  await expect(nestedGroups).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(nestedGroups).toHaveCount(0);

  await freshParagraph(page);
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  const para = editor.locator(".bn-block-content[data-content-type='paragraph']", { hasText: "line one" });
  await expect(para).toHaveCount(1); // 同一個區塊
  await expect(para.locator("br")).toHaveCount(1);
  await expect(para).toContainText("line two");
});

test("文字格式：Ctrl+Shift+↑／↓ 上下搬動段落 [sc:moveBlock]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "fmt-move");
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("bravo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("charlie");
  await waitForEditorSelection(page);
  expect(await blockTexts(page)).toEqual(["alpha", "bravo", "charlie"]);
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp"); // charlie 往上
  await expect.poll(() => blockTexts(page)).toEqual(["alpha", "charlie", "bravo"]);
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown"); // 再往下
  await expect.poll(() => blockTexts(page)).toEqual(["alpha", "bravo", "charlie"]);
});

// ── 並排 ───────────────────────────────────────────────────────────────────────────────────────

const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';

/** 主編輯器文件頂層形狀（同 34-columns 的 docShape）：`ROW[COL(paragraph:a) | COL(paragraph:b)]`。 */
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

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) })
    .last();
}

/** 點進某段文字、把游標放到開頭（Home）或結尾（End），等 ProseMirror 跟上。 */
async function caretIn(page: Page, text: string, where: "Home" | "End"): Promise<void> {
  await blockOuter(page, text).locator(".bn-inline-content").first().click();
  await page.keyboard.press(where);
  await waitForEditorSelection(page);
}

async function slashTitles(page: Page): Promise<string[]> {
  return (await page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title").allTextContents()).map((t) => t.trim());
}

test("並排：/ 選「2 columns」建立並排；游標在欄內時選單不提供 [sc:columnsInsert]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-insert");
  await page.keyboard.type("/grid");
  await expect.poll(() => slashTitles(page)).toEqual(expect.arrayContaining(["2 columns", "3 columns", "4 columns"]));
  await page.keyboard.press("Enter"); // 第一項＝2 columns
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(2);
  await waitForEditorSelection(page);
  // 游標現在在第 1 欄內：打 / → 選單出現（正向錨點：含 Heading 1），而且沒有 columns 項
  await page.keyboard.type("/");
  const menu = page.locator(".bn-suggestion-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => slashTitles(page)).toContain("Heading 1");
  expect((await slashTitles(page)).filter((t) => /columns/.test(t))).toEqual([]);
  await page.keyboard.press("Escape");
});

test("並排：欄首 Backspace 把這段搬到前一欄、欄尾 Delete 把下一欄第一段搬上來 [sc:columnBackspace] [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(120_000);
  await startNote(page, "cols-edge");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b", "c", "d"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]");

  // 第 2 欄的 b：開頭 Backspace → b 搬到第 1 欄尾端，第 2 欄（空了）被刪掉
  await caretIn(page, "b", "Home");
  await page.keyboard.press("Backspace");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a,paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]");

  // 第 1 欄尾端 b：Delete → 下一欄的第一段 c 搬上來接在 b 後，那欄（空了）被刪掉
  await caretIn(page, "b", "End");
  await page.keyboard.press("Delete");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a,paragraph:b,paragraph:c) | COL(paragraph:d)]");
});

test("並排：空欄裡按 Backspace 刪掉那欄、欄尾 Delete 遇到空的下一欄就刪掉它；只剩一欄時列拆回上下排 [sc:columnBackspace] [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await startNote(page, "cols-empty");
  await page.keyboard.type("/grid3");
  await expect.poll(() => slashTitles(page)).toEqual(["3 columns"]);
  await page.keyboard.press("Enter");
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(3);
  await waitForEditorSelection(page);
  await page.keyboard.type("keep");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph) | COL(paragraph)]");

  // 欄尾 Delete，下一欄是空的 → 刪掉它
  await page.keyboard.press("Delete");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph)]");

  // 最後那個空欄裡 Backspace → 刪掉它；只剩一欄，列拆回上下排
  await editor.locator(COL).nth(1).click();
  await waitForEditorSelection(page);
  await page.keyboard.press("Backspace");
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:keep");
});

test("並排：只有兩欄時欄尾 Delete 遇到空的第二欄 → 並排拆回上下段落 [sc:columnDelete]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-delete-last");
  await page.keyboard.type("/grid2");
  await expect.poll(() => slashTitles(page)).toEqual(["2 columns"]);
  await page.keyboard.press("Enter");
  await expect(editor.locator(ROW).first().locator(COL)).toHaveCount(2);
  await waitForEditorSelection(page);
  await page.keyboard.type("keep");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:keep) | COL(paragraph)]");
  await page.keyboard.press("Delete"); // 第一欄尾端、第二欄是空的 → 刪掉第二欄，只剩一欄 → 拆回上下排
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:keep");
});

test("並排：⋮⋮ 選單「Ungroup columns」拆回上下排 [sc:columnUngroup]", async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await startNote(page, "cols-ungroup");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["l", "r"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:l) | COL(paragraph:r)]");
  await blockOuter(page, "r").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Ungroup columns" }).click();
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:l  paragraph:r  paragraph:z");
});

// ── 滑鼠 ───────────────────────────────────────────────────────────────────────────────────────

test("滑鼠：拖 ⋮⋮ 搬移段落 [sc:dragBlock]", async ({ page }) => {
  test.setTimeout(90_000);
  await startNote(page, "mouse-drag");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("three");
  await waitForEditorSelection(page);
  expect(await blockTexts(page)).toEqual(["one", "two", "three"]);

  // 把 one 的 ⋮⋮ 拖到 three 的下半部放開 → one 排到最後
  await blockOuter(page, "one").hover();
  const handle = page.getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const t = (await blockOuter(page, "three").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10, h.y + h.height / 2 + 10, { steps: 5 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.75, { steps: 15 });
  await page.mouse.move(t.x + t.width / 2 + 2, t.y + t.height * 0.75);
  await page.mouse.up();
  await expect.poll(() => blockTexts(page)).toEqual(["two", "three", "one"]);
});

// ── 側欄（選取模式）────────────────────────────────────────────────────────────────────────────

test("側欄：選取模式 Esc 結束（焦點在內文時不作用）、Shift＋點連續選一段 [sc:selectEsc] [sc:selectRange]", async ({ page }) => {
  test.setTimeout(150_000);
  const titles = ["A", "B", "C", "D"].map((s) => `E2E sc sel ${s} ${RUN}`);
  await loginAs(page, ADMIN.email, ADMIN.password);
  for (const title of titles) {
    const res = await page.request.post("/api/notes", { data: { title } });
    expect(res.status(), await res.text()).toBe(201);
  }
  await page.goto("/");
  await showSidebarTab(page, "My notes");

  // Shift＋點：點第 1 篇、Shift＋點第 4 篇 → 中間兩篇也勾上
  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  await toggleSelectedNote(panel, titles[3]!, { shift: true });
  for (const title of titles) await expect(panel.getByRole("checkbox", { name: new RegExp("^" + title) })).toBeChecked();

  // 焦點在側欄裡（剛點過的勾選框）→ Esc 結束選取
  expect(await panel.locator(":focus").count(), "焦點在側欄的勾選框上").toBe(1);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  // 焦點在 body（點主內容區空白）→ Esc 結束選取
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  const main = page.getByRole("main");
  const box = (await main.boundingBox())!;
  await main.click({ position: { x: 24, y: box.height - 24 } });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  // 筆記頁、焦點在內文時 Esc 不結束選取
  await panel.getByRole("link", { name: new RegExp("^" + titles[1]) }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(titles[1]!, { timeout: 15_000 });
  await showSidebarTab(page, "My notes");
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, titles[0]!);
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.type("x");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: new RegExp("^" + titles[0]) })).toBeChecked();
});

// ── 簡報模式 ───────────────────────────────────────────────────────────────────────────────────

const DECK = ["Intro paragraph", "", "## Chapter A", "", "alpha text", "", "### Section A2", "", "a2 text", "", "## Chapter B", "", "beta text", ""].join("\n");

async function currentSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector(".reveal .slides section.present[data-kn-slide-id]")?.getAttribute("data-kn-slide-id") ?? null);
}

async function slideIdContaining(page: Page, text: string): Promise<string> {
  const id = await page.evaluate(
    (needle) => Array.from(document.querySelectorAll(".reveal .slides section[data-kn-slide-id]")).find((s) => s.textContent?.includes(needle))?.getAttribute("data-kn-slide-id") ?? null,
    text,
  );
  expect(id, `找不到含「${text}」的投影片`).not.toBeNull();
  return id!;
}

async function presentFromHeaderMenu(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test("簡報模式：→ ← 換章、↓ ↑ 換節 [sc:presentNav]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E sc present nav ${RUN}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
  await presentFromHeaderMenu(page, title);

  const start = await currentSlideId(page);
  await page.keyboard.press("ArrowRight");
  const chapterA = await slideIdContaining(page, "Chapter A");
  await expect.poll(() => currentSlideId(page)).toBe(chapterA);
  await page.keyboard.press("ArrowDown");
  const a2 = await slideIdContaining(page, "Section A2");
  await expect.poll(() => currentSlideId(page)).toBe(a2);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => currentSlideId(page)).toBe(chapterA);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => currentSlideId(page)).toBe(start);
});

test("簡報模式：F 切換全螢幕（從選單進入時已是全螢幕） [sc:presentFullscreen]", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E sc present fs ${RUN}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
  await presentFromHeaderMenu(page, title);

  const isFs = () => page.evaluate(() => document.fullscreenElement !== null);
  await expect.poll(isFs).toBe(true); // 從選單進簡報時已經在全螢幕
  await page.keyboard.press("f");
  await expect.poll(isFs).toBe(false); // F 先退出
  await page.waitForTimeout(350); // 防連退窗口：語意上的間隔，不是等待條件
  await page.keyboard.press("f");
  await expect.poll(isFs).toBe(true); // 再按回到全螢幕

  // 收尾：像瀏覽器的 Esc 那樣先退全螢幕，再按 Esc 離開簡報
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await page.waitForTimeout(350);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// ── AI ─────────────────────────────────────────────────────────────────────────────────────────

const PROVIDER_NAME = `E2E SC Provider ${RUN}`;
const MODEL_DISPLAY_NAME = `E2E SC Model ${RUN}`;

test.describe.serial("ai facts", () => {
  test("AI：建 provider（/fast，勾 Default model）", async ({ page }) => {
    test.setTimeout(90_000);
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
    await page.getByRole("row", { name: `${PROVIDER_NAME} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
    const modelDialog = page.getByRole("dialog", { name: "Add model" });
    await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-sc-model");
    await modelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await modelDialog.getByLabel("Default model", { exact: true }).check();
    await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(modelDialog).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  });

  test("AI：選取文字後工具列 AI 鈕開框；框內 Shift+Enter 換行、Enter 送出；Esc 關閉 [sc:aiSelect] [sc:aiSend] [sc:aiClose]", async ({ page }) => {
    test.setTimeout(120_000);
    await startNote(page, "ai");
    await page.keyboard.type("ai target text");
    await waitForEditorSelection(page);

    // aiSelect：三擊選段 → 工具列 AI 鈕 → 框出現
    const box = await openSelectionAiBox(page, "ai target text");

    // aiClose：框內 Esc 關閉
    await box.press("Escape");
    await expect(box).toBeHidden();

    // 再開一次，驗 aiSend
    const box2 = await openSelectionAiBox(page, "ai target text");
    const input = box2.getByRole("textbox", { name: "Instruction for the selected text" });
    await input.fill("first");
    await input.press("Shift+Enter");
    await input.pressSequentially("second");
    expect(await input.inputValue()).toBe("first\nsecond"); // Shift+Enter 換行、沒有送出
    await expect(selectionAiBox(page).getByTestId("selection-ai-preview")).toHaveCount(0);
    await input.press("Enter"); // Enter 送出
    await expect(selectionAiBox(page).getByTestId("selection-ai-preview")).toContainText("E2E rewritten text", { timeout: 15_000 });
  });
});

// ── 借用既有 e2e 的條目（標籤在那些檔裡）：presentOverview、presentExit → 22-presentation；dragNoteToEditor → 42-folders-drag 42-7；
//    dragNoteToFolder → 42-folders-drag 42-1、42-4；dragBlockCopy → 49-drag-undo U6。

// ── 快捷鍵介紹頁（Ctrl+/ modal）本身的行為──────────────────────────────────────────────────

const shortcutsDialog = (page: Page): Locator => page.getByRole("dialog", { name: "Keyboard shortcuts" });

/** 簡報：頁首 ⋮「Present」進入，等 reveal 就緒。 */
async function presentFromHeaderMenuForDialog(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test.describe("shortcuts dialog", () => {
  test("E1 寬螢幕：Ctrl+/ 開啟、內文不多一個 /、PageDown 可捲、Tab 在內容與 ✕ 間循環、Esc 關閉後游標回原處 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    const editor = await startNote(page, "dlg-open");
    await page.keyboard.type("abc");
    await waitForEditorSelection(page);
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    // 預設停在「通用」：左欄 aria-current、右卡 region 名稱與標題都是 General
    await expect(dialog.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 3, name: "General" })).toBeVisible();
    await expect(editor).toContainText("abc");
    expect(await blockTexts(page)).toEqual(["abc"]); // 沒有多一個 /
    await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);

    // 開啟後焦點就在右卡內容區；Tab 到 ✕（內容區是最後一個可聚焦元素）、Shift+Tab 回來
    const content = dialog.locator("[data-shortcuts-content]");
    await expect(content).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(content).toBeFocused();

    // 選分類（寬螢幕）：焦點留在被點的項次、右卡換成那一類；「Text formatting」夠長，點進內容區後 PageDown 能捲
    const formatting = dialog.getByRole("button", { name: "Text formatting" });
    await formatting.click();
    await expect(formatting).toHaveAttribute("aria-current", "true");
    await expect(dialog.getByRole("button", { name: "General" })).not.toHaveAttribute("aria-current", "true");
    await expect(formatting).toBeFocused();
    await expect(dialog.getByRole("region", { name: "Text formatting" })).toBeVisible();
    await expect(dialog.locator('[data-shortcut-id="search"]')).toHaveCount(0);
    await expect(dialog.locator('[data-shortcut-id="bold"]')).toHaveCount(1);
    await content.click({ position: { x: 4, y: 4 } });
    await expect(content).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Radix 卸載後才排 setTimeout(0) 還焦點：先等焦點真的回到編輯器再打字，否則「d」可能搶在還焦點之前（偶發紅的來源）
    await expect(editor).toBeFocused();
    await page.keyboard.type("d");
    await expect.poll(() => blockTexts(page)).toEqual(["abcd"]); // 焦點與游標回到原處
  });

  test("E2 從使用者選單打開，Esc 後焦點回觸發鈕 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-menu");
    const trigger = page.getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    const item = page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true });
    await expect(item).toContainText("Ctrl+/");
    await item.click();
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("E3 再按一次 Ctrl+/ 關閉 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-toggle");
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
  });

  test("E4 設定 modal 開著時 Ctrl+/ 不開快捷鍵頁 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-other");
    await page.getByRole("button", { name: "admin", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\//);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1); // 還是只有設定那一個
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("E5 AI 段與站台能力一致 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-ai");
    const res = await page.request.get("/api/ai/actions");
    expect(res.ok()).toBe(true);
    const { actions } = (await res.json()) as { actions: Array<{ kind: string }> };
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
    const aiNav = dialog.getByRole("button", { name: "AI", exact: true });
    await expect(aiNav).toHaveCount(actions.length > 0 ? 1 : 0); // 站台沒有 AI 時整個分類不出現
    if (actions.length > 0) {
      await aiNav.click();
      await expect(dialog.getByRole("region", { name: "AI" })).toBeVisible();
    }
    await expect(dialog.locator('[data-shortcut-id="aiSend"]')).toHaveCount(actions.some((a) => a.kind === "instruct") ? 1 : 0);
    test.info().annotations.push({ type: "e5-site", description: `actions=${actions.length} instruct=${actions.some((a) => a.kind === "instruct")}` });
  });

  test("E6b 手機（390 寬）：筆記畫面按 Ctrl+K 回到清單並聚焦底部搜尋框、Esc 收起搜尋；從頂列頭像開快捷鍵頁，Esc 只關快捷鍵頁 [sc:search] [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-phone");
    await page.setViewportSize({ width: 390, height: 844 });
    const search = page.getByRole("textbox", { name: "Search notes", exact: true });
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    await expect(search).toBeHidden();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(search).not.toBeFocused();
    await expect(page.locator("[data-phone-list-bar]").getByRole("button", { name: "New note", exact: true })).toBeVisible();

    const trigger = page.locator("[data-phone-top-bar]").getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("E6 浮動側欄（700 寬）：Ctrl+K 先打開側欄；從抽屜裡的使用者選單開快捷鍵頁，抽屜仍在，Esc 只關快捷鍵頁 [sc:search] [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-narrow");
    await page.setViewportSize({ width: 700, height: 844 });
    // search 說明的「窄螢幕會先打開側欄」：Ctrl+K 開抽屜並把焦點放進抽屜裡的搜尋框
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("textbox", { name: "Search notes" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(drawer).toBeVisible();
    const trigger = drawer.getByRole("button", { name: "admin", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    // 快捷鍵頁開著時抽屜被 Radix 標成 aria-hidden（預期行為），所以用屬性選擇器、不用 getByRole
    await expect(page.locator("[data-sidebar-drawer]")).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    // 窄螢幕一次只顯示一塊：打開先看到右卡（通用）；左卡（分類＋提示句）在「返回」之後
    await expect(dialog.getByRole("region", { name: "General" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Text formatting" })).toBeHidden();
    await dialog.getByRole("button", { name: "Back to sections" }).click();
    const footer = dialog.locator("[data-shortcuts-footer]");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(dialog.getByRole("button", { name: "General" })).toBeFocused(); // 焦點回到目前項次
    await dialog.getByRole("button", { name: "Mouse" }).click();
    const mouseRegion = dialog.getByRole("region", { name: "Mouse" });
    await expect(mouseRegion).toBeVisible();
    await expect(mouseRegion).toBeFocused(); // 窄螢幕選分類後焦點進內容區
    await expect(dialog.getByRole("button", { name: "General" })).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("E9 左欄每個分類都點得進去，右卡只顯示所選分類（標題＝region 名稱＝aria-current 那一項）", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-cats");
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-shortcuts-category]").first()).toBeVisible(); // 內容 chunk 到了
    const names = await dialog.locator("[data-shortcuts-category]").allTextContents();
    expect(names.slice(0, 3)).toEqual(["General", "Typing triggers", "Markdown shortcuts"]);
    for (const name of names) {
      await dialog.getByRole("button", { name, exact: true }).click();
      await expect(dialog.getByRole("button", { name, exact: true })).toHaveAttribute("aria-current", "true");
      await expect(dialog.getByRole("region", { name, exact: true })).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
      await expect(dialog.locator("[data-shortcut-id]").first()).toBeVisible();
    }
  });

  test("E10 Ctrl+, 打開設定（內文裡也行）；設定開著時再按不動作；關閉回到原筆記頁 [sc:openSettings]", async ({ page }) => {
    test.setTimeout(90_000);
    const editor = await startNote(page, "dlg-settings");
    await page.keyboard.type("abc");
    await waitForEditorSelection(page);
    const noteUrl = page.url();
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    // 設定開著：再按不動作。網址與對話框數量不變不夠（背景頁的 location 沒變，重導一次結果一樣）——另看 history 沒有多一筆
    const historyBefore = await page.evaluate(() => history.length);
    await page.keyboard.press("ControlOrMeta+,");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(0)))));
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    // 帶了 backgroundLocation：關閉回到原本那篇，內文還在
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(noteUrl);
    await expect(editor).toContainText("abc");
    expect(await blockTexts(page)).toEqual(["abc"]); // 編輯器沒對 Ctrl+, 做任何事（內文還是 abc）
  });

  test("E7 簡報模式中 Ctrl+/ 不開快捷鍵頁 [sc:openShortcuts]", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, ADMIN.email, ADMIN.password);
    const title = `E2E sc present dlg ${RUN}`;
    await createNote(page, title);
    await pasteMarkdown(page, DECK);
    await expect(editorLocator(page).getByText("beta text")).toBeVisible({ timeout: 15_000 });
    await presentFromHeaderMenuForDialog(page, title);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(shortcutsDialog(page)).toHaveCount(0);
    // 收尾：全螢幕中的 Esc 被瀏覽器吃掉，先像瀏覽器那樣退全螢幕，再按 Esc 離開簡報
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  // 已知副作用：`/` 要按 Shift 的鍵盤配置（例：德文 Ctrl+Shift+7，key="/"、keyCode=55）。prosemirror-keymap 在有 Ctrl 時以 keyCode 退回比對，
  // 於編輯器內會命中 BlockNote 的 Mod-Shift-7（轉編號清單）。這案用 CDP 模擬，只記錄實測結果並斷言它（docs/known-limitations.md 據此寫）。
  test("E8 德文式 Ctrl+Shift+7（key=/）：編輯器內與編輯器外各自的結果", async ({ page }) => {
    test.setTimeout(90_000);
    await startNote(page, "dlg-de");
    await page.keyboard.type("seven");
    await waitForEditorSelection(page);
    const cdp = await page.context().newCDPSession(page);
    const send = async () => {
      const base = { key: "/", code: "Digit7", windowsVirtualKeyCode: 55, nativeVirtualKeyCode: 55, modifiers: 2 | 8 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    // ① 焦點在內文
    await send();
    await page.waitForTimeout(500); // 記錄用：給事件處理時間，不是等待條件
    const inEditor = { blockType: await caretBlockType(page), dialog: await shortcutsDialog(page).count() };
    test.info().annotations.push({ type: "e8-in-editor", description: JSON.stringify(inEditor) });
    // ② 焦點在 body（點主內容區空白）
    if (inEditor.dialog > 0) await page.keyboard.press("Escape");
    const main = page.getByRole("main");
    const mainBox = (await main.boundingBox())!;
    await main.click({ position: { x: 24, y: mainBox.height - 24 } });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await send();
    await expect(shortcutsDialog(page)).toHaveCount(1); // 正向：內文外照常開（重試式斷言，不靠固定等待）
    const onBody = { dialog: await shortcutsDialog(page).count() };
    test.info().annotations.push({ type: "e8-on-body", description: JSON.stringify(onBody) });
    // 實測（Chromium、CDP 模擬）：內文裡那段被轉成編號清單、沒有開快捷鍵頁；內文外照常開。docs/known-limitations.md 據此寫。
    expect(inEditor).toEqual({ blockType: "numberedListItem", dialog: 0 });
    expect(onBody).toEqual({ dialog: 1 });
  });
});
