import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickByPointer, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail } from "./helpers.js";

/**
 * 筆記頁頁首在各視窗寬的取捨（真瀏覽器量測；六位使用者同時在線＝頁首最擠）：
 * - 星號（Favorite）、分享、寬度鈕（可見時）、⋮ 的右緣都不超出頁首 content box，也不超出卡片內緣（最近一層 overflow:hidden 的祖先）。
 * - 視窗 < 640：在線者只有一顆「5 more, show everyone」，沒有頭像；≥ 640 沒有這顆。
 * - 「最後編輯」與連線文字在視窗 < 640 或頁首 content box < 36rem（576 px）時只給螢幕閱讀器（sr-only），連線點仍看得見。
 *   640–767 這段是文字開始顯示的範圍：以二分找出邊界，邊界兩側（約 641／642）各量一格。
 * - 星號在頁首 content box < 18rem（288 px）時收起；寬度鈕在 content box ≥ 43.5rem（696 px）時出現。
 * - 1440：寬度鈕按三下依序換 Standard → Wide → Full width → Standard，名稱帶下一種；⋮ → Width 是 Radix 子選單。
 * - 390（hasTouch）：⋮ → Width 就地展開三個選項，選了選單不關，Esc 先收合再關。
 * 每次量測印一行 `MEASURE …`；失敗訊息帶各鈕的 bounding box 與兩個邊界的右緣。
 */

const RUN = Date.now();
const PASSWORD = "e2e-header-policy-pw";
const OTHERS = ["bob", "carol", "dave", "erin", "frank"] as const;
const OTHERS_LABEL = "5 more, show everyone";
/** 頁首 content box 的門檻（px）：文字 36rem、星號 18rem、寬度鈕 43.5rem。 */
const TEXT_EDGE = 576;
const STAR_EDGE = 288;
const WIDTH_EDGE = 696;
const TOLERANCE = 0.5;
const CYCLE = {
  standard: "Width: Standard — click for Wide",
  wide: "Width: Wide — click for Full width",
  full: "Width: Full width — click for Standard",
} as const;

interface Account {
  email: string;
  displayName: string;
}

const accountOf = (name: string): Account => ({ email: randomEmail(), displayName: `${name} ${RUN}` });

const contexts: BrowserContext[] = [];
let desktop: Page;
let touch: Page;

const headerOf = (page: Page): Locator => page.locator("header").filter({ has: page.getByRole("button", { name: "More", exact: true }) }).first();
const presenceOf = (page: Page): Locator => page.getByRole("group", { name: "Also viewing this note" });
const buttonIn = (header: Locator, name: string): Locator => header.getByRole("button", { name, exact: true });
const widthButtonIn = (header: Locator): Locator => header.getByRole("button", { name: /^Width:/ });

async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title, { timeout: 15_000 });
}

async function openAs(browser: Browser, account: Account, options?: Parameters<Browser["newContext"]>[0]): Promise<Page> {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return page;
}

