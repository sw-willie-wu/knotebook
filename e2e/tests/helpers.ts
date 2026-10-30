import { randomUUID } from "node:crypto";
import { expect, request as pwRequest, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { derivedVersionName } from "../../packages/shared/src/version-names.js";

/**
 * 疊內建的 env bootstrap admin（見 `docker-compose.e2e.yml` 的 `ADMIN_EMAIL`/
 * `ADMIN_PASSWORD`）。#187 PR4 起 env 管理員首登**不強制改密碼**，所以全疊唯一密碼就是
 * `password`，所有 spec 直接用它登入（沒有「01 先改密碼、其餘 spec 用新密碼」的檔序耦合了）。
 * 強制改密碼不再有 e2e 覆蓋（代建已移除），由 `auth/guards.test.tsx`、`pages/ChangePasswordPage.test.tsx` 與 server 測試守。
 */
export const ADMIN = {
  email: "admin@e2e.local",
  password: "e2e-admin-password",
} as const;

/** §14.5 隨機化隔離：多 spec 共用一座疊（單 worker、不 `down -v` 於 spec 之間），
 * 建帳號一律用隨機 email 避免互撞。 */
export function randomEmail(): string {
  return `e2e-${randomUUID()}@e2e.local`;
}

/**
 * `/login` → 送出表單 → 等離開 `/login`。**不在這裡斷言最終落在哪個 URL**——
 * 被旗標的帳號（例如舊版代建、尚未改密碼的帳號）會被 `ChangePasswordGate` client-side 導向
 * `/change-password`，一般帳號（含 env bootstrap 管理員）則落在 `/`；呼叫端才知道自己期待哪一種，用
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
 * admin 以 API 建邀請，另開一個不帶 cookie 的 APIRequestContext 兌換——**不得用 admin 的 context**：
 * 兌換成功會 Set-Cookie 登入新帳號，蓋掉 admin 的 session。`adminPage` 須已登入且導覽過（要取 origin）。
 * 建出的帳號沒有強制改密碼，之後直接 `loginAs`。CSRF 只需 JSON content-type（`data` 自動帶，同 26 的 `call`）。
 */
export async function createUserViaInvite(
  adminPage: Page,
  user: { email: string; password: string; displayName?: string },
): Promise<void> {
  const created = await adminPage.request.post("/api/admin/invites", { data: { expiresInDays: 1 } });
  expect(created.status(), `POST /api/admin/invites → HTTP ${created.status()} ${await created.text()}`).toBe(201);
  const { token } = (await created.json()) as { token: string };
  const api = await pwRequest.newContext({ baseURL: new URL(adminPage.url()).origin });
  try {
    const accepted = await api.post("/api/auth/invite/accept", { data: { token, ...user } });
    expect(accepted.status(), `POST /api/auth/invite/accept → HTTP ${accepted.status()} ${await accepted.text()}`).toBe(201);
  } finally {
    await api.dispose();
  }
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
  // 頁尾「New note」只在 My notes／Recent／搜尋中顯示；呼叫端可能停在 Workspace／Shared with me，先切回 My notes。
  if (!(await page.getByRole("button", { name: "New note", exact: true }).isVisible())) {
    await showSidebarTab(page, "My notes");
  }
  await page.getByRole("button", { name: "New note", exact: true }).click();
  // #122 首跳：新筆記的 canonical 是 /n/<handle>/untitled-<uuid8>（slug 吃 DB default）
  await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });

  const titleInput = page.getByLabel("Note title");
  // 網址先換、畫面約 180 ms 後才換成新筆記（react-router startTransition）：只等網址就填，會填進上一篇的標題框
  // （CI 2026-10-14 run 38586250119 的 27-site-links 四支）。等新筆記的標題框（值為 Untitled）掛上再填。
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
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
  await page.locator(MAIN_EDITOR_SELECTOR).first().waitFor({ timeout: 15_000 });
}

/**
 * #263：主編輯器的 contenteditable。框選 AI 框掛在主編輯器的 DOM 之內（`editor.portalElement` 在 `.bn-container` 裡），預覽時框裡
 * 多一顆唯讀編輯器——它是 `contenteditable="false"`，本來就不會中這個選擇器；`:not(…)` 把「框內一律排除」寫明，日後框內若出現可編輯
 * 元素也不會被誤選。以主編輯器為範圍的斷言一律經 `editorLocator`。
 */
export const MAIN_EDITOR_SELECTOR = '[data-testid="note-editor"] [contenteditable="true"]:not([data-testid="selection-ai-box"] *)';

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
  return page.locator(MAIN_EDITOR_SELECTOR).first();
}

