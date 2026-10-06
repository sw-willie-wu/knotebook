import { randomUUID } from "node:crypto";
import { test, expect, type Browser } from "@playwright/test";
import { ADMIN, loginAs, randomEmail } from "./helpers.js";

/**
 * #187 e2e 19（spec §14.3）。PR2 只交 1（建第二個登入服務）與 7（停用→刪除）；2–6、6a、8 由 PR3 加進本檔。
 * 第二個服務指向 fake-idp 的路徑形 issuer `http://fake-idp:9400/b`（各自金鑰、共用 client）。
 * 識別值一律隨機化（顯示名、sub、email）：腳本失敗時不 down 疊，重跑會吃到髒資料（r2-M10、[[knotebook-local-workflow]]）。
 * control endpoint 走 `http://localhost:9400/b/control/next-login`（`request` fixture 不吃瀏覽器的 host-resolver-rules）。
 */

const SECOND_ISSUER = "http://fake-idp:9400/b";
const SECOND_CONTROL_URL = "http://localhost:9400/b/control/next-login";
const SECOND_NAME = `Second IdP ${randomUUID().slice(0, 8)}`;

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
