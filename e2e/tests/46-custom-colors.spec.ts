import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  clickEndOfParagraph,
  createNote,
  createUserViaInvite,
  editorLocator,
  loginAs,
  randomEmail,
  reEscape,
  waitForEditorSelection,
} from "./helpers.js";
import { E2E_ORIGIN } from "../ports.js";

/**
 * 自訂色碼（任意 #rrggbb 的文字色與底色）的顯示面與自訂色面板 e2e。
 *
 * 面板（格式工具列與拖曳把手 ⋮⋮ 選單的「Custom…」）：
 * - C1＋C2：工具列套自訂色與內建 red 對照、工具列圖示顯示自訂色、重新整理後仍在、全程零 CSP violation；切深色後自訂色不變、內建 red 變。
 * - C3：拖曳把手套自訂底色到有巢狀子 block 的段落，另一段套內建底色對照。
 * - C5：套用過的顏色出現在「Recent」，點色塊直接套用並關選單。
 * - C6：拖曳飽和度方塊只改面板裡的值，按 Apply 才寫入筆記與最近用過。
 * - C10：觸控裝置套用色碼與最近用過；開面板時色碼框不自動取得焦點（不叫出螢幕鍵盤）。
 * - C11a／C11b：拖曳把手的面板在拖曳超出面板、打色碼時滑鼠移開的情況下都不會被關掉。
 * - C11c：工具列（一般文字選取與表格儲存格選取）與拖曳把手的面板裡用真鍵盤 Tab／Shift+Tab 在面板內繞回，選單不關、不打字進筆記。
 * - C13：帶自訂行內色與 block 底色的段落複製貼上到另一份筆記，顏色相同。
 *
 * 表格（滑鼠停在儲存格上出現的儲存格把手 ▾，與列／欄把手 ⋮⋮ 的選單）：
 * - C4a：儲存格把手套自訂底色，只有那一格上色，重新整理後仍在。
 * - C4b：列把手套自訂字色，整列每一格都換色，另一列不變。
 * - C4c：列／欄把手選單的項目恰為刪除、兩個新增、Colors；新增一列、刪除一欄照常；畫面上只有一組把手。
 *   關掉列選單後馬上開儲存格選單，經 aria-controls 只查到儲存格選單（只有 Colors）。
 * - C4d：儲存格把手的面板開著時，另一個分頁刪掉整張表：面板跟著表格消失、什麼都沒寫入，頁面不丟例外。
 * - C11a／C11b（儲存格把手）：同拖曳把手的 C11a／C11b，入口換成儲存格把手。
 * 表格把手的選單一律經觸發鈕的 `aria-controls` 找：BlockNote 的把手浮層在淡出期間會顯示它最後一次開著時的
 * HTML 複本（可能含剛關掉的選單），整頁查 class 會同時查到那份複本。
 *
 * 顯示面：
 * - C7：同一份筆記在編輯器、公開頁、版本預覽、簡報四個面，自訂色碼的 computed 色值都要對，且內建色名
 *   （`red`）的對照元素維持內建值（防止「全部變成同一色」的假綠）。
 * - C8：C7 全程不得出現任何 `securitypolicyviolation`（自訂色碼的規則是 JS 動態插入的，不可靠 inline style 或 `unsafe-inline`）。
 * - C12：同一個 context 的兩個分頁開同一篇筆記；A 貼上自訂色碼後，B 不重新整理就要顯示出來（遠端共編者套的色碼不會經過本機操作）。
 * - C9：用 API token 經 REST 寫入以 `style` 表示的十六進位色碼（短形、大寫），開著的編輯器不重新整理就顯示，且存成小寫 `#rrggbb`。
 * - C14：格式工具列的自訂色面板開著、正在打色碼時，另一個分頁在選取之前插入一段：色碼框的焦點不被工具列搶走，打完按 Enter 套到原本的選取；
 *   同時量面板沒有橫向捲軸、選色方塊不超出面板。
 *
 * 色碼是怎麼放進筆記的：面板的案例走 UI 套色；C9 走 REST API；其餘只關心「已經在文件裡」的色碼如何顯示，所以用貼上 HTML 放（`pasteHtml`）。
 * 貼上走合成的 `ClipboardEvent("paste")`＋真的 `DataTransfer`，只放 `text/html`：
 * - 不經瀏覽器 async clipboard（寫入時 Chromium 會消毒 HTML，`data-*` 之類的屬性不保證留得下來），也不需要剪貼簿授權；
 * - 不放 `text/plain`：編輯器的貼上流程會優先把純文字當 markdown 解析，HTML 就沒機會被處理。
 *
 * helper 的 `openShareDialog`、`readPublicUrl`、`saveVersion`、`presentFromHeaderMenu`、CSP 收集器是從
 * 11-public-share、22-versions、22-presentation、09-csp 複製精簡的（那些檔的 helper 沒有 export）。
 * 公開連結的 owner 用新帳號、不用 admin（公開連結的限流桶以 userId 計，見 helpers 檔頭）。
 */

const CUSTOM = "#ff6600";
const RGB_CUSTOM = "rgb(255, 102, 0)";
/** 內建 red：`--bn-colors-highlights-red-text: #e03e3e`、`--bn-colors-highlights-red-background: #fbe4e4`（淺色）。 */
const RGB_RED_TEXT = "rgb(224, 62, 62)";
const RGB_RED_BG = "rgb(251, 228, 228)";

/**
 * 種子：行內文字色、段落與標題的區塊文字色、儲存格底色，各一個自訂色碼與一個內建色名的對照。
 * 簡報切頁（頂層 heading 中 level 最小的當章、第一個 heading 之前是封面）會切成三張：
 * 封面 [i、cp、rp]、第 2 張 [ch]、第 3 張 [rh、表格]。
 */
const SEED_HTML =
  `<p>i <span data-style-type="textColor" data-value="${CUSTOM}">ci</span> <span data-style-type="textColor" data-value="red">ri</span></p>` +
  `<p data-text-color="${CUSTOM}">cp</p><p data-text-color="red">rp</p>` +
  `<h2 data-text-color="${CUSTOM}">ch</h2><h2 data-text-color="red">rh</h2>` +
  `<table><tr><td data-background-color="${CUSTOM}">cc</td><td data-background-color="red">rc</td></tr></table>`;

type Surface = "editor" | "present";
interface Probe {
  text: string;
  kind: "inline" | "block" | "cell";
  value: string;
  css: "color" | "background-color";
  expected: string;
}
const PROBES: Probe[] = [
  { text: "ci", kind: "inline", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "ri", kind: "inline", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "cp", kind: "block", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "rp", kind: "block", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "ch", kind: "block", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "rh", kind: "block", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "cc", kind: "cell", value: CUSTOM, css: "background-color", expected: RGB_CUSTOM },
  { text: "rc", kind: "cell", value: "red", css: "background-color", expected: RGB_RED_BG },
];

function probeLocator(scope: Locator, surface: Surface, probe: Probe): Locator {
  let selector: string;
  if (probe.kind === "inline") selector = `[data-style-type="textColor"][data-value="${probe.value}"]`;
  else if (probe.kind === "cell") selector = `td[data-background-color="${probe.value}"]`;
  // 編輯器類的顯示面：區塊色屬性在 `.bn-block-content` 上；簡報是消毒後的 HTML，屬性直接在 p／h2 上。
  else selector = surface === "editor" ? `.bn-block-content[data-text-color="${probe.value}"]` : `[data-text-color="${probe.value}"]`;
  return scope.locator(selector).filter({ hasText: new RegExp(`^${probe.text}$`) }).first();
}

