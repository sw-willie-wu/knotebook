import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * #93：側欄搜尋的合併結果列表（真瀏覽器；標題命中與內文命中一個列表，**每處內文命中各一項**、三行：標題／資料夾路徑／片段）。
 * 點該項 → 開筆記、捲到該段落範圍內**第一個含查詢字的 block**、捲到畫面**中間**並高亮（閃的是那個 block，不是段落標題）。E1 寬螢幕從首頁 Ctrl+K 搜、點片段；
 * E1b 巢狀標題（片段的段落標題是 `#` Top，但閃的是 `##` Sub 底下含字的那一行）；E2 同篇只捲動、不重載、上一頁回得去；E3／E4 窄螢幕抽屜
 * （別篇／同篇）點片段都關抽屜；E5 版面（共用捲動容器）與「載入更多」；E6 別篇、命中在長段落深處；E9 一篇多處命中列多項、點第 2 項跳到第 2 處
 * 並落在視窗中段；E10 block 比視窗高時對準它自己那一行；E11 常駐標記（恆亮、Esc 與清空搜尋字取消）。
 *
 * - e2e package 不 import `@knotebook/shared`，網址自組（同 27-site-links 檔頭）。
 * - 每個 test 用自己的新使用者：search 桶每人每分 60 次，與 UI 共用；ADMIN 只發邀請。
 * - 筆記一律以 `POST /api/notes` 帶 markdown 建（帶內容才扣 edit 桶 30／分）；索引有延遲，先輪詢 `GET /api/search` 等到命中再打字。
 * - 整頁載入筆記頁後先等「Note title」標題框再碰側欄（lazy NotePage 的 fallback 自帶一份 AppShell，會換殼）；點擊導覽後 `waitForURL`
 *   之後再等新頁專屬的狀態（標題框的值、高亮浮層），不只等網址。
 */

const PASSWORD = "e2e-fulltext-pw";
type Created = { id: string; title: string; slug: string; ownerHandle: string };
type SearchHit = { note: { id: string }; matches: Array<{ sectionId: string; heading: string }> };

async function asNewUser(page: Page, displayName: string): Promise<void> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
}

async function createNoteViaApi(page: Page, title: string, content?: string): Promise<Created> {
  const res = await page.request.post("/api/notes", { data: content === undefined ? { title } : { title, content } });
  expect(res.status(), `POST /api/notes → ${res.status()} ${await res.text()}`).toBe(201);
  return (await res.json()) as Created;
}
const pathOf = (n: Created) => `/n/${n.ownerHandle}/${n.slug}`;

/** 等索引追上：`match=body` 的結果裡這篇有命中、回它第一個 match 的段落。 */
async function waitIndexed(page: Page, q: string, noteId: string): Promise<{ sectionId: string; heading: string }> {
  let found: { sectionId: string; heading: string } | null = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${encodeURIComponent(q)}&match=body`);
        if (res.status() !== 200) return null;
        const hit = ((await res.json()) as { hits: SearchHit[] }).hits.find((h) => h.note.id === noteId);
        found = hit?.matches[0] ?? null;
        return found?.sectionId ?? null;
      },
      { intervals: [500, 1000], timeout: 20_000 },
    )
    .not.toBeNull();
  return found!;
}

/** 段落錨點的高亮浮層（抄 27-site-links 的 expectAnchorFlash 主幹）：出現、蓋在該區塊上、在可編輯 DOM 之外。 */
async function expectAnchorFlash(page: Page, blockId: string): Promise<void> {
  const overlay = page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`);
  await expect(overlay).toBeAttached({ timeout: 15_000 });
  const geo = await overlay.evaluate((el, id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    return { dTop: Math.abs(o.top - block.top), dHeight: Math.abs(o.height - block.height), inEditable: el.closest('[contenteditable="true"], .ProseMirror') !== null };
  }, blockId);
  expect(geo.inEditable).toBe(false);
  expect(geo.dTop).toBeLessThanOrEqual(1);
  expect(geo.dHeight).toBeLessThanOrEqual(1);
}

