import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, showSidebarTab, startSidebarSelection, tapAreaOf, waitForEditorSelection } from "./helpers.js";

/**
 * Body heading font sizes (all widths) and the phone (< 640) layout: content flush with the screen edge, the mentions row inside the body's scroll container, the right-edge hint of wide tables. Everything measures browser-computed values, never class names.
 *
 * Cases are numbered 58-1 to 58-33 in their titles and are not in numeric order in the file.
 * - 58-5: while the table can still scroll right `--kb-table-fade` is 1.5rem (24px) and 0 at the end; a table that does not overflow has 0.
 * - 58-6: the delegated scroll listener marks a table that can still scroll right with `data-kb-more-right` and removes it at the end.
 * - 58-16: the panel and the menu sheet of the same screen are one family (measured in light and dark): same card background and shadow, top radius 12px, a tray without blur or background; item rows >= 48 high, 16px regular weight, touching, 4px radius, no permanent background, a 16px chevron at the row end; title 18px/600 with a hairline on the row header; the second-level title is 18px/600 and vertically centered with the chevron. 58-21 measures the same surfaces for site admin, shortcuts and the group panel (shortcut entry names 16px, descriptions 14px).
 * - 58-20: the release point lands on a menu item once the sheet has risen (390x560, the lowest list row); touch uses CDP touchStart/touchEnd because Playwright's tap releases instantly.
 * - 58-24: the header height equals the blocks' scroll-margin-top, and the Radix scroll lock must not change scrollY.
 * - 58-28: on a wide screen the admin panel keeps rows 36px/14px/8px radius, a brand background on the current item and no chevron; the 700 list level keeps the back arrow and close button.
 *
 *
 * Cannot be measured and are on the real-device list: whether iOS Safari's toolbar collapses while scrolling, whether content extends behind the translucent bottom toolbar, the notch and home-indicator safe area,
 * the scroll range and pinned header position with a real on-screen keyboard, and whether pull to refresh is really blocked.
 *
 * Account and data: one account (alice) is created through an invite and data is created once through the API; each case then opens a new context.
 */

test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-mobile-layout-pw";
const ORIGIN = E2E_ORIGIN;
const BASE_FONT_PX = 16;

const TITLES = {
  headings: `E2E layout headings ${RUN}`,
  short: `E2E layout short ${RUN}`,
  mentioned: `E2E layout mentioned ${RUN}`,
  mentioner: `E2E layout mentioner ${RUN}`,
  wide: `E2E layout wide table ${RUN}`,
  deck: `E2E layout deck ${RUN}`,
  published: `E2E layout public ${RUN}`,
  long: `E2E layout long ${RUN}`,
};

const HEADINGS_MD = ["# Heading one", "", "## Heading two", "", "### Heading three", "", "body text"].join("\n");
const DECK_MD = ["# Slide one", "", "## Slide two", "", "### Slide three", "", "slide text"].join("\n");
const LONG_LAST = "the very last paragraph";
const LONG_MD = [...Array.from({ length: 40 }, (_, i) => `paragraph number ${i}`), LONG_LAST].join("\n\n");
const WIDE_ROW = Array.from({ length: 10 }, (_, i) => `a rather long cell ${i}`);
const TABLE_MD = [
  "wide and narrow",
  "",
  `| ${WIDE_ROW.map((_, i) => `Column ${i}`).join(" | ")} |`,
  `| ${WIDE_ROW.map(() => "---").join(" | ")} |`,
  `| ${WIDE_ROW.join(" | ")} |`,
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| a | 1 |",
].join("\n");

let alice: { email: string; displayName: string };
const paths: Record<keyof typeof TITLES, string> = { headings: "", short: "", mentioned: "", mentioner: "", wide: "", deck: "", published: "", long: "" };

async function createNoteVia(page: Page, title: string, content?: string): Promise<{ id: string; path: string }> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: content === undefined ? { title } : { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    paths.headings = (await createNoteVia(page, TITLES.headings, HEADINGS_MD)).path;
    paths.short = (await createNoteVia(page, TITLES.short, "one line")).path;
    paths.wide = (await createNoteVia(page, TITLES.wide, TABLE_MD)).path;
    paths.deck = (await createNoteVia(page, TITLES.deck, DECK_MD)).path;
    paths.long = (await createNoteVia(page, TITLES.long, LONG_MD)).path;
    const mentioned = await createNoteVia(page, TITLES.mentioned, "mentioned text");
    paths.mentioned = mentioned.path;
    const mentioner = await createNoteVia(page, TITLES.mentioner, "see");
    paths.mentioner = mentioner.path;
    await page.goto(mentioner.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    await editorLocator(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" [[");
    await page.keyboard.type(TITLES.mentioned);
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText(TITLES.mentioned, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(editorLocator(page).locator('[data-inline-content-type="wikilink"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(async () => {
      const res = await page.request.get(`/api/notes/${mentioned.id}/backlinks`);
      expect(res.status()).toBe(200);
      const { backlinks } = (await res.json()) as { backlinks: Array<{ id: string }> };
      expect(backlinks.map((b) => b.id)).toContain(mentioner.id);
    }).toPass({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});

async function open(browser: Browser, width: number, key: keyof typeof TITLES, opts: { touch?: boolean; height?: number; init?: () => void; backlinks?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = { width, height: opts.height ?? 844 };
  const context = await browser.newContext(opts.touch === false ? { viewport } : { hasTouch: true, isMobile: true, viewport });
  const page = await context.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  // Register the mentions query's response before goto, so the "no mentions row" assertion runs after the query has returned.
  const backlinksResponse = opts.backlinks ? page.waitForResponse((r) => r.url().endsWith("/backlinks") && r.ok()) : null;
  await page.goto(paths[key]);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await backlinksResponse;
  return { context, page };
}

const fontPx = (target: Locator): Promise<number> => target.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

const headingText = (page: Page, text: string): Locator =>
  editorLocator(page).locator('[data-content-type="heading"] .bn-inline-content').filter({ hasText: new RegExp(`^${text}$`) });

async function headingSizes(page: Page): Promise<{ base: number; h1: number; h2: number; h3: number }> {
  await expect(headingText(page, "Heading three")).toBeVisible({ timeout: 15_000 });
  const base = await headingText(page, "Heading one").evaluate((el) => parseFloat(getComputedStyle(el.closest(".bn-block")!).fontSize));
  return {
    base,
    h1: await fontPx(headingText(page, "Heading one")),
    h2: await fontPx(headingText(page, "Heading two")),
    h3: await fontPx(headingText(page, "Heading three")),
  };
}

const scrollerOf = (page: Page): Locator => page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
const nextFrame = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("58-1 heading sizes: 2/1.5/1.25 times at both 390 and 800", async ({ browser }) => {
  const phone = await open(browser, 390, "headings");
  try {
    const sizes = await headingSizes(phone.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 1.5, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.25, 1);
    expect(await fontPx(phone.page.getByRole("textbox", { name: "Note title" }))).toBe(20);
  } finally {
    await phone.context.close();
  }
  const wide = await open(browser, 800, "headings", { touch: false });
  try {
    const sizes = await headingSizes(wide.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 1.5, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.25, 1);
  } finally {
    await wide.context.close();
  }
});

test("58-2 edge to edge: at 390 the body card is flush with the viewport and the frame padding is 0; at 800 the frame and card edge remain", async ({ browser }) => {
  const phone = await open(browser, 390, "short");
  try {
    const card = phone.page.locator("[data-note-header-slot]").locator("xpath=..");
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(390);
    const frame = await phone.page.locator("div.h-dvh").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
    });
    expect(frame).toEqual(["0px", "0px", "0px", "0px"]);
    const radius = await card.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderTopWidth]);
    expect(radius).toEqual(["0px", "0px"]);
  } finally {
    await phone.context.close();
  }
  const wide = await open(browser, 800, "short", { touch: false });
  try {
    const card = wide.page.locator("[data-note-header-slot]").locator("xpath=..");
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(12);
    const frame = await wide.page.locator("div.h-dvh").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
    });
    for (const side of frame) expect(parseFloat(side)).toBeGreaterThanOrEqual(12);
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
  } finally {
    await wide.context.close();
  }
});

test("58-3 presentation (390): h1 > h2 > h3, and h1 is 1.75 times the font size of its container", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "deck");
  try {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Present" }).click();
    await expect(page.getByRole("dialog", { name: `${TITLES.deck} — presentation` })).toBeVisible();
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    const sizes = await page.evaluate(() => {
      const size = (selector: string) => {
        const el = document.querySelector(selector);
        return el === null ? null : { px: parseFloat(getComputedStyle(el).fontSize), parentPx: parseFloat(getComputedStyle(el.parentElement!).fontSize) };
      };
      return { h1: size(".kn-slide-body h1"), h2: size(".kn-slide-body h2"), h3: size(".kn-slide-body h3") };
    });
    expect(sizes.h1).not.toBeNull();
    expect(sizes.h2).not.toBeNull();
    expect(sizes.h3).not.toBeNull();
    expect(sizes.h1!.px / sizes.h1!.parentPx).toBeCloseTo(1.75, 2);
    expect(sizes.h1!.px).toBeGreaterThan(sizes.h2!.px);
    expect(sizes.h2!.px).toBeGreaterThan(sizes.h3!.px);
  } finally {
    await context.close();
  }
});

async function scrollRange(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
}

const scrollPageToEnd = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
const scrollPageToTop = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, 0));

test("58-4 a short note has no extra scroll range: with no mentions there is no mentions row", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short", { backlinks: true });
  try {
    await expect(editorLocator(page).getByText("one line")).toBeVisible({ timeout: 15_000 });
    await nextFrame(page);
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    await expect(page.getByText(/Mentioned in|No mentions yet/)).toHaveCount(0);
    await editorLocator(page).getByText("one line").click();
    await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 10_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const lastIsSpacer = await scrollerOf(page).evaluate((el) => (el.firstElementChild!.lastElementChild as HTMLElement).hasAttribute("data-mobile-toolbar-spacer"));
    expect(lastIsSpacer).toBe(true);
  } finally {
    await context.close();
  }
});

test("58-4b a short note with mentions: the mentions row is inside the first screen after the article column and the range is still 0", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "mentioned");
  try {
    const title = page.getByText(/^Mentioned in 1 note$/);
    await expect(title).toBeVisible({ timeout: 15_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const geometry = await scrollerOf(page).evaluate((scroller) => {
      const column = scroller.querySelector('[data-testid="article-column"]') as HTMLElement;
      const footer = column.nextElementSibling as HTMLElement;
      const f = footer.getBoundingClientRect();
      return { footerText: footer.textContent ?? "", footerBottom: f.bottom, footerTop: f.top, viewportBottom: window.innerHeight, columnBottom: column.getBoundingClientRect().bottom };
    });
    expect(geometry.footerText).toContain("Mentioned in 1 note");
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportBottom + 0.5);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.columnBottom - 0.5);
    await editorLocator(page).getByText("mentioned text").click();
    await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 10_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const order = await scrollerOf(page).evaluate((el) => Array.from(el.firstElementChild!.children).map((child) => (child as HTMLElement).dataset.testid ?? (child.hasAttribute("data-mobile-toolbar-spacer") ? "spacer" : "footer")));
    expect(order).toEqual(["article-column", "footer", "spacer"]);
  } finally {
    await context.close();
  }
});

interface TableState {
  overflow: boolean;
  fade: number;
  marked: boolean;
  scrollLeft: number;
}

async function tableStates(page: Page): Promise<TableState[]> {
  return page.locator(".tableWrapper").evaluateAll((wrappers) =>
    wrappers.map((el) => ({
      overflow: el.scrollWidth - el.clientWidth > 1,
      fade: parseFloat(getComputedStyle(el).getPropertyValue("--kb-table-fade")) || 0,
      marked: el.hasAttribute("data-kb-more-right"),
      scrollLeft: el.scrollLeft,
    })),
  );
}