/**
 * 等編輯器（ProseMirror）把目前的 DOM selection 讀進自己的 state，才能接著按 Enter／打字。
 *
 * 點擊、End、Ctrl+End 這類游標移動是瀏覽器原生做的：DOM selection 當下就變了，但 ProseMirror 要等
 * `selectionchange` 事件（瀏覽器另排的 task）才把它讀回 `state.selection`；Enter 與一般按鍵輸入用的是
 * `state.selection`。Playwright 緊接著送的 Enter 若趕在 selectionchange 之前被處理，新段落／文字就落在
 * **上一個**游標位置（為什麼 selectionchange 會晚到輸入事件之後：推測是 Chromium 對輸入事件的排程優先序，未量測）。
 * 2026-10-10 在 e2e 疊上不經任何對話框就重現：點段尾 → End → Enter，修前 30 次錯 3 次、加本 helper 後 30/30 正確；
 * 錯的那幾次從點擊到 Enter 的 23 ms 內一個 selectionchange 都沒送到，`state.selection` 還停在前一段尾。
 * CI run 38047114343 的 22b（inserted-middle 落到 two-bottom 之後）trace 同型。所以只驗 `window.getSelection()`
 * 不夠——要對到 ProseMirror 的 state。
 *
 * ⚠ 只適用於文字游標：collapsed 的 TextSelection、caret 在文字節點內（例如段尾純文字）。NodeSelection、
 * 或 caret 在 inline atom（圖片、wikilink 等）旁時，`posAtDOM`（bias −1）跟 PM 自己讀 selection 的換算／正規化
 * 不同，可能在合法的穩定狀態下永遠對不上而超時。
 *
 * 讀的是 Tiptap 掛在 contenteditable 上的 `editor`（`view.dom.editor`）。超時時失敗訊息帶最後一次的診斷值：
 * `"no-editor"`（editor 物件沒掛上）、`{ focusOutside: … }`（activeElement／caret 不在編輯器內）、
 * `{ pm, dom }`（PM 的 selection.head 與 DOM caret 換算的位置）。
 */
export async function waitForEditorSelection(page: Page, timeout = 2_000): Promise<void> {
  await expect
    .poll(
      () =>
        editorLocator(page).evaluate((el) => {
          type View = { state: { selection: { head: number } }; posAtDOM(node: Node, offset: number): number };
          const view = (el as Element & { editor?: { view?: View } }).editor?.view;
          if (!view) return "no-editor";
          const sel = window.getSelection();
          const active = document.activeElement;
          if (!active || !el.contains(active) || !sel?.focusNode || !el.contains(sel.focusNode)) {
            return {
              focusOutside: {
                activeElement: active ? `${active.tagName}.${String(active.className).slice(0, 40)}` : null,
                caretInEditor: !!sel?.focusNode && el.contains(sel.focusNode),
              },
            };
          }
          const pm = view.state.selection.head;
          let dom: number | string;
          try {
            dom = view.posAtDOM(sel.focusNode, sel.focusOffset);
          } catch (err) {
            dom = `posAtDOM threw: ${String(err)}`;
          }
          return dom === pm ? "synced" : { pm, dom };
        }),
      { timeout, message: "ProseMirror 的 state.selection 要跟 DOM selection 對齊（值：no-editor／focusOutside／{pm, dom}）" },
    )
    .toEqual("synced");
}

/**
 * #247：站台管理是 modal。UserMenu（觸發鈕名＝displayName「admin」）→「Site admin」→ `/admin/users`，回傳該 dialog。
 * 關閉用 Esc（或 dialog 的 ✕），回到開啟前的頁面；站台管理已沒有「回筆記」連結。
 */
export async function openSiteAdmin(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Site admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  const dialog = page.getByRole("dialog", { name: "Site admin" });
  await expect(dialog).toBeVisible();
  // §11.3：等左卡目前項次標好 aria-current 才算開好（窄視窗左卡是 display:none，用 CSS locator 才不受隱藏影響）。
  await expect(dialog.locator('nav a[aria-current="page"]')).toHaveCount(1);
  return dialog;
}

/** 站台管理 modal 左卡項次（nav 的可及名稱＝面板標題「Site admin」）。 */
export async function adminNav(page: Page, item: "Users" | "Groups" | "Sign-in" | "Storage plans" | "AI agents"): Promise<void> {
  const urls = {
    Users: /\/admin\/users$/,
    Groups: /\/admin\/groups$/,
    "Sign-in": /\/admin\/login$/,
    "Storage plans": /\/admin\/storage$/,
    "AI agents": /\/admin\/ai$/,
  };
  await page.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: item, exact: true }).click();
  await expect(page).toHaveURL(urls[item]);
}

export type SidebarTabName = "Recent" | "My notes" | "Workspace" | "Shared with me" | "Trash";

