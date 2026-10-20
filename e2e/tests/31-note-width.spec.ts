import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * #297 內文欄三段寬度（真瀏覽器量測）：
 * - E1 站內：頁首寬度選單切標準／寬／全寬，多個視窗寬下欄寬＝`expected()`（spec §3 的 clamp 公式，代入實量的 W）；重整後仍記得。
 * - E2 頁首（Review Focus 5）：768 px × {預設側欄, 320 px 側欄} × {en, zh-TW} 頁首不被裁、寬度鈕隱藏；
 *   寬度鈕恰在頁首 content box ≥ 696 px（`@min-[43.5rem]`）時出現，門檻兩側各量一格，⋮ 都不被裁。
 * - E3 公開頁（spec §8 e2e）：owner 在分享對話框設全寬 → 匿名讀者的欄寬＝W、超過標準上限 1056。
 *
 * W＝欄的父層（捲動容器，無 padding）的 clientWidth：max-width 的百分比以它解析；以實量 W 對公式，捲軸只改變 W、不影響判定。
 * 每次量測印一行 `MEASURE …`。
 */

const RUN_ID = Date.now();

/** spec §3：標準 clamp(42.5rem,85%,66rem)、寬 clamp(42.5rem,92.5%,88rem)、全寬不設上限；再被 w-full 夾在 W 以內。 */
const CLAMP = { standard: { ratio: 0.85, cap: 1056 }, wide: { ratio: 0.925, cap: 1408 } } as const;
type Mode = "standard" | "wide" | "full";
function expected(mode: Mode, W: number): number {
  if (mode === "full") return W;
  const { ratio, cap } = CLAMP[mode];
  return Math.min(W, Math.min(cap, Math.max(680, ratio * W)));
}

const MENU_LABEL: Record<Mode, string> = { standard: "Standard", wide: "Wide", full: "Full width" };
/** 頁首寬度鈕的門檻：header content box ≥ 43.5rem。 */
const HEADER_EDGE = 696;

async function measureColumn(page: Page): Promise<{ col: number; W: number }> {
  return page.getByTestId("article-column").evaluate((el) => ({
    col: el.getBoundingClientRect().width,
    W: el.parentElement!.clientWidth,
  }));
}

async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function loginAndCreateNote(page: Page, title: string, email: string = ADMIN.email, password: string = ADMIN.password): Promise<void> {
  await loginAs(page, email, password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("Width measurement paragraph.");
}

test("E1 站內三段寬度：欄寬照公式、選了就換、重整仍記得", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAndCreateNote(page, `E2E note width E1 ${RUN_ID}`);
  await setViewport(page, 1920, 1000);
  const button = page.getByRole("button", { name: /^Width/ });
  await expect(button).toHaveAttribute("aria-label", "Width: Standard");

  const seenW: number[] = [];
  for (const mode of ["standard", "wide", "full"] as const) {
    await setViewport(page, 1920, 1000);
    await button.click();
    await page.getByRole("menuitemradio", { name: MENU_LABEL[mode], exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-label", `Width: ${MENU_LABEL[mode]}`);
    for (const vw of [1920, 1440, 1200, 1000, 900]) {
      await setViewport(page, vw, 1000);
      const { col, W } = await measureColumn(page);
      const want = expected(mode, W);
      seenW.push(W);
      console.log(`MEASURE E1 mode=${mode} vw=${vw} W=${W} col=${col.toFixed(2)} expected=${want.toFixed(2)}`);
      expect(Math.abs(col - want), `E1 ${mode} vw=${vw} W=${W}`).toBeLessThanOrEqual(1);
    }
  }
  // 視窗清單要涵蓋兩端：W ≥ 1523（三段都到各自上限／全寬）與 W < 680（三段都＝W）。
  expect(Math.max(...seenW)).toBeGreaterThanOrEqual(1523);
  expect(Math.min(...seenW)).toBeLessThan(680);

  await setViewport(page, 1920, 1000);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Width/ })).toHaveAttribute("aria-label", "Width: Full width");
  const after = await measureColumn(page);
  console.log(`MEASURE E1 reload vw=1920 W=${after.W} col=${after.col.toFixed(2)}`);
  expect(Math.abs(after.col - after.W)).toBeLessThanOrEqual(1);
});

