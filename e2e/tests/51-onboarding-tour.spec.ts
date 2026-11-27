import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  editorLocator,
  loginAs,
  noteIdFromUrl,
  openTour,
  randomEmail,
  selectionAiBox,
  setAutoWait,
  showSidebarTab,
  toastWithTitle,
  tourCard,
  waitForEditorSelection,
} from "./helpers.js";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems } from "../../apps/web/src/components/shortcuts/release-highlights.js";

/**
 * Feature tour (part one: opened manually from the help window, static site, sample note).
 *
 * - There is one entry: user menu "Help" (or Ctrl+/) -> the help window's "Feature tour" page -> "Start tour". The tour never appears on its own.
 * - One fresh account per test: every tour start creates a new "Welcome to Knotebook" in My notes, so accounts are not shared to keep the count exact.
 * - The sample note's content is compared only through the `markdown` field of `GET /api/notes/:id/content`: the response's `lastEdited` changes within seconds after a write.
 * - After a full page load of a note page (reload/goto), wait for the "Note title" box before touching the sidebar (the fallback before NotePage mounts carries its own sidebar).
 * - Verified on Chromium only.
 */

/** English string bundle (used by the help window's What's new page); item titles are read from it instead of hard-coding what this version contains. */
const WHATS_NEW_STRINGS = JSON.parse(
  readFileSync(new URL("../../apps/web/src/i18n/shortcuts.en.json", import.meta.url), "utf8"),
) as { helpGuide: { whatsNew: { heading: string; empty: string; items: Record<string, { title: string }> } } };

const SAMPLE_TITLE = "Welcome to Knotebook";
const USER_NAME = "Tour User";

/** Target elements of each stop (`data-kb-tour-target`), wide viewport; in the tour's stop order. */
const WIDE_TARGETS: readonly (readonly string[])[] = [
  ["tabs"],
  ["newNote"],
  ["newFolder"],
  ["search"],
  ["share", "noteMenu"],
  ["versions"],
  ["knowledgeIcon"],
  ["noteMenu"],
  ["wikilinkMenu"],
  ["slashMenu", "flowchart"],
  ["userMenu"],
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Account {
  email: string;
  password: string;
}

/** Admin invites a new account, then `page` logs in as it (lands on home `/`); returns the account so another context can log in as the same person. */
async function signUpFreshUser(browser: Browser, page: Page): Promise<Account> {
  const email = randomEmail();
  const password = "e2e-tour-user-pw";
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email, password, displayName: USER_NAME });
  } finally {
    await adminContext.close();
  }
  await loginAs(page, email, password);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: USER_NAME, exact: true })).toBeVisible();
  return { email, password };
}

const userMenuTrigger = (page: Page): Locator => page.getByRole("button", { name: USER_NAME, exact: true });

async function sampleNotesInMyNotes(page: Page): Promise<Locator> {
  const panel = await showSidebarTab(page, "My notes");
  return panel.getByText(SAMPLE_TITLE, { exact: true });
}

async function readProgress(page: Page): Promise<{ n: number; total: number }> {
  const label = tourCard(page).getByText(/^\d+ \/ \d+$/);
  await expect(label).toBeVisible();
  const [n, total] = ((await label.textContent()) ?? "").split("/").map((s) => Number(s.trim()));
  return { n: n!, total: total! };
}

const cardTitle = (page: Page): Locator => tourCard(page).getByRole("heading", { level: 2 });

async function walkToLastStop(page: Page, onStep?: (n: number, total: number) => Promise<void>): Promise<number> {
  const { total } = await readProgress(page);
  for (let n = 1; n <= total; n++) {
    await expect(tourCard(page).getByText(`${n} / ${total}`, { exact: true })).toBeVisible();
    await onStep?.(n, total);
    if (n < total) await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
  }
  return total;
}

/** From the current stop presses Next up to stop `stop`; before each press waits for the current stop's "n / N" (a Next pressed during a stop change is ignored). */
async function goToStop(page: Page, stop: number, total: number): Promise<void> {
  const { n: from } = await readProgress(page);
  for (let n = from; n < stop; n++) {
    await expect(tourCard(page).getByText(`${n} / ${total}`, { exact: true })).toBeVisible();
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
  }
  await expect(tourCard(page).getByText(`${stop} / ${total}`, { exact: true })).toBeVisible();
}

/** Reads the cut-out rectangle (the svg is the viewport size with its top-left at the origin, so attribute values are viewport coordinates). */
async function holeBox(page: Page): Promise<Box> {
  const hole = page.locator("[data-tour-hole]");
  await expect(hole).toHaveCount(1);
  return hole.evaluate((el) => ({
    x: Number(el.getAttribute("x")),
    y: Number(el.getAttribute("y")),
    width: Number(el.getAttribute("width")),
    height: Number(el.getAttribute("height")),
  }));
}

