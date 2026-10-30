import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * #293 PR-1（spec §14.1 A1–A6、A8）：頁首「也在這篇的人」頭像列。
 * A（擁有者）寫 40 段 → B（檢視者）進來 → A 看到 B（唯讀者沒有游標）、B 看到 A（外框色＝遠端游標色、點頭像捲到游標）
 * → B 多開一分頁仍一顆 → B 的兩支 PAT 各讀一次，A 看到兩顆 AI（不與 B 合併）→ 390 寬 +N 與完整名單 → 鍵盤 → B 關掉後 35 s 內消失。
 *
 * 唯讀者沒有游標（讀碼發現 10）：此檔「B 的頭像是 no cursor」即守衛；紅了代表 viewer 也送了 cursor，不得改斷言。
 * 被刪位置點頭像會捲到相鄰（spec §9.4），所以這裡只對「沒有游標」的頭像斷言不捲。
 */

const RUN = Date.now();

function scrollerOf(page: Page): Locator {
  return page.getByTestId("article-column").locator("..");
}

const scrollTopOf = (page: Page) => scrollerOf(page).evaluate((el) => el.scrollTop);

async function waitConnectedOnNote(page: Page, title: string): Promise<void> {
  // viewer 的標題是 h1（memory knotebook-notepage-fallback-appshell-swap：等標題再碰側欄／頁首）
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
}

