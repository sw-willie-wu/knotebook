import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * #229 簡報模式（spec §13.4）：E1 入口與導覽、E2 即時更新保位、E3 公開連結、E4 CSP、E5 改名不斷簡報、
 * E6 觸控（CDP Input.dispatchTouchEvent）、E7 側欄進入。
 *
 * - 「目前投影片」一律讀 DOM：`.reveal .slides section.present[data-kn-slide-id]`（reveal 實例不外露；起草裁定 8）。
 * - 內容用貼上 markdown 建（14-table-hover 的手法）：標題 → `##`／`###`，表格 → markdown table。
 * - 全螢幕：headless chromium 的行為見 S7（Step 2）；「瀏覽器吃掉 Esc」以 `document.exitFullscreen()` 模擬，之後等 > 300 ms
 *   （防連退窗口，§6.6-1）再按 Esc。
 */

const ORIGIN = "http://localhost:3100";
const INVALID_LINK_TEXT = "This link doesn't exist or is no longer active.";

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

const DECK = ["Intro paragraph", "", "## Chapter A", "", "alpha text", "", "### Section A2", "", "a2 text", "", "## Chapter B", "", "beta text", "", "### Section B2", "", "b2 text", ""].join("\n");

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

async function leaveFullscreenLikeBrowserEsc(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await page.waitForTimeout(350); // §6.6-1 的 300 ms 防連退窗口
}

/** 觸控手勢（spec §13.4 E6：CDP Input.dispatchTouchEvent）。 */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
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

/** 10×3000 的灰色 PNG：載入後讓投影片溢出（E6 的延遲載入圖片）。 */
function tallPng(width = 10, height = 3000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function adminPageWithNote(browser: Browser, title: string, markdown: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, title);
  await pasteMarkdown(page, markdown);
  return { context, page };
}

test("E1：⋮ 進入、換頁寫 hash 不增 history、O 總覽／Esc 只關總覽、兩段 Esc 回筆記、編輯器未重掛", async ({ browser }) => {
  test.setTimeout(120_000);
  const title = `E2E present ${Date.now()}`;
  const { context, page } = await adminPageWithNote(browser, title, DECK);
  try {
    await expect(editorLocator(page).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
    // spec §13.4-1「剛打的字還在」：進入簡報前另外打一段，回來後斷言它還在（r2-p3 MINOR 6）
    await editorLocator(page).getByText("b2 text").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" typed-before-present");
    await expect(editorLocator(page).getByText("b2 text typed-before-present")).toBeVisible();
    await page.evaluate(() => { (document.querySelector('[data-testid="note-editor"]') as HTMLElement & { __kn?: number }).__kn = 1; });

    // S8（§2.6-15【推】）：編輯器 block 帶 data-id；簡報的 <section> 不帶 id／data-id（A11）。
    expect(await page.locator('[data-testid="note-editor"] [data-id]').count()).toBeGreaterThan(0);

    await presentFromHeaderMenu(page, title);
    expect(new URL(page.url()).search).toBe("?present");
    expect(await page.locator(".reveal .slides section[id], .reveal .slides section[data-id]").count()).toBe(0);

    // S7（Step 2 判準）：分支 A＝headless chromium 真的進全螢幕。
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);

    const historyLength = await page.evaluate(() => history.length);
    await page.keyboard.press("ArrowRight");
    const chapterA = await slideIdContaining(page, "Chapter A");
    await expect.poll(() => currentSlideId(page)).toBe(chapterA);
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${chapterA}`);
    await page.keyboard.press("ArrowDown");
    const a2 = await slideIdContaining(page, "Section A2");
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${a2}`);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    await page.keyboard.press("o");
    await expect(page.locator(".reveal.overview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".reveal.overview")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();

    await leaveFullscreenLikeBrowserEsc(page);
    await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible(); // 第一下只退全螢幕
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
    await expect(editorLocator(page).getByText("b2 text typed-before-present")).toBeVisible();
    expect(await page.evaluate(() => (document.querySelector('[data-testid="note-editor"]') as HTMLElement & { __kn?: number }).__kn)).toBe(1);

    // §12【推】的佐證（不是【驗】：沒斷言 reveal.css 的 html／body overflow 規則真的套用）：列印媒體下內文仍看得到。
    await page.emulateMedia({ media: "print" });
    await expect(editorLocator(page).getByText("b2 text")).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  } finally {
    await context.close();
  }
});