/** `texts` 裡每一個元素的 computed 色值都要等於預期（toHaveCSS 會重試，等規則被插入與版面穩定）。 */
async function expectColors(scope: Locator, surface: Surface, texts: string[]): Promise<void> {
  for (const probe of PROBES.filter((p) => texts.includes(p.text))) {
    await expect(probeLocator(scope, surface, probe), `${surface}：${probe.text} 的 ${probe.css}`).toHaveCSS(probe.css, probe.expected, { timeout: 15_000 });
  }
}

const ALL_TEXTS = PROBES.map((p) => p.text);

/** 貼上 HTML（只放 text/html）：先點編輯器放游標，再對 contenteditable 送合成貼上事件。 */
async function pasteHtml(page: Page, html: string): Promise<void> {
  await editorLocator(page).click();
  await page.evaluate((markup) => {
    const dt = new DataTransfer();
    dt.setData("text/html", markup);
    const target = document.querySelector('[data-testid="note-editor"] [contenteditable="true"]');
    if (!target) throw new Error("editor not found");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
}

interface Violation {
  directive: string;
  blockedURI: string;
}
type CspWindow = { __cspViolations?: Violation[] };

/** 在 context 內每個頁面的任何腳本之前註冊 CSP violation 收集器（匿名 context 的頁面也要各自註冊）。 */
async function collectCspViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as CspWindow;
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations!.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
}

async function drainCspViolations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => (window as unknown as CspWindow).__cspViolations ?? []);
}