/**
 * 點側欄某個 tab、等它 aria-selected，回傳同一範圍內的 tabpanel。`scope` 預設靜態側欄（complementary）；窄螢幕傳抽屜。
 * 側欄一次只渲染目前 tab 的內容：負向斷言（`toHaveCount(0)`）在看不到該類筆記的 tab 會空轉成綠，
 * 所以每個負向斷言前都要重新呼叫一次。
 */
export async function showSidebarTab(page: Page, name: SidebarTabName, scope?: Locator): Promise<Locator> {
  const root = scope ?? page.getByRole("complementary");
  const tab = root.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return root.getByRole("tabpanel");
}

/**
 * #181 PR-2c：一般 tab（我的筆記／工作坊／與我共享／最近）標題列的「Select」→ 等選取標題列的「0 selected」（lazy 的 SelectLazy chunk 到了；
 * 進入時已選一律清空）。`scope` 預設靜態側欄；窄螢幕傳抽屜。回傳 tabpanel（勾選框在裡面；動作列在 tabpanel 外、側欄底部）。
 * 垃圾桶 tab 的選取是另一套（36）。
 */
export async function startSidebarSelection(page: Page, scope?: Locator): Promise<Locator> {
  const panel = (scope ?? page.getByRole("complementary")).getByRole("tabpanel");
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await expect(panel.getByText("0 selected", { exact: true })).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * #181 PR-2c：選取模式中點某篇的勾選框（整列是 `<label>`，可及名稱以標題開頭；最近 tab 後面接位置行）。
 * 點的是 checkbox 本身：Shift 範圍讀 click 事件的 `shiftKey`。不帶 `shift` 是單列切換；`shift` 時錨點到這篇整段加入、這篇一定變成已勾。
 */
export async function toggleSelectedNote(panel: Locator, title: string, opts?: { shift?: boolean }): Promise<void> {
  const box = panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
  const wasChecked = await box.isChecked();
  await box.click(opts?.shift ? { modifiers: ["Shift"] } : undefined);
  await expect(box).toBeChecked({ checked: opts?.shift ? true : !wasChecked });
}

/**
 * 標題為 `title` 的 toast（Radix Toast 的 `<li>`，在「Notifications (F8)」region 裡）。標題用 exact 比對：Radix 另有一份
 * 「Notification …」朗讀節點（`role="status"`，約 1 秒後移除）會含同樣的子字串。同標題可能同時有好幾則（連續移入），取最新的一則。
 */
export function toastWithTitle(page: Page, title: string): Locator {
  return page
    .getByRole("region", { name: /^Notifications/ })
    .getByRole("listitem")
    .filter({ has: page.getByText(title, { exact: true }) })
    .last();
}

/**
 * #181：側欄（或傳入的範圍）裡某篇筆記列的 ⋮ →「Delete」，等該列離開清單、toast 出現；回傳 toast locator。
 * 移入不確認（spec §6.10.4）。移的是開著的那篇時，頁面會導回 `/`（同頁首 ⋮）。
 */
export async function moveNoteToTrashFromSidebar(page: Page, title: string, scope?: Locator): Promise<Locator> {
  const root = scope ?? page.getByRole("complementary");
  const actions = root.getByRole("button", { name: `Note actions for ${title}`, exact: true });
  // ⋮ 是 hover 浮出（hoverReveal），先 hover 再點（同 22 的 E7）。
  await actions.hover();
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(actions).toHaveCount(0, { timeout: 15_000 });
  const toastItem = toastWithTitle(page, "Moved to the trash");
  await expect(toastItem).toBeVisible();
  return toastItem;
}

/** #247：群組 modal。側欄群組列 ⋮ →「Members & settings」→ `/groups/<id>`；回傳 group id。 */
export async function openGroupPanel(page: Page, groupName: string): Promise<string> {
  await showSidebarTab(page, "Workspace");
  await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
  await page.getByRole("menuitem", { name: "Members & settings" }).click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  const dialog = page.getByRole("dialog", { name: groupName });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('nav a[aria-current="page"]')).toHaveCount(1);
  return new URL(page.url()).pathname.split("/")[2]!;
}

/**
 * 資料夾 PR-3b：目前 tab 的資料夾列（`li[data-node-kind="folder"]`）。以主鈕名稱 exact 找，再取最近的資料夾 `<li>` 祖先——
 * 不能用 `filter({ has })`：外層資料夾的 `<li>` 也「含」子資料夾的主鈕。
 */
export function folderRow(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true }).locator("xpath=ancestor::li[@data-node-kind='folder'][1]");
}

