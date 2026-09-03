import { expect, test } from "@playwright/test";
import { ADMIN, loginAs } from "./helpers.js";

test("PAT：設定頁建立 → 無 cookie 的 Bearer 請求可用 → 撤銷後立即 401", async ({ page, browser, baseURL }) => {
  // 01-bootstrap 已把首登密碼改掉，之後所有 spec 一律用 newPassword 登入
  await loginAs(page, ADMIN.email, ADMIN.newPassword);

  // §14.5 隨機化：多 spec 共用一座疊、失敗時刻意不 down，固定名稱在重跑時會在
  // filter({ hasText }) 撞出 strict mode violation，把真正的回歸訊息蓋掉。
  const tokenName = `E2E script ${Date.now()}`;

  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Create API token" }).click();
  // ⚠ `getByLabel` 預設是「不分大小寫的子字串比對」，而同頁 HandleSection 的
  // aria-label 是 "Username"——不加 exact 會同時命中兩個元素，strict mode violation。
  await page.getByLabel("Name", { exact: true }).fill(tokenName);
  await page.getByLabel("Access", { exact: true }).selectOption("notes:write");
  await page.getByRole("button", { name: "Create token" }).click();

  // 明文只出現這一次，用它自己的 aria-label 讀出來（不要用模糊比對）
  const tokenField = page.getByLabel("New API token", { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^knb_/);
  await page.getByRole("button", { name: "Done" }).click();

  // **無 cookie 的 context**——用瀏覽器 context 會因為 session cookie 而 200，
  // 那樣這一發對 Bearer 完全沒有鑑別力。try/finally 比照 02：斷言失敗時仍要釋放，
  // 否則失敗案例會在同一個 worker 累積殘留 context。
  const anonymous = await browser.newContext();
  try {
    const api = anonymous.request;
    const ok = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status()).toBe(200);
    // 同一支 token 也建得了筆記（scope 選的是 notes:write）
    const created = await api.post(`${baseURL}/api/notes`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: "E2E via token" },
    });
    expect(created.status()).toBe(201);

    // 撤銷——鎖定這一輪建的那一列（名稱已隨機化，前一輪殘留不會同名）
    const row = page.getByRole("listitem").filter({ hasText: tokenName });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke token" }).click();
    // 斷言「剛建的那筆消失」而不是「列表全空」——多 spec 共用一座疊，admin 帳號
    // 可能有前一輪殘留的 token（髒疊重跑時「全空」會假紅）。
    await expect(page.getByText(tokenName)).toHaveCount(0);

    const revoked = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(revoked.status()).toBe(401);
    // 「憑證無效」與「未帶憑證」是兩條不同的 challenge（RFC 6750 §3 vs §3.1），一起釘住
    expect(revoked.headers()["www-authenticate"]).toContain('error="invalid_token"');
    expect(revoked.headers()["www-authenticate"]).toContain("resource_metadata=");
  } finally {
    await anonymous.close();
  }
});
