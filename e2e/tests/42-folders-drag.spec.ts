import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  dragMoveTo,
  dragTo,
  editorLocator,
  folderRow,
  loginAs,
  randomEmail,
  reEscape,
  showSidebarTab,
  submitFolderName,
  toastWithTitle,
} from "./helpers.js";

/**
 * 資料夾 PR-3c（spec §6.18 e2e 列中本 PR 的一支；A3-7 的 Chromium 可自動化部分；§6.13【推-2】）：側欄原生拖曳——放進資料夾、拖回根目錄、
 * 彈簧資料夾、A 疊 B 建資料夾（改名框關閉後才出 toast）與復原、預覽後移開不建、工作坊跨群組不給落點、拖進編輯器。
 * 每個 test 以 `createUserViaInvite` 開自己的使用者並登入它（同 40／41：資料夾會改變共用帳號的可見列）；資料以 API 建後 `goto("/")`。
 * 拖曳一律 `dragTo`／`dragMoveTo`（page.mouse，Chromium）：等待只用斷言（落點標示 `data-drop-scope`、預覽 `data-node-kind="preview"`），
 * 不寫 waitForTimeout。停留 0.5 秒的觸發（彈簧、預覽）都以「等它出現」斷言，不量時間。負向斷言前先等正向錨點；toast 斷言錨定全字。
 * 指標停在同空間、可放置、所在層深度小於 5 的另一篇筆記上 0.5 秒，就會出疊資料夾預覽（drag-zone.ts `evaluateDragOver` 的 canStack）：
 * 要「放在根層」的案（42-2）放在清單下方空白處，不放在筆記列上（見該案）。
 */

test.use({ viewport: { width: 1280, height: 720 } });

const RUN = Date.now();
const PASSWORD = "e2e-folders-drag-pw";
type FolderParent = { parentId: string } | { space: { kind: "personal" } | { kind: "group"; groupId: string } };

/** ADMIN 發邀請建一個新使用者，在 `page` 以它登入（落在 `/`）。 */
async function asNewUser(page: Page, displayName: string): Promise<void> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
}

/** POST /api/folders（根層帶 `space`、子資料夾帶 `parentId`）；回傳 id。 */
async function apiCreateFolder(page: Page, name: string, parent: FolderParent): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 建一篇筆記（不帶 content：不吃寫入節流）；可帶 `groupId`、`folderId`。回傳 id。 */
async function apiCreateNote(page: Page, title: string, place: { groupId?: string; folderId?: string } = {}): Promise<string> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 建群組（建立者＝目前使用者）；回傳 id。 */
async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 以 `page` 的身分讀 `GET /api/notes`，回傳那篇的放置（`folderId`）與所屬群組（`groupId`）。 */
async function placementOf(page: Page, noteId: string): Promise<{ folderId: string | null; groupId: string | null }> {
  const res = await page.request.get("/api/notes");
  expect(res.status()).toBe(200);
  const note = ((await res.json()) as Array<{ id: string; folderId: string | null; groupId: string | null }>).find((n) => n.id === noteId);
  if (note === undefined) throw new Error(`GET /api/notes 裡沒有 ${noteId}`);
  return { folderId: note.folderId, groupId: note.groupId };
}

async function folderIdOf(page: Page, noteId: string): Promise<string | null> {
  return (await placementOf(page, noteId)).folderId;
}

/** 側欄筆記連結（可及名稱以標題開頭；本檔各案的標題互不為前綴）。 */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** 資料夾列的主鈕（名稱 exact）：拖曳的落點與彈簧都以它為目標。 */
function folderButton(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true });
}

/** 疊資料夾預覽（StackPreview 的 `<li data-node-kind="preview">`）。 */
function previews(scope: Locator): Locator {
  return scope.locator('[data-node-kind="preview"]');
}