type HeaderMeasure = { contentW: number; clientW: number; scrollW: number; right: number; moreRight: number; visible: boolean };

async function measureHeader(header: Locator, widthButton: Locator, more: Locator): Promise<HeaderMeasure> {
  const box = await header.evaluate((h) => {
    const cs = getComputedStyle(h);
    const r = h.getBoundingClientRect();
    const inline = (a: string, b: string) => parseFloat(a) + parseFloat(b);
    return {
      contentW: r.width - inline(cs.paddingLeft, cs.paddingRight) - inline(cs.borderLeftWidth, cs.borderRightWidth),
      clientW: h.clientWidth,
      scrollW: h.scrollWidth,
      right: r.right,
    };
  });
  const moreBox = (await more.boundingBox())!;
  return { ...box, moreRight: moreBox.x + moreBox.width, visible: await widthButton.isVisible() };
}

test("E2 頁首不裁切：768 × 兩種側欄 × 中英文；寬度鈕恰在 content box ≥ 696 時出現", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAndCreateNote(page, `E2E note width E2 ${RUN_ID}`);
  // 等「最後編輯」出現，讓頁首最擠。
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("last-edited")).toBeVisible();
  }).toPass({ timeout: 20_000 });

  for (const lang of ["en", "zh-TW"] as const) {
    for (const sidebar of [null, 320] as const) {
      await setViewport(page, 1280, 900);
      await page.evaluate(
        ([l, s]) => {
          if (l === "en") window.localStorage.removeItem("knotebook:lang");
          else window.localStorage.setItem("knotebook:lang", l);
          if (s === null) window.localStorage.removeItem("sidebar.width");
          else window.localStorage.setItem("sidebar.width", String(s));
        },
        [lang, sidebar] as const,
      );
      await page.reload();
      const widthName = lang === "en" ? /^Width/ : /^寬度/;
      const moreName = lang === "en" ? "More" : "更多";
      const header = page.locator("header").filter({ has: page.getByRole("button", { name: widthName, includeHidden: true }) });
      const widthButton = header.getByRole("button", { name: widthName, includeHidden: true });
      const more = header.getByRole("button", { name: moreName, exact: true });
      await expect(more).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("last-edited")).toBeVisible();
      const tag = `lang=${lang} sidebar=${sidebar ?? "default"}`;

      const check = async (vw: number): Promise<HeaderMeasure> => {
        await setViewport(page, vw, 900);
        const m = await measureHeader(header, widthButton, more);
        console.log(
          `MEASURE E2 ${tag} vw=${vw} contentW=${m.contentW} clientW=${m.clientW} scrollW=${m.scrollW} ` +
            `headerRight=${m.right.toFixed(2)} moreRight=${m.moreRight.toFixed(2)} widthButton=${m.visible ? "visible" : "hidden"}`,
        );
        expect(m.scrollW, `${tag} vw=${vw}：頁首有橫向溢出`).toBeLessThanOrEqual(m.clientW);
        expect(m.moreRight, `${tag} vw=${vw}：⋮ 超出頁首右緣`).toBeLessThanOrEqual(m.right + 0.5);
        expect(m.visible, `${tag} vw=${vw} contentW=${m.contentW}`).toBe(m.contentW >= HEADER_EDGE);
        return m;
      };

      const narrow = await check(768);
      expect(narrow.visible, `${tag}：768 時寬度鈕要隱藏`).toBe(false);
      const wide = await check(1200);
      expect(wide.visible, `${tag}: width button must be visible at 1200`).toBe(true);

      // 邊界：在 (768, 1200] 二分找最小可見 vw，兩側各量一格（check 內已斷言不裁切、可見性與 contentW 一致）。
      let lo = 768;
      let hi = 1200;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        await setViewport(page, mid, 900);
        if (await widthButton.isVisible()) hi = mid;
        else lo = mid;
      }
      const edge = await check(hi);
      const below = await check(hi - 1);
      const predicted = 1200 - (wide.contentW - HEADER_EDGE);
      console.log(`MEASURE E2 ${tag} edgeVw=${hi} predictedVw=${predicted} contentW@edge=${edge.contentW} contentW@edge-1=${below.contentW}`);
      expect(edge.visible).toBe(true);
      expect(below.visible).toBe(false);
      expect(edge.contentW).toBeGreaterThanOrEqual(HEADER_EDGE);
      expect(edge.contentW).toBeLessThan(HEADER_EDGE + 1);
      if (Number.isInteger(wide.contentW)) expect(hi).toBe(predicted);
    }
  }
});

