import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * #72 公開分享連結（spec §6 的 e2e）＋#122 PR3 公開別名段：owner 建筆記＋圖
 * （**真上傳**）→ 開公開 → 關 owner 分頁 → 免登入 context 看到內容與圖 →
 * 設別名 → 免登入走 /p/<handle>/<slug>（含 by-path 圖端點）→ 撤別名（token 仍活）
 * → 重生後舊連結 404 → 撤銷後失效卡。
 *
 * ⚠ 「關 owner 分頁」是**場景步驟，不是被驗證的行為**（審查 M1）：內容落盤可能來自
 * 一般的 2 秒 debounce flush、也可能來自最後連線關閉的 flush，本測試不區分——
 * 「內容（含圖的 URL）真的持久化了」由下面的輪詢斷言守（ydoc 解碼後含上傳網址），
 * 哪條 flush 路徑把它送進 DB 不在本測試的守備範圍。
 *
 * - 圖**必走 FilePanel Upload tab 的 `setInputFiles` 真上傳**（spec 明文禁用 Embed
 *   繞過：Embed 強制絕對網址、正好落在 publicMediaUrl「同源絕對網址不映射」的
 *   known-limitation 上，匿名端看圖的斷言必紅——用 Embed 等於把本測試最重要的
 *   斷言弄成必然失敗、誘發弱化）。
 * - **flush 是非同步的**（collab store debounce 2s、最後連線關閉時 flush）——公開
 *   端點的內容斷言一律 `expect(...).toPass()` 輪詢，不可讀一次就斷言。
 * - 自建資源（筆記/圖/連結），不依賴其他 spec 殘留；共用疊、admin 用 01 之後的
 *   `newPassword` 登入（helpers 檔頭慣例）。
 */

