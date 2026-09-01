import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

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
 *
 * 交還控制權前等兩件事，**順序刻意是「先連線、後編輯器」**：Hocuspocus 共編連線
 * 真的連上（`ConnectionBadge` 顯示「Connected」），然後編輯器節點掛上。連線屏障是
 * issue #33 要的顯式前置條件；放在前面是因為 `contenteditable="true"` 如今隱含
 * 「已同步 ⟹ 已連線」（見下段），倒過來放的話，握手卡死時會先在 contenteditable
 * 那行逾時、報「編輯器沒掛上」這個誤導訊息，連線屏障一次都輪不到執行。
 *
 * 歷史與現況（2026-08-24 強制延遲 collab-token 的實驗核實）：#33 的成因——字被
 * `@hocuspocus/provider` 排進尚未連線的 `messageQueue`、隨即 reload 就永久丟掉——
 * 已被 #48 順帶封死：「從未同步」的筆記唯讀（`NotePage` 的
 * `editable = roleCanEdit && synced`），BlockNote 唯讀時 ProseMirror 根本不掛
 * `contenteditable="true"`，所以下面第二道 `waitFor` 如今**隱含**等到首次 sync 完成。
 * 但那是寄生在 #48 的唯讀行為上：哪天編輯器改成「未同步也可編輯」（local-first，
 * `NotePage` 的註解正暗示這個方向），這裡沒有顯式屏障的話 flake 會原樣復活。
 * 等「Connected」讓這個前置條件寫在測試自己身上，而不是賭產品碼永遠幫忙擋。
 * （流程 3 在自己的 spec 裡對 **userPage** 另有一道同款屏障——那個 page 不經過
 * `createNote`；所有走 `createNote` 的 page（流程 1／2／3 的 adminPage／4）都由這裡涵蓋。）
 */
export async function createNote(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New note" }).click();
  // #122 首跳：新筆記的 canonical 是 /n/<handle>/untitled-<uuid8>（slug 吃 DB default）
  await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });

  const titleInput = page.getByLabel("Note title");
  await titleInput.fill(title);
  await titleInput.blur();

  // #122（plan gate m15）：**斷第二跳**——title 存檔 → server 重算 auto slug →
  // NotePage 收斂 effect 把網址換成 /n/<handle>/<title-slug>。只斷 /\/n\// 會在首跳
  // 就提前通過，後續的 URL 相關斷言全變競態。
  // 已知邊界：predicate 排除任何 untitled-<8hex> 尾形——若日後某測試讓標題退化成
  // untitled 系列且撞到 server 的 uuid8 退位形，這裡會 15s 逾時；目前所有 createNote
  // 標題都帶 Date.now()，不會發生。
  await page.waitForURL(
    (url) => /^\/n\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );

  // 共編連線屏障：`ConnectionBadge`（`role="status"`）顯示「Connected」。用 `hasText`
  // 過濾把它與 Radix Toast 另外渲染的 `role="status"` live-region（例如流程 1 的
  // 「Password updated.」播報）區分開——同流程 3 的手法。regex 錨定開頭：`hasText`
  // 給字串是大小寫不敏感的子字串比對，未來若出現「Disconnected」之類的文案會誤中。
  //
  // 與 #48 離線升級的互動（非顯然，審查追問過）：`connected 但尚未 synced` 超過 3 秒
  // 時，badge 會暫時升級成「Not loaded — offline」而非「Connected」——但升級只在
  // `!synced` 期間持續，首次 sync 一完成就回落顯示「Connected」，所以這道等待最壞
  // 情況等同「等到首次 sync」，與下面 contenteditable 那道同預算，不會因升級而 flake。
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

  // 編輯器（BlockNote）節點掛上——呼叫端緊接著通常就要 click/type，還沒 mount 會
  // 直接找不到 contenteditable 節點。（#48 之後這行也隱含等到首次 sync，見檔頭。）
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