test("42-1 拖進資料夾：根層 N 拖到 F 列放開 → N 在 F 底下、toast「Moved to “F”」→ Undo 回根層", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Drag Into ${RUN}`;
  await asNewUser(page, "E2E Drag Into");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderButton(panel, F)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  // ── 拖到 F 列：F 的 <li> 標示為落點 → 放開（不必停留）────────────────────────────────
  await dragTo(page, noteLink(panel, N), folderButton(panel, F), {
    waitFor: () => expect(folderRow(panel, F)).toHaveAttribute("data-drop-scope", ""),
  });
  const moved = toastWithTitle(page, `Moved to “${F}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // 指標停在 toast 上：Radix 的 5 秒計時暫停，側欄斷言與 Undo 之間 toast 不會自己收掉。
  await moved.hover();
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBe(fId);
  // 放開後標示清掉
  await expect(panel.locator("[data-drop-scope]")).toHaveCount(0);

  // ── Undo → 回根層 ─────────────────────────────────────────────────────────────
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("42-2 拖回根目錄：F 裡的 N 經過根層 R 列（整份清單標示）→ 清單下方空白處放開 → N 在根層、toast「Moved to “Top level”」", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Drag Out ${RUN}`;
  const R = `E2E Drag Rest ${RUN}`;
  await asNewUser(page, "E2E Drag Out");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const noteId = await apiCreateNote(page, N, { folderId: fId });
  await apiCreateNote(page, R);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, R)).toBeVisible();
  const list = panel.locator("[data-sidebar-list]");
  const listScope = panel.locator("[data-sidebar-list] > div");

  // ── 指到根層 R 列：落點＝根目錄（整份清單的包層標示）───────────────────────────────────
  await dragTo(page, noteLink(panel, N), noteLink(panel, R), {
    drop: false,
    waitFor: () => expect(listScope).toHaveAttribute("data-drop-scope", ""),
  });
  // ── 移到清單下方空白處再放開：R 列上停滿 0.5 秒會出 R 的疊資料夾預覽（R 也是可疊的根層筆記），放在列上會變成時間賽跑；
  //    空白處同樣是根目錄、沒有計時，且移開 R 列會收起預覽（若已出現）。────────────────────────────────
  const listBox = await list.boundingBox();
  expect(listBox, "側欄清單量不到位置").not.toBeNull();
  await dragMoveTo(page, list, {
    position: { x: listBox!.width / 2, y: listBox!.height - 12 },
    waitFor: async () => {
      await expect(listScope).toHaveAttribute("data-drop-scope", "");
      await expect(previews(panel)).toHaveCount(0);
    },
  });
  await page.mouse.up();

  await expect(toastWithTitle(page, "Moved to “Top level”")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("42-3 彈簧資料夾：收合的 F 列上停住 → 自動展開出 F1 → 移到 F1 放開 → N 在 F1，F 仍展開", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Drag Spring ${RUN}`;
  await asNewUser(page, "E2E Drag Spring");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const f1Id = await apiCreateFolder(page, F1, { parentId: fId });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  const fButton = folderButton(panel, F);
  const f1Button = folderButton(panel, F1);
  await expect(f1Button).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  // ── 先收合 F（資料夾預設展開）────────────────────────────────────────────────────
  await fButton.click();
  await expect(fButton).toHaveAttribute("aria-expanded", "false");
  await expect(f1Button).toBeHidden();

  // ── 拖到 F 列停住 → 0.5 秒後展開、F1 出現（等它出現，不量時間）→ 移到 F1 列（標示）→ 放開 ─────────────
  await dragTo(page, noteLink(panel, N), fButton, {
    drop: false,
    waitFor: () => expect(f1Button).toBeVisible({ timeout: 15_000 }),
  });
  await dragMoveTo(page, f1Button, {
    waitFor: () => expect(folderRow(panel, F1)).toHaveAttribute("data-drop-scope", ""),
  });
  await page.mouse.up();

  await expect(toastWithTitle(page, `Moved to “${F1}”`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBe(f1Id);
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });
  // 結束狀態：F 展開、F1 可見。⚠ 這兩行守不到「拖曳結束不收回彈簧」：放進 F1 時 note-place 的樂觀更新與 PUT 成功都會
  // expandFolderChain(F1) 把 F 展開，彈簧就算被收回也會被它再展開。拖曳結束（dragend／離開樹）不收回由 42-3b 守；
  // 放置路徑上的收回仍被 expandFolderChain 遮住，沒有 e2e 守。
  await expect(fButton).toHaveAttribute("aria-expanded", "true");
  await expect(f1Button).toBeVisible();
});

