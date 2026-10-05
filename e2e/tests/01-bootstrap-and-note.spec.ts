import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * §14.5 流程 1：env bootstrap admin 首登 → **不被強制改密碼**（#187 PR4，spec §10.1／W6）
 * → 直接進站，建筆記、打字、重整後內容還在。
 *
 * 強制改密碼（`ChangePasswordGate` → `/change-password`）的 E2E 覆蓋由 admin 代建帳號的
 * 第二使用者首登承擔：`03-share-revoke.spec.ts:61`（以及 15／16／17／18）。
 * `ADMIN.password` 是全疊唯一的 admin 密碼，後續 spec 直接用它登入。
 */
test("env admin 首登不強改密 → 直接進站、建筆記 → 重整後內容還在", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  // `toHaveURL(/\/$/)` 單獨不夠：旗標帳號登入後也會先導到 `/`（網址會短暫是 `/`），
  // 再由 ChangePasswordGate 在 render 時 `<Navigate replace>` 走，斷言可能在導走之前就通過。
  // 所以再等 AppShell 的「New note」鈕出現（旗標帳號進不了 AppShell），然後確認網址不在
  // `/change-password`；`createNote` 稍後點這顆鈕，旗標帳號會在這裡找不到鈕而紅。
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/change-password/);

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

/**
 * #99：手打完整的 markdown 連結語法 `[文字](網址)`，打完尾端 `)` 的當下轉成真連結。
 *
 * 直接以 `ADMIN.password` 登入（#187 PR4 起疊內 admin 密碼不再被改過）。
 *
 * `)` 是這條 input rule 的單一字元觸發（[[knotebook-wikilink-trigger]] 記著的「合成
 * 按鍵一次只送一個字元」限制，對這個 feature 反而無害），`pressSequentially` 逐字元
 * 送出即可測到。
 */
test("手打 markdown 連結語法 [文字](網址) 自動轉成真連結", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  const title = `E2E markdown link ${Date.now()}`;
  await createNote(page, title);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("[Anthropic](https://anthropic.com)");

  await expect(page.locator('[data-testid="note-editor"] a[href="https://anthropic.com"]')).toBeVisible();
});
