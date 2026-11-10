import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, waitForEditorSelection } from "./helpers.js";

/**
 * bulk transfer（MCP 批次讀寫）spec 2026-11-02 §18.3 六案：真瀏覽器 A 開著筆記時，agent 經 bulk 權杖下載、寫回、整包匯出。
 *
 * 隔離（PR-3 plan T5 做法）：
 * - **專用使用者**（`createUserViaInvite`）：不用 ADMIN——ADMIN 有前面各檔留下的大量筆記，額度（`transferExport` 每人每小時 10 次、
 *   `contentRead` 每人每分鐘 120 次）也是 per user。**整檔只建一支 PAT**（notes:read notes:write＝設定頁的「Create and edit notes」）。
 * - 每案建自己的資料夾與筆記，**簽 bulk 權杖一律帶 `folder_id`**（範圍只含該案的筆記）；每案 `finally` 以 `DELETE /api/transfer/token`
 *   撤掉自己的權杖（一支 PAT 同時最多 3 張）。整檔只有 E5 打整包。標記字串一律隨機（重跑、髒疊不撞名）。
 *
 * 每案的順序寫死（gate r2 N1）：① bulk 權杖單篇下載一次（拿 `base`）② A 在瀏覽器改 ③ 輪詢到 server 已有 A 的字 ④ `PUT`（E5 是整包）。
 * 規則改成「筆記動過就 409 note_changed」之後：E1–E3 的 ④ 改成預期 409；E1、E2 之後重新下載一次再寫回；E4 改成 ②③ 在 ① 之前。
 * ⚠ ③ **不准用 `GET /api/transfer/notes/:id`**：那支每呼叫一次就寫一列基底（每 (user, note) 只留 10 列，會把 ① 的基底擠掉）。
 *   改用 A 的 cookie 打 `GET /api/notes/:id/content`——`loadNoteDoc` 有 live doc 就 fork live（不讀落盤的 `note_states`）、不寫基底、
 *   cookie 讀者不 touch presence；吃 `contentRead`，所以間隔 400 ms。
 *
 * E6（橫切）：每次 `goto` 筆記頁之後先等「Note title」標題框（lazy NotePage 的 fallback AppShell 會換殼），經 `openNote` 一處做掉。
 * 本檔不 reload：E1–E4 的「A 不重整就看到」就是靠這點成立。
 * 各案彼此獨立（不設 serial）：某案紅了，worker 重開時 `beforeAll` 會再建一個使用者與一支 PAT，後面的案照跑。
 *
 * ⚠ 畫面上的段落文字用 `editorBlocks` 讀（拿掉遠端游標的名牌）：寫回之後 agent 的游標名牌（`bn-collaboration-cursor__base`）
 *   插在它寫的那一段裡，`getByText(…, { exact: true })` 會因此找不到那一段（本機首跑實測）。
 */

const POLL = { intervals: [400], timeout: 15_000 };

let userCtx: BrowserContext;
let page: Page;
let anon: BrowserContext;
let origin: string;
let pat: string;
let patId: string;

const rand = (): string => `${Date.now()}-${randomBytes(4).toString("hex")}`;

test.beforeAll(async ({ browser }) => {
  const email = randomEmail();
  const password = `bulk-e2e-${randomBytes(6).toString("hex")}`;
  const adminCtx = await browser.newContext();
  try {
    const admin = await adminCtx.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    await createUserViaInvite(admin, { email, password, displayName: "bulk e2e" });
  } finally {
    await adminCtx.close();
  }
  // 1400 寬：E3 開版本面板時預覽自動並排（同 22），左欄就是那一版的內容。
  userCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await userCtx.newPage();
  await loginAs(page, email, password);
  origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/auth/tokens", {
    data: { name: `bulk-e2e-${rand()}`, scope: "notes:read notes:write", expiresInDays: 30 },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { id: string; token: string };
  pat = body.token;
  patId = body.id;
  // 無 cookie 的 context：PAT 與 bulk 權杖的請求都從這裡發，cookie 不會替它們過認證。
  anon = await browser.newContext();
});

test.afterAll(async () => {
  try {
    if (patId) await page.request.delete(`/api/auth/tokens/${patId}`);
  } finally {
    await anon?.close();
    await userCtx?.close();
  }
});

/** 筆記頁 goto 之後：標題框（E6）→ 共編連上 → 編輯器掛上（可編輯＝已首次同步）。 */
async function openNote(url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
}

interface Case {
  noteId: string;
  /** 筆記頁的網址（`/n/<owner>/<slug>`）。 */
  url: string;
  paras: string[];
  token: string;
  bulk: APIRequestContext;
  auth: { Authorization: string };
}

