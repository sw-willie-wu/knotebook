import { writeFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * #269 站內連結（spec §15.3）：E1 點擊語意（讀者／編輯者都同分頁跳轉、修飾鍵新分頁、編輯者 hover 出工具列）、E2 段落錨點、E3 複製入口、
 * E4 三條寫入路徑轉 wikilink＋反向連結、E5 公開頁。E6 在 22-presentation.spec.ts。
 * C1–C3 是前面 task 留給真瀏覽器確認的項目（選取含 wikilink 的複製／拖曳、A 工具列開著時 hover 到 B、過期分頁）；
 * C4 是 rev 7 的觸控（wikilink 與一般連結：長按出工具列、短按跳轉）。
 *
 * - wikilink 一律以 `[data-inline-content-type="wikilink"]` 定位（BlockNote 對 inline content 外層加的屬性）。
 * - e2e package 不 import `@knotebook/shared`（rsync 不帶 dist；同 11-public-share 檔頭的裁決），網址自組。
 * - 唯讀的編輯器（viewer、公開頁）沒有 `contenteditable="true"`，`editorLocator` 找不到——那些情境以頁面容器為範圍。
 */

const ORIGIN = "http://localhost:3100";
const WIKILINK = '[data-inline-content-type="wikilink"]';

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
}

/** 把文字放進剪貼簿後在目前游標處 Ctrl+V（呼叫端負責游標）。 */
async function pasteAtCaret(page: Page, text: string): Promise<void> {
  await grantClipboard(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+v");
}

/** 在筆記最後貼上 markdown（22-presentation 的 pasteMarkdown 同形；Ctrl+End 後等 ProseMirror 讀回選取再貼，同 34-columns）。 */
async function appendMarkdown(page: Page, markdown: string): Promise<void> {
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await pasteAtCaret(page, markdown);
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** 文字恰為 `text` 的區塊外層（`.bn-block-outer`）。巢狀時取最內層（DOM 序上祖先在前，取 last）。 */
function blockOuterIn(root: Locator, text: string): Locator {
  return root
    .locator(".bn-block-outer")
    .filter({ has: root.page().locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

function blockOuter(page: Page, text: string): Locator {
  return blockOuterIn(editorLocator(page), text);
}

async function blockIdOf(page: Page, text: string): Promise<string> {
  const id = await blockOuter(page, text).getAttribute("data-id");
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  return id!;
}

type WikilinkAttrs = { targetNoteId: string; label: string; anchorBlockId: string };

/** 主編輯器 ProseMirror 文件裡所有 wikilink 節點的 props（文件序）。讀 Tiptap 掛在 contenteditable 上的 editor（同 `waitForEditorSelection`）。 */
async function wikilinkAttrs(page: Page): Promise<WikilinkAttrs[]> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; attrs: Record<string, string>; descendants(f: (n: PmNode) => boolean | void): void };
    const view = (el as Element & { editor?: { view?: { state: { doc: PmNode } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const out: WikilinkAttrs[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === "wikilink") out.push({ targetNoteId: n.attrs.targetNoteId!, label: n.attrs.label!, anchorBlockId: n.attrs.anchorBlockId! });
    });
    return out;
  });
}

/** admin 以邀請建一個帳號 → 新 context 登入。回傳已登入、停在 `/` 的 page。 */
async function createViewer(browser: Browser, adminPage: Page): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const email = randomEmail();
  const password = "e2e-sitelinks-user-pw";
  await createUserViaInvite(adminPage, { email, password, displayName: "E2E Site Links Viewer" });

  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, password);
  await expect(page).toHaveURL(/\/$/);
  return { context, page, email };
}

/** 目前筆記分享給 email（預設角色 viewer）。 */
async function shareWith(page: Page, email: string): Promise<void> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /Members only/ }).click();
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByText(email)).toBeVisible();
  await page.keyboard.press("Escape");
}

/** 目前筆記開公開連結（匿名 token 形），回傳 token。 */
async function makePublicToken(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /^Public link/ }).check();
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toHaveValue(/^[A-Za-z0-9_-]{43}$/, { timeout: 10_000 });
  const token = await input.inputValue();
  await page.keyboard.press("Escape");
  return token;
}

/** 目前筆記開公開連結並關掉 Anonymous link（自訂網址形），回傳 `/p/<handle>/<name>`（11-public-share 的 readAliasPath 同形）。 */
async function makePublicCustom(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /^Public link/ }).check();
  const toggle = dialog.getByRole("switch", { name: "Anonymous link" });
  await expect(toggle).toBeChecked({ timeout: 10_000 });
  await toggle.click();
  const aliasInput = dialog.getByLabel("Custom public link", { exact: true });
  await expect(aliasInput).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => aliasInput.inputValue()).not.toBe("");
  const prefix = await dialog.locator("#share-public-slug-prefix").innerText();
  expect(prefix).toMatch(/^\/p\/[a-z0-9-]+\/$/);
  const path = `${prefix}${await aliasInput.inputValue()}`;
  await page.keyboard.press("Escape");
  return path;
}

async function backlinkIds(page: Page, noteId: string): Promise<string[]> {
  const res = await page.request.get(`/api/notes/${noteId}/backlinks`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { backlinks: Array<{ id: string }> }).backlinks.map((b) => b.id);
}