test("42-3b 彈簧不收回：收合的 F 列上停到展開 → 移到側欄外（tab 列）放開、不放置 → F 仍展開、F1 可見", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const M = `E2E Drag Stay ${RUN}`;
  await asNewUser(page, "E2E Drag Spring Stay");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const mId = await apiCreateNote(page, M);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  const fButton = folderButton(panel, F);
  const f1Button = folderButton(panel, F1);
  await expect(f1Button).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, M)).toBeVisible();

  // ── 先收合 F（資料夾預設展開）────────────────────────────────────────────────────
  await fButton.click();
  await expect(fButton).toHaveAttribute("aria-expanded", "false");
  await expect(f1Button).toBeHidden();

  // ── 拖到 F 列停到彈簧展開（等 F1 出現）→ 移到 tab 列（清單容器外：離開樹、沒有落點）→ 放開。這條路不放置，
  //    不會有 note-place 的 expandFolderChain 替彈簧再展開一次。────────────────────────────────────
  await dragTo(page, noteLink(panel, M), fButton, {
    drop: false,
    waitFor: () => expect(f1Button).toBeVisible({ timeout: 15_000 }),
  });
  const tabs = page.getByRole("complementary").getByRole("tablist", { name: "Sidebar sections" });
  await dragMoveTo(page, tabs, {
    waitFor: () => expect(panel.locator("[data-drop-scope]")).toHaveCount(0),
  });
  await page.mouse.up();

  // M 沒被放置、仍在根層 → 再看 F 仍展開。拖曳結束沒有 DOM 標記可等；API 一來一回只是給清理留時間，不是因果錨點。
  expect(await placementOf(page, mId)).toEqual({ folderId: null, groupId: null });
  await expect(noteLink(panel, M)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), M)).toHaveCount(0);
  await expect(fButton).toHaveAttribute("aria-expanded", "true");
  await expect(f1Button).toBeVisible();
});

test("42-4 A 疊 B：N1 停在 N2 上出預覽 → 放開 → 改名框（New folder）→ 關框前沒有 toast → 存成 Stack → toast → Undo 兩篇回根層、資料夾消失", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const N1 = `E2E Drag Alpha ${RUN}`;
  const N2 = `E2E Drag Beta ${RUN}`;
  const STACK = `Stack ${RUN}`;
  await asNewUser(page, "E2E Drag Stack");
  const n1Id = await apiCreateNote(page, N1);
  const n2Id = await apiCreateNote(page, N2);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  for (const title of [N1, N2]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });

  // ── N1 拖到 N2 列停住 → 預覽出現（等它出現）→ 預覽內放開 ─────────────────────────────────
  await dragTo(page, noteLink(panel, N1), noteLink(panel, N2), {
    waitFor: () => expect(previews(panel)).toBeVisible({ timeout: 15_000 }),
  });

  // ── 改名框立刻開：預設名「New folder」；此時還沒有成功 toast（改名框關閉後才出）──────────────────────
  const dialog = page.getByRole("dialog", { name: "Rename folder", exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(input).toBeFocused({ timeout: 15_000 });
  await expect(input).toHaveValue("New folder");
  // modal 開著時 toast 區被 aria-hidden（getByRole 看不到），所以用文字找：不受 aria-hidden 影響。
  await expect(page.getByText(/^Created “/)).toHaveCount(0);

  // ── 改名存檔 → 框關 → toast「Created “Stack …” with 2 notes」→ 兩篇都在 Stack 裡 ───────────────────
  await submitFolderName(page, "Rename folder", STACK);
  const created = toastWithTitle(page, `Created “${STACK}” with 2 notes`);
  await expect(created).toBeVisible({ timeout: 15_000 });
  await created.hover();
  for (const title of [N1, N2]) await expect(noteLink(folderRow(panel, STACK), title)).toBeVisible({ timeout: 15_000 });
  const stackId = await folderIdOf(page, n1Id);
  expect(stackId).not.toBeNull();
  expect(await folderIdOf(page, n2Id)).toBe(stackId);

  // ── Undo → 兩篇回根層、資料夾消失 ─────────────────────────────────────────────────
  await created.getByRole("button", { name: "Undo", exact: true }).click();
  for (const id of [n1Id, n2Id]) await expect.poll(() => folderIdOf(page, id), { timeout: 15_000 }).toBeNull();
  for (const title of [N1, N2]) await expect(noteLink(panel, title)).toBeVisible();
  await expect(folderButton(panel, STACK)).toHaveCount(0, { timeout: 15_000 });
});