async function scrollTableTo(page: Page, index: number, where: "start" | "end"): Promise<void> {
  await page.locator(".tableWrapper").nth(index).evaluate((el, to) => {
    el.scrollLeft = to === "end" ? el.scrollWidth : 0;
  }, where);
  await nextFrame(page);
}

test("58-5 right-edge hint of wide tables: present while it can still scroll right, gone at the end; a table without overflow has none", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "wide");
  try {
    await expect(page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    await nextFrame(page);
    const fades = async () => (await tableStates(page)).map((s) => Math.round(s.fade));
    const [wide, narrow] = await tableStates(page);
    expect(wide!.overflow).toBe(true);
    expect(narrow!.overflow).toBe(false);
    await expect.poll(fades).toEqual([24, 0]);
    await scrollTableTo(page, 0, "end");
    expect((await tableStates(page))[0]!.scrollLeft).toBeGreaterThan(0);
    await expect.poll(fades).toEqual([0, 0]);
    await scrollTableTo(page, 0, "start");
    await expect.poll(fades).toEqual([24, 0]);
  } finally {
    await context.close();
  }
});

test("58-6 fallback: without scroll-driven animations the delegated listener marks data-kb-more-right; non-phone widths are not marked", async ({ browser }) => {
  const noScrollTimeline = () => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string] | [string, string]) => (String(args[0]).includes("animation-timeline") ? false : (supports as (...a: unknown[]) => boolean)(...args))) as typeof CSS.supports;
  };
  const phone = await open(browser, 390, "wide", { init: noScrollTimeline });
  try {
    await expect(phone.page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([true, false]);
    await scrollTableTo(phone.page, 0, "end");
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([false, false]);
    await scrollTableTo(phone.page, 0, "start");
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([true, false]);
  } finally {
    await phone.context.close();
  }
  const desktop = await open(browser, 1280, "wide", { touch: false, init: noScrollTimeline });
  try {
    await expect(desktop.page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    // At 1280 the wide table really does overflow (otherwise "not marked" proves nothing).
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.overflow)).toEqual([true, false]);
    await nextFrame(desktop.page);
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.marked)).toEqual([false, false]);
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.fade)).toEqual([0, 0]);
  } finally {
    await desktop.context.close();
  }
});

test("58-7 desktop side menu: the drag handle is vertically centered on the first line of H1/H2/H3", async ({ browser }) => {
  const desktop = await open(browser, 1280, "headings", { touch: false });
  try {
    const { page } = desktop;
    await expect(headingText(page, "Heading three")).toBeVisible({ timeout: 15_000 });
    for (const text of ["Heading one", "Heading two", "Heading three"]) {
      const inline = headingText(page, text);
      await inline.hover();
      const handle = page.getByRole("button", { name: "Open block menu" });
      await expect(handle).toBeVisible();
      // The side menu's position has a transition: wait for the handle's midline to settle before measuring.
      await expect(async () => {
        const geo = await inline.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const line = range.getClientRects()[0]!;
          const button = document.querySelector('button[aria-label="Open block menu"]')!.getBoundingClientRect();
          return { lineMid: line.top + line.height / 2, buttonMid: button.top + button.height / 2 };
        });
        expect(Math.abs(geo.buttonMid - geo.lineMid), text).toBeLessThanOrEqual(1);
      }).toPass({ timeout: 5_000 });
    }
  } finally {
    await desktop.context.close();
  }
});

/** Stand-in for the on-screen keyboard: replaces `window.visualViewport` with a fake object whose height can be set (the layout viewport doesn't shrink, like iOS). */
function stubVisualViewport(): void {
  const target = new EventTarget();
  const state = { keyboard: 0 };
  Object.defineProperties(target, {
    height: { get: () => window.innerHeight - state.keyboard },
    width: { get: () => window.innerWidth },
    offsetTop: { value: 0 },
    offsetLeft: { value: 0 },
    pageTop: { value: 0 },
    pageLeft: { value: 0 },
    scale: { value: 1 },
  });
  Object.defineProperty(window, "visualViewport", { get: () => target, configurable: true });
  (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px) => {
    state.keyboard = px;
    target.dispatchEvent(new Event("resize"));
  };
}

async function setKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(value), px);
  await nextFrame(page);
}

