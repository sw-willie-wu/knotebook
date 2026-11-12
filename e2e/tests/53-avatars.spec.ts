import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, loginAs, noteIdFromUrl, randomEmail, solidPng } from "./helpers.js";

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