async function openShareDialog(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 匿名公開連結的輸入框只放 token，網址要自己組回去。 */
async function readPublicUrl(dialog: Locator, page: Page): Promise<string> {
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toBeVisible();
  const token = await input.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `${new URL(page.url()).origin}/p/${token}`;
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function presentFromHeaderMenu(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test("C7＋C8 自訂色碼在編輯器、公開頁、版本預覽、簡報都顯示，且全程零 CSP violation", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const anonContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const violations: Violation[] = [];
  try {
    await collectCspViolations(ownerContext);
    await collectCspViolations(anonContext);

    // ── 建一個新帳號當 owner（公開連結的限流桶不要吃 admin 的）──────────────
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const ownerEmail = randomEmail();
    const ownerPassword = "e2e-colors-owner-pw";
    await createUserViaInvite(adminPage, { email: ownerEmail, password: ownerPassword, displayName: "E2E Colors Owner" });

    const page = await ownerContext.newPage();
    await loginAs(page, ownerEmail, ownerPassword);
    await expect(page).toHaveURL(/\/$/);
    const title = `E2E custom colors ${Date.now()}`;
    await createNote(page, title);

    // ── 編輯器：先確認貼上後文件裡真的有色碼屬性（失敗是貼上解析的問題，不是顯示），再看 computed ──
    await pasteHtml(page, SEED_HTML);
    const editor = editorLocator(page);
    await expect(editor.locator(`[data-value="${CUSTOM}"]`)).toHaveCount(1);
    await expect(editor.locator(`.bn-block-content[data-text-color="${CUSTOM}"]`)).toHaveCount(2);
    await expect(editor.locator(`td[data-background-color="${CUSTOM}"]`)).toHaveCount(1);
    await expectColors(editor, "editor", ALL_TEXTS);

    // ── 公開頁：開匿名公開連結，等內容落盤，再用全新 context 開 ──────────────
    const dialog = await openShareDialog(page);
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    await publicRadio.check();
    const publicUrl = await readPublicUrl(dialog, page);
    const token = publicUrl.slice(publicUrl.lastIndexOf("/p/") + 3);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(async () => {
      const res = await anonContext.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ydoc: string };
      // 色碼字串原文編進 Yjs update：含它＝這份內容（而不是貼上前的舊快照）已落盤。
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain(CUSTOM);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(publicUrl);
    await expect(anon.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anon.getByText("Read-only")).toBeVisible();
    await expectColors(anon.locator(".bn-editor").first(), "editor", ALL_TEXTS);
    violations.push(...(await drainCspViolations(anon)));

    // ── 簡報：逐張換頁，各斷言該張的元素 ──────────────────────────────────
    await presentFromHeaderMenu(page, title);
    const slide = page.locator(".reveal .slides section.present");
    await expect(slide.getByText("cp", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["ci", "ri", "cp", "rp"]);
    await page.keyboard.press("ArrowRight");
    await expect(slide.getByText("ch", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["ch"]);
    await page.keyboard.press("ArrowRight");
    await expect(slide.getByText("rh", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["rh", "cc", "rc"]);
    // 退出簡報：先退全螢幕（等過連退防護窗口），再按 Esc 關對話框。
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    // 350 ms 必須大於簡報自己的 300 ms 防連退窗口，否則 Esc 會被當成同一次退出而吃掉。
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editorLocator(page)).toBeVisible();

    // ── 版本預覽：存一版、開預覽、切單欄（預設並排時兩欄各有一份，單欄只有一份）──
    await saveVersion(page, "colors-v1");
    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: /^colors-v1 \(/ }).click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Single column" }).click();
    await expectColors(page.getByTestId("diff-single"), "editor", ALL_TEXTS);

    violations.push(...(await drainCspViolations(page)));
    expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  } finally {
    await Promise.all([adminContext.close(), ownerContext.close(), anonContext.close()]);
  }
});

test("C12 兩個分頁開同一篇筆記：A 貼上自訂色碼，B 不重新整理就顯示", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const pageA = await context.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    await expect(pageA).toHaveURL(/\/$/);
    const title = `E2E colors two tabs ${Date.now()}`;
    await createNote(pageA, title);

    // 同一個 context 共用 cookie，不必再登入。等 B 載入完成、連上共編才讓 A 貼上。
    const pageB = await context.newPage();
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await expect(editorLocator(pageB)).toBeVisible();

    await pasteHtml(pageA, `<p data-text-color="${CUSTOM}">tab</p><p>x <span data-style-type="textColor" data-value="${CUSTOM}">y</span></p>`);

    const editorB = editorLocator(pageB);
    await expect(editorB.locator(`.bn-block-content[data-text-color="${CUSTOM}"]`).filter({ hasText: /^tab$/ }).first()).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(editorB.locator(`[data-style-type="textColor"][data-value="${CUSTOM}"]`).filter({ hasText: /^y$/ }).first()).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C9 API 用 token 以 style 寫入色碼：網頁不重整就顯示，且存成小寫 #rrggbb", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  // 新帳號：建 token 的額度（每人每小時 10 次）是 per user，不吃 admin 的。
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  let anonymous: BrowserContext | undefined;
  let tokenId: string | undefined;
  const page = await userContext.newPage();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const email = randomEmail();
    const password = "e2e-colors-api-pw";
    await createUserViaInvite(adminPage, { email, password, displayName: "E2E Colors Api" });

    await loginAs(page, email, password);
    const title = `E2E colors api ${Date.now()}`;
    await createNote(page, title);
    const noteUrl = page.url();

    // API token（照 45-bulk-transfer）：notes:read notes:write，結束時撤掉。
    const created = await page.request.post("/api/auth/tokens", {
      data: { name: `e2e-colors-${Date.now()}`, scope: "notes:read notes:write", expiresInDays: 30 },
    });
    expect(created.status(), await created.text()).toBe(201);
    const body = (await created.json()) as { id: string; token: string };
    tokenId = body.id;
    const token = body.token;
    expect(token).toMatch(/^knb_/);

    // 回到筆記並等編輯器掛上（命中即隱含已連線且首次同步完成）。
    await page.goto(noteUrl);
    const editor = editorLocator(page);
    await editor.waitFor();

    // 無 cookie 的 context：用瀏覽器 context 會因 session cookie 而通過，對 Bearer 沒有鑑別力。
    anonymous = await browser.newContext();
    const api = anonymous.request;
    const auth = { Authorization: `Bearer ${token}` };
    const listRes = await api.get(`${baseURL}/api/notes`, { headers: auth });
    expect(listRes.status()).toBe(200);
    const notes = (await listRes.json()) as Array<{ id: string; title: string }>;
    const mine = notes.find((n) => n.title === title)!;
    expect(mine).toBeTruthy();

    // 短形、大寫的色碼經 style 寫入：parser 先換成 rgb(255, 102, 0)，寫入端再正規化成 #ff6600。
    const res = await api.post(`${baseURL}/api/notes/${mine.id}/edits`, {
      headers: auth,
      data: { op: "append", markdown: '<span style="color:#F60">c9</span>' },
    });
    expect(res.status()).toBe(201);

    // 寫入後 token 的遠端游標落在這次寫下的第一個字前面。ProseMirror 把 widget 包進「後面那個字」的
    // mark 裡，所以游標（含名牌文字）會畫在色彩 span 裡面，span 的 textContent 不會剛好是 "c9"。
    // 這裡用子字串找 span，再扣掉 widget 比對 span 自己的文字：整段 "c9" 都被上色，不是只有一部分。
    const colored = editor.locator('[data-style-type="textColor"]').filter({ hasText: "c9" }).first();
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(colored).toHaveAttribute("data-value", CUSTOM);
    const ownText = () =>
      colored.evaluate((el) => {
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
        return copy.textContent;
      });
    await expect.poll(ownText).toBe("c9");
  } finally {
    try {
      if (tokenId) await page.request.delete(`/api/auth/tokens/${tokenId}`);
    } finally {
      await anonymous?.close();
      await userContext.close();
      await adminContext.close();
    }
  }
});

test("C14 工具列自訂色面板打色碼時，另一個分頁在選取之前插入一段：焦點留在色碼框，Enter 套到原選取", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const pageA = await context.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    await expect(pageA).toHaveURL(/\/$/);
    const title = `E2E colors toolbar focus ${Date.now()}`;
    await createNote(pageA, title);
    const editorA = editorLocator(pageA);
    await editorA.click();
    await pageA.keyboard.type("top");
    await pageA.keyboard.press("Enter");
    await pageA.keyboard.type("target text");

    // 同一個 context 共用 cookie，不必再登入。等 B 載入完成、連上共編、看到 A 打的內容。
    const pageB = await context.newPage();
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const editorB = editorLocator(pageB);
    // A 的遠端游標（含名牌文字）畫在 `target text` 段尾，所以用子字串比對。
    await expect(editorB.locator(".bn-block-content", { hasText: "target text" })).toBeVisible({ timeout: 10_000 });

    // A：三擊選取整段 `target text` → 真滑鼠點顏色鈕 → 「自訂…」，焦點進色碼框。
    await editorA.getByText("target text", { exact: true }).click({ clickCount: 3 });
    await pageA.locator('.bn-formatting-toolbar [data-test="colors"]').click();
    await pageA.locator('[data-test="text-color-custom"]').click();
    const panel = pageA.locator(".bn-formatting-toolbar .kb-color-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".react-colorful")).toBeVisible();
    const hex = pageA.getByRole("textbox", { name: "Hex color" });
    await expect(hex).toBeFocused();

    // 面板寬度：dropdown 不出現橫向捲軸，選色方塊左右都在面板內；色值在 0%（方塊與色相的左端）時指標也不超出面板。
    const dropdown = pageA.locator(".bn-formatting-toolbar .bn-color-picker-dropdown");
    const metrics = await dropdown.evaluate((el) => {
      const panelBox = el.querySelector(".kb-color-panel")!.getBoundingClientRect();
      const pickerBox = el.querySelector(".react-colorful")!.getBoundingClientRect();
      const pointers = Array.from(el.querySelectorAll(".react-colorful__pointer")).map((p) => p.getBoundingClientRect());
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        panelLeft: panelBox.left,
        panelRight: panelBox.right,
        pickerLeft: pickerBox.left,
        pickerRight: pickerBox.right,
        pointerLeft: Math.min(...pointers.map((r) => r.left)),
        pointerRight: Math.max(...pointers.map((r) => r.right)),
      };
    });
    console.log(`MEASURE C14 ${JSON.stringify(metrics)}`);
    await pageA.screenshot({ path: test.info().outputPath("c14-panel.png") });
    expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.pickerLeft, JSON.stringify(metrics)).toBeGreaterThanOrEqual(metrics.panelLeft);
    expect(metrics.pickerRight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.panelRight);
    expect(metrics.pointerLeft, JSON.stringify(metrics)).toBeGreaterThanOrEqual(metrics.panelLeft);
    expect(metrics.pointerRight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.panelRight);

    // 面板一開，色碼框裡是 `#`（沒有自訂色也沒有最近用過）；全選後打，蓋掉它。
    await pageA.keyboard.press("Control+A");
    await pageA.keyboard.type("#ff6");
    await expect(hex).toHaveValue("#ff6");

    // B：在第一段開頭打 zz 再按 Enter，新段落插在 A 的選取上方，A 的選取被重映射、工具列重繪。
    await editorB.getByText("top", { exact: true }).click();
    await pageB.keyboard.press("Home");
    await waitForEditorSelection(pageB);
    await pageB.keyboard.type("zz");
    await pageB.keyboard.press("Enter");

    await expect(editorA.getByText("zz", { exact: true })).toBeVisible({ timeout: 10_000 });
    // 工具列重繪後 Mantine focus trap 的重新聚焦排在 setTimeout 裡，多等一下再看焦點。
    await pageA.waitForTimeout(300);
    expect(await hex.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect(panel).toBeVisible();

    await pageA.keyboard.type("600");
    await expect(hex).toHaveValue("#ff6600");
    await pageA.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);

    const colored = editorA.locator('[data-style-type="textColor"][data-value="#ff6600"]').filter({ hasText: /^target text$/ });
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    // B 的遠端游標（含名牌文字）畫在 `top` 開頭，比對前扣掉 widget。
    const blockTexts = () =>
      editorA.evaluate((root) =>
        Array.from(root.querySelectorAll(".bn-block-content"))
          .map((el) => {
            const copy = el.cloneNode(true) as Element;
            copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
            return copy.textContent ?? "";
          })
          .filter((text) => text !== ""),
      );
    await expect.poll(blockTexts).toEqual(["zz", "top", "target text"]);
  } finally {
    await context.close();
  }
});

// ── 自訂色面板 ─────────────────────────────────────────────────────────────

/** 內建 red 的文字色在深色主題是 `#ec4040`。 */
const RGB_RED_TEXT_DARK = "rgb(236, 64, 64)";
const RECENT_COLORS_KEY = "knotebook:recent-colors";
/** 拖曳把手的面板要量「移到面板外 150 px」，視窗要夠寬。 */
const WIDE = { width: 1400, height: 900 };

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** 新 context 以 admin 登入、建一份筆記，把 `lines` 逐段打進去。`prepare` 在開頁面之前對 context 做設定（例如攔截請求）。 */
async function startColorNote(
  browser: Browser,
  name: string,
  lines: string[],
  options: Parameters<Browser["newContext"]>[0] = { viewport: WIDE },
  prepare?: (context: BrowserContext) => Promise<unknown>,
): Promise<{ context: BrowserContext; page: Page; title: string }> {
  const context = await browser.newContext(options);
  await prepare?.(context);
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const title = `E2E colors ${name} ${Date.now()}`;
  await createNote(page, title);
  if (lines.length > 0) await typeLines(page, lines);
  return { context, page, title };
}

