import { test, expect } from "@playwright/test";
import { ADMIN, createNote, loginAs, randomEmail } from "./helpers.js";

/**
 * §14.5 流程 3：admin 於設定 modal 建第二使用者（admin 代建帳號 `mustChangePassword:
 * true`）→ 第二使用者（獨立 browser context）首登被強制改密 → admin 分享筆記給他
 * → 他開啟可見 → admin 撤銷 → **≤10 秒**他的頁面出現 `note.accessRevoked` toast
 * 文案＋被導回 `/`（§10 SLA 的機器斷言）。
 *
 * 建第二使用者走 `/settings/users`（設定總 modal），**不是**直接 `page.goto` 深連結——
 * 深連結沒有 `location.state.backgroundLocation`，之後 Esc 關閉 modal 會落回 `/`
 * 而非原本的背景頁；這裡刻意從 `UserMenu` 的「Settings」入口進去，讓
 * `backgroundLocation` 沿途正確帶著（見 `SettingsModal.tsx`/`UserMenu.tsx` 檔頭）。
 */
test("admin 建第二使用者 → 分享筆記 → 撤銷 → SLA 內失去存取", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.newPassword);
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 設定 modal → 使用者區 → 建立第二使用者 ──────────────────────────
    await adminPage.getByRole("button", { name: "admin", exact: true }).click(); // UserMenu 觸發鈕＝displayName
    await adminPage.getByRole("menuitem", { name: "Settings" }).click();
    await expect(adminPage).toHaveURL(/\/settings\/account$/);
    await adminPage.getByRole("link", { name: "Users", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/users$/);

    const secondEmail = randomEmail();
    const tempPassword = "e2e-second-user-temp-pw";

    await adminPage.getByRole("button", { name: "Create user" }).click();
    const createUserDialog = adminPage.getByRole("dialog", { name: "Create user" });
    await createUserDialog.locator("#admin-create-email").fill(secondEmail);
    await createUserDialog.locator("#admin-create-password").fill(tempPassword);
    await createUserDialog.locator("#admin-create-display-name").fill("E2E Second User");
    await createUserDialog.getByRole("button", { name: "Create", exact: true }).click();

    // 成功訊號：dialog 關閉＋新使用者出現在表格。
    await expect(createUserDialog).not.toBeVisible();
    await expect(adminPage.getByText(secondEmail)).toBeVisible();

    // ── 關閉設定 modal（Esc），無 reload 落回背景頁（"/"）── ────────────
    await adminPage.keyboard.press("Escape");
    await expect(adminPage).toHaveURL(/\/$/);

    // ── 建筆記＋分享給第二使用者 ─────────────────────────────────────
    const title = `E2E share ${Date.now()}`;
    await createNote(adminPage, title);
    const noteUrl = adminPage.url();

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByLabel("Email address").fill(secondEmail);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByText(secondEmail)).toBeVisible();

    // ── 第二使用者：獨立 context 首登強改密（admin 代建帳號的既定流程，同 01 spec）──
    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, tempPassword);
    await expect(userPage).toHaveURL(/\/change-password$/);

    const newPassword = "e2e-second-user-pw-2";
    await userPage.locator("#change-password-current").fill(tempPassword);
    await userPage.locator("#change-password-new").fill(newPassword);
    await userPage.locator("#change-password-confirm").fill(newPassword);
    await userPage.getByRole("button", { name: "Change password" }).click();
    await expect(userPage).toHaveURL(/\/$/);
    await expect(userPage.getByText("Password updated.", { exact: true })).toBeVisible();

    // ── 開啟被分享的筆記，確認可見 ───────────────────────────────────
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
    // 跟真正的 toast 文案共用子字串（見 01 spec 同款雷）——`exact:true` 只匹配
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
