import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, loginAs, noteIdFromUrl, openSiteAdmin, randomEmail, showSidebarTab, solidPng } from "./helpers.js";

/**
 * 個人頭貼（設定頁 → 側欄 → 同篇筆記的在線頭像 → 刪除）與上傳大小上限：
 * 1. alice 在 /settings/account 上傳 600×400 的 PNG → 裁切框裡拖曳一次、改一次縮放 → Save（真瀏覽器的 canvas 編碼）→
 *    框關、候選格多一格且被選用；伺服器回的顯示圖是 256×256。
 * 2. 側欄帳號按鈕內有載入完成的 <img>。
 * 3. bob（檢視者）與 alice 開同一篇筆記，bob 頁首的在線頭像列裡 alice 那顆有 <img>。
 * 4. alice 刪掉目前這張 → 帳號按鈕內沒有 <img>、顯示首字。
 * 5. 站台把上傳大小上限調到 1 MiB → 選 1.5 MiB 的圖 → 區塊內出現超過上限的訊息、不開裁切框；測完調回預設。
 *
 * 站台限制是整座疊共用的設定，所以還原寫在 finally，而且前後都用 API 做，不靠畫面。
 *
 * 53-2／53-3：列表上別人的頭貼（頭貼本身用 API 上傳，上傳畫面由 53-1 負責）。
 * 53-2：bob 看 alice——群組成員表、版本歷史的編輯者頭貼群有 alice 的 <img>；沒有頭貼的 bob 那列沒有；
 *       同一個人跨兩個畫面只向伺服器要一次圖；筆記頁首的「最後編輯」落款沒有 <img>。
 * 53-3：alice 看 bob——建議清單、分享名單（新增後與重新開啟）、站台管理的使用者表都有 bob 的 <img>。
 */

const RUN = Date.now();

async function waitForNoteTitle(page: Page): Promise<void> {
  await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
}

async function setUploadMaxBytes(page: Page, value: number | null): Promise<void> {
  const res = await page.request.patch("/api/admin/limits", { data: { set: { uploadMaxBytes: value } } });
  expect(res.status(), `PATCH /api/admin/limits → HTTP ${res.status()} ${await res.text()}`).toBe(200);
}