test("E2：A 播放中、B 編輯——A 3 s 內看到變動且停在同一張；B 刪掉 A 目前那張的起始標題 → A 到前一張", async ({ browser }) => {
  test.setTimeout(150_000);
  const title = `E2E present live ${Date.now()}`;
  const { context: contextA, page: pageA } = await adminPageWithNote(browser, title, DECK);
  const contextB = await browser.newContext();
  try {
    await expect(editorLocator(pageA).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
    const noteUrl = pageA.url();
    const pageB = await contextB.newPage();
    await loginAs(pageB, ADMIN.email, ADMIN.password);
    await pageB.goto(noteUrl);
    await expect(editorLocator(pageB).getByText("b2 text")).toBeVisible({ timeout: 15_000 });

    await presentFromHeaderMenu(pageA, title);
    const fullscreenBefore = await pageA.evaluate(() => document.fullscreenElement !== null);
    await pageA.keyboard.press("ArrowRight");
    await pageA.keyboard.press("ArrowRight");
    await pageA.keyboard.press("ArrowDown");
    const b2 = await slideIdContaining(pageA, "Section B2");
    await expect.poll(() => currentSlideId(pageA)).toBe(b2);

    // B 在第一章加字
    await editorLocator(pageB).getByText("alpha text").click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" plus");
    await expect(pageA.locator(".reveal .slides").getByText("alpha text plus")).toBeAttached({ timeout: 3_000 });
    expect(await currentSlideId(pageA)).toBe(b2);

    // B 把 A 目前那張的起始標題（### Section B2）改成段落（Q2 的解讀）→ 那張消失 → A 到前一張（Chapter B）
    await editorLocator(pageB).getByText("Section B2").click();
    await pageB.keyboard.press("Home");
    // S-E2：Ctrl+Alt+0 在 headless chromium 約五成不生效（B 端標題仍是 heading）；改為 block 開頭按 Backspace（BlockNote 會把非段落 block 轉成段落）。
    await pageB.keyboard.press("Backspace");
    await expect(editorLocator(pageB).locator('[data-content-type="heading"]', { hasText: "Section B2" })).toHaveCount(0);
    const chapterB = await slideIdContaining(pageA, "Chapter B");
    await expect.poll(() => currentSlideId(pageA), { timeout: 5_000 }).toBe(chapterB);
    expect(await pageA.evaluate(() => document.fullscreenElement !== null)).toBe(fullscreenBefore);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("E3：匿名開公開連結簡報——wikilink 純文字、圖片載得出來、回焦重抓後更新並保位、撤銷後關層顯示失效卡", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    const targetTitle = `E2E wikitarget ${stamp}`; // 查詢只打 stamp：髒疊上舊的 wikitarget 筆記不會被選到（r1-p3 MINOR 1）
    await createNote(owner, targetTitle);
    const title = `E2E present public ${Date.now()}`;
    await createNote(owner, title);
    const noteId = await noteIdFromUrl(owner);

    // 圖：走 API 真上傳（同 11-public-share 的「真上傳」要求），再以 markdown 圖片語法放進筆記。
    const upload = await owner.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "tall.png", mimeType: "image/png", buffer: tallPng(40, 40) } },
    });
    expect(upload.status()).toBe(201);
    const { url: imageUrl } = (await upload.json()) as { url: string };
    await pasteMarkdown(owner, ["## Slide One", "", "one text", "", `![pic](${imageUrl})`, "", "## Slide Two", "", "two text", ""].join("\n"));
    await expect(editorLocator(owner).getByText("two text")).toBeVisible({ timeout: 15_000 });

    // wikilink：在 Slide Two 內文後打 [[ ＋目標標題前綴，選第一個建議（Step 2 S-E3 判準）
    await editorLocator(owner).getByText("two text").click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" see [[");
    await owner.keyboard.type(stamp);
    await expect(owner.locator(".bn-suggestion-menu")).toBeVisible({ timeout: 10_000 });
    // 先等 target 出現在選單裡：['notes'] 快取還沒收到它時，第一項會是「建立並連結」（r2-p3 MINOR 5）
    await expect(owner.locator(".bn-suggestion-menu").getByText(targetTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
    await owner.keyboard.press("Enter");

    // 公開連結（同 11-public-share 的 ShareDialog 操作）
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = owner.getByRole("dialog", { name: "Share note" });
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    await publicRadio.check();
    const token = await dialog.getByLabel("Public link URL").inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await owner.keyboard.press("Escape");
    await expect(async () => {
      const res = await owner.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(stamp);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(`/p/${token}`);
    await anon.getByRole("button", { name: "Present" }).click();
    await expect(anon.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    expect(new URL(anon.url()).search).toBe("?present");
    const twoId = await slideIdContaining(anon, "Slide Two");
    // wikilink 純文字：簡報裡找得到標題文字，但不在任何 <a> 裡
    await expect(anon.locator(".reveal .slides").getByText(targetTitle, { exact: false })).toBeAttached();
    expect(await anon.locator(".reveal .slides a", { hasText: targetTitle }).count()).toBe(0);
    // 圖：公開端點、真的解得出像素
    const img = anon.locator(`.reveal .slides img[src*="/api/public/notes/${token}/uploads/"]`);
    await expect(img).toBeAttached();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // 停在 Slide Two；owner 改 Slide One → 匿名端回焦重抓後更新、仍在 Slide Two
    await anon.keyboard.press("ArrowRight");
    await anon.keyboard.press("ArrowRight");
    await expect.poll(() => currentSlideId(anon)).toBe(twoId);
    await editorLocator(owner).getByText("one text").click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" updated");
    await expect(async () => {
      await anon.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(anon.locator(".reveal .slides").getByText("one text updated")).toBeAttached({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    expect(await currentSlideId(anon)).toBe(twoId);

    // 匿名直接開 /p/<token>?present（spec §13.4 E3 原文；r1-p3 MINOR 2）
    await anon.goto(`/p/${token}?present`);
    await expect(anon.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    expect(new URL(anon.url()).search).toBe("?present");

    // 撤銷（切回 Members only，同 11-public-share）→ 匿名端回焦後簡報層關閉、顯示失效卡
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("dialog", { name: "Share note" }).getByRole("radio", { name: /^Members only/ }).check();
    await owner.keyboard.press("Escape");
    await expect(async () => {
      await anon.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(anon.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(anon.getByRole("dialog")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});

test("E4：簡報 chunk／CSS、mermaid、程式碼、總覽、全螢幕切換 → 零 CSP violation（含正向對照）", async ({ page }) => {
  test.setTimeout(120_000);
  interface Violation { directive: string; blockedURI: string }
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E present csp ${Date.now()}`;
  await createNote(page, title);
  await pasteMarkdown(page, ["## Code", "", "```ts", 'const x = "hi";', "```", "", "## Diagram", "", "## Video", ""].join("\n"));
  // mermaid（同 09-csp 的 slash 流程）
  const editor = editorLocator(page);
  await editor.getByText("Diagram").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("flowchart TD\n  A[Start] --> B[End]");
  await source.press("Escape");
  await expect(editor.locator("svg[aria-roledescription]").first()).toBeVisible({ timeout: 20_000 });

  // 影片（spec §13.4 E4 明列；r1-p3 M4）：video 沒有上傳路徑，只能 embed 網址——用同源、剛上傳的 png（只要求載入不觸發
  // CSP、不要求能播；media-src 是 'self' http: https:）。面板是本 app 的 components/FilePanel.tsx（見 Step 2 S-E4）。
  const noteId = await noteIdFromUrl(page);
  const upload = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "v.png", mimeType: "image/png", buffer: tallPng(40, 40) } },
  });
  expect(upload.status()).toBe(201);
  const { url: mediaUrl } = (await upload.json()) as { url: string };
  // 前面 mermaid 步驟留下的浮動格式工具列可能蓋住「Video」標題而攔截點擊（重複跑約三成逾時）；Escape 收掉它。
  await page.keyboard.press("Escape");
  await editor.getByText("Video").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await editor.pressSequentially("/video");
  await page.getByText("Resizable video with caption").click();
  // slash 插入後 BlockNote 自動開檔案面板；本 app 的面板對非 image block 沒有 tab 列，直接是 Embed 表單
  await page.getByPlaceholder("Paste a link…").fill(`${ORIGIN}${mediaUrl}`);
  await page.getByRole("button", { name: "Embed", exact: true }).click();
  await expect(editor.locator("video").first()).toBeAttached({ timeout: 10_000 });

  await presentFromHeaderMenu(page, title);
  await expect(page.locator(".reveal .slides svg[aria-roledescription]").first()).toBeAttached({ timeout: 20_000 });
  await page.keyboard.press("o");
  await expect(page.locator(".reveal.overview")).toBeVisible();
  await page.keyboard.press("o");
  await page.keyboard.press("f");
  await page.keyboard.press("f");
  // 影片落在哪一張取決於前面點擊把游標放在字中間的位置（重複跑時標題會被拆開、block 次序也會變），所以不假設「含 Video 字樣的那張」，
  // 改找「含 <video> 的那張」再逐張往右走過去（這份牌組全是 H2，沒有縱向堆疊）。
  const videoSlide = await page.evaluate(() => document.querySelector(".reveal .slides section[data-kn-slide-id]:has(video)")?.getAttribute("data-kn-slide-id") ?? null);
  expect(videoSlide, "簡報裡找不到含 <video> 的投影片").not.toBeNull();
  for (let i = 0; i < 8 && (await currentSlideId(page)) !== videoSlide; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => currentSlideId(page)).toBe(videoSlide);
  await expect(page.locator(`section[data-kn-slide-id="${videoSlide}"] video[controls]`)).toBeAttached();
  await page.waitForTimeout(500); // 讓 video 的載入嘗試發生後再收 violation

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
  expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  // 正向對照（同 09-csp）：注入 inline script 必須被擋
  const pwned = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspPositiveControl = true;";
    document.head.appendChild(script);
    return (window as unknown as { __cspPositiveControl?: boolean }).__cspPositiveControl ?? false;
  });
  expect(pwned).toBe(false);
});

test("E5：播放中改名 → 網址換 slug、?present＋hash 保留、仍在同一張、簡報層同一實例", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E present rename ${Date.now()}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
  const noteId = await noteIdFromUrl(page);
  await presentFromHeaderMenu(page, title);
  await page.keyboard.press("ArrowRight");
  const chapterA = await slideIdContaining(page, "Chapter A");
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/${chapterA}`);
  await page.evaluate(() => { (document.querySelector(".reveal") as HTMLElement & { __kn?: number }).__kn = 1; });
  const oldPath = new URL(page.url()).pathname;

  const renamed = `${title} renamed`;
  const res = await page.request.patch(`/api/notes/${noteId}`, { headers: { Origin: ORIGIN }, data: { title: renamed } });
  expect(res.ok()).toBe(true);
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    expect(new URL(page.url()).pathname).not.toBe(oldPath);
  }).toPass({ timeout: 15_000 });
  const url = new URL(page.url());
  expect(url.search).toBe("?present");
  expect(url.hash).toBe(`#/${chapterA}`);
  expect(await currentSlideId(page)).toBe(chapterA);
  expect(await page.evaluate(() => (document.querySelector(".reveal") as HTMLElement & { __kn?: number }).__kn)).toBe(1);
});

test("E6：觸控——未溢出的投影片滑動換頁；溢出的投影片與表格手指捲動不換頁；延遲載入圖片後變溢出；控制箭頭換頁", async ({ browser }) => {
  test.setTimeout(180_000);
  const title = `E2E present touch ${Date.now()}`;
  const longLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n");
  const cols = 20;
  const table = [
    `| ${Array.from({ length: cols }, (_, i) => `WideHeader${i + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: cols }, (_, i) => `W1C${i + 1}`).join(" | ")} |`,
  ].join("\n");
  const { context: desktop, page: owner } = await adminPageWithNote(browser, title, ["## Short", "", "short text", "", "## Long", "", longLines, "", "## Table", "", table, "", "## Stack", "", "stack text", "", "### Child", "", "child text", "", "## Picture", ""].join("\n"));
  const mobile = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 640 } });
  try {
    await expect(editorLocator(owner).getByText("line 60")).toBeVisible({ timeout: 15_000 });
    const noteId = await noteIdFromUrl(owner);
    const upload = await owner.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "tall.png", mimeType: "image/png", buffer: tallPng() } },
    });
    expect(upload.status()).toBe(201);
    const { url: imageUrl } = (await upload.json()) as { url: string };
    await pasteMarkdown(owner, `![tall](${imageUrl})\n`);
    await expect(editorLocator(owner).locator(`img[src*="${imageUrl}"]`)).toBeVisible({ timeout: 15_000 });
    const noteUrl = owner.url();

    const page = await mobile.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    // 圖片回應掛住，走到 Picture 之後才放行（§6.8 的 img load 重算）——用 deferred 控制，不假設時間（r1-p3 MINOR 6）
    let releaseImage: () => void = () => {};
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route("**/api/uploads/**", async (route) => {
      await imageGate;
      await route.continue();
    });
    await page.goto(`${noteUrl}?present`);
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
    const short = await slideIdContaining(page, "short text");
    const long = await slideIdContaining(page, "line 60");
    const tableSlide = await slideIdContaining(page, "WideHeader1");
    const stack = await slideIdContaining(page, "stack text");
    const child = await slideIdContaining(page, "child text");
    const picture = await slideIdContaining(page, "Picture");

    // 封面 → Short（鍵盤），在 Short 上水平滑動 → 換到 Long
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => currentSlideId(page)).toBe(short);
    await swipe(page, { x: 330, y: 320 }, { x: 60, y: 320 });
    await expect.poll(() => currentSlideId(page)).toBe(long);

    // Long 溢出：垂直滑動 → 捲動、不換頁
    await expect(page.locator(`section[data-kn-slide-id="${long}"]`)).toHaveAttribute("data-prevent-swipe", "");
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => page.locator(`section[data-kn-slide-id="${long}"]`).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(long);

    // 控制箭頭 → Table；在表格上水平滑動 → 包裝層 scrollLeft 增加、不換頁
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(tableSlide);
    const wrap = page.locator(`section[data-kn-slide-id="${tableSlide}"] .kn-present-table`);
    const box = (await wrap.boundingBox())!;
    await swipe(page, { x: box.x + box.width - 20, y: box.y + box.height / 2 }, { x: box.x + 20, y: box.y + box.height / 2 });
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(tableSlide);

    // 有縱向子投影片的章：沒溢出，手指向上滑 → 進到下一張縱向投影片（touch-action:none 的 app 修正守著；pan-y 會讓這步壞掉）
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(stack);
    expect(await page.locator(`section[data-kn-slide-id="${stack}"]`).getAttribute("data-prevent-swipe")).toBeNull();
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => currentSlideId(page)).toBe(child);

    // Picture：圖還沒到 → 不溢出；到了 → 溢出、垂直滑動捲動不換頁
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(picture);
    const pictureSection = page.locator(`section[data-kn-slide-id="${picture}"]`);
    expect(await pictureSection.getAttribute("data-prevent-swipe")).toBeNull();
    releaseImage();
    await expect.poll(() => pictureSection.locator("img").evaluate((el) => (el as HTMLImageElement).naturalHeight), { timeout: 40_000 }).toBeGreaterThan(0);
    await expect(pictureSection).toHaveAttribute("data-prevent-swipe", "");
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => pictureSection.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(picture);
  } finally {
    await mobile.close();
    await desktop.close();
  }
});

test("E7：側欄別篇 ⋮「簡報模式」→ 直接打開那篇的簡報；Esc（滿版）→ 落在那篇的一般筆記頁", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const target = `E2E present target ${Date.now()}`;
  await createNote(page, target);
  await pasteMarkdown(page, "## Target chapter\n\ntarget text\n");
  await expect(editorLocator(page).getByText("target text")).toBeVisible({ timeout: 15_000 });
  const targetPath = new URL(page.url()).pathname;
  await createNote(page, `E2E present other ${Date.now()}`);

  const row = page.getByRole("button", { name: `Note actions for ${target}` }).first();
  await row.hover();
  await row.click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${target} — presentation` })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe(targetPath);
  expect(new URL(page.url()).search).toBe("?present");

  await leaveFullscreenLikeBrowserEsc(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(targetPath);
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByLabel("Note title")).toHaveValue(target);
});