/**
 * 段落錨點的高亮（#269 §10.2）：useBlockAnchor 在 ProseMirror 管轄外疊一層 `.kn-anchor-flash[data-anchor-flash="<id>"]` 浮層。
 * 斷言：浮層出現、蓋在該區塊上（±1px）、在可編輯 DOM 之外、有動畫；300 ms 後仍在（舊作法把屬性掛在 `.bn-block-outer` 上，可編輯時
 * ProseMirror 約 70 ms 內就把那個元素換掉、高亮跟著消失——Task 19 探針實測）。
 */
async function expectAnchorFlash(page: Page, blockId: string): Promise<void> {
  const overlay = page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`);
  await expect(overlay).toBeAttached({ timeout: 15_000 });
  const geo = await overlay.evaluate((el, id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    return {
      dTop: Math.abs(o.top - block.top),
      dLeft: Math.abs(o.left - block.left),
      dWidth: Math.abs(o.width - block.width),
      dHeight: Math.abs(o.height - block.height),
      inEditable: el.closest('[contenteditable="true"], .ProseMirror') !== null,
      animation: getComputedStyle(el).animationName,
    };
  }, blockId);
  expect(geo).toEqual({ dTop: expect.any(Number), dLeft: expect.any(Number), dWidth: expect.any(Number), dHeight: expect.any(Number), inEditable: false, animation: "kn-anchor-flash" });
  for (const d of [geo.dTop, geo.dLeft, geo.dWidth, geo.dHeight]) expect(d).toBeLessThanOrEqual(1);
  await page.waitForTimeout(300);
  await expect(overlay).toBeAttached();
}

/** 標題「#」鈕與標題文字首行的幾何（相對視窗）。 */
async function headingButtonGeometry(outer: Locator): Promise<{ lineMid: number; lineRight: number; buttonMid: number; buttonLeft: number }> {
  return outer.evaluate((el) => {
    const inline = el.querySelector(":scope > .bn-block > .bn-block-content > .bn-inline-content")!;
    const range = document.createRange();
    range.selectNodeContents(inline);
    const line = range.getClientRects()[0]!;
    const button = document.querySelector('button[aria-label="Copy link to this section"]')!.getBoundingClientRect();
    return { lineMid: line.top + line.height / 2, lineRight: line.right, buttonMid: button.top + button.height / 2, buttonLeft: button.left };
  });
}

test("E1：讀者一般點擊同分頁導航；Ctrl+Click 與中鍵開新分頁；編輯者 hover 出工具列（沒有「開啟」）、一般點擊同分頁跳轉", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  let viewer: { context: BrowserContext; page: Page; email: string } | undefined;
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    viewer = await createViewer(browser, admin);
    const stamp = String(Date.now());

    const targetTitle = `E2E sl target ${stamp}`;
    await createNote(admin, targetTitle);
    const targetPath = new URL(admin.url()).pathname;
    const targetId = await noteIdFromUrl(admin);
    await shareWith(admin, viewer.email);

    await createNote(admin, `E2E sl source ${stamp}`);
    const sourceUrl = admin.url();
    await shareWith(admin, viewer.email);
    await appendMarkdown(admin, `see [${targetTitle}](/notes/${targetId})\n`);
    const adminLink = editorLocator(admin).locator(WIKILINK);
    await expect(adminLink).toHaveCount(1, { timeout: 10_000 });

    // 編輯者：hover 出工具列（三鈕、沒有「開啟」）、不導航；Esc 關
    await adminLink.hover();
    const adminToolbar = admin.getByRole("dialog", { name: "Note link" });
    await expect(adminToolbar).toHaveAttribute("data-state", "open");
    await expect(adminToolbar.getByRole("button")).toHaveText(["Edit text", "Change target", "Remove link"]);
    expect(admin.url()).toBe(sourceUrl);
    await admin.keyboard.press("Escape");
    await expect(adminToolbar).not.toBeVisible();

    // 編輯者：Ctrl/Cmd+Click（contenteditable 內的 contentEditable=false 島——spec §7.2【推】的量測點）⇒ 新分頁、原分頁不動
    // （滑鼠停在連結上，hover 工具列可能出現——那是 hover 的行為，不在這裡斷言）
    // 雲端偶發等不到新分頁（run 40182358217：trace 裡點擊落在 <a> 上、點擊後編輯器失焦，卻沒有 page 事件；根因未明）。
    // 只在失敗時輸出診斷（console＋test-results 下的 e1-ctrl-click-diagnostics.txt）：page／popup／導航事件、點擊事件有沒有到、
    // 有沒有被 preventDefault、點擊後的焦點與選取、連結中心點上是什麼元素。成功時不輸出、不改變行為（監聽都是被動的）。
    const diag: string[] = [];
    const diagStart = Date.now();
    const note = (line: string) => diag.push(`+${Date.now() - diagStart}ms ${line}`);
    const onContextPage = (p: Page) => note(`context "page": ${p.url()}`);
    const onPopup = (p: Page) => note(`admin "popup": ${p.url()}`);
    const onNavigated = (f: Frame) => {
      if (f === admin.mainFrame()) note(`admin framenavigated: ${f.url()}`);
    };
    adminContext.on("page", onContextPage);
    admin.on("popup", onPopup);
    admin.on("framenavigated", onNavigated);
    await admin.evaluate(() => {
      const log: string[] = [];
      (window as unknown as { __e1Events: string[] }).__e1Events = log;
      const describe = (t: EventTarget | null) => (t instanceof Element ? `${t.tagName}.${String(t.className).slice(0, 30)}` : String(t));
      for (const type of ["pointerdown", "mousedown", "mouseup", "click", "auxclick"]) {
        // capture＝事件有沒有到；bubble（window 最後一站）＝有沒有被攔（沒記到就是被 stopPropagation）、有沒有 preventDefault
        window.addEventListener(type, (e) => log.push(`${type} capture target=${describe(e.target)} ctrl=${(e as MouseEvent).ctrlKey}`), { capture: true, passive: true });
        window.addEventListener(type, (e) => log.push(`${type} bubble defaultPrevented=${e.defaultPrevented}`), { passive: true });
      }
      window.addEventListener("blur", () => log.push("window blur"));
    });
    let editorCtrlPage: Page;
    try {
      const editorCtrlPromise = adminContext.waitForEvent("page", { timeout: 10_000 });
      // click 自己拋錯時這個 promise 沒人 await，10 s 後的逾時會變成未處理的 rejection：先掛一個空 catch（下面照常 await，失敗仍會拋）
      editorCtrlPromise.catch(() => undefined);
      await adminLink.locator("a").click({ modifiers: ["ControlOrMeta"] });
      note(`click returned: admin.url=${admin.url()}`);
      editorCtrlPage = await editorCtrlPromise;
    } catch (err) {
      note(`failed: admin.url=${admin.url()} contextPages=${JSON.stringify(adminContext.pages().map((p) => p.url()))} pagesPerContext=${JSON.stringify(browser.contexts().map((c) => c.pages().length))}`);
      const state = await admin
        .evaluate(() => {
          const link = document.querySelector('[data-testid="note-editor"] [data-inline-content-type="wikilink"] a');
          const rect = link?.getBoundingClientRect();
          const atCenter = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
          const ce = document.querySelector('[data-testid="note-editor"] [contenteditable="true"]') as (Element & { editor?: { view?: { state: { selection: { toJSON(): unknown } } } } }) | null;
          const active = document.activeElement;
          return {
            events: (window as unknown as { __e1Events?: string[] }).__e1Events ?? null,
            hasFocus: document.hasFocus(),
            visibility: document.visibilityState,
            activeElement: active ? `${active.tagName}.${String(active.className).slice(0, 40)}` : null,
            pmFocused: document.querySelector(".ProseMirror-focused") !== null,
            pmSelection: ce?.editor?.view?.state.selection.toJSON() ?? null,
            openToolbars: document.querySelectorAll('[role="dialog"][aria-label="Note link"][data-state="open"]').length,
            elementAtLinkCenter: atCenter ? `${atCenter.tagName}.${String(atCenter.className).slice(0, 40)}` : null,
            linkIsAtCenter: !!link && !!atCenter && (atCenter === link || link.contains(atCenter)),
          };
        })
        .catch((e: unknown) => `evaluate failed: ${String(e)}`);
      note(`page state: ${JSON.stringify(state)}`);
      const report = `[E1 Ctrl+Click 診斷]\n${diag.join("\n")}`;
      console.log(report);
      writeFileSync(test.info().outputPath("e1-ctrl-click-diagnostics.txt"), report, "utf8");
      throw err;
    } finally {
      adminContext.off("page", onContextPage);
      admin.off("popup", onPopup);
      admin.off("framenavigated", onNavigated);
    }
    await editorCtrlPage.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(admin.url()).toBe(sourceUrl);
    await editorCtrlPage.close();

    // 編輯者：一般點擊同分頁跳轉（rev 7：不再是「點擊開工具列」）
    const adminPagesBefore = adminContext.pages().length;
    await adminLink.locator("a").click();
    await admin.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(adminContext.pages().length).toBe(adminPagesBefore);

    // 讀者：清單到了 ⇒ <a href=canonical>
    const vp = viewer.page;
    await vp.goto(sourceUrl);
    await expect(vp.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const link = vp.locator(`[data-testid="note-editor"] ${WIKILINK} a`, { hasText: targetTitle });
    await expect(link).toHaveAttribute("href", targetPath, { timeout: 10_000 });

    // Ctrl/Cmd+Click：新分頁、原分頁不動（修飾鍵實測——見 Step 5）
    const ctrlPagePromise = viewer.context.waitForEvent("page", { timeout: 10_000 });
    await link.click({ modifiers: ["ControlOrMeta"] });
    const ctrlPage = await ctrlPagePromise;
    await ctrlPage.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(vp.url()).toBe(sourceUrl);
    await ctrlPage.close();

    // 中鍵：新分頁、原分頁不動
    const middlePagePromise = viewer.context.waitForEvent("page", { timeout: 10_000 });
    await link.click({ button: "middle" });
    const middlePage = await middlePagePromise;
    await middlePage.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(vp.url()).toBe(sourceUrl);
    await middlePage.close();

    // 一般點擊：同分頁導航（不開新分頁）
    const pagesBefore = viewer.context.pages().length;
    await link.click();
    await vp.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    await expect(vp.getByRole("heading", { name: targetTitle, level: 1 })).toBeVisible({ timeout: 15_000 });
    expect(viewer.context.pages().length).toBe(pagesBefore);
  } finally {
    await viewer?.context.close();
    await adminContext.close();
  }
});

test("E2：開 #b-<id> 捲到並高亮；不存在的 id 停頂端無錯；?present#b- 不捲；同篇錨點不重載、上一頁回到點擊前", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl anchor ${stamp}`);
    const noteUrl = page.url();
    const notePath = new URL(noteUrl).pathname;
    const noteId = await noteIdFromUrl(page);
    const paras = Array.from({ length: 40 }, (_, i) => `para ${i + 1}`);
    await appendMarkdown(page, paras.join("\n\n") + "\n");
    await expect(editorLocator(page).getByText("para 40", { exact: true })).toBeVisible({ timeout: 15_000 });
    const targetId = await blockIdOf(page, "para 35");

    // 冷開：新分頁直接開 #b-<id>
    const cold = await context.newPage();
    const coldErrors: string[] = [];
    cold.on("pageerror", (e) => coldErrors.push(e.message));
    await cold.goto(`${noteUrl}#b-${targetId}`);
    const coldTarget = cold.locator(`.bn-block-outer[data-id="${targetId}"]`);
    await expectAnchorFlash(cold, targetId); // 擁有者＝可編輯編輯器：高亮浮層要撐過 ProseMirror 的重繪
    await expect(coldTarget).toBeInViewport();
    expect(coldErrors).toEqual([]);

    // 不存在的 id：停頂端、無錯（等過 2 s 放棄窗口）
    const missing = await context.newPage();
    const missingErrors: string[] = [];
    missing.on("pageerror", (e) => missingErrors.push(e.message));
    await missing.goto(`${noteUrl}#b-doesnotexist`);
    await expect(missing.locator(`.bn-block-outer[data-id="${targetId}"]`)).toBeAttached({ timeout: 15_000 });
    await missing.waitForTimeout(2_500);
    await expect(missing.getByText("para 1", { exact: true })).toBeInViewport();
    expect(missingErrors).toEqual([]);
    await missing.close();
    await cold.close();

    // 簡報播放中（?present）忽略 #b-（spec §10.1）：底下的筆記不捲。守衛是 not.toBeInViewport（para 35 在 40 段裡，不捲就在視窗外）；
    // 不斷高亮浮層——等了 1.5 s，就算錨點被消耗、浮層也可能已到期移除，0 個證明不了什麼。
    const present = await context.newPage();
    await present.goto(`${noteUrl}?present#b-${targetId}`);
    await expect(present.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    const presentTarget = present.locator(`.bn-block-outer[data-id="${targetId}"]`);
    await expect(presentTarget).toBeAttached();
    await present.waitForTimeout(1_500); // 簡報 ready 要求 synced；錨點若被消耗，會在 sync 當下捲動——多等一拍
    await expect(presentTarget).not.toBeInViewport();
    await present.close();

    // 同篇錨點：文首加一個指向本篇 para 35 的連結（自連結轉換，RF5 的 client 半），編輯模式直接點（rev 7）
    await editorLocator(page).getByText("para 1", { exact: true }).click();
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await pasteAtCaret(page, `[jump](/notes/${noteId}#b-${targetId}) `);
    const jump = editorLocator(page).locator(WIKILINK, { hasText: "jump" });
    await expect(jump).toHaveCount(1, { timeout: 10_000 });
    await page.evaluate(() => {
      (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
    });
    await jump.locator("a").click();
    await page.waitForURL((u) => u.pathname === notePath && u.hash === `#b-${targetId}`, { timeout: 10_000 });
    await expect(page.locator(`.bn-block-outer[data-id="${targetId}"]`)).toBeInViewport({ timeout: 5_000 });
    await expectAnchorFlash(page, targetId);
    expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);

    // 上一頁回到點擊前（PUSH，不是 REPLACE——T9-M4 的觀察點）且仍不重載
    await page.goBack();
    await page.waitForURL((u) => u.pathname === notePath && u.hash === "", { timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
  } finally {
    await context.close();
  }
});

