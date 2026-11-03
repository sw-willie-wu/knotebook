import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * #93 PR2：側欄搜尋的合併結果列表（真瀏覽器；標題命中與內文命中一個列表、一篇一列，每列第一個片段）。點片段 → 開筆記、捲到該段落範圍內
 * **第一個含查詢字的 block** 並高亮（閃的是那個 block，不是段落標題；2026-11-03 Willie 回饋）。E1 寬螢幕從首頁 Ctrl+K 搜、點片段；
 * E1b 巢狀標題（片段的段落標題是 `#` Top，但閃的是 `##` Sub 底下含字的那一行）；E2 同篇只捲動、不重載、上一頁回得去；E3／E4 窄螢幕抽屜
 * （別篇／同篇）點片段都關抽屜；E5 版面（共用捲動容器）與「載入更多」；E6 別篇、命中在長段落深處。
 *
 * - e2e package 不 import `@knotebook/shared`，網址自組（同 27-site-links 檔頭）。
 * - 每個 test 用自己的新使用者：search 桶每人每分 60 次，與 UI 共用（plan gate M12）；ADMIN 只發邀請。
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
  const md = `## Alpha\n\n${filler("alpha", 20)}\n\n## Beta\n\n${filler("beta", 20)}\n\n## Gamma\n\nthe ${kw} lives here\n\n${filler("gamma", 10)}\n`;
  const a = await createNoteViaApi(page, `E2E ft A ${stamp}`, md);
  const hit = await waitIndexed(page, kw, a.id);
  expect(hit.heading).toBe("Gamma");
  const gammaId = hit.sectionId;

  // E1：首頁、Ctrl+K
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
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

  // E2：同篇——先回到沒有 hash 的網址（頁首），再從側欄點同一個片段
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
  await expect(snippet.locator("div").first()).toHaveText("Top");
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
    await page.getByRole("button", { name: "Open navigation" }).click();
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

  // E4：在 A 頁面（頁首），點 A 自己的片段——pathname 不變，抽屜照樣關
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
  // 合併列表：22 篇標題命中在前，加第一頁 20 篇只中內文的；篇數是合併後的（已載入）篇數。
  await expect(results.getByRole("status")).toHaveText("42 notes loaded, more available", { timeout: 15_000 });
  await expect(hits).toHaveCount(42, { timeout: 15_000 });
  // 整個列表一個捲動容器：捲到底，「載入更多」看得到、按得到。
  await region.evaluate((el) => el.closest(".overflow-y-auto")!.scrollTo({ top: 1e6 }));
  const more = region.getByRole("button", { name: "Load more" });
  await expect(more).toBeInViewport();
  await more.click();
  await expect(hits).toHaveCount(44, { timeout: 15_000 });
  await expect(results.getByRole("status")).toHaveText("44 notes found");
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
