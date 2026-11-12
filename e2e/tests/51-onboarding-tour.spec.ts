import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  loginAs,
  noteIdFromUrl,
  openTour,
  randomEmail,
  showSidebarTab,
  toastWithTitle,
  tourCard,
} from "./helpers.js";

/**
 * 功能導覽（第一部分：從說明視窗手動打開、靜態站、示範筆記）。
 *
 * - 入口只有一個：使用者選單「Help」（或 Ctrl+/）→ 說明視窗的「Feature tour」頁 →「Start tour」。導覽不會自己出現。
 * - 每支 test 一個全新帳號：每次開始導覽都會在 My notes 新建一篇 "Welcome to Knotebook"，帳號不共用才數得準。
 * - 示範筆記的內容只比 `GET /api/notes/:id/content` 的 `markdown` 欄位：回應的 `lastEdited` 在寫入後幾秒內會變。
 * - 筆記頁整頁載入（reload／goto）後先等 "Note title" 標題框，再碰側欄（NotePage 掛上前的 fallback 自帶一份側欄）。
 * - 只有 Chromium 驗過。
 */

const SAMPLE_TITLE = "Welcome to Knotebook";
const USER_NAME = "Tour User";

/** 站點對應的目標元件（`data-kb-tour-target`），寬視窗；順序同導覽的站序。 */
const WIDE_TARGETS: readonly (readonly string[])[] = [
  ["tabs"],
  ["newNote"],
  ["newFolder"],
  ["search"],
  ["share", "noteMenu"],
  ["versions"],
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

/** admin 邀請一個新帳號，再讓 `page` 用它登入（落在首頁 `/`）。 */
async function signUpFreshUser(browser: Browser, page: Page): Promise<void> {
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
}

const userMenuTrigger = (page: Page): Locator => page.getByRole("button", { name: USER_NAME, exact: true });

/** 側欄切到 My notes，回傳其中的示範筆記列（供 `toHaveCount`）。 */
async function sampleNotesInMyNotes(page: Page): Promise<Locator> {
  const panel = await showSidebarTab(page, "My notes");
  return panel.getByText(SAMPLE_TITLE, { exact: true });
}

/** 說明卡上的 "n / N"。 */
async function readProgress(page: Page): Promise<{ n: number; total: number }> {
  const label = tourCard(page).getByText(/^\d+ \/ \d+$/);
  await expect(label).toBeVisible();
  const [n, total] = ((await label.textContent()) ?? "").split("/").map((s) => Number(s.trim()));
  return { n: n!, total: total! };
}

/** 目前站的說明卡標題。 */
const cardTitle = (page: Page): Locator => tourCard(page).getByRole("heading", { level: 2 });

/** 逐站按 Next 走到最後一站（不按最後一站的鈕）；每一站呼叫 `onStep(n, total)`。 */
async function walkToLastStop(page: Page, onStep?: (n: number, total: number) => Promise<void>): Promise<number> {
  const { total } = await readProgress(page);
  for (let n = 1; n <= total; n++) {
    await expect(tourCard(page).getByText(`${n} / ${total}`, { exact: true })).toBeVisible();
    await onStep?.(n, total);
    if (n < total) await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
  }
  return total;
}

/** 從目前這一站按 Next 走到第 `stop` 站；每按一次前先等目前這一站的 "n / N" 出現（換站中按 Next 會被忽略）。 */
async function goToStop(page: Page, stop: number, total: number): Promise<void> {
  const { n: from } = await readProgress(page);
  for (let n = from; n < stop; n++) {
    await expect(tourCard(page).getByText(`${n} / ${total}`, { exact: true })).toBeVisible();
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
  }
  await expect(tourCard(page).getByText(`${stop} / ${total}`, { exact: true })).toBeVisible();
}

/** 讀挖洞矩形（svg 與視窗同大、左上角在原點，屬性值就是視窗座標）。 */
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

/** 目標元件（看得見的第一個）的聯集矩形。 */
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
 * 挖洞比目標往外擴的距離，對應產品 `apps/web/src/components/tour/geometry.ts` 的 `HOLE_PADDING`
 * （e2e 不能 import web 的碼，那邊改值時要一起改這裡）。
 */
const HOLE_PADDING = 6;
/** 量測誤差與圓角造成的容差（px）。 */
const HOLE_TOLERANCE = 8;

/** 挖洞要蓋住目標（容差 `HOLE_TOLERANCE`）。 */
function expectHoleCovers(hole: Box, target: Box): void {
  const tol = HOLE_TOLERANCE;
  expect(hole.x).toBeLessThanOrEqual(target.x + tol);
  expect(hole.y).toBeLessThanOrEqual(target.y + tol);
  expect(hole.x + hole.width).toBeGreaterThanOrEqual(target.x + target.width - tol);
  expect(hole.y + hole.height).toBeGreaterThanOrEqual(target.y + target.height - tol);
}

/** 挖洞蓋住目標，而且沒有大出一圈邊框以外的範圍（寬視窗：目標聯集加上邊框就是挖洞）。 */
function expectHoleMatches(hole: Box, target: Box): void {
  expectHoleCovers(hole, target);
  const slack = HOLE_PADDING + HOLE_TOLERANCE;
  expect(hole.x).toBeGreaterThanOrEqual(target.x - slack);
  expect(hole.y).toBeGreaterThanOrEqual(target.y - slack);
  expect(hole.x + hole.width).toBeLessThanOrEqual(target.x + target.width + slack);
  expect(hole.y + hole.height).toBeLessThanOrEqual(target.y + target.height + slack);
}

/** 沒有筆記頁被刪時的離場提示（NotePage 在開著的筆記被刪時顯示的那句）。 */
async function expectNoDeletedNotice(page: Page): Promise<void> {
  await expect(page.getByText("This note has been deleted.")).toHaveCount(0);
}

const originPath = (page: Page): string => new URL(page.url()).pathname;

/**
 * 導覽結束後回到起點，而且焦點在 `focus`。
 *
 * 網址變回去的當下，畫面可能還是導覽那一頁的舊側欄（裡面有同名的觸發鈕，`toBeFocused` 會誤中），
 * 所以先等只有目的頁才成立的狀態：回首頁＝沒有筆記標題框；回既有筆記＝標題框的值是那篇的標題。
 */
async function expectBackAtStart(page: Page, start: { path: string; noteTitle?: string }, focus: Locator): Promise<void> {
  const titleBox = page.getByRole("textbox", { name: "Note title" });
  if (start.noteTitle === undefined) await expect(titleBox).toHaveCount(0);
  else await expect(titleBox).toHaveValue(start.noteTitle);
  await expect.poll(() => originPath(page)).toBe(start.path);
  await expect(focus).toBeFocused();
}

/**
 * 示範筆記的去處：`kept` 篇還在清單裡，垃圾桶裡一篇都沒有。
 * 「沒被移走」是負向斷言，要先等刪除請求有時間落地（移垃圾桶和還焦點是並行的，呼叫端的焦點斷言過了，請求也已經送出），
 * 再用 API 與畫面各確認一次。`waitForLoadState("networkidle")` 在單頁應用裡早已達成、立刻返回，不能用。
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

test.describe("feature tour (manual start)", () => {
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
      // 說明視窗開始前就關了；導覽接手之後焦點在說明卡內，不會被稍晚還焦點的說明視窗拉走。
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
    expect(before).toContain(noteId); // 站內連結指向自己

    // 冒煙：重新打開的編輯器撤銷堆疊是空的，所以這裡本來就撤不到；「寫入不進撤銷」由單元測試守。
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

    // 示範內容寫入後 server 端要有，才拿得到比對的基準。基準在走到演示站之前取，開選單本身有沒有寫入才算得進去。
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

    // 點選單項目沒有作用：選單還在、還在同一站、內容不變。固定等一秒是負向斷言要的：沒有事件可等。
    await menu.locator(".bn-suggestion-menu-item").first().click();
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

    // 上一站剛關的 [[ 選單可能還在 DOM 裡多留一下，所以只認 / 選單自己的目標屬性。
    const menu = page.locator('[data-kb-tour-target="slashMenu"]:visible').first();
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Heading 1", { exact: true })).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // 挖洞同時蓋住選單與筆記裡的流程圖。
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

    // 打字、方向鍵、點選單項目都沒有作用：選單還在、還在同一站、內容不變。固定等一秒是負向斷言要的：沒有事件可等。
    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowDown");
    await menu.locator(".bn-suggestion-menu-item").first().click();
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
    // 不替使用者清掉搜尋字
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
      // 站 2（New note）起要在 My notes
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

      // 這段靠「移垃圾桶」toast 的存活時間（約 5 秒）：到點 Undo 之前別再加慢的斷言。
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
    // token 請求永遠不回：編輯器一直不會變可編輯
    const hang = () => {
      /* 不 fulfill、不 continue */
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

  test("narrow window: Help and the drawer close first, sidebar stops point at the menu button, and focus ends on it", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    await page.setViewportSize({ width: 390, height: 844 });
    const drawerButton = page.getByRole("button", { name: "Open navigation", exact: true });
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

    // 站 5（Share and more）指頁首的 ⋮，站 6（Version history）也在 ⋮ 裡，站 7、8 指編輯器裡真的 [[ 與 / 選單；
    // 其餘指開側欄的漢堡鈕。抽屜整輪都不再出現。
    const label = (n: number): string => (n === 5 || n === 6 ? "More" : n === 7 ? "the [[ menu" : n === 8 ? "the / menu" : "Open navigation");
    await walkToLastStop(page, async (n) => {
      await expect(page.locator("[data-sidebar-drawer]")).toHaveCount(0);
      const target =
        n === 5 || n === 6
          ? page.getByRole("button", { name: "More", exact: true })
          : n === 7
            ? page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first()
            : n === 8
              ? page.locator('[data-kb-tour-target="slashMenu"]:visible').first()
              : drawerButton;
      await expect.poll(async () => {
        const [hole, box] = [await holeBox(page), await target.boundingBox()];
        if (box === null) return false;
        try {
          expectHoleCovers(hole, box);
          return true;
        } catch {
          return false;
        }
      }, { message: `第 ${n} 站的挖洞要蓋住 ${label(n)}` }).toBe(true);
    });
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, drawerButton);
  });
});
