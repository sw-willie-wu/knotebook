import { test, expect } from "@playwright/test";

/**
 * Task 11 smoke spec：驗證 compose 疊本身起得來、app 對外可達——不碰 OIDC/AI stub，
 * 那些留給消費本疊的後續 task（12-14）。跑法見 ../../scripts/test-e2e.sh
 * （`stack:up` → `playwright test` → `stack:down`，本檔不自行管理疊的生命週期）。
 */

test("GET /healthz 回 {ok:true}", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("/login 渲染登入表單", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#login-email")).toBeVisible();
  await expect(page.locator("#login-password")).toBeVisible();
  await expect(page.getByRole("button", { name: /.+/ }).first()).toBeVisible();
});
