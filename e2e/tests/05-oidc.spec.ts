import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { ADMIN, loginAs, randomEmail } from "./helpers.js";

/**
 * §14.5 流程 5（#187 改寫）：SSO 兩情境（fake-idp）。e2e 疊仍設 OIDC_* 三變數——新版第一次啟動把它們匯入成名為「SSO」的
 * legacy provider（舊回呼網址 /api/auth/oidc/callback），所以按鈕是「Sign in with SSO」。這同時是 env 匯入與舊回呼網址的 e2e 面。
 *
 * control endpoint 走 `http://localhost:9400/control/next-login`（`request` fixture 不吃瀏覽器的 host-resolver-rules）。
 * 識別值一律隨機化（sub、email）：腳本失敗時不 down 疊，重跑會吃到髒資料（[[knotebook-local-workflow]]）。
 */

const CONTROL_URL = "http://localhost:9400/control/next-login";
const SSO_BUTTON = "Sign in with SSO";

test("情境一：SSO 登入未知 email → 自動建帳並登入", async ({ request, browser }) => {
  const email = randomEmail();
  const controlResponse = await request.put(CONTROL_URL, {
    data: { sub: `e2e-new-${randomUUID()}`, email, email_verified: true, name: "E2E New User" },
  });
  expect(controlResponse.ok()).toBe(true);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "E2E New User", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

/**
 * 情境二（#187 改寫，spec §14.3）：admin 代建帳號（`mustChangePassword: true`）→ 同 email 的 SSO 首登**不再自動連結**（S5）
 * → `/link-account` 輸入代建密碼 → 連結成功後被導去 `/change-password`（B15：只有改密碼會清旗標）→ 改密碼 → 進站；之後 SSO
 * 直接進站；結尾的「雙路承諾」改成新密碼可登、臨時密碼已登不進（r3-N8）。
 * fake-idp 的 `name` claim 刻意與代建的顯示名不同——UserMenu 顯示哪一個，就是「連到既有帳號」與「誤建新帳號」的分野。
 */
test("情境二：SSO 首登 email 命中代建帳號 → 輸入代建密碼連結 → 先改密碼 → 之後 SSO 直接進站", async ({ request, browser }) => {
  const linkedEmail = randomEmail();
  const tempPassword = "e2e-oidc-linked-user-pw";
  const newPassword = "e2e-oidc-linked-user-pw-2";
  const displayName = "E2E OIDC Linked User";
  const idpNameClaim = "IdP Claimed Name (must not appear)";
  const sub = `e2e-linked-${randomUUID()}`;

  // ── admin 代建（自建，不依賴其他 spec 的帳號）──────────────────────────────
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await adminPage.getByRole("button", { name: "admin", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/admin\/users$/);
    await adminPage.getByRole("button", { name: "Create user" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "Create user" });
    await dialog.locator("#admin-create-email").fill(linkedEmail);
    await dialog.locator("#admin-create-password").fill(tempPassword);
    await dialog.locator("#admin-create-display-name").fill(displayName);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(adminPage.getByText(linkedEmail)).toBeVisible();
  } finally {
    await adminContext.close();
  }

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email: linkedEmail, email_verified: true, name: idpNameClaim } });
    expect(res.ok()).toBe(true);
  };

  // ── SSO 首登 → 連結頁 → 以代建密碼確認 → 被導去改密碼 → 改完進站 ──────────────
  await putLogin();
  const ssoContext = await browser.newContext();
  try {
    const page = await ssoContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
    await expect(page.getByText(`This email (${linkedEmail}) already has an account.`, { exact: false })).toBeVisible();
    await page.getByLabel("Password for this account").fill(tempPassword);
    await page.getByRole("button", { name: "Confirm with password and link" }).click();
    await expect(page).toHaveURL(/\/change-password$/);
    await page.locator("#change-password-current").fill(tempPassword);
    await page.locator("#change-password-new").fill(newPassword);
    await page.locator("#change-password-confirm").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
    await expect(page.getByText(idpNameClaim)).toHaveCount(0);
  } finally {
    await ssoContext.close();
  }

  // ── 之後同一個 IdP 身分 SSO 直接進站（已連結、旗標已由改密碼清掉）──────────────
  await putLogin();
  const againContext = await browser.newContext();
  try {
    const page = await againContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await againContext.close();
  }

  // ── 雙路承諾（r3-N8）：新密碼可登、顯示名不變；臨時密碼已登不進 ───────────────────
  const passwordContext = await browser.newContext();
  try {
    const page = await passwordContext.newPage();
    await loginAs(page, linkedEmail, newPassword);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await passwordContext.close();
  }
  const staleContext = await browser.newContext();
  try {
    const page = await staleContext.newPage();
    await page.goto("/login");
    await page.locator("#login-email").fill(linkedEmail);
    await page.locator("#login-password").fill(tempPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Incorrect email or password.");
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await staleContext.close();
  }
});
