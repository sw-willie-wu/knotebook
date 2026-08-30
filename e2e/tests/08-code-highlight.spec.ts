import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #96：程式碼區塊語法上色的端到端驗證。單元測試已涵蓋 highlighter 契約、
 * schema 接線、CSS 變數守衛——這裡驗的是**只有真瀏覽器才驗得到**的三件事：
 * ① shiki chunk 真的被 lazy 載入且 decoration 真的畫出來（jsdom 的綠證明不了
 *    真 bundle 的 import("shiki") 能解析）；
 * ② CSS 變數真的解析出**不同的顏色**（computed style；變數沒定義時所有 token
 *    會靜默繼承同一個前景色，DOM 結構看起來完全正常）；
 * ③ 深淺主題切換時顏色真的跟著換（index.css 的 :root／.dark 兩套變數）。
 *
 * ⚠ 本檔依賴 01 已把 admin 密碼改成 ADMIN.newPassword（workers:1＋檔名序，全套跑
 * 才成立；單獨跑本檔會紅——與其他 spec 同一個已知檔序耦合，見 helpers.ts）。
 */

const codeBlock = (page: import("@playwright/test").Page) =>
  page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');

test("```ts 圍欄 → 上色出現且 token 顏色分得開 → 深淺切換換色 → 語言下拉可用", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E code highlight ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  // ``` 圍欄 input rule（結尾空白觸發）；"ts" 走 SUPPORTED_LANGUAGES 的別名映射。
  await editor.pressSequentially("```ts ");
  await expect(codeBlock(page)).toHaveCount(1);
  await expect(codeBlock(page).locator("select")).toHaveValue("typescript");

  await editor.pressSequentially('const greeting = "hello" // 註解');

  // ① 核心：shiki chunk lazy 載入 → grammar 載入 → decoration 重繪。首次要抓兩個
  // chunk（shiki 核心＋typescript grammar），給寬鬆 timeout。
  const tokens = codeBlock(page).locator(".shiki");
  await expect(tokens.first()).toBeVisible({ timeout: 20_000 });

  // ② token 顏色是 CSS 變數且**解析得出相異顏色**。inline style 斷言鎖住「走的是
  // css-variables theme」；computed 顏色數量鎖住「變數真的有值」——變數沒定義時
  // 瀏覽器對 var() 解析失敗、全部 token 落回繼承色，distinct 就只剩 1。
  const keywordToken = codeBlock(page).locator('.shiki[style*="--code-token-keyword"]');
  await expect(keywordToken.first()).toBeVisible();
  const lightColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(lightColors.length).toBeGreaterThan(1);

  // 淺色模式的底：--code-background #f6f8fa（不再是內建寫死的 #161616 深色方塊）。
  // 前置條件是 resolvedTheme=light——playwright 預設 colorScheme 就是 light，這裡
  // 顯式釘住，免得未來 config 改了讓這條斷言測到 dark 還以為在測 light。
  await page.emulateMedia({ colorScheme: "light" });
  const lightBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe("rgb(246, 248, 250)");

  // ③ 切到深色（app 預設跟系統走，emulateMedia 即可翻面）：底與 token 色都要換。
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(async () => {
    const darkBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).toBe("rgb(21, 24, 30)");
  }).toPass({ timeout: 5_000 });
  const darkColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(darkColors.length).toBeGreaterThan(1);
  // 兩套色值沒有交集（GitHub Light vs Dark 的 token 色完全不同）——有交集＝有變數
  // 漏了 dark 版、靜默沿用 light 色。
  for (const color of darkColors) expect(lightColors).not.toContain(color);

  // 語言下拉：修前 supportedLanguages 是空物件、下拉整個不存在。
  const options = codeBlock(page).locator("select option");
  expect(await options.count()).toBeGreaterThanOrEqual(20);
  await expect(codeBlock(page).locator('select option[value="python"]')).toHaveText("Python");
});