async function typeLines(page: Page, lines: string[]): Promise<void> {
  await editorLocator(page).click();
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
  await expect(paragraph(page, lines[lines.length - 1]!)).toBeVisible();
}

/** 文字剛好是 `text` 的那一段的行內內容。 */
function paragraph(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-inline-content").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

/** 文字剛好是 `text` 的那一段的 `.bn-block-content`（不含巢狀子 block 的字）。 */
function blockContent(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-block-content").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

function inlineColored(page: Page, hex: string, text: string): Locator {
  return editorLocator(page).locator(`[data-style-type="textColor"][data-value="${hex}"]`).filter({ hasText: new RegExp(`^${reEscape(text)}$`) });
}

/** 用鍵盤選取 `text` 那一段的第 `from` 到 `to` 個字，等格式工具列出現。 */
async function selectText(page: Page, text: string, from: number, to: number): Promise<void> {
  const toolbar = page.locator(".bn-formatting-toolbar");
  const hasRange = () => page.evaluate(() => !(document.getSelection()?.isCollapsed ?? true));
  if ((await toolbar.isVisible()) || (await hasRange())) {
    // 上一次的選取還在：工具列可能正好蓋在要點的那一段上。等焦點回到編輯器（套用後是 setTimeout 才還焦點），
    // 選取還沒收起才按方向鍵收起，再等工具列消失
    await expect.poll(() => editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // 焦點回到編輯器時，選取範圍可能晚一點才畫回 DOM：這一輪看到的還是收起的，工具列卻還開著，就再看一次
    await expect(async () => {
      if (await hasRange()) await page.keyboard.press("ArrowRight");
      await expect(toolbar).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
  await clickEndOfParagraph(page, paragraph(page, text));
  await page.keyboard.press("Home");
  await waitForEditorSelection(page);
  for (let i = 0; i < from; i++) await page.keyboard.press("ArrowRight");
  for (let i = from; i < to; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(toolbar).toBeVisible();
}

const panelOf = (page: Page) => page.locator(".kb-color-panel");
const hexInput = (page: Page) => page.getByRole("textbox", { name: "Hex color" });
const applyButton = (page: Page) => panelOf(page).getByRole("button", { name: "Apply", exact: true });

/** 選取已就緒時，以真滑鼠點工具列的顏色鈕與「Custom…」，回傳面板。觸控時用 tap。 */
async function openToolbarPanel(page: Page, section: "text" | "background", how: "click" | "tap" = "click"): Promise<Locator> {
  const colors = page.locator('.bn-formatting-toolbar [data-test="colors"]');
  const custom = page.locator(`.bn-formatting-toolbar [data-test="${section}-color-custom"]`);
  if (how === "tap") {
    await colors.tap();
    await custom.tap();
  } else {
    await colors.click();
    await custom.click();
  }
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

/** hover 文字是 `text` 的那一段，等側邊選單對齊那一段，以真滑鼠點 ⋮⋮ 開把手選單。 */
async function openBlockMenu(page: Page, text: string): Promise<Locator> {
  const content = blockContent(page, text);
  await content.hover();
  const handle = page.getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await content.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${text}`).not.toBeNull();
    expect(menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height, JSON.stringify({ menu, box })).toBe(true);
  }).toPass({ timeout: 5_000 });
  await handle.click();
  const menu = page.locator(".bn-drag-handle-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** 把手選單 → hover「Colors」開子選單 → 點 `dataTest` 那一項。 */
async function pickBlockColorItem(page: Page, text: string, dataTest: string): Promise<void> {
  const menu = await openBlockMenu(page, text);
  await menu.getByRole("menuitem", { name: "Colors", exact: true }).hover();
  const item = menu.locator(`[data-test="${dataTest}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

async function openBlockPanel(page: Page, text: string, section: "text" | "background"): Promise<Locator> {
  await pickBlockColorItem(page, text, `${section}-color-custom`);
  const panel = page.locator(".bn-drag-handle-menu .kb-color-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

/** 各段的文字（扣掉遠端游標的 widget、略過空段落），比對「筆記內容沒有多出字元」用。 */
function blockTexts(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((root) =>
    Array.from(root.querySelectorAll(".bn-block-content"))
      .map((el) => {
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
        return copy.textContent ?? "";
      })
      .filter((text) => text !== ""),
  );
}

test("C1＋C2 工具列套自訂色：與內建 red 對照、工具列圖示顯示自訂色、重新整理後仍在、零 CSP violation；深色主題下自訂色不變", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: WIDE });
  try {
    // react-colorful 會注入自己的 <style>：從開面板起就要收 violation
    await collectCspViolations(context);
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const title = `E2E colors toolbar ${Date.now()}`;
    await createNote(page, title);
    const line = "orange and red";
    await typeLines(page, [line]);

    await selectText(page, line, 0, 6);
    await openToolbarPanel(page, "text");
    await expect(hexInput(page)).toBeFocused();
    await hexInput(page).fill(CUSTOM);
    await applyButton(page).click();
    await expect(panelOf(page)).toHaveCount(0);
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });

    // 同一段的另一段字套內建 red 當對照
    await selectText(page, line, 11, 14);
    await page.locator('.bn-formatting-toolbar [data-test="colors"]').click();
    await page.locator('.bn-formatting-toolbar [data-test="text-color-red"]').click();
    const red = editorLocator(page).locator('[data-style-type="textColor"][data-value="red"]').filter({ hasText: /^red$/ });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT, { timeout: 10_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM);

    // 選回自訂色那段：工具列顏色鈕的圖示是自訂色
    await selectText(page, line, 0, 6);
    await expect(page.locator('.bn-formatting-toolbar [data-test="colors"] .bn-color-icon')).toHaveCSS("color", RGB_CUSTOM);

    // 收集器每次載入頁面都會重設：開面板期間（react-colorful 注入 <style>）收到的 violation 要在重新整理前先取出
    const violations = await drainCspViolations(page);

    // 重新整理：色碼存進筆記了
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM, { timeout: 15_000 });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT);

    // 深色主題：自訂色碼照原值，內建 red 換成深色的值（兩者都變或都不變都是錯）
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT_DARK, { timeout: 10_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM);

    violations.push(...(await drainCspViolations(page)));
    expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  } finally {
    await context.close();
  }
});

test("C3 拖曳把手套自訂底色：外層 block 上底色、巢狀子 block 在它裡面，另一段套內建 red 底色對照", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startColorNote(browser, "block bg", []);
  try {
    // parent 底下巢狀一個 child，再回到頂層打 other
    await editorLocator(page).click();
    await page.keyboard.type("parent");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("child");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("other");
    await expect(blockContent(page, "other")).toBeVisible();
    const nested = () =>
      blockContent(page, "child").evaluate((el) => el.closest(".bn-block")!.parentElement!.closest(".bn-block")?.querySelector(":scope > .bn-block-content")?.textContent ?? null);
    await expect.poll(nested, { message: "child 要巢狀在 parent 底下" }).toBe("parent");

    const bright = "#00ff00";
    const panel = await openBlockPanel(page, "parent", "background");
    await hexInput(page).fill(bright);
    await panel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(panelOf(page)).toHaveCount(0);

    const outer = editorLocator(page).locator(`.bn-block:has(> .bn-block-content[data-background-color="${bright}"])`);
    await expect(outer).toHaveCount(1);
    await expect(outer.locator(":scope > .bn-block-content")).toHaveText("parent");
    await expect(outer).toHaveCSS("background-color", "rgb(0, 255, 0)", { timeout: 10_000 });
    // 子 block 是外層 .bn-block 的後代，畫在它的底色上。不斷言子 block 自己的 background-color：
    // background-color 不會繼承，BlockNote 只對外層上底色（內建色也一樣），子 block 的 .bn-block 是透明的。
    expect(
      await blockContent(page, "child").evaluate(
        (el, sel) => el.closest(".bn-block")!.parentElement!.closest(".bn-block") === document.querySelector(sel),
        `[data-testid="note-editor"] .bn-block:has(> .bn-block-content[data-background-color="${bright}"])`,
      ),
    ).toBe(true);

    await pickBlockColorItem(page, "other", "background-color-red");
    const redOuter = editorLocator(page).locator('.bn-block:has(> .bn-block-content[data-background-color="red"])');
    await expect(redOuter.locator(":scope > .bn-block-content")).toHaveText("other");
    await expect(redOuter).toHaveCSS("background-color", RGB_RED_BG, { timeout: 10_000 });
    await expect(outer).toHaveCSS("background-color", "rgb(0, 255, 0)");
  } finally {
    await context.close();
  }
});

/**
 * 先以色碼框套 `CUSTOM` 到 `first` 段的第一個字，再開面板點「Recent」的色塊套到 `second` 段的第一個字；`how` 決定用滑鼠還是觸控。
 * `onFirstPanel` 在第一次開面板、還沒碰色碼框時呼叫。
 */
async function applyThenPickRecent(
  page: Page,
  first: string,
  second: string,
  how: "click" | "tap",
  onFirstPanel?: (panel: Locator) => Promise<void>,
): Promise<void> {
  const press = (target: Locator) => (how === "tap" ? target.tap() : target.click());
  await selectText(page, first, 0, first.indexOf(" "));
  const firstPanel = await openToolbarPanel(page, "text", how);
  await onFirstPanel?.(firstPanel);
  if (how === "tap") await hexInput(page).tap();
  await hexInput(page).fill(CUSTOM);
  await press(applyButton(page));
  await expect(panelOf(page)).toHaveCount(0);
  const firstWord = first.slice(0, first.indexOf(" "));
  await expect(inlineColored(page, CUSTOM, firstWord)).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });

  await selectText(page, second, 0, second.indexOf(" "));
  const panel = await openToolbarPanel(page, "text", how);
  await expect(panel.getByText("Recent", { exact: true })).toBeVisible();
  const swatch = panel.getByRole("button", { name: CUSTOM, exact: true });
  await expect(swatch).toBeVisible();
  await press(swatch);
  // 點色塊就是套用：選單整個關掉
  await expect(panelOf(page)).toHaveCount(0);
  await expect(page.locator(".bn-color-picker-dropdown")).toHaveCount(0);
  await expect(inlineColored(page, CUSTOM, second.slice(0, second.indexOf(" ")))).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
}

test("C5 最近用過：套用一次後再開面板，Recent 有該色，點色塊直接套到另一段並關選單", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startColorNote(browser, "recent", ["first words", "second words"]);
  try {
    await applyThenPickRecent(page, "first words", "second words", "click");
  } finally {
    await context.close();
  }
});

test("C6 拖曳飽和度方塊：色碼框跟著變，按 Apply 前筆記與最近用過都不變，按了才寫入", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "drag me";
  const { context, page } = await startColorNote(browser, "drag preview", [line]);
  try {
    const original = await paragraph(page, line).evaluate((el) => getComputedStyle(el).color);
    await selectText(page, line, 0, line.length);
    const panel = await openToolbarPanel(page, "text");

    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    await page.mouse.move(sat.x + sat.width * 0.7, sat.y + sat.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.5, sat.y + sat.height * 0.5, { steps: 5 });
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // 按住繼續拖：色碼框要跟著指標再變一次（不是只在按下那一刻取一次值）
    const midway = await hexInput(page).inputValue();
    await page.mouse.move(sat.x + sat.width * 0.2, sat.y + sat.height * 0.8, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await hexInput(page).inputValue();
    expect(dragged).not.toBe(midway);

    // 拖曳只改預覽：筆記裡沒有色彩 span、字色照舊，最近用過也沒記
    await expect(paragraph(page, line).locator('[data-style-type="textColor"]')).toHaveCount(0);
    expect(await paragraph(page, line).evaluate((el) => getComputedStyle(el).color)).toBe(original);
    expect(await page.evaluate((key) => localStorage.getItem(key), RECENT_COLORS_KEY) ?? "").not.toContain(dragged);

    await applyButton(page).click();
    await expect(panelOf(page)).toHaveCount(0);
    await expect(inlineColored(page, dragged, line)).toHaveCSS("color", hexToRgb(dragged), { timeout: 10_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), RECENT_COLORS_KEY)).toContain(dragged);
  } finally {
    await context.close();
  }
});