test("42-5 預覽後移開：N1 停在 N2 上出預覽 → 移到 R 列預覽收起 → 移到側欄外（tab 列）放開 → 沒有 POST /api/folders、沒有資料夾", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const N1 = `E2E Drag Gamma ${RUN}`;
  const N2 = `E2E Drag Delta ${RUN}`;
  const R = `E2E Drag Omega ${RUN}`;
  await asNewUser(page, "E2E Drag Away");
  for (const title of [N1, N2, R]) await apiCreateNote(page, title);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  for (const title of [N1, N2, R]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });
  let folderPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/folders") folderPosts += 1;
  });

  // ── N1 拖到 N2 列停住 → 預覽出現（N2 列被預覽取代）──────────────────────────────────
  await dragTo(page, noteLink(panel, N1), noteLink(panel, N2), {
    drop: false,
    waitFor: () => expect(previews(panel)).toBeVisible({ timeout: 15_000 }),
  });
  await expect(noteLink(panel, N2)).toHaveCount(0);

  // ── 移到 R 列：N2 的預覽收起、N2 列回來。只斷言「N2 的預覽」不在：停在 R 上 0.5 秒後可能出 R 的預覽（不含 N2 標題）。────────
  await dragMoveTo(page, noteLink(panel, R), {
    waitFor: async () => {
      await expect(noteLink(panel, N2)).toBeVisible();
      await expect(previews(panel).filter({ hasText: N2 })).toHaveCount(0);
    },
  });

  // ── 移到側欄外（tab 列，不在清單容器內）：離開樹 → 預覽與標示全清 → 放開 ───────────────────────
  const tabs = page.getByRole("complementary").getByRole("tablist", { name: "Sidebar sections" });
  await dragMoveTo(page, tabs, {
    waitFor: async () => {
      await expect(previews(panel)).toHaveCount(0);
      await expect(panel.locator("[data-drop-scope]")).toHaveCount(0);
    },
  });
  await page.mouse.up();

  // 結尾兩條（沒有資料夾、POST 次數 0）只是保險：放開點在清單容器外，側欄的 drop 根本不會觸發，任何實作都成立。
  // 本案主要的守衛是上面三處：預覽取代 N2 列、移到 R 後 N2 的預覽收起、移出清單後預覽與標示全清。
  // 正向錨點：三篇都還在根層（N2 列沒被預覽取代）→ 再斷言沒有建資料夾。
  for (const title of [N1, N2, R]) await expect(noteLink(panel, title)).toBeVisible();
  await expect(panel.locator('li[data-node-kind="folder"]')).toHaveCount(0);
  expect(folderPosts).toBe(0);
});

