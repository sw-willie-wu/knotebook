import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * #106（#136／#137／#138 三棒的整條線）：外部 AI 拿 PAT 改一段筆記，正開著這篇的瀏覽器
 * 不重整就看到新內容、看到遠端游標的名牌、看到標題列的最後編輯落款；再從 ⋮ 打開 AI
 * 修改紀錄把那一發撤回，內容還原、該列顯示已撤回。
 *
 * ⚠ 名牌的斷言用**屬性**不是可見性：沒亮的時候 BlockNote 的 CSS 把 label 壓成
 * `max-width:4px; max-height:5px; color:transparent`，那個 4×5 的透明框仍然算「可見」，
 * `toBeVisible()` 在這裡是假綠。
 */
test("外部 AI 改一段：不重整看到新內容、遠端游標名牌、最後編輯落款；⋮ AI 修改紀錄撤回 → 內容還原", async ({
  page,
  browser,
  baseURL,
}) => {
  // 01-bootstrap 已把首登密碼改掉，之後所有 spec 一律用 newPassword 登入
  await loginAs(page, ADMIN.email, ADMIN.newPassword);

  const title = `E2E ai ${Date.now()}`;
  await createNote(page, title);
  const noteUrl = page.url();

  const editor = editorLocator(page);
  await editor.click();
  // ⚠ heading 一律同級：`sectionize()` 只在「同級或更淺」的 heading 才開新段，`## B` 會被
  // 併進前一段（Global Constraints 專條）。這裡只有一個 `# Section A`，改寫時也重述同級。
  await editor.pressSequentially("Intro line");
  await editor.press("Enter");
  await editor.pressSequentially("# Section A");
  await editor.press("Enter");
  await editor.pressSequentially("Original body");
  await expect(editor).toContainText("Original body");

  // §14.5 隨機化：多 spec 共用一座疊、失敗時刻意不 down，固定名稱重跑會撞 strict mode。
  // ⚠ 隨機化會改變派生出來的 agent 名稱：`deriveAgentLabel` 取第一個空白切詞 → NFKC →
  //   小寫 → 濾掉 `[^A-Za-z0-9._-]` → 截 32。名稱刻意做成「無空白、全小寫、只含 `-` 與
  //   數字、共 23 字元」，派生值就等於名稱本身，底下一律用同一個變數斷言、不另外寫死。
  const tokenName = `e2e-agent-${Date.now()}`;

  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Create API token" }).click();
  // ⚠ `getByLabel` 預設是不分大小寫的子字串比對，同頁還有 "Username"——要 exact（同 12）。
  await page.getByLabel("Name", { exact: true }).fill(tokenName);
  await page.getByLabel("Access", { exact: true }).selectOption("notes:write");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByLabel("New API token", { exact: true }).inputValue();
  expect(token).toMatch(/^knb_/);
  await page.getByRole("button", { name: "Done" }).click();

  // 回到筆記並等編輯器掛上——`editorLocator` 命中即隱含「已連線且首次同步完成」（見
  // helpers.ts 檔頭）。presence 只對**已載入**的文件掛，所以這一步是後面所有斷言的前提。
  await page.goto(noteUrl);
  await editor.waitFor();

  // **無 cookie 的 context**：用瀏覽器 context 會因為 session cookie 而通過，對 Bearer
  // 沒有鑑別力。try/finally 比照 02／12：斷言失敗時仍要釋放，否則失敗案例會在同一個
  // worker 累積殘留 context。
  const anonymous = await browser.newContext();
  try {
    const api = anonymous.request;
    const auth = { Authorization: `Bearer ${token}` };

    // ⚠ 用清單端點找 note id：以 handle／slug 解析筆記的那條路由是 cookie 專用，不在
    //   #107 D2 的 Bearer 允許清單上，用匿名 context 打會 401（`.id` 是 undefined，之後
    //   每一發都 404）。`GET /api/notes` 在清單上。
    const listRes = await api.get(`${baseURL}/api/notes`, { headers: auth });
    expect(listRes.status()).toBe(200);
    const notes = (await listRes.json()) as Array<{ id: string; title: string; ownerHandle: string }>;
    const mine = notes.find(n => n.title === title)!;
    expect(mine).toBeTruthy();
    // handle 由 DB default 產生（`user-<8hex>`），不得寫死；名牌斷言要用真的那一個。
    const handle = mine.ownerHandle;

    const contentRes = await api.get(`${baseURL}/api/notes/${mine.id}/content`, { headers: auth });
    expect(contentRes.status()).toBe(200);
    const content = (await contentRes.json()) as {
      outline: Array<{ sectionId: string; heading: string; fingerprint: string }>;
    };
    const sec = content.outline.find(o => o.heading === "Section A")!;
    expect(sec).toBeTruthy();

    // ⚠ 換一個**不同的** heading：`replace_section` 連 heading 一起換掉，用新標題才能證明
    //   游標落在「這次寫下去的第一顆」，而不是退回文件開頭（`Section A` 這篇裡就是文件
    //   開頭那一段，沿用舊標題就分不出兩者）。
    const res = await api.post(`${baseURL}/api/notes/${mine.id}/edits`, {
      headers: auth,
      data: {
        op: "replace_section",
        section_id: sec.sectionId,
        markdown: "# Section B\n\nRewritten by AI",
        if_match: sec.fingerprint,
      },
    });
    expect(res.status()).toBe(201);
    const applied = (await res.json()) as { outline: Array<{ sectionId: string; heading: string }> };

    // ① 不重整就看到新內容
    await expect(editor).toContainText("Rewritten by AI", { timeout: 10_000 });

    // ② 遠端游標名牌。BlockNote 的 `renderCursor` 產的是
    //    `bn-collaboration-cursor__base > bn-collaboration-cursor__caret > bn-collaboration-cursor__label`。
    const cursor = page.locator(".bn-collaboration-cursor__base").filter({
      has: page.locator(`.bn-collaboration-cursor__label:text-is("${handle} (${tokenName})")`),
    });

    // ②-a 裝飾真的產生了（名字牌此時可能還是收起來的：第一次現身走 awareness 的 `added`，
    //      而 BlockNote 設亮起屬性的處理常式只看 `updated`）。
    await expect(cursor).toHaveCount(1, { timeout: 15_000 });

    // ②-b 名牌真的亮得起來。**這裡再讀一次，不是為了「製造」一次 change 事件**——上面
    //      那發寫入本身就已經送過一次 `updated`，亮燈視窗早就開過。真正的理由是**時機**：
    //      前面兩個等待各有 10 秒與 15 秒逾時，真的跑到接近上限時，寫入那次留下的兩秒
    //      視窗已經關了，斷言會撲進視窗外——不是機制沒作用，是斷言下錯了時間點。這裡對
    //      **同一段**再讀一次（段落識別子直接取自上面那發 201 的 outline，不必多打一次
    //      整篇讀），游標位置不變、但 presence state 的單調遞增欄位前進 → 新舊 state 深度
    //      不等 → provider 才會發 `change` → 在斷言前就地重開一次兩秒視窗，不必賭前面的
    //      等待實際花了多久。
    const secB = applied.outline.find(o => o.heading === "Section B")!;
    expect(secB).toBeTruthy();
    const reread = await api.get(`${baseURL}/api/notes/${mine.id}/content?section=${secB.sectionId}`, { headers: auth });
    expect(reread.status()).toBe(200);
    await expect(cursor).toHaveAttribute("data-active", "", { timeout: 10_000 });

    // ③ 標題列的最後編輯落款（`useCollab` 收到遠端 update → debounce 3 s → 失效 note query）
    await expect(page.getByTestId("last-edited")).toContainText(`(${tokenName})`, { timeout: 15_000 });

    // ④ ⋮ → AI 修改紀錄 → 撤回 → 內容還原
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI edit history" }).click();
    await page.getByRole("button", { name: "Revert", exact: true }).first().click();
    await expect(editor).toContainText("Original body", { timeout: 10_000 });
    await expect(editor).not.toContainText("Rewritten by AI");
    // ⚠ 成功 toast 的文案（`aiEdits.revertOk`）與列上的「已撤回」標記（`aiEdits.reverted`）
    //   是兩個互不為子字串的字串——否則 dialog 還開著時兩個節點都中，strict mode violation。
    //   `exact: true` 另外避開 Radix Toast 的 `role="status"` live-region（01／03 的同款雷）。
    await expect(page.getByText("Edit reverted.", { exact: true })).toBeVisible();
    // ⑤ spec 的 e2e 情境逐字要求「該列顯示已撤回」——`useRevertEdit` 的 onSuccess 失效
    //    修改紀錄清單（`apps/web/src/api/noteEdits.ts`），dialog 重抓後那一列的
    //    `revertable` 變 false、`revertedAt` 非 null，`AiEditsDialog.tsx` 就會把
    //    Revert 按鈕換成這個字串（`aiEdits.reverted`，與上面的 toast 文案不互為子字串）。
    await expect(page.getByText("Already reverted", { exact: true })).toBeVisible();
  } finally {
    await anonymous.close();
  }
});
