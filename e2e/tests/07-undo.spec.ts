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
 * 第一條維持「打兩格歷史、只撤一格、文件全程不變空」的形狀——它守的是 #97 的
 * 重掛接線，跟文件空不空無關，保持單純。
 *
 * 第二條（#100）刻意反過來**撤到空白再 redo**：修正前這是確定性失效（sync plugin
 * 的 `view.update` 把 undo 後的正規化以 `ySyncPluginKey` 這個被 tracked 的 origin
 * 寫回 Y.Doc，`UndoManager` 判定「使用者又編輯了」而清掉 redoStack；早期量測
 * `--repeat-each=12` 下 8 紅 4 綠、undo 後多等 1s 則 0/6——綠的只是按鍵搶在清空
 * 之前）。修正（`collab/undo.ts` 的 `guardEmptyDocNormalization`）後這條要**含
 * 「等超過競態窗口」仍穩定綠**，所以裡面那個 1 秒等待是測試的一部分，別當成
 * 冗餘 sleep 拿掉。
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

test("撤到空白文件後 redo 仍能復原（issue #100）", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E undo empty ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("gamma");
  await expect(editor).toContainText("gamma");

  // 正常情況打字與初始正規化在同一個 captureTimeout（500ms）內合併成單格、一撤
  // 全空、一重做全回；慢 CI 上若打字被拆成兩格，單按只走一半。兩側都用收斂迴圈
  // （多按對空堆疊／滿堆疊是 no-op，安全），測試的斷言不變：能到全空、能回 gamma。
  const undoToEmpty = async (key: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.press(key);
      if (!(await editor.textContent())?.includes("g")) break;
    }
    await expect(editor).not.toContainText("g");
  };
  const redoUntilRestored = async (key: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.press(key);
      if ((await editor.textContent())?.includes("gamma")) break;
      // 分格情境下，兩格 redo 之間會再有一次正規化競態窗口——比照下面主等待的理由。
      await page.waitForTimeout(1000);
    }
    await expect(editor).toContainText("gamma");
  };

  await undoToEmpty("Control+z");

  // ⚠ 這 1 秒是測試的一部分：正規化回寫發生在 undo 後約 12ms（下一筆 PM transaction
  // 觸發），修正前「多等必敗」（0/6）。等超過競態窗口再 redo，證明修的是機制不是運氣。
  await page.waitForTimeout(1000);
  await redoUntilRestored("Control+Shift+z");

  // 歷史還能連續走：再撤回空、再重做回來（Ctrl+Y 那一半也走一次）。
  await undoToEmpty("Control+z");
  await page.waitForTimeout(1000);
  await redoUntilRestored("Control+y");
});
