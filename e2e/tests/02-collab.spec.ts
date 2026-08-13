import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * §14.5 流程 2：兩個獨立 `browser.newContext()`（各自獨立 cookie jar，模擬兩台
 * 裝置）同開同一篇筆記，斷言雙向即時同步。用同一個 admin 帳號登入兩個 context
 * 即可驗證——這一階段還不需要分享/第二使用者（那是 §14.5 流程 3 的範圍）。
 *
 * `ADMIN.newPassword`：01 spec 已經把疊內唯一的 admin 密碼改掉（單 worker、
 * 檔名數字排序保證 01 先跑），這裡不重跑改密流程。
 */
test("雙 browser context 即時共編：雙向文字同步", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.newPassword);
    await expect(pageA).toHaveURL(/\/$/);

    const title = `E2E collab ${Date.now()}`;
    await createNote(pageA, title);
    const noteUrl = pageA.url();

    const pageB = await contextB.newPage();
    await loginAs(pageB, ADMIN.email, ADMIN.newPassword);
    await pageB.goto(noteUrl);

    const editorA = editorLocator(pageA);
    const editorB = editorLocator(pageB);
    await editorB.waitFor({ timeout: 15_000 });

    await editorA.click();
    await editorA.pressSequentially("Hello from A");
    await expect(editorB).toContainText("Hello from A", { timeout: 10_000 });

    // 接著打字要接在既有內容之後（不是覆蓋掉剛同步進來的內容）——click 只保證聚焦，
    // 光游標位置不定，用 End 把游標移到這個 block 的尾端再打字。
    await editorB.click();
    await editorB.press("End");
    await editorB.pressSequentially(" and B");
    await expect(editorA).toContainText("Hello from A and B", { timeout: 10_000 });
  } finally {
    // try/finally：斷言失敗時仍要釋放兩個 context（否則失敗案例會在同一個 worker
    // 累積殘留 browser context，拖累後續 spec 的資源——T12 審查遞延項）。
    await contextA.close();
    await contextB.close();
  }
});