test("E3：拖曳把手「Copy link to block」與標題「#」寫入剪貼簿的網址正確；「#」在首行垂直置中；viewer 也有「#」、沒有把手選單", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  let viewer: { context: BrowserContext; page: Page; email: string } | undefined;
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    viewer = await createViewer(browser, admin);
    await createNote(admin, `E2E sl copy ${Date.now()}`);
    const noteUrl = admin.url();
    const notePath = new URL(noteUrl).pathname;
    await shareWith(admin, viewer.email);
    await appendMarkdown(admin, "## Copy heading\n\ncopy para\n");
    await expect(editorLocator(admin).getByText("copy para", { exact: true })).toBeVisible({ timeout: 15_000 });
    const paraId = await blockIdOf(admin, "copy para");
    const headingId = await blockIdOf(admin, "Copy heading");
    await grantClipboard(admin);

    // 拖曳把手選單
    await blockOuter(admin, "copy para").hover();
    await admin.getByRole("button", { name: "Open block menu" }).click();
    await admin.getByRole("menuitem", { name: "Copy link to block" }).click();
    await expect(admin.getByText("Block link copied", { exact: true }).first()).toBeVisible();
    expect(await readClipboard(admin)).toBe(`${ORIGIN}${notePath}#b-${paraId}`);

    // 標題「#」（編輯者；Task 15 I1 把它搬到文字右側，避開側邊選單）
    await blockOuter(admin, "Copy heading").hover();
    const hash = admin.getByRole("button", { name: "Copy link to this section" });
    await expect(hash).toBeVisible();
    // 幾何（Task 15 m2）：「#」在標題文字首行垂直置中、在文字右側
    const geo = await headingButtonGeometry(blockOuter(admin, "Copy heading"));
    expect(Math.abs(geo.buttonMid - geo.lineMid)).toBeLessThanOrEqual(1);
    expect(geo.buttonLeft).toBeGreaterThanOrEqual(geo.lineRight);
    await hash.click();
    expect(await readClipboard(admin)).toBe(`${ORIGIN}${notePath}#b-${headingId}`);

    // viewer：有「#」、沒有把手選單（唯讀編輯器沒有 contenteditable="true"，以 note-editor 容器為範圍）
    const vp = viewer.page;
    await grantClipboard(vp);
    await vp.goto(noteUrl);
    await expect(vp.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const viewerEditor = vp.getByTestId("note-editor");
    await blockOuterIn(viewerEditor, "Copy heading").hover();
    await vp.getByRole("button", { name: "Copy link to this section" }).click();
    expect(await readClipboard(vp)).toBe(`${ORIGIN}${notePath}#b-${headingId}`);
    await blockOuterIn(viewerEditor, "copy para").hover();
    await expect(vp.getByRole("button", { name: "Open block menu" })).toHaveCount(0);

    // 編輯者：「#」顯示中、標題被刪掉（游標不動）⇒「#」收起（Task 15 m3）
    await blockOuter(admin, "Copy heading").hover();
    await expect(hash).toBeVisible();
    await editorLocator(admin).evaluate((el, text) => {
      type PmNode = { type: { name: string }; nodeSize: number; textContent: string; firstChild: PmNode | null; descendants(f: (n: PmNode, pos: number) => boolean | void): void };
      type View = { state: { doc: PmNode; tr: { delete(from: number, to: number): unknown } }; dispatch(tr: unknown): void };
      const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
      let range: [number, number] | null = null;
      view.state.doc.descendants((n, pos) => {
        if (range) return false;
        if (n.type.name === "blockContainer" && n.firstChild?.type.name === "heading" && n.firstChild.textContent === text) range = [pos, pos + n.nodeSize];
        return true;
      });
      if (!range) throw new Error("heading not found");
      view.dispatch(view.state.tr.delete(range[0], range[1]));
    }, "Copy heading");
    await expect(blockOuter(admin, "Copy heading")).toHaveCount(0);
    await expect(hash).toHaveCount(0);
  } finally {
    await viewer?.context.close();
    await adminContext.close();
  }
});