/**
 * 資料夾 PR-3b：按 `opener`（標題列「New folder」、群組列「New folder in G」或 ⋮ 的「New subfolder」已開出的框都可）→ 等 lazy 的
 * 新增對話框 → 輸入名稱 → Create → 等框關閉、資料夾主鈕出現（取看得見的那份：窄螢幕時靜態卡藏著）。
 */
export async function createFolder(page: Page, opener: Locator, name: string): Promise<void> {
  await opener.hover();
  await opener.click();
  await submitFolderName(page, "New folder", name);
}

/** 新增／改名對話框：等輸入框得焦點 → 填名稱 → 送出 → 等框關閉、該名稱的資料夾主鈕可見。 */
export async function submitFolderName(page: Page, title: "New folder" | "Rename folder", name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(input).toBeFocused({ timeout: 15_000 });
  await input.fill(name);
  await dialog.getByRole("button", { name: title === "New folder" ? "Create" : "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name, exact: true }).locator("visible=true").first()).toBeVisible({ timeout: 15_000 });
}

/** 資料夾 PR-3b：資料夾 ⋮（hover 浮出，先 hover）。 */
export function folderMenuButton(scope: Locator, folder: string): Locator {
  return scope.getByRole("button", { name: `Folder menu for ${folder}`, exact: true });
}

/** 資料夾 PR-3b：資料夾 ⋮ → 選一項（Radix 選單，等 menuitem 可見再點）。 */
export async function folderMenuItem(page: Page, scope: Locator, folder: string, item: string): Promise<void> {
  const trigger = folderMenuButton(scope, folder);
  await trigger.hover();
  await trigger.click();
  const menuItem = page.getByRole("menu").getByRole("menuitem", { name: item, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

/** #263：框選 AI 框（`role="region"`、`data-testid="selection-ai-box"`）。 */
export function selectionAiBox(page: Page): Locator {
  return page.getByTestId("selection-ai-box");
}

/** #263：三擊選取整段（非空選取，`getSelection()` 才吃得到）→ 按工具列的 AI 鈕 → 等框出現。 */
export async function openSelectionAiBox(page: Page, paragraphText: string): Promise<Locator> {
  await editorLocator(page).getByText(paragraphText, { exact: true }).click({ clickCount: 3 });
  await page.getByRole("button", { name: "AI", exact: true }).click();
  const box = selectionAiBox(page);
  await expect(box).toBeVisible();
  return box;
}

/** e2e 疊的 origin（`playwright.config.ts` 的 baseURL）；cookie 寫入請求帶 Origin（同 22-presentation／23）。 */
const E2E_ORIGIN = "http://localhost:3100";

/**
 * #272 §7.5：e2e 測試縫——把自動存版等待 X 設成 `seconds` 秒（null＝回站台設定）。只有 e2e 疊有這條路由
 * （`KNOTEBOOK_E2E_TEST_HOOKS=1`、PUBLIC_URL 是 localhost）；`page` 須以站台管理員登入。設定是整座疊共用的（單 worker 序列），
 * 用到的測試開頭設、`finally`（或 afterEach）設回 null。
 */
export async function setAutoWait(page: Page, seconds: number | null): Promise<void> {
  const res = await page.request.put("/api/admin/test/version-auto-wait", { headers: { Origin: E2E_ORIGIN }, data: { seconds } });
  expect(res.status(), await res.text()).toBe(204);
}

/** 目前網址（`/n/<handle>/<slug>`）那篇筆記的 id（by-path API）。 */
export async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/**
 * #272：從版本清單 API 組出某一版的完整標籤「名稱 (短 id)」（未命名＝uuid 推名，與 web 的 `versionLabel` 用同一個函式）。
 * 格式須與 web 的 `versionLabel`（`apps/web/src/components/versions/version-labels.ts`）同步（e2e 不能依賴 web 套件，只能自組）。
 */
export async function versionLabelOf(
  request: APIRequestContext,
  noteId: string,
  pick: (v: { id: string; seq: number; kind: string; name: string | null }) => boolean,
): Promise<string> {
  const res = await request.get(`/api/notes/${noteId}/versions?limit=100`);
  expect(res.ok()).toBe(true);
  const { versions } = (await res.json()) as { versions: Array<{ id: string; seq: number; kind: string; name: string | null }> };
  const v = versions.find(pick);
  if (!v) throw new Error(`versionLabelOf：清單裡沒有符合條件的版本（共 ${versions.length} 筆）`);
  return `${v.name ?? derivedVersionName(v.id)} (${v.id.slice(0, 7).toLowerCase()})`;
}

/**
 * 把字串放進 RegExp 時跳脫特殊字元（版本標籤含括號）。
 * web 另有一份同樣的 `reEscape`（`apps/web/src/test/version-fixtures.ts`；e2e 不能依賴 web 套件），兩處須同步。
 */
export function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
