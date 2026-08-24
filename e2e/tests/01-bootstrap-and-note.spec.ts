import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * §14.5 流程 1：env bootstrap admin 首登 → 被 `ChangePasswordGate` 強制導向
 * `/change-password` → 改密 → 回 `/` → 建筆記、打字、重整後內容還在。
 *
 * 這是 `mustChangePassword` 全鏈唯一的 E2E 覆蓋（token 流程已退役，見 §14.2）——
 * `ADMIN.password` 只在這一支 spec 用得到一次，改密成功後全疊唯一密碼變成
 * `ADMIN.newPassword`，後續 spec（02+）一律直接用新密碼登入。
 */
test("env admin 首登強改密 → 建筆記 → 重整後內容還在", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/change-password$/);

  await page.locator("#change-password-current").fill(ADMIN.password);
  await page.locator("#change-password-new").fill(ADMIN.newPassword);
  await page.locator("#change-password-confirm").fill(ADMIN.newPassword);
  await page.getByRole("button", { name: "Change password" }).click();

  // 成功訊號：導回 `/`（ChangePasswordGate 讀到 mustChangePassword:false 後放行）
  // + 成功 toast 文案（`changePassword.successMessage`）。
  await expect(page).toHaveURL(/\/$/);
  // Radix Toast 額外渲染一個 `role="status"` 的 live-region 播報「Notification
  // Password updated.」給螢幕報讀器，跟真正的 toast 文案共用「Password updated.」
  // 子字串——`exact:true` 只匹配真正的 ToastTitle 節點，避免 strict mode 兩個都中。
  await expect(page.getByText("Password updated.", { exact: true })).toBeVisible();

  const title = `E2E note ${Date.now()}`;
  await createNote(page, title);

  const editor = editorLocator(page);
  const bodyText = "Hello from Playwright";
  await editor.click();
  await editor.pressSequentially(bodyText);

  // 筆記正文走 Y.Doc 共編，server 端 `onStoreDocument` 是 debounce 2000ms 才落地
  // 到 Postgres（`STORE_DEBOUNCE_MS`，見 apps/server/src/collab/server.ts）——重整
  // 前要等這個窗口過去，否則重整後拿到的是還沒落盤的舊內容（假陰性）。T12 審查遞延：
  // 固定 `waitForTimeout(2_500)` 只是「賭」debounce 一定準時觸發＋落盤一定夠快，CI
  // 較慢的跑者上這個賭注會輸——改用 `expect(...).toPass()` 主動重試「重整＋斷言」，
  // 直到內容真的落盤為止，語意上等價但不再是固定睡眠賭時序。
  //
  // 這裡**不需要**「重整前等 client 無未同步更新」的屏障（issue #33 的建議 b）：
  // `createNote` 已保證打字發生在連線 OPEN 且首次 sync 完成之後（見 helpers.ts），而
  // `@hocuspocus/provider` 預設 `flushDelay: false`——y-prosemirror 在 transaction 結束
  // 時同步發出 Y update、provider 同步寫進已 OPEN 的 socket，`pressSequentially` 返回
  // 時每一鍵的更新都已同步交給 socket（不再進 messageQueue）。剩下的只有 server 端落盤延遲，正是上面 toPass 在等的
  //（且 @hocuspocus/server 在最後一條連線關閉時對 onStoreDocument 走 executeNow，
  // reload 掐斷唯一 client 並不會讓 debounce 中的更新蒸發）。
  await expect(async () => {
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title);
    await expect(page.locator('[data-testid="note-editor"]')).toContainText(bodyText, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});