/** 1×1 紅色 PNG——夠小又是真檔案，走完 multipart 上傳與磁碟落地的整條鏈。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const INVALID_LINK_TEXT = "This link doesn't exist or is no longer active.";

/** 開 ShareDialog（呼叫端保證 page 已在筆記頁）。 */
async function openShareDialog(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 從 ShareDialog 讀公開連結（radio 已在「公開」態時）。
 *
 * ⚠ 2026-09-17 介面改版後，匿名態的輸入框**只放 token**，`/p/` 前綴是旁邊的一段
 * 文字（兩種型態共用「前綴 ＋ 輸入框」的形狀，見 `ShareDialog.tsx` 的
 * `PublicLinkPanel`）。所以這裡讀到的是裸 token，網址要自己組回去——改版前
 * 讀到的是整條網址，那個假設已經不成立。 */
async function readPublicUrl(dialog: ReturnType<Page["getByRole"]>, page: Page): Promise<string> {
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toBeVisible();
  const token = await input.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `${new URL(page.url()).origin}/p/${token}`;
}

function tokenOf(publicUrl: string): string {
  const token = publicUrl.slice(publicUrl.lastIndexOf("/p/") + 3);
  // 驗形在 helper 本身（plan T6）：本檔現有兩段別名形網址，餵錯進來會切出
  // "<handle>/<slug>"——別讓它靜默流進後續請求。
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
}

/** 從 ShareDialog 讀公開別名路徑（匿名 OFF 態，radio 已在「公開」態時）。
 *
 * OFF 態的輸入框放 slug（可編輯），前綴 `/p/<handle>/` 是旁邊的一段文字——
 * 與 `readPublicUrl`（ON 態、輸入框放裸 token）分屬兩種型態，不共用同一支
 * helper（呼叫端 2026-09-17 交辦明令：另開一支，別硬塞進 `readPublicUrl`）。
 * 回傳**路徑**（不含 origin）：呼叫端只拿它餵 `page.goto` 與切出 `<handle>/<slug>`
 * 這段 API ref，不像 `readPublicUrl` 的呼叫點需要組完整網址。 */
async function readAliasPath(dialog: ReturnType<Page["getByRole"]>): Promise<string> {
  const prefix = await dialog.locator("#share-public-slug-prefix").innerText();
  expect(prefix).toMatch(/^\/p\/[a-z0-9-]+\/$/);
  const slug = await dialog.getByLabel("Custom public link", { exact: true }).inputValue();
  return `${prefix}${slug}`;
}

/** 公開內容端點路徑的唯一組字點（#122 PR3：本檔原有兩處硬編字串，改集中；
 * `ref` 可為 token 或 `<handle>/<slug>` 兩段形——別名段的圖 src 也走這裡）。
 * ⚠ e2e 刻意不共用 web 端的組字模組（`lib/public-note-ref.ts`；e2e package 無
 * workspace 依賴、rsync 不帶 dist——與 gate r3-M 對 shared 的裁決同理），自組一份。 */
function publicNoteApi(ref: string): string {
  return `/api/public/notes/${ref}`;
}

/** 公開端點的節流桶 key 含 ip——單 worker 序列跑不會撞 429，這裡不做退避。 */
async function fetchPublicNote(request: APIRequestContext, token: string) {
  return request.get(publicNoteApi(token));
}

test("owner 開公開 → 免登入看到內容與圖 → 重生舊連結死 → 撤銷後失效卡", async ({ browser, request }) => {
  // 逐項等待的名目總和早已超過任何合理上限（每個 15s 等待實際毫秒級就過）——
  // 150s 是「單一步驟卡死時，讓真失敗以該步驟誠實的斷言訊息呈現」的實用預算，
  // 不是名目最壞值的算術（#122 別名段加了四個等待點後名目和已無意義）。
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  // 免登入訪客：全新 context＝零 cookie/session。
  const anonContext = await browser.newContext();
  try {
    // ── owner：建筆記＋打字＋真上傳一張圖 ──────────────────────────────
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, ADMIN.email, ADMIN.newPassword);
    await expect(ownerPage).toHaveURL(/\/$/);

    const title = `E2E public share ${Date.now()}`;
    await createNote(ownerPage, title);
    const noteUrl = ownerPage.url();

    const editor = editorLocator(ownerPage);
    await editor.click();
    await editor.pressSequentially("Anon-visible content line.");
    // 新行開 image block：slash 選單（我們接管的那個，內建項全數保留）。
    await ownerPage.keyboard.press("Enter");
    await editor.pressSequentially("/image");
    // 比照 06-mermaid 的手法：用 slash item 的 subtext 點選（title 字樣太通用）。
    await ownerPage.getByText("Resizable image with caption").click();
    // image placeholder →「Add image」開 FilePanel → 自家 Upload tab（預設分頁）
    await ownerPage.getByText("Add image", { exact: true }).click();
    await expect(ownerPage.getByRole("tab", { name: "Upload" })).toBeVisible();
    await ownerPage
      .getByLabel("Choose an image file to upload")
      .setInputFiles({ name: "e2e-public.png", mimeType: "image/png", buffer: PNG_1X1 });
    // 上傳落地：owner 端 img src 指向登入版上傳端點且真的載得出來。
    const ownerImg = ownerPage.locator('img[src*="/api/uploads/"]');
    await expect(ownerImg).toBeVisible({ timeout: 15_000 });

    // ── owner：ShareDialog 切「公開」→ 取得 /p/ 連結 ─────────────────────
    let dialog = await openShareDialog(ownerPage);
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled(); // latch 完成（兩個 query 都到）才可點
    await publicRadio.check();
    const publicUrl = await readPublicUrl(dialog, ownerPage);
    const token = tokenOf(publicUrl);
    await ownerPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    // ── 關 owner 分頁 → 輪詢公開端點等內容（含圖）落地 ─────────────────────
    await ownerPage.close();
    await expect(async () => {
      const res = await fetchPublicNote(request, token);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { title: string; ydoc: string };
      expect(body.title).toBe(title);
      // 判別性守衛（審查 M2）：Yjs 把 XML attribute 字串**原文**編進 update（本機
      // 實測核實），所以「解碼後含上傳網址」＝圖的 URL 真的持久化了。只斷長度的話，
      // 上傳往返超過 2 秒時中間那次 debounce flush（image block 還沒有 url）就足以
      // 讓輪詢提前放行，匿名頁吃到 stale 快照、看圖斷言誤紅。
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain("/api/uploads/");
    }).toPass({ timeout: 20_000 });

    // ── 免登入訪客：看到標題、內文、圖（走公開圖端點且真的解得出像素）────
    const anonPage = await anonContext.newPage();
    await anonPage.goto(publicUrl);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anonPage.getByText("Read-only")).toBeVisible();
    await expect(anonPage.getByText("Anon-visible content line.")).toBeVisible();
    // 圖：resolveFileUrl 把 /api/uploads/:id 映射到 /api/public/notes/:token/uploads/:id
    const anonImg = anonPage.locator(`img[src*="${publicNoteApi(token)}/uploads/"]`);
    await expect(anonImg).toBeVisible({ timeout: 15_000 });
    // naturalWidth > 0 ＝瀏覽器真的抓到並解碼了 blob（404/破圖時是 0）。
    await expect
      .poll(async () => anonImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // 未登入不重導：仍在 /p/ 網址上。
    expect(new URL(anonPage.url()).pathname).toBe(`/p/${token}`);

    // ── owner：設公開別名（Willie 2026-09-17 介面改版：匿名 toggle 取代舊的
    //    「公開別名欄位」＋「Remove custom URL」鈕）→ 無痕開 /p/<handle>/<slug>
    //    → 撤別名（開回匿名 toggle） ──────────────────────────────────────
    const ownerPage2 = await ownerContext.newPage();
    await ownerPage2.goto(noteUrl);
    await expect(ownerPage2.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    dialog = await openShareDialog(ownerPage2);
    await expect(dialog.getByRole("radio", { name: /^Public link/ })).toBeChecked();

    // 匿名 toggle（Radix Switch，role="switch"，可及名稱 "Anonymous link"）。新開的
    // 公開連結預設匿名 ON（`public_slug` 為 null）——關掉會讓前端自動產生一個 16 位
    // hex 隨機 slug 並送出（`PublicLinkPanel.applyRandomSlug`），輸入框隨即從唯讀的
    // "Public link URL" 變成可編輯的 "Custom public link"。
    const anonymousToggle = dialog.getByRole("switch", { name: "Anonymous link" });
    await expect(anonymousToggle).toBeChecked();
    await anonymousToggle.click();
    const aliasInput = dialog.getByLabel("Custom public link", { exact: true });
    await expect(aliasInput).toBeVisible({ timeout: 10_000 });
    // 等隨機 slug 真的落地（mutateAsync 完成、輸入框從空字串變成候選值）——別在
    // 輸入框還空著的時候就蓋自訂名，那樣蓋掉的其實是尚未送出的中繼狀態。
    await expect.poll(async () => aliasInput.inputValue()).not.toBe("");

    const alias = `e2e-alias-${Date.now()}`;
    await aliasInput.fill(alias);
    const saveButton = dialog.getByRole("button", { name: "Save custom URL" });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    // 存檔成功＝`dirty` 回 false（`useSetPublicSlug` onSuccess 直寫快取，`slug` prop
    // 追上使用者剛存的值）——鈕重新變回 disabled 就是完成訊號，不必另外輪詢 API。
    await expect(saveButton).toBeDisabled({ timeout: 10_000 });

    // 別名網址**從 UI 讀出**（gate r3-M 的既有裁決沿用：禁 import shared 的
    // publicAliasPath、禁自拼 handle）：`readAliasPath` 讀前綴 span＋輸入框現值。
    const aliasPath = await readAliasPath(dialog);
    const aliasRef = aliasPath.slice("/p/".length); // "<handle>/<slug>"——API 組字回 helper

    // 無痕開別名網址：與 token 頁同一張唯讀頁（標題＋內文＋圖走 by-path uploads）
    await anonPage.goto(aliasPath);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anonPage.getByText("Anon-visible content line.")).toBeVisible();
    const anonAliasImg = anonPage.locator(`img[src*="${publicNoteApi(aliasRef)}/uploads/"]`);
    await expect(anonAliasImg).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => anonAliasImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(new URL(anonPage.url()).pathname).toBe(aliasPath);

    // 撤別名（新做法：把匿名 toggle 開回去——舊的「Remove custom URL」鈕已下架）
    // → 別名 404、token 連結**仍活**（清 slug 不動 token——並存語意）。
    // token 面用「頁面級」斷言（不只 API）：兩段 route 若吞掉單段形，API 探針看不到。
    await anonymousToggle.click();
    await expect(dialog.getByLabel("Public link URL")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel("Public link URL")).toHaveValue(token, { timeout: 10_000 });
    await anonPage.goto(aliasPath);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });
    await anonPage.goto(publicUrl);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    expect((await fetchPublicNote(request, token)).status()).toBe(200);

    // ── owner：重生（此時匿名 ON＝換 token，不是換 slug）→ 舊連結 404、新連結活 ──
    await dialog.getByRole("button", { name: "Regenerate link" }).click();
    await expect(dialog.getByLabel("Public link URL")).not.toHaveValue(token);
    const newPublicUrl = await readPublicUrl(dialog, ownerPage2);
    const newToken = tokenOf(newPublicUrl);
    expect(newToken).not.toBe(token);

    const oldRes = await fetchPublicNote(request, token);
    expect(oldRes.status()).toBe(404);
    const newRes = await fetchPublicNote(request, newToken);
    expect(newRes.status()).toBe(200);

    // 匿名端拿舊連結重整 → 失效卡（不是白屏、不是導去登入）。
    await anonPage.goto(publicUrl);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });

    // ── owner：撤銷（切回「限定成員」＝ DELETE public-link；本筆記零成員）────
    await dialog.getByRole("radio", { name: /^Members only/ }).check();
    await expect(dialog.getByLabel("Public link URL")).not.toBeVisible();
    await ownerPage2.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await expect(async () => {
      const res = await fetchPublicNote(request, newToken);
      expect(res.status()).toBe(404);
    }).toPass({ timeout: 10_000 });

    // 匿名端開撤銷後的連結 → 失效卡。
    await anonPage.goto(newPublicUrl);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});
