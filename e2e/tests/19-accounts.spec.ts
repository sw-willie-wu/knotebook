import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type APIRequestContext } from "@playwright/test";
import { ADMIN, loginAs, randomEmail } from "./helpers.js";

/**
 * #187 e2e 19（spec §14.3）：1–8（含 6a）；2–6、6a、8 是 #187 PR3。
 * 第二個服務指向 fake-idp 的路徑形 issuer `http://fake-idp:9400/b`（各自金鑰、共用 client）。
 * 識別值一律隨機化（顯示名、sub、email）：腳本失敗時不 down 疊，重跑會吃到髒資料（r2-M10、[[knotebook-local-workflow]]）。
 * control endpoint 走 `http://localhost:9400/b/control/next-login`（`request` fixture 不吃瀏覽器的 host-resolver-rules）。
 */

const SECOND_ISSUER = "http://fake-idp:9400/b";
const SECOND_CONTROL_URL = "http://localhost:9400/b/control/next-login";
const SECOND_NAME = `Second IdP ${randomUUID().slice(0, 8)}`;
const ROOT_CONTROL_URL = "http://localhost:9400/control/next-login";
const NEW_PASSWORD = "e2e-accounts-password-123";

async function nextLogin(request: APIRequestContext, url: string, claims: { sub: string; email: string; name?: string }) {
  const res = await request.put(url, { data: { name: "E2E Accounts User", ...claims } });
  expect(res.ok()).toBe(true);
}

async function adminOnSignInPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Site admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: "Sign-in" }).click();
  await expect(page).toHaveURL(/\/admin\/auth$/);
  return { context, page };
}