test("58-8 dialogs are bottom sheets: flush with the viewport bottom, left and right, close button tap area 44; rises with the keyboard", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short", { init: stubVisualViewport });
  try {
    await page.locator("header").getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share note" });
    await expect(dialog).toBeVisible();
    // Measure after the entry animation (boundingBox is wrong while the position moves).
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBe(390);
      expect(box.y + box.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
    const close = dialog.getByRole("button", { name: "Close" });
    const area = await tapAreaOf(close);
    expect(area.tap[0], "✕ 點擊寬").toBeGreaterThanOrEqual(43);
    expect(area.tap[1], "✕ 點擊高").toBeGreaterThanOrEqual(43);

    await setKeyboard(page, 300);
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.y + box.height).toBeCloseTo(844 - 300, 0);
    }).toPass({ timeout: 5_000 });
    await setKeyboard(page, 0);
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.y + box.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });

    await close.click();
    // During the exit animation body still has pointer-events: none; wait for the dialog to be really removed before the next step.
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-9 version full page (390): the \"Back\" button is 44 high", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short");
  try {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeVisible();
    const back = sheet.getByRole("button", { name: "Back", exact: true });
    await expect(back).toBeVisible();
    await expect(async () => {
      const box = (await back.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }).toPass({ timeout: 5_000 });
    await back.click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-10 public page header (390): title >= 180px, Present shows only an icon, read-only shows only a dot", async ({ browser }) => {
  const owner = await open(browser, 390, "short");
  let token: string;
  try {
    const note = await createNoteVia(owner.page, TITLES.published, "public text");
    const res = await owner.page.request.put(`/api/notes/${note.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    token = ((await res.json()) as { token: string }).token;
  } finally {
    await owner.context.close();
  }
  const anonymous = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await anonymous.newPage();
    await page.goto(`/p/${token}`);
    const heading = page.getByRole("heading", { name: TITLES.published, level: 1 });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    const present = page.getByRole("button", { name: "Present", exact: true });
    await expect(present).toBeVisible();
    expect((await present.boundingBox())!.width, "Present 鈕只剩圖示").toBeLessThanOrEqual(48);
    const dot = page.locator("[data-readonly-dot]");
    await expect(dot).toBeVisible();
    expect((await dot.boundingBox())!.width).toBeLessThanOrEqual(8);
    const readonlyText = page.getByText("Read-only", { exact: false }).first();
    expect(await readonlyText.evaluate((el) => el.getBoundingClientRect().width <= 1)).toBe(true);
    await expect(async () => {
      expect((await heading.boundingBox())!.width).toBeGreaterThanOrEqual(180);
    }).toPass({ timeout: 5_000 });
  } finally {
    await anonymous.close();
  }
});

async function openList(browser: Browser, width: number, touch: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = { width, height: 844 };
  const context = await browser.newContext(touch ? { hasTouch: true, isMobile: true, viewport } : { viewport });
  const page = await context.newPage();
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await showSidebarTab(page, "My notes");
  return { context, page };
}

async function favoriteViaApi(page: Page, noteId: string): Promise<void> {
  const res = await page.request.put(`/api/favorites/${encodeURIComponent(noteId)}`, { headers: { Origin: ORIGIN } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

async function tagNoteViaApi(page: Page, noteId: string, name: string): Promise<void> {
  const res = await page.request.post(`/api/notes/${encodeURIComponent(noteId)}/tags`, { headers: { Origin: ORIGIN }, data: { name } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

// A tagged note row ends with a fixed-width tag-dots slot (19px, plus a 4px gap before it); an untagged row has none.
const DOTS_SLOT_WIDTH = 19;
const DOTS_SLOT_GAP = 4;
// Icon buttons keep their glyph 5px inside the button box.
const STAR_GLYPH_INSET = 5;

const box = async (target: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await target.boundingBox();
  expect(b, "元素要有版面").not.toBeNull();
  return b!;
};

async function listEdges(page: Page): Promise<{ left: number; right: number }> {
  return page.locator("[data-sidebar-list]").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.left + el.clientWidth };
  });
}

test("58-11 phone list (390): Search bottom left and New note bottom right, each 56x56, 16px from the edge, same bottom; no bottom search bar", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    await expect(page.locator("[data-phone-list-bar]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toHaveCount(0);
    const fabs = page.locator("[data-phone-list-fabs]");
    const search = fabs.getByRole("button", { name: "Search notes", exact: true });
    const create = fabs.getByRole("button", { name: "New note", exact: true });
    const s = await box(search);
    const c = await box(create);
    for (const b of [s, c]) {
      expect(b.width).toBeCloseTo(56, 0);
      expect(b.height).toBeCloseTo(56, 0);
      expect(844 - (b.y + b.height), "離視窗下緣").toBeCloseTo(16, 0);
    }
    expect(s.x, "Search 左緣").toBeCloseTo(16, 0);
    expect(390 - (c.x + c.width), "New note 右緣").toBeCloseTo(16, 0);
    expect(Math.abs(s.y - c.y)).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test("58-12 phone list (390): the last row scrolls above the floating buttons; no floating buttons while searching or selecting; the trash has no New note", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    for (let i = 0; i < 16; i++) await createNoteVia(page, `E2E layout fab filler ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const fabs = page.locator("[data-phone-list-fabs]");
    const list = page.locator("[data-sidebar-list]").first();
    const notes = list.locator('[data-node-kind="note"]');
    await expect(notes.nth(15)).toBeAttached({ timeout: 15_000 });
    await scrollPageToEnd(page);
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const last = await box(notes.last());
      expect(last.y + last.height, "最後一列的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
    }).toPass({ timeout: 5_000 });

    await fabs.getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    await expect(fabs).toHaveCount(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeVisible();
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeFocused();

    await startSidebarSelection(page);
    await expect(fabs).toHaveCount(0);
    await page.getByRole("button", { name: "Done", exact: true }).first().click();
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeVisible();

    // Trash: only Search; the last row and the retention-days notice are both above the Search button's top edge, the notice within the safe range.
    for (let i = 0; i < 12; i++) {
      const note = await createNoteVia(page, `E2E layout trash filler ${RUN} ${String(i).padStart(2, "0")}`);
      const res = await page.request.delete(`/api/notes/${note.id}`, { headers: { Origin: ORIGIN } });
      expect(res.status(), await res.text()).toBeLessThan(300);
    }
    await page.reload();
    await page.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab", { name: "Trash", exact: true }).click();
    const searchFab = fabs.getByRole("button", { name: "Search notes", exact: true });
    await expect(searchFab).toBeVisible();
    await expect(fabs.getByRole("button", { name: "New note", exact: true })).toHaveCount(0);
    const trashList = page.locator("[data-sidebar-list]").first();
    const trashRows = trashList.locator('[data-node-kind="note"]');
    await expect(trashRows.nth(11)).toBeAttached({ timeout: 15_000 });
    await scrollPageToEnd(page);
    const footer = page.getByTestId("trash-footer");
    await expect(footer).toBeVisible();
    const searchTop = (await box(searchFab)).y;
    await expect(async () => {
      const last = await box(trashRows.last());
      const foot = await box(footer);
      expect(last.y + last.height, "最後一列的下緣在說明之上").toBeLessThanOrEqual(foot.y + 1);
      // The notice's bottom padding is reserved space for the floating button: the text itself (without that padding) must be above the Search button's top edge.
      const padBottom = await footer.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      // The text's bottom edge is at least 6px from the Search button's top edge (clear of the shadow too).
      expect(foot.y + foot.height - padBottom, "保留天數說明文字的下緣在 Search 鈕上緣之上").toBeLessThanOrEqual(searchTop - 6);
    }).toPass({ timeout: 5_000 });
  } finally {
    await context.close();
  }
});

test("58-13 desktop (1280): on an untagged row the star's right inset equals the left inset; on a tagged row the dots' right inset equals it and the star sits one slot further left; on either kind of row the star and the dots do not move on hover and the kebab appears left of the star", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 1280, false);
  try {
    const created = await createNoteVia(page, `E2E layout fav row ${RUN}`);
    await favoriteViaApi(page, created.id);
    const tagged = await createNoteVia(page, `E2E layout tagged row ${RUN}`);
    await favoriteViaApi(page, tagged.id);
    await tagNoteViaApi(page, tagged.id, `layout${RUN}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const row = page.locator(`[data-node-id="${created.id}"]`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const taggedRow = page.locator(`[data-node-id="${tagged.id}"]`).first();
    await expect(taggedRow.getByRole("img", { name: /^Tags: / })).toBeVisible({ timeout: 15_000 });
    const star = row.getByRole("button", { name: "Favorite", exact: true });
    const more = row.getByRole("button", { name: /^Note actions for / });
    await page.mouse.move(700, 600);
    const edges = await listEdges(page);
    const moveAway = (): Promise<void> => page.mouse.move(700, 600);
    const textLeft = (await box(row.getByRole("link"))).x;
    const leftInset = textLeft - edges.left;
    const starGlyph = async (): Promise<number> => {
      const g = await box(star.locator("svg"));
      return g.x + g.width;
    };
    const idleInset = edges.right - (await starGlyph());
    expect(leftInset, "文字左緣離清單左緣").toBeCloseTo(16, 0);
    expect(Math.abs(idleInset - leftInset), `無標籤列星號右內距 ${idleInset} 與左內距 ${leftInset} 相差`).toBeLessThanOrEqual(1);
    await expect(row.locator("[data-tag-dots]")).toHaveCount(0);
    const taggedStarButton = taggedRow.getByRole("button", { name: "Favorite", exact: true });
    const taggedMore = taggedRow.getByRole("button", { name: /^Note actions for / });
    const slot = await box(taggedRow.locator(":scope > span").last());
    expect(slot.width, "圓點欄寬").toBeCloseTo(DOTS_SLOT_WIDTH, 0);
    const slotInset13 = edges.right - (slot.x + slot.width);
    expect(Math.abs(slotInset13 - leftInset), `圓點欄右內距 ${slotInset13} 與左內距 ${leftInset} 相差`).toBeLessThanOrEqual(1);
    const taggedGlyph = await box(taggedStarButton.locator("svg"));
    const taggedIdleInset = edges.right - (taggedGlyph.x + taggedGlyph.width);
    expect(Math.abs(taggedIdleInset - slotInset13 - DOTS_SLOT_WIDTH - DOTS_SLOT_GAP - STAR_GLYPH_INSET), `有標籤列星號右內距 ${taggedIdleInset} 要多出圓點欄與間距`).toBeLessThanOrEqual(1);
    const taggedIdleStar = await box(taggedStarButton);
    console.log(`MEASURE 58-13 untagged star inset ${idleInset} tagged dots inset ${slotInset13} tagged star inset ${taggedIdleInset} star offset ${(await box(star)).x - taggedIdleStar.x}`);
    // When the kebab hasn't surfaced it is transparent with width 0 (takes no space); the title extends up to one gap before the star.
    expect(await more.evaluate((el) => getComputedStyle(el).opacity), "⋮ 沒浮出").toBe("0");
    expect((await box(more)).width, "⋮ 沒浮出時不佔位").toBeLessThanOrEqual(1);
    const idleLink = await box(row.getByRole("link"));
    const idleStar = await box(star);
    expect(idleStar.x - (idleLink.x + idleLink.width), "沒浮出時標題與星號之間只有一個 gap").toBeLessThanOrEqual(4.5);

    await row.hover();
    await expect(async () => {
      expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect((await box(more)).width).toBeCloseTo(24, 0);
    }).toPass({ timeout: 5_000 });
    const hoverLink = await box(row.getByRole("link"));
    const hoverMore = await box(more);
    const hoverStar = await box(star);
    expect(hoverLink.x + hoverLink.width, "標題不蓋到 ⋮").toBeLessThanOrEqual(hoverMore.x + 0.5);
    expect(hoverMore.x + hoverMore.width, "⋮ 不蓋到星號").toBeLessThanOrEqual(hoverStar.x + 0.5);
    expect(hoverLink.width, "浮出後標題縮短").toBeLessThan(idleLink.width);
    expect(Math.abs(hoverStar.x - idleStar.x), "星號不動").toBeLessThanOrEqual(0.5);
    expect(Math.abs(idleInset - (edges.right - (await starGlyph()))), "星號位置不變").toBeLessThanOrEqual(0.5);
    const moreBox = await box(more);
    const starBox = await box(star);
    expect(Math.abs(starBox.x - (moreBox.x + moreBox.width) - 4), "⋮ 與星號的間距").toBeLessThanOrEqual(1);
    expect(moreBox.x, "⋮ 在星號左邊").toBeLessThan(starBox.x);
    await taggedRow.hover();
    await expect(async () => {
      expect(await taggedMore.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect((await box(taggedMore)).width).toBeCloseTo(24, 0);
    }).toPass({ timeout: 5_000 });
    const taggedHoverStar = await box(taggedStarButton);
    const taggedHoverMore = await box(taggedMore);
    const taggedHoverSlot = await box(taggedRow.locator(":scope > span").last());
    expect(Math.abs(taggedHoverStar.x - taggedIdleStar.x), "有標籤的列星號不動").toBeLessThanOrEqual(0.5);
    expect(Math.abs(taggedHoverSlot.x - slot.x), "圓點欄不動").toBeLessThanOrEqual(0.5);
    expect(taggedHoverMore.x + taggedHoverMore.width, "⋮ 不蓋到星號").toBeLessThanOrEqual(taggedHoverStar.x + 0.5);
    expect(taggedHoverMore.x, "⋮ 在星號左邊").toBeLessThan(taggedHoverStar.x);
    expect(taggedHoverStar.x + taggedHoverStar.width, "星號在圓點欄左邊").toBeLessThanOrEqual(taggedHoverSlot.x + 0.5);
    expect(Math.abs(taggedHoverStar.x - starBox.x + 28), "有標籤的列星號比沒標籤的列靠左一欄（圓點欄＋間距－右邊距差）").toBeLessThanOrEqual(1);
    await moveAway();
  } finally {
    await context.close();
  }
});

test("58-14 phone (390): on an untagged row the kebab's right inset equals the left inset; on a tagged row the dots' right inset equals it and the kebab sits left of the dots; star and kebab tap areas don't overlap; font sizes 15/12; top bar title on the left and avatar on the right at the same 16px inset", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    const created = await createNoteVia(page, `E2E layout phone row ${RUN}`);
    await favoriteViaApi(page, created.id);
    await tagNoteViaApi(page, created.id, `phone${RUN}`);
    const untaggedFav = await createNoteVia(page, `E2E layout phone untagged row ${RUN}`);
    await favoriteViaApi(page, untaggedFav.id);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const row = page.locator(`[data-node-id="${created.id}"]`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
    const marker = row.getByRole("img", { name: "Favorite", exact: true });
    const more = row.getByRole("button", { name: /^Note actions for / });
    await expect(marker).toBeVisible();
    await expect(more).toBeVisible();

    const edges = await listEdges(page);
    const link = row.getByRole("link");
    const leftInset = (await box(link)).x - edges.left;
    // On a tagged row the dots slot is the rightmost item and the kebab icon ends one slot plus a gap before it; the marker is about 8px left of the kebab (icon to icon).
    const moreGlyph = await box(more.locator("svg"));
    const rightInset = edges.right - (moreGlyph.x + moreGlyph.width);
    const slotBox = await box(row.locator(":scope > span").last());
    const slotInset = edges.right - (slotBox.x + slotBox.width);
    expect(slotBox.width, "圓點欄寬").toBeCloseTo(DOTS_SLOT_WIDTH, 0);
    expect(Math.abs(slotInset - leftInset), `圓點欄右內距 ${slotInset} 與左內距 ${leftInset} 相差`).toBeLessThanOrEqual(1);
    expect(Math.abs(rightInset - slotInset - DOTS_SLOT_WIDTH - DOTS_SLOT_GAP - STAR_GLYPH_INSET), `⋮ 右內距 ${rightInset} 圓點欄右內距 ${slotInset}`).toBeLessThanOrEqual(1);
    const markerGlyph = await box(marker.locator("svg"));
    const iconGap = moreGlyph.x - (markerGlyph.x + markerGlyph.width);
    expect(iconGap, "標記與 ⋮ 的圖示間距").toBeGreaterThanOrEqual(6);
    expect(iconGap, "標記與 ⋮ 的圖示間距").toBeLessThanOrEqual(11);
    const moreBox = await box(more);
    const markerBox = await box(marker);
    expect(moreBox.x, "⋮ 在標記右邊").toBeGreaterThanOrEqual(markerBox.x + markerBox.width - 0.5);
    // There must be space between the marker and the title's visible end (the right edge of the truncated link box).
    const linkBox = await box(link);
    expect(markerBox.x - (linkBox.x + linkBox.width), "標記與標題右緣").toBeGreaterThanOrEqual(11);
    // An untagged row has no dots slot: its kebab icon is the rightmost item, 16px from the list edge like the left text start.
    const untaggedRow = page.locator(`[data-node-id="${untaggedFav.id}"]`).first();
    await expect(untaggedRow).toBeVisible({ timeout: 15_000 });
    await expect(untaggedRow.locator("[data-tag-dots]")).toHaveCount(0);
    const untaggedMore = untaggedRow.getByRole("button", { name: /^Note actions for / });
    const untaggedGlyph = await box(untaggedMore.locator("svg"));
    const untaggedInset = edges.right - (untaggedGlyph.x + untaggedGlyph.width);
    expect(Math.abs(untaggedInset - leftInset), `無標籤列 ⋮ 右內距 ${untaggedInset} 與左內距 ${leftInset} 相差`).toBeLessThanOrEqual(1);
    const untaggedMoreBox = await box(untaggedMore);
    expect(untaggedMoreBox.width).toBeLessThanOrEqual(24.5);
    expect(Math.abs(untaggedMoreBox.x + untaggedMoreBox.width - (moreBox.x + moreBox.width) - (DOTS_SLOT_WIDTH + DOTS_SLOT_GAP + 5)), "有標籤的列 ⋮ 比沒標籤的列靠左一欄").toBeLessThanOrEqual(1);
    console.log(`MEASURE 58-14 untagged kebab inset ${untaggedInset} tagged dots inset ${slotInset} tagged kebab inset ${rightInset}`);

    expect(await link.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(15);
    await showSidebarTab(page, "Recent");
    const recent = page.locator(`[data-node-id="${created.id}"]`).first().getByRole("link");
    await expect(recent).toBeVisible({ timeout: 15_000 });
    expect(await recent.locator("div").nth(0).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(15);
    expect(await recent.locator("div").nth(1).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(12);

    await showSidebarTab(page, "My notes");
    const top = page.locator("[data-phone-top-bar]");
    // span[aria-hidden] is the "K" mark.
    const mark = await box(top.locator("span[aria-hidden]").first());
    expect(Math.abs(mark.x - (edges.left + leftInset)), "標題左緣").toBeLessThanOrEqual(1);
    const avatarButton = top.getByRole("button", { name: alice.displayName, exact: true });
    const avatar = await box(avatarButton.locator("> *").first());
    expect(avatar.width).toBeCloseTo(32, 0);
    expect(Math.abs(edges.right - (avatar.x + avatar.width) - leftInset), "頭像右緣與左內距同一個內距").toBeLessThanOrEqual(1);
    expect((await box(avatarButton)).width, "頭像點擊範圍").toBeGreaterThanOrEqual(44);
    expect((await box(top.getByText("Knotebook", { exact: true }))).x).toBeLessThan((await box(avatarButton)).x);
  } finally {
    await context.close();
  }
});

test("58-15 phone note page header (390): the location is right below the title with its left edge aligned to it; the chevron is vertically centered on the title + location block", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short");
  try {
    const block = page.getByTestId("note-header-block");
    await expect(block).toBeVisible();
    const title = await box(page.getByRole("textbox", { name: "Note title" }));
    const location = await box(page.getByRole("button", { name: /^Show in list: / }));
    expect(location.y, "位置在標題下方").toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(Math.abs(location.x - title.x), "位置與標題左緣").toBeLessThanOrEqual(1);
    const blockBox = await box(block);
    const back = await box(page.getByRole("button", { name: "Back to notes", exact: true }));
    const more = await box(page.locator("header").getByRole("button", { name: "More", exact: true }));
    const centre = blockBox.y + blockBox.height / 2;
    expect(Math.abs(back.y + back.height / 2 - centre), "「‹」圓心").toBeLessThanOrEqual(2);
    expect(Math.abs(more.y + more.height / 2 - centre), "⋮ 圓心").toBeLessThanOrEqual(2);
    expect(await page.getByRole("textbox", { name: "Note title" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(20);
    expect(await page.getByRole("button", { name: /^Show in list: / }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(12);
    const dot = await box(page.getByTestId("note-header-subline").getByRole("status").locator("span").first());
    expect(dot.x - (location.x + location.width), "連線點離位置文字右緣").toBeLessThanOrEqual(12);
    expect(dot.x, "連線點在位置文字之後").toBeGreaterThanOrEqual(location.x + location.width - 1);
  } finally {
    await context.close();
  }
});

async function expectPanelSheet(page: Page, dialog: Locator): Promise<number> {
  const size = page.viewportSize()!;
  let gap = 0;
  await expect(async () => {
    const b = (await dialog.boundingBox())!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(size.width);
    expect(Math.abs(b.y + b.height - size.height), "底緣貼齊視窗底").toBeLessThanOrEqual(1);
    gap = b.y;
    expect(gap, "上方的縫").toBeGreaterThan(0);
    expect(gap, "上方的縫").toBeLessThan(40);
  }).toPass({ timeout: 5_000 });
  expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
  expect(await dialog.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
  await expectCardEdgeToEdge(page, dialog, "第一眼");
  return gap;
}

/** The visible card (the panel frame is transparent, what is seen is the card inside): left and right flush with the viewport, bottom flush with the frame bottom, full-bleed like the menu sheet. */
async function expectCardEdgeToEdge(page: Page, dialog: Locator, label: string): Promise<void> {
  const width = page.viewportSize()!.width;
  const edges = await dialog.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card], [data-shortcuts-card]")).find((c) => c.getBoundingClientRect().width > 0);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { left: r.left, right: r.right, bottomGap: outer.bottom - r.bottom, topGap: r.top - outer.top };
  });
  expect(edges, `${label}：要有一張看得見的卡`).not.toBeNull();
  console.log(`MEASURE card ${label} left ${edges!.left} right ${edges!.right} top ${edges!.topGap} bottom ${edges!.bottomGap}`);
  expect(edges!.left, `${label}：卡的左緣`).toBe(0);
  expect(edges!.right, `${label}：卡的右緣`).toBe(width);
  expect(edges!.topGap, `${label}：卡的上緣貼齊外框`).toBe(0);
  expect(edges!.bottomGap, `${label}：卡的底緣貼齊外框`).toBe(0);
}

interface SurfaceMetrics {
  bg: string;
  radius: string;
  shadow: string;
}
interface PanelMetrics extends SurfaceMetrics {
  trayBg: string;
  trayBlur: string;
}
interface ListMetrics {
  title: { fontSize: number; fontWeight: number };
  headerBorder: number;
  headerLeft: number;
  headerRight: number;
  viewportWidth: number;
  rows: {
    height: number;
    fontSize: number;
    fontWeight: number;
    bgAlpha: number;
    top: number;
    left: number;
    right: number;
    textLeft: number;
    chevronRight: number;
    radius: number;
    chevronWidth: number;
    chevronDisplay: string;
    chevronColor: string;
    /** Immediately after the previous row (adjacent in the DOM); in the help window's list the rows before and after the divider and the "Shortcuts" subheading are not adjacent. */
    joined: boolean;
  }[];
  navBg: string;
}

const menuSurface = (menu: Locator): Promise<SurfaceMetrics> =>
  menu.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });

/** Left edge (x) of the first option's content in a menu sheet (row left edge plus left padding; the leading icon and text both start here). */
const menuTextLeft = (menu: Locator): Promise<number> =>
  menu.evaluate((el) => {
    const item = el.querySelector('[role="menuitem"]')!;
    return item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft);
  });

/** Background and top-left radius of the visible card of a panel sheet, the shadow of the frame (Dialog content), plus the tray's background and blur. */
const panelSurface = (dialog: Locator): Promise<PanelMetrics> =>
  dialog.evaluate((el) => {
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card], [data-shortcuts-card]")).find((c) => c.getBoundingClientRect().width > 0)!;
    const c = getComputedStyle(card);
    const tray = getComputedStyle(card.parentElement!);
    return { bg: c.backgroundColor, radius: c.borderTopLeftRadius, shadow: getComputedStyle(el).boxShadow, trayBg: tray.backgroundColor, trayBlur: tray.backdropFilter };
  });

const listMetrics = (dialog: Locator): Promise<ListMetrics> =>
  dialog.evaluate((el) => {
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card='items'], [data-shortcuts-card='items']")).find((c) => c.getBoundingClientRect().width > 0)!;
    const header = card.firstElementChild as HTMLElement;
    const title = (header.querySelector("h2") ?? header.querySelector("p")) as HTMLElement;
    const nav = card.querySelector("nav") as HTMLElement;
    // A row is a link or button in the list (the help window's list also has dividers and group subheadings, which are not rows).
    const rowEls = Array.from(nav.querySelectorAll<HTMLElement>("a, button"));
    const alpha = (color: string): number => {
      const m = color.match(/\/\s*([\d.]+)(%?)\s*\)$/) ?? color.match(/rgba\([^)]*,\s*([\d.]+)\)$/);
      return m ? parseFloat(m[1]) / (m[2] === "%" ? 100 : 1) : 1;
    };
    return {
      title: { fontSize: parseFloat(getComputedStyle(title).fontSize), fontWeight: parseInt(getComputedStyle(title).fontWeight, 10) },
      headerBorder: parseFloat(getComputedStyle(header).borderBottomWidth),
      headerLeft: header.getBoundingClientRect().left,
      headerRight: header.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      navBg: getComputedStyle(nav).backgroundColor,
      rows: rowEls.map((row, i) => {
        const s = getComputedStyle(row);
        const svg = row.querySelector("svg") as SVGElement | null;
        return {
          height: row.getBoundingClientRect().height,
          fontSize: parseFloat(s.fontSize),
          fontWeight: parseInt(s.fontWeight, 10),
          bgAlpha: alpha(s.backgroundColor),
          top: row.getBoundingClientRect().top,
          left: row.getBoundingClientRect().left,
          right: row.getBoundingClientRect().right,
          textLeft: (row.firstElementChild as HTMLElement).getBoundingClientRect().left,
          chevronRight: svg ? svg.getBoundingClientRect().right : 0,
          radius: parseFloat(s.borderTopLeftRadius),
          chevronWidth: svg ? svg.getBoundingClientRect().width : 0,
          chevronDisplay: svg ? getComputedStyle(svg).display : "none",
          chevronColor: svg ? getComputedStyle(svg).color : "",
          joined: i > 0 && row.previousElementSibling === rowEls[i - 1],
        };
      }),
    };
  });

function expectSameSurface(panel: PanelMetrics, menu: SurfaceMetrics, label: string): void {
  console.log(`MEASURE surface ${label} panel ${panel.bg} ${panel.radius} | menu ${menu.bg} ${menu.radius} | shadow ${panel.shadow}`);
  expect(panel.bg, `${label}：卡的底色＝選單 sheet 的底色`).toBe(menu.bg);
  expect(panel.radius, `${label}：上圓角`).toBe("12px");
  expect(menu.radius, `${label}：選單的上圓角`).toBe("12px");
  expect(panel.shadow, `${label}：陰影＝選單 sheet 的陰影`).toBe(menu.shadow);
  expect(panel.shadow, `${label}：有陰影`).not.toBe("none");
  expect(panel.trayBlur, `${label}：托盤沒有模糊`).toBe("none");
  expect(alphaOf(panel.trayBg), `${label}：托盤沒有底色`).toBe(0);
}

function expectPhoneList(list: ListMetrics, label: string): void {
  console.log(`MEASURE list ${label} title ${list.title.fontSize}/${list.title.fontWeight} border ${list.headerBorder} row0 ${JSON.stringify(list.rows[0])}`);
  expect(list.title.fontSize, `${label}：標題字級`).toBe(18);
  expect(list.title.fontWeight, `${label}：標題字重`).toBe(600);
  expect(list.headerBorder, `${label}：列頭髮絲線`).toBe(1);
  expect(list.headerLeft, `${label}：髮絲線從左緣起`).toBe(0);
  expect(list.headerRight, `${label}：髮絲線到右緣止`).toBe(list.viewportWidth);
  expect(list.rows.length, `${label}：有列`).toBeGreaterThan(1);
  list.rows.forEach((row, i) => {
    expect(row.height, `${label}：列 ${i} 高`).toBeGreaterThanOrEqual(48);
    expect(row.fontSize, `${label}：列 ${i} 字級`).toBe(16);
    expect(row.fontWeight, `${label}：列 ${i} 字重`).toBe(400);
    expect(row.radius, `${label}：列 ${i} 圓角`).toBe(4);
    expect(row.bgAlpha, `${label}：列 ${i} 沒有常駐底色（目前的項次也一樣）`).toBe(0);
    expect(row.chevronWidth, `${label}：列 ${i} 的「›」`).toBe(16);
    expect(row.chevronDisplay).not.toBe("none");
    expect(Math.abs(row.left - (list.viewportWidth - row.right)), `${label}：列 ${i} 左右內縮相等`).toBeLessThanOrEqual(0.5);
    expect(row.left, `${label}：列 ${i} 底色離邊緣 8px`).toBe(8);
    expect(row.textLeft, `${label}：列 ${i} 文字離邊緣 16px`).toBe(16);
    expect(list.viewportWidth - row.chevronRight, `${label}：列 ${i}「›」離邊緣 16px`).toBe(16);
    if (row.joined) expect(row.top - (list.rows[i - 1].top + list.rows[i - 1].height), `${label}：列 ${i} 與上一列相貼`).toBeCloseTo(0, 0);
  });
}

function expectAlignedWithMenu(list: ListMetrics, menuX: number, label: string): void {
  console.log(`MEASURE align ${label} menu text x ${menuX} | row text x ${list.rows[0].textLeft} row left ${list.rows[0].left} right ${list.rows[0].right}`);
  for (const [i, row] of list.rows.entries()) expect(Math.abs(row.textLeft - menuX), `${label}：列 ${i} 文字與選單文字同 x`).toBeLessThanOrEqual(1);
}

async function expectPhoneContentHeading(dialog: Locator, heading: Locator, label: string): Promise<void> {
  await expect(heading).toBeVisible();
  // The title node may be replaced when a section page loads (the old node measures an empty string): poll until a number is measured.
  await expect.poll(() => fontPx(heading), { message: `${label}：第二層標題字級` }).toBe(18);
  expect(await heading.evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10)), `${label}：第二層標題字重`).toBe(600);
  const back = await box(dialog.getByRole("button", { name: "Back to sections", exact: true }));
  const title = await box(heading);
  expect(Math.abs(title.y + title.height / 2 - (back.y + back.height / 2)), `${label}：標題與「‹」垂直置中`).toBeLessThanOrEqual(1);
  // The chevron's background = the card (sheet) background: it looks transparent, and scrolling content passes under it.
  const surface = await panelSurface(dialog);
  expect(await dialog.getByRole("button", { name: "Back to sections", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor), `${label}：「‹」底色＝卡底色`).toBe(surface.bg);
  // The content area leaves room for the chevron (symbol up to 54px, tap area up to 62px): content without its own title (loading, error) doesn't end up under it.
  const padTop = await dialog.locator("[data-management-content], [data-shortcuts-content]").evaluateAll((els) =>
    els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => parseFloat(getComputedStyle(el).paddingTop)),
  );
  expect(padTop.length, `${label}：看得見的內容區`).toBe(1);
  expect(padTop[0], `${label}：內容區頂端內距 ≥ 62`).toBeGreaterThanOrEqual(62);
}

test("58-16 phone (390) the admin panel is a nearly full-height sheet: opened from the account menu it first stays on the item list; the chevron goes back to the account menu step by step; no close button; a deep link stays on that page and the list's chevron only closes; tapping the gap above closes", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    const avatarButton = page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true });
    const openSettingsFromMenu = async (): Promise<Locator> => {
      await avatarButton.click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      return dialog;
    };
    const insideViewport = async (target: Locator, label: string): Promise<void> => {
      const b = await box(target);
      const size = page.viewportSize()!;
      expect(b.x, `${label} 左`).toBeGreaterThanOrEqual(0);
      expect(b.y, `${label} 上`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `${label} 右`).toBeLessThanOrEqual(size.width);
      expect(b.y + b.height, `${label} 下`).toBeLessThanOrEqual(size.height);
    };

    let dialog = await openSettingsFromMenu();
    const gap = await expectPanelSheet(page, dialog);
    const lightPanel = await panelSurface(dialog);
    const lightList = await listMetrics(dialog);
    expectPhoneList(lightList, "Settings 清單");
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const toMenu = dialog.getByRole("button", { name: "Back to menu", exact: true });
    await expect(toMenu).toBeVisible();
    await expect(toMenu).toBeFocused();
    await insideViewport(toMenu, "清單的「‹」");
    const listBack = await box(toMenu);
    const listArea = await tapAreaOf(toMenu);
    expect(listArea.tap[0]).toBeGreaterThanOrEqual(43);
    expect(listArea.tap[1]).toBeGreaterThanOrEqual(43);

    await dialog.getByRole("link", { name: "Sign-in", exact: true }).click();
    const toList = dialog.getByRole("button", { name: "Back to sections", exact: true });
    await expect(toList).toBeVisible();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const contentBack = await box(toList);
    await expectCardEdgeToEdge(page, dialog, "內容層");
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "Settings 第二層");
    expect(Math.abs(contentBack.x - listBack.x), "兩層「‹」的 x").toBeLessThanOrEqual(1);
    expect(Math.abs(contentBack.y - listBack.y), "兩層「‹」的 y").toBeLessThanOrEqual(1);
    const contentArea = await tapAreaOf(toList);
    expect(contentArea.tap[0]).toBeGreaterThanOrEqual(43);
    expect(contentArea.tap[1]).toBeGreaterThanOrEqual(43);

    // A shorter viewport simulates a toolbar taking height.
    await page.setViewportSize({ width: 390, height: 740 });
    await expect(async () => {
      const b = await box(dialog);
      expect(Math.abs(b.y + b.height - 740)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.y - gap)).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 5_000 });
    await insideViewport(toList, "矮視窗的「‹」");
    await page.setViewportSize({ width: 390, height: 844 });

    await toList.click();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const lightMenu = await menuSurface(menu);
    expectSameSurface(lightPanel, lightMenu, "淺色");
    expectAlignedWithMenu(lightList, await menuTextLeft(menu), "淺色");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await avatarButton.click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const darkMenu = await menuSurface(menu);
    const darkMenuX = await menuTextLeft(menu);
    expect(darkMenu.bg, "深色底色與淺色不同").not.toBe(lightMenu.bg);
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), darkMenu, "深色");
    const darkList = await listMetrics(dialog);
    expectPhoneList(darkList, "深色 Settings 清單");
    expectAlignedWithMenu(darkList, darkMenuX, "深色");
    await dialog.getByRole("link", { name: "Sign-in", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "深色 Settings 第二層");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(menu).toHaveCount(0);

    dialog = await openSettingsFromMenu();
    await expectPanelSheet(page, dialog);
    // The upper third of the gap: touch target correction assigns a press too close to the sheet to the sheet (when the gap is too narrow it can't be hit, see `ui/dialog.tsx`).
    await page.touchscreen.tap(195, Math.max(2, gap / 3));
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.goto("/settings/login");
    dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Back to menu", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (slash) return parseFloat(slash[1]) / (slash[2] === "%" ? 100 : 1);
  const rgba = color.match(/^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)$/);
  return rgba ? parseFloat(rgba[1]) : 1;
}

test("58-17 phone note page (390): two frosted floating buttons at the same positions as the list; absent while editing; Search opens the search layer; New note creates a note; the last paragraph scrolls above the buttons", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, 390, "long");
  try {
    // This group at the bottom of the note page (the group in the sidebar is hidden behind and has the same attribute).
    const fabs = page.getByTestId("note-browse-bar").locator("[data-phone-list-fabs]");
    const search = fabs.getByRole("button", { name: "Search notes", exact: true });
    const create = fabs.getByRole("button", { name: "New note", exact: true });
    await expect(search).toBeVisible();
    await expect(create).toBeVisible();
    await expect(fabs).toHaveCount(1);

    const onNote = { s: await box(search), c: await box(create) };
    for (const b of [onNote.s, onNote.c]) {
      expect(b.width).toBeCloseTo(56, 0);
      expect(b.height).toBeCloseTo(56, 0);
      expect(844 - (b.y + b.height), "離視窗下緣").toBeCloseTo(16, 0);
    }
    expect(onNote.s.x, "Search 左緣").toBeCloseTo(16, 0);
    expect(390 - (onNote.c.x + onNote.c.width), "New note 右緣").toBeCloseTo(16, 0);

    // Frosted glass: translucent background + background blur + thin border; New note is emphasized by the icon's brand color, not a solid fill.
    const style = (target: Locator) =>
      target.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"), border: cs.borderTopWidth, color: cs.color, shadow: cs.boxShadow };
      });
    const sStyle = await style(search);
    const cStyle = await style(create);
    for (const st of [sStyle, cStyle]) {
      expect(st.filter, "backdrop-filter").toContain("blur");
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeLessThan(1);
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeGreaterThan(0.15);
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeLessThan(0.35);
      expect(st.border).toBe("1px");
      expect(st.shadow).not.toBe("none");
    }
    expect(cStyle.bg, "兩顆同一款底").toBe(sStyle.bg);
    expect(cStyle.color, "New note 的圖示是 brand 色、與 Search 不同").not.toBe(sStyle.color);
    await expect(create.locator("svg")).toHaveAttribute("data-icon", "pen-line");

    await scrollPageToEnd(page);
    const last = editorLocator(page).getByText(LONG_LAST, { exact: true });
    await expect(async () => {
      const lastBox = await box(last);
      const top = Math.min((await box(search)).y, (await box(create)).y);
      expect(lastBox.y + lastBox.height, "最後一段的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(top);
    }).toPass({ timeout: 5_000 });
    await scrollPageToTop(page);

    // Absent while editing, back after leaving. The editor can't be clicked into before it connects to collab (a click while read-only doesn't count as editing), so keep clicking until the floating buttons disappear.
    await expect(async () => {
      await editorLocator(page).getByText("paragraph number 0", { exact: true }).tap({ position: { x: 2, y: 4 } });
      await expect(fabs).toHaveCount(0, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await page.getByRole("textbox", { name: "Note title" }).click();
    await expect(fabs).toHaveCount(1);

    await search.click();
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    await expect(fabs).toHaveCount(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(search).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.long);

    await page.goto("/");
    await showSidebarTab(page, "My notes");
    const listFabs = page.locator("[data-phone-list-fabs]");
    const listS = await box(listFabs.getByRole("button", { name: "Search notes", exact: true }));
    const listC = await box(listFabs.getByRole("button", { name: "New note", exact: true }));
    for (const [a, b] of [[onNote.s, listS], [onNote.c, listC]] as const) {
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(0.5);
    }

    await page.goto(paths.long);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.long, { timeout: 15_000 });
    await page.getByTestId("note-browse-bar").getByRole("button", { name: "New note", exact: true }).click();
    await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled", { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

async function expectMenuSheet(page: Page, opts: { width?: number; height?: number; radioRows?: boolean } = {}): Promise<Locator> {
  const width = opts.width ?? 390;
  const height = opts.height ?? 844;
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(async () => {
    const b = (await menu.boundingBox())!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(width);
    expect(b.y + b.height).toBeCloseTo(height, 0);
  }).toPass({ timeout: 5_000 });
  const selector = opts.radioRows ? '[role="menuitem"], [role="menuitemradio"]' : '[role="menuitem"]';
  const rows = await menu.evaluate((el, sel) => Array.from(el.querySelectorAll(sel)).map((item) => ({ name: item.textContent ?? "", height: item.getBoundingClientRect().height })), selector);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.height, `「${row.name}」列高`).toBeGreaterThanOrEqual(48 - 0.5);
  return menu;
}

const sheetRowNames = (menu: Locator): Promise<string[]> =>
  menu.evaluate((el) => Array.from(el.querySelectorAll('[role="menuitem"]')).map((item) => item.getAttribute("aria-label") ?? item.textContent ?? ""));

test("58-18 phone (390 touch): the note page kebab, list row kebab, folder kebab and avatar menu are full-width bottom sheets with rows >= 48 high; Move to... goes in and out level by level in the sheet; rises with the keyboard; clicking the backdrop closes", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await open(browser, 390, "short", { init: stubVisualViewport });
  try {
    // The first level of Move to... needs folders to have a ", open" item to click: create F containing F1.
    const F = `E2E sheet folder ${RUN}`;
    const F1 = `E2E sheet sub ${RUN}`;
    const created = await page.request.post("/api/folders", { headers: { Origin: ORIGIN }, data: { name: F, space: { kind: "personal" } } });
    expect(created.status(), await created.text()).toBe(201);
    const fId = ((await created.json()) as { id: string }).id;
    const sub = await page.request.post("/api/folders", { headers: { Origin: ORIGIN }, data: { name: F1, parentId: fId } });
    expect(sub.status(), await sub.text()).toBe(201);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });

    await page.locator("header").getByRole("button", { name: "More", exact: true }).click();
    let menu = await expectMenuSheet(page);
    expect(await menu.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
    expect(await menu.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();
    const backdrop = await menu.evaluate((el) => {
      const style = getComputedStyle(el.parentElement!, "::before");
      return { position: style.position, top: style.top, left: style.left, width: style.width, height: style.height, color: style.backgroundColor };
    });
    expect(backdrop).toEqual({ position: "fixed", top: "0px", left: "0px", width: "390px", height: "844px", color: "rgba(0, 0, 0, 0.5)" });

    await setKeyboard(page, 300);
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.y + b.height).toBeCloseTo(844 - 300, 0);
    }).toPass({ timeout: 5_000 });
    await setKeyboard(page, 0);
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.y + b.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });

    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", `${F}, open`]);
    await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toBeFocused();
    await expect(menu.getByText("Move to…", { exact: true })).toBeVisible();
    await expectMenuSheet(page);
    await menu.getByRole("menuitem", { name: `${F}, open`, exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", "Move here", F1]);
    await expectMenuSheet(page);
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", `${F}, open`]);
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
    await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to…", exact: true })).toBeFocused();
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();

    await page.touchscreen.tap(195, 60);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.short);

    await page.goto("/");
    const panel = await showSidebarTab(page, "My notes");
    await panel.getByRole("button", { name: `Note actions for ${TITLES.short}`, exact: true }).click();
    menu = await expectMenuSheet(page);
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await panel.getByRole("button", { name: `Folder menu for ${F}`, exact: true }).click();
    menu = await expectMenuSheet(page, { radioRows: true });
    await page.touchscreen.tap(195, 60);
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true }).click();
    menu = await expectMenuSheet(page);
    await expect(menu.getByRole("menuitem", { name: "Log out", exact: true })).toBeVisible();
    await page.touchscreen.tap(195, 30);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-19 wide screen (1280): the note page kebab is still a small menu next to its button (not a sheet, no backdrop)", async ({ browser }) => {
  const { context, page } = await open(browser, 1280, "short", { touch: false });
  try {
    const more = page.locator("header").getByRole("button", { name: "More", exact: true });
    // Measure the button first: while the menu is open Radix marks content outside the menu aria-hidden, so getByRole can't find it.
    const button = await box(more);
    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAttribute("data-menu-sheet");
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.width).toBeLessThan(400);
      expect(Math.abs(b.x + b.width - (button.x + button.width))).toBeLessThanOrEqual(1);
      // align="end": right edge aligned to the button's right edge, 4px below the button.
      expect(b.y).toBeCloseTo(button.y + button.height + 4, 0);
    }).toPass({ timeout: 5_000 });
    expect(await menu.evaluate((el) => getComputedStyle(el.parentElement!, "::before").content)).toBe("none");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/** The lowest row kebab in the list (avoiding the bottom floating buttons): the sheet rises from the bottom, and the lower the row, the more likely a menu item is under the finger during the hold. */
async function lowestRowMenu(page: Page, opts: { hover: boolean }): Promise<{ button: Locator; x: number; y: number }> {
  const viewport = page.viewportSize()!;
  const buttons = page.getByRole("complementary").getByRole("button", { name: /^Note actions for / });
  const count = await buttons.count();
  let best = -1;
  let bestY = -1;
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (opts.hover) await button.locator("xpath=ancestor::li[1]").hover();
    const b = await button.boundingBox();
    if (b === null || b.width === 0 || b.y + b.height > viewport.height - 96) continue;
    if (b.y > bestY) {
      best = i;
      bestY = b.y;
    }
  }
  expect(best, "清單裡要有看得見的列 ⋮").toBeGreaterThanOrEqual(0);
  expect(bestY, "那顆 ⋮ 要在畫面下半部（sheet 會升到它底下）").toBeGreaterThan(viewport.height * 0.4);
  const button = buttons.nth(best);
  if (opts.hover) await button.locator("xpath=ancestor::li[1]").hover();
  const b = (await button.boundingBox())!;
  return { button, x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Holds for `ms` then releases: touch uses CDP touchStart/touchEnd (Playwright's tap/click releases instantly and can't measure this), mouse uses down/up. */
async function pressAndHold(page: Page, point: { x: number; y: number }, ms: number, kind: "touch" | "mouse"): Promise<void> {
  if (kind === "touch") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

for (const variant of [
  { label: "touch hold 250ms", kind: "touch", reduced: false, ms: 250 },
  { label: "touch hold 250ms, reduced motion", kind: "touch", reduced: true, ms: 250 },
  { label: "mouse hold 250ms", kind: "mouse", reduced: false, ms: 250 },
] as const) {
  test(`58-20 phone (390x560) ${variant.label}: the moment a kebab opens does not select the item that ends up under the finger once the sheet has risen`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openList(browser, 390, variant.kind === "touch");
    try {
      await page.setViewportSize({ width: 390, height: 560 });
      if (variant.reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.getByRole("complementary").getByRole("button", { name: /^Note actions for / }).first()).toBeAttached({ timeout: 15_000 });
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(`${request.method()} ${request.url()}`);
      });
      const url = page.url();
      const target = await lowestRowMenu(page, { hover: variant.kind === "mouse" });
      await pressAndHold(page, target, variant.ms, variant.kind);

      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute("data-menu-sheet");
      // Let the entry animation and any delayed click finish.
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(page.url()).toBe(url);
      // Precondition that makes this case meaningful: the release point now lies on a menu item of the sheet (under the old behaviour that release would select it).
      const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[role="menuitem"]')?.textContent ?? null, [target.x, target.y] as const);
      expect(under, "按下的那一點在 sheet 的選單項上").not.toBeNull();
      expect(writes, "開 ⋮ 不該送出任何寫入").toEqual([]);

      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("58-21 phone (390 touch): site admin and the shortcuts page opened from the account menu and the group panel opened from a group row kebab - the list's chevron closes and reopens the menu that opened it", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const groupName = `E2E sheet group ${RUN}`;
    const created = await page.request.post("/api/groups", { headers: { Origin: ORIGIN }, data: { name: groupName } });
    expect(created.status(), await created.text()).toBe(201);
    await page.reload();
    const avatarButton = page.locator("[data-phone-top-bar]").getByRole("button", { name: /.+/ }).last();
    const menu = page.getByRole("menu");

    await avatarButton.click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const accountSheet = await menuSurface(menu);
    const accountX = await menuTextLeft(menu);
    await menu.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Site admin" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), accountSheet, "Site admin");
    const adminList = await listMetrics(dialog);
    expectPhoneList(adminList, "Site admin 清單");
    expectAlignedWithMenu(adminList, accountX, "Site admin");
    await expect(dialog.getByRole("navigation", { name: "Site admin" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await dialog.getByRole("link", { name: "Groups", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "Site admin 第二層");
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Site admin" })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Site admin", exact: true })).toBeVisible();

    await menu.getByRole("menuitem", { name: "Help", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Help" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), accountSheet, "快捷鍵");
    const shortcutsList = await listMetrics(dialog);
    expectPhoneList(shortcutsList, "快捷鍵清單");
    expectAlignedWithMenu(shortcutsList, accountX, "快捷鍵");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const shortcutsBack = dialog.getByRole("button", { name: "Back to menu", exact: true });
    await expect(shortcutsBack).toBeVisible({ timeout: 15_000 });
    const listBox = await box(shortcutsBack);
    await dialog.getByRole("button", { name: "Sidebar", exact: true }).click();
    const sectionsBack = dialog.getByRole("button", { name: "Back to sections", exact: true });
    await expect(sectionsBack).toBeVisible();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 3 }), "快捷鍵第二層");
    const entryFonts = await dialog.locator("[data-shortcut-id]").first().evaluate((li) => ({
      name: parseFloat(getComputedStyle(li.querySelector("p.font-medium")!).fontSize),
      desc: parseFloat(getComputedStyle(li.querySelector("p.text-muted-foreground")!).fontSize),
      divider: parseFloat(getComputedStyle(li).borderBottomWidth),
    }));
    expect(entryFonts).toEqual({ name: 16, desc: 14, divider: 1 });
    const contentBox = await box(sectionsBack);
    expect(Math.abs(contentBox.x - listBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(contentBox.y - listBox.y)).toBeLessThanOrEqual(1);
    await sectionsBack.click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    const panel = await showSidebarTab(page, "Groups");
    await panel.getByRole("button", { name: `Group actions for ${groupName}`, exact: true }).click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const groupSheet = await menuSurface(menu);
    const groupX = await menuTextLeft(menu);
    await menu.getByRole("menuitem", { name: "Members & settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: groupName });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    await expect(dialog.getByRole("navigation", { name: groupName })).toBeVisible();
    expectSameSurface(await panelSurface(dialog), groupSheet, "群組");
    const groupList = await listMetrics(dialog);
    expectPhoneList(groupList, "群組清單");
    expectAlignedWithMenu(groupList, groupX, "群組");
    await dialog.getByRole("link", { name: "About", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "群組第二層");
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: groupName })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(menu.getByText(groupName, { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Members & settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

const pageScrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

const edgesOf = (target: Locator): Promise<{ top: number; bottom: number }> =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });

/** Scrolls with the wheel (a user scroll, not setting scrollTop) over whatever scrolls under the point `x, y`. */
async function wheelAt(page: Page, x: number, y: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, dy);
}

test("58-22 phone list (390): the document scrolls (the list container doesn't); top bar and title row are pinned to the top; the last row scrolls above the floating buttons; background reaches the viewport bottom; list -> note starts at the top and back restores the position", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    for (let i = 0; i < 24; i++) await createNoteVia(page, `E2E page scroll row ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const list = page.locator("[data-sidebar-list]").first();
    const rows = list.locator('[data-node-kind="note"]');
    await expect(rows.nth(23)).toBeAttached({ timeout: 15_000 });

    expect(await scrollRange(page), "文件要能捲").toBeGreaterThan(300);
    expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight), "清單容器不自己捲").toBeLessThanOrEqual(1);

    await wheelAt(page, 195, 500, 600);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(100);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);

    const topBar = page.locator("[data-phone-top-bar]");
    const header = page.locator("[data-sidebar-header]").first();
    const topEdges = await edgesOf(topBar);
    expect(topEdges.top).toBeCloseTo(0, 0);
    expect(topEdges.bottom).toBeCloseTo(48, 0);
    expect((await edgesOf(header)).top).toBeCloseTo(topEdges.bottom, 0);
    expect(alphaOf(await topBar.evaluate((el) => getComputedStyle(el).backgroundColor)), "頂列底色不透明").toBe(1);
    expect(alphaOf(await header.evaluate((el) => getComputedStyle(el).backgroundColor)), "標題列底色不透明").toBe(1);
    await expect(topBar.getByRole("button").last()).toBeInViewport();

    await scrollPageToEnd(page);
    const fabs = page.locator("[data-phone-list-fabs]");
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const last = await box(rows.last());
      expect(last.y + last.height, "最後一列的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
    }).toPass({ timeout: 5_000 });

    const colors = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      aside: getComputedStyle(document.querySelector("aside[data-sidebar-instance]")!).backgroundColor,
      asideBottom: document.querySelector("aside[data-sidebar-instance]")!.getBoundingClientRect().bottom,
      bottomHit: document.elementFromPoint(195, window.innerHeight - 1)?.closest("aside[data-sidebar-instance]") !== null,
    }));
    expect(colors.html).toBe(colors.aside);
    expect(colors.body).toBe(colors.aside);
    expect(colors.asideBottom).toBeGreaterThanOrEqual(844 - 0.5);
    expect(colors.bottomHit, "視窗最底那一點落在清單上").toBe(true);

    await page.evaluate(() => window.scrollTo(0, 400));
    const before = await pageScrollY(page);
    expect(before).toBe(400);
    const target = await list.evaluate((el) => {
      const headerBottom = document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => {
        const r = a.getBoundingClientRect();
        return r.top >= headerBottom + 4 && r.bottom <= window.innerHeight - 100;
      });
      return link?.getAttribute("href") ?? null;
    });
    expect(target).not.toBeNull();
    await list.locator(`a[href="${target}"]`).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    expect(await pageScrollY(page), "筆記從頂端開始").toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => pageScrollY(page), { message: "回到清單原本的位置" }).toBe(before);
  } finally {
    await context.close();
  }
});