/**
 * 一案的前置：個人空間根層建資料夾 → 在裡面建一篇 `n` 段的筆記（A 的 cookie）→ A 打開它 → 用 PAT 簽 bulk 權杖（帶 `folder_id`）。
 * 段落文字 `${label}-p${i}-${r}` 彼此不互為子字串（1–9 段）。
 */
async function setupCase(label: string, n: number, opts: { extra?: string; open?: boolean } = {}): Promise<Case> {
  const r = rand();
  const folder = await page.request.post("/api/folders", { data: { name: `bulk ${label} ${r}`, space: { kind: "personal" } } });
  expect(folder.status(), await folder.text()).toBe(201);
  const folderId = ((await folder.json()) as { id: string }).id;
  const paras = Array.from({ length: n }, (_, i) => `${label}-p${i + 1}-${r}`);
  const content = opts.extra === undefined ? paras.join("\n\n") : `${paras.join("\n\n")}\n\n${opts.extra}`;
  const note = await page.request.post("/api/notes", { data: { title: `E2E bulk ${label} ${r}`, content, folderId } });
  expect(note.status(), await note.text()).toBe(201);
  const dto = (await note.json()) as { id: string; slug: string; ownerHandle: string };
  const url = `/n/${dto.ownerHandle}/${dto.slug}`;
  if (opts.open !== false) {
    await openNote(url);
    await expect(editorLocator(page)).toContainText(paras[n - 1]!);
  }

  const res = await anon.request.post(`${origin}/api/mcp`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_bulk_transfer_token", arguments: { folder_id: folderId } } },
  });
  expect(res.status()).toBe(200);
  const rpc = (await res.json()) as { result?: { isError?: boolean; structuredContent?: { token: string; access: string } } };
  expect(rpc.result?.isError, JSON.stringify(rpc)).not.toBe(true);
  const sc = rpc.result!.structuredContent!;
  expect(sc.token).toMatch(/^knbt_/);
  expect(sc.access).toBe("write");
  return { noteId: dto.id, url, paras, token: sc.token, bulk: anon.request, auth: { Authorization: `Bearer ${sc.token}` } };
}

/** 每案 finally：撤掉這一案的 bulk 權杖（204）。清理失敗不得蓋掉原本的錯誤。 */
async function revokeBulk(c: Case | undefined): Promise<void> {
  if (!c) return;
  try {
    const res = await c.bulk.delete(`${origin}/api/transfer/token`, { headers: c.auth });
    expect(res.status()).toBe(204);
  } catch {
    // 盡力而為：上一個斷言若已失敗，這裡的錯誤不重要。
  }
}