const block = (page: Page, id: string) => page.locator(`.bn-block-outer[data-id="${id}"]`);
/**
 * 搜尋跳轉捲到畫面中間：判定＝block 中心點落在視窗高度的 25%–75%。命中處下方要有足夠內容才捲得到中間（測試資料各自保證）。
 * 用 poll：捲動後版面可能還在穩定。
 */
async function expectBlockCentered(page: Page, id: string): Promise<void> {
  const ratio = () =>
    block(page, id).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (r.top + r.height / 2) / window.innerHeight;
    });
  await expect
    .poll(async () => {
      const r = await ratio();
      return r >= 0.25 && r <= 0.75;
    }, { timeout: 10_000, message: `block ${id} 的中心點應在視窗高度的 25%–75%` })
    .toBe(true);
}
/** 頁面上「自己的文字含 kw」的最內層 block 的 id（等它出現）。命中 block 的 id 由 DOM 讀，不靠 server（server 只記到段落）。 */
async function matchBlockId(page: Page, kw: string): Promise<string> {
  const handle = await page.waitForFunction(
    (k) => {
      const hit = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")).find((o) =>
        (o.querySelector(":scope > .bn-block > .bn-block-content")?.textContent ?? "").includes(k),
      );
      return hit?.getAttribute("data-id") ?? null;
    },
    kw,
    { timeout: 15_000 },
  );
  return (await handle.jsonValue()) as string;
}
const titleBox = (page: Page) => page.getByRole("textbox", { name: "Note title" });
const bodyRegion = (scope: Page | Locator) => scope.getByRole("region", { name: "Search results" });
/** 內文區裡某篇的第一個片段連結。 */
function snippetOf(scope: Page | Locator, href: string): Locator {
  return bodyRegion(scope).locator(`a[href="${href}"]`);
}
function filler(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} filler ${i + 1}`).join("\n\n");
}

test("E1＋E2：寬螢幕從首頁 Ctrl+K 搜 → 點片段捲到 Gamma 並高亮；同篇再點只捲動、不重載、上一頁回得去", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E1");
  const stamp = Date.now();
  const kw = `kw${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 20)}\n\n## Beta\n\n${filler("beta", 20)}\n\n## Gamma\n\nthe ${kw} lives here\n\n${filler("gamma", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft A ${stamp}`, md);
  const hit = await waitIndexed(page, kw, a.id);
  expect(hit.heading).toBe("Gamma");
  const gammaId = hit.sectionId;

  // E1：首頁、Ctrl+K
  await page.goto("/");
  const search = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
  // Ctrl+K 的監聽掛在 AppShell；登入檢查的 Loading 結束、搜尋框可見後才按，否則按鍵沒人接。
  await expect(search).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();
  await search.fill(kw);
  const snippet = snippetOf(page.getByRole("complementary"), `${pathOf(a)}#b-${gammaId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await expect(snippet.locator("mark")).toHaveText(kw);
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kw);
  expect(hitId, "閃的是含字的 block，不是段落標題").not.toBe(gammaId);
  await expectAnchorFlash(page, hitId);
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${gammaId}"]`)).toHaveCount(0);
  await expect(block(page, hitId)).toBeInViewport();
  await expectBlockCentered(page, hitId);

  // 同篇——先回到沒有 hash 的網址（頁首），再從側欄點同一個片段
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expect(block(page, hitId)).not.toBeInViewport();
  await page.evaluate(() => {
    (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
  });
  const search2 = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
  await search2.fill(kw);
  const same = snippetOf(page.getByRole("complementary"), `${pathOf(a)}#b-${gammaId}`);
  await expect(same).toBeVisible({ timeout: 15_000 });
  await same.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 10_000 });
  await expect(block(page, hitId)).toBeInViewport({ timeout: 5_000 });
  await expectAnchorFlash(page, hitId);
  expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
  await page.goBack();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === "", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
});

