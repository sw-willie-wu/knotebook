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
 *
 * ⚠ **這支刻意「打兩格歷史、只撤一格、文件全程不變空」**，不是隨手寫成這樣的：
 * 「撤到空白文件之後再 redo」在**目前的程式碼上是確定性失效**的——那是 y-prosemirror
 * 自己的殘留缺陷（sync plugin 的 `view.update` 會把 undo 之後的正規化差異以
 * `ySyncPluginKey` 這個**被 tracked 的** origin 寫回 Y.Doc，`UndoManager` 於是
 * 判定「使用者又編輯了」而 `clear(false, true)` 清掉 redoStack），與 #97 這條修正
 * 無關（修正之前 undo/redo 是整組死的）。細節與實驗數據見 follow-up issue #100。
 * 早期版本的這支測試會撤到空白再 redo，量到 `--repeat-each=12` 下 8 紅 4 綠——
 * 綠的那幾發只是按鍵搶在清空之前。**維護時請保持文件不變空**，否則會把一條穩定的
 * 守門改回 flaky。
 */
test("共編筆記：Ctrl+Z 復原、Ctrl+Shift+Z 與 Ctrl+Y 重做", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E undo ${Date.now()}`);

  const editor = editorLocator(page);
  // 兩段字刻意選成「後者不是前者的子字串」，`toContainText` 才分得出來：
  // 撤掉一格後文件是 "alpha"（含 alpha、不含 beta），沒撤成功則仍是 "alphabeta"。
  await editor.click();
  await editor.pressSequentially("alpha");
  // 跨過 Yjs `UndoManager` 的 `captureTimeout`（預設 500ms），把兩次輸入切成
  // **兩格**歷史——下面才有辦法「只撤一格」而讓文件停在非空的 "alpha"。
  await page.waitForTimeout(900);
  await editor.pressSequentially("beta");
  await expect(editor).toContainText("alphabeta");

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText("beta");
  // 這一行同時是「只撤了一格」的斷言：若兩次輸入意外併成同一格，文件會變空，
  // 這裡就會紅（而不是靜默退化成「撤到空白」那個 flaky 形狀）。
  await expect(editor).toContainText("alpha");

  await page.keyboard.press("Control+Shift+z");
  await expect(editor).toContainText("alphabeta");

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText("beta");

  await page.keyboard.press("Control+y");
  await expect(editor).toContainText("alphabeta");
});
