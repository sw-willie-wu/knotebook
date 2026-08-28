import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #97 的迴歸守門：**共編模式下 Ctrl+Z／Ctrl+Shift+Z／Ctrl+Y 完全沒反應**。
 *
 * 為什麼非得放 e2e（單元測試那一份在 `apps/web/src/collab/undo.test.tsx`，兩邊都要）：
 * 這條缺陷的觸發條件是「ProseMirror view 被拆掉重掛一次」，而重掛是由
 * `<BlockNoteView>` 的 mount ref callback（依賴 `editable`）在 `synced` 抵達的那一刻
 * 觸發的——**真實的連線時序**。單元測試靠手動 rerender 模擬得出來，但只有這裡能證明
 * 整條「真瀏覽器 + 真 Hocuspocus 連線 + 真鍵盤事件」的路徑是通的；當初回報的症狀
 * 正是「單元測試全綠、瀏覽器按 Ctrl+Z 沒反應、console 零錯誤」。
 *
 * 三個快捷鍵都測：BlockNote 把 `Mod-z`／`Shift-Mod-z`／`Mod-y` 都接到同一個
 * `UndoManager`（`editor.undo()`／`editor.redo()`），但接線斷掉時三個一起靜默失效，
 * 逐一按過才看得出來哪一個沒接。
 */
test("共編筆記：Ctrl+Z 復原、Ctrl+Shift+Z 與 Ctrl+Y 重做", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E undo ${Date.now()}`);

  const editor = editorLocator(page);
  // 短字串是刻意的：Yjs `UndoManager` 的 `captureTimeout` 預設 500ms 會把相鄰輸入
  // 併成同一格歷史，字太長時 `pressSequentially` 有機會跨過那道門檻而分成兩格，
  // 「按一次 Ctrl+Z 就該全部消失」的斷言就會偶發性地只撤掉一半。
  const body = "undome";
  await editor.click();
  await editor.pressSequentially(body);
  await expect(editor).toContainText(body);

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText(body);

  await page.keyboard.press("Control+Shift+z");
  await expect(editor).toContainText(body);

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText(body);

  await page.keyboard.press("Control+y");
  await expect(editor).toContainText(body);
});
