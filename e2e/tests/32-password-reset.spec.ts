import { expect, test } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * #286 管理員重設密碼（spec §10.2 新 spec 五步）：
 * 1. admin 以邀請建一位帳密使用者（`createUserViaInvite`，帳號不帶 `must_change_password`）；
 * 2. 該使用者的 context B 登入、直接建一支 PAT，
 *    以無 cookie 的 context 帶 Bearer 打 `GET /api/notes` → 200；
 * 3. admin 在使用者表產生重設連結，讀出只顯示一次的連結；
 * 4. 第三個 context C 開連結：網址列沒有 `#`、看得到帳號 email；設定新密碼、進站；
 * 5. context B 的 session 被登出（`/api/auth/me` 401、開 `/` 回登入頁）；第 2 步的 PAT 仍然 200。
 * 使用者沒有刪除 API，留著（email 帶隨機碼，比照 26）。
 */

const FIRST_PASSWORD = "e2e-t32-first-password";
const RESET_PASSWORD = "e2e-t32-reset-password";

test("32：admin 產生重設連結 → 本人設定新密碼進站 → 其他瀏覽器被登出、PAT 照常可用", async ({ browser, baseURL }) => {
  const email = randomEmail();
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const resetContext = await browser.newContext();
  const anonymous = await browser.newContext();
  try {
    // 1. admin 以邀請建帳號
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email, password: FIRST_PASSWORD, displayName: "E2E Reset User" });

    // 2. 使用者 B：登入（邀請建的帳號不會被導去改密碼）→ 建 PAT → Bearer 可用
    const userPage = await userContext.newPage();
    await loginAs(userPage, email, FIRST_PASSWORD);
    await expect(userPage).toHaveURL(/\/$/);
    const tokenRes = await userPage.request.post("/api/auth/tokens", { data: { name: `E2E t32 ${Date.now()}`, scope: "notes:read", expiresInDays: null } });
    expect(tokenRes.status()).toBe(201);
    const { token: pat } = (await tokenRes.json()) as { token: string };
    const bearer = { Authorization: `Bearer ${pat}` };
    expect((await anonymous.request.get(`${baseURL}/api/notes`, { headers: bearer })).status()).toBe(200);

    // 3. admin 在使用者表產生連結
    await adminPage.goto("/admin/users");
    await adminPage.getByRole("button", { name: `Reset password for ${email}`, exact: true }).click();
    const dialog = adminPage.getByRole("dialog", { name: "Reset password" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create link" }).click();
    const result = adminPage.getByRole("dialog", { name: "Password reset link" });
    const linkField = result.getByLabel("Link", { exact: true });
    await expect(linkField).toBeVisible();
    const link = await linkField.inputValue();
    // origin 不寫死：與 playwright config 的 baseURL 同源，由目前頁面取。
    const origin = new URL(adminPage.url()).origin;
    const prefix = `${origin}/reset-password#token=`;
    expect(link.startsWith(prefix)).toBe(true);
    expect(link.slice(prefix.length)).toMatch(/^knbp_[A-Za-z0-9_-]{43}$/);
    await result.getByRole("button", { name: "Done" }).click();
    await expect(result).toBeHidden();

    // 4. context C 開連結 → 網址列沒有 fragment → 設定新密碼 → 進站
    const resetPage = await resetContext.newPage();
    await resetPage.goto(link);
    await expect(resetPage).toHaveURL(/\/reset-password$/);
    await expect(resetPage.getByText(`For ${email}.`, { exact: false })).toBeVisible();
    await resetPage.getByLabel("New password", { exact: true }).fill(RESET_PASSWORD);
    await resetPage.getByLabel("Confirm new password", { exact: true }).fill(RESET_PASSWORD);
    await resetPage.getByRole("button", { name: "Set password" }).click();
    await expect(resetPage).toHaveURL(/\/$/, { timeout: 15_000 });

    // 5. B 被登出；PAT 照常可用
    expect((await userPage.request.get("/api/auth/me")).status()).toBe(401);
    await userPage.goto("/");
    await expect(userPage).toHaveURL(/\/login/);
    expect((await anonymous.request.get(`${baseURL}/api/notes`, { headers: bearer })).status()).toBe(200);
  } finally {
    await anonymous.close();
    await resetContext.close();
    await userContext.close();
    await adminContext.close();
  }
});
