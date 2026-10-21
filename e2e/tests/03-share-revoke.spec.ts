import { test, expect } from "@playwright/test";
import { ADMIN, createNote, loginAs, openSiteAdmin, randomEmail } from "./helpers.js";

/**
 * §14.5 流程 3：admin 於站台管理頁建邀請連結（UI 全程，#285）→ 第二使用者（獨立 browser
 * context）開連結、自己填 email 與密碼建帳並登入（不強制改密碼）→ admin 建筆記並分享給他
 * → 他開啟可見 → admin 撤銷 → **≤10 秒**他的頁面出現 `note.accessRevoked` toast
 * 文案＋被導回 `/`（§10 SLA 的機器斷言）。
 *
 * 建邀請走站台管理 modal（`/admin/users`），從 `UserMenu` 的「Site admin」入口進去
 * （走真實入口，不 `page.goto` 深連結），完成後按 Esc 關掉回 `/`。
 */
test("admin 建第二使用者 → 分享筆記 → 撤銷 → SLA 內失去存取", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 站台管理頁 → 使用者區 → 建立第二使用者 ────────────────────────
    await openSiteAdmin(adminPage);

    const secondEmail = randomEmail();
    const secondPassword = "e2e-second-user-pw";

    await adminPage.getByRole("button", { name: "Create invitation" }).click();
    const createDialog = adminPage.getByRole("dialog", { name: "Create an invitation" });
    await createDialog.getByRole("button", { name: "Create link" }).click();

    // 結果對話框：唯讀欄（可及名稱 `Link`）的值就是邀請連結，token 只在這裡出現一次。
    const resultDialog = adminPage.getByRole("dialog", { name: "Invitation link" });
    const inviteUrl = await resultDialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
    expect(inviteUrl.startsWith(`${new URL(adminPage.url()).origin}/register#invite=`)).toBe(true);
    expect(new URL(inviteUrl).hash).toMatch(/^#invite=knbi_[A-Za-z0-9_-]{43}$/);
    await resultDialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(resultDialog).not.toBeVisible();

    // ── Esc 關站台管理 modal、回 "/" ──────────────────────────────────
    await adminPage.keyboard.press("Escape");
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 第二使用者：獨立 context 開邀請連結 → 自己填表建帳（成功即登入、不強制改密碼）──
    const userPage = await userContext.newPage();
    await userPage.goto(inviteUrl);
    // 讀完 fragment 就從網址列清掉，所以網址上沒有 `#`。
    await expect(userPage).toHaveURL(/\/register$/);
    await expect(userPage.getByText(/^This invitation works once/)).toBeVisible();
    await userPage.getByLabel("Email", { exact: true }).fill(secondEmail);
    await userPage.getByLabel("Display name (optional)").fill("E2E Second User");
    await userPage.getByLabel("Password", { exact: true }).fill(secondPassword);
    await userPage.getByLabel("Confirm password").fill(secondPassword);
    await userPage.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(userPage).toHaveURL(/\/$/);

    // ── 建筆記＋分享給第二使用者（對方已建帳，加人才找得到 email） ─────────────────────────────────────
    const title = `E2E share ${Date.now()}`;
    await createNote(adminPage, title);
    const noteUrl = adminPage.url();

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    // 加人表單掛在「限定成員」情境面板底下（新 IA，Willie 2026-09-17 產品決定），
    // 只有選了這個層級才會掛載——先切過去才看得到 Email address 欄位。
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();
    await shareDialog.getByLabel("Email address").fill(secondEmail);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByText(secondEmail)).toBeVisible();

    // ── 第二使用者開啟被分享的筆記（已登入，同上面建帳後的 context），確認可見 ───────────────────────────────────
    // 分享表單預設角色＝viewer（未改動下拉選單）：`TitleInput` 對 `readOnly`
    // 改渲染成 `<h1>`（不是可編輯的 `Note title` labeled input，見
    // `TitleInput.tsx` 的 `if (readOnly)` 分支）——「可見」斷言改認這顆標題。
    await userPage.goto(noteUrl);
    await expect(userPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });

    // ── 屏障：等 Hocuspocus 共編真的連上，才開始算 SLA ──────────────────
    // REST（上面那個 `<h1>` 標題）成功只代表 `GET /api/notes/:ref` 拿到資料；
    // provider 的 WS 握手是接在它後面才起步的獨立非同步流程（`useCollab`）。
    // 在這裡就撤權也不再是卡死的（issue #6：握手前被拒走的是
    // `authenticationFailed`，`useCollab` 現在接了並翻成同一套二擊語意，同樣收斂到
    // 下面那組斷言）——但這道屏障仍然保留：它讓這一支 spec 釘的是「已連線後收到
    // 應用層 CLOSE(REVOKED)」那條主路徑，而不是隨機落在兩條之一。
    // `ConnectionBadge`（`role="status"`）是 T12 交接記錄的真訊號：
    // 等它顯示「Connected」，順帶釘住角色徽章＝viewer（分享表單預設角色）。
    // regex 錨定開頭（同 helpers.ts `createNote` 的屏障）：字串形式是大小寫不敏感的
    // 子字串比對，未來若出現「Disconnected」之類的文案會誤中。
    const connectionBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(connectionBadge).toBeVisible({ timeout: 15_000 });
    await expect(connectionBadge.getByText("Viewer", { exact: true })).toBeVisible();

    // ── admin 撤銷（DELETE share）──────────────────────────────────
    await shareDialog.getByRole("button", { name: `Remove ${secondEmail}` }).click();
    await expect(shareDialog.getByText(secondEmail)).not.toBeVisible();

    // ── §10 SLA：≤10 秒，第二使用者頁面出現 accessRevoked toast＋被導回 "/" ──
    // Radix Toast 額外渲染一個 `role="status"` live-region 播報「Notification …」
    // 跟真正的 toast 文案共用子字串——`exact:true` 只匹配
    // 真正的 ToastTitle 節點。
    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