test("E4：段落中間貼 [x](/n/…)、連結對話框輸入 /g/…、打 http://…/notes/<id> 加空白 → 皆成 wikilink，且出現在目標的反向連結", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());

    await createNote(page, `E2E sl t1 ${stamp}`);
    const t1Path = new URL(page.url()).pathname; // /n/<handle>/<slug>
    const t1Id = await noteIdFromUrl(page);
    await createNote(page, `E2E sl t3 ${stamp}`);
    const t3Id = await noteIdFromUrl(page);

    // 群組筆記（/g/…）：API 建群組與群組筆記
    const groupRes = await page.request.post("/api/groups", { headers: { Origin: ORIGIN }, data: { name: `E2E sl group ${stamp}` } });
    expect(groupRes.status()).toBe(201);
    const groupId = ((await groupRes.json()) as { id: string }).id;
    const t2Res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title: `E2E sl t2 ${stamp}`, groupId } });
    expect(t2Res.status()).toBe(201);
    const t2 = (await t2Res.json()) as { id: string; slug: string };
    const t2Path = `/g/${groupId}/${t2.slug}`;

    await createNote(page, `E2E sl writer ${stamp}`);
    const sourceId = await noteIdFromUrl(page);
    const wikilinks = editorLocator(page).locator(WIKILINK);

    // (a) 段落中間行內貼 markdown 連結
    await editorLocator(page).click();
    await page.keyboard.type("alpha omega");
    await page.keyboard.press("Home");
    for (let i = 0; i < "alpha ".length; i += 1) await page.keyboard.press("ArrowRight");
    await waitForEditorSelection(page);
    await pasteAtCaret(page, `[x](${t1Path})`);
    await expect(wikilinks.filter({ hasText: "x" })).toHaveCount(1, { timeout: 10_000 });

    // (b) 連結對話框（`/` 選單的 Link）輸入 /g/…
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/Link");
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    const linkDialog = page.getByRole("dialog", { name: "Insert link" });
    await linkDialog.getByLabel("Display text").fill("group target");
    await linkDialog.getByLabel("URL").fill(t2Path);
    await linkDialog.getByRole("button", { name: "Insert" }).click();
    await expect(wikilinks.filter({ hasText: "group target" })).toHaveCount(1, { timeout: 10_000 });

    // (c) 打完整網址加空白（autolink）
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`${ORIGIN}/notes/${t3Id} `);
    await expect(wikilinks).toHaveCount(3, { timeout: 10_000 });

    // 反向連結（client 送出連結集合有 debounce——輪詢）
    for (const target of [t1Id, t2.id, t3Id]) {
      await expect(async () => {
        expect(await backlinkIds(page, target)).toContain(sourceId);
      }).toPass({ timeout: 20_000 });
    }
  } finally {
    await context.close();
  }
});