test("E1b 巢狀標題：# Top 底下都是 ##——片段的段落標題是 Top，但點了閃的是 ## Sub 底下含字的那一行", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E1b");
  const stamp = Date.now();
  const kx = `kx${stamp}`;
  const md = `# Top\n\n${filler("top", 10)}\n\n## Sub\n\n${filler("sub", 20)}\n\nwhere ${kx} is\n`;
  const c = await createNoteViaApi(page, `E2E ft C ${stamp}`, md);
  const hit = await waitIndexed(page, kx, c.id);
  expect(hit.heading).toBe("Top");
  const topId = hit.sectionId;

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kx);
  const snippet = snippetOf(sidebar, `${pathOf(c)}#b-${topId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  // 每處命中一項、三行（標題／路徑／片段）；段落標題（Top）不顯示。
  await expect(snippet.locator(":scope > div")).toHaveCount(3);
  await expect(snippet.locator(":scope > div").nth(1)).toContainText("My notes");
  await expect(snippet.locator(":scope > div").nth(2)).toContainText(kx);
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(c) && u.hash === `#b-${topId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(c.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kx);
  expect(hitId).not.toBe(topId);
  await expectAnchorFlash(page, hitId);
  await expect(block(page, hitId)).toContainText(kx);
  await expect(block(page, hitId)).toBeInViewport();
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${topId}"]`)).toHaveCount(0);
});

test("E3＋E4 窄螢幕抽屜：別篇與同篇的片段點了都關抽屜、捲到含字的 block", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await asNewUser(page, "E2E Fulltext E3");
  const stamp = Date.now();
  const kw = `kn${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 20)}\n\n## Beta\n\n${filler("beta", 20)}\n\n## Gamma\n\nthe ${kw} lives here\n\n${filler("gamma", 10)}\n`;
  const a = await createNoteViaApi(page, `E2E ft A ${stamp}`, md);
  const b = await createNoteViaApi(page, `E2E ft B ${stamp}`);
  const gammaId = (await waitIndexed(page, kw, a.id)).sectionId;
  const href = `${pathOf(a)}#b-${gammaId}`;

  async function searchInDrawer(): Promise<Locator> {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await drawer.getByRole("textbox", { name: "Search notes" }).fill(kw);
    const s = snippetOf(drawer, href);
    await expect(s).toBeVisible({ timeout: 15_000 });
    return s;
  }

  // E3：開著無關的 B，點 A 的片段
  await page.goto(pathOf(b));
  await expect(titleBox(page)).toHaveValue(b.title, { timeout: 15_000 });
  await (await searchInDrawer()).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kw);
  expect(hitId).not.toBe(gammaId);
  await expect(block(page, hitId)).toBeInViewport({ timeout: 15_000 });
  await expectAnchorFlash(page, hitId);

  // 在 A 頁面（頁首），點 A 自己的片段——pathname 不變，抽屜照樣關
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expect(block(page, hitId)).not.toBeInViewport();
  await (await searchInDrawer()).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
  await expect(block(page, hitId)).toBeInViewport({ timeout: 15_000 });
  await expectAnchorFlash(page, hitId);
});

