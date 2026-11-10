import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * 自訂色碼（任意 #rrggbb 的文字色與底色）的顯示面 e2e。
 *
 * - C7：同一份筆記在編輯器、公開頁、版本預覽、簡報四個面，自訂色碼的 computed 色值都要對，且內建色名
 *   （`red`）的對照元素維持內建值（防止「全部變成同一色」的假綠）。
 * - C8：C7 全程不得出現任何 `securitypolicyviolation`（自訂色碼的規則是 JS 動態插入的，不可靠 inline style 或 `unsafe-inline`）。
 * - C12：同一個 context 的兩個分頁開同一篇筆記；A 貼上自訂色碼後，B 不重新整理就要顯示出來（遠端共編者套的色碼不會經過本機操作）。
 *
 * 色碼是怎麼放進筆記的：本檔只關心「已經在文件裡」的色碼如何顯示，所以用貼上 HTML 放（`pasteHtml`）。
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