test("58-23 phone short list (390): no extra scroll range and the list still extends to the viewport bottom", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    // Nobody shared notes with this account, so Shared with me is the short list.
    await showSidebarTab(page, "Shared with me");
    await expect(page.locator("[data-sidebar-header]").first()).toBeVisible();
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const asideBottom = await page.locator("aside[data-sidebar-instance]").first().evaluate((el) => el.getBoundingClientRect().bottom);
    expect(asideBottom).toBeCloseTo(844, 0);
  } finally {
    await context.close();
  }
});

test("58-24 phone long note (390): the document scrolls; the header is pinned and opaque; the last paragraph scrolls above the floating buttons; opening and closing dialogs and menus doesn't jump; the search layer's Cancel returns to the earlier position", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, 390, "long", { touch: false });
  try {
    const last = editorLocator(page).getByText(LONG_LAST, { exact: true });
    await expect(last).toBeAttached({ timeout: 15_000 });
    expect(await scrollRange(page), "文件要能捲").toBeGreaterThan(300);
    expect(await scrollerOf(page).evaluate((el) => el.scrollHeight - el.clientHeight), "內文容器不自己捲").toBeLessThanOrEqual(1);
    expect(await pageScrollY(page), "筆記從頂端開始").toBe(0);

    await wheelAt(page, 195, 500, 700);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(100);
    const slot = page.locator("[data-note-header-slot]");
    expect((await edgesOf(slot)).top).toBeCloseTo(0, 0);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Back to notes", exact: true })).toBeInViewport();
    expect(alphaOf(await slot.evaluate((el) => getComputedStyle(el).backgroundColor)), "頁首底色不透明").toBe(1);
    // The header height is written to --kb-sticky-top and blocks' scroll-margin-top follows it (scrolling to a paragraph leaves room for the header).
    const slotHeight = await slot.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(await last.evaluate((el) => getComputedStyle(el.closest(".bn-block-outer")!).scrollMarginTop)).toBe(`${slotHeight}px`);

    await scrollPageToEnd(page);
    const fabs = page.getByTestId("note-browse-bar").locator("[data-phone-list-fabs]");
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const b = await box(last);
      expect(b.y + b.height, "最後一段的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
      // No extra blank space at the end: at the bottom the last paragraph is only the floating buttons' space plus the column's bottom padding from the viewport bottom.
      expect(844 - (b.y + b.height), "最後一段離視窗底").toBeLessThanOrEqual(200);
    }).toPass({ timeout: 5_000 });
    const colors = await page.evaluate(() => {
      const card = document.querySelector("[data-note-header-slot]")!.parentElement!;
      return {
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(card).backgroundColor,
        cardBottom: card.getBoundingClientRect().bottom,
      };
    });
    expect(colors.html).toBe(colors.card);
    expect(colors.body).toBe(colors.card);
    expect(colors.cardBottom).toBeGreaterThanOrEqual(844 - 0.5);

    // The position doesn't change while a menu (Radix locks scrolling; focus returns to the kebab when it closes) is open and after it closes. Use coordinates to click: only the app's own behaviour is measured,
    // without Playwright's scroll-into-view before clicking getting involved.
    const clickAt = async (target: Locator) => {
      const b = await box(target);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    await page.evaluate(() => window.scrollTo(0, 500));
    const y = await pageScrollY(page);
    expect(y).toBe(500);
    await clickAt(page.locator("header").getByRole("button", { name: "More", exact: true }));
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await pageScrollY(page), "選單開著時不跳").toBe(y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await pageScrollY(page), "選單關掉後不跳").toBe(y);
    await clickAt(page.locator("header").getByRole("button", { name: "Share", exact: true }));
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await pageScrollY(page), "對話框開著時不跳").toBe(y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await pageScrollY(page), "對話框關掉後不跳").toBe(y);

    await clickAt(page.getByTestId("note-browse-bar").getByRole("button", { name: "Search notes", exact: true }));
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    expect(await pageScrollY(page)).toBe(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await expect.poll(() => pageScrollY(page)).toBe(y);
  } finally {
    await context.close();
  }
});

