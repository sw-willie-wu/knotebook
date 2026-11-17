import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, solidPng } from "./helpers.js";

/**
 * #462 圖片與 mermaid 圖的放大檢視。
 *
 * 59-1 桌機圖片（1280×800）：滑到圖上才出現放大鈕；點了開全螢幕檢視（名稱是圖的 alt），一開始放得進視窗，
 *      滾輪放大；Esc 關掉、焦點回放大鈕。編輯模式點圖本身是選取，不開放大。
 * 59-2 桌機 mermaid：滑到圖上控制組現身，放大鈕在「Edit」右邊；放大內容是同一張圖的 `<svg>`（不是點陣圖、根 id 另換），
 *      坐在卡面底色上（淺色主題的線與字才看得見）；滾輪放大；Esc 焦點回放大鈕。點圖本身照舊進原始碼編輯。
 * 59-3 公開頁（唯讀、免登入）：點圖直接開放大，Esc 焦點回到圖；mermaid 圖聚焦後按 Enter 開放大。
 * 59-4 手機可編輯（觸控、390×844）：點圖（選取）前沒有放大鈕，點了才出現；放大畫面佔滿視窗，關閉鈕整顆在視窗內，按它關掉。
 * 59-5 手機 mermaid：觸控裝置沒有 hover，右上控制組常駐淡色（看得到才點得到）。
 *
 * 帳號與資料：用邀請建一個帳號（alice），每個案例自己以 API 建一篇有圖片與 mermaid 圖的筆記。
 * 雙指縮放與 PWA 的 safe area 量不到，要在實機上看。
 */

// Playwright 的動作預設沒有逾時：點不到就一直等到整個案例逾時，看不出卡在哪一步
test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-media-zoom-pw";
const ORIGIN = E2E_ORIGIN;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const IMAGE = { width: 1600, height: 1000 };

let alice: { email: string; displayName: string };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
});

interface NoteRef {
  id: string;
  title: string;
  path: string;
}

/** 建一篇筆記：先上傳一張 1600×1000 的圖，再整篇寫入（一段字、那張圖顯示成寬 400、一張 mermaid 圖）。 */
async function createZoomNote(page: Page, label: string): Promise<NoteRef> {
  const title = `E2E media zoom ${label} ${RUN}`;
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "box.png", mimeType: "image/png", buffer: solidPng(IMAGE.width, IMAGE.height) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { url } = (await upload.json()) as { url: string };
  const current = await page.request.get(`/api/notes/${note.id}/content`);
  const { fingerprint } = (await current.json()) as { fingerprint: string };
  const markdown = [
    "lead words",
    "",
    `<figure><img alt="box" src="${url}" width="400"></figure>`,
    "",
    "```mermaid",
    "graph LR",
    "  A[ZoomStart] --> B[ZoomEnd]",
    "```",
    "",
    "tail words",
  ].join("\n");
  const written = await page.request.post(`/api/notes/${note.id}/edits`, {
    headers: { Origin: ORIGIN },
    data: { op: "replace_all", markdown, if_match: fingerprint },
  });
  expect(written.status(), await written.text()).toBeLessThan(300);
  return { id: note.id, title, path: `/n/${note.ownerHandle}/${note.slug}` };
}

/** 登入 alice、建筆記並打開；等標題框、可編輯的編輯器與載好的圖。 */
async function openZoomNote(
  browser: Browser,
  label: string,
  options: { viewport: { width: number; height: number }; touch?: boolean },
): Promise<{ context: BrowserContext; page: Page; note: NoteRef }> {
  const context = await browser.newContext(
    options.touch ? { hasTouch: true, isMobile: true, viewport: options.viewport } : { viewport: options.viewport },
  );
  const page = await context.newPage();
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  const note = await createZoomNote(page, label);
  await page.goto(note.path);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(editorLocator(page)).toBeVisible({ timeout: 15_000 });
  await expectLoaded(editorImage(page));
  return { context, page, note };
}

function editorImage(page: Page): Locator {
  return editorLocator(page).locator('[data-content-type="image"] img').first();
}

function mermaidBlock(page: Page): Locator {
  return editorLocator(page).locator('[data-content-type="mermaid"]').first();
}

/** 圖片的放大鈕在編輯欄上的浮動層裡（不在 block 內）。 */
function imageZoomButton(page: Page): Locator {
  return page.locator("[data-kb-zoom-layer]").getByRole("button", { name: "Zoom in", exact: true });
}