test("E5：公開頁——自訂網址目標可點且導到 /p/…；非公開與只有 token 形的目標為純文字；冷開 #b- 捲到並高亮；「#」複製公開網址；同篇錨點不重載；不打 /api/notes", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());

    const pubTitle = `E2E sl pub ${stamp}`;
    await createNote(owner, pubTitle);
    const pubId = await noteIdFromUrl(owner);
    const pubPath = await makePublicCustom(owner);

    await createNote(owner, `E2E sl priv ${stamp}`);
    const privId = await noteIdFromUrl(owner);

    await createNote(owner, `E2E sl tok ${stamp}`);
    const tokId = await noteIdFromUrl(owner);
    await makePublicToken(owner);

    await createNote(owner, `E2E sl public source ${stamp}`);
    const sourceId = await noteIdFromUrl(owner);
    const fillers = Array.from({ length: 30 }, (_, i) => `filler ${i + 1}`);
    await appendMarkdown(owner, [`links [pub](/notes/${pubId}) [priv](/notes/${privId}) [tok](/notes/${tokId})`, "## Pub heading", ...fillers].join("\n\n") + "\n");
    await expect(editorLocator(owner).getByText("filler 30", { exact: true })).toBeVisible({ timeout: 15_000 });
    const anchorId = await blockIdOf(owner, "filler 28");
    const headingId = await blockIdOf(owner, "Pub heading");
    await appendMarkdown(owner, `[jump](/notes/${sourceId}#b-${anchorId})\n`);
    await expect(editorLocator(owner).locator(WIKILINK)).toHaveCount(4, { timeout: 10_000 });
    const token = await makePublicToken(owner);

    // 公開快照（persist debounce）追上：四個 wikilink 都在 ydoc 裡
    await expect(async () => {
      const res = await owner.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ydoc: string; links: Array<{ id: string; path: string }> };
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain(anchorId);
      expect(body.links.map((l) => l.id)).toEqual([pubId]);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    const apiNotesHits: string[] = [];
    anon.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/notes") apiNotesHits.push(r.url());
    });

    // 冷開公開頁的 #b-<id>：捲到並高亮（Task 14 的公開頁接線）
    await anon.goto(`/p/${token}#b-${anchorId}`);
    const coldTarget = anon.locator(`.bn-block-outer[data-id="${anchorId}"]`);
    await expectAnchorFlash(anon, anchorId);
    await expect(coldTarget).toBeInViewport();

    await anon.goto(`/p/${token}`);
    // 「jump」是貼在最後一段（filler 30）段尾的行內連結，那段的文字不再恰為「filler 30」——以 filler 29 判斷內文載入
    await expect(anon.getByText("filler 29", { exact: true })).toBeAttached({ timeout: 15_000 });
    const scope = anon.locator(WIKILINK);
    await expect(scope.filter({ hasText: "pub" }).locator("a")).toHaveAttribute("href", pubPath);
    for (const text of ["priv", "tok"]) {
      await expect(scope.filter({ hasText: text })).toBeVisible();
      await expect(scope.filter({ hasText: text }).locator("a")).toHaveCount(0);
    }

    // 公開頁的標題「#」：複製公開網址＋錨點（Task 15）
    await grantClipboard(anon);
    await blockOuterIn(anon.locator("body"), "Pub heading").hover();
    await anon.getByRole("button", { name: "Copy link to this section" }).click();
    expect(await readClipboard(anon)).toBe(`${ORIGIN}/p/${token}#b-${headingId}`);

    // 同篇錨點：只改 hash、不重載
    await anon.evaluate(() => {
      (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
    });
    await scope.filter({ hasText: "jump" }).locator("a").click();
    await anon.waitForURL((u) => u.hash === `#b-${anchorId}`, { timeout: 10_000 });
    await expect(anon.locator(`.bn-block-outer[data-id="${anchorId}"]`)).toBeInViewport({ timeout: 5_000 });
    expect(await anon.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);

    // 公開目標：一般點擊導到 /p/…（同分頁）
    await scope.filter({ hasText: "pub" }).locator("a").click();
    await anon.waitForURL((u) => u.pathname === pubPath, { timeout: 15_000 });
    await expect(anon.getByText(pubTitle).first()).toBeVisible({ timeout: 15_000 });

    expect(apiNotesHits).toEqual([]);
  } finally {
    await anonContext.close();
    await ownerContext.close();
  }
});

