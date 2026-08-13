import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

/**
 * 疊內建的 env bootstrap admin（見 `docker-compose.e2e.yml` 的 `ADMIN_EMAIL`/
 * `ADMIN_PASSWORD`）。**`newPassword` 只在 `01-bootstrap-and-note.spec.ts` 送出一次
 * 改密表單**——之後所有 spec（單 worker、檔名數字排序保證跑在 01 之後）一律用
 * `newPassword` 登入，不重跑改密流程（§14.5 流程 1 只需被覆蓋一次）。
 */
export const ADMIN = {
  email: "admin@e2e.local",
  password: "e2e-admin-password",
  newPassword: "e2e-admin-password-2",
} as const;

/** §14.5 隨機化隔離：多 spec 共用一座疊（單 worker、不 `down -v` 於 spec 之間），
 * 建帳號一律用隨機 email 避免互撞。 */
export function randomEmail(): string {
  return `e2e-${randomUUID()}@e2e.local`;
}

/**
 * `/login` → 送出表單 → 等離開 `/login`。**不在這裡斷言最終落在哪個 URL**——
 * 首登（`mustChangePassword:true`）會被 `ChangePasswordGate` client-side 導向
 * `/change-password`，一般帳號則落在 `/`；呼叫端才知道自己期待哪一種，用
 * `expect(page).toHaveURL(...)`（本身有重試）斷言即可，這裡只保證「表單已送出且
 * 導航已經開始」。
 */
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 });
}

/**
 * 在目前已登入的 `page`（須已在 `/` 且看得到 `AppShell`）建一篇新筆記並填標題。
 * 呼叫端接手後 `page.url()` 就是這篇筆記的 canonical URL（可直接餵給另一個
 * context 的 `page.goto` 開同一篇）。
 *
 * 標題走 `TitleInput` 的 blur-即存語意（見該元件檔頭），不是 800ms debounce——
 * `.blur()` 讓存檔請求立刻送出，不必在這裡等一輪 debounce。
 */
export async function createNote(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  await page.waitForURL(/\/notes\//, { timeout: 15_000 });

  const titleInput = page.getByLabel("Note title");
  await titleInput.fill(title);
  await titleInput.blur();

  // 等編輯器（BlockNote + Hocuspocus 共編連線）真的掛上去再把控制權交還呼叫端——
  // 呼叫端緊接著通常就要打字，編輯器还沒 mount 會直接找不到 contenteditable 節點。
  await page.locator('[data-testid="note-editor"] [contenteditable="true"]').first().waitFor({ timeout: 15_000 });
}

/**
 * BlockNote（`@blocknote/mantine`）把呼叫端傳給 `<BlockNoteView data-testid=…>`
 * 的任意 prop 原樣灑在最外層 `<div class="bn-root bn-container …">` 上（見
 * `@blocknote/react` dist 內 `hi` 元件的 `{...i}` 展開）——`data-testid` 因此不會
 * 落在真正可編輯的節點，而是它的祖先。實際的 ProseMirror root 是這個 div 底下
 * 由 tiptap/prosemirror-view 在掛載時設定 `contentEditable="true"` 的子節點，因此
 * 一律用「testid 祖先 + `[contenteditable="true"]` 子孫」這個 CSS 選擇器定位，
 * 不能只用 testid 本身（click/type 會作用在容器而非真正的 ProseMirror root）。
 */
export function editorLocator(page: Page) {
  return page.locator('[data-testid="note-editor"] [contenteditable="true"]').first();
}