test("E5 版面與載入更多：22 篇標題命中在上；捲到底：22＋20 列＋載入更多 → 44 列、鈕消失；點最後一篇的片段導過去", async ({ page }) => {
  test.setTimeout(180_000);
  await asNewUser(page, "E2E Fulltext E5");
  const stamp = Date.now();
  const ky = `ky${stamp}`;
  for (let i = 0; i < 22; i += 1) await createNoteViaApi(page, `E2E ft title ${ky} ${String(i).padStart(2, "0")}`);
  const bodies: Created[] = [];
  for (let i = 0; i < 22; i += 1) bodies.push(await createNoteViaApi(page, `E2E ft body ${stamp} ${String(i).padStart(2, "0")}`, `has ${ky} inside ${i}\n`));
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${ky}&limit=50&match=body`);
        return res.status() === 200 ? ((await res.json()) as { hits: SearchHit[] }).hits.length : -1;
      },
      { intervals: [500, 1000], timeout: 30_000 },
    )
    .toBe(22);

  // 建完一定要重載：內文區與 ["notes"] 清單交叉比對，頁面若在建筆記前就載過清單，新筆記會被濾掉。
  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(ky);
  const results = sidebar.getByTestId("sidebar-search");
  const region = bodyRegion(sidebar);
  const hits = region.getByTestId("search-hit");
  // 合併列表：22 篇標題命中在前，加第一頁 20 篇只中內文的；項數是列出的（已載入）項數。
  await expect(results.getByRole("status")).toHaveText("42 results loaded, more available", { timeout: 15_000 });
  await expect(hits).toHaveCount(42, { timeout: 15_000 });
  // 整個列表一個捲動容器：捲到底，「載入更多」看得到、按得到。
  await region.evaluate((el) => el.closest(".overflow-y-auto")!.scrollTo({ top: 1e6 }));
  const more = region.getByRole("button", { name: "Load more" });
  await expect(more).toBeInViewport();
  await more.click();
  await expect(hits).toHaveCount(44, { timeout: 15_000 });
  await expect(results.getByRole("status")).toHaveText("44 results");
  await expect(more).toHaveCount(0);
  const last = hits.last().getByTestId("body-match");
  await last.scrollIntoViewIfNeeded();
  const href = await last.getAttribute("href");
  expect(href).not.toBeNull();
  const lastNote = bodies.find((n) => href!.startsWith(pathOf(n)));
  expect(lastNote, `片段 href ${href} 對得到某篇內文筆記`).toBeDefined();
  await last.click();
  await page.waitForURL((u) => u.pathname === pathOf(lastNote!), { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(lastNote!.title, { timeout: 15_000 });
});

test("E6 別篇、命中在長段落深處：點片段 → 含字的 block 進視窗並閃、段落標題不閃", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E6");
  const stamp = Date.now();
  const kz = `kz${stamp}`;
  const md = `## Long\n\n${filler("long", 60)}\n\ndeep inside ${kz} here\n\n${filler("tail", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft L ${stamp}`, md);
  const b = await createNoteViaApi(page, `E2E ft M ${stamp}`);
  const hit = await waitIndexed(page, kz, a.id);
  expect(hit.heading).toBe("Long");

  // 別篇：開著 B，從側欄點 A 的片段（navigate＋state，不帶查詢字進網址）
  await page.goto(pathOf(b));
  await expect(titleBox(page)).toHaveValue(b.title, { timeout: 15_000 });
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kz);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${hit.sectionId}`, { timeout: 15_000 });
  expect(page.url()).not.toContain(kz);
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kz);
  expect(hitId).not.toBe(hit.sectionId);
  await expectAnchorFlash(page, hitId);
  await expect(block(page, hitId)).toBeInViewport();
  await expect(block(page, hit.sectionId)).not.toBeInViewport();
  await expectBlockCentered(page, hitId);
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${hit.sectionId}"]`)).toHaveCount(0);

  // 重新整理：navigation state 留在 history entry 裡 → 與 `#b-` 一樣會再跳一次（known-limitations 的句子以此為準）
  await page.reload();
  await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expectAnchorFlash(page, hitId);
});

test("E7 表格格子：命中回表格那顆 block 並閃（格子是 <td><p>，沒有 .bn-inline-content）", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E7");
  const stamp = Date.now();
  const kt = `kt${stamp}`;
  const md = `## Sec

${filler("sec", 20)}

| col a | col b |
| --- | --- |
| plain | ${kt} |

${filler("mid", 20)}
`;
  const a = await createNoteViaApi(page, `E2E ft T ${stamp}`, md);
  const hit = await waitIndexed(page, kt, a.id);
  const idOfType = async (type: string) =>
    page.locator(`.bn-block-outer:has(> .bn-block > .bn-block-content[data-content-type="${type}"])`).first().getAttribute("data-id");

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kt);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const tableId = await idOfType("table");
  expect(tableId).not.toBeNull();
  await expectAnchorFlash(page, tableId!);
  await expect(block(page, tableId!)).toBeInViewport();
});