test("C1：選取含 wikilink 的文字——複製貼回保留 wikilink（label／錨點）、剪貼簿不空；拖曳搬移保留 wikilink；可編輯的 wikilink 本身拖不出一般連結", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl c1 target ${stamp}`);
    const targetId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c1 source ${stamp}`);
    await appendMarkdown(page, ["copy src [lbl](/notes/" + targetId + "#b-anc1) tail", "drop here", "paste here"].join("\n\n") + "\n");
    const editor = editorLocator(page);
    const wikilinks = editor.locator(WIKILINK);
    await expect(wikilinks).toHaveCount(1, { timeout: 10_000 });
    const expected: WikilinkAttrs = { targetNoteId: targetId, label: "lbl", anchorBlockId: "anc1" };
    expect(await wikilinkAttrs(page)).toEqual([expected]);
    // 段落以開頭文字定位（`^`）：貼上／拖放後別段也會含「copy src」
    const srcInline = editor.locator(".bn-inline-content", { hasText: /^copy src/ });
    const pasted = editor.locator(".bn-inline-content", { hasText: /^paste here/ });
    const dropInline = editor.locator(".bn-inline-content", { hasText: /^drop here/ });

    // 選取整段（含 wikilink）→ Ctrl+C：剪貼簿的純文字與 HTML 都不空（PF-COPY：修前 serializeForClipboard 拋錯、剪貼簿是空的）
    await grantClipboard(page);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await srcInline.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const html = items[0]?.types.includes("text/html") ? await (await items[0]!.getType("text/html")).text() : "";
      return { text: await navigator.clipboard.readText(), html };
    });
    expect(copied.text).toContain("lbl");
    expect(copied.html).toContain("lbl");

    // 貼回站內（另一段的段尾）：多一個 wikilink，props 原樣
    await pasted.click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.press("ControlOrMeta+v");
    await expect(wikilinks).toHaveCount(2, { timeout: 10_000 });
    await expect(pasted.locator(WIKILINK)).toHaveCount(1);
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
    await expect(editor.locator("a[href]")).toHaveCount(2); // 沒有多出一般連結

    // 拖曳搬移：選取來源段 → 從選取範圍內拖到「drop here」段尾 ⇒ wikilink 搬過去、props 原樣
    await srcInline.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await page.keyboard.press("Shift+End");
    // 放在目標列的右段（區塊外層寬的 80%）：拖曳中 BlockNote 側邊選單的按鈕疊在段首文字上（實測 dragover 落在 mantine Button、
    // 沒被 preventDefault ⇒ 不觸發 drop），放在文字上量不到。右段 posAtCoords 落在該段段尾。
    const from = (await srcInline.boundingBox())!;
    const dropOuter = editor.locator(".bn-block-outer").filter({ has: page.locator(".bn-inline-content", { hasText: /^drop here/ }) }).last();
    const to = (await dropOuter.boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 5 });
    await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 10 });
    await page.mouse.move(to.x + to.width * 0.8 + 2, to.y + to.height / 2);
    await page.mouse.up();
    await expect(dropInline.locator(WIKILINK)).toHaveCount(1, { timeout: 10_000 });
    await expect(dropInline).toContainText("copy src");
    await expect(srcInline).toHaveCount(0); // 原段的內容整段搬走了（不是複製）
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
    await expect(editor.locator("a[href]")).toHaveCount(2);

    // 可編輯的 wikilink 本身（draggable=false）：按住它拖到別段放開 ⇒ 不多出一般連結、wikilink 不搬家
    // 放開點同上（目標列右段——上一步證明那裡收得到 drop）：<a> 若能原生拖，這裡就會多出一般連結
    const linkBox = (await pasted.locator(WIKILINK).boundingBox())!;
    const target = (await dropOuter.boundingBox())!;
    await page.mouse.move(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(linkBox.x + linkBox.width / 2 + 20, linkBox.y + linkBox.height / 2, { steps: 5 });
    await page.mouse.move(target.x + target.width * 0.8, target.y + target.height / 2, { steps: 10 });
    await page.mouse.move(target.x + target.width * 0.8 + 2, target.y + target.height / 2);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await expect(pasted.locator(WIKILINK)).toHaveCount(1);
    await expect(dropInline.locator(WIKILINK)).toHaveCount(1);
    await expect(editor.locator("a[href]")).toHaveCount(2);
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
  } finally {
    await context.close();
  }
});