test("53-1 頭貼：上傳裁切（256×256 顯示圖）→ 側欄 → 別人頁首看得到 → 刪除退回首字 → 超過上限被擋", async ({ browser }) => {
  test.setTimeout(180_000);

  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };

    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    // alice 建一篇筆記並分享給 bob（檢視者）。
    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const title = `E2E avatar ${RUN}`;
    await createNote(alicePage, title);
    const noteUrl = alicePage.url();
    const noteId = await noteIdFromUrl(alicePage);
    const shared = await alicePage.request.put(`/api/notes/${noteId}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    // ── 1. 上傳、裁切、儲存 ───────────────────────────────────────
    await alicePage.goto("/settings/account");
    const group = alicePage.getByRole("radiogroup", { name: "Picture options" });
    await expect(group.getByRole("radio", { name: "No picture", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(group.getByRole("radio")).toHaveCount(1);

    await alicePage.getByTestId("avatar-file-input").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: solidPng(600, 400) });
    const dialog = alicePage.getByRole("dialog", { name: "Adjust picture", exact: true });
    await expect(dialog).toBeVisible();
    const area = dialog.getByRole("application");
    const box = await area.boundingBox();
    expect(box, "裁切區域應有版面").not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await alicePage.mouse.move(cx, cy);
    await alicePage.mouse.down();
    await alicePage.mouse.move(cx + 12, cy + 6, { steps: 6 });
    await alicePage.mouse.up();
    const zoom = dialog.getByRole("slider", { name: "Zoom", exact: true });
    const min = Number(await zoom.getAttribute("min"));
    const max = Number(await zoom.getAttribute("max"));
    await zoom.fill((min + (max - min) * 0.5).toFixed(2));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });

    await expect(group.getByRole("radio")).toHaveCount(2);
    await expect(group.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(group.getByRole("radio", { name: "No picture", exact: true })).toHaveAttribute("aria-checked", "false");

    // 顯示圖是瀏覽器編碼的結果（只有 e2e 看得到這條路徑）：伺服器回來的圖解碼後是 256×256。
    const me = (await (await alicePage.request.get("/api/auth/me")).json()) as { avatar: { id: string; v: number; pending: boolean } | null };
    expect(me.avatar, "選用後 /me 應帶 avatar").not.toBeNull();
    const shown = await alicePage.evaluate(async ({ id, v }) => {
      const res = await fetch(`/api/avatars/${id}?v=${v}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      return { status: res.status, type: blob.type, width: bitmap.width, height: bitmap.height };
    }, { id: me.avatar!.id, v: me.avatar!.v });
    expect(shown.status).toBe(200);
    expect(shown.type).toMatch(/^image\/(webp|jpeg|png)$/);
    expect([shown.width, shown.height]).toEqual([256, 256]);

    // 重新裁切走另一條請求（PUT）：⋮ → Adjust crop → 拖一下 → Save，顯示圖版本號要加一。
    await group.getByRole("radio").nth(1).hover();
    await alicePage.getByRole("button", { name: /^More actions for / }).click();
    await alicePage.getByRole("menuitem", { name: "Adjust crop", exact: true }).click();
    await expect(dialog).toBeVisible();
    const box2 = await dialog.getByRole("application").boundingBox();
    expect(box2, "裁切區域應有版面").not.toBeNull();
    await alicePage.mouse.move(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
    await alicePage.mouse.down();
    await alicePage.mouse.move(box2!.x + box2!.width / 2 - 20, box2!.y + box2!.height / 2, { steps: 6 });
    await alicePage.mouse.up();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => ((await (await alicePage.request.get("/api/auth/me")).json()) as { avatar: { v: number } | null }).avatar?.v)
      .toBeGreaterThan(me.avatar!.v);

    // ── 2. 側欄帳號按鈕內有圖（設定頁沒有側欄，回筆記頁看；先等標題框，lazy 頁的殼換完才碰側欄）────
    await alicePage.goto(noteUrl);
    await waitForNoteTitle(alicePage);
    const accountButton = alicePage.getByRole("button", { name: aliceName, exact: true });
    const accountImg = accountButton.locator("img");
    await expect(accountImg).toHaveCount(1);
    await expect.poll(() => accountImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);

    // ── 3. bob 在同一篇筆記的頁首看到 alice 的頭貼 ───────────────────────
    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    await bobPage.goto(noteUrl);
    await expect(bobPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(bobPage.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const row = bobPage.getByRole("group", { name: "Also viewing this note" });
    const aliceInRow = row.getByRole("button", { name: new RegExp(`^${aliceName},`) });
    await expect(aliceInRow).toBeVisible({ timeout: 35_000 });
    await expect(aliceInRow.locator("img")).toHaveCount(1, { timeout: 35_000 });

    // ── 4. 刪掉目前這張 → 退回首字 ───────────────────────────────────
    await alicePage.goto("/settings/account");
    await expect(group.getByRole("radio")).toHaveCount(2);
    await group.getByRole("radio").nth(1).hover();
    await alicePage.getByRole("button", { name: /^More actions for / }).click();
    await alicePage.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirm = alicePage.getByRole("dialog", { name: "Delete this picture?", exact: true });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    // 設定是 modal，外面的 toast 區在無障礙樹裡被隱藏，所以用文字找，不用 role。
    await expect(alicePage.getByText("Deleted. Your initial is shown instead.", { exact: true })).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(1);
    await alicePage.goto(noteUrl);
    await waitForNoteTitle(alicePage);
    await expect(accountButton).toBeVisible();
    await expect(accountButton.locator("img")).toHaveCount(0);
    await expect(accountButton.locator("span").first()).toHaveText("A");

    // ── 5. 超過站台上傳上限 ───────────────────────────────────────
    try {
      await setUploadMaxBytes(adminPage, 1_048_576);
      // 站台設定沒回來之前選檔，瀏覽器端的大小前驗會被跳過；先等設定回應再選。
      const authConfig = alicePage.waitForResponse(r => r.url().endsWith("/api/auth/config") && r.ok());
      await alicePage.goto("/settings/account");
      await authConfig;
      await expect(group.getByRole("radio")).toHaveCount(1);
      await alicePage.getByTestId("avatar-file-input").setInputFiles({
        name: "big.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(1_572_864),
      });
      await expect(alicePage.getByRole("alert").filter({ hasText: /larger than the .* limit/ })).toBeVisible();
      await expect(alicePage.getByRole("dialog", { name: "Adjust picture", exact: true })).toHaveCount(0);
    } finally {
      await setUploadMaxBytes(adminPage, null);
    }
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});