test("C10 觸控裝置：套用色碼與最近用過都可用，開面板時色碼框不自動取得焦點", async ({ browser }) => {
  test.setTimeout(150_000);
  // 筆記在桌面 context 建好打字，觸控 context 只開它
  const { context: desktop, page: owner, title } = await startColorNote(browser, "touch", ["first words", "second words"]);
  const mobile = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 640 } });
  try {
    const page = await mobile.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await page.goto(owner.url());
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    // 桌面那頁的遠端游標（含名牌文字）畫在段落文字裡：看到內容後關掉桌面那頁，等游標消失，段落文字才會剛好相等
    await expect(editorLocator(page).locator(".bn-inline-content", { hasText: "second words" })).toBeVisible({ timeout: 15_000 });
    await desktop.close();
    await expect(editorLocator(page).locator(".bn-collaboration-cursor__base")).toHaveCount(0, { timeout: 15_000 });
    await expect(paragraph(page, "second words")).toBeVisible();
    // 前提：這個 context 被當成觸控（不是細指標），面板才會走「不聚焦色碼框」那條
    expect(await page.evaluate(() => window.matchMedia("(pointer: fine)").matches)).toBe(false);

    await applyThenPickRecent(page, "first words", "second words", "tap", async (panel) => {
      // 觸控開面板不叫出螢幕鍵盤：色碼框沒有焦點，焦點仍在面板裡（不在面板外，否則下一個按鍵會關掉選單）
      await expect(hexInput(page)).not.toBeFocused();
      expect(await panel.evaluate((el) => el.contains(document.activeElement)), "焦點要留在面板裡").toBe(true);
    });
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
  }
});