test("E8 命中在收合的 toggle 子項：閃的是 toggle 那顆（子項被藏起來），而且在視窗內", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E8");
  const stamp = Date.now();
  const kg = `kg${stamp}`;
  const a = await createNoteViaApi(page, `E2E ft G ${stamp}`, `## Sec

${filler("sec", 25)}

last paragraph
`);
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  // 在最後一段後面用 UI 打一個 toggle 加一個子項（"> " 輸入規則）
  await page.getByText("last paragraph").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/toggle list");
  await page.keyboard.press("Enter");
  await page.keyboard.type("toggle parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(`child ${kg}`);
  const hit = await waitIndexed(page, kg, a.id);

  await page.goto("/");
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  // 父 toggle（輸入子項時它展開）：按它的箭頭收合，子項被藏起來。
  const parent = page.locator(".bn-block-outer:has(> .bn-block > .bn-block-content .bn-toggle-wrapper)").first();
  const toggleId = await parent.getAttribute("data-id");
  expect(toggleId).not.toBeNull();
  await parent.locator("> .bn-block > .bn-block-content .bn-toggle-button").click();
  await expect(parent.locator('> .bn-block > .bn-block-content .bn-toggle-wrapper')).toHaveAttribute("data-show-children", "false");
  await expect(page.locator(".bn-block-outer", { hasText: `child ${kg}` }).last()).toBeHidden();
  await page.evaluate(() => document.querySelector(".overflow-y-auto")?.scrollTo({ top: 0 }));

  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kg);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expectAnchorFlash(page, toggleId!);
  await expect(block(page, toggleId!)).toBeInViewport();
  await expect(page.locator(".bn-block-outer", { hasText: `child ${kg}` }).last()).toBeHidden();
});

test("E9 一篇多處命中列多項：三處命中三項（各三行）；點第 2 項 → 跳到第 2 處命中的 block、落在視窗中段；一般 #b- 連結仍捲到最上面", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E9");
  const stamp = Date.now();
  const km = `km${stamp}`;
  // 三個段落各一處命中；每處上面、下面都有 ≥ 25 個段落，才捲得到畫面中間。
  const sec = (n: number) => `## Sec ${n}

${filler(`s${n}a`, 25)}

the ${km} hit ${n}

${filler(`s${n}b`, 25)}
`;
  const md = `${sec(1)}
${sec(2)}
${sec(3)}`;
  const a = await createNoteViaApi(page, `E2E ft M9 ${stamp}`, md);
  let sections: string[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${encodeURIComponent(km)}&match=body`);
        if (res.status() !== 200) return 0;
        const h = ((await res.json()) as { hits: SearchHit[] }).hits.find((x) => x.note.id === a.id);
        sections = h?.matches.map((m) => m.sectionId) ?? [];
        return sections.length;
      },
      { intervals: [500, 1000], timeout: 20_000 },
    )
    .toBe(3);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(km);
  const items = bodyRegion(sidebar).getByTestId("body-match");
  await expect(items).toHaveCount(3, { timeout: 15_000 });
  await expect(bodyRegion(sidebar).getByTestId("search-hit")).toHaveCount(3);
  await expect(sidebar.getByTestId("sidebar-search").getByRole("status")).toHaveText("3 results");
  for (let i = 0; i < 3; i += 1) {
    const item = items.nth(i);
    await expect(item).toHaveAttribute("href", `${pathOf(a)}#b-${sections[i]}`);
    await expect(item.locator(":scope > div")).toHaveCount(3);
    await expect(item.locator(":scope > div").nth(0)).toHaveText(a.title);
    await expect(item.locator(":scope > div").nth(1)).toContainText("My notes");
    await expect(item.locator(":scope > div").nth(2)).toContainText(`hit ${i + 1}`);
    await expect(item).not.toContainText(`Sec ${i + 1}`); // 段落標題不顯示
  }

  // 點第 2 項：跳到第 2 處命中的 block（不是第 1 處、也不是標題），並落在視窗中段
  await items.nth(1).click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${sections[1]}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const secondId = await matchBlockId(page, `${km} hit 2`);
  expect(secondId).not.toBe(sections[1]);
  await expectAnchorFlash(page, secondId);
  await expect(block(page, secondId)).toContainText(`hit 2`);
  await expectBlockCentered(page, secondId);

  // 對照：沒有 kbFind 的一般 #b- 連結（複製出去的段落連結）仍把標題捲到最上面（落在視窗上段，不在中間）
  await page.goto("/"); // 先離開：同一頁只差 hash 的 goto 是同文件導覽，不會重新載入、也不會再捲
  await page.goto(`${pathOf(a)}#b-${sections[1]}`);
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expectAnchorFlash(page, sections[1]!);
  await expect
    .poll(async () => block(page, sections[1]!).evaluate((el) => el.getBoundingClientRect().top / window.innerHeight), { timeout: 10_000 })
    .toBeLessThan(0.25);
});

