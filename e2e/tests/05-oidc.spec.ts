import { test, expect } from "@playwright/test";
import { ADMIN, loginAs, randomEmail } from "./helpers.js";

/**
 * §14.5 流程 5：OIDC 兩情境（fake-idp）。
 *
 * control endpoint 走 `http://localhost:9400/control/next-login`（`request`
 * fixture 是獨立於瀏覽器的 API context，不吃 `playwright.config.ts` 的
 * `--host-resolver-rules`——那條規則只影響瀏覽器分頁的 DNS 解析；`request` 直接
 * 打 host 發布的 `127.0.0.1:9400`，用 `localhost` 一樣能解到，無需該規則）。
 * SSO 鈕本身（`/login` 頁的 `<a href="/api/auth/oidc/login">`）則是瀏覽器頂層
 * 導航，經 fake-idp 容器內部視角的 `fake-idp:9400`（server 端 `OIDC_ISSUER_URL`）
 * 302 出去、又靠 `--host-resolver-rules=MAP fake-idp 127.0.0.1` 讓瀏覽器把同一個
 * `fake-idp` 主機名解回 127.0.0.1，兩邊因此看到同一個 issuer 字串。
 *
 * fake-idp 的 code 一次性：`/authorize` 消費即清 `nextLogin`、`/token` 消費即刪
 * code——本檔每個情境各自 PUT 一次 `next-login`、且不重試同一次 authorize，不會
 * 撞到這個限制。
 */

const CONTROL_URL = "http://localhost:9400/control/next-login";

test("情境一：SSO 登入未知 email → 自動建帳並登入", async ({ request, browser }) => {
  const email = randomEmail();

  const controlResponse = await request.put(CONTROL_URL, {
    data: { sub: "new-user-1", email, email_verified: true, name: "E2E New User" },
  });
  expect(controlResponse.ok()).toBe(true);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: "Continue with SSO" }).click();

    // 成功訊號：全頁導航鏈（/login → /api/auth/oidc/login → fake-idp →
    // /api/auth/oidc/callback）結束後落在 "/"（已登入）。
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

    // UserMenu 觸發鈕＝displayName；自動建帳時 displayName 取自 IdP 的 name claim。
    await expect(page.getByRole("button", { name: "E2E New User", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

/**
 * §14.5 流程 5 情境二：**本流程自建**一個已知 email 的使用者（admin 於
 * `/settings/users` 代建，不依賴 03 spec 的隨機帳號——跨流程資料耦合禁止）。
 * admin 代建帳號 `mustChangePassword: true`，但 OIDC callback 認證成功後會清
 * 掉這個旗標（§14.3 一輪 gate MAJOR-6）並呼叫 `gate.invalidate`（§14.3 三輪 gate
 * MAJOR-1）——SSO 登入因此**不該**被 `ChangePasswordGate` 導去 `/change-password`，
 * 這正是 gate.invalidate 快取一致性鏈的 E2E 面：漏了 invalidate，60 秒 TTL 快取
 * 會把剛清掉的旗標吐回 `/api/auth/me`，使用者又被彈回改密頁。
 *
 * fake-idp 預置的 `name` claim 刻意與 admin 代建時填的 displayName 不同——
 * UserMenu 最終顯示哪一個，就是「連結既有帳號」（用 DB 既有 displayName）還是
 * 「誤判成建新帳號」（用 IdP claim 覆寫）的機器可斷言分野。
 */
test("情境二：SSO 登入已驗證 email 命中既有帳號 → 連結而非建帳，帳密路徑亦可登入", async ({ request, browser }) => {
  const linkedEmail = randomEmail();
  const tempPassword = "e2e-oidc-linked-user-pw";
  const adminCreatedDisplayName = "E2E OIDC Linked User";
  const idpNameClaim = "IdP Claimed Name (must not appear)";

  // ── admin 代建已知 email 使用者（自建，不依賴 03 spec 的帳號）───────────
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.newPassword);
    await expect(adminPage).toHaveURL(/\/$/);

    await adminPage.getByRole("button", { name: "admin", exact: true }).click(); // UserMenu 觸發鈕＝displayName
    await adminPage.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/account$/);
    await adminPage.getByRole("link", { name: "Users", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/settings\/users$/);

    await adminPage.getByRole("button", { name: "Create user" }).click();
    const createUserDialog = adminPage.getByRole("dialog", { name: "Create user" });
    await createUserDialog.locator("#admin-create-email").fill(linkedEmail);
    await createUserDialog.locator("#admin-create-password").fill(tempPassword);
    await createUserDialog.locator("#admin-create-display-name").fill(adminCreatedDisplayName);
    await createUserDialog.getByRole("button", { name: "Create", exact: true }).click();

    // 成功訊號：dialog 關閉＋新使用者出現在表格（同 03 spec 慣例）。
    await expect(createUserDialog).not.toBeVisible();
    await expect(adminPage.getByText(linkedEmail)).toBeVisible();
  } finally {
    await adminContext.close();
  }

  // ── control 預置同 email（已驗證、sub 不同於情境一）─────────────────
  const controlResponse = await request.put(CONTROL_URL, {
    data: { sub: "existing-user-linked-1", email: linkedEmail, email_verified: true, name: idpNameClaim },
  });
  expect(controlResponse.ok()).toBe(true);

  // ── 新 context 點 SSO：應連結既有帳號，不落 /change-password ───────────
  const ssoContext = await browser.newContext();
  try {
    const ssoPage = await ssoContext.newPage();
    await ssoPage.goto("/login");
    await ssoPage.getByRole("link", { name: "Continue with SSO" }).click();

    // gate.invalidate 鏈的 E2E 面：直接落 "/"，不是 "/change-password"。
    await expect(ssoPage).toHaveURL(/\/$/, { timeout: 20_000 });

    // 機器斷言「連結而非建帳」：UserMenu 顯示 admin 代建時的 displayName，
    // 不是 IdP 的 name claim。
    await expect(ssoPage.getByRole("button", { name: adminCreatedDisplayName, exact: true })).toBeVisible();
    await expect(ssoPage.getByText(idpNameClaim)).toHaveCount(0);
  } finally {
    await ssoContext.close();
  }

  // ── 雙路承諾：連結後帳密路徑（admin 代建時設定的密碼）亦可登入同一帳號 ─────
  // OIDC 連結已清 mustChangePassword，帳密登入不該被導去 /change-password。
  const passwordContext = await browser.newContext();
  try {
    const passwordPage = await passwordContext.newPage();
    await loginAs(passwordPage, linkedEmail, tempPassword);
    await expect(passwordPage).toHaveURL(/\/$/);
    await expect(passwordPage.getByRole("button", { name: adminCreatedDisplayName, exact: true })).toBeVisible();
  } finally {
    await passwordContext.close();
  }
});