test("頁首頭像列：A 看 B（無游標）、B 看 A（外框色、點了捲到游標）、多分頁一顆、兩支 AI、窄螢幕完整名單、鍵盤、關掉後消失", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);

  let ctxA: BrowserContext | undefined;
  let ctxB: BrowserContext | undefined;
  let anonymous: BrowserContext | undefined;
  try {
    ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    ctxB = await browser.newContext({ viewport: { width: 1280, height: 600 } });
    anonymous = await browser.newContext();
    // ── 建場：A 建筆記、打 40 段 ───────────────────────────────────────
    const pageA = await ctxA.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    const title = `E2E presence ${RUN}`;
    await createNote(pageA, title);
    const noteUrl = pageA.url();
    const noteId = await noteIdFromUrl(pageA);
    const me = (await (await pageA.request.get("/api/auth/me")).json()) as { displayName: string };

    await editorLocator(pageA).click();
    for (let i = 0; i < 40; i++) {
      await pageA.keyboard.insertText(i === 39 ? `Last line ${RUN}` : `Line ${i} ${RUN}`);
      if (i < 39) await pageA.keyboard.press("Enter");
    }
    await expect(editorLocator(pageA)).toContainText(`Last line ${RUN}`);

    // ── B（檢視者）──────────────────────────────────────────────────
    const bEmail = randomEmail();
    const bPassword = "e2e-presence-viewer-pw";
    await createUserViaInvite(pageA, { email: bEmail, password: bPassword, displayName: "E2E Viewer" });
    const shared = await pageA.request.put(`/api/notes/${noteId}/shares`, { data: { email: bEmail, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    const pageB = await ctxB.newPage();
    await loginAs(pageB, bEmail, bPassword);
    await pageB.goto(noteUrl);
    await waitConnectedOnNote(pageB, title);
    // 唯讀者沒有游標的守衛要有鑑別力：B 真的點進內文（y-prosemirror 只在 view.hasFocus() 時才送 cursor）。
    // 點前段，B 視窗內，不會捲動。
    await pageB.getByTestId("note-editor").getByText(`Line 2 ${RUN}`).click();

    // ── A1／A3：A 看 B ──────────────────────────────────────────────
    const rowA = pageA.getByRole("group", { name: "Also viewing this note" });
    const bAvatar = rowA.getByRole("button", { name: "E2E Viewer, Viewer, no cursor right now" });
    await expect(bAvatar).toBeVisible({ timeout: 15_000 });
    await expect(rowA.getByRole("button", { name: new RegExp("^" + reEscape(me.displayName) + ",") })).toHaveCount(0);

    await bAvatar.hover();
    const tip = pageA.getByRole("tooltip");
    await expect(tip).toContainText("E2E Viewer · Viewer");
    await expect(tip).toContainText("No cursor right now");
    // 負向斷言的觀察窗：B 若（錯誤地）送了 cursor，要等 awareness 傳到 A 並渲染；至少 300 ms 後再斷一次。
    await pageA.waitForTimeout(300);
    await expect(bAvatar).toBeVisible();

    const scrollBefore = await scrollTopOf(pageA);
    await bAvatar.click();
    expect(await scrollTopOf(pageA)).toBe(scrollBefore);

    // ── A1／A4：B 看 A ──────────────────────────────────────────────
    // 之後到第 5 步之前 A 不再碰別的元素，保住焦點＝游標。
    await editorLocator(pageA).getByText(`Last line ${RUN}`).click();
    // 游標落在行尾，B 端該段文字不被 A 的遠端游標 widget 切開。
    await pageA.keyboard.press("End");
    // 後面不打字，但 A 送出的游標位置（awareness）讀的是 PM 的 state.selection：等它讀回 End，B 端的游標一開始就在行尾、不在斷言途中移位。
    await waitForEditorSelection(pageA);

    const rowB = pageB.getByRole("group", { name: "Also viewing this note" });
    const aBtn = rowB.getByRole("button", {
      name: new RegExp("^" + reEscape(me.displayName) + ", Owner, go to their cursor$"),
    });
    await expect(aBtn).toBeVisible({ timeout: 10_000 });

    const caret = pageB.locator(".bn-collaboration-cursor__caret").first();
    await expect(caret).toBeAttached();
    const caretBg = await caret.evaluate((el) => getComputedStyle(el).backgroundColor);
    const shadow = await aBtn.locator("span[aria-hidden]").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain(caretBg);

    expect(await scrollTopOf(pageB)).toBe(0);
    await expect(caret).not.toBeInViewport();
    await aBtn.click();
    await expect.poll(() => scrollTopOf(pageB)).toBeGreaterThan(0);
    await expect(caret).toBeInViewport();

    // ── A2：同一人多分頁只有一顆 ───────────────────────────────────
    const bAnyAvatar = rowA.getByRole("button", { name: /^E2E Viewer, Viewer,/ });
    const pageB2 = await ctxB.newPage();
    await pageB2.goto(noteUrl);
    await waitConnectedOnNote(pageB2, title);
    // 負向性質需要時間窗：合併失敗時，第二顆要等 pageB2 的 awareness 傳到 A 並渲染才會出現（A 端沒有可觀察的「已收到」訊號）。
    await pageA.waitForTimeout(1_500);
    await expect(bAnyAvatar).toHaveCount(1);
    await pageB2.close();
    await pageA.waitForTimeout(1_500);
    await expect(bAnyAvatar).toHaveCount(1);

    // ── A6：兩支 AI（不與 B 合併）──────────────────────────────────
    const bMe = (await (await pageB.request.get("/api/auth/me")).json()) as { handle: string };
    const labels: string[] = [];
    for (const n of ["ai1", "ai2"]) {
      const name = `e2e-${n}-${RUN % 1_000_000}`;
      const created = await pageB.request.post("/api/auth/tokens", { data: { name, scope: "notes:read", expiresInDays: 30 } });
      expect(created.status(), await created.text()).toBe(201);
      const { token } = (await created.json()) as { token: string };
      const read = await anonymous.request.get(`${baseURL}/api/notes/${noteId}/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status()).toBe(200);
      labels.push(name); // 全小寫無空白 → agent 標籤＝名稱本身（同 13）
    }
    const agentBtn = (label: string) =>
      rowA.getByRole("button", { name: `${bMe.handle} (${label}), AI agent, go to its cursor` });
    await expect(agentBtn(labels[0]!)).toBeVisible({ timeout: 15_000 });
    await expect(agentBtn(labels[1]!)).toBeVisible({ timeout: 15_000 });
    const agentRing = await agentBtn(labels[0]!).locator("span[aria-hidden]").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(agentRing).toContain("rgb(124, 58, 237)"); // AGENT_PRESENCE_COLOR #7c3aed
    await agentBtn(labels[0]!).hover();
    await expect(pageA.getByRole("tooltip")).toContainText(`${bMe.handle} (${labels[0]}) · AI agent`);
    await expect(bAnyAvatar).toHaveCount(1);

    // ── A5：窄螢幕 +N 與完整名單（A 看到 3 位）──────────────────────
    // ai1 的 Tooltip 還開著；縮窄後該頭像被藏，先把滑鼠移走讓 Tooltip 關掉，免得蓋住 +N。
    // 不用 hover()（可能動到 A 的捲動，後面 Enter 捲動需要 scrollTop > 0）。Radix hoverable Tooltip 離開 trigger 只建 grace area，
    // 要等「之後」的 pointermove 落在區外才關（react-tooltip dist/index.mjs:268-291），所以送兩段 move，慢機器重試。
    const sb = (await scrollerOf(pageA).boundingBox())!;
    const cx = sb.x + sb.width / 2;
    const cy = sb.y + sb.height / 2;
    await expect(async () => {
      await pageA.mouse.move(cx, cy);
      await pageA.mouse.move(cx, cy + 60, { steps: 5 });
      await expect(pageA.getByRole("tooltip")).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 5_000 });
    await pageA.setViewportSize({ width: 390, height: 844 });
    const personBtn = rowA.getByRole("button", { name: /, (go to (their|its) cursor|no cursor right now)$/ });
    await expect(personBtn).toHaveCount(1);
    const more = rowA.getByRole("button", { name: "2 more, show everyone" });
    await expect(more).toBeVisible();

    const header = rowA.locator("xpath=ancestor::header[1]");
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const rowBox = (await rowA.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);

    await more.click();
    const menu = pageA.getByRole("menu", { name: "People on this note (3)" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    const bRow = menu.getByRole("menuitem").filter({ hasText: "E2E Viewer" });
    await expect(bRow).toHaveAttribute("aria-disabled", "true");
    await expect(bRow).toContainText("No cursor");
    await expect(bRow).toContainText(/E2E Viewer\s*Viewer/);
    await pageA.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    await pageA.setViewportSize({ width: 1280, height: 800 });
    await expect(personBtn).toHaveCount(3);
    await expect(rowA.getByRole("button", { name: /more, show everyone/ })).toHaveCount(0);

    // ── A8：鍵盤 ────────────────────────────────────────────────────
    const first = rowA.getByRole("button").first();
    const second = rowA.getByRole("button").nth(1);
    await first.focus();
    await expect(pageA.getByRole("tooltip")).toBeVisible();
    const secondLabel = (await second.getAttribute("aria-label")) ?? "";
    // 第二顆（AI）的 tooltip 要含它自己的名字：`{handle} ({label}), AI agent, …` → `{handle} ({label}) · AI agent`
    const secondTip = secondLabel.replace(/, AI agent, (go to its cursor|no cursor right now)$/, " · AI agent");
    expect(secondTip).not.toBe(secondLabel);
    await pageA.keyboard.press("Tab");
    await expect(second).toBeFocused();
    await expect(pageA.getByRole("tooltip")).toContainText(secondTip);

    // Enter 捲到 AI 的游標（文件開頭）：A 打字後停在底部，scrollTop 要變小；且不開選單。
    const topBeforeEnter = await scrollTopOf(pageA);
    expect(topBeforeEnter).toBeGreaterThan(0);
    await rowA.getByRole("button", { name: /AI agent/ }).first().focus();
    await pageA.keyboard.press("Enter");
    await expect.poll(() => scrollTopOf(pageA)).toBeLessThan(topBeforeEnter);
    await expect(pageA.getByRole("menu")).toHaveCount(0);

    // ── A2：B 的最後一個分頁關掉 → 消失；AI 仍在（閒置 120 s 才消失，不等）──
    await pageB.close();
    await expect(bAnyAvatar).toHaveCount(0, { timeout: 35_000 });
    await expect(agentBtn(labels[0]!)).toBeVisible();
    await expect(agentBtn(labels[1]!)).toBeVisible();
  } finally {
    await ctxA?.close();
    await ctxB?.close();
    await anonymous?.close();
  }
});
