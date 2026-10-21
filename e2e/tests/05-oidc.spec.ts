import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

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
 * 情境二（#187 改寫，spec §14.3；#285 起改走邀請）：admin 以邀請建帳密帳號（自設密碼、不強制改密碼）→ 同 email 的 SSO 首登**不再自動連結**（S5）
 * → `/link-account` 輸入該帳號的密碼 → 連結成功後**直接進站**；之後 SSO 直接進站；
 * 結尾的「雙路承諾」是邀請時設的密碼可登、SSO 也可登（r3-N8）。
 * fake-idp 的 `name` claim 刻意與邀請時填的顯示名不同——UserMenu 顯示哪一個，就是「連到既有帳號」與「誤建新帳號」的分野。
 */
test("情境二：SSO 首登 email 命中邀請建的帳號 → 輸入該帳號密碼連結 → 直接進站 → 之後 SSO 與密碼都能登", async ({ request, browser }) => {
  const linkedEmail = randomEmail();
  const password = "e2e-oidc-linked-user-pw";
  const displayName = "E2E OIDC Linked User";
  const idpNameClaim = "IdP Claimed Name (must not appear)";
  const sub = `e2e-linked-${randomUUID()}`;

  // ── admin 建邀請、另一個 context 兌換（自建，不依賴其他 spec 的帳號）──────────────────
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email: linkedEmail, password, displayName });
  } finally {
    await adminContext.close();
  }

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email: linkedEmail, email_verified: true, name: idpNameClaim } });
    expect(res.ok()).toBe(true);
  };

  // ── SSO 首登 → 連結頁 → 以帳號密碼確認 → 直接進站 ──────────────────────────────
  await putLogin();
  const ssoContext = await browser.newContext();
  try {
    const page = await ssoContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
    await expect(page.getByText(`This email (${linkedEmail}) already has an account.`, { exact: false })).toBeVisible();
    await page.getByLabel("Password for this account").fill(password);
    await page.getByRole("button", { name: "Confirm with password and link" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
    await expect(page.getByText(idpNameClaim)).toHaveCount(0);
  } finally {
    await ssoContext.close();
  }

  // ── 之後同一個 IdP 身分 SSO 直接進站（已連結）──────────────
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

  // ── 雙路承諾（r3-N8）：邀請時設的密碼可登、SSO 也可登，顯示名不變 ───────────────────
  const passwordContext = await browser.newContext();
  try {
    const page = await passwordContext.newPage();
    await loginAs(page, linkedEmail, password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await passwordContext.close();
  }
});