test("E10 block 比視窗高（清單父項包著很多子項）：置中對準父項自己那一行，命中那一行在視窗內且在中段", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E10");
  const stamp = Date.now();
  const kq = `kq${stamp}`;
  const children = Array.from({ length: 60 }, (_, i) => `  - child ${i + 1} text`).join(String.fromCharCode(10));
  const md = `## Sec

${filler("pre", 25)}

- parent ${kq} line
${children}

${filler("post", 25)}
`;
  const a = await createNoteViaApi(page, `E2E ft P10 ${stamp}`, md);
  const hit = await waitIndexed(page, kq, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kq);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const parentId = await matchBlockId(page, kq);
  await expectAnchorFlash(page, parentId);
  // 前提：整個父項 block（連子項）比視窗高，否則這案測不到東西
  const outerHeight = await block(page, parentId).evaluate((el) => el.getBoundingClientRect().height);
  expect(outerHeight, "父項 block 要比視窗高").toBeGreaterThan(page.viewportSize()!.height);
  // 命中的那一行（父項自己的 content）在視窗內、在中段
  const line = block(page, parentId).locator(":scope > .bn-block > .bn-block-content");
  await expect(line).toContainText(kq);
  await expect(line).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () =>
      line.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const c = (r.top + r.height / 2) / window.innerHeight;
        return c >= 0.25 && c <= 0.75;
      }), { timeout: 10_000, message: "命中那一行的中心應在視窗高度的 25%–75%" })
    .toBe(true);
});

test("E11 常駐標記：閃兩下後恆亮（3 s 後還在）→ Esc 消失；再跳一次 → 清空搜尋字後消失", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E11");
  const stamp = Date.now();
  const kk = `kk${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft K ${stamp}`, md);
  const hit = await waitIndexed(page, kk, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kk);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kk);
  await expectAnchorFlash(page, hitId);
  const mark = page.locator(`.kn-anchor-flash.kn-anchor-mark[data-anchor-flash="${hitId}"]`);
  await expect(mark).toBeAttached();

  // 恆亮：等過閃爍時間（2 s）再多一秒，標記還在、還對在那個 block 上、底色是亮的（不是動畫結束後的透明）
  await page.waitForTimeout(3_000);
  await expect(mark).toBeAttached();
  await expectAnchorFlash(page, hitId);
  expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  // 首頁進來的第一次跳轉換了殼（首頁 AppShell → 筆記頁 AppShell），搜尋字不重設（#369：query 住在 App 層）
  await expect(sidebar.getByRole("textbox", { name: "Search notes" })).toHaveValue(kk);

  // 焦點在編輯器裡按 Esc（真的 BlockNote：OverrideEscape 先 blur、再 preventDefault）：一下就消失，不用按兩次（#369）
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("Escape");
  await expect(mark).toHaveCount(0);

  // 再跳一次（搜尋結果還開著、搜尋字還在）→ 清空搜尋字後消失
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(mark).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(2_500);
  await expect(mark).toBeAttached();
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(mark).toHaveCount(0);
});


