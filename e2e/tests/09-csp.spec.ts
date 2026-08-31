import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #101：CSP 的端到端驗證。單元測試（`security-headers.test.ts`）釘住政策內容、
 * 整合測試（`spa.test.ts`）釘住標頭有掛上去且 hash 從送出的 body 推導——**只有真瀏覽器
 * 驗得到的是「這份政策會不會把我們自己的東西擋掉」**：
 *
 * ① 首屏防閃的 inline script 必須通過（被擋的症狀是深色模式**每次開頁閃白**，
 *    而且沒有任何單元測試會紅——這是本條 issue 最主要的回歸風險）；
 * ② 共編 WebSocket（`wss://<same host>/collab`）要能連上（`connect-src 'self'`
 *    是否涵蓋同源 ws，各瀏覽器歷史上不一致）；
 * ③ 編輯器實際會用到的注入不得觸發 violation——本檔真的跑過的是：shiki 的 token
 *    inline style、slash 選單（BlockNote 浮層）、mermaid 的 lazy chunk 與產出的 SVG。
 *
 * 判準是**瀏覽器自己回報的 CSP violation**（`securitypolicyviolation` 事件），不是
 * console 字串比對——後者會隨瀏覽器改文案而靜默失效。
 *
 * ⚠ 本檔依賴 01 已把 admin 密碼改成 ADMIN.newPassword（workers:1＋檔名序，全套跑才
 * 成立；單獨跑會紅——與其他 spec 同一個已知檔序耦合，見 helpers.ts）。
 */

interface Violation {
  directive: string;
  blockedURI: string;
}

test("載入筆記＋程式碼區塊＋圖表＋共編連線：瀏覽器回報零 CSP violation", async ({ page }) => {
  const violations: Violation[] = [];
  // 在任何頁面腳本之前註冊，才抓得到首屏那一段 inline script 被擋的情形。
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });

  // 把當頁收到的 violation 搬進 test 這側累積。本檔目前**只有一次真正的文件導覽**
  // （`page.goto("/login")`），之後換筆記都是 react-router 的 client-side 導覽，收集器
  // 不會被 addInitScript 重置——所以這裡是防禦性的：哪天有人在中間加一次整頁導覽，
  // 沒有 drain 就會把前一頁的證據丟掉。（陣列不清空，同一則 violation 會被計兩次，
  // 只影響錯誤訊息不影響判定。）
  const drain = async () => {
    const collected = await page.evaluate(
      () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
    );
    violations.push(...collected);
  };

  await loginAs(page, ADMIN.email, ADMIN.newPassword);

  // 第一頁：程式碼區塊（shiki 的 lazy chunk ＋ token 的 inline style）。
  await createNote(page, `E2E csp code ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("```ts ");
  await editor.pressSequentially('const x = "hi"');
  await expect(page.locator('[data-testid="note-editor"] .shiki').first()).toBeVisible({ timeout: 20_000 });
  await drain();

  // 第二頁：mermaid（lazy chunk ＋ 注入的 inline style ＋ 產出的 SVG ＋ slash 選單這個
  // BlockNote 浮層）。⚠ 另開一篇而不是接在上面：游標若還在 code block 裡，`/diagram`
  // 會被當成程式碼文字，slash 選單不會開（首跑實測 timeout）。
  await createNote(page, `E2E csp diagram ${Date.now()}`);
  const editor2 = editorLocator(page);
  await editor2.click();
  await editor2.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("flowchart TD\n  A[Start] --> B[End]");
  await source.press("Escape");
  await expect(editorLocator(page).locator("svg[aria-roledescription]").first()).toBeVisible({
    timeout: 20_000,
  });

  // 共編連線：badge 進到 Connected＝WebSocket 沒被 connect-src 擋掉（locale 釘死 en-US，
  // 見 playwright.config.ts）。
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 20_000 });

  // 首屏防閃 script 若被擋，瀏覽器會發一則 script-src 的 violation——由下面那條總斷言
  // 涵蓋（這裡不另外宣稱「script 有跑」：那要靠時序旁證，不如直接看 violation）。
  const csp = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  );
  expect(csp, "CSP 不該用 <meta> 帶（本專案由 server 標頭帶，meta 會多一份難同步的真相）").toBeUndefined();

  await drain();
  expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);

  // ⚠ **正向對照**：上面那條「零 violation」在「CSP 根本沒送出」時也會綠——那是這個
  // repo 反覆出現的假綠形。所以這裡證明政策真的在**這個瀏覽器**生效：注入一段
  // inline script，它必須被擋（不執行）且產生一則 script-src violation。
  const pwned = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspPositiveControl = true;";
    document.head.appendChild(script);
    return (window as unknown as { __cspPositiveControl?: boolean }).__cspPositiveControl ?? false;
  });
  expect(pwned, "注入的 inline script 竟然執行了——CSP 沒有生效，上面的零 violation 是假綠").toBe(false);

  const afterControl = await page.evaluate(
    () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
  );
  // ⚠ 比對要接受 script-src **家族**：Chromium 對 `<script>` **元素**回報的
  // `violatedDirective` 是 `script-src-elem`（規範裡 script-src 的細分），不是
  // `script-src`——寫死後者會讓這條正向對照永遠紅（首跑實測）。
  expect(
    afterControl.some((v) => v.directive.startsWith("script-src")),
    `正向對照沒有拿到 script-src 家族的 violation：${JSON.stringify(afterControl)}`,
  ).toBe(true);
});
