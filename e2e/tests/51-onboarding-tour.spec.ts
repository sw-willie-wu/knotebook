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
 * 功能導覽（第一部分：從說明視窗手動打開、靜態站、示範筆記）。
 *
 * - 入口只有一個：使用者選單「Help」（或 Ctrl+/）→ 說明視窗的「Feature tour」頁 →「Start tour」。導覽不會自己出現。
 * - 每支 test 一個全新帳號：每次開始導覽都會在 My notes 新建一篇 "Welcome to Knotebook"，帳號不共用才數得準。
 * - 示範筆記的內容只比 `GET /api/notes/:id/content` 的 `markdown` 欄位：回應的 `lastEdited` 在寫入後幾秒內會變。
 * - 筆記頁整頁載入（reload／goto）後先等 "Note title" 標題框，再碰側欄（NotePage 掛上前的 fallback 自帶一份側欄）。
 * - 只有 Chromium 驗過。
 */

/** 英文字串包（說明視窗 What's new 頁用的）；條目標題從這裡讀，不寫死這一版有哪些功能。 */
const WHATS_NEW_STRINGS = JSON.parse(
  readFileSync(new URL("../../apps/web/src/i18n/shortcuts.en.json", import.meta.url), "utf8"),
) as { helpGuide: { whatsNew: { heading: string; empty: string; items: Record<string, { title: string }> } } };

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

interface Account {
  email: string;
  password: string;
}

/** admin 邀請一個新帳號，再讓 `page` 用它登入（落在首頁 `/`）；回傳帳號，供另開 context 登入同一個人。 */
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

/** 站台有一個可用的 AI 動作時 `GET /api/ai/actions` 的回應（導覽的 AI 站與格式工具列上的 AI 鈕都讀這份）。 */
const AI_ACTIONS_NONEMPTY = {
  actions: [{ id: "improve", name: "Improve writing", applyMode: "direct", kind: "quick" }],
};

/** 讓這一頁看到的 AI 動作清單固定（疊上別的測試可能設過 AI，不固定的話站數會飄）。 */
async function stubAiActions(page: Page, actions: "none" | "some"): Promise<void> {
  await page.route("**/api/ai/actions", (route) => route.fulfill({ json: actions === "some" ? AI_ACTIONS_NONEMPTY : { actions: [] } }));
}

/** 目前網址那篇筆記內容的 `markdown` 欄位（`lastEdited` 在寫入後幾秒內會變，不比整個回應）。 */
function markdownReader(page: Page, noteId: string): () => Promise<string> {
  return async () => {
    const res = await page.request.get(`/api/notes/${noteId}/content`);
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { markdown: string }).markdown;
  };
}

/** 開始導覽，等示範內容寫進 server，回傳筆記 id、讀內容的函式與走演示站之前的內容。 */
async function startTourOnSample(page: Page): Promise<{ noteId: string; read: () => Promise<string>; before: string }> {
  await openTour(page, USER_NAME);
  const noteId = await noteIdFromUrl(page);
  const read = markdownReader(page, noteId);
  await expect.poll(read, { timeout: 15_000 }).toContain("What a note can hold");
  return { noteId, read, before: await read() };
}

/** 按 Next 走到說明卡標題等於 `title` 的那一站；每按一次前先等目前這一站穩定。 */
async function goToTitle(page: Page, title: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const current = (await cardTitle(page).textContent()) ?? "";
    if (current === title) return;
    await tourCard(page).getByRole("button", { name: "Next", exact: true }).click();
    await expect(cardTitle(page)).not.toHaveText(current);
  }
  throw new Error(`走不到標題是「${title}」的那一站`);
}

/** 兩個矩形相交的面積（px²）。 */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 說明卡不蓋住 `target`（演示站要讓人讀得到選單）。 */
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

/** 說明卡的標題、說明、〔Next〕在中心點都是最上層（沒有被別的浮層蓋住）。 */
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

/** 目前的 DOM 選取：是否收合、選到的文字。 */
async function domSelection(page: Page): Promise<{ collapsed: boolean; text: string }> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    return { collapsed: sel?.isCollapsed ?? true, text: sel?.toString() ?? "" };
  });
}