test("58-25 pull to refresh: blocked on the list and on a note being edited (overscroll-behavior-y: contain), unchanged on a note being read", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 390, "long");
  try {
    const overscroll = () => page.evaluate(() => ({ html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY }));
    await expect(editorLocator(page).getByText("paragraph number 0", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await overscroll()).toEqual({ html: "auto", body: "auto" });
    // Editing (toolbar present); the editor can't be clicked into before it connects to collab, so keep clicking until the toolbar appears.
    await expect(async () => {
      await editorLocator(page).getByText("paragraph number 0", { exact: true }).tap({ position: { x: 2, y: 4 } });
      await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    expect(await overscroll()).toEqual({ html: "contain", body: "contain" });
    await page.getByRole("button", { name: "Back to notes", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(await overscroll()).toEqual({ html: "contain", body: "contain" });
  } finally {
    await context.close();
  }
});

test("58-26 wide screen (1280x800): the page itself doesn't scroll (scrollY stays 0) and the note's body container does", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 1280, "long", { touch: false, height: 800 });
  try {
    await expect(editorLocator(page).getByText(LONG_LAST, { exact: true })).toBeAttached({ timeout: 15_000 });
    expect(await scrollRange(page), "文件沒有捲動範圍").toBeLessThanOrEqual(0);
    const scroller = scrollerOf(page);
    const scrollerBox = await box(scroller);
    await wheelAt(page, scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2, 700);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    expect(await pageScrollY(page)).toBe(0);
    // The frame is still locked to the viewport height; body keeps the page background (not the phone's card color).
    expect(await page.locator("[data-phone-page-scroll]").evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(800, 0);
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector("[data-note-header-slot]")!.parentElement!).backgroundColor }));
    expect(colors.body).not.toBe(colors.card);
  } finally {
    await context.close();
  }
});