for (const motion of ["no-preference", "reduce"] as const) {
  test(`E11b 標記明顯閃兩下（prefers-reduced-motion: ${motion}）：動畫期間取樣底色，至少兩次「淡→亮」，最後停在亮、且與恆亮同一個強度`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: motion });
    await asNewUser(page, `E2E Fulltext E11b ${motion}`);
    const stamp = Date.now();
    const kk = `kb${stamp}`;
    const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
    const a = await createNoteViaApi(page, `E2E ft KB ${stamp}`, md);
    const hit = await waitIndexed(page, kk, a.id);

    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kk);
    const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
    await expect(snippet).toBeVisible({ timeout: 15_000 });
    // 點之前裝好取樣器（每 30 ms 讀一次浮層的 computed 底色 alpha 與 class）；浮層出現前記 null
    await page.evaluate(() => {
      // computed 值可能是 oklab()／oklch()／rgba()／transparent
      const alphaOf = (c: string): number => {
        if (c === "transparent") return 0;
        const m = /\/\s*([\d.]+)\s*\)/.exec(c);
        return m ? Number(m[1]) : 1;
      };
      const log: Array<{ t: number; a: number | null; mark: boolean }> = [];
      (window as unknown as { __markLog: typeof log }).__markLog = log;
      const t0 = performance.now();
      setInterval(() => {
        const o = document.querySelector<HTMLElement>(".kn-anchor-flash");
        log.push({ t: Math.round(performance.now() - t0), a: o ? alphaOf(getComputedStyle(o).backgroundColor) : null, mark: o?.classList.contains("kn-anchor-mark") ?? false });
      }, 30);
    });
    await snippet.click();
    await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
    await page.waitForTimeout(4_000);
    const log = await page.evaluate(() => (window as unknown as { __markLog: Array<{ t: number; a: number | null; mark: boolean }> }).__markLog);

    // 動畫是在 mark class 之後才開始的（等捲動穩定）：只取 mark=true 之後的樣本
    const firstMark = log.findIndex((s) => s.mark);
    expect(firstMark, "應該出現過 .kn-anchor-mark").toBeGreaterThanOrEqual(0);
    const seq = log.slice(firstMark).map((s) => s.a ?? 0);
    const DARK = 0.12;
    const LIGHT = 0.3;
    let rises = 0;
    let dark = false;
    for (const v of seq) {
      if (v < DARK) dark = true;
      else if (v > LIGHT && dark) {
        rises++;
        dark = false;
      }
    }
    expect(rises, `應該有至少兩次 淡→亮（取樣：${seq.map((v) => v.toFixed(2)).join(" ")}）`).toBeGreaterThanOrEqual(2);
    // 最後停在亮，且是目標強度（brand 38%）
    const last = seq.at(-1)!;
    expect(last).toBeGreaterThan(0.33);
    expect(last).toBeLessThan(0.43);
    // 閃的總長大約 1.2–1.6 s：第一個 mark 樣本到最後一次變化之間
    const settledAt = log.slice(firstMark).findIndex((_, i, arr) => arr.slice(i).every((s) => Math.abs((s.a ?? 0) - last) < 0.005));
    const dur = log[firstMark + settledAt]!.t - log[firstMark]!.t;
    expect(dur).toBeGreaterThan(1_100);
    expect(dur).toBeLessThan(2_000);
  });
}

test("E11c 首頁搜尋 → 點結果（換殼）→ 在筆記頁清空搜尋字 → 標記消失；搜尋字在換殼後還在", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E11c");
  const stamp = Date.now();
  const kk = `kc${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft KC ${stamp}`, md);
  const hit = await waitIndexed(page, kk, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kk);
  await snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`).click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kk);
  const mark = page.locator(`.kn-anchor-flash.kn-anchor-mark[data-anchor-flash="${hitId}"]`);
  await expect(mark).toBeAttached({ timeout: 15_000 });
  await expect(search).toHaveValue(kk);
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(mark).toHaveCount(0);
});