/** 用 API 幫目前登入的人設一張頭貼（原圖與顯示圖都是純色 PNG）；回傳 `/api/auth/me` 的 avatar 參照。 */
async function setAvatarViaApi(page: Page): Promise<{ id: string; v: number }> {
  const res = await page.request.post("/api/auth/avatars", {
    multipart: {
      original: { name: "o.png", mimeType: "image/png", buffer: solidPng(300, 300) },
      display: { name: "d.png", mimeType: "image/png", buffer: solidPng(256, 256) },
      crop: JSON.stringify({ x: 0, y: 0, size: 300, width: 300, height: 300 }),
    },
  });
  expect(res.status(), `POST /api/auth/avatars → HTTP ${res.status()} ${await res.text()}`).toBe(201);
  const me = (await (await page.request.get("/api/auth/me")).json()) as { avatar: { id: string; v: number; pending: boolean } | null };
  expect(me.avatar, "上傳後 /me 應帶 avatar").not.toBeNull();
  expect(me.avatar!.pending).toBe(false);
  return { id: me.avatar!.id, v: me.avatar!.v };
}

/** 範圍內恰有一顆 <img> 且已載入（有圖才算數，不只是節點存在）。 */
async function expectLoadedImg(scope: Locator): Promise<Locator> {
  const img = scope.locator("img");
  await expect(img).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  return img;
}

test("53-2 列表上的頭貼（bob 看 alice）：群組成員表、版本歷史有圖；沒頭貼的沒有；同一人跨畫面只要一次圖；最後編輯落款沒有圖", async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };
    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    // alice：設頭貼 → 建群組、加 bob → 在群組裡建一篇筆記、寫一次內容、存一個版本。
    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const aliceAvatar = await setAvatarViaApi(alicePage);
    const groupName = `E2E avatar group ${RUN}`;
    const g = await alicePage.request.post("/api/groups", { data: { name: groupName } });
    expect(g.status(), await g.text()).toBe(201);
    const groupId = ((await g.json()) as { id: string }).id;
    const added = await alicePage.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBe(200);
    const title = `E2E avatar list ${RUN}`;
    const created = await alicePage.request.post("/api/notes", { data: { title, groupId } });
    expect(created.status(), await created.text()).toBe(201);
    const noteId = ((await created.json()) as { id: string }).id;
    const wrote = await alicePage.request.post(`/api/notes/${noteId}/edits`, { data: { op: "append", markdown: "Written by alice." } });
    expect(wrote.status(), await wrote.text()).toBe(201);
    const saved = await alicePage.request.post(`/api/notes/${noteId}/versions`, { data: { name: "first" } });
    expect(saved.status(), await saved.text()).toBe(201);
    const aliceSrc = `/api/avatars/${aliceAvatar.id}?v=${aliceAvatar.v}`;

    // bob：記下 alice 的圖被要了幾次，從群組成員表走到版本歷史。
    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    // Playwright 的 request 事件連記憶體快取命中都會報，所以用 CDP 區分：真的到伺服器的才算。
    const cdp = await bobPage.context().newCDPSession(bobPage);
    await cdp.send("Network.enable");
    const avatarIds = new Map<string, string>();
    const servedFromCache = new Set<string>();
    cdp.on("Network.requestWillBeSent", e => {
      if (new URL(e.request.url).pathname === `/api/avatars/${aliceAvatar.id}`) avatarIds.set(e.requestId, e.request.url);
    });
    cdp.on("Network.requestServedFromCache", e => servedFromCache.add(e.requestId));
    cdp.on("Network.responseReceived", e => {
      if (e.response.fromDiskCache || e.response.fromPrefetchCache) servedFromCache.add(e.requestId);
    });
    await bobPage.goto("/");
    // bob 是一般成員，群組選單的項目叫「View members」（有管理成員權限的才叫「Members & settings」）。
    await showSidebarTab(bobPage, "Groups");
    await bobPage.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
    await bobPage.getByRole("menuitem", { name: "View members" }).click();
    await expect(bobPage).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
    const dialog = bobPage.getByRole("dialog", { name: groupName });
    const aliceRow = dialog.getByRole("row").filter({ hasText: aliceName });
    const bobRow = dialog.getByRole("row").filter({ hasText: bobName });
    await expect(aliceRow).toHaveCount(1, { timeout: 15_000 });
    await expect(bobRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(aliceRow)).toHaveAttribute("src", aliceSrc);
    await expect(bobRow.locator("img")).toHaveCount(0);

    // 關掉群組視窗，從側欄開那篇筆記（單頁應用內換頁，同一份文件裡同網址的圖不會再向伺服器要）。
    await bobPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    const sidebar = bobPage.getByRole("complementary");
    const noteRow = sidebar.getByText(title, { exact: true });
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(noteRow).toBeVisible({ timeout: 15_000 });
    await noteRow.click();
    await waitForNoteTitle(bobPage);

    // 筆記頁首「最後編輯」落款：只有字，沒有圖。
    const lastEdited = bobPage.getByTestId("last-edited");
    await expect(lastEdited).toBeVisible({ timeout: 15_000 });
    await expect(lastEdited.locator("img")).toHaveCount(0);

    await bobPage.getByTestId("versions-bubble").click();
    const panel = bobPage.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    const editorAvatar = panel.locator("[data-editor-avatar]");
    await expect(editorAvatar).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(editorAvatar)).toHaveAttribute("src", aliceSrc);

    // 兩個畫面用的是同一個網址：伺服器只被要過一次。
    const hitServer = [...avatarIds.keys()].filter(id => !servedFromCache.has(id));
    expect(hitServer, `alice 的圖發出 ${avatarIds.size} 個請求，其中 ${hitServer.length} 個到了伺服器`).toHaveLength(1);
    expect(avatarIds.size, "第二個畫面有用到同一個網址（快取命中才是這個斷言要看的）").toBeGreaterThanOrEqual(2);
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});