test("42-6 工作坊跨群組：G 的 g1 拖到 H 群組列 → H 不標示為落點；放開 → g1 仍在 G", async ({ page }) => {
  test.setTimeout(150_000);
  const G = `E2E Drag G ${RUN}`;
  const H = `E2E Drag H ${RUN}`;
  const GF = `GF ${RUN}`;
  const g1 = `E2E Drag InG ${RUN}`;
  const h1 = `E2E Drag InH ${RUN}`;
  await asNewUser(page, "E2E Drag Across");
  const gId = await apiCreateGroup(page, G);
  const hId = await apiCreateGroup(page, H);
  // GF 只當正向錨點：拖到它上面會標示，證明這次拖曳有被側欄接手。
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId: gId } });
  const g1Id = await apiCreateNote(page, g1, { groupId: gId });
  await apiCreateNote(page, h1, { groupId: hId });
  await page.goto("/");
  const workspace = await showSidebarTab(page, "Workspace");
  const gNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${gId}"]`);
  const hNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${hId}"]`);
  await expect(noteLink(gNode, g1)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(hNode, h1)).toBeVisible({ timeout: 15_000 });

  // ── 正向錨點：g1 拖到自己群組的 GF 列 → GF 標示 ───────────────────────────────────
  await dragTo(page, noteLink(gNode, g1), folderButton(workspace, GF), {
    drop: false,
    waitFor: () => expect(folderRow(workspace, GF)).toHaveAttribute("data-drop-scope", ""),
  });
  // ── 移到 H 群組列：GF 的標示收起、H 不標示、整個側欄沒有任何落點 ─────────────────────────
  await dragMoveTo(page, workspace.getByRole("button", { name: H, exact: true }), {
    waitFor: () => expect(folderRow(workspace, GF)).not.toHaveAttribute("data-drop-scope"),
  });
  await expect(hNode).not.toHaveAttribute("data-drop-scope");
  await expect(page.locator("[data-drop-scope]")).toHaveCount(0);
  await page.mouse.up();

  // ── 放開後只確認沒有變化：g1 仍在 G 的根層。本案的守衛是放開前那兩條（H 沒有 data-drop-scope、整頁沒有任何落點標示）；
  //    下面幾條緊接著放開讀，不宣稱守得住錯誤的放置。──────────────────────────────────────────
  await expect(noteLink(gNode, g1)).toBeVisible();
  await expect(noteLink(hNode, g1)).toHaveCount(0);
  await expect(noteLink(folderRow(workspace, GF), g1)).toHaveCount(0);
  expect(await placementOf(page, g1Id)).toEqual({ folderId: null, groupId: gId });
});

test("42-7 拖進編輯器（【推-2】）：側欄 N 拖進 P 的編輯器放下 → 網址不變、側欄沒有落點與預覽、P 多一個指向 N 的連結", async ({ page }) => {
  test.setTimeout(150_000);
  const P = `E2E Drag Page ${RUN}`;
  const N = `E2E Drag Linked ${RUN}`;
  await asNewUser(page, "E2E Drag Editor");
  await apiCreateNote(page, P);
  await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(panel, N)).toBeVisible({ timeout: 15_000 });

  // ── 開 P（SPA 導覽：等標題框是 P）→ 共編連上、編輯器可編輯 → 打一段字當放下的目標 ─────────────────────
  await noteLink(panel, P).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(P, { timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  const editor = editorLocator(page);
  await editor.waitFor({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type(`drop here ${RUN}`);
  await expect(editor).toContainText(`drop here ${RUN}`);
  const dropOuter = editor
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: /^drop here/ }) })
    .last();

  const urlBefore = page.url();
  // 側欄連結的 href 是 N 的 canonical 路徑（/n/<handle>/<slug>）。
  const nPath = await noteLink(panel, N).getAttribute("href");
  expect(nPath).toMatch(/^\/n\/[^/"]+\/[^/"]+$/);

  // ── 放在那段的右段（區塊寬的 80%）：拖曳中 BlockNote 側邊選單的按鈕疊在段首，落在按鈕上不觸發 drop（同 27 的 C1）──────────
  const box = await dropOuter.boundingBox();
  expect(box, "放下目標段量不到位置").not.toBeNull();
  await dragTo(page, noteLink(panel, N), dropOuter, { position: { x: box!.width * 0.8, y: box!.height / 2 } });

  // 正向錨點：P 的編輯器多出一個指向 N 的連結。選擇器對一般連結與 wikilink 都成立——
  // 一般連結（現行，#269「拖放進來的不轉換」）是 link mark 的 <a href="<origin>/n/…">；wikilink 的編輯頁渲染（MemberWikilink 命中態）
  // 是 <a href={canonicalNotePath(note)}>。兩者的 href 都以 N 的 canonical 路徑結尾。不斷言連結文字、絕對／相對與是否為 wikilink。
  await expect(editor.locator(`a[href$="${nPath}"]`)).toHaveCount(1, { timeout: 15_000 });
  await expect(page).toHaveURL(urlBefore);
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(page.locator("[data-drop-scope]")).toHaveCount(0);
  await expect(page.locator('[data-node-kind="preview"]')).toHaveCount(0);
});
