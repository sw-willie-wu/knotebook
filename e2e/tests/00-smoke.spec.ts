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

// <meta name="theme-color"> 是寫死的 hex（狀態列要穩定的值），頁底色是 index.css 的 oklch token。
// 在真瀏覽器裡把 body 的計算後背景色畫到 canvas 換成 sRGB，與 meta 比對，token 改了而 hex 沒跟上就會紅。
// 裝置設定刻意與 app 主題相反：meta 要跟的是 app 內選的主題。
for (const theme of ["light", "dark"] as const) {
  test(`theme-color 等於 ${theme} 主題的頁底色（裝置設定相反）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
    await page.addInitScript((value) => window.localStorage.setItem("knotebook:theme", value), theme);
    await page.goto("/login");
    await expect(page.locator("#login-email")).toBeVisible();
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    // 首屏兩個 meta 依裝置深淺各有一個值；React 掛載後兩個都改成 app 主題的值
    await expect
      .poll(() =>
        page.evaluate(
          () => new Set([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"))).size,
        ),
      )
      .toBe(1);

    const { body, metas } = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return {
        body: [r, g, b],
        metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content") ?? ""),
      };
    });

    expect(metas).toHaveLength(2);
    for (const hex of metas) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      const meta = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // oklch → sRGB 的取整可能差 1
      for (let i = 0; i < 3; i++) expect(Math.abs(meta[i] - body[i]), `${hex} vs rgb(${body.join(", ")})`).toBeLessThanOrEqual(1);
    }
  });
}