test("53-3 列表上的頭貼（alice 看 bob）：建議清單、分享名單（新增後與重新開啟）、站台管理使用者表", async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };
    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    // bob 設頭貼；alice 與 bob 同在一個群組（建議清單只找「已經認識的人」）。
    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    const bobAvatar = await setAvatarViaApi(bobPage);
    const bobSrc = `/api/avatars/${bobAvatar.id}?v=${bobAvatar.v}`;
    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const g = await alicePage.request.post("/api/groups", { data: { name: `E2E avatar known ${RUN}` } });
    expect(g.status(), await g.text()).toBe(201);
    const added = await alicePage.request.put(`/api/groups/${((await g.json()) as { id: string }).id}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBe(200);

    await alicePage.goto("/");
    await createNote(alicePage, `E2E avatar share ${RUN}`);
    await alicePage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = alicePage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();

    // 建議清單：打 bob 的 email 前幾字，那一項有他的圖。
    const emailBox = shareDialog.getByLabel("Email address");
    await emailBox.fill(bob.email.slice(0, 10));
    const option = alicePage.getByRole("listbox").getByRole("option").filter({ hasText: bobName });
    await expect(option).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(option)).toHaveAttribute("src", bobSrc);

    // 加進分享名單：新增後那一列有圖（PUT 的回應）。
    await emailBox.fill(bob.email);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    const shareRow = shareDialog.getByRole("listitem").filter({ hasText: bob.email });
    await expect(shareRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(shareRow)).toHaveAttribute("src", bobSrc);

    // 重新載入、再開分享框：名單從伺服器重抓（GET），那一列仍有圖。
    await alicePage.reload();
    await waitForNoteTitle(alicePage);
    await alicePage.getByRole("button", { name: "Share", exact: true }).click();
    const reopened = alicePage.getByRole("dialog", { name: "Share note" });
    const reopenedRow = reopened.getByRole("listitem").filter({ hasText: bob.email });
    await expect(reopenedRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(reopenedRow)).toHaveAttribute("src", bobSrc);

    // 站台管理的使用者表：bob 那列有圖，沒頭貼的 alice 那列沒有。
    const admin = await openSiteAdmin(adminPage);
    const table = admin.getByRole("table", { name: "Users", exact: true });
    const bobUserRow = table.getByRole("row").filter({ hasText: bob.email });
    await expect(bobUserRow).toHaveCount(1, { timeout: 15_000 });
    // 圖是 loading="lazy"：疊裡累積很多使用者時，這一列可能在捲動區之外，要捲進來才會載。
    await bobUserRow.scrollIntoViewIfNeeded();
    await expect(await expectLoadedImg(bobUserRow)).toHaveAttribute("src", bobSrc);
    const aliceUserRow = table.getByRole("row").filter({ hasText: alice.email });
    await expect(aliceUserRow).toHaveCount(1);
    await expect(aliceUserRow.locator("img")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});