/** 在編輯器裡用輸入法組一個注音字再送出（CDP），模擬注音／拼音輸入法在游標處或選取範圍上輸入。 */
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

/** 挖洞要蓋住 `target`（導覽剛換站或工具列剛掛上時位置還在算，所以輪詢）。 */
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

test.describe("feature tour (manual start)", () => {
  // 疊上別的測試可能設過 AI 動作（導覽會多出 AI 站）。預設固定成沒有 AI；要 AI 的案例自己再 `stubAiActions(page, "some")`，後註冊的路由優先。
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
    // 導覽遮罩蓋在選單上面，真的點下去落在遮罩；另外直接對項目送 click，確認遮罩以外的備援攔截也擋得住。
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
    // 導覽遮罩蓋在選單上面，真的點下去落在遮罩；另外直接對項目送 click，確認遮罩以外的備援攔截也擋得住。
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

  test("on the [[ stop typing, arrow keys and Enter do not write: Enter moves on, Esc closes, and the note stays as it was", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signUpFreshUser(browser, page);
    const { read, before } = await startTourOnSample(page);
    const { total } = await readProgress(page);
    await goToTitle(page, "Link to another note");
    const menu = page.locator('[data-kb-tour-target="wikilinkMenu"]:visible').first();
    await expect(menu).toBeVisible();

    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(1_000); // 負向斷言：沒有事件可等
    await expect(menu).toBeVisible();
    await expect(cardTitle(page)).toHaveText("Link to another note");
    expect(await read()).toBe(before);
    expect(await read()).not.toContain("abc");

    // Enter 是「下一步」，不是選單的確認。
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
    await page.waitForTimeout(1_500); // 負向斷言：沒有事件可等
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
    // 站序：AI 站夾在 [[ 站與 / 站之間。
    expect((await readProgress(page)).n).toBe(WIDE_TARGETS.findIndex((ids) => ids[0] === "wikilinkMenu") + 2);

    const aiButton = aiToolbarButton(page);
    await expect(aiButton).toBeVisible();
    await expectHoleCoversLocator(page, aiButton, "AI 站的挖洞要蓋住工具列上的 AI 鈕");
    await expect.poll(() => domSelection(page)).toEqual({ collapsed: false, text: "Select this sentence to try AI." });

    // 注音組字、點 AI 鈕都不會改內容或開 AI 框；框起來的那句還在。
    await composeWithIme(page);
    await aiButton.dispatchEvent("click");
    await page.waitForTimeout(1_000); // 負向斷言：沒有事件可等
    await expect(selectionAiBox(page)).toHaveCount(0);
    expect(await read()).toBe(before);
    expect(await read()).toContain("Select this sentence to try AI.");
    await expect(editorLocator(page)).not.toContainText("八");
    await expect(editorLocator(page)).toContainText("Select this sentence to try AI.");
    expect(await domSelection(page)).toEqual({ collapsed: false, text: "Select this sentence to try AI." });

    // 離站後那句不再反白。下一站（/）會自己把游標放進最後的空段落，所以這裡看的是結果；離站收合本身由單元測試守。
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
        await page.waitForTimeout(3_000); // 自動存版等待壓成 1 秒
        expect(await versionCount()).toBeLessThanOrEqual(1);

        await page.reload();
        await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(SAMPLE_TITLE);
        await expect(tourCard(page)).toHaveCount(0);
        await expect(page.locator("[data-tour-overlay]")).toHaveCount(0);
        await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);
        await page.waitForTimeout(3_000);
        expect(await read()).toBe(before);
        // 版本只有寫入示範內容的那一次（機器忙時它可能晚到 reload 之後才存）：等到剛好 1，再確認演示和重新整理都沒另外多存。
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

  test("the tour has no stop for this version's new features: after the / stop comes the user menu stop", async ({ page, browser }) => {
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
      // 選單撐滿整個窄畫面，卡片會疊在選單上；導覽層在選單之上，所以卡片的標題與〔Next〕要在最上層（不被選單蓋住）。
      if (n === 8) await expectCardContentOnTop(page);
    });
    await tourCard(page).getByRole("button", { name: "Keep sample note", exact: true }).click();
    await expect(tourCard(page)).toHaveCount(0);
    await expectBackAtStart(page, { path: "/" }, drawerButton);
  });
});