async function targetsBox(page: Page, ids: readonly string[]): Promise<Box> {
  const boxes: Box[] = [];
  for (const id of ids) {
    const box = await page.locator(`[data-kb-tour-target="${id}"]:visible`).first().boundingBox();
    expect(box, `目標 ${id} 看不到`).not.toBeNull();
    boxes.push(box!);
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/**
 * How far the cut-out extends beyond the target, matching `HOLE_PADDING` in the product's `apps/web/src/components/tour/geometry.ts`
 * (e2e can't import web code, so change both together).
 */
const HOLE_PADDING = 6;
/** Tolerance (px) for measurement error and rounded corners. */
const HOLE_TOLERANCE = 8;

function expectHoleCovers(hole: Box, target: Box): void {
  const tol = HOLE_TOLERANCE;
  expect(hole.x).toBeLessThanOrEqual(target.x + tol);
  expect(hole.y).toBeLessThanOrEqual(target.y + tol);
  expect(hole.x + hole.width).toBeGreaterThanOrEqual(target.x + target.width - tol);
  expect(hole.y + hole.height).toBeGreaterThanOrEqual(target.y + target.height - tol);
}

function expectHoleMatches(hole: Box, target: Box): void {
  expectHoleCovers(hole, target);
  const slack = HOLE_PADDING + HOLE_TOLERANCE;
  expect(hole.x).toBeGreaterThanOrEqual(target.x - slack);
  expect(hole.y).toBeGreaterThanOrEqual(target.y - slack);
  expect(hole.x + hole.width).toBeLessThanOrEqual(target.x + target.width + slack);
  expect(hole.y + hole.height).toBeLessThanOrEqual(target.y + target.height + slack);
}

/** The exit notice when no note page was deleted (the line NotePage shows when the open note is deleted). */
async function expectNoDeletedNotice(page: Page): Promise<void> {
  await expect(page.getByText("This note has been deleted.")).toHaveCount(0);
}

const originPath = (page: Page): string => new URL(page.url()).pathname;

/**
 * After the tour ends it is back at the start and focus is on `focus`.
 *
 * At the moment the URL changes back the screen may still show the tour page's old sidebar (with a same-named trigger, which `toBeFocused` could wrongly match),
 * so first wait for state that holds only on the destination: home = no note title box; an existing note = the title box value is that note's title.
 */
async function expectBackAtStart(page: Page, start: { path: string; noteTitle?: string }, focus: Locator): Promise<void> {
  const titleBox = page.getByRole("textbox", { name: "Note title" });
  if (start.noteTitle === undefined) await expect(titleBox).toHaveCount(0);
  else await expect(titleBox).toHaveValue(start.noteTitle);
  await expect.poll(() => originPath(page)).toBe(start.path);
  await expect(focus).toBeFocused();
}

/**
 * Where the sample notes went: `kept` of them are still in the list and the trash has none.
 * "Not moved" is a negative assertion, so first give the delete request time to land (trashing and returning focus run in parallel: by the time the caller's focus assertion passes the request has been sent),
 * then confirm once through the API and once on screen. `waitForLoadState("networkidle")` can't be used: in a single-page app it is already reached and returns at once.
 */
async function expectSamplesKept(page: Page, kept: number): Promise<void> {
  await page.waitForTimeout(1_500);
  const notesRes = await page.request.get("/api/notes");
  expect(notesRes.status()).toBe(200);
  const notes = (await notesRes.json()) as { title: string }[];
  expect(notes.filter((n) => n.title === SAMPLE_TITLE)).toHaveLength(kept);
  const trashRes = await page.request.get("/api/trash");
  expect(trashRes.status()).toBe(200);
  const trash = (await trashRes.json()) as { items: { title: string }[] };
  expect(trash.items.filter((n) => n.title === SAMPLE_TITLE)).toHaveLength(0);

  const trashPanel = await showSidebarTab(page, "Trash");
  await expect(trashPanel.getByText(SAMPLE_TITLE, { exact: true })).toHaveCount(0);
  await expect(await sampleNotesInMyNotes(page)).toHaveCount(kept);
  await expect(toastWithTitle(page, "Moved to the trash")).toHaveCount(0);
}

/** Response of `GET /api/ai/actions` when the site has one usable AI action (read by the tour's AI stop and the format toolbar's AI button). */
const AI_ACTIONS_NONEMPTY = {
  actions: [{ id: "improve", name: "Improve writing", applyMode: "direct", kind: "quick" }],
};

/** Fixes the AI action list this page sees (other tests on the stack may have set AI; if not fixed the number of stops would drift). */
async function stubAiActions(page: Page, actions: "none" | "some"): Promise<void> {
  await page.route("**/api/ai/actions", (route) => route.fulfill({ json: actions === "some" ? AI_ACTIONS_NONEMPTY : { actions: [] } }));
}

/** The `markdown` field of the current URL's note content (`lastEdited` changes within seconds after a write, so the whole response isn't compared). */
function markdownReader(page: Page, noteId: string): () => Promise<string> {
  return async () => {
    const res = await page.request.get(`/api/notes/${noteId}/content`);
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { markdown: string }).markdown;
  };
}

/** Starts the tour, waits for the sample content to be written to the server, and returns the note id, a function that reads the content, and the content from before the live stops. */
async function startTourOnSample(page: Page): Promise<{ noteId: string; read: () => Promise<string>; before: string }> {
  await openTour(page, USER_NAME);
  const noteId = await noteIdFromUrl(page);
  const read = markdownReader(page, noteId);
  await expect.poll(read, { timeout: 15_000 }).toContain("What a note can hold");
  return { noteId, read, before: await read() };
}

/** Presses Next to the stop whose card title equals `title`; before each press waits for the current stop to settle. */
async function goToTitle(page: Page, title: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const current = (await cardTitle(page).textContent()) ?? "";
    if (current === title) return;
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).not.toHaveText(current);
  }
  throw new Error(`走不到標題是「${title}」的那一站`);
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The card does not cover `target` (the live stops must let people read the menu). */
async function expectCardClearOf(page: Page, target: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const [card, box] = [await tourCard(page).boundingBox(), await target.boundingBox()];
        return card === null || box === null ? -1 : overlapArea(card, box);
      },
      { message: "說明卡不該蓋到演示站的選單" },
    )
    .toBe(0);
}

async function expectCardContentOnTop(page: Page): Promise<void> {
  const card = tourCard(page);
  const parts = [card.getByRole("heading", { level: 2 }), card.getByRole("button", { name: "Next", exact: true })];
  for (const part of parts) {
    await expect
      .poll(
        async () =>
          part.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return top !== null && el.closest("[data-tour-card]")!.contains(top);
          }),
        { message: "說明卡的標題與下一步要在最上層" },
      )
      .toBe(true);
  }
}

async function domSelection(page: Page): Promise<{ collapsed: boolean; text: string }> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    return { collapsed: sel?.isCollapsed ?? true, text: sel?.toString() ?? "" };
  });
}

/** Composes a Zhuyin character with an input method in the editor and then commits it (CDP), simulating Zhuyin/pinyin IME input at the caret or over a selection. */
async function composeWithIme(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "ㄅ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "ㄅㄚ", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "八" });
  } finally {
    await cdp.detach();
  }
}

/** The cut-out must cover `target` (right after the tour changes stop or the toolbar mounts, the position is still being computed, so poll). */
async function expectHoleCoversLocator(page: Page, target: Locator, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const [hole, box] = [await holeBox(page), await target.boundingBox()];
        if (box === null) return false;
        try {
          expectHoleCovers(hole, box);
          return true;
        } catch {
          return false;
        }
      },
      { message },
    )
    .toBe(true);
}

const aiToolbarButton = (page: Page): Locator =>
  page.locator("[data-kb-formatting-toolbar-popover]").getByRole("button", { name: "AI", exact: true });

const phoneAvatar = (page: Page): Locator => page.locator("[data-phone-top-bar]").getByRole("button", { name: USER_NAME, exact: true });

/**
 * Targets (`data-kb-tour-target`) each stop highlights on a phone, and the screen it should be on, in the tour's stop order. The stops on the list (tab bar, the new-note button at bottom right,
 * the new-folder button, the search button at bottom left, the avatar in the top bar) point at real things on the list (`/`); the rest are on the sample note; the AI stop is skipped on a phone (no floating format toolbar).
 */
const PHONE_STOPS: readonly { ids: readonly string[]; on: "list" | "note" }[] = [
  { ids: ["tabs"], on: "list" },
  { ids: ["phoneNewNote"], on: "list" },
  { ids: ["newFolder"], on: "list" },
  { ids: ["phoneSearch"], on: "list" },
  { ids: ["share", "noteMenu"], on: "note" },
  { ids: ["noteMenu"], on: "note" },
  { ids: ["knowledgeIcon"], on: "note" },
  { ids: ["noteMenu"], on: "note" },
  { ids: ["wikilinkMenu"], on: "note" },
  { ids: ["slashMenu"], on: "note" },
  { ids: ["userMenu"], on: "list" },
];

/** Limit for a stop change: the tour waits 3 seconds for a target before skipping the stop; on a phone every stop (including changing screens) must appear before that. */
const PHONE_STEP_LIMIT_MS = 2_500;