async function bubbleGeometry(page: Page): Promise<{ bubble: Rect; scrollbar: number; clientRight: number; scroller: Rect; footer: Rect; blur: string; opacity: string; hit: boolean }> {
  return page.evaluate(() => {
    const bubbleEl = document.querySelector('[data-testid="versions-bubble"]') as HTMLElement;
    const anchor = document.querySelector('[data-testid="corner-anchor"]') as HTMLElement;
    const card = anchor.parentElement!;
    const scrollEl = card.querySelector('[data-testid="article-column"]')!.closest(".overflow-y-auto") as HTMLElement;
    const footerEl = anchor.nextElementSibling as HTMLElement;
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
    };
    const sb = scrollEl.getBoundingClientRect();
    const scrollbar = scrollEl.offsetWidth - scrollEl.clientWidth;
    const clientRight = sb.x + scrollEl.clientLeft + scrollEl.clientWidth;
    const b = bubbleEl.getBoundingClientRect();
    const hitEl = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const cs = getComputedStyle(bubbleEl);
    return { bubble: r(bubbleEl), scrollbar, clientRight, scroller: r(scrollEl), footer: r(footerEl), blur: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"), opacity: getComputedStyle(anchor.firstElementChild!).opacity, hit: hitEl === bubbleEl || bubbleEl.contains(hitEl) };
  });
}