/** 換視窗寬後等頁首寬度連續 3 個 frame 不變再量（版面隨 resize 分幾個 frame 才落定，立刻量會量到中間值）。 */
async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await headerOf(page).evaluate(
    (h) =>
      new Promise<void>((resolve) => {
        let last = -1;
        let same = 0;
        let frames = 0;
        const tick = () => {
          const w = h.getBoundingClientRect().width;
          same = w === last ? same + 1 : 0;
          last = w;
          frames += 1;
          if (same >= 3 || frames > 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

interface Frame {
  contentRight: number;
  cardRight: number | null;
  contentW: number;
  scrollW: number;
  clientW: number;
  innerWidth: number;
}

/** 頁首 content box 的右緣與寬、卡片內緣（最近一層 overflow 為 hidden 的祖先）、橫向溢出。 */
async function frameOf(header: Locator): Promise<Frame> {
  return header.evaluate((h) => {
    const style = getComputedStyle(h);
    const r = h.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    let card: Element | null = h.parentElement;
    while (card && getComputedStyle(card).overflowX !== "hidden") card = card.parentElement;
    return {
      contentRight: r.right - px(style.paddingRight) - px(style.borderRightWidth),
      cardRight: card ? card.getBoundingClientRect().right : null,
      contentW: r.width - px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth),
      scrollW: h.scrollWidth,
      clientW: h.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
}

/** 只給螢幕閱讀器的元素：sr-only 把寬高縮到 1 px。 */
async function isSrOnly(el: Locator): Promise<boolean> {
  const box = await el.boundingBox();
  return box !== null && box.width <= 1 && box.height <= 1;
}

interface Policy {
  /** 星號預期可見（缺省依 content box ≥ 288）。 */
  star?: boolean;
}

/**
 * 量一個視窗寬下的頁首並斷言取捨。`phone`＝視窗 < 640。失敗時訊息帶各鈕的 box 與兩個邊界。
 */
async function checkHeader(page: Page, tag: string, vw: number, policy: Policy = {}): Promise<Frame> {
  const header = headerOf(page);
  await expect(buttonIn(header, "More")).toBeVisible();
  const frame = await frameOf(header);
  const phone = vw < 640;
  const star = buttonIn(header, "Favorite");
  const share = buttonIn(header, "Share");
  const more = buttonIn(header, "More");
  const width = widthButtonIn(header);

  const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const [name, button] of [["Favorite", star], ["Share", share], ["Width", width], ["More", more]] as const) {
    boxes[name] = (await button.isVisible()) ? await button.boundingBox() : null;
  }
  const detail = JSON.stringify({ tag, vw, contentW: frame.contentW, contentRight: frame.contentRight, cardRight: frame.cardRight, boxes });
  console.log(`MEASURE ${tag} vw=${vw} innerWidth=${frame.innerWidth} contentW=${frame.contentW.toFixed(2)} contentRight=${frame.contentRight.toFixed(2)} cardRight=${frame.cardRight?.toFixed(2)} ${JSON.stringify(boxes)}`);

  expect(frame.cardRight, `沒有找到 overflow 為 hidden 的卡片 ${detail}`).not.toBeNull();
  expect(frame.scrollW, `頁首有橫向溢出 ${detail}`).toBeLessThanOrEqual(frame.clientW);
  for (const [name, box] of Object.entries(boxes)) {
    if (box === null) continue;
    const right = box.x + box.width;
    expect(right, `${name} 超出頁首 content box ${detail}`).toBeLessThanOrEqual(frame.contentRight + TOLERANCE);
    expect(right, `${name} 被卡片裁掉 ${detail}`).toBeLessThanOrEqual(frame.cardRight! + TOLERANCE);
  }
  expect(boxes.Share, `分享鈕不見 ${detail}`).not.toBeNull();
  expect(boxes.More, `⋮ 不見 ${detail}`).not.toBeNull();
  expect(boxes.Favorite !== null, `星號可見性（content box ${frame.contentW}，門檻 ${STAR_EDGE}）${detail}`).toBe(policy.star ?? frame.contentW >= STAR_EDGE);
  expect(boxes.Width !== null, `寬度鈕可見性（content box ${frame.contentW}，門檻 ${WIDTH_EDGE}）${detail}`).toBe(frame.contentW >= WIDTH_EDGE);

  // 在線者
  const group = presenceOf(page);
  const compact = group.getByRole("button", { name: OTHERS_LABEL, exact: true });
  if (phone) {
    await expect(compact, `手機寬在線者只該有一顆「+N」 ${detail}`).toHaveCount(1);
    await expect(group.getByRole("button"), `手機寬不該有頭像 ${detail}`).toHaveCount(1);
  } else {
    await expect(compact, `≥ 640 不該出現精簡的「+N」 ${detail}`).toHaveCount(0);
    expect(await group.getByRole("button").count(), `≥ 640 要有頭像 ${detail}`).toBeGreaterThan(1);
  }

  // 文字：視窗 < 640 或 content box < 36rem 時只給螢幕閱讀器，連線點仍看得見
  const textHidden = phone || frame.contentW < TEXT_EDGE;
  const lastEdited = page.getByTestId("last-edited");
  const status = page.getByRole("status").filter({ hasText: /^Connected/ });
  const statusText = status.locator("span").last();
  expect(await isSrOnly(lastEdited), `「最後編輯」sr-only 與否（content box ${frame.contentW}，門檻 ${TEXT_EDGE}）${detail}`).toBe(textHidden);
  expect(await isSrOnly(statusText), `連線文字 sr-only 與否（content box ${frame.contentW}，門檻 ${TEXT_EDGE}）${detail}`).toBe(textHidden);
  const dot = (await status.locator("span[aria-hidden]").first().boundingBox())!;
  expect(dot.width, `連線點要看得見 ${detail}`).toBeGreaterThan(0);
  return frame;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = accountOf("alice");
  const others = OTHERS.map((name) => accountOf(name));
  const adminContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    for (const account of [alice, ...others]) await createUserViaInvite(admin, { ...account, password: PASSWORD });
  } finally {
    await adminContext.close();
  }

  desktop = await openAs(browser, alice, { viewport: { width: 1440, height: 900 } });
  const title = `E2E header policy ${RUN}`;
  await createNote(desktop, title);
  const noteUrl = desktop.url();
  const noteId = await noteIdFromUrl(desktop);
  const editor = editorLocator(desktop);
  await editor.click();
  await editor.pressSequentially("Header policy paragraph.");

  for (const account of others) {
    const shared = await desktop.request.put(`/api/notes/${noteId}/shares`, { data: { email: account.email, role: "editor" } });
    expect(shared.status(), await shared.text()).toBe(200);
    const page = await openAs(browser, account, { viewport: { width: 1280, height: 800 } });
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
    await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  }

  // 「最後編輯」要出現（頁首最擠）：重載到看見為止
  await expect(async () => {
    await desktop.reload();
    await waitForNoteTitle(desktop, title);
    await expect(desktop.getByTestId("last-edited")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(presenceOf(desktop).getByRole("button")).toHaveCount(5, { timeout: 20_000 }); // 5 顆頭像（剛好塞滿寬形容量）

  touch = await openAs(browser, alice, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await touch.goto(noteUrl);
  await waitForNoteTitle(touch, title);
  await expect(presenceOf(touch).getByRole("button", { name: OTHERS_LABEL, exact: true })).toHaveCount(1, { timeout: 20_000 });
});

test.afterAll(async () => {
  for (const context of contexts) await context.close();
});

test("C1 各視窗寬：按鈕不超出頁首與卡片、手機只剩一顆「+N」、文字與星號依門檻收起", async () => {
  test.setTimeout(120_000);
  // 星號沒有寬度規則以外的例外；320 時 content box 落在 18rem 以下
  for (const [vw, vh] of [[320, 640], [360, 800], [768, 900], [1024, 900], [1440, 900]] as const) {
    await setViewport(desktop, vw, vh);
    await checkHeader(desktop, "C1", vw);
  }
  await setViewport(desktop, 320, 640);
  await expect(buttonIn(headerOf(desktop), "Favorite")).toBeHidden();
  // 390 觸控裝置（isMobile）
  await checkHeader(touch, "C1-touch", 390);
});

test("C2 1024 開著版本面板：頁首變窄仍不超出", async () => {
  test.setTimeout(60_000);
  await setViewport(desktop, 1024, 900);
  await desktop.getByTestId("versions-bubble").click();
  await expect(desktop.getByTestId("versions-panel")).toBeVisible();
  await checkHeader(desktop, "C2-versions", 1024);
  await desktop.getByRole("button", { name: "Close version history", exact: true }).click();
  await expect(desktop.getByTestId("versions-panel")).toBeHidden();
  await setViewport(desktop, 1440, 900);
});

test("C3 640–767：文字開始顯示的邊界（約 641／642）兩側各量一格", async () => {
  test.setTimeout(120_000);
  const lastEdited = desktop.getByTestId("last-edited");
  // 先量固定幾格
  for (const vw of [640, 641, 642, 700, 767]) {
    await setViewport(desktop, vw, 900);
    await checkHeader(desktop, "C3", vw);
  }
  await setViewport(desktop, 640, 900);
  expect(await isSrOnly(lastEdited), "640 時 content box 應在 36rem 以下").toBe(true);
  await setViewport(desktop, 767, 900);
  expect(await isSrOnly(lastEdited), "767 時 content box 應在 36rem 以上").toBe(false);
  // 二分找最小的文字可見視窗寬，兩側各量一格
  let lo = 640;
  let hi = 767;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    await setViewport(desktop, mid, 900);
    if (await isSrOnly(lastEdited)) lo = mid;
    else hi = mid;
  }
  await setViewport(desktop, hi, 900);
  const edge = await checkHeader(desktop, "C3-edge", hi);
  await setViewport(desktop, hi - 1, 900);
  const below = await checkHeader(desktop, "C3-edge-1", hi - 1);
  console.log(`MEASURE C3 edgeVw=${hi} contentW@edge=${edge.contentW} contentW@edge-1=${below.contentW}`);
  expect(edge.contentW).toBeGreaterThanOrEqual(TEXT_EDGE);
  expect(below.contentW).toBeLessThan(TEXT_EDGE);
  expect(hi, "邊界應落在 641–642 附近").toBeLessThanOrEqual(643);
  expect(hi).toBeGreaterThanOrEqual(641);
});

test("C4 1440 寬度鈕：按三下循環；⋮ → Width 子選單切回 Standard", async () => {
  test.setTimeout(90_000);
  await setViewport(desktop, 1440, 900);
  const header = headerOf(desktop);
  const toggle = widthButtonIn(header);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.wide);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.full);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.wide);

  await buttonIn(header, "More").click();
  await desktop.getByRole("menuitem", { name: "Width", exact: true }).click();
  await clickByPointer(desktop, desktop.getByRole("menuitemradio", { name: "Standard", exact: true }));
  await expect(desktop.getByRole("menu")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
});

test("C5 390 觸控：⋮ → Width 就地展開，選了選單不關，Esc 先收合再關", async () => {
  test.setTimeout(90_000);
  const header = headerOf(touch);
  await expect(widthButtonIn(header)).toHaveCount(0);
  await buttonIn(header, "More").click();
  const menu = touch.getByRole("menu");
  await expect(menu).toHaveCount(1);
  const trigger = menu.getByRole("menuitem", { name: "Width", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu, "窄形不開第二層選單").toHaveCount(1);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitemradio", { name: "Standard", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Wide", exact: true }).click();
  await expect(menu, "選了選單不關").toHaveCount(1);
  await expect(menu.getByRole("menuitemradio", { name: "Wide", exact: true })).toHaveAttribute("aria-checked", "true");
  await touch.keyboard.press("Escape");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  await expect(menu).toHaveCount(1);
  await touch.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // 再開一次：選擇有記住；還原成 Standard，免得影響後面
  await buttonIn(header, "More").click();
  await menu.getByRole("menuitem", { name: "Width", exact: true }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Wide", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Standard", exact: true }).click();
  await touch.keyboard.press("Escape");
  await touch.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
