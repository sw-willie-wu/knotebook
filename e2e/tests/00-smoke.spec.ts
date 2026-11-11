import { test, expect } from "@playwright/test";

/**
 * smoke spec：驗證 compose 疊本身起得來、app 對外可達——不碰 OIDC/AI stub，
 * 那些留給消費本疊的後續測試。跑法見 ../../scripts/test-e2e.sh
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
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

// #336：server 的單元測試用手寫的假 dist，證明不了「真映像裡真的有這些檔、且以正確 MIME 送出」。
test("GET /manifest.webmanifest 回 application/manifest+json，且 manifest 列的每張圖示與 apple-touch-icon 都 200 image/png", async ({
  request,
}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  expect(response.headers()["cache-control"]).toBe("no-cache");

  const manifest = (await response.json()) as { icons: { src: string }[] };
  // 先斷言非空：空陣列會讓下面的迴圈空轉而假綠。
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()["content-type"], icon.src).toContain("image/png");
    expect(iconResponse.headers()["cache-control"], icon.src).toBe("no-cache");
  }

  // iOS 的主畫面圖示用 index.html 的 <link rel="apple-touch-icon">，不在 manifest 裡。
  const touchIcon = await request.get("/apple-touch-icon.png");
  expect(touchIcon.status()).toBe(200);
  expect(touchIcon.headers()["content-type"]).toContain("image/png");
  expect(touchIcon.headers()["cache-control"]).toBe("no-cache");
});

test("index.html 是 no-cache，它載入的入口 script（/assets/ 底下的 hash 檔名）快取一年且 immutable", async ({ request }) => {
  const html = await request.get("/", { headers: { accept: "text/html" } });
  expect(html.status()).toBe(200);
  expect(html.headers()["cache-control"]).toBe("no-cache");

  const entry = (await html.text()).match(/<script\b[^>]*\bsrc="(\/assets\/index-[^"]+\.js)"/)?.[1];
  expect(entry, "index.html 裡找不到 /assets/index-*.js").toBeDefined();
  const script = await request.get(entry!);
  expect(script.status()).toBe(200);
  expect(script.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});