/** ① 單篇下載（寫一列基底）。每案至多兩次（E1、E2 被拒後重新下載）。 */
async function download(c: Case): Promise<string> {
  const res = await c.bulk.get(`${origin}/api/transfer/notes/${c.noteId}`, { headers: c.auth });
  expect(res.status(), await res.text()).toBe(200);
  expect(res.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  const file = await res.text();
  expect(file).toContain(`\nid: ${c.noteId}\n`);
  expect(file).toMatch(/\nbase: [0-9a-f]{16}\n/);
  return file;
}

/** ④ 寫回一篇（`write.curl` 的形：PUT、`text/markdown; charset=utf-8`、body＝整個檔）。 */
async function writeBack(c: Case, file: string): Promise<Record<string, unknown>> {
  const res = await c.bulk.put(`${origin}/api/transfer/notes`, {
    headers: { ...c.auth, "Content-Type": "text/markdown; charset=utf-8" },
    data: Buffer.from(file, "utf8"),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
}

/** 把檔案裡恰好一行 `old` 換成 `neu`（agent 改那一段）。 */
function replaceLine(file: string, old: string, neu: string): string {
  const lines = file.split("\n");
  const hits = lines.flatMap((l, i) => (l === old ? [i] : []));
  expect(hits, `檔案裡「${old}」那一行應恰好一行`).toHaveLength(1);
  lines[hits[0]!] = neu;
  return lines.join("\n");
}

/** ③ 輪詢 server 的 live doc（A 的 cookie，不寫基底）直到 markdown 含全部 `needles`。 */
async function pollServer(noteId: string, needles: string[]): Promise<string> {
  let md = "";
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/notes/${noteId}/content`);
        if (res.status() !== 200) return `HTTP ${res.status()}`;
        md = ((await res.json()) as { markdown: string }).markdown;
        return needles.every(s => md.includes(s)) ? "ok" : md;
      },
      { ...POLL, message: `server 的 live doc 要含 ${JSON.stringify(needles)}` },
    )
    .toBe("ok");
  return md;
}

/**
 * A 的畫面上主編輯器的頂層 block 文字（依序）。拿掉遠端游標的裝飾（名牌節點與它前後的 U+2060）再取文字，
 * 所以斷言比的是內容、不受名牌落在哪一段影響。
 */
async function editorBlocks(): Promise<string[]> {
  return editorLocator(page).evaluate(root =>
    Array.from(root.querySelectorAll(":scope > .bn-block-group > .bn-block-outer")).map(outer => {
      const inline = outer.querySelector(".bn-inline-content");
      if (!inline) return "";
      const copy = inline.cloneNode(true) as Element;
      copy.querySelectorAll(".bn-collaboration-cursor__base").forEach(n => n.remove());
      return (copy.textContent ?? "").replace(/\u2060/g, "");
    }),
  );
}

/** A 不重整，畫面上的頂層 block 依序等於 `expected`。 */
async function expectEditorBlocks(expected: string[], message: string): Promise<void> {
  await expect.poll(editorBlocks, { timeout: 15_000, message }).toEqual(expected);
}

/** A 在某段（文字恰為 `para`）的段尾打字；`newParagraph`＝先 Enter 另起一段再打。 */
async function typeAtEndOf(para: string, text: string, newParagraph = false): Promise<void> {
  await editorLocator(page).getByText(para, { exact: true }).click();
  await page.keyboard.press("End");
  // End 是瀏覽器原生移游標，ProseMirror 要等 selectionchange 才跟上（helpers 註解）。
  await waitForEditorSelection(page);
  if (newParagraph) await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

/** ④' 寫回、預期被拒：409 base_unavailable、reason note_changed（筆記動過就拒）。 */
async function writeBackRefused(c: Case, file: string): Promise<void> {
  const res = await c.bulk.put(`${origin}/api/transfer/notes`, {
    headers: { ...c.auth, "Content-Type": "text/markdown; charset=utf-8" },
    data: Buffer.from(file, "utf8"),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(409);
  expect((JSON.parse(text) as { error: { code: string; reason: string } }).error).toMatchObject({ code: "base_unavailable", reason: "note_changed" });
}

test("E1 A 在第 2 段打字後，agent 拿舊副本寫回 → 409、什麼都沒寫；重新下載後改第 5 段 → A 不重整就看到，第 2 段 A 打的字都在", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e1", 6);
    const [p1, p2, p3, p4, p5, p6] = c.paras as [string, string, string, string, string, string];
    const stale = await download(c); // ①
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p2, ` ${aMark}`); // ②
    await pollServer(c.noteId, [`${p2} ${aMark}`]); // ③
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(stale, p5, `${p5} ${agentMark}`)); // ④ 舊副本 → 409
    await pollServer(c.noteId, [`${p1}\n\n${p2} ${aMark}\n\n${p3}\n\n${p4}\n\n${p5}\n\n${p6}`]);

    const file = await download(c); // ①' 重新下載（含 A 打的字）
    const out = await writeBack(c, replaceLine(file, p5, `${p5} ${agentMark}`)); // ④'
    expect(out).toMatchObject({ result: "applied", applied: 1, base: null });
    await expectEditorBlocks([p1, `${p2} ${aMark}`, p3, p4, `${p5} ${agentMark}`, p6], "A 不重整：第 5 段是 agent 的、第 2 段 A 打的字都在");
    await pollServer(c.noteId, [`${p1}\n\n${p2} ${aMark}\n\n${p3}\n\n${p4}\n\n${p5} ${agentMark}\n\n${p6}`]);
  } finally {
    await revokeBulk(c);
  }
});

test("E2 A 在第 3 段前插一段後，agent 拿舊副本改第 3 段 → 409；重新下載再改 → 插的段在、沒有存版", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e2", 5);
    const [p1, p2, p3, p4, p5] = c.paras as [string, string, string, string, string];
    const stale = await download(c); // ①
    const inserted = `a-inserted-${rand()}`;
    await typeAtEndOf(p2, inserted, true); // ② 第 2 段尾 Enter＝新段落落在第 3 段之前
    await pollServer(c.noteId, [`${p2}\n\n${inserted}\n\n${p3}`]); // ③ 確認是獨立一段、在第 3 段前
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(stale, p3, `${p3} ${agentMark}`)); // ④ 舊副本 → 409
    const file = await download(c);
    const out = await writeBack(c, replaceLine(file, p3, `${p3} ${agentMark}`));
    expect(out).toMatchObject({ result: "applied", applied: 1 });
    expect(out).not.toHaveProperty("version");
    expect(out).not.toHaveProperty("conflicts");
    await expectEditorBlocks([p1, p2, inserted, `${p3} ${agentMark}`, p4, p5], "A 不重整：A 插的段在、第 3 段是 agent 的");
    await pollServer(c.noteId, [`${p2}\n\n${inserted}\n\n${p3} ${agentMark}`]);
  } finally {
    await revokeBulk(c);
  }
});

test("E3 同一段兩邊都改：agent 的舊副本 → 409；A 的字留著、畫面不變、沒有存版", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e3", 5);
    const [p1, p2, p3, p4, p5] = c.paras as [string, string, string, string, string];
    const file = await download(c); // ①
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p3, ` ${aMark}`); // ②
    await pollServer(c.noteId, [`${p3} ${aMark}`]); // ③
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(file, p3, `${p3} ${agentMark}`)); // ④
    await expectEditorBlocks([p1, p2, `${p3} ${aMark}`, p4, p5], "A 的字留著、agent 的沒寫進來");
    const md = await pollServer(c.noteId, [`${p3} ${aMark}`]);
    expect(md).not.toContain(agentMark);
    const listed = await page.request.get(`/api/notes/${c.noteId}/versions?limit=100`);
    expect(listed.status()).toBe(200);
    expect(((await listed.json()) as { versions: unknown[] }).versions).toHaveLength(0);
  } finally {
    await revokeBulk(c);
  }
});

test("E4 寫回改兩區：AI 修改紀錄列出兩列 file_sync；撤回其中一列只還原那一區", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e4", 6);
    const [p1, p2, , , p5] = c.paras as [string, string, string, string, string];
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p1, ` ${aMark}`); // ② A 改的是第 1 段（不在 agent 的兩區裡）——第三輪：A 先改、agent 後下載（否則 409）
    await pollServer(c.noteId, [`${p1} ${aMark}`]); // ③
    const file = await download(c); // ① 含 A 打的字
    const m2 = `agent2-${rand()}`;
    const m5 = `agent5-${rand()}`;
    const out = await writeBack(c, replaceLine(replaceLine(file, p2, `${p2} ${m2}`), p5, `${p5} ${m5}`)); // ④ 兩區（中間隔著沒改的 3、4 段）
    expect(out).toMatchObject({ result: "applied", applied: 2 });
    const editIds = out.editIds as string[];
    expect(editIds).toHaveLength(2);

    const [, , p3, p4, , p6] = c.paras as [string, string, string, string, string, string];
    await expectEditorBlocks([`${p1} ${aMark}`, `${p2} ${m2}`, p3, p4, `${p5} ${m5}`, p6], "A 不重整：兩區都是 agent 的");

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI edit history" }).click();
    const dialog = page.getByRole("dialog", { name: "AI edits on this note" });
    await expect(dialog).toBeVisible();
    // 清單裡另有建筆記那一列（`POST /api/notes` 帶 content＝`replace_all`）；寫回的是恰好兩列 file_sync。
    const syncRows = dialog.locator('li[data-testid^="ai-edit-"]').filter({ has: page.locator("code", { hasText: /^file_sync$/ }) });
    await expect(syncRows).toHaveCount(2);
    const rowA = dialog.getByTestId(`ai-edit-${editIds[0]}`);
    const rowB = dialog.getByTestId(`ai-edit-${editIds[1]}`);
    await expect(rowA.locator("code")).toHaveText("file_sync");
    await expect(rowB.locator("code")).toHaveText("file_sync");

    // editIds 依文件順序（`record-file-sync.ts`：一句多列 INSERT ... RETURNING）：[0]＝第 2 段那一區。
    await rowA.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(page.getByText("Edit reverted.", { exact: true })).toBeVisible();
    // 只還原第 2 段那一區；另一區與 A 的字都不動。
    await expectEditorBlocks([`${p1} ${aMark}`, p2, p3, p4, `${p5} ${m5}`, p6], "撤回一列只還原那一區");
    await expect(rowA.getByText("Already reverted", { exact: true })).toBeVisible();
    await expect(rowB.getByRole("button", { name: "Revert", exact: true })).toBeVisible();
    await pollServer(c.noteId, [`${p1} ${aMark}\n\n${p2}\n\n${p3}\n\n${p4}\n\n${p5} ${m5}\n\n${p6}`]);
  } finally {
    await revokeBulk(c);
  }
});

/** E6 的豐富內容（表格、巢狀清單、checklist、code block、圖片、並排）：瀏覽器第一次打開時若有正規化寫入 Yjs，寫回會被判 note_changed。 */
const RICH = (r: string): string =>
  [
    `| h1-${r} | h2 |\n| --- | --- |\n| a | b |\n| c | d |`,
    `* outer-${r}\n  * inner\n    * deepest\n* outer two`,
    `- [ ] todo-${r}\n- [x] done`,
    "```js\nconst x = 1;\n```",
    "![alt](https://example.com/e6.png)",
    `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nleft-${r}\n\n</div>\n<div data-kb-column style="flex:1">\n\nright-${r}\n\n</div>\n</div>`,
    `tail-${r}`,
  ].join("\n\n");

test("E6 下載後才第一次在瀏覽器打開、不打字，再寫回改一段 → 200 applied、內容正確（打開筆記不算動過）", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    const r = rand();
    c = await setupCase("e6", 3, { extra: RICH(r), open: false });
    const [p1, p2, p3] = c.paras as [string, string, string];
    const file = await download(c); // ① 還沒有人在瀏覽器打開過
    await openNote(c.url); // ② 第一次打開（等標題框、連線、編輯器）
    await expect(editorLocator(page)).toContainText(`tail-${r}`);
    await page.waitForTimeout(2_000); // 不打字，讓打開時可能有的寫入先到 server
    const agentMark = `agent-${rand()}`;
    const out = await writeBack(c, replaceLine(file, p2, `${p2} ${agentMark}`)); // ④ 預期不是 409
    expect(out).toMatchObject({ result: "applied", applied: 1 });
    const md = await pollServer(c.noteId, [`${p1}\n\n${p2} ${agentMark}\n\n${p3}`]);
    for (const part of [`h1-${r}`, `outer-${r}`, "deepest", `todo-${r}`, "const x = 1;", "e6.png", `left-${r}`, `right-${r}`, `tail-${r}`]) expect(md, part).toContain(part);
    await expect(editorLocator(page)).toContainText(`${p2} ${agentMark}`);
  } finally {
    await revokeBulk(c);
  }
});

test("E5 A 打標記並持續打字（未落盤）時整包匯出：包裡那篇含標記（讀的是 live doc）", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  let typing = false;
  let typer: Promise<void> | undefined;
  try {
    c = await setupCase("e5", 4);
    const [, p2] = c.paras as [string, string];
    // 時間界線（gate r2 N7）：從閒置開始。開筆記可能帶出一次正規化寫入，store 的 debounce 是 2 s——等 3 s 讓它先落盤，
    // 之後打的第一個字重新起算 debounce 的 maxDebounce（約 10 s），在那之前 note_states 不會有標記。
    await page.waitForTimeout(3_000);
    const mark = `mk-${rand()}`;
    await editorLocator(page).getByText(p2, { exact: true }).click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    const t0 = Date.now();
    await page.keyboard.type(` ${mark}`);
    // 持續打字（每 200 ms 一字）直到匯出回應完成：store 的 2 s debounce 一直延後，落盤只會在 t0＋約 10 s（maxDebounce）。
    typing = true;
    typer = (async () => {
      while (typing) {
        await page.keyboard.type("z");
        await new Promise(r => setTimeout(r, 200));
      }
    })();
    await pollServer(c.noteId, [`${p2} ${mark}`]); // ③ live doc 已有標記

    const res = await c.bulk.get(`${origin}/api/transfer/export`, { headers: c.auth }); // ④ 整包（本檔唯一一次）
    const gz = await res.body();
    const tEnd = Date.now();
    typing = false;
    await typer;
    expect(res.status(), gz.toString("utf8").slice(0, 300)).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/gzip");
    expect(
      tEnd - t0,
      "不承重：匯出在 t0＋8 s 之後才完成——live doc 可能已經落盤（store debounce 最長約 10 s），綠也證明不了讀的是 live",
    ).toBeLessThanOrEqual(8_000);
    // 回應沒有 Content-Encoding（是 application/gzip 本體），Playwright 不會自動解壓。
    const tar = gunzipSync(gz);
    expect(tar.includes(Buffer.from(`id: ${c.noteId}\n`, "utf8")), "包裡要有這一篇").toBe(true);
    expect(tar.includes(Buffer.from(`${p2} ${mark}`, "utf8")), "包裡那篇要含 A 還沒落盤的標記").toBe(true);
  } finally {
    typing = false;
    await typer?.catch(() => undefined);
    await revokeBulk(c);
  }
});