test("C2：hover A 出工具列 → 移進工具列不關 → 真滑鼠移到 B → 只剩 B 的工具列；移開 → 關閉且焦點不被拉進編輯器", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl c2 a ${stamp}`);
    const aId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c2 b ${stamp}`);
    const bId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c2 source ${stamp}`);
    await appendMarkdown(page, `first [link A](/notes/${aId}) then [link B](/notes/${bId}) end\n`);
    const editor = editorLocator(page);
    await expect(editor.locator(WIKILINK)).toHaveCount(2, { timeout: 10_000 });
    const toolbars = page.getByRole("dialog", { name: "Note link" });

    const center = async (l: Locator) => {
      const box = (await l.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const a = await center(editor.locator(WIKILINK, { hasText: "link A" }));
    await page.mouse.move(a.x, a.y, { steps: 5 });
    // 關閉中的 Popover 內容 toBeVisible 照樣過：一律斷 Radix 的開合狀態（關閉時 data-state 是 "closed"）
    await expect(toolbars).toHaveAttribute("data-state", "open");
    // hover 開的工具列不搶焦點
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') ?? null)).toBeNull();

    // 慢慢移進工具列：途中離開連結、經過 4px 間隙，工具列不關
    const t = await center(toolbars);
    await page.mouse.move(t.x, t.y, { steps: 10 });
    await page.waitForTimeout(600);
    await expect(toolbars).toHaveCount(1);
    await expect(toolbars).toHaveAttribute("data-state", "open");

    const b = await center(editor.locator(WIKILINK, { hasText: "link B" }));
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.waitForTimeout(800); // A 的延遲關閉＋關閉轉場、B 的延遲開啟
    await expect(toolbars).toHaveCount(1);
    await expect(toolbars).toHaveAttribute("data-state", "open");
    // 開著的是 B 的工具列：編輯文字預填 B 的 label
    await toolbars.getByRole("button", { name: "Edit text" }).click();
    await expect(toolbars.getByRole("textbox", { name: "Link text" })).toHaveValue("link B");
    // 焦點在工具列裡（正在編輯文字）：滑鼠移開不關
    await page.mouse.move(b.x, b.y + 200, { steps: 5 });
    await page.waitForTimeout(600);
    await expect(toolbars).toHaveAttribute("data-state", "open");
    await page.keyboard.press("Escape");
    await expect(toolbars).toHaveCount(0);
    // Esc 關閉後焦點會還給編輯器，但那是 Radix FocusScope 卸載時另排 setTimeout(0) 才跑的 onCloseAutoFocus：toHaveCount(0) 過了它可能還沒跑，
    // 這時 blur 會被它晚到的 editor.focus() 蓋掉（下一段 hover 開工具列時又把「開啟當下編輯器有焦點」記成真，最後焦點留在編輯器）。
    // 先等焦點真的回到編輯器，再 blur。
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="note-editor"]') != null)).toBe(true);

    // 純 hover 開、純移開：關閉，焦點不被拉進編輯器（先讓焦點落在 body——Esc 等關法在這種情況會把焦點還給編輯器）
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.mouse.move(a.x, a.y, { steps: 5 });
    await expect(toolbars).toHaveAttribute("data-state", "open");
    await page.mouse.move(a.x, a.y + 200, { steps: 5 });
    await expect(toolbars).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  } finally {
    await context.close();
  }
});

/**
 * 觸控長按：CDP `Input.dispatchTouchEvent` touchStart → 停 `ms` → touchEnd（`page.touchscreen.tap` 走同一條 CDP 路徑、只是不停）。
 * Chromium 的手勢辨識把它當真觸控：pointer 事件帶 `pointerType: "touch"`、長按可能發 contextmenu、短按補發 click。
 */
async function touchHold(page: Page, at: { x: number; y: number }, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

test("C4：觸控（hasTouch）——一般連結與 wikilink：長按約 0.5 s 出工具列、不跳轉；短按跳轉（一般連結開新分頁、wikilink 同分頁）", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    const targetTitle = `E2E sl c4 target ${stamp}`;
    await createNote(page, targetTitle);
    const targetPath = new URL(page.url()).pathname;
    const targetId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c4 source ${stamp}`);
    const sourceUrl = page.url();
    await appendMarkdown(page, `wiki [link W](/notes/${targetId}) and ext [link E](https://example.com/kn-e2e-${stamp}) end\n`);
    const editor = editorLocator(page);
    const wiki = editor.locator(WIKILINK, { hasText: "link W" });
    const ext = editor.locator('a[data-inline-content-type="link"]', { hasText: "link E" });
    await expect(wiki).toHaveCount(1, { timeout: 10_000 });
    await expect(ext).toHaveCount(1);
    const center = async (l: Locator) => {
      const box = (await l.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    // 外部網址不走網路：攔下來回一頁空白，新分頁的網址照樣看得到
    await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>ok</p>" }));
    const popups: Page[] = [];
    context.on("page", (p) => popups.push(p));

    // 一般連結長按 ⇒ BlockNote 原生連結工具列；不開新分頁、不跳轉
    await touchHold(page, await center(ext), 800);
    const linkToolbar = page.locator(".bn-link-toolbar");
    await expect(linkToolbar).toBeVisible();
    await expect(linkToolbar.getByRole("button", { name: "Open in new tab" })).toBeVisible();
    await page.waitForTimeout(800);
    expect(popups).toHaveLength(0);
    expect(page.url()).toBe(sourceUrl);
    await expect(linkToolbar).toBeVisible(); // 補發的事件（若有）沒把剛開的工具列關掉

    // 一般連結短按 ⇒ BlockNote 原行為：開新分頁
    const popupPromise = context.waitForEvent("page", { timeout: 10_000 });
    await page.touchscreen.tap((await center(ext)).x, (await center(ext)).y);
    const popup = await popupPromise;
    await popup.waitForURL((u) => u.pathname === `/kn-e2e-${stamp}`, { timeout: 10_000 });
    await popup.close();
    expect(page.url()).toBe(sourceUrl);

    // wikilink 長按 ⇒ 筆記連結工具列（三鈕）；放開後不跳轉
    await touchHold(page, await center(wiki), 800);
    const toolbar = page.getByRole("dialog", { name: "Note link" });
    await expect(toolbar).toHaveAttribute("data-state", "open");
    await expect(toolbar.getByRole("button")).toHaveText(["Edit text", "Change target", "Remove link"]);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(sourceUrl);
    await expect(toolbar).toHaveAttribute("data-state", "open");

    // 短按但在門檻前放開 ⇒ 不出工具列，當一般點擊：同分頁跳轉
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
    await touchHold(page, await center(wiki), 100);
    await page.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("C3：過期分頁（collab-token 帶舊 schema 版本）——筆記頁顯示重新整理 banner 且唯讀；簡報模式看不到 banner、工具列顯示需要重新整理", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const title = `E2E sl outdated ${Date.now()}`;
    await createNote(page, title);
    await appendMarkdown(page, "## Outdated slide\n\noutdated text\n");
    await expect(editorLocator(page).getByText("outdated text", { exact: true })).toBeVisible({ timeout: 15_000 });
    const noteUrl = page.url();

    // 模擬閘門前的分頁：token 請求不帶新版本（server 簽 sv=0，握手被拒為 client-outdated）
    const stale = await context.newPage();
    await stale.route("**/api/notes/*/collab-token", (route) => route.continue({ postData: JSON.stringify({ noteSchemaVersion: 0 }) }));
    await stale.goto(noteUrl);
    const message = "Knotebook has been updated. Reload the page to keep editing. Changes in this tab that haven't synced won't be kept after reloading.";
    await expect(stale.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
    await expect(stale.getByRole("status").filter({ hasText: /^Reload required/ })).toBeVisible();
    await expect(stale.locator('[data-testid="note-editor"] [contenteditable="true"]')).toHaveCount(0);
    await expect(stale.getByRole("heading", { name: title, level: 1 })).toBeVisible(); // 標題唯讀（TitleInput readOnly ⇒ h1）

    // 簡報模式：簡報層蓋住頁首 banner；簡報工具列顯示需要重新整理
    await stale.goto(`${noteUrl}?present`);
    const shell = stale.getByRole("dialog", { name: `${title} — presentation` });
    await expect(shell).toBeVisible({ timeout: 15_000 });
    await expect(shell.getByText("Reload required")).toBeVisible({ timeout: 15_000 });
    const banner = stale.getByText(message);
    await expect(banner).toBeAttached();
    const covered = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === null || !el.contains(hit);
    });
    expect(covered).toBe(true);
  } finally {
    await context.close();
  }
});
