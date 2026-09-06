import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { apiTokens, noteAiEdits } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testConfig, testEditingRuntime } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
/** 保留（100 筆裁切）那兩案要跑 101 次寫入，預設桶（`EDIT_LIMIT` 30/min、`TOKEN_WRITE_LIMIT`
 *  60/10min）會在第 31／61 次就 429。**兩顆都要放寬，只放一顆等於沒放**——這兩案是「99 不是 100」
 *  那條算術的唯一證據，桶沒放寬就根本跑不到第 101 次。詳見 Global Constraints 的限流桶條。 */
const looseLimiters = () => ({
  edit: new FixedWindowLimiter({ limit: 1_000, windowMs: 600_000 }),
  tokenWrite: new FixedWindowLimiter({ limit: 1_000, windowMs: 600_000 }),
});
// ⚠ 兩個 heading **同級**：`## B` 會被 `sectionize()` 併進 A 段，`outline[2]` 變 undefined
// （見 Global Constraints 的 heading 條；#136 Task 4 踩過同一格）。
async function setup(md = "# A\n\n第一段\n\n# B\n\n第二段", opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = md === "" ? await session.connect(note.id) : await seedContent(ctx, session, note.id, md);
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "MCP CLI Proxy");
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const post = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: body });
  const list = async () => (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/edits`, headers: bearer(token) })).json().edits as Array<{ id: string; op: string; revertable: boolean; revertedAt: string | null; agentLabel: string | null; heading: string; byHandle: string }>;
  const revert = (editId: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits/${editId}/revert`, headers: bearer(token) });
  return { ctx, u, note, client, token, tokenId, content, post, list, revert };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const ids = (doc: Y.Doc) => topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId, tv: 0 })}`;
/** server 上那份 live doc 的文字（斷言併發時**一律看這個**，不看 client.doc——client 的改動要經 WS 才到 server）。 */
const serverText = (s: Setup) => docText(s.ctx.collab.hocuspocus.documents.get(s.note.id)!);
/** 模擬人在瀏覽器編輯。`try { … } finally { close() }` 是硬性的——testEditingRuntime 是模組層單例，
 *  漏 close 就永久洩漏一個 in-flight 名額，重建旗標一設就整支測試檔無訊息逾時（session.ts 的 m3 不變量）。 */
async function humanEdit(s: Setup, fn: (ed: EditorSession["editor"]) => void) {
  const ses = await EditorSession.open(testEditingRuntime, s.client.doc);
  try {
    fn(ses.editor);
  } finally {
    ses.close();
  }
}
/** `client.disconnect()` 之後、要斷言 documents.size 或讀落盤結果之前的唯一等法。 */
const settled = (s: Setup) => waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

describe("撤回", () => {
  it("replace_section 撤回後內容與 id 等於原本（BlockNote 沿用給定 id——釘住）；撤回列存在、原列 reverted_at；再撤回 409；撤回撤回列 409", async () => {
    const s = await setup();
    const before = await s.content(); const idsBefore = ids(s.client.doc);
    const a = before.outline[1];
    const r = await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint });
    expect(r.statusCode).toBe(201);
    let edits = await s.list();
    expect(edits[0]).toMatchObject({ op: "replace_section", revertable: true, heading: "A", agentLabel: "mcp" });
    const rv = await s.revert(edits[0]!.id);
    expect(rv.statusCode).toBe(201);
    await waitFor("provider 收到還原", 3_000, () => docText(s.client.doc).includes("第一段"));
    expect(ids(s.client.doc)).toEqual(idsBefore);
    expect((await s.content()).fingerprint).toBe(before.fingerprint);
    edits = await s.list();
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ op: "revert", revertable: false });
    expect(edits[1]).toMatchObject({ op: "replace_section", revertable: false });
    expect(edits[1]!.revertedAt).not.toBeNull();
    expect((await s.revert(edits[1]!.id)).json().error.code).toBe("already_reverted");
    expect((await s.revert(edits[0]!.id)).json().error.code).toBe("already_reverted");
  });

  it("append 撤回消失；delete_section 三種 anchor（前一顆 after／後一顆 before／空 paragraph before 且撤回後移除）", async () => {
    const s = await setup();
    let c = await s.content();
    expect((await s.post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect((await s.content()).markdown).not.toContain("尾巴");
    c = await s.content();
    const b = c.outline[2]; // B 段：前一顆是 A 段最後一顆 → anchor after
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect((await s.content()).fingerprint).toBe(c.fingerprint);
    const t = await setup("# A\n\n一\n\n# B\n\n二"); // 同級 heading（`## B` 會併進 A 段，就沒有「第二段」可刪）
    const ct = await t.content(); const a = ct.outline[1]; // A 段在最前：沒有前一顆 → anchor before（B 的 heading）
    expect((await t.post({ op: "delete_section", section_id: a.sectionId, if_match: a.fingerprint })).statusCode).toBe(201);
    expect((await t.revert((await t.list())[0]!.id)).statusCode).toBe(201);
    expect((await t.content()).fingerprint).toBe(ct.fingerprint);
    const f = await setup("只有一段");
    const cf = await f.content();
    expect((await f.post({ op: "delete_section", section_id: "_top", if_match: cf.outline[0].fingerprint })).statusCode).toBe(201);
    expect((await f.revert((await f.list())[0]!.id)).statusCode).toBe(201);
    const after = await f.content();
    expect(after.markdown.trim()).toBe("只有一段");
    // ⚠ 這個 waitFor **不是裝飾**：`ids()` 讀的是 client.doc，撤回是 server 上合併的，要經 WS 才到。
    // 沒有它時「撤回前 1 顆（空 paragraph）／撤回後 1 顆」長度相同，斷言會在**還沒收到**的狀態下
    // 通過——規則③被刪掉（撤回後留下 2 顆）也照樣綠。等文字回來才代表那一批更新真的到了。
    await waitFor("provider 收到還原", 3_000, () => docText(f.client.doc).includes("只有一段"));
    expect(ids(f.client.doc)).toHaveLength(1); // 規則③：空 paragraph 撤回後移除
  });

  it("刪掉 anchor block → revertable:false、heading 退回 '' 且 revert 409 stale；AI 改後人再改同段 → revertable:false + 409 stale", async () => {
    const s = await setup();
    const c = await s.content(); const b = c.outline[2];
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    const [del] = await s.list();
    const anchorId = ids(s.client.doc).at(-1)!; // B 段刪掉後，文件最後一顆＝anchor（A 段最後一顆）
    // ⚠ 這裡原本的 waitFor 條件是恆真的（回傳字面 true）＝完全沒等，是個 no-op。要等的是
    // server 的 live doc 真的**不再含**那個 block id。（本檔驗收要求恆真條件出現 0 次，所以
    // 連註解裡都不重寫那個字面量。）
    await humanEdit(s, ed => ed.removeBlocks([anchorId]));
    await waitFor("server 收到刪除", 5_000, () => !serverText(s).includes(anchorId));
    const orphaned = (await s.list())[0]!;
    expect(orphaned.revertable).toBe(false);
    // `heading` 的探針對 `delete_section` 而言是 `anchor.block_id`（`after_block_ids` 是空的）。
    // 錨點被刪掉之後那顆探針在任何段落裡都查不到 → 退回空字串。這是 `?? ""` 那條分支**唯一**
    // 到得了的路徑（一般情形一定查得到），沒有這一行的話它改成任何常數都不會紅。
    expect(orphaned.heading).toBe("");
    const rv = await s.revert(del!.id);
    expect(rv.statusCode).toBe(409); expect(rv.json().error.code).toBe("stale"); expect(rv.json().current).toBeDefined();
    const t = await setup();
    const ct = await t.content(); const a = ct.outline[1];
    expect((await t.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    // ⚠ 人要改的必須是**AI 剛寫進去的那顆 block**（`after_block_ids` 之一），否則指紋不變、
    // `revertable` 仍是 true，下面兩行會綠得毫無意義。改完 fixture 後文件是
    // [0]=heading A'、[1]=「AI 版」段落（← 這顆在 after_block_ids 裡）、[2]=heading B、[3]=第二段，
    // 所以取 `document[1]`。（原本寫 `document[2]` 是配合舊的 `## B` fixture 的索引，改成同級
    // heading 之後 `[2]` 會落在 B 段——那是別段，指紋不會變。）
    await humanEdit(t, ed => ed.updateBlock(ed.document[1]!.id, { content: "人再改" }));
    await waitFor("server 收到人再改", 5_000, () => serverText(t).includes("人再改")); // 觀察 server，不是 client
    expect((await t.list())[0]!.revertable).toBe(false);
    expect((await t.revert((await t.list())[0]!.id)).json().error.code).toBe("stale");
  });

  it("撤回記錄插入失敗（beforeRevertRecord throw）→ 500：內容已還原、紀錄沒寫，該列因此變成**不可撤回**，再按一次 409 stale（replace_section 與 delete_section 各一格；delete 靠冪等守衛，頂層 id 不得重複）", async () => {
    // 失敗形（撤回路徑）：紀錄交易排在**合併之後**，所以中途失敗＝內容已還原、撤回列沒寫、
    // 原列沒標 `reverted_at`。這一案守的是「該列因此變成不可撤回、再按一次是 409 stale」。
    // ⚠ 兩個 op 的成立理由**不一樣**，所以兩格都要跑：
    //   - 非 delete 的四個 op：判準是比對 `after_block_ids` 的指紋，而還原正好把那些 block
    //     換掉了 → `revertable` 自動變 false。
    //   - `delete_section`：判準是「錨點還在」，而還原**不會**讓錨點消失 → 少了
    //     `editRevertable` 的 delete_section 第 2 條（`before_blocks` 已在頂層），該列會維持可撤回，
    //     第二次撤回回 201 並把整段**再插一次**，造出重複的頂層 block id（BlockNote 沿用給定
    //     的 id），段落定址／指紋／`after_block_ids` 全建立在頂層 id 唯一之上。撤回沒有
    //     `if_match` 可倚靠，冪等只能寫在判準裡——所以這一格的最後兩行（409 與 id 唯一）
    //     就是那顆守衛的測試。
    for (const kind of ["replace_section", "delete_section"] as const) {
      let boom = true;
      const s = await setup(undefined, { editingTestHooks: { beforeRevertRecord: async () => { if (boom) throw new Error("boom"); } } });
      const c = await s.content();
      // replace_section 打 A 段；delete_section 打 B 段（前一顆是 A 段最後一顆 → anchor after）。
      const target = kind === "replace_section" ? c.outline[1] : c.outline[2];
      const payload = kind === "replace_section"
        ? { op: "replace_section", section_id: target.sectionId, markdown: "# A\n\nAI 版", if_match: target.fingerprint }
        : { op: "delete_section", section_id: target.sectionId, if_match: target.fingerprint };
      expect((await s.post(payload)).statusCode, kind).toBe(201);
      const [edit] = await s.list();
      expect((await s.revert(edit!.id)).statusCode, kind).toBe(500);
      expect((await s.content()).fingerprint, kind).toBe(c.fingerprint); // 內容已還原
      const failed = (await s.list())[0]!;
      expect(failed.revertable, kind).toBe(false); // ← 失敗形的斷言：不可撤回（不是「仍可撤回」）
      expect(failed.revertedAt, kind).toBeNull();  // 紀錄沒寫：原列沒被標
      expect(await s.list(), kind).toHaveLength(1); // 撤回列也沒寫
      boom = false;
      const second = await s.revert(edit!.id);
      expect(second.statusCode, kind).toBe(409);
      expect(second.json().error.code, kind).toBe("stale");
      // 冪等守衛的直接證據：第二次沒有把 `before_blocks` 再插一次。看 server 的 live doc
      // （撤回是在 server 上合併的），不看 client.doc。
      const top = ids(s.ctx.collab.hocuspocus.documents.get(s.note.id)!);
      expect(new Set(top).size, kind).toBe(top.length);
    }
  });

  it("/revert 佇列逾時 → 503 server_busy（不是 500）且什麼都沒動", async () => {
    // ⚠ 這一案守的是 `/revert` 那個 `catch (err) { if (err instanceof QueueBusyError) … 503 }`。
    // 寫入端點有同形的一案，撤回端點原本沒有——而拿掉這個捕捉會讓「忙碌」變成 **500**，
    // 500 正是會誘導外部呼叫端重試的碼，而撤回的重試就是冪等守衛（`editRevertable`
    // 的第 2 條）在擋的那條路。兩件事疊起來是一條可達的路，所以這條分支必須有守衛。
    //
    // 形狀沿用 note-edits.test.ts 的 503 那一段：先傳一個空 hooks 物件進 setup（同一個參照一路
    // 到 `applyDeps.testHooks`，`beforeMerge` 是呼叫時才讀），成功寫一筆拿到 editId 之後才把
    // `beforeMerge` 掛上去卡住下一個寫入，撤回因此撞上 `editingQueueWaitMs`。
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks, editingQueueWaitMs: 50 });
    const c = await s.content(); const a = c.outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const [edit] = await s.list();
    let release!: () => void;
    let entered = false;
    const blocked = new Promise<void>(r => {
      release = r;
    });
    hooks.beforeMerge = () => {
      entered = true;
      return blocked;
    };
    const p1 = s.post({ op: "append", markdown: "卡住佇列" });
    // 第一個請求要先跑完 resolveRole／visibleNoteTitles／loadNoteDoc／mount 才會走到 beforeMerge，
    // 固定次數的輪詢等不到——等旗標，才能確定佇列真的被占住、撤回才會撞逾時。
    await waitFor("第一個寫入已占住佇列", 5_000, () => entered);
    const busy = await s.revert(edit!.id);
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe("server_busy");
    // 撞逾時＝連 `revertEdit` 都沒進去：原列沒被標、也沒有撤回列。
    const still = await s.list();
    expect(still).toHaveLength(1);
    expect(still[0]!.revertedAt).toBeNull();
    expect(still[0]!.revertable).toBe(true);
    release();
    expect((await p1).statusCode).toBe(201);
  });

  it("撤回引入 [[…]] 的 AI 修改 → 目標的 backlinks 不再含來源", async () => {
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標");
    expect((await s.post({ op: "append", markdown: "看 [[目標]]" })).statusCode).toBe(201);
    // ⚠ `/backlinks` 是 **cookie-only**（`app.authenticate`，不在 #107 D2 的 Bearer 允許清單上）
    // ——用 Bearer 會拿到 401、`body.backlinks` 是 undefined（同 note-edits.test.ts 的兩處）。
    const back = async () => {
      const res = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
      return (res.json().backlinks as Array<{ id: string }>).map(b => b.id);
    };
    expect(await back()).toContain(s.note.id);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect(await back()).not.toContain(s.note.id);
  });

  it("空筆記 replace_all／insert_after _top／append → 撤回 → 剩一個空 paragraph、結構合法、再讀正常", async () => {
    for (const body of [{ op: "replace_all", markdown: "X" }, { op: "insert_after", section_id: "_top", markdown: "X" }, { op: "append", markdown: "X" }]) {
      const e = await setup("");
      const c0 = await e.content();
      // ⚠ 三個 op 的 `if_match` **不是同一個指紋**（Task 1 的 D2 是同一格）：`replace_all`／`append`
      // 的 `targetIds` 是 null＝比對**整篇**指紋，`insert_after _top` 比的是那一段的指紋。真空文件
      // 上兩者必不相等（段指紋＝`EMPTY_SECTION_FINGERPRINT`；整篇＝把段指紋串起來再 hash 一次），
      // 所以三個共用一個值會讓 `replace_all` 拿到 409。核對照樣有做，只是各自用對的基線。
      const fp = body.op === "insert_after" ? c0.outline[0].fingerprint : c0.fingerprint;
      expect((await e.post({ ...body, if_match: fp })).statusCode, body.op).toBe(201);
      expect((await e.revert((await e.list())[0]!.id)).statusCode, body.op).toBe(201);
      const c = await e.content();
      expect(c.markdown.trim()).toBe("");
      // ⚠ 同上一案的理由：撤回是在 server 上合併的，client.doc 要經 WS 才收得到。等 `X` 消失
      // ＝那一批更新確實抵達，`toHaveLength(1)`（永不為空、且沒有殘留）才是在驗撤回後的結構。
      await waitFor(`provider 收到還原（${body.op}）`, 3_000, () => !docText(e.client.doc).includes("X"));
      expect(ids(e.client.doc), body.op).toHaveLength(1);
      expect((await e.list())[0]!.op).toBe("revert");
    }
  });

  it("保留：101 筆最舊消失；撤回**最舊那一筆**時原列與撤回列同時消失，總數因此是 99 不是 100", async () => {
    // ⚠ 這個 99 是算出來的，不是筆誤。依 revertEdit 的交易順序：
    //   插入撤回列（101 列）→ 原列標 reverted_at → keep＝按 (created_at desc, id desc) 取前 100
    //   → 刪掉不在 keep 的那一列，也就是**最舊的 oldestKept 自己**
    //   → `note_ai_edits.revert_of` 是 ON DELETE CASCADE，剛插入的撤回列跟著被刪
    // 101 − 1（被裁的原列）− 1（CASCADE 帶走的撤回列）＝ 99。
    // 語意：撤回一筆已經在裁切邊緣的紀錄，會讓紀錄總數少一——不是資料遺失，內容已經還原了，
    // 只是那一對紀錄同時退出保留窗口。已寫進 docs/known-limitations.md。
    //
    // ⚠ `looseLimiters()` **不是多此一舉，不要拿掉**：預設桶是 `EDIT_LIMIT` 30/min 與
    // `TOKEN_WRITE_LIMIT` 60/10min，這個迴圈第 31 次（放寬 edit 後第 61 次）就會拿到 429，
    // 迴圈裡的 `toBe(201)` 直接紅。此時最省事的「修法」是把 101 改小或把斷言放寬——那樣
    // 裁切（RETENTION）與 `revert_of` CASCADE 連帶刪除這條路就完全沒有守衛了。
    // ⚠ 這一案與下一案各做 101 次「fork → mount → 合併 → 記錄」，是本檔最慢的兩案
    // （各約 100 次 mount，會跨過 runtime 的 rebuildEvery=50 門檻兩次）；vitest `testTimeout`
    // 是 120 s，足夠，但別再往裡面加無關的迴圈。
    const s = await setup(undefined, { limiters: looseLimiters() });
    for (let i = 0; i < 101; i += 1) expect((await s.post({ op: "append", markdown: `p${i}` })).statusCode).toBe(201);
    let rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rows).toHaveLength(100);
    // ⚠ 判準要與裁切**同源**：裁切用的是 `orderBy(desc(created_at), desc(id))` 取前 100，所以
    // 「下一個會被裁掉的那一列」＝這個排序的最後一名，不是「created_at 最小的那一列」。少了
    // `id` 這個次要鍵，時間戳相同的兩列在 JS 與 SQL 可能排出不同順序，這一案就會挑錯目標、
    // 得到 100 而不是 99（機率極低，但判準不同源本身就是缺陷）。uuid 的正規小寫十六進位字串
    // 比較與 pg 的 uuid 位元組比較同序（分隔線在固定位置），所以直接用字串比。
    // ⚠ 已知的殘留不對齊（**備查，不打算修**）：`Date.getTime()` 只到**毫秒**，而 pg 的
    // `timestamptz` 排序到**微秒**——所以「同毫秒、不同微秒」的兩列在 SQL 會照微秒分出勝負，
    // 在 JS 這邊卻會落到 `id` 這個次要鍵，兩邊可能不同序。實務風險可以忽略：每一次寫入都含
    // 一次 fork＋mount＋直連合併＋DB 交易，相鄰兩列的間隔遠大於一毫秒，不可能撞在同一毫秒。
    // 真要對齊得改成拿原始字串比（drizzle 已經把欄位轉成 `Date` 了），代價大於收益。
    const trimOrder = [...rows].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
    const oldestKept = trimOrder.at(-1)!;
    expect((await s.revert(oldestKept.id)).statusCode).toBe(201); // 撤回列 +1 → 裁切
    rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rows).toHaveLength(99);
    expect(rows.find(r => r.id === oldestKept.id)).toBeUndefined(); // 原列被裁
    expect(rows.find(r => r.revertOf === oldestKept.id)).toBeUndefined(); // 撤回列隨 CASCADE 消失
  });

  it("保留：撤回**不在邊緣**的那一筆 → 總數維持 100（與上一案對照，證明 99 是裁切邊緣造成的，不是撤回本身會少一）", async () => {
    const s = await setup(undefined, { limiters: looseLimiters() }); // 同上一案：兩顆桶都要放寬，理由見該案註解
    for (let i = 0; i < 101; i += 1) expect((await s.post({ op: "append", markdown: `p${i}` })).statusCode).toBe(201);
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    // 與上一案同一個排序判準（裁切的 `desc(created_at), desc(id)`）——這裡取的是第一名＝最新，
    // 離裁切邊緣最遠，所以撤回它不會連帶刪除任何東西。（`getTime()` 只到毫秒、pg 排到微秒的
    // 那條殘留不對齊備註同上一案：每次寫入的間隔遠大於一毫秒，撞不到。）
    const newest = [...rows].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )[0]!;
    expect((await s.revert(newest.id)).statusCode).toBe(201);
    const after = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(after).toHaveLength(100); // 插一列、裁掉最舊的一列（與撤回列無 FK 關係）
    expect(after.find(r => r.revertOf === newest.id)).toBeDefined();
  });

  it("GET /edits：新到舊、heading 取 anchor 附近的 heading、token 刪除後回快照 label、cookie 寫入的列只顯示 handle（agentLabel 為 null）、不刷新文件載入", async () => {
    const s = await setup();
    const c = await s.content(); const b = c.outline[2];
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    expect((await s.post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    // ⚠ 這一發**刻意走 cookie**（不是 Bearer）：`request.tokenId` 因此是 null，該列的
    // `token_id`／`agent_label` 都是 null，DTO 組裝走的是「沒有 token id → 用快照（也是 null）」
    // 那條分支。本案其餘寫入全是 Bearer，少了這一發那條分支完全沒有守衛，改成任意常數都不會紅。
    const cookieWrite = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: { cookie: await cookieFor(s.u.id) }, payload: { op: "append", markdown: "人寫的" } });
    expect(cookieWrite.statusCode).toBe(201);
    const edits = await s.list();
    expect(edits.map(e => e.op)).toEqual(["append", "append", "delete_section"]);
    expect(edits[0]!.agentLabel).toBeNull(); // cookie 列：沒有 token → 不落 agent 款，只有 handle
    expect(edits[0]!.byHandle).toBe(edits[1]!.byHandle); // 同一個人，兩條路徑的 handle 一致
    expect(edits[2]!.heading).toBe("A"); // anchor 附近的第一顆 heading
    await s.ctx.db.delete(apiTokens).where(eq(apiTokens.id, s.tokenId));
    const { token: t2 } = await seedTokenForUser(s.ctx.db, s.u.id);
    const after = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(t2) })).json().edits;
    expect(after[0].agentLabel).toBeNull(); // cookie 列不受 token 刪除影響
    expect(after[1].agentLabel).toBe("mcp"); // Bearer 列：token 已刪 → 回落到快照
    // ⚠ handle **不能硬寫成 `"a"`**（那是 email 的 local part，不是 handle）：`ctx.createUser`
    // 完全不帶 handle，該欄吃的是 DB default——`'user-' || substr(gen_random_uuid()::text, 1, 8)`，
    // 每次都不一樣。既有整合測試一律讀真值（沒有任何一處硬寫 handle 字串），這裡照辦。
    // **也不要退化成 `expect.any(String)`**：這一格守的就是「落款指向的是**這位**編輯者」
    // ——DTO 組裝時 `innerJoin(users)` 若漏接，`byHandle` 會是空字串，只有真值比對抓得到。
    // 這裡不能用 `bearer(s.token)`——`s.token` 上面幾行已經被刪掉了，查表會落空回 401。
    const ownerHandle = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}`, headers: bearer(t2) })).json().ownerHandle;
    expect(after[0].byHandle).toBe(ownerHandle);
    s.client.disconnect(); await settled(s);
    await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(t2) });
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0); // GET /edits 走讀路徑，不得讓文件重新載入
  });

  it("/revert 的四格：不存在／別篇筆記／格式錯與含 NUL 的 editId → 404（不是 500）；viewer → 403 且什麼都沒動", async () => {
    // plan gate r2 I-E：`/revert` 原本一個拒絕案都沒有，違反本 plan 自己的全域限制
    // （每個端點都要有一案「含 NUL → 該端點的正常錯誤形，不是 500」）。`/revert` **沒有 body**，
    // 所以不變量 S 落在**路徑參數**上：`editId` 走路由的 `UUID_RE` 守衛，正常形是 404 `not_found`。
    const s = await setup();
    const c = await s.content(); const a = c.outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const [mine] = await s.list();

    // ① 格式合法但不存在的 uuid
    expect((await s.revert("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);

    // ② **別篇筆記的紀錄**：`revertEdit` 第一句 where 的 `eq(noteAiEdits.noteId, input.noteId)`
    //    是唯一擋這件事的地方，拿掉它今天沒有任何測試會紅——這一格就是它的守衛。
    const other = await s.ctx.createNote(s.u.id, "另一篇");
    const w = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${other.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "別篇" } });
    expect(w.statusCode).toBe(201);
    const cross = await s.revert(w.json().editId); // 路徑是 s.note，editId 屬於 other
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("not_found");

    // ③ 格式錯／含 NUL 的 editId → 本端點的正常 404 形（不得 500、不得逃到全域 errorHandler）
    const NUL = String.fromCharCode(0);
    for (const bad of ["nope", encodeURIComponent(`${mine!.id}${NUL}`)]) {
      const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${bad}/revert`, headers: bearer(s.token) });
      expect(r.statusCode, bad).toBe(404);
      expect(r.json().error.code).toBe("not_found");
    }

    // ④ viewer → 403；且原列仍可撤回、內容沒被動過（假綠守衛：拒絕就是什麼都不做）
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    const forbidden = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${mine!.id}/revert`, headers: bearer(vt) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    expect((await s.list())[0]!.revertable).toBe(true);
    expect((await s.content()).markdown).toContain("AI 版");
  });

  it("GET /edits 的守衛：非成員 → 404；角色檢查之後才消耗 CONTENT_READ_LIMIT；耗盡 → 429", async () => {
    // plan gate r2 Minor-5：這條路由宣稱三道守衛（scope、角色、限流）卻一個斷言都沒有。
    // **scope 那道刻意不另造案**：它是 `authenticateAny("notes:read")` 的共用機制，已由
    // `api-token-auth.test.ts` 的「read token 打 POST /api/notes → 403 insufficient_scope」釘住，
    // 而本檔的 token 一律含 `notes:read`，造不出有意義的變體。這裡守角色與限流兩道。
    const s = await setup(undefined, { limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const get = (t: string, noteId = s.note.id) => s.ctx.app.inject({ method: "GET", url: `/api/notes/${noteId}/edits`, headers: bearer(t) });
    const stranger = await s.ctx.createUser({ email: "x@example.com", password: PASSWORD });
    const { token: st } = await seedTokenForUser(s.ctx.db, stranger.id);
    const outsider = await get(st);
    expect(outsider.statusCode).toBe(404); // 非成員一律 404（不洩漏筆記存在性）
    expect(outsider.json().error.code).toBe("not_found");
    // 擁有者打一個不存在的 noteId → 404。桶 key＝userId，額度只有 1：
    // 若 consume 被搬到角色檢查**之前**，這一發就會吃掉唯一額度，下一行的 200 會變成 429。
    expect((await get(s.token, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await get(s.token)).statusCode).toBe(200);
    expect((await get(s.token)).statusCode).toBe(429);
  });
});
