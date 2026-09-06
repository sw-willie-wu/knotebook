import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm"; // `sql` 只給 note_links 故障那案的觸發器用（一律樣板，不串字串）
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { docClock } from "../src/collab/store.js";
import { noteAiEdits, noteStates, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testConfig, testEditingRuntime } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
type Setup = Awaited<ReturnType<typeof setup>>;

// ⚠ 兩個 heading **同級**（`# A` / `# B`）。寫成 `## B` 的話 `sectionize()` 會把 B 併進 A 段
// （開新段條件 `level <= current.level` 不成立），`outline[2]` 變 undefined、且「最後一顆 block」
// 不再是「別的段落」——底下兩條併發守衛會靜默變成測別的東西。見 Global Constraints 的 heading 條。
async function setup(md: string | null = "# A\n\n第一段\n\n# B\n\n第二段", opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = md === null ? await session.connect(note.id) : await seedContent(ctx, session, note.id, md);
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const post = (body: Record<string, unknown>, t = token) =>
    ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(t), payload: body });
  const rows = () => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
  const stateBytes = async () => Buffer.from((await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]?.ydoc ?? Buffer.alloc(0));
  // #137 Task 3：spec §12.2 對每個拒絕情境要求三件事，第三件就是 `last_edited_*` 不變——與
  // `stateBytes` 並列，同一顆 debounce 打穿兩者（取基線前必須先讓落盤成為確定事件，見各案註解）。
  const lastEdited = async () =>
    (await ctx.db.select({ at: notes.lastEditedAt, by: notes.lastEditedBy, tokenId: notes.lastEditedTokenId, label: notes.lastEditedAgentLabel })
      .from(notes).where(eq(notes.id, note.id)))[0]!;
  return { ctx, u, note, session, client, token, tokenId, content, post, rows, stateBytes, lastEdited };
}
const ids = (doc: Y.Doc) => topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId, tv: 0 })}`;
/**
 * provider 側用 server 的 EditorSession 對 client.doc 做一次編輯（模擬人在瀏覽器打字），
 * **並等到 server 的 live doc 真的收到才回傳**。
 *
 * 兩件事都不可省（Global Constraints）：
 * (1) `try { … } finally { s.close() }`——`testEditingRuntime` 是**模組層單例**，同一個 worker 內
 *     所有整合測試共用。回呼一 throw 就永久洩漏一個 in-flight 名額；重建旗標一旦被設起
 *     （每 50 次 mount，本檔輕鬆超過），後面每個 `acquire()` 都永遠不會 settle，整支測試檔
 *     以**無訊息逾時**收場（`session.ts` 的 m3 不變量白紙黑字寫了這條）。
 * (2) `waitFor` 觀察的是 **server 上的 doc**，不是 client.doc——改動要經 WebSocket 才會到
 *     server，函式回傳當下 server 還沒收到。少了這一步，「transact 內重算指紋擋住併發覆蓋」
 *     這條本棒最重要的守衛就是靠競態在驗，會偶爾假綠。
 */
async function humanEdit(ctx: Setup["ctx"], noteId: string, client: Setup["client"], sentinel: string, fn: (ed: EditorSession["editor"]) => void) {
  const s = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    fn(s.editor);
  } finally {
    s.close();
  }
  await waitFor(`server 收到併發編輯（${sentinel}）`, 5_000, () =>
    docText(ctx.collab.hocuspocus.documents.get(noteId)!).includes(sentinel)
  );
}
/** `client.disconnect()` 之後、要讀 note_states／notes 或斷言 documents.size 之前的唯一等法。 */
const settled = (ctx: Setup["ctx"]) => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);

describe("POST /api/notes/:id/edits：五 op", () => {
  it("replace_section：內容換、段外 id 不變、provider 即時收到、記錄一列、note_states 已新、回覆指紋==之後讀到的、agentLabel 快照", async () => {
    const { note, client, content, post, rows, stateBytes } = await setup();
    const before = await content();
    const idsBefore = ids(client.doc);
    const sec = before.outline[2]; // ＝ B 段（outline[0]=_top、[1]=A、[2]=B；兩個 heading 同級才成立）
    // ⚠ 寫回去的 heading 也要**同級**（`# B2`）：寫成 `## B2` 的話新內容合併後會併進 A 段，
    // 這一案就不再是在測 replace_section 的語意了。
    const res = await post({ op: "replace_section", section_id: sec.sectionId, markdown: "# B2\n\n新的第二段", if_match: sec.fingerprint });
    expect(res.statusCode).toBe(201);
    expect(res.json().unboundWikilinks).toBe(0);
    await waitFor("provider 收到", 3_000, () => docText(client.doc).includes("新的第二段"));
    expect(ids(client.doc).slice(0, 2)).toEqual(idsBefore.slice(0, 2));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ op: "replace_section", sectionId: sec.sectionId, agentLabel: "claude", noteId: note.id });
    expect(r[0]!.afterBlockIds.length).toBeGreaterThan(0);
    expect((r[0]!.beforeBlocks as unknown[]).length).toBe(2);
    expect((await content()).fingerprint).toBe(res.json().fingerprint);
    // 落盤的是 Yjs 的二進位更新——直接對 `Buffer.toString()` 做子字串比對不可靠（長度前綴位元組
    // 會被 UTF-8 解碼器吃掉相鄰的中日韓位元組），所以解回 Y.Doc 再看內文（同「fork 側 409」那案）。
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, await stateBytes());
    expect(docText(persisted)).toContain("新的第二段");
  });

  it("replace_all／insert_after／append／delete_section 語意；沒人在線寫入後 documents.size 回 0；append 免 if_match", async () => {
    const { ctx, client, content, post } = await setup();
    client.disconnect();
    await settled(ctx);
    let c = await content();
    expect((await post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.trimEnd().endsWith("尾巴")).toBe(true);
    const a = c.outline[1];
    expect((await post({ op: "insert_after", section_id: a.sectionId, markdown: "插入的", if_match: a.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.indexOf("插入的")).toBeGreaterThan(c.markdown.indexOf("第一段"));
    expect(c.markdown.indexOf("插入的")).toBeLessThan(c.markdown.indexOf("# B"));
    const b = c.outline.find((o: { heading: string }) => o.heading === "B");
    expect((await post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown).not.toContain("第二段");
    expect((await post({ op: "replace_all", markdown: "全新", if_match: c.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.trim()).toBe("全新");
    await settled(ctx);
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
  });

  it("從未開過的空筆記：讀 → 用讀到的 if_match 寫 → 成功 → 回覆指紋 == 再讀的指紋", async () => {
    const { content, post } = await setup(null);
    const first = await content();
    expect(first.outline).toEqual([expect.objectContaining({ sectionId: "_top", chars: 0 })]);
    const res = await post({ op: "replace_all", markdown: "從無到有", if_match: first.fingerprint });
    expect(res.statusCode).toBe(201);
    expect((await content()).fingerprint).toBe(res.json().fingerprint);
  });

  it("_top：insert_after _top 插在第一個 heading 前；零 block _top 的 replace_section 同；delete_section 零 block _top → 400 empty_section", async () => {
    const { content, post } = await setup("# A\n\n內文");
    let c = await content();
    const top = c.outline[0];
    expect(top.chars).toBe(0);
    expect((await post({ op: "delete_section", section_id: "_top", if_match: top.fingerprint })).json().error.code).toBe("empty_section");
    expect((await post({ op: "insert_after", section_id: "_top", markdown: "前言", if_match: top.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.indexOf("前言")).toBeLessThan(c.markdown.indexOf("# A"));
    // 種子寫成 `# A 標題`（不是 `# A`）：`seedContent` 的哨兵是最後一行的可見文字，單字元的
    // ASCII 哨兵（`"A"`）會被 block id 的隨機字元命中，等於沒等。下面的 `indexOf("# A")` 仍成立。
    const h = await setup("# A 標題");
    const topEmpty = (await h.content()).outline[0];
    expect((await h.post({ op: "replace_section", section_id: "_top", markdown: "前言二", if_match: topEmpty.fingerprint })).statusCode).toBe(201);
    expect((await h.content()).markdown.indexOf("前言二")).toBeLessThan((await h.content()).markdown.indexOf("# A"));
  });

  it("無 heading 筆記 delete_section _top → 只剩一個空 paragraph、記錄 after 空、anchor ③ 指向它", async () => {
    const flat = await setup("只有一段");
    const t = (await flat.content()).outline[0];
    expect((await flat.post({ op: "delete_section", section_id: "_top", if_match: t.fingerprint })).statusCode).toBe(201);
    const after = await flat.content();
    expect(after.outline).toHaveLength(1);
    expect(after.outline[0].chars).toBe(0);
    expect(ids(flat.client.doc)).toHaveLength(1);
    const [row] = await flat.rows();
    expect(row!.afterBlockIds).toEqual([]);
    expect(row!.afterFingerprint).toBeNull();
    expect(row!.anchor).toEqual({ block_id: ids(flat.client.doc)[0], position: "before" });
  });

  it("真空文件：replace_section／insert_after _top／append → 結果同 replace_all；delete_section → 400", async () => {
    for (const body of [
      { op: "replace_section", section_id: "_top", markdown: "X" },
      { op: "insert_after", section_id: "_top", markdown: "X" },
      { op: "append", markdown: "X" },
    ]) {
      const e = await setup(null);
      const c0 = await e.content();
      // ⚠ `append` 的 `if_match` 比對的是**整篇**指紋（`targetIds === null`），另外兩支比對的是
      // `_top` 這一段的指紋。真空文件下這兩個值不相等（整篇＝各段指紋串起來再 hash），三支共用
      // 同一個值會讓 append 拿到 409——那是輸入寫錯，不是行為錯，所以按 op 取對應的那一個。
      const fp = body.op === "append" ? c0.fingerprint : c0.outline[0].fingerprint;
      expect((await e.post({ ...body, if_match: fp })).statusCode, body.op).toBe(201);
      const c = await e.content();
      expect(c.markdown.trim()).toBe("X");
      expect(c.outline).toHaveLength(1);
      expect(ids(e.client.doc)).toHaveLength(1);
    }
    const d = await setup(null);
    expect((await d.post({ op: "delete_section", section_id: "_top", if_match: (await d.content()).outline[0].fingerprint })).json().error.code).toBe("empty_section");
  });

  it("cookie 寫入 → 記錄 token_id／agent_label 皆 NULL", async () => {
    const { ctx, u, note, content, rows } = await setup();
    const c = await content();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: { cookie: await cookieFor(u.id) }, payload: { op: "append", markdown: "by cookie" } });
    expect(res.statusCode).toBe(201);
    expect(c.fingerprint).not.toBe(res.json().fingerprint);
    const [row] = await rows();
    expect(row).toMatchObject({ tokenId: null, agentLabel: null, userId: u.id });
  });
});

describe("if_match 與併發", () => {
  it("整篇不符 409 且 current 是新內容；段落不符 409；別段被人改該段仍成功", async () => {
    const { ctx, note, client, content, post } = await setup();
    const c = await content();
    const stale = await post({ op: "replace_all", markdown: "x", if_match: "0000000000000000" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("fingerprint_mismatch");
    expect(stale.json().current.fingerprint).toBe(c.fingerprint);
    const a = c.outline[1];
    expect((await post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nx", if_match: "0000000000000000" })).statusCode).toBe(409);
    // `document.at(-1)` ＝ 第二段，**在 B 段**（fixture 的兩個 heading 同級才成立；若寫成 `## B`
    // 它會落在 A 段裡，這一行就會把「別段被人改」變成「同段被人改」，下一行的期待要從 201 變 409——
    // 也就是把本棒最重要的守衛之一測反了）。
    await humanEdit(ctx, note.id, client, "第二段（人改）", ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段（人改）" }));
    expect((await post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 改的", if_match: a.fingerprint })).statusCode).toBe(201);
    expect((await content()).markdown).toContain("人改");
    expect((await content()).markdown).toContain("AI 改的");
  });

  it("fork 後合併前 provider 打同段字 → transact 內 409；(a) 落盤含併發編輯且不含 AI block id (c) 紀錄空 (d) provider 斷線後 documents.size 回 0", async () => {
    // ⚠ hook 必須等到 server 收到那筆併發編輯才回傳（humanEdit 內建 waitFor）——否則合併的
    // transact 在編輯抵達之前就跑完，指紋核對根本沒看到併發，這一案會靠時序偶爾綠。
    // hook 要用到 `setup()` 的結果，而 hook 又必須在 `setup()` 之前就交給 app——所以先傳一個空物件
    // 進去（同一個參照一路到 `applyDeps.testHooks`），再把 `beforeMerge` 掛上去。`deps.testHooks
    // ?.beforeMerge` 是**呼叫時**才讀，所以掛在 setup 之後仍然生效。
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks });
    hooks.beforeMerge = async () => {
      await humanEdit(s.ctx, s.note.id, s.client, "第一段（併發）", ed => ed.updateBlock(ed.document[1]!.id, { content: "第一段（併發）" }));
    };
    const c = await s.content();
    const a = c.outline[1];
    const svBefore = new Set(Y.decodeStateVector(Y.encodeStateVector(s.client.doc)).keys());
    const res = await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("fingerprint_mismatch");
    expect(res.json().current.markdown).toContain("併發");
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, await s.stateBytes());
    expect(docText(persisted)).toContain("併發");
    expect(docText(persisted)).not.toContain("AI 版");
    const svAfter = new Set(Y.decodeStateVector(Y.encodeStateVector(persisted)).keys());
    for (const k of svAfter) expect(svBefore.has(k) || k === s.client.doc.clientID).toBe(true);
    expect(await s.rows()).toHaveLength(0);
    s.client.disconnect();
    await settled(s.ctx);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    // #137 spec §12.2 的 (b)：拒絕路徑的 `disconnect()` **也會 store**，`ctx.applied === false`
    // 是唯一擋住 AI 落款的閘。拿掉 `onStoreDocument` 的 applied 閘 → 這一行紅。
    expect(await s.lastEdited()).toMatchObject({ tokenId: null, label: null });
  });

  it("fork 後合併前 provider 打別段 → 兩邊都在", async () => {
    // 同上（含「先傳空 hooks 物件、setup 之後才掛 beforeMerge」的理由）：`at(-1)` ＝ 第二段，
    // 在 B 段（AI 打的是 A 段）。fixture 的 heading 同級是這一案成立的前提。
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks });
    hooks.beforeMerge = async () => {
      await humanEdit(s.ctx, s.note.id, s.client, "第二段（併發）", ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段（併發）" }));
    };
    const a = (await s.content()).outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const md = (await s.content()).markdown;
    expect(md).toContain("AI 版");
    expect(md).toContain("第二段（併發）");
  });

  it("併發：同段恰一發成功（replace_section 落敗＝404、insert_after 落敗＝409）；不同段都 201；佇列逾時 503 server_busy 且什麼都沒寫", async () => {
    const s = await setup();
    const c = await s.content();
    const a = c.outline[1];
    const [r1, r2] = await Promise.all([
      s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\n一", if_match: a.fingerprint }),
      s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\n二", if_match: a.fingerprint }),
    ]);
    // ⚠ 落敗那一發是 **404 `section_not_found`**，不是 409：佇列讓兩發串行，第二發是在第一發
    // 合併完之後才 fork 的，而 `replace_section` 連 heading block 一起換掉＝該段的 sectionId
    // （＝heading 的 block id）已經不存在了。守的東西不變（恰好一發成功、落敗那發什麼都沒寫），
    // 只是碼不同；「段落還在但指紋變了 → 409」由下面第二組（insert_after）驗。
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 404]);
    expect(await s.rows()).toHaveLength(1); // 落敗那一發沒有留下任何紀錄
    const c2 = await s.content();
    const a2 = c2.outline[1];
    const b2 = c2.outline[2];
    const [r3, r4] = await Promise.all([
      s.post({ op: "replace_section", section_id: a2.sectionId, markdown: "# A\n\n三", if_match: a2.fingerprint }),
      s.post({ op: "replace_section", section_id: b2.sectionId, markdown: "# B\n\n四", if_match: b2.fingerprint }),
    ]);
    expect([r3.statusCode, r4.statusCode]).toEqual([201, 201]);
    // 同段、但 sectionId 仍在（`insert_after` 不動 heading）→ 落敗那發是 409 `fingerprint_mismatch`：
    // 第一發插進去的 block 併入該段，該段指紋因此改變，第二發帶的舊指紋核對不過。
    const cIns = await s.content();
    const aIns = cIns.outline[1];
    const [ri1, ri2] = await Promise.all([
      s.post({ op: "insert_after", section_id: aIns.sectionId, markdown: "五", if_match: aIns.fingerprint }),
      s.post({ op: "insert_after", section_id: aIns.sectionId, markdown: "六", if_match: aIns.fingerprint }),
    ]);
    expect([ri1.statusCode, ri2.statusCode].sort()).toEqual([201, 409]);
    expect([ri1, ri2].find(r => r.statusCode === 409)!.json().error.code).toBe("fingerprint_mismatch");
    // 503：把佇列等待壓到 0（editingTestHooks.beforeMerge 卡住第一個請求）
    let release!: () => void;
    let entered = false;
    const blocked = new Promise<void>(r => {
      release = r;
    });
    const t = await setup(undefined, { editingTestHooks: { beforeMerge: () => { entered = true; return blocked; } }, editingQueueWaitMs: 50 });
    // ⚠ 同拒絕案共用案：**取基線前先讓落盤成為確定事件**（Global Constraints 的基線條）。這一段的
    // 兩個請求都停在合併之前——`p1` 被 hook 卡住、`r5` 撞佇列逾時——所以**沒有任何立即落盤去取代
    // `seedContent` 那顆待送的 debounced store**（429 那案安全，正是因為它前面有一次成功寫入）。
    // 不斷線的話：基線取在 `note_states` 還沒有列的時候，等 mount 與 waitFor 拖過兩秒，種子的
    // store 落地，`bytes` 的相等斷言就假紅。斷線＋卸載後這一段不會再有任何落盤，相等是確定事件。
    t.client.disconnect();
    await settled(t.ctx);
    const c3 = await t.content();
    const bytes = await t.stateBytes();
    const p1 = t.post({ op: "append", markdown: "一" });
    // 第一個請求要先跑完 resolveRole／visibleNoteTitles／loadNoteDoc／mount 才會走到 beforeMerge，
    // 固定次數的 setImmediate 輪詢等不到——等旗標，才能確定佇列真的被占住、第二個請求才會撞逾時。
    await waitFor("第一個請求已占住佇列", 5_000, () => entered);
    const r5 = await t.post({ op: "append", markdown: "二" });
    expect(r5.statusCode).toBe(503);
    expect(r5.json().error.code).toBe("server_busy");
    expect((await t.stateBytes()).equals(bytes)).toBe(true);
    expect(await t.rows()).toHaveLength(0);
    release();
    expect((await p1).statusCode).toBe(201);
    expect((await t.content()).fingerprint).not.toBe(c3.fingerprint);
  });
});

describe("拒絕案假綠守衛", () => {
  // spec §12.2 的清單是「每一個拒絕情境都要斷言：note_states.ydoc 位元組相同、note_ai_edits 零列」。
  // 這一案是那份清單的共用實作——新增任何拒絕碼都要加進 `cases`，不要另開一個沒有守衛的 it。
  // ⚠ `unsupported_block` **整合層刻意不驗**，而且到不了：headless schema ＝ `defaultBlockSpecs`
  // 全集＋mermaid／codeBlock（見 shared 的 `createHeadlessNoteSchema`），BlockNote 的 markdown/HTML
  // parser 產得出來的 type 一定在白名單裡，所以無法從 markdown 造出這個碼。白名單那條分支由
  // `test/unit/editing-markdown.test.ts` 的「未知型別整筆拒絕」以收窄的假 schema 驗（刪掉
  // `markdown.ts` 的 `walk` 檢查 → 那一案必須紅）。這裡誠實記下，而不是塞一個到不了的案子。
  it("403 viewer、empty_content、empty_section、too_many_blocks、NUL、未知欄位、fork 側 409、413 content_too_large → note_states 位元組相同、記錄零列", async () => {
    const s = await setup();
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    // ⚠ **取基線之前必須先讓落盤成為確定事件**（Global Constraints 的基線條）——這一行不是多餘的
    // 收尾動作，是這一案唯一能成立的前提。不斷線就取基線的話：此刻 `note_states` 還沒有列
    //（`stateBytes()` 回空緩衝區），而 `seedContent` 那批人為編輯掛著一顆 2 秒 debounce 的 store；
    // 底下 11 個 case ＋ 一次內容讀取 ＋ 413 跑超過兩秒，那顆 store 就會在中途落地、表裡出現種子
    // 內容，結尾的位元組相等斷言變成時序假紅。斷線＋卸載之後**沒有任何在線 client 會再排 store**，
    // 而底下每一個請求都停在合併之前（拒絕案的定義）＝不會開直連、不會落盤，所以基線與結尾必然相等。
    // 之後的讀取走 DB 快照（`loadNoteDoc` 沒有 live doc 就解 `note_states`），內容與斷線前逐位元組相同。
    s.client.disconnect();
    await settled(s.ctx);
    const before = await s.stateBytes();
    // #137：spec §12.2 的第三件事。可以用嚴格的「四欄全等」，前提正是上面那兩行斷線＋卸載——
    // 之後四欄已是人形落款且**不會再有任何 store**（底下每個請求都停在合併之前），所以「不變」
    // 是確定事件而非賭時序。⚠ 拿掉那兩行斷線，這一行會跟著變成隨機紅（同一顆 debounce 的兩個面）。
    const lastBefore = await s.lastEdited();
    const topFp = (await s.content()).outline[0].fingerprint; // 文件以 heading 開頭 → _top 零 block
    const NUL = String.fromCharCode(0);
    const cases: Array<[Record<string, unknown>, number, string, string?]> = [
      [{ op: "append", markdown: "x" }, 403, "forbidden", vt],
      [{ op: "append", markdown: "   \n" }, 400, "empty_content"],
      [{ op: "append", markdown: "\n\n" }, 400, "empty_content"],
      [{ op: "delete_section", section_id: "_top", if_match: topFp }, 400, "empty_section"],
      [{ op: "append", markdown: Array.from({ length: 2001 }, (_, i) => `p${i}`).join("\n\n") }, 400, "too_many_blocks"],
      [{ op: "append", markdown: "x" + NUL }, 400, "invalid_body"],
      [{ op: "append", markdown: "x", extra: 1 }, 400, "invalid_body"],
      [{ op: "replace_section", section_id: "a" + NUL, markdown: "x", if_match: "0000000000000000" }, 400, "invalid_body"],
      [{ op: "replace_all", markdown: "x", if_match: "0000000000000000" + NUL }, 400, "invalid_body"],
      [{ op: "replace_all", markdown: "x", if_match: "0000000000000000" }, 409, "fingerprint_mismatch"],
      [{ op: "replace_section", section_id: "nope", markdown: "x", if_match: "0000000000000000" }, 404, "section_not_found"],
    ];
    for (const [body, status, code, t] of cases) {
      const r = await s.post(body, t);
      expect(r.statusCode, code).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
    const big = await s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.note.id}/edits`,
      headers: { ...bearer(s.token), "content-type": "application/json" },
      payload: JSON.stringify({ op: "append", markdown: "a".repeat(300_000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("content_too_large");
    expect((await s.stateBytes()).equals(before)).toBe(true);
    expect(await s.rows()).toHaveLength(0);
    expect(await s.lastEdited()).toEqual(lastBefore);
  });

  it("429 也是拒絕案：EDIT_LIMIT 耗盡後的請求 → note_states 位元組相同、記錄零列", async () => {
    // spec §12.2 把 429 列在拒絕案假綠守衛的清單裡，但它需要自己的桶，所以獨立一案。
    // 守的是「限流在任何 mount／直連之前就擋下來」：日後有人把 consume 搬到合併之後，
    // 位元組與零列這兩條會紅。
    const s = await setup(undefined, { limiters: { edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    expect((await s.post({ op: "append", markdown: "第一次" })).statusCode).toBe(201);
    const before = await s.stateBytes();
    // #137：這一案也能用嚴格的「四欄全等」，理由是上面那次成功的 append——合併的 disconnect()
    // 是立即 store，**會取代該批待送的 debounced store**（spec §13），所以之後沒有別的寫入者
    // 會再動這四欄。基線因此是確定事件，不是「大概來得及」。
    const lastBefore = await s.lastEdited();
    const rowsBefore = (await s.rows()).length;
    const r = await s.post({ op: "append", markdown: "第二次" });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("too_many_requests");
    expect((await s.stateBytes()).equals(before)).toBe(true);
    expect(await s.rows()).toHaveLength(rowsBefore);
    expect(await s.lastEdited()).toEqual(lastBefore);
    expect((await s.content()).markdown).not.toContain("第二次");
  });

  // ⚠ #137：這一案**刻意不補** `last_edited_*` 不變的斷言——它不是拒絕案：內容**已經合併落盤**
  // 了（`expect(content).toContain("內容在")` 正是這個意思），落款本來就該更新。誤加「不變」會把
  // 正確行為測成錯的。
  it("記錄插入失敗（beforeRecord throw）→ 500、內容仍在、記錄零列", async () => {
    const s = await setup(undefined, { editingTestHooks: { beforeRecord: async () => { throw new Error("boom"); } } });
    const c = await s.content();
    const r = await s.post({ op: "replace_all", markdown: "內容在", if_match: c.fingerprint });
    expect(r.statusCode).toBe(500);
    expect((await s.content()).markdown).toContain("內容在");
    expect(await s.rows()).toHaveLength(0);
  });
});

describe("限流", () => {
  it("EDIT_LIMIT limit 3 第 4 次 429；viewer 4 次全 403（角色檢查後才消耗）", async () => {
    const s = await setup(undefined, { limiters: { edit: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    for (let i = 0; i < 4; i += 1) expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    for (let i = 0; i < 3; i += 1) expect((await s.post({ op: "append", markdown: "x" })).statusCode).toBe(201);
    expect((await s.post({ op: "append", markdown: "x" })).statusCode).toBe(429);
  });

  it("token 的 TOKEN_WRITE_LIMIT：viewer 的 403 也消耗（preHandler 扣點）", async () => {
    const s = await setup(undefined, { limiters: { tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(429);
  });
});

describe("note_links 與媒體", () => {
  it("AI 寫入含 [[…]] 的段落 → 目標的 backlinks 立即含來源；unboundWikilinks 計數", async () => {
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標筆記");
    const c = await s.content();
    const r = await s.post({ op: "append", markdown: "看 [[目標筆記]] 與 [[不存在]]", if_match: c.fingerprint });
    expect(r.statusCode).toBe(201);
    expect(r.json().unboundWikilinks).toBe(1);
    // ⚠ `/backlinks` 是 **cookie-only**（`app.authenticate`，不在 #107 D2 的 Bearer 允許清單上）
    // ——用 Bearer 會拿到 401、`body.backlinks` 是 undefined。這裡改用 session cookie。
    const back = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
    expect(back.json().backlinks.map((b: { id: string }) => b.id)).toContain(s.note.id);
  });

  it("note_links 的 clock 取自 applyUpdate 之前的 live doc（＝寫入前的 docClock，且 < 寫入後）", async () => {
    // 這一案守的是本棒 CAS 正確性的唯一依據：`mergeDiff` 在 `Y.applyUpdate` **之前**讀 `docClock`。
    // 把那行挪到 applyUpdate 之後，兩個既有的 backlinks 案仍然全綠——因為 writeNoteLinks 的 CAS 用
    // 的是 `links_clock <= $clock`，更大的 clock 一樣寫得進去。失效是**靜默**的：AI 拿一個比它實際
    // 看到的狀態更新的 clock 去佔位，瀏覽器後續（clock 較小）的索引更新被判成 no-op，該筆記的
    // wikilink 索引永久落後且完全無聲。所以直接查那個欄位本身。
    const s = await setup();
    await s.ctx.createNote(s.u.id, "目標筆記");
    const live = () => s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    const clockBefore = docClock(live());
    const c = await s.content();
    expect((await s.post({ op: "append", markdown: "看 [[目標筆記]]", if_match: c.fingerprint })).statusCode).toBe(201);
    const clockAfter = docClock(live());
    const [row] = await s.ctx.db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, s.note.id));
    expect(row!.linksClock).toBe(clockBefore); // 挪到 applyUpdate 之後 → 這行紅
    expect(row!.linksClock).toBeLessThan(clockAfter); // 且合併確實推進了 doc clock（守衛本身沒有空轉）
    expect(clockBefore).toBeGreaterThan(0); // seed 過的筆記，不是拿 0 跟 0 比
  });

  it("note_links 寫入失敗（DB 故障）→ 仍回 201、紀錄已寫、只是索引落後（不得把成功的寫入變成 500）", async () => {
    // plan gate r3 Minor-2：`updateNoteLinks` 跑在**內容已落盤、note_ai_edits 也已寫**之後。
    // `writeNoteLinks` 對「忙碌」是**回值**（"busy"）不是拋出，所以它真的 throw 就代表 DB 故障——
    // 讓那個例外逃出去會把一次**完全成功**的寫入回成 500，而外部 AI 對 500 幾乎一定重試，於是
    // 同一筆編輯被套用兩次、`note_ai_edits` 多一列。這條鏈上其他每個失敗形都有明確語意
    //（記錄插入失敗＝內容在紀錄沒有、回 500），唯獨這個沒有——降級成 warn，索引落後而已。
    // 造故障的手法沿用 repo 前例：一律用 `sql` 樣板，不串字串。
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標筆記");
    await s.ctx.db.execute(sql`create or replace function knb_links_boom() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await s.ctx.db.execute(sql`create trigger knb_links_boom_trg before insert on note_links for each row execute function knb_links_boom()`);
    try {
      const c = await s.content();
      const r = await s.post({ op: "append", markdown: "看 [[目標筆記]]", if_match: c.fingerprint });
      expect(r.statusCode).toBe(201); // 拿掉 updateNoteLinks 外面的 try/catch → 這行變 500，紅
      expect(await s.rows()).toHaveLength(1); // 紀錄已經寫了：回 500 會讓 AI 重試而重複這一列
      expect((await s.content()).markdown).toContain("目標筆記"); // 內容也已經落盤
    } finally {
      await s.ctx.db.execute(sql`drop trigger knb_links_boom_trg on note_links`);
    }
    // 代價只有索引落後（known-limitations 第 9 條）：backlinks 這次沒建起來。
    // ⚠ `/backlinks` 是 **cookie-only**（`app.authenticate`，不在 #107 D2 的 Bearer 允許清單上）
    // ——用 Bearer 會拿到 401、`body.backlinks` 是 undefined。這裡改用 session cookie。
    const back = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
    expect(back.json().backlinks).toHaveLength(0);
  });

  it("含上傳圖片的筆記 read → replace_section 寫回 → 圖片 url 不變", async () => {
    // ⚠ 尾巴的 `圖說` 那一行**不是裝飾，不要刪**：`seedContent` 的哨兵取「最後一行的可見文字」，
    // 而 `![pic](…)` 會被解析成 image block（Y 文件裡存的是 `url` 之類的**屬性**），那串 markdown
    // 語法永遠不會出現在 `docText()` 的 XML 字串裡——沒有這行圖說，這一案會跑滿 5 秒逾時，
    // 而最省事的「修法」（放寬或縮短 seedContent 的等待）會靜默拆掉另外約 25 個案子的前提。
    const s = await setup("# A\n\n![pic](/api/uploads/abc123)\n\n圖說");
    const c = await s.content();
    expect(c.markdown).toContain("/api/uploads/abc123");
    const a = c.outline[1];
    const sec = (await getContent(s.ctx.app, s.note.id, s.token, a.sectionId)).json().section;
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: sec.markdown + "\n\n補一句", if_match: a.fingerprint })).statusCode).toBe(201);
    // ⚠ 底下兩條斷言看的是 client.doc，合併結果要經 WebSocket 才會回到 client——`post()` 回傳
    // 當下 client 還沒收到。沒有這行 `waitFor`，「沒被消毒成 about:blank」那條唯一真正的守衛
    // 只在時序恰好之下才驗得到東西（同檔開頭 `humanEdit` 的理由(2)）；上面那條 url 斷言則因為
    // 種子裡本來就有這段 url 而恆真，測不出這裡有等。
    await waitFor("provider 收到", 3_000, () => docText(s.client.doc).includes("補一句"));
    expect(docText(s.client.doc)).toContain("/api/uploads/abc123");
    expect(docText(s.client.doc)).not.toContain("about:blank");
  });
});