/** On a phone the card is inside the viewport and does not cover the pinned top bar (list) or the note header, nor the visible round buttons at the bottom (tolerance 1 px). */
async function expectCardClearOfPhoneChrome(page: Page, message: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const card = document.querySelector("[data-tour-card]")?.getBoundingClientRect();
          if (!card) return "no card";
          if (card.left < 0 || card.top < 0 || card.right > window.innerWidth + 1 || card.bottom > window.innerHeight + 1) return "outside the screen";
          for (const selector of ["main header", "[data-phone-top-bar]"]) {
            for (const el of document.querySelectorAll(selector)) {
              if (el.closest("[inert]") !== null) continue;
              const r = el.getBoundingClientRect();
              if (r.height > 0 && r.bottom > 0 && card.top < r.bottom - 1) return `over ${selector}`;
            }
          }
          for (const fab of document.querySelectorAll("[data-phone-fab]")) {
            if (fab.closest("[inert]") !== null) continue;
            const r = fab.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && card.bottom > r.top + 1) return "over the round buttons";
          }
          return "ok";
        }),
      { message },
    )
    .toBe("ok");
}

const SAMPLE_URL = /\/n\/[^/]+\/welcome-to-knotebook/;

/**
 * On a phone presses Next stop by stop to the last stop (without pressing the last stop's button): each stop is on the right screen (the list is `/`, the rest the sample note), the cut-out covers the target,
 * the card avoids the top bar, header and round buttons and is topmost, and each stop change (including changing screens) happens within `PHONE_STEP_LIMIT_MS`. Returns the total number of stops.
 */
async function walkPhoneTour(page: Page): Promise<number> {
  const { total } = await readProgress(page);
  for (let n = 1; n <= total; n++) {
    await expect(tourCard(page).getByText(`${n} / ${total}`, { exact: true })).toBeVisible();
    const stop = PHONE_STOPS[n - 1]!;
    if (stop.on === "list") await expect.poll(() => originPath(page), { message: `第 ${n} 站要在清單上` }).toBe("/");
    else await expect(page, `第 ${n} 站要在示範筆記上`).toHaveURL(SAMPLE_URL);
    for (const id of stop.ids) {
      await expectHoleCoversLocator(page, page.locator(`[data-kb-tour-target="${id}"]:visible`).first(), `第 ${n} 站的挖洞要蓋住 ${id}`);
    }
    // The [[ and / stops put focus in the editor: the editor is set to inputmode="none" so touch devices don't bring up the on-screen keyboard; stops on other notes don't have this attribute.
    if (stop.on === "note") {
      const live = stop.ids.includes("wikilinkMenu") || stop.ids.includes("slashMenu");
      if (live) await expect(editorLocator(page), `第 ${n} 站`).toHaveAttribute("inputmode", "none");
      else await expect(editorLocator(page), `第 ${n} 站`).not.toHaveAttribute("inputmode");
    }
    await expectCardClearOfPhoneChrome(page, `第 ${n} 站的說明卡要在畫面內、不蓋住頂列、頁首與圓形鈕`);
    if (n === total) break;
    await expectCardContentOnTop(page);
    const before = Date.now();
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(tourCard(page).getByText(`${n + 1} / ${total}`, { exact: true })).toBeVisible();
    expect(Date.now() - before, `第 ${n} 站到第 ${n + 1} 站`).toBeLessThan(PHONE_STEP_LIMIT_MS);
  }
  return total;
}