/** naturalWidth > 0 ＝瀏覽器真的抓到並解碼了圖（破圖時是 0）。 */
async function expectLoaded(img: Locator): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
}

async function widthOf(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  expect(box, "元素要有版面").not.toBeNull();
  return box!.width;
}

/** 在放大畫面中央往上捲一次滾輪，內容要變寬。 */
async function expectWheelZoomsIn(page: Page, viewport: { width: number; height: number }, content: Locator): Promise<void> {
  const before = await widthOf(content);
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => widthOf(content)).toBeGreaterThan(before + 1);
}

test("59-1 桌機圖片：hover 才出現放大鈕，點了開放大、滾輪放大、Esc 焦點回鈕；點圖本身是選取", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "desktop image", { viewport: DESKTOP });
  try {
    const img = editorImage(page);
    const button = imageZoomButton(page);
    await expect(button).toHaveCount(0);
    await img.hover();
    await expect(button).toBeVisible();

    await button.click();
    const dialog = page.getByRole("dialog", { name: "box" });
    await expect(dialog).toBeVisible();
    const zoomed = dialog.locator("img");
    await expect(zoomed).toBeVisible();
    // 一開始放得進視窗（1600 寬的圖在 1280 寬的視窗裡縮小）
    expect(await widthOf(zoomed)).toBeLessThanOrEqual(DESKTOP.width + 0.5);
    await expectWheelZoomsIn(page, DESKTOP, zoomed);

    // 按 Esc 時指標停在 mermaid 圖的位置：關掉後指標底下是別的區塊、不是圖，焦點仍要回放大鈕
    const other = (await mermaidBlock(page).boundingBox())!;
    expect(other.y + other.height / 2, "前提：mermaid 圖在視窗內").toBeLessThan(DESKTOP.height);
    await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    // 編輯模式點圖片本身：選取（出現圖片的浮動工具列），不開放大
    await img.click();
    await expect(page.locator(".bn-formatting-toolbar")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-2 桌機 mermaid：放大鈕在 Edit 右邊，放大的是同一張圖的 svg、坐在卡面上，Esc 焦點回鈕；點圖本身進原始碼", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "desktop mermaid", { viewport: DESKTOP });
  try {
    const block = mermaidBlock(page);
    const pageSvg = block.locator("svg[aria-roledescription]");
    await expect(pageSvg).toBeVisible({ timeout: 20_000 });
    await expect(pageSvg).toContainText("ZoomStart");

    // 控制組平常透明，滑到圖上才現身
    const group = block.locator(".block-control-group");
    await expect(group).toHaveCSS("opacity", "0");
    await block.hover();
    await expect(group).toHaveCSS("opacity", "1");
    const zoom = block.getByRole("button", { name: "Zoom in", exact: true });
    const edit = block.getByRole("button", { name: "Edit", exact: true });
    await expect(zoom).toBeVisible();
    await expect(edit).toBeVisible();
    expect((await zoom.boundingBox())!.x, "放大鈕在 Edit 右邊").toBeGreaterThan((await edit.boundingBox())!.x);

    await zoom.click();
    const dialog = page.getByRole("dialog", { name: "Diagram", exact: true });
    await expect(dialog).toBeVisible();
    const zoomedSvg = dialog.locator("svg[aria-roledescription]");
    await expect(zoomedSvg).toHaveCount(1);
    await expect(dialog.locator("img")).toHaveCount(0);
    await expect(zoomedSvg).toContainText("ZoomStart");
    const [pageId, zoomedId] = [await pageSvg.getAttribute("id"), await zoomedSvg.getAttribute("id")];
    expect(zoomedId, "放大的那份換了根 id").not.toBe(pageId);

    // 內容坐在卡面底色上：淺色主題的 mermaid 用深灰畫線與字、svg 本身沒有底色，直接放在深色背板上會看不見
    const colors = await zoomedSvg.evaluate((svg) => {
      const probe = document.createElement("div");
      probe.className = "bg-card";
      document.body.appendChild(probe);
      const card = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { content: getComputedStyle(svg.parentElement!).backgroundColor, card };
    });
    expect(colors.card).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.content, "放大內容的底色是卡面色").toBe(colors.card);

    await expectWheelZoomsIn(page, DESKTOP, zoomedSvg);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(zoom).toBeFocused();

    // 點圖本身：照舊進原始碼編輯，不開放大
    await pageSvg.click();
    await expect(page.getByRole("textbox", { name: "Mermaid source" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-3 公開頁：點圖直接放大、Esc 焦點回圖；mermaid 圖聚焦後 Enter 放大", async ({ browser }) => {
  test.setTimeout(120_000);
  let note: NoteRef;
  let token: string;
  const owner = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await owner.newPage();
    await loginAs(page, alice.email, PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    note = await createZoomNote(page, "public");
    const res = await page.request.put(`/api/notes/${note.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    token = ((await res.json()) as { token: string }).token;
    // 公開端點讀的是存下來的內容：等它含上傳網址（＝圖已經寫進去）再開
    await expect(async () => {
      const pub = await page.request.get(`/api/public/notes/${token}`);
      expect(pub.status()).toBe(200);
      const body = (await pub.json()) as { ydoc: string };
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain("/api/uploads/");
    }).toPass({ timeout: 20_000 });
  } finally {
    await owner.close();
  }

  const anonymous = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await anonymous.newPage();
    await page.goto(`/p/${token}`);
    await expect(page.getByRole("heading", { name: note.title, level: 1 })).toBeVisible({ timeout: 15_000 });
    const img = page.locator(`img[src*="/api/public/notes/${token}/uploads/"]`);
    await expectLoaded(img);

    await img.click();
    const imageDialog = page.getByRole("dialog", { name: "box" });
    await expect(imageDialog).toBeVisible();
    await expect(imageDialog.locator("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(imageDialog).toHaveCount(0);
    await expect(img).toBeFocused();

    // 唯讀時整張 mermaid 圖是一顆「Zoom in on diagram」按鈕（右上那顆放大鈕對輔助技術隱藏）
    await expect(page.locator("svg[aria-roledescription]")).toContainText("ZoomStart", { timeout: 20_000 });
    const diagram = page.getByRole("button", { name: "Zoom in on diagram", exact: true });
    await expect(diagram).toHaveCount(1);
    await diagram.focus();
    await page.keyboard.press("Enter");
    const diagramDialog = page.getByRole("dialog", { name: "Diagram", exact: true });
    await expect(diagramDialog).toBeVisible();
    await expect(diagramDialog.locator("svg[aria-roledescription]")).toContainText("ZoomStart");
    await page.keyboard.press("Escape");
    await expect(diagramDialog).toHaveCount(0);
    await expect(diagram).toBeFocused();
  } finally {
    await anonymous.close();
  }
});

test("59-4 手機可編輯：點圖選取後才出現放大鈕，放大畫面佔滿視窗、關閉鈕在視窗內", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "phone image", { viewport: PHONE, touch: true });
  try {
    const img = editorImage(page);
    const button = imageZoomButton(page);
    await img.scrollIntoViewIfNeeded();
    await expect(button).toHaveCount(0);
    await img.tap();
    await expect(button).toBeVisible({ timeout: 10_000 });

    await button.tap();
    const dialog = page.getByRole("dialog", { name: "box" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toBeVisible();
    const viewport = (await dialog.locator("[data-zoom-viewport]").boundingBox())!;
    expect(viewport.x).toBeCloseTo(0, 0);
    expect(viewport.y).toBeCloseTo(0, 0);
    expect(viewport.width).toBeCloseTo(PHONE.width, 0);
    expect(viewport.height).toBeCloseTo(PHONE.height, 0);

    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const box = (await close.boundingBox())!;
    expect(box.x, "關閉鈕左緣").toBeGreaterThanOrEqual(0);
    expect(box.y, "關閉鈕上緣").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "關閉鈕右緣").toBeLessThanOrEqual(PHONE.width);
    expect(box.y + box.height, "關閉鈕下緣").toBeLessThanOrEqual(PHONE.height);
    await close.tap();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-5 手機 mermaid：沒有 hover 也看得到右上控制組（常駐淡色）", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "phone mermaid", { viewport: PHONE, touch: true });
  try {
    const block = mermaidBlock(page);
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
    const group = block.locator(".block-control-group");
    await expect(group.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
    const opacity = Number(await group.evaluate((el) => getComputedStyle(el).opacity));
    expect(opacity, "淡色：看得到").toBeGreaterThan(0);
    expect(opacity, "淡色：不是全對比").toBeLessThan(1);
  } finally {
    await context.close();
  }
});