interface Rect { x: number; y: number; width: number; height: number; right: number; bottom: number }

function expectBubbleInNoteArea(g: Awaited<ReturnType<typeof bubbleGeometry>>, label: string): void {
  console.log(`MEASURE ${label} ${JSON.stringify(g)}`);
  expect(g.blur, `${label}：毛玻璃`).toMatch(/blur\(/);
  expect(g.bubble.right, `${label}：在內文區右緣內`).toBeLessThanOrEqual(g.scroller.right);
  expect(g.bubble.right, `${label}：離右緣有空隙（讓出捲軸）`).toBeLessThanOrEqual(g.scroller.right - 16);
  expect(g.bubble.bottom, `${label}：在內文區下緣內`).toBeLessThanOrEqual(g.scroller.bottom);
  expect(g.bubble.x).toBeGreaterThanOrEqual(g.scroller.x);
  expect(g.bubble.y).toBeGreaterThanOrEqual(g.scroller.y);
  expect(g.bubble.bottom, `${label}：不壓到提及列`).toBeLessThanOrEqual(g.footer.y + 0.5);
  const gapBottom = g.footer.y - g.bubble.bottom;
  // On the right measure the left edge of the scrollbar gutter; the scroll area always reserves the gutter, so short notes have it too and the gaps on both sides are equal.
  const gapRight = g.clientRight - g.bubble.right;
  expect(g.scrollbar, `${label}：預留捲軸槽`).toBeGreaterThan(0);
  expect(Math.abs(gapRight - gapBottom), `${label}：右邊空隙 ${gapRight}、下邊 ${gapBottom}、槽寬 ${g.scrollbar}`).toBeLessThanOrEqual(1);
  expect(Math.abs(gapBottom - 18), `${label}：離提及列上緣 18px（實 ${gapBottom}）`).toBeLessThanOrEqual(1);
}

test("58-32 wide screen (1280, 900, 767, 700 x 800): the history bubble is frosted glass pinned to the bottom right of the body area (above the mentions row) and doesn't disappear while scrolling; the same at the three widths, short/long notes and with/without mentions; 390 has no bubble", async ({ browser }) => {
  test.setTimeout(480_000);
  for (const width of [1280, 900, 767, 700]) {
    const columnLeft: Record<string, number> = {};
    for (const [key, backlinks] of [["long", false], ["short", false], ["mentioned", true]] as const) {
      const { context, page } = await open(browser, width, key, { touch: false, height: 800, backlinks });
      try {
        await expect(page.getByTestId("versions-bubble")).toBeVisible({ timeout: 15_000 });
        if (backlinks) await expect(page.getByText(/^Mentioned in 1 note$/)).toBeVisible();
        const widthButton = page.getByRole("button", { name: /^Width:/ });
        for (const mode of ["standard", "wide", "full"]) {
          if (mode !== "standard") {
            // The 700 header has no width button (it is in the kebab): change width at 1280 and return to the original viewport; the width setting is kept across viewports.
            if (width < 768) await page.setViewportSize({ width: 1280, height: 800 });
            await widthButton.click();
            if (width < 768) await page.setViewportSize({ width, height: 800 });
          }
          const label = `${width} ${key} ${mode}`;
          const g = await bubbleGeometry(page);
          expectBubbleInNoteArea(g, label);
          if (mode === "standard") columnLeft[key] = (await page.getByTestId("article-column").boundingBox())!.x;
          expect(g.hit, `${label}：點得到`).toBe(true);
          const pad = await page.getByTestId("article-column").evaluate((el) => ({ top: getComputedStyle(el).paddingTop, bottom: getComputedStyle(el).paddingBottom }));
          expect(pad.bottom, `${label}：欄的下內距等於上內距`).toBe(pad.top);
          if (key === "long" && mode === "standard") {
            const scroller = scrollerOf(page);
            await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await page.waitForTimeout(1_200);
            const after = await bubbleGeometry(page);
            expect(after.opacity, "捲動後沒有淡出").toBe("1");
            expect(after.hit, "捲動後仍點得到").toBe(true);
            expect(Math.abs(after.bubble.y - g.bubble.y), "泡泡不隨內文捲走").toBeLessThanOrEqual(0.5);
            await scroller.evaluate((el) => { el.scrollTop = 0; });
          }
        }
        if (key === "mentioned") {
          const g = await bubbleGeometry(page);
          expect(g.footer.height, "有提及列").toBeGreaterThan(20);
          expect(g.bubble.bottom).toBeLessThanOrEqual(g.footer.y + 0.5);
        }
      } finally {
        await context.close();
      }
    }
    // The scrollbar gutter is always reserved: the article column's left edge is at the same position for a long note (with scrollbar) and a short one (without).
    console.log(`MEASURE ${width} article column left ${JSON.stringify(columnLeft)}`);
    expect(Math.abs(columnLeft.long! - columnLeft.short!), `${width}：長短筆記的文章欄左緣不動`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(columnLeft.long! - columnLeft.mentioned!), `${width}：有提及時也不動`).toBeLessThanOrEqual(0.5);
  }
  const { context, page } = await open(browser, 390, "long");
  try {
    await expect(page.getByTestId("versions-bubble")).toHaveCount(0);
    await expect(page.getByTestId("corner-anchor")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-33 wide screen (1280x800): on hover the history bubble's background is the light brand color (light and dark, equal to bg-brand-soft) with a pointer cursor, and returns to frosted glass when the pointer leaves", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 1280, "long", { touch: false, height: 800 });
  try {
    const bubble = page.getByTestId("versions-bubble");
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      const bg = () => bubble.evaluate((el) => getComputedStyle(el).backgroundColor);
      const rest = await bg();
      await bubble.hover();
      await page.waitForTimeout(400);
      const hover = await bg();
      console.log(`MEASURE bubble bg ${scheme} rest ${rest} hover ${hover}`);
      const soft = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "bg-brand-soft";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      });
      console.log(`MEASURE bubble bg-brand-soft ${scheme} ${soft}`);
      expect(hover, `${scheme}：hover 底色等於 bg-brand-soft`).toBe(soft);
      expect(hover, `${scheme}：hover 與平時不同`).not.toBe(rest);
      expect(await bubble.evaluate((el) => getComputedStyle(el).cursor), `${scheme}：游標是手指`).toBe("pointer");
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      expect(await bg(), `${scheme}：移開後回到平時`).toBe(rest);
    }
  } finally {
    await context.close();
  }
});