test("C11a 拖曳把手的面板：在飽和度方塊按下、拖到面板外 150 px 停住再放開，面板仍在、值已變、Apply 生效", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "drag outside";
  const { context, page } = await startColorNote(browser, "drag outside", [line]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    const box = (await panel.boundingBox())!;
    const y = sat.y + sat.height * 0.5;
    // 往右拖出面板 160 px；右邊放不下就往左
    const outsideX = box.x + box.width + 160 < WIDE.width - 10 ? box.x + box.width + 160 : box.x - 160;
    await page.mouse.move(sat.x + sat.width * 0.6, sat.y + sat.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.3, y, { steps: 5 });
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // 面板內拖到的值；拖出面板後指標仍被追蹤，飽和度貼到邊（0% 或 100%），值要再變
    const inside = await hexInput(page).inputValue();
    await page.mouse.move(outsideX, y, { steps: 10 });
    // 停得比子選單的關閉延遲久：面板若放在 hover 開關的子選單裡，這段時間就會被關掉
    await page.waitForTimeout(500);
    await page.mouse.up();

    await expect(panel).toBeVisible();
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await hexInput(page).inputValue();
    expect(dragged).not.toBe(inside);
    await panel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(panelOf(page)).toHaveCount(0);
    const colored = editorLocator(page).locator(`.bn-block-content[data-text-color="${dragged}"]`).filter({ hasText: new RegExp(`^${line}$`) });
    await expect(colored).toHaveCSS("color", hexToRgb(dragged), { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C11b 拖曳把手的面板：打色碼到一半把滑鼠移到編輯器另一端停住，再打完按 Enter，套上完整色碼", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "type then move";
  const { context, page } = await startColorNote(browser, "type move", [line, "far line"]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    await hexInput(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#ff6");
    await expect(hexInput(page)).toHaveValue("#ff6");

    const editorBox = (await editorLocator(page).boundingBox())!;
    await page.mouse.move(editorBox.x + editorBox.width - 10, editorBox.y + editorBox.height - 5, { steps: 10 });
    await page.waitForTimeout(500);
    await expect(panel).toBeVisible();

    await page.keyboard.type("600");
    await expect(hexInput(page)).toHaveValue("#ff6600");
    await page.keyboard.press("Enter");
    await expect(panelOf(page)).toHaveCount(0);
    const colored = editorLocator(page).locator(`.bn-block-content[data-text-color="${CUSTOM}"]`).filter({ hasText: new RegExp(`^${line}$`) });
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

/**
 * 面板已開、色碼框有焦點、沒有最近用過（新 context）時：打一個合法色碼讓 Apply 可按，Tab 到 Apply（最後一個元素），
 * 再按一次 Tab 要繞回 Back；Shift+Tab 回到 Apply。全程選單開著、筆記內容不變。
 */
async function expectTabWrapsInPanel(page: Page, panel: Locator): Promise<void> {
  const texts = await blockTexts(page);
  await expect(panel.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(hexInput(page)).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(CUSTOM);
  await expect(applyButton(page)).toBeEnabled();

  const active = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return { inPanel: !!el?.closest(".kb-color-panel"), text: el?.textContent?.trim() ?? "" };
    });
  await page.keyboard.press("Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "Apply" });
  await page.keyboard.press("Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "←Back" });
  await expect(panel).toBeVisible();
  expect(await blockTexts(page)).toEqual(texts);

  await page.keyboard.press("Shift+Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "Apply" });
  await expect(panel).toBeVisible();
  expect(await blockTexts(page)).toEqual(texts);
}

/** 格式工具列裡排在顏色鈕之後、可用（沒停用、有顯示）的鈕；dropdown 裡的不算。 */
function enabledToolbarButtonsAfterColors(page: Page): Promise<string[]> {
  return page.locator(".bn-formatting-toolbar").evaluate((bar) => {
    const colors = bar.querySelector('[data-test="colors"]')!;
    return Array.from(bar.querySelectorAll<HTMLButtonElement>("button"))
      .filter((b) => !b.closest("[data-menu-dropdown]") && !b.disabled && b.offsetParent !== null)
      .filter((b) => (colors.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
      .map((b) => b.getAttribute("data-test") ?? b.getAttribute("aria-label") ?? b.textContent ?? "");
  });
}

// 面板自己在兩端處理 Tab／Shift+Tab（先移好焦點並 preventDefault），所以不論面板的最後一個元素是不是整條工具列的
// 最後一個可 Tab 元素，工具列與 dropdown 掛在 document 上的 focus trap 看到焦點已不在端點都不介入，焦點一定留在面板裡。
// 下面兩案各量一種：一般文字選取（顏色鈕之後還有建立連結鈕），以及表格儲存格選取（顏色鈕之後沒有可用的鈕）。
// 顏色選單一律以真滑鼠點開：Mantine 與工具列兩層 focus trap 的註冊順序只有這樣才和真實使用相同。
// 共編者讓工具列重繪時搶焦點的情境，單人安靜的頁面量不到，由 C14 涵蓋。
test("C11c 工具列的面板：真鍵盤 Tab 在最後一個元素繞回 Back、Shift+Tab 回到最後一個，選單不關、不打字進筆記", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "keyboard target";
  const { context, page } = await startColorNote(browser, "tab toolbar", [line]);
  try {
    await selectText(page, line, 0, line.length);
    const enabledAfter = await enabledToolbarButtonsAfterColors(page);
    expect(enabledAfter.length, JSON.stringify(enabledAfter)).toBeGreaterThan(0);

    const panel = await openToolbarPanel(page, "text");
    await expectTabWrapsInPanel(page, panel);
  } finally {
    await context.close();
  }
});

test("C11c 工具列的面板（選取表格儲存格，顏色鈕之後沒有可用的鈕）：Tab／Shift+Tab 仍在面板內繞回，粗體沒被切換", async ({ browser }) => {
  test.setTimeout(120_000);
  // 站台設了 AI 動作時（同一座疊上別的測試會設），工具列尾端多一顆 AI 鈕，顏色鈕之後就有可用的鈕、量不到本案要的情境。
  // 這一頁把 AI 動作清單換成空的，工具列跟沒設 AI 動作的站台相同。
  const { context, page } = await startColorNote(browser, "tab table", [], { viewport: WIDE }, (ctx) =>
    ctx.route("**/api/ai/actions", (route) => route.fulfill({ json: { actions: [] } })),
  );
  try {
    await pasteHtml(page, "<table><tr><td>cell one</td><td>cell two</td></tr></table>");
    const cells = editorLocator(page).locator("td");
    await expect(cells).toHaveCount(2);
    await expect(cells.nth(1)).toHaveText("cell two");

    // 滑鼠從第一格拖到第二格：選取變成儲存格選取（CellSelection）
    const a = (await cells.nth(0).boundingBox())!;
    const b = (await cells.nth(1).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(editorLocator(page).locator("td.selectedCell")).toHaveCount(2);
    await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();

    // 前提：這就是面板最後一個元素同時是整條工具列最後一個可 Tab 元素的情境
    const enabledAfter = await enabledToolbarButtonsAfterColors(page);
    expect(enabledAfter, JSON.stringify(enabledAfter)).toEqual([]);

    const panel = await openToolbarPanel(page, "text");
    await expectTabWrapsInPanel(page, panel);
    await expect(editorLocator(page).locator("td strong, td b")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("C11c 拖曳把手的面板：真鍵盤 Tab 在最後一個元素繞回 Back、Shift+Tab 回到最後一個，選單不關、不打字進筆記", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "keyboard block";
  const { context, page } = await startColorNote(browser, "tab handle", [line]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    await expectTabWrapsInPanel(page, panel);
  } finally {
    await context.close();
  }
});

test("C13 帶自訂行內色與 block 底色的段落複製貼上到另一份筆記：重新整理後顏色與原筆記相同", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: WIDE });
  try {
    const page = await context.newPage();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const stamp = Date.now();
    await createNote(page, `E2E colors copy source ${stamp}`);
    await pasteHtml(page, `<p data-background-color="${CUSTOM}">copy <span data-style-type="textColor" data-value="${CUSTOM}">me</span></p><p>tail</p>`);

    const probe = () =>
      editorLocator(page).evaluate((root, hex) => {
        const block = root.querySelector(`.bn-block:has(> .bn-block-content[data-background-color="${hex}"])`);
        const span = root.querySelector(`[data-style-type="textColor"][data-value="${hex}"]`);
        return {
          blockText: block?.querySelector(":scope > .bn-block-content")?.textContent ?? null,
          blockBg: block ? getComputedStyle(block).backgroundColor : null,
          spanText: span?.textContent ?? null,
          spanColor: span ? getComputedStyle(span).color : null,
        };
      }, CUSTOM);
    const expected = { blockText: "copy me", blockBg: RGB_CUSTOM, spanText: "me", spanColor: RGB_CUSTOM };
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);

    // 選取只在一個 block 的文字裡時，BlockNote 只複製行內內容（內建色也一樣），block 的底色要選取跨到別的 block 才會跟著走。
    // Ctrl+A 在這個編輯器是瀏覽器原生的全選，ProseMirror 讀回來是從第一段文字頭到最後一段文字尾的文字選取：只有一段時
    // 仍在那一段裡，所以後面多放一段 tail。原生全選要等 selectionchange 才讀進編輯器，複製前先等選取真的跨了 block。
    await clickEndOfParagraph(page, paragraph(page, "copy me"));
    await page.keyboard.press("ControlOrMeta+a");
    await expect
      .poll(() =>
        editorLocator(page).evaluate((el) => {
          type Sel = { empty: boolean; $from: { sameParent(other: unknown): boolean }; $to: unknown };
          const selection = (el as Element & { editor?: { view?: { state: { selection: Sel } } } }).editor?.view?.state.selection;
          return selection ? !selection.empty && !selection.$from.sameParent(selection.$to) : null;
        }),
      )
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items[0]?.types.includes("text/html") ? await (await items[0]!.getType("text/html")).text() : "";
    });
    expect(copied).toContain(`data-background-color="${CUSTOM}"`);

    const targetTitle = `E2E colors copy target ${stamp}`;
    await createNote(page, targetTitle);
    await editorLocator(page).click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);

    // 重新整理：貼上的色碼存進了這份筆記，規則在新頁面也產生得出來
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(targetTitle, { timeout: 15_000 });
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);
  } finally {
    await context.close();
  }
});

// ── 表格 ───────────────────────────────────────────────────────────────────

/** 2×2 表格：第一列 a1、b1，第二列 a2、b2。 */
const TABLE_HTML = "<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>";

/** 新筆記貼上 2×2 表格。 */
async function startTableNote(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page; title: string }> {
  const started = await startColorNote(browser, name, []);
  await pasteHtml(started.page, TABLE_HTML);
  const cells = editorLocator(started.page).locator("td");
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(3)).toHaveText("b2");
  return started;
}

/** 文字剛好是 `text` 的那一格。 */
function tableCell(page: Page, text: string): Locator {
  return editorLocator(page).locator("td").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

/** 每一列各格的文字（扣掉遠端游標的 widget）。 */
function tableTexts(page: Page): Promise<string[][]> {
  return editorLocator(page)
    .locator("tr")
    .evaluateAll((rows) =>
      rows.map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => {
          const copy = td.cloneNode(true) as Element;
          copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
          return copy.textContent ?? "";
        }),
      ),
    );
}

const cellHandle = (page: Page) => page.locator("button.bn-table-cell-handle");
// 列把手與欄把手是同一個元件，欄把手以 transform 轉 90 度
const rowHandle = (page: Page) => page.locator('.bn-table-handle:not([style*="rotate"])');
const columnHandle = (page: Page) => page.locator('.bn-table-handle[style*="rotate"]');

type Box = { x: number; y: number; width: number; height: number };
const overlapsX = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width;
const overlapsY = (a: Box, b: Box) => a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * 滑鼠移到 `text` 那一格，等儲存格把手、列把手、欄把手各剛好一個，且都對齊那一格。
 * boundingBox 在對到多個元素時會丟例外（重試到只剩一個）：把手浮層淡出時的複本也會被重試掉。
 */
async function hoverCell(page: Page, text: string): Promise<Locator> {
  const cell = tableCell(page, text);
  await cell.hover();
  await expect(async () => {
    const box = (await cell.boundingBox({ timeout: 1_000 }))!;
    const handle = await cellHandle(page).boundingBox({ timeout: 1_000 });
    const row = await rowHandle(page).boundingBox({ timeout: 1_000 });
    const column = await columnHandle(page).boundingBox({ timeout: 1_000 });
    const all = JSON.stringify({ box, handle, row, column });
    expect(handle && overlapsX(handle, box) && overlapsY(handle, box), `cell handle ${all}`).toBe(true);
    expect(row && overlapsY(row, box), `row handle ${all}`).toBe(true);
    expect(column && overlapsX(column, box), `column handle ${all}`).toBe(true);
  }).toPass({ timeout: 5_000 });
  return cell;
}

/** 以真滑鼠點把手開根選單，回傳這個把手自己的 dropdown（觸發鈕的 `aria-controls` 指向它）。 */
async function openTableMenu(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const id = await trigger.getAttribute("aria-controls");
  expect(id, "trigger aria-controls").toBeTruthy();
  const menu = page.locator(`[id="${id}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

/** 表格選單 → hover「Colors」開子選單 → 點該段的「Custom…」，回傳面板。 */
async function openTablePanel(menu: Locator, section: "text" | "background"): Promise<Locator> {
  await menu.getByRole("menuitem", { name: "Colors", exact: true }).hover();
  const custom = menu.locator(`[data-test="${section}-color-custom"]`);
  await expect(custom).toBeVisible();
  await custom.click();
  const panel = menu.locator(".kb-color-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

const panelHex = (panel: Locator) => panel.getByRole("textbox", { name: "Hex color" });
const panelApply = (panel: Locator) => panel.getByRole("button", { name: "Apply", exact: true });

test("C4a 儲存格把手：Colors → Background → Custom… 套 #ff6600，只有那一格上底色，重新整理後仍在", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, title } = await startTableNote(browser, "cell bg");
  try {
    await hoverCell(page, "b1");
    const menu = await openTableMenu(page, cellHandle(page));
    // 儲存格選單只有 Colors 一項（拆格沒開）
    await expect(menu.getByRole("menuitem")).toHaveText(["Colors"]);
    const panel = await openTablePanel(menu, "background");
    await panelHex(panel).fill(CUSTOM);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".kb-color-panel")).toHaveCount(0);

    const editor = editorLocator(page);
    await expect(tableCell(page, "b1")).toHaveAttribute("data-background-color", CUSTOM);
    await expect(tableCell(page, "b1")).toHaveCSS("background-color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(editor.locator("td[data-background-color]")).toHaveCount(1);

    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(tableCell(page, "b1")).toHaveCSS("background-color", RGB_CUSTOM, { timeout: 15_000 });
    await expect(editor.locator("td[data-background-color]")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("C4b 列把手：Colors → Text → Custom… 套 #0000ff，整列每一格都換字色，另一列不變", async ({ browser }) => {
  test.setTimeout(120_000);
  const blue = "#0000ff";
  const { context, page } = await startTableNote(browser, "row text");
  try {
    const before = await tableCell(page, "a2").evaluate((el) => getComputedStyle(el).color);
    expect(before).not.toBe("rgb(0, 0, 255)");

    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, rowHandle(page));
    const panel = await openTablePanel(menu, "text");
    await panelHex(panel).fill(blue);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);

    for (const text of ["a1", "b1"]) {
      await expect(tableCell(page, text)).toHaveAttribute("data-text-color", blue);
      await expect(tableCell(page, text), `${text} 的字色`).toHaveCSS("color", "rgb(0, 0, 255)", { timeout: 10_000 });
    }
    for (const text of ["a2", "b2"]) {
      await expect(tableCell(page, text)).not.toHaveAttribute("data-text-color");
      await expect(tableCell(page, text), `${text} 的字色`).toHaveCSS("color", before);
    }
  } finally {
    await context.close();
  }
});

test("C4c 列／欄把手選單：項目恰為刪除、兩個新增、Colors；新增一列、刪除一欄照常；畫面上只有一組把手", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "row col");
  try {
    await hoverCell(page, "a1");
    // 只有一組把手：內建的表格把手若沒關掉，會再疊一組
    await expect(cellHandle(page)).toHaveCount(1);
    await expect(page.locator(".bn-table-handle")).toHaveCount(2);
    await expect(rowHandle(page)).toHaveCount(1);
    await expect(columnHandle(page)).toHaveCount(1);

    // 關掉列選單後馬上開儲存格選單：列把手浮層淡出期間 DOM 裡還有一份列選單的複本，經 aria-controls 只查到儲存格選單
    const peek = await openTableMenu(page, rowHandle(page));
    await expect(peek.getByRole("menuitem")).toHaveText(["Delete row", "Add row above", "Add row below", "Colors"]);
    await page.keyboard.press("Escape");
    await expect(rowHandle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(cellHandle(page)).toHaveCount(1);
    const cellMenu = await openTableMenu(page, cellHandle(page));
    await expect(cellMenu.getByRole("menuitem")).toHaveText(["Colors"]);
    await page.keyboard.press("Escape");
    await expect(cellHandle(page)).toHaveAttribute("aria-expanded", "false");

    // 新增一列（在第一列下方）
    await hoverCell(page, "a1");
    const rowMenu = await openTableMenu(page, rowHandle(page));
    await expect(rowMenu.getByRole("menuitem")).toHaveText(["Delete row", "Add row above", "Add row below", "Colors"]);
    await rowMenu.getByRole("menuitem", { name: "Add row below", exact: true }).click();
    await expect.poll(() => tableTexts(page)).toEqual([["a1", "b1"], ["", ""], ["a2", "b2"]]);

    // 刪除第二欄
    await hoverCell(page, "b2");
    const columnMenu = await openTableMenu(page, columnHandle(page));
    await expect(columnMenu.getByRole("menuitem")).toHaveText(["Delete column", "Add column left", "Add column right", "Colors"]);
    await columnMenu.getByRole("menuitem", { name: "Delete column", exact: true }).click();
    await expect.poll(() => tableTexts(page)).toEqual([["a1"], [""], ["a2"]]);

    // 改完表格，把手仍只有一組
    await hoverCell(page, "a2");
    await expect(cellHandle(page)).toHaveCount(1);
    await expect(page.locator(".bn-table-handle")).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test("C4d 儲存格把手的面板開著時，另一個分頁刪掉整張表：面板跟著表格消失、什麼都沒寫入，頁面不丟例外", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page: pageA, title } = await startTableNote(browser, "cell remote delete");
  const errors: string[] = [];
  pageA.on("pageerror", (error) => errors.push(error.message));
  try {
    // 同一個 context 共用 cookie，不必再登入。等 B 載入完成、連上共編、看到表格。
    const pageB = await context.newPage();
    pageB.on("pageerror", (error) => errors.push(`B: ${error.message}`));
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const editorB = editorLocator(pageB);
    await expect(editorB.locator("td")).toHaveCount(4, { timeout: 10_000 });

    // A：儲存格把手開到自訂面板，打好色碼但還沒套用
    await hoverCell(pageA, "b1");
    const menu = await openTableMenu(pageA, cellHandle(pageA));
    const panel = await openTablePanel(menu, "background");
    await panelHex(panel).fill(CUSTOM);
    await expect(panelApply(panel)).toBeEnabled();

    // B：表格的拖曳把手選單 → Delete，整張表從文件裡拿掉
    const tableB = editorB.locator(".bn-block-content", { has: pageB.locator("table") }).first();
    await editorB.locator("td", { hasText: "a2" }).first().hover();
    const handle = pageB.getByRole("button", { name: "Open block menu" });
    await expect(handle).toBeVisible();
    await expect(async () => {
      const side = await pageB.locator(".bn-side-menu").boundingBox();
      const box = await tableB.boundingBox();
      expect(side && box && overlapsY(side, box), JSON.stringify({ side, box })).toBe(true);
    }).toPass({ timeout: 5_000 });
    await handle.click();
    const blockMenu = pageB.locator(".bn-drag-handle-menu");
    await expect(blockMenu).toBeVisible();
    await blockMenu.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(editorB.locator("table")).toHaveCount(0);

    // A：表格消失，把手與面板跟著卸載
    await expect(editorLocator(pageA).locator("table")).toHaveCount(0, { timeout: 10_000 });
    await expect(pageA.locator(".kb-color-panel")).toHaveCount(0, { timeout: 10_000 });
    // 什麼都沒寫入：每隔 200 ms 讀一次、讀滿三次，每次兩頁都沒有表格、也沒有這個底色
    const reads: number[][] = [];
    await expect
      .poll(
        async () => {
          reads.push(await Promise.all([pageA, pageB].map((p) => editorLocator(p).locator(`table, [data-background-color="${CUSTOM}"]`).count())));
          return reads.length >= 3 ? reads : "reading";
        },
        { intervals: [200] },
      )
      .toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("C11a 儲存格把手的面板：在飽和度方塊按下、拖到面板外 150 px 停住再放開，面板仍在、值已變、Apply 生效", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "cell drag outside");
  try {
    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, cellHandle(page));
    const panel = await openTablePanel(menu, "background");
    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    const box = (await panel.boundingBox())!;
    const y = sat.y + sat.height * 0.5;
    // 往右拖出面板 160 px；右邊放不下就往左
    const outsideX = box.x + box.width + 160 < WIDE.width - 10 ? box.x + box.width + 160 : box.x - 160;
    await page.mouse.move(sat.x + sat.width * 0.6, sat.y + sat.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.3, y, { steps: 5 });
    await expect.poll(() => panelHex(panel).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // 面板內拖到的值；拖出面板後指標仍被追蹤，飽和度貼到邊（0% 或 100%），值要再變
    const inside = await panelHex(panel).inputValue();
    await page.mouse.move(outsideX, y, { steps: 10 });
    // 停得比子選單的關閉延遲久：面板若放在 hover 開關的子選單裡，這段時間就會被關掉
    await page.waitForTimeout(500);
    await page.mouse.up();

    await expect(panel).toBeVisible();
    await expect.poll(() => panelHex(panel).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await panelHex(panel).inputValue();
    expect(dragged).not.toBe(inside);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);
    await expect(tableCell(page, "a1")).toHaveAttribute("data-background-color", dragged);
    await expect(tableCell(page, "a1")).toHaveCSS("background-color", hexToRgb(dragged), { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C11b 儲存格把手的面板：打色碼到一半把滑鼠移到編輯器另一端停住，再打完按 Enter，套上完整色碼", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "cell type move");
  try {
    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, cellHandle(page));
    const panel = await openTablePanel(menu, "text");
    await panelHex(panel).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#ff6");
    await expect(panelHex(panel)).toHaveValue("#ff6");

    const editorBox = (await editorLocator(page).boundingBox())!;
    await page.mouse.move(editorBox.x + editorBox.width - 10, editorBox.y + editorBox.height - 5, { steps: 10 });
    await page.waitForTimeout(500);
    await expect(panel).toBeVisible();

    await page.keyboard.type("600");
    await expect(panelHex(panel)).toHaveValue("#ff6600");
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(tableCell(page, "a1")).toHaveAttribute("data-text-color", CUSTOM);
    await expect(tableCell(page, "a1")).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});