test.describe.serial("19 帳號與登入服務（#187）", () => {
  test("19-1：admin 在 /admin/auth 建第二個登入服務 → 回呼網址 → 填 secret → 測試 → 啟用；登入頁出現按鈕、首登建帳", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    try {
      await page.getByRole("button", { name: "Add sign-in service" }).click();
      const dialog = page.getByRole("dialog", { name: "Add sign-in service" });
      await dialog.getByLabel("Template").selectOption("oidc");
      await dialog.getByLabel("Display name").fill(SECOND_NAME);
      await dialog.getByLabel("Issuer URL").fill(SECOND_ISSUER);
      await dialog.getByRole("button", { name: "Check issuer" }).click();
      await expect(dialog.getByText(`Found issuer ${SECOND_ISSUER}.`)).toBeVisible();
      await dialog.getByLabel("Client ID").fill("knotebook-e2e");
      await dialog.getByRole("button", { name: "Add", exact: true }).click();

      const steps = page.getByRole("dialog", { name: "Finish setting it up" });
      await expect(steps.getByText(/^http:\/\/localhost:3100\/api\/auth\/oidc\/callback\/[0-9a-f-]{36}$/)).toBeVisible();
      await steps.getByRole("button", { name: "Done" }).click();
      await expect(steps).not.toBeVisible();

      const card = page.getByRole("region", { name: SECOND_NAME });
      await expect(card.getByText(/No client secret yet/)).toBeVisible();
      await card.getByRole("button", { name: "Edit" }).click();
      const edit = page.getByRole("dialog", { name: "Edit sign-in service" });
      await edit.getByLabel("Client secret").fill("e2e-oidc-secret");
      await edit.getByRole("button", { name: "Save" }).click();
      await expect(edit).not.toBeVisible();
      await expect(card.getByText("Client secret saved.")).toBeVisible();

      await card.getByRole("button", { name: "Test connection" }).click();
      await expect(card.getByText(`Connection OK. The identity provider reports issuer ${SECOND_ISSUER}.`)).toBeVisible();
      await expect(card.getByText("The issuer uses plain http.")).toBeVisible();
      await card.getByRole("switch", { name: "On" }).click();
      await expect(card.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "true");
    } finally {
      await context.close();
    }

    const email = randomEmail();
    const control = await request.put(SECOND_CONTROL_URL, { data: { sub: `e2e-second-${randomUUID()}`, email, name: "E2E Second User" } });
    expect(control.ok()).toBe(true);
    const userContext = await browser.newContext();
    try {
      const page = await userContext.newPage();
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Second User", exact: true })).toBeVisible();
    } finally {
      await userContext.close();
    }
  });

  test("19-2：已登入帳號在設定頁「Link」第二個服務 → 已連結 → 另一個瀏覽器以它登入同一帳號", async ({ browser, request }) => {
    const email = randomEmail();
    const sub = `e2e-19-2-${randomUUID()}`;
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const reg = await page.request.post("/api/auth/register", { data: { email, password: NEW_PASSWORD, displayName: "E2E Linker" } });
      expect(reg.status()).toBe(201);
      await page.goto("/settings/account");
      await nextLogin(request, SECOND_CONTROL_URL, { sub, email: `other-${randomUUID()}@e2e.local` });
      await page.getByRole("button", { name: `Link ${SECOND_NAME}` }).click();
      // 整條 OIDC 來回之後才回到設定頁（URL 等待無作用——出發前就在 /settings/account，gate r1-t10-17 M3）。
      // toast 文字另有一份在 `role="status"` 的「Notification …」朗讀節點：不加 exact 會 strict mode 兩個命中（03 先例）。
      await expect(page.getByText("Sign-in service linked.", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("listitem", { name: new RegExp(SECOND_NAME) })).toBeVisible();
    } finally {
      await ctx.close();
    }
    const other = await browser.newContext();
    try {
      const page = await other.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub, email: `ignored-${randomUUID()}@e2e.local` });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Linker", exact: true })).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("19-3：帳密註冊 → 另一個瀏覽器以同 email 走 SSO → /link-account 輸密碼 → 連結進站", async ({ browser, request }) => {
    const email = randomEmail();
    const reg = await browser.newContext();
    try {
      const page = await reg.newPage();
      await page.goto("/register");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Display name (optional)").fill("E2E Registered");
      await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E Registered", exact: true })).toBeVisible();
    } finally {
      await reg.close();
    }
    const sso = await browser.newContext();
    try {
      const page = await sso.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-3-${randomUUID()}`, email });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
      await page.getByLabel("Password for this account").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Confirm with password and link" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E Registered", exact: true })).toBeVisible();
    } finally {
      await sso.close();
    }
  });

  test("19-4＋19-5：「Sign up with X」建純 SSO 帳號 → 唯一登入方式的解除鈕 disabled → 加上密碼 → 另一個瀏覽器以密碼登入", async ({ browser, request }) => {
    const email = randomEmail();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-4-${randomUUID()}`, email, name: "E2E SSO Only" });
      await page.goto("/register");
      await page.getByRole("link", { name: `Sign up with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await page.goto("/settings/account");
      const row = page.getByRole("listitem", { name: new RegExp(SECOND_NAME) });
      await expect(row.getByRole("button", { name: "Unlink" })).toBeDisabled();
      await expect(row.getByText("This is your only way to sign in, so it can't be unlinked.")).toBeVisible();
      // id 定位：Playwright 的 getByLabel 預設子字串比對，「New password」會同時命中「Confirm new password」（strict mode 錯，`05-oidc.spec.ts:87-89` 先例）。
      await page.locator("#set-password-new").fill(NEW_PASSWORD);
      await page.locator("#set-password-confirm").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Add password" }).click();
      await expect(page.getByText("Password added.", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Unlink" })).toBeEnabled();
    } finally {
      await ctx.close();
    }
    const pw = await browser.newContext();
    try {
      const page = await pw.newPage();
      await loginAs(page, email, NEW_PASSWORD);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E SSO Only", exact: true })).toBeVisible();
    } finally {
      await pw.close();
    }
  });

  test("19-6：關閉註冊 → 註冊鈕與 SSO 註冊鈕消失、/register 顯示關閉、API 403；新 email 走「Sign in with X」→ registration_disabled 文案", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    try {
      const sw = page.getByRole("switch", { name: "Allow registration" });
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "false");

      const anon = await browser.newContext();
      try {
        const p = await anon.newPage();
        await p.goto("/login");
        // 「不存在」斷言的等待點：SSO 鈕看得到＝`/api/auth/config` 已落地（註冊鈕與它同一份資料）。
        await expect(p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toBeVisible();
        await expect(p.getByRole("link", { name: "Create an account" })).toHaveCount(0);
        await p.goto("/register");
        // 同上：「關閉」文案只在 config 落地且 registration.enabled === false 時出現。
        await expect(p.getByText("This site isn't accepting new accounts right now.")).toBeVisible();
        await expect(p.getByRole("link", { name: /^Sign up with/ })).toHaveCount(0);
        const api = await p.request.post("/api/auth/register", { data: { email: randomEmail(), password: NEW_PASSWORD } });
        expect(api.status()).toBe(403);
        expect((await api.json()).error.code).toBe("registration_disabled");
        await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-6-${randomUUID()}`, email: randomEmail() });
        await p.goto("/login");
        await p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
        await expect(p.getByRole("alert")).toHaveText("This site isn't accepting new accounts right now. Please contact the site administrator.", { timeout: 20_000 });
      } finally {
        await anon.close();
      }
    } finally {
      // 髒疊重跑時 05 情境一與 19-4 會吃 registration_disabled（r2-M10）——一律開回。
      const res = await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: true } });
      expect(res.ok()).toBe(true);
      await context.close();
    }
  });

  test("19-6a：純 SSO 帳號（第一個服務 SSO）＋同 email 以第二個服務登入 → /link-account 只能以 SSO 證明 → 進站、設定頁兩個身分", async ({ browser, request }) => {
    const email = randomEmail();
    const firstSub = `e2e-19-6a-${randomUUID()}`;
    const reg = await browser.newContext();
    try {
      const page = await reg.newPage();
      await nextLogin(request, ROOT_CONTROL_URL, { sub: firstSub, email, name: "E2E Prover" });
      await page.goto("/register");
      await page.getByRole("link", { name: "Sign up with SSO" }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    } finally {
      await reg.close();
    }
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-6a-b-${randomUUID()}`, email });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
      // 容忍殘留：只斷言本輪要用的那顆在（PR3 注意事項 2）。它看得到＝pending 已落地，才能斷言密碼欄不存在
      // （落地前是「Loading…」，密碼欄本來就不在——先斷言 count 0 會在資料到之前就假綠）。
      const prove = page.getByRole("button", { name: "Confirm by signing in with SSO", exact: true });
      await expect(prove).toBeVisible();
      await expect(page.getByLabel("Password for this account")).toHaveCount(0);
      await nextLogin(request, ROOT_CONTROL_URL, { sub: firstSub, email });
      await prove.click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Prover", exact: true })).toBeVisible();
      await page.goto("/settings/account");
      await expect(page.getByRole("listitem", { name: /^SSO/ })).toBeVisible();
      await expect(page.getByRole("listitem", { name: new RegExp(SECOND_NAME) })).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("19-8：admin 連結第二服務 → 代建帳號 → 關閉帳密 → 新人以 SSO 首登、輸臨時密碼連結 → 被導去改密碼（B23 說明句）→ 進站；admin 的 session 仍有效", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    const memberEmail = randomEmail();
    const tempPassword = "e2e-19-8-temp-password";
    try {
      // 前輪殘留：admin 若已有 /b 的身分，「Link」鈕不會出現——先清（此時帳密登入開著、admin 有密碼，解除一定被允許）。
      const ids = await (await page.request.get("/api/auth/identities")).json();
      for (const identity of ids.identities as Array<{ id: string; issuer: string }>) {
        if (identity.issuer === SECOND_ISSUER) expect((await page.request.delete(`/api/auth/identities/${identity.id}`)).status()).toBe(204);
      }
      await page.goto("/settings/account");
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-8-admin-${randomUUID()}`, email: ADMIN.email });
      await page.getByRole("button", { name: `Link ${SECOND_NAME}` }).click();
      await expect(page.getByText("Sign-in service linked.", { exact: true })).toBeVisible({ timeout: 20_000 });

      await page.goto("/admin/users");
      await page.getByRole("button", { name: "Create user" }).click();
      const create = page.getByRole("dialog", { name: "Create user" });
      await create.locator("#admin-create-email").fill(memberEmail);
      await create.locator("#admin-create-password").fill(tempPassword);
      await create.locator("#admin-create-display-name").fill("E2E Closed Member");
      await create.getByRole("button", { name: "Create", exact: true }).click();
      await expect(create).not.toBeVisible();

      await page.goto("/admin/auth");
      await page.getByRole("switch", { name: "Allow password sign-in" }).click();
      const confirm = page.getByRole("dialog", { name: "Turn off password sign-in?" });
      await expect(confirm.getByText(/^Accounts with no usable sign-in service: \d+$/)).toBeVisible();
      await confirm.getByRole("button", { name: "Turn off" }).click();
      await expect(page.getByRole("switch", { name: "Allow password sign-in" })).toHaveAttribute("aria-checked", "false");

      const member = await browser.newContext();
      try {
        const p = await member.newPage();
        await p.goto("/login");
        // 「不存在」斷言的等待點：SSO 鈕看得到＝`/api/auth/config` 已落地（帳密表單在落地前照常顯示，RF5）。
        await expect(p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toBeVisible();
        await expect(p.locator("#login-email")).toHaveCount(0);
        const api = await p.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
        expect(api.status()).toBe(403);
        expect((await api.json()).error.code).toBe("password_login_disabled");

        await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-8-member-${randomUUID()}`, email: memberEmail });
        await p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
        await expect(p).toHaveURL(/\/link-account$/, { timeout: 20_000 });
        await p.getByLabel("Password for this account").fill(tempPassword);
        await p.getByRole("button", { name: "Confirm with password and link" }).click();
        await expect(p).toHaveURL(/\/change-password$/);
        await expect(
          p.getByText("This site only allows signing in through a sign-in service right now. This password won't be used to sign in for now, but you still need to replace the temporary password the site administrator set."),
        ).toBeVisible();
        await p.locator("#change-password-current").fill(tempPassword);
        await p.locator("#change-password-new").fill(NEW_PASSWORD);
        await p.locator("#change-password-confirm").fill(NEW_PASSWORD);
        await p.getByRole("button", { name: "Change password" }).click();
        await expect(p).toHaveURL(/\/$/);
        await expect(p.getByRole("button", { name: "E2E Closed Member", exact: true })).toBeVisible();
      } finally {
        await member.close();
      }

      // B25：admin 用密碼登入的 session 在關閉後仍有效。
      expect((await page.request.get("/api/auth/me")).status()).toBe(200);
    } finally {
      // 一律開回（否則髒疊重跑時 01／05 等帳密登入全掛；救不回就 stack:down，[[knotebook-local-workflow]]）。
      const res = await page.request.patch("/api/admin/auth/settings", { data: { passwordLoginEnabled: true } });
      expect(res.ok()).toBe(true);
      await context.close();
    }
  });

  test("19-7：停用（dialog 顯示人數）→ 登入頁按鈕消失 → 刪除", async ({ browser }) => {
    const { context, page } = await adminOnSignInPage(browser);
    try {
      const card = page.getByRole("region", { name: SECOND_NAME });
      await card.getByRole("switch", { name: "On" }).click();
      const dialog = page.getByRole("dialog", { name: "Turn this sign-in service off?" });
      // 不釘死人數：身分以 issuer 為鍵、刪服務後保留（§14.1-9），髒疊重跑時 `/b` 上可能已有前幾輪的身分；前輪若在刪除前失敗，
      // 殘留的同 issuer 啟用服務會讓 lockedOut 變 0（RF2）。只斷言「至少有本輪 19-1 那一個」與數字形（gate r1-t8-12 I4）。
      await expect(dialog.getByText(/^Linked accounts: [1-9]\d*$/)).toBeVisible();
      await expect(dialog.getByText(/^Of those, with no other way to sign in: \d+$/)).toBeVisible();
      await dialog.getByRole("button", { name: "Turn off" }).click();
      await expect(card.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "false");

      const anon = await browser.newContext();
      try {
        const loginPage = await anon.newPage();
        await loginPage.goto("/login");
        await expect(loginPage.getByRole("link", { name: "Sign in with SSO" })).toBeVisible();
        await expect(loginPage.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toHaveCount(0);
      } finally {
        await anon.close();
      }

      await card.getByRole("button", { name: "Delete" }).click();
      const confirm = page.getByRole("dialog", { name: "Delete this sign-in service?" });
      await confirm.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("region", { name: SECOND_NAME })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