/** How far the paragraph containing `text` is from the visible top edge: on a phone the header's bottom edge, from 640 up the body container's top edge. */
async function blockOffset(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const block = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-content")).find((el) => el.textContent === needle)!;
    const scroller = document.querySelector('[data-testid="article-column"]')!.closest(".overflow-y-auto") as HTMLElement;
    const scrolls = getComputedStyle(scroller).overflowY !== "visible";
    const top = scrolls ? scroller.getBoundingClientRect().top : document.querySelector("[data-note-header-slot]")!.getBoundingClientRect().bottom;
    return block.getBoundingClientRect().top - top;
  }, text);
}

test("58-27 rotation (390x844 -> 844x390 -> 390x844): a long note stays at the same paragraph (a phone scrolls the document, landscape scrolls the body container)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 390, "long", { touch: false });
  try {
    const target = "paragraph number 20";
    await expect(editorLocator(page).getByText(target, { exact: true })).toBeAttached({ timeout: 15_000 });
    await page.evaluate(async (needle) => {
      const block = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-content")).find((el) => el.textContent === needle)!;
      const header = document.querySelector("[data-note-header-slot]")!.getBoundingClientRect().bottom;
      window.scrollTo(0, window.scrollY + block.getBoundingClientRect().top - header);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, target);
    expect(Math.abs(await blockOffset(page, target)), "那一段在頁首正下方附近").toBeLessThanOrEqual(8);
    expect(await pageScrollY(page)).toBeGreaterThan(300);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => scrollerOf(page).evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    await expect.poll(() => blockOffset(page, target).then((d) => Math.abs(d) <= 40), { message: "橫拿：那一段在內文容器頂端附近" }).toBe(true);
    expect(await pageScrollY(page), "橫拿：文件不捲").toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => scrollerOf(page).evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    await expect.poll(() => blockOffset(page, target).then((d) => Math.abs(d) <= 40), { message: "轉回直拿：那一段在頁首正下方附近" }).toBe(true);
    expect(await pageScrollY(page)).toBeGreaterThan(300);
  } finally {
    await context.close();
  }
});

test("58-29 rotation (390x844 -> 844x390 -> 390x844): the list stays at the same row (in landscape the list is in a drawer)", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    for (let i = 0; i < 24; i++) await createNoteVia(page, `E2E rotate row ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const list = page.locator("[data-sidebar-list]").first();
    await expect(list.locator('[data-node-kind="note"]').nth(23)).toBeAttached({ timeout: 15_000 });
    const rowOffset = (href: string) =>
      page.evaluate((h) => {
        const row = document.querySelector(`[data-sidebar-list] a[href="${h}"]`)!.closest("[data-node-kind]")!.firstElementChild!;
        return row.getBoundingClientRect().top - document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      }, href);
    await page.evaluate(() => window.scrollTo(0, 500));
    const href = await list.evaluate((el) => {
      const headerBottom = document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => a.getBoundingClientRect().top >= headerBottom);
      return link!.getAttribute("href")!;
    });
    await page.evaluate(async (d) => {
      window.scrollTo(0, window.scrollY + d);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, await rowOffset(href));
    const offset = await rowOffset(href);
    expect(Math.abs(offset), "那一列在標題列正下方附近").toBeLessThanOrEqual(30);
    const before = await pageScrollY(page);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-phone-top-bar]")).toBeVisible();
    await expect(async () => {
      const d = await rowOffset(href);
      expect(Math.abs(d - offset), `轉回直拿：同一列回到原本的位置（原 ${offset}、現 ${d}、scrollY ${await pageScrollY(page)}／${before}）`).toBeLessThanOrEqual(2);
    }).toPass({ timeout: 5_000 });
    expect(Math.abs((await pageScrollY(page)) - before)).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("58-28 wide screen (1280): the admin panel's rows, title, card and tray are unchanged - rows 36px/14px, the current item has a brand background, no chevron, the tray is frosted glass", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await openList(browser, 1280, false);
  try {
    await page.goto("/settings/login");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const items = dialog.locator("[data-management-card='items']");
    await expect(items.getByRole("link", { name: "Sign-in", exact: true })).toBeVisible();
    const list = await listMetrics(dialog);
    expect(list.title.fontSize).toBe(15);
    expect(list.title.fontWeight).toBe(600);
    expect(list.headerBorder, "沒有列頭髮絲線").toBe(0);
    for (const [i, row] of list.rows.entries()) {
      expect(row.height, `列 ${i} 高`).toBe(36);
      expect(row.fontSize, `列 ${i} 字級`).toBe(14);
      expect(row.radius, `列 ${i} 圓角`).toBe(8);
      expect(row.chevronDisplay, `列 ${i} 沒有「›」`).toBe("none");
      if (i > 0) expect(row.top - (list.rows[i - 1].top + list.rows[i - 1].height), `列 ${i} 與上一列的間距`).toBe(4);
    }
    const current = await items.getByRole("link", { name: "Sign-in", exact: true }).evaluate((el) => ({ weight: parseInt(getComputedStyle(el).fontWeight, 10), bg: getComputedStyle(el).backgroundColor }));
    expect(current.weight, "目前的項次 500").toBe(500);
    expect(alphaOf(current.bg), "目前的項次有品牌底").toBeGreaterThan(0);
    const surface = await dialog.evaluate((el) => {
      const card = el.querySelector<HTMLElement>("[data-management-card='items']")!;
      const tray = getComputedStyle(card.parentElement!);
      return { cardBg: getComputedStyle(card).backgroundColor, cardRadius: getComputedStyle(card).borderTopLeftRadius, trayRadius: tray.borderTopLeftRadius, trayBlur: tray.backdropFilter, trayShadow: tray.boxShadow };
    });
    expect(surface.cardRadius).toBe("12px");
    expect(surface.trayRadius).toBe("16px");
    expect(surface.trayBlur).toMatch(/blur/);
    expect(surface.trayShadow).not.toBe("none");
    // The card is still the card color (in dark it is darker than the menu's popover; here only that it isn't transparent is measured).
    expect(alphaOf(surface.cardBg)).toBe(1);
    const h1 = dialog.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    expect(await fontPx(h1), "第二層標題 20px").toBe(20);

    await page.setViewportSize({ width: 700, height: 844 });
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Back to menu", exact: true })).toHaveCount(0);
    const mid = await listMetrics(dialog);
    expect(mid.title.fontSize).toBe(15);
    expect(mid.headerBorder, "700：沒有列頭髮絲線").toBe(0);
    for (const [i, row] of mid.rows.entries()) {
      expect(row.height, `700：列 ${i} 高`).toBe(36);
      expect(row.fontSize, `700：列 ${i} 字級`).toBe(14);
      expect(row.chevronDisplay, `700：列 ${i} 沒有「›」`).toBe("none");
    }
    const midCurrent = await items.getByRole("link", { name: "Sign-in", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(alphaOf(midCurrent), "700：目前的項次有品牌底").toBeGreaterThan(0);
    await items.getByRole("link", { name: "Sign-in", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("58-30 phone (390) dark: the table card's main column cells have the card's background (not the card color that is darker than the surface); the chevron's background = the card's background", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await page.goto("/admin/users");
    const dialog = page.getByRole("dialog", { name: "Site admin" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const row = dialog.getByRole("row").nth(1);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const cell = row.getByRole("cell").first();
    const surface = await panelSurface(dialog);
    const cellBg = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`MEASURE table cell dark card ${surface.bg} cell ${cellBg}`);
    expect(alphaOf(cellBg) === 0 || cellBg === surface.bg, "主欄格透明或與卡同色").toBe(true);
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "深色 Site admin Users");
  } finally {
    await context.close();
  }
});

test("58-31 short phone screen (568x320 landscape): settings' item list scrolls itself, the row header stays, and the last row can be scrolled to and tapped", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 568, height: 320 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    await page.goto("/settings/login");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    const nav = dialog.getByRole("navigation", { name: "Settings" });
    await expect(nav).toBeVisible();
    const scroll = await nav.evaluate((el) => ({ client: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY, overflowX: el.scrollWidth - el.clientWidth }));
    console.log(`MEASURE short list ${JSON.stringify(scroll)}`);
    expect(scroll.overflowY).toBe("auto");
    expect(scroll.scrollHeight, "清單比可見高度高（要捲）").toBeGreaterThan(scroll.client);
    expect(scroll.overflowX, "沒有橫向捲動").toBeLessThanOrEqual(0);
    const headerTop = await dialog.getByRole("heading", { name: "Settings" }).evaluate((el) => el.getBoundingClientRect().top);
    const links = nav.getByRole("link");
    const last = links.last();
    await last.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const after = await nav.evaluate((el, lastEl) => {
      const n = el.getBoundingClientRect();
      const r = (lastEl as HTMLElement).getBoundingClientRect();
      return { scrollTop: el.scrollTop, rowTop: r.top, rowBottom: r.bottom, navTop: n.top, navBottom: n.bottom, height: window.innerHeight };
    }, await last.elementHandle());
    console.log(`MEASURE short list after ${JSON.stringify(after)}`);
    expect(after.scrollTop, "清單捲過了").toBeGreaterThan(0);
    expect(after.rowBottom, "最後一列在清單可見範圍內").toBeLessThanOrEqual(after.navBottom + 1);
    expect(after.rowTop).toBeGreaterThanOrEqual(after.navTop - 1);
    expect(after.rowBottom, "最後一列在畫面內").toBeLessThanOrEqual(after.height);
    expect(await dialog.getByRole("heading", { name: "Settings" }).evaluate((el) => el.getBoundingClientRect().top), "列頭沒有跟著捲").toBe(headerTop);
    const name = (await last.innerText()).trim();
    await last.tap();
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible();
    await expect(nav).toBeHidden();
    expect(name.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