test("E3 公開頁：分享對話框設全寬 → 匿名讀者看到 W 寬的欄，站內寬度不受影響", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  try {
    const owner = await ownerContext.newPage();
    // 用新註冊的帳號當 owner：public-link 的 PUT/DELETE 每人 10 次/10 分鐘（PUBLIC_LINK_LIMIT），
    // 整套序跑到這裡時 admin 已被 11／16／18／22／27 用滿，再開公開連結會吃 429。
    const email = randomEmail();
    const password = "e2e-note-width-pw";
    expect((await request.post("/api/auth/register", { data: { email, password } })).status()).toBe(201);
    await loginAndCreateNote(owner, `E2E note width E3 ${RUN_ID}`, email, password);

    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = owner.getByRole("dialog", { name: "Share note" });
    await expect(dialog).toBeVisible();
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    const publish = owner.waitForResponse((res) => res.url().endsWith("/public-link") && res.request().method() === "PUT");
    await publicRadio.check();
    expect((await publish).status()).toBe(200);
    const tokenInput = dialog.getByLabel("Public link URL");
    await expect(tokenInput).toBeVisible();
    const token = await tokenInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const widthSelect = dialog.getByLabel("Public page width");
    await expect(widthSelect).toHaveValue("standard");

    const anon = await anonContext.newPage();
    // 內容 flush 是非同步的（collab 2 s debounce）：重載到看見內文為止。
    await expect(async () => {
      await anon.goto(`/p/${token}`);
      await expect(anon.getByText("Width measurement paragraph.")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const before = await measureColumn(anon);
    console.log(`MEASURE E3 public=standard vw=1600 W=${before.W} col=${before.col.toFixed(2)} expected=${expected("standard", before.W).toFixed(2)}`);
    expect(Math.abs(before.col - expected("standard", before.W))).toBeLessThanOrEqual(1);

    const put = owner.waitForResponse((res) => res.url().endsWith("/public-width") && res.request().method() === "PUT");
    await widthSelect.selectOption("full");
    expect((await put).status()).toBe(200);
    await expect(widthSelect).toHaveValue("full");

    await anon.reload();
    await expect(anon.getByText("Width measurement paragraph.")).toBeVisible({ timeout: 15_000 });
    const after = await measureColumn(anon);
    console.log(`MEASURE E3 public=full vw=1600 W=${after.W} col=${after.col.toFixed(2)}`);
    expect(Math.abs(after.col - after.W)).toBeLessThanOrEqual(1);
    expect(after.col).toBeGreaterThan(1056 + 1);

    // 站內寬度是 owner 自己這台瀏覽器的偏好，不跟著公開頁走。
    await owner.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(owner.getByRole("button", { name: /^Width/ })).toHaveAttribute("aria-label", "Width: Standard");
  } finally {
    await anonContext.close();
    await ownerContext.close();
  }
});