async function openTourOnPhone(page: Page): Promise<void> {
  await phoneAvatar(page).click();
  await page.getByRole("menuitem", { name: "Help", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Help", exact: true });
  await help.getByRole("button", { name: "Feature tour", exact: true }).click();
  await help.getByRole("button", { name: "Start tour", exact: true }).click();
  await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
}

test.describe("feature tour (manual start)", () => {
  // Other tests on the stack may have set AI actions (the tour would gain an AI stop). Default to none; a case that needs AI calls `stubAiActions(page, "some")` itself, and the later-registered route takes priority.
  test.beforeEach(async ({ page }) => {
    await stubAiActions(page, "none");
  });

  test("never starts by itself: no card after login, note open and reload, and no sample note is created", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await createNote(page, `E2E tour idle ${Date.now()}`);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(tourCard(page)).toHaveCount(0);
    await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
    await expect(await sampleNotesInMyNotes(page)).toHaveCount(0);
  });

  for (const origin of ["home", "note"] as const) {
    test(`from the Help dialog starting on ${origin === "home" ? "the home page" : "an existing note"}: walks every stop with the cut-out on its target, keeps the sample, returns to where it started`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);
      await signUpFreshUser(browser, page);
      const startTitle = `E2E tour from note ${Date.now()}`;
      if (origin === "note") await createNote(page, startTitle);
      const start = { path: originPath(page), noteTitle: origin === "note" ? startTitle : undefined };

      await openTour(page, USER_NAME);
      // The help window was closed before this started; once the tour takes over, focus is in the card and is not pulled away by a help window that would restore focus later.
      await expect(page.getByRole("dialog", { name: "Help", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/n\/[^/]+\/welcome-to-knotebook/);
      await expect(tourCard(page).getByRole("button", { name: "Next", exact: true })).toBeFocused();
      await page.waitForTimeout(500);
      await expect(tourCard(page).locator(":focus")).toHaveCount(1);

      const total = await walkToLastStop(page, async (n) => {
        const ids = WIDE_TARGETS[n - 1]!;
        await expect.poll(async () => {
          const [hole, target] = [await holeBox(page), await targetsBox(page, ids)];
          try {
            expectHoleMatches(hole, target);
            return true;
          } catch {
            return false;
          }
        }, { message: `第 ${n} 站的挖洞要對上 ${ids.join("+")}` }).toBe(true);
      });
      expect(total).toBe(WIDE_TARGETS.length);

      await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
      await expect(tourCard(page)).toHaveCount(0);
      await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
      await expectBackAtStart(page, start, userMenuTrigger(page));
      await expectSamplesKept(page, 1);
    });
  }

  test("Skip on the first stop closes the tour, returns to the start page and keeps the sample note", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await tourCard(page).getByRole("button", { name: "Skip feature tour", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));
    await expectSamplesKept(page, 1);
  });

  test("Esc on a middle stop closes the tour, returns to the start page and keeps the sample note", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(tourCard(page).getByText(/^3 \/ \d+$/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));
    await expectSamplesKept(page, 1);
  });

  test("starting twice and keeping both times leaves two sample notes (each start makes a new one)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    for (let round = 0; round < 2; round++) {
      await openTour(page, USER_NAME);
      await walkToLastStop(page);
      await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
      await expect(tourCard(page)).toHaveCount(0);
      await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));
    }
    await expectSamplesKept(page, 2);
  });

  test("Ctrl+K and Ctrl+/ do nothing while the tour is running", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("textbox", { name: "Search notes" })).not.toBeFocused();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByRole("dialog", { name: "Help", exact: true })).toHaveCount(0);
    await expect(tourCard(page)).toBeVisible();
  });

  test("opening Help with Ctrl+/ and starting the tour from its Feature tour page works; focus ends on the user menu button", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await page.keyboard.press("ControlOrMeta+/");
    const dialog = page.getByRole("dialog", { name: "Help", exact: true });
    await expect(dialog.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "true");
    await dialog.getByRole("button", { name: "Feature tour", exact: true }).click();
    await dialog.getByRole("button", { name: "Start tour", exact: true }).click();
    await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toHaveCount(0);
    await walkToLastStop(page);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));
  });

  test("the sample note holds columns, a diagram, a table and a link to itself, and Ctrl+Z does not undo the sample content", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await walkToLastStop(page);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);

    await (await sampleNotesInMyNotes(page)).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
    const noteId = await noteIdFromUrl(page);
    const read = async (): Promise<string> => {
      const res = await page.request.get(`/api/notes/${noteId}/content`);
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { markdown: string }).markdown;
    };
    const before = await read();
    expect(before).toContain("What a note can hold");
    expect(before).toContain("Left column");
    expect(before).toContain("Right column");
    expect(before).toContain("graph LR");
    expect(before).toMatch(/\|\s*Name\s*\|\s*Value\s*\|/);
    expect(before).toContain(noteId); // the site link points at itself

    // Smoke check: the reopened editor's undo stack is empty, so there is nothing to undo here anyway; "the write is not undoable" is covered by unit tests.
    await page.getByText("This note was made for the feature tour.").click();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(1_500);
    expect(await read()).toBe(before);
  });

  test("the [[ stop opens the real link menu inside the window; clicking its items does nothing, and the note is unchanged afterwards", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    const noteId = await noteIdFromUrl(page);
    const read = async (): Promise<string> => {
      const res = await page.request.get(`/api/notes/${noteId}/content`);
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { markdown: string }).markdown;
    };

    // The sample content must be on the server before there is a baseline to compare. Take the baseline before reaching the live stops so that any write caused by opening the menu counts.
    await expect.poll(read, { timeout: 15_000 }).toContain("What a note can hold");
    const before = await read();

    const { total } = await readProgress(page);
    const stop = WIDE_TARGETS.findIndex((ids) => ids[0] === "wikilinkMenu") + 1;
    await goToStop(page, stop, total);
    await expect(cardTitle(page)).toHaveText("Link to another note");

    const menu = page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first();
    await expect(menu).toBeVisible();
    await expect(menu.locator(".bn-suggestion-menu-item").first()).toBeVisible();
    const box = await menu.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expectHoleMatches(await holeBox(page), box!);

    // Clicking a menu item has no effect: the menu is still there, still on the same stop, content unchanged. The fixed one-second wait is what a negative assertion needs: there is no event to wait for.
    // The tour overlay is above the menu, so a real click lands on the overlay; a click also sent directly to the item confirms the interception behind the overlay also holds.
    expect(
      await menu.locator(".bn-suggestion-menu-item").first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit?.closest("[data-tour-overlay]");
      }),
    ).toBe(true);
    await menu.locator(".bn-suggestion-menu-item").first().click({ force: true });
    await menu.locator(".bn-suggestion-menu-item").first().dispatchEvent("click");
    await page.waitForTimeout(1_000);
    await expect(menu).toBeVisible();
    await expect(tourCard(page).getByText(`${stop} / ${total}`, { exact: true })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(cardTitle(page)).toHaveText("Insert blocks with /");
    await expect(page.locator('[data-kb-tour-target="wikilinkMenu"]')).toHaveCount(0);
    await goToStop(page, total, total);
    await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));

    await (await sampleNotesInMyNotes(page)).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
    await page.waitForTimeout(1_500);
    expect(await read()).toBe(before);
  });

  test("the / stop opens the real insert menu next to the flowchart, mentions side-by-side columns, ignores typing and clicks, and leaves the note unchanged", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    const noteId = await noteIdFromUrl(page);
    const read = async (): Promise<string> => {
      const res = await page.request.get(`/api/notes/${noteId}/content`);
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()) as { markdown: string }).markdown;
    };
    await expect.poll(read, { timeout: 15_000 }).toContain("What a note can hold");
    const before = await read();

    const { total } = await readProgress(page);
    const stop = WIDE_TARGETS.findIndex((ids) => ids[0] === "slashMenu") + 1;
    await goToStop(page, stop, total);
    await expect(cardTitle(page)).toHaveText("Insert blocks with /");
    await expect(tourCard(page)).toContainText("side-by-side columns");
    await expect(tourCard(page)).toContainText("2 columns");

    // The [[ menu closed at the previous stop may linger in the DOM for a moment, so match only the / menu's own target attribute.
    const menu = page.locator('[data-kb-tour-target="slashMenu"]:visible').first();
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Heading 1", { exact: true })).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expect
      .poll(
        async () => {
          const [hole, target] = [await holeBox(page), await targetsBox(page, ["slashMenu", "flowchart"])];
          try {
            expectHoleMatches(hole, target);
            return true;
          } catch {
            return false;
          }
        },
        { message: "挖洞要對上 / 選單與流程圖" },
      )
      .toBe(true);

    // Typing, arrow keys and clicking a menu item have no effect: the menu is still there, still on the same stop, content unchanged. The fixed one-second wait is what a negative assertion needs: there is no event to wait for.
    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowDown");
    // The tour overlay is above the menu, so a real click lands on the overlay; a click also sent directly to the item confirms the interception behind the overlay also holds.
    expect(
      await menu.locator(".bn-suggestion-menu-item").first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit?.closest("[data-tour-overlay]");
      }),
    ).toBe(true);
    await menu.locator(".bn-suggestion-menu-item").first().click({ force: true });
    await menu.locator(".bn-suggestion-menu-item").first().dispatchEvent("click");
    await page.waitForTimeout(1_000);
    await expect(menu).toBeVisible();
    await expect(tourCard(page).getByText(`${stop} / ${total}`, { exact: true })).toBeVisible();
    expect(await read()).toBe(before);

    await page.keyboard.press("Enter");
    await expect(cardTitle(page)).toHaveText("Forgot how something works?");
    await expect(page.locator('[data-kb-tour-target="slashMenu"]')).toHaveCount(0);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);

    await (await sampleNotesInMyNotes(page)).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
    await page.waitForTimeout(1_500);
    expect(await read()).toBe(before);
  });

  test("with text in the search box, the stops that point at the hidden tab bar, folder button and search box are left out", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await page.getByRole("textbox", { name: "Search notes" }).fill("zzz");
    await openTour(page, USER_NAME);
    const { total } = await readProgress(page);
    expect(total).toBe(WIDE_TARGETS.length - 3);
    const titles: string[] = [];
    await walkToLastStop(page, async () => {
      titles.push((await cardTitle(page).textContent()) ?? "");
    });
    expect(titles).toHaveLength(total);
    expect(titles).not.toContain("Sidebar sections");
    expect(titles).not.toContain("Folders");
    expect(titles).not.toContain("Search");
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    // The tour does not clear the user's search text.
    await expect(page.getByRole("textbox", { name: "Search notes" })).toHaveValue("zzz");
  });

  test("a failed sample-note creation shows one error toast and no overlay; the next start works", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    const failCreate = (route: Route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) })
        : route.fallback();
    await page.route("**/api/notes", failCreate);

    await page.getByRole("button", { name: USER_NAME, exact: true }).click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    await page.getByRole("dialog", { name: "Help", exact: true }).getByRole("button", { name: "Start tour", exact: true }).click();
    await expect(toastWithTitle(page, "Couldn't create the sample note. Try again.")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    await expect(page.getByText("Couldn't create the sample note. Try again.", { exact: true })).toHaveCount(1);
    await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
    await expect.poll(() => originPath(page)).toBe("/");

    await page.unroute("**/api/notes", failCreate);
    await openTour(page, USER_NAME);
    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await tourCard(page).getByRole("button", { name: "Skip feature tour", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
  });

  test("starting on the Groups tab: the tour switches to My notes for its sidebar stops and puts Groups back afterwards", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await showSidebarTab(page, "Groups");
    await openTour(page, USER_NAME);
    const tab = (name: string): Locator => page.getByRole("complementary").getByRole("tab", { name, exact: true });
    await walkToLastStop(page, async (n) => {
      // From stop 2 (New note) on, it must be on My notes.
      if (n >= 2) await expect(tab("My notes")).toHaveAttribute("aria-selected", "true");
    });
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expect(tab("Groups")).toHaveAttribute("aria-selected", "true");
  });

  test("last stop: Keep is focused by default and Enter keeps the sample note without a trash toast", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await walkToLastStop(page);
    await expect(tourCard(page).getByRole("button", { name: "Keep sample note", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, userMenuTrigger(page));
    await expectSamplesKept(page, 1);
  });

  for (const origin of ["home", "note"] as const) {
    test(`last stop Delete starting on ${origin === "home" ? "the home page" : "an existing note"}: ends on the start page with no deleted-note notice, the sample goes to the trash, and Undo brings it back`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);
      await signUpFreshUser(browser, page);
      const startTitle = `E2E tour delete from note ${Date.now()}`;
      if (origin === "note") await createNote(page, startTitle);
      const start = { path: originPath(page), noteTitle: origin === "note" ? startTitle : undefined };
      await openTour(page, USER_NAME);
      await walkToLastStop(page);
      await page.keyboard.press("Tab"); // Keep → Delete
      const del = tourCard(page).getByRole("button", { name: "Delete sample note", exact: true });
      await expect(del).toBeFocused();
      await page.keyboard.press("Enter");

      // This part depends on how long the "moved to trash" toast lives (about 5 seconds): don't add slow assertions before the Undo.
      const trashed = toastWithTitle(page, "Moved to the trash");
      await expect(trashed).toBeVisible({ timeout: 15_000 });
      await expect(trashed.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
      await expect(tourCard(page)).toHaveCount(0);
      await expectBackAtStart(page, start, userMenuTrigger(page));
      await page.waitForTimeout(1_000);
      await expectNoDeletedNotice(page);

      await expect(await sampleNotesInMyNotes(page)).toHaveCount(0);
      const trashPanel = await showSidebarTab(page, "Trash");
      await expect(trashPanel.getByText(SAMPLE_TITLE, { exact: true })).toHaveCount(1);

      await trashed.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(await sampleNotesInMyNotes(page)).toHaveCount(1);
    });
  }

  test("a start that never gets the editor ready gives up after about 15 seconds: one toast, no overlay, the blank sample goes to the trash, back on the start page", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await signUpFreshUser(browser, page);
    // The token request never answers, so the editor never becomes editable.
    const hang = () => {
      /* neither fulfill nor continue */
    };
    await page.route("**/api/notes/*/collab-token", hang);

    await page.getByRole("button", { name: USER_NAME, exact: true }).click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    await page.getByRole("dialog", { name: "Help", exact: true }).getByRole("button", { name: "Start tour", exact: true }).click();
    const failed = toastWithTitle(page, "The feature tour couldn't start. Try again.");
    await expect(failed).toBeVisible({ timeout: 40_000 });
    await expect(tourCard(page)).toHaveCount(0);
    await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
    await expect.poll(() => originPath(page)).toBe("/");
    await page.waitForTimeout(1_000);
    await expect(page.getByText("The feature tour couldn't start. Try again.", { exact: true })).toHaveCount(1);
    await expectNoDeletedNotice(page);

    await page.unroute("**/api/notes/*/collab-token", hang);
    await expect(await sampleNotesInMyNotes(page)).toHaveCount(0);
    const trashPanel = await showSidebarTab(page, "Trash");
    await expect(trashPanel.getByText(SAMPLE_TITLE, { exact: true })).toHaveCount(1);

    await openTour(page, USER_NAME);
    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await tourCard(page).getByRole("button", { name: "Skip feature tour", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
  });

  test("on the [[ stop typing, arrow keys and Enter do not write: Enter moves on, Esc closes, and the note stays as it was", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    const { read, before } = await startTourOnSample(page);
    const { total } = await readProgress(page);
    await goToTitle(page, "Link to another note");
    const menu = page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first();
    await expect(menu).toBeVisible();

    await page.keyboard.type("xyz");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(1_000); // negative assertion: no event to wait for
    await expect(menu).toBeVisible();
    await expect(cardTitle(page)).toHaveText("Link to another note");
    expect(await read()).toBe(before);
    expect(await read()).not.toContain("xyz");

    await page.keyboard.press("Enter");
    await expect(cardTitle(page)).not.toHaveText("Link to another note");
    await expect(page.locator('[data-kb-tour-target="wikilinkMenu"]')).toHaveCount(0);
    expect(await read()).toBe(before);
    expect((await readProgress(page)).total).toBe(total);

    await page.keyboard.press("Escape");
    await expect(tourCard(page)).toHaveCount(0);
    await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(await read()).toBe(before);
  });

  test("the / stop card does not cover the menu in a wide window", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    await goToTitle(page, "Insert blocks with /");
    const menu = page.locator('[data-kb-tour-target="slashMenu"]:visible').first();
    await expect(menu.getByText("Heading 1", { exact: true })).toBeVisible();
    await expectCardClearOf(page, menu);
  });

  test("IME composition on the [[ stop writes nothing", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    const { read, before } = await startTourOnSample(page);
    await goToTitle(page, "Link to another note");
    await expect(page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first()).toBeVisible();

    await composeWithIme(page);
    await page.waitForTimeout(1_500); // negative assertion: no event to wait for
    expect(await read()).toBe(before);
    expect(await read()).not.toContain("八");
    await expect(editorLocator(page)).not.toContainText("八");
    await expect(cardTitle(page)).toHaveText("Link to another note");
  });

  test("with an AI action configured the AI stop selects the sentence with the AI button inside the cut-out, ignores IME and clicks, and collapses the selection on leaving", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await stubAiActions(page, "some");
    await signUpFreshUser(browser, page);
    const { read, before } = await startTourOnSample(page);
    const { total } = await readProgress(page);
    expect(total).toBe(WIDE_TARGETS.length + 1);
    await goToTitle(page, "Ask AI about a selection");
    // Stop order: the AI stop sits between the [[ stop and the / stop.
    expect((await readProgress(page)).n).toBe(WIDE_TARGETS.findIndex((ids) => ids[0] === "wikilinkMenu") + 2);

    const aiButton = aiToolbarButton(page);
    await expect(aiButton).toBeVisible();
    await expectHoleCoversLocator(page, aiButton, "AI 站的挖洞要蓋住工具列上的 AI 鈕");
    await expect.poll(() => domSelection(page)).toEqual({ collapsed: false, text: "Select this sentence to try AI." });

    await composeWithIme(page);
    await aiButton.dispatchEvent("click");
    await page.waitForTimeout(1_000); // negative assertion: no event to wait for
    await expect(selectionAiBox(page)).toHaveCount(0);
    expect(await read()).toBe(before);
    expect(await read()).toContain("Select this sentence to try AI.");
    await expect(editorLocator(page)).not.toContainText("八");
    await expect(editorLocator(page)).toContainText("Select this sentence to try AI.");
    expect(await domSelection(page)).toEqual({ collapsed: false, text: "Select this sentence to try AI." });

    // After leaving the stop the sentence is no longer highlighted. The next stop (/) puts the caret into the last empty paragraph itself, so the result is what is checked here; the selection collapsing on leaving is covered by unit tests.
    await page.keyboard.press("ArrowRight");
    await expect(cardTitle(page)).toHaveText("Insert blocks with /");
    await expect.poll(async () => (await domSelection(page)).text).not.toBe("Select this sentence to try AI.");
    await page.waitForTimeout(500);
    expect((await domSelection(page)).collapsed).toBe(true);
    expect(await read()).toBe(before);
  });

  test("without an AI action the AI stop is left out and the tour is one stop shorter", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    const titles: string[] = [];
    const total = await walkToLastStop(page, async () => {
      titles.push((await cardTitle(page).textContent()) ?? "");
    });
    expect(total).toBe(WIDE_TARGETS.length);
    expect(titles).not.toContain("Ask AI about a selection");
    expect(titles).toContain("Link to another note");
    expect(titles).toContain("Insert blocks with /");
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
  });

  test("the tour does not touch another note: a draft written beforehand reads the same after the live stops", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await stubAiActions(page, "some");
    await signUpFreshUser(browser, page);
    await createNote(page, `Bob's draft ${Date.now()}`);
    await editorLocator(page).click();
    await waitForEditorSelection(page);
    await page.keyboard.type("Bob wrote this line.");
    const draftId = await noteIdFromUrl(page);
    const readDraft = markdownReader(page, draftId);
    await expect.poll(readDraft, { timeout: 15_000 }).toContain("Bob wrote this line.");
    const draftBefore = await readDraft();
    const draftPath = originPath(page);

    await openTour(page, USER_NAME);
    for (const title of ["Link to another note", "Ask AI about a selection", "Insert blocks with /"]) {
      await goToTitle(page, title);
      await page.keyboard.type("abc");
      await composeWithIme(page);
    }
    const { total } = await readProgress(page);
    await goToStop(page, total, total);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expect.poll(() => originPath(page)).toBe(draftPath);
    await page.waitForTimeout(1_500);
    expect(await readDraft()).toBe(draftBefore);
    await expect(editorLocator(page)).toContainText("Bob wrote this line.");
    await expect(editorLocator(page)).not.toContainText("abc");
  });

  test("an edit from another device while the [[ stop is open arrives as usual: the menu stays open and both sides converge", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const account = await signUpFreshUser(browser, page);
    const { noteId, read, before } = await startTourOnSample(page);
    await goToTitle(page, "Link to another note");
    const menu = page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first();
    await expect(menu).toBeVisible();
    const editorUrl = page.url();

    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await loginAs(other, account.email, account.password);
      await expect(other).toHaveURL(/\/$/);
      await other.goto(editorUrl);
      await expect(other.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
      const intro = editorLocator(other).getByText("This note was made for the feature tour.");
      await intro.click();
      await waitForEditorSelection(other);
      await other.keyboard.press("End");
      await waitForEditorSelection(other);
      await other.keyboard.type(" Remote words.");

      await expect(editorLocator(page)).toContainText("Remote words.", { timeout: 15_000 });
      await expect(menu).toBeVisible();
      await expect(cardTitle(page)).toHaveText("Link to another note");
      await expect.poll(read, { timeout: 15_000 }).toContain("Remote words.");
      const merged = await read();
      expect(merged).not.toBe(before);
      expect(merged).toContain("What a note can hold");
      expect(await markdownReader(other, noteId)()).toBe(merged);
    } finally {
      await otherContext.close();
    }
  });

  test("reloading on the [[ stop ends the tour and leaves the content and the number of versions as they were", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await loginAs(adminPage, ADMIN.email, ADMIN.password);
      await expect(adminPage).toHaveURL(/\/$/);
      await setAutoWait(adminPage, 1);
      try {
        await signUpFreshUser(browser, page);
        const { noteId, read, before } = await startTourOnSample(page);
        const versionCount = async (): Promise<number> => {
          const res = await page.request.get(`/api/notes/${noteId}/versions?limit=100`);
          expect(res.status(), await res.text()).toBe(200);
          return ((await res.json()) as { versions: unknown[] }).versions.length;
        };
        await goToTitle(page, "Link to another note");
        await expect(page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first()).toBeVisible();
        await page.waitForTimeout(3_000); // the autosave-version wait is squeezed to 1 second
        expect(await versionCount()).toBeLessThanOrEqual(1);

        await page.reload();
        await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
        await expect(tourCard(page)).toHaveCount(0);
        await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
        await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);
        await page.waitForTimeout(3_000);
        expect(await read()).toBe(before);
        // The version is saved only once, for writing the sample content (when the machine is busy it may arrive after the reload): wait until it is exactly 1, then confirm the live stops and the reload added no other.
        await expect.poll(versionCount, { timeout: 15_000 }).toBe(1);
        await page.waitForTimeout(3_000);
        expect(await versionCount()).toBe(1);
      } finally {
        await setAutoWait(adminPage, null);
      }
    } finally {
      await adminContext.close();
    }
  });

  for (const who of ["a regular user", "the site admin"] as const) {
    test(`the Help window's What's new page lists the registry's items that ${who} can see, titled by the string bundle`, async ({ page, browser }) => {
      test.setTimeout(90_000);
      if (who === "a regular user") await signUpFreshUser(browser, page);
      else await loginAs(page, ADMIN.email, ADMIN.password);
      const visible = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, who === "the site admin");
      await page.getByRole("button", { name: who === "a regular user" ? USER_NAME : "admin", exact: true }).click();
      await page.getByRole("menuitem", { name: "Help", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Help", exact: true });
      await dialog.getByRole("button", { name: "What's new", exact: true }).click();
      const content = dialog.locator('[data-help-page-content="whatsNew"]');
      await expect(content).toBeVisible();
      if (visible.length === 0) {
        await expect(content.getByText("Nothing new to highlight in this version.", { exact: true })).toBeVisible();
        await expect(content.locator("[data-highlight-id]")).toHaveCount(0);
        return;
      }
      await expect(content.getByRole("heading", { level: 3, name: `New in v${RELEASE_HIGHLIGHTS.version}`, exact: true })).toBeVisible();
      await expect(content.locator("[data-highlight-id]")).toHaveCount(visible.length);
      for (const item of visible) {
        const title = WHATS_NEW_STRINGS.helpGuide.whatsNew.items[item.id]?.title;
        expect(title, `字串包缺 ${item.id} 的標題`).toBeTruthy();
        await expect(content.locator(`[data-highlight-id="${item.id}"]`).getByText(title!, { exact: true })).toBeVisible();
      }
    });
  }

  test("after Version history the knowledge stop highlights the sample heading's Verified icon and the tags stop highlights ⋮; Back from the [[ stop brings the icon into view again; ending the tour adds no tag to the space", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await startTourOnSample(page);
    await goToTitle(page, "Version history");

    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Knowledge info");
    const icon = page.locator('[data-kb-tour-target="knowledgeIcon"]:visible');
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAccessibleName("Knowledge info: Verified");
    const heading = editorLocator(page).getByRole("heading", { name: "What a note can hold", exact: true });
    const [iconBox, headingBox] = [await icon.boundingBox(), await heading.boundingBox()];
    expect(iconBox !== null && headingBox !== null && iconBox.y < headingBox.y + headingBox.height && iconBox.y + iconBox.height > headingBox.y, "圖示在示範標題那一行").toBe(true);
    await expectHoleCoversLocator(page, icon, "知識資訊站的挖洞要蓋住示範標題的狀態圖示");
    await expect(tourCard(page)).toContainText("/info");

    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Tags");
    await expectHoleCoversLocator(page, page.getByRole("button", { name: "More", exact: true }), "標籤站的挖洞要蓋住 ⋮");
    await expect(tourCard(page)).toContainText('"Add tag" in this ⋮ menu');

    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Link to another note");

    // The [[ demo scrolls the editor to the last paragraph; coming back must bring the icon into view again.
    await tourCard(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Tags");
    await tourCard(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Knowledge info");
    const viewport = page.viewportSize()!;
    await expect
      .poll(
        async () => {
          const box = await icon.boundingBox();
          return box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
        },
        { message: "回到知識資訊站時圖示要在畫面內" },
      )
      .toBe(true);
    await expectHoleCoversLocator(page, icon, "回到知識資訊站時挖洞要蓋住圖示");
    await page.keyboard.press("Escape");
    await expect(tourCard(page)).toHaveCount(0);
    const tags = await page.request.get("/api/tags");
    expect(tags.status(), await tags.text()).toBe(200);
    expect(await tags.json()).toEqual([]);
  });

  test("no stop is titled as a version's new feature: after the / stop comes the user menu stop", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    const { total } = await readProgress(page);
    expect(total).toBe(WIDE_TARGETS.length);
    const slashStop = WIDE_TARGETS.findIndex((ids) => ids.includes("slashMenu")) + 1;
    await goToStop(page, slashStop, total);
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(tourCard(page).getByText(`${slashStop + 1} / ${total}`, { exact: true })).toBeVisible();
    expect(WIDE_TARGETS[slashStop]).toEqual(["userMenu"]);
    await expect(cardTitle(page)).not.toHaveText(/^New in v/);
    await expect.poll(async () => {
      const [hole, target] = [await holeBox(page), await targetsBox(page, ["userMenu"])];
      try {
        expectHoleMatches(hole, target);
        return true;
      } catch {
        return false;
      }
    }).toBe(true);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
  });

  // 768 wide is the floating sidebar layout (640-1279, the sidebar is a drawer); phones narrower than 640 have no drawer and no sidebar button, see the phone case below.
  test("floating sidebar (768): Help and the drawer close first, sidebar stops point at the sidebar button, and focus ends on it", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await page.setViewportSize({ width: 768, height: 844 });
    const drawerButton = page.getByRole("button", { name: "Open sidebar", exact: true });
    await drawerButton.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: USER_NAME, exact: true }).click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    await expect(help.getByRole("region", { name: "Feature tour" })).toBeVisible();
    await help.getByRole("button", { name: "Start tour", exact: true }).click();
    await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
    await expect(help).toHaveCount(0);

    // Stops 5 (Share and more) and 8 (Tags) point at the header kebab, stop 6 (Version history) at the version bubble at bottom right (present from 640 up), stop 7 at the knowledge icon,
    // stops 9 and 10 at the real [[ and / menus in the editor; the rest point at the sidebar button that opens the sidebar. The drawer never appears again for the whole run.
    const more = page.getByRole("button", { name: "More", exact: true });
    const NOTE_STOPS: Record<number, [string, Locator]> = {
      5: ["More", more],
      6: ["the versions bubble", page.locator('[data-kb-tour-target="versions"]:visible').first()],
      7: ["the knowledge icon", page.locator('[data-kb-tour-target="knowledgeIcon"]:visible').first()],
      8: ["More", more],
      9: ["the [[ menu", page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first()],
      10: ["the / menu", page.locator('[data-kb-tour-target="slashMenu"]:visible').first()],
    };
    await walkToLastStop(page, async (n) => {
      await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
      const [label, target] = NOTE_STOPS[n] ?? ["Open sidebar", drawerButton];
      await expectHoleCoversLocator(page, target, `第 ${n} 站的挖洞要蓋住 ${label}`);
      // The menu fills the whole narrow screen and the card overlaps it; the tour layer is above the menu, so the card's title and Next must be topmost (not covered by the menu).
      if (n === 10) await expectCardContentOnTop(page);
    });
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, drawerButton);
  });

  test("phone (390): Help from the avatar sheet opens at its list; Start tour closes both sheets; list stops highlight the real tab row, buttons and avatar, note stops run on the sample note, and the tour ends on the list with focus on the avatar", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    // With an AI action: a phone has no floating format toolbar, so the AI stop is skipped without taking a number (a wide viewport counts it).
    await stubAiActions(page, "some");
    await page.setViewportSize({ width: 390, height: 844 });
    await signUpFreshUser(browser, page);
    await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toHaveCount(0);
    const avatar = phoneAvatar(page);
    await avatar.click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    await expect(help.getByRole("button", { name: "Feature tour", exact: true })).toBeVisible();
    await expect(help.getByRole("region", { name: "Feature tour" })).toBeHidden();
    await help.getByRole("button", { name: "Feature tour", exact: true }).click();
    await expect(help.getByRole("region", { name: "Feature tour" })).toBeVisible();
    await help.getByRole("button", { name: "Start tour", exact: true }).click();
    await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
    await expect(help).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expectCardContentOnTop(page);

    const total = await walkPhoneTour(page);
    expect(total).toBe(PHONE_STOPS.length);

    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, avatar);
    const avatarOnTop = await avatar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && el.contains(top);
    });
    expect(avatarOnTop).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    const notes = (await (await page.request.get("/api/notes")).json()) as { title: string }[];
    expect(notes.filter((n) => n.title === SAMPLE_TITLE)).toHaveLength(1);
    await page.locator("aside").getByText(SAMPLE_TITLE, { exact: true }).first().click();
    await expect(page).toHaveURL(SAMPLE_URL);
    await expect(editorLocator(page)).toBeVisible();
    await expect(editorLocator(page)).not.toHaveAttribute("inputmode");
  });

  test("phone (390): started on a note, the tour goes to the list first; Back from the first note stop returns to the list; Esc on a note stop ends on the list with focus on the avatar", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signUpFreshUser(browser, page);
    await createNote(page, `E2E phone tour from note ${Date.now()}`);
    // The note screen has no avatar: open Help with Ctrl+/ (a phone with a hardware keyboard), which also starts on the item list.
    await page.keyboard.press("ControlOrMeta+/");
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    await help.getByRole("button", { name: "Feature tour", exact: true }).click();
    await help.getByRole("button", { name: "Start tour", exact: true }).click();
    await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await expect.poll(() => originPath(page)).toBe("/");
    await expectHoleCoversLocator(page, page.locator('[data-kb-tour-target="tabs"]:visible').first(), "第 1 站在清單上指 tab 列");

    await goToTitle(page, "Share and more");
    await expect(page).toHaveURL(SAMPLE_URL);
    await tourCard(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Search");
    await expect.poll(() => originPath(page)).toBe("/");
    await expectHoleCoversLocator(page, page.locator('[data-kb-tour-target="phoneSearch"]:visible').first(), "往回走：清單左下的搜尋鈕");
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Share and more");
    await expect(page).toHaveURL(SAMPLE_URL);

    // Live stops don't bring up the on-screen keyboard: at the [[ stop the editor is inputmode="none", and going back to the tags stop removes it (it didn't have this attribute originally).
    await goToTitle(page, "Link to another note");
    await expect(editorLocator(page)).toHaveAttribute("inputmode", "none");
    await tourCard(page).getByRole("button", { name: "Back", exact: true }).click();
    await expect(cardTitle(page)).toHaveText("Tags");
    await expect(editorLocator(page)).not.toHaveAttribute("inputmode");

    await page.keyboard.press("Escape");
    await expect(tourCard(page)).toHaveCount(0);
    await expect.poll(() => originPath(page)).toBe("/");
    await expect(phoneAvatar(page)).toBeFocused();
  });

  test("phone (390): the browser's Back on a list stop ends the tour and stays in the app, even though the page before is the list too", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signUpFreshUser(browser, page);
    await openTourOnPhone(page);
    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await expect.poll(() => originPath(page)).toBe("/");
    await page.goBack();
    await expect(tourCard(page)).toHaveCount(0);
    await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
    await expect.poll(() => originPath(page)).toBe("/");
    await expect(phoneAvatar(page)).toBeVisible();
  });

  test("phone (320): the card stays inside the screen and clear of the top bar, the note header and the round buttons", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 320, height: 568 });
    await signUpFreshUser(browser, page);
    await openTourOnPhone(page);
    const total = await walkPhoneTour(page);
    expect(total).toBe(PHONE_STOPS.length);
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expect(phoneAvatar(page)).toBeFocused();
  });

  test("crossing 1280 and 640 in the middle of a stop moves the cut-out to that layout's target", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1280, height: 844 });
    await signUpFreshUser(browser, page);
    await openTour(page, USER_NAME);
    const tabs = page.locator('[data-kb-tour-target="tabs"]:visible').first();
    const drawerButton = page.getByRole("button", { name: "Open sidebar", exact: true });
    const bubble = page.locator('[data-kb-tour-target="versions"]:visible').first();
    const more = page.getByRole("button", { name: "More", exact: true });
    const body = tourCard(page).locator("p").first();

    await expect(tourCard(page).getByText(/^1 \/ \d+$/)).toBeVisible();
    await expectHoleCoversLocator(page, tabs, "1280：第 1 站指側欄的 tab 列");
    await page.setViewportSize({ width: 1279, height: 844 });
    await expectHoleCoversLocator(page, drawerButton, "1279：第 1 站改指側欄鈕");
    await expect(body).toContainText("Open the sidebar from here");
    await page.setViewportSize({ width: 640, height: 844 });
    await expectHoleCoversLocator(page, drawerButton, "640：仍指側欄鈕");
    await page.setViewportSize({ width: 639, height: 844 });
    await expect.poll(() => originPath(page), { message: "639：第 1 站回到清單畫面" }).toBe("/");
    await expectHoleCoversLocator(page, tabs, "639：指清單畫面的 tab 列");
    await expect(cardTitle(page)).toHaveText("Lists of notes");
    await expect(body).toContainText("This row of icons");
    await page.setViewportSize({ width: 640, height: 844 });
    await expect(page, "640：回到示範筆記").toHaveURL(SAMPLE_URL);
    await expectHoleCoversLocator(page, drawerButton, "640：回到側欄鈕");
    await expect(cardTitle(page)).toHaveText("Sidebar sections");
    await page.setViewportSize({ width: 1280, height: 844 });
    await expectHoleCoversLocator(page, tabs, "1280：回到 tab 列");
    await expect(body).not.toContainText("sidebar from here");

    await page.setViewportSize({ width: 640, height: 844 });
    const { total } = await readProgress(page);
    await goToTitle(page, "Version history");
    await expectHoleCoversLocator(page, bubble, "640：版本站指泡泡");
    await page.setViewportSize({ width: 639, height: 844 });
    await expectHoleCoversLocator(page, more, "639：版本站改指 ⋮");
    await expect(body).toContainText('"Version history" in the ⋮ menu');
    await page.setViewportSize({ width: 640, height: 844 });
    await expectHoleCoversLocator(page, bubble, "640：版本站回到泡泡");
    expect((await readProgress(page)).total).toBe(total);

    await page.keyboard.press("Escape");
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, drawerButton);
  });

  test("phone (390): What's new opens from the Help list and the back chevron returns to the list", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signUpFreshUser(browser, page);
    await phoneAvatar(page).click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    const whatsNew = help.getByRole("button", { name: "What's new", exact: true });
    await expect(whatsNew).toBeVisible();
    const content = help.locator('[data-help-page-content="whatsNew"]');
    await expect(content).toBeHidden();
    await whatsNew.click();
    await expect(content).toBeVisible();
    await expect(whatsNew).toBeHidden();
    await help.getByRole("button", { name: "Back to sections", exact: true }).click();
    await expect(whatsNew).toBeVisible();
    await expect(content).toBeHidden();
    await expect(help).toBeVisible();
  });
});
