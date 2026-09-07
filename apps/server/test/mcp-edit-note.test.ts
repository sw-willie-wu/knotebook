/**
 * #108 PR2 Task 2：`edit_note`（規格 §8.6、§14.4 案 19／19b／20／23、§14.2 案 8 的寫入側）。
 *
 * 全族走 `buildCollabTestApp`（＝生產形態）：依 D-M，`edit_note` 與兩支讀取工具一樣**只在
 * `collab` 與 `editing` 都在時才註冊**（它要寫 live doc）。
 *
 * ⚠ **唯讀憑證拿到的是 SDK 的「Tool not found」，不是 `insufficient_scope`**（plan P16）：
 * `McpServer` 的「清單」就是「註冊表」，`register.ts` 已經按 scope 過濾掉 `edit_note`，所以
 * `tools/call` 走的是 SDK 的未知工具名分支——**永遠到不了我們的 handler**。`insufficient_scope`
 * 那條分支在 HTTP 上是死碼，唯一的守衛是 `test/unit/mcp-write-scope.test.ts` 的第 2 發。
 * 這幾案（S2）剩下的鑑別力是 **M6 的四件零副作用**，那半是真的。
 *
 * ⚠ `callTool`／`payloadOf` 與 `mcp-content.test.ts`／`mcp-notes.test.ts` 的同名 helper 是**第三份**
 * （同樣的理由：`test/mcp-helpers.ts` 不在本棒的觸及面內，各自只有幾行）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { noteAiEdits } from "../src/db/schema.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { INITIALIZE, mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** 整個 wire body 的字串（「回應裡一個指紋／一個字的 markdown 都不得出現」那種掃描用）。 */
  raw: string;
}

interface EditPayload extends Record<string, unknown> {
  editId: string;
  fingerprint: string;
  outline: { sections: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint?: string }>; truncated: boolean };
  unboundWikilinks: number;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** 成功呼叫的 `structuredContent`（順手守住 M10 的鏡像等式）。 */
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as T;
}

/** 我們自產的 (4b) 工具錯誤。 */
function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

const editNote = (app: FastifyInstance, token: string, args: Record<string, unknown>) => callTool(app, token, "edit_note", args);

/** REST 側的同一篇 outline——`sectionId`／`fingerprint` 的**獨立**真相（段落指紋在 MCP 上只有
 *  讀完該段或前一次寫入成功才拿得到，測試不繞路去猜）。 */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    markdown: string;
    fingerprint: string;
    outline: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
  };
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  email: string;
  session: HttpSession;
  token: string;
  tokenId: string;
  noteId: string;
  disconnect: () => void;
}

/** owner ＋ 一顆讀寫 PAT（名稱固定 "Claude Code" ⇒ agent label "claude"）＋ 一篇已填內容的筆記。 */
async function scene(markdown: string | null, opts: Parameters<typeof buildCollabTestApp>[0] = {}): Promise<Scene> {
  const ctx = await buildCollabTestApp(opts);
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const session = await ctx.loginAs(email, PASSWORD);
  let disconnect = (): void => {};
  if (markdown !== null) {
    const client = await seedContent(ctx, session, note.id, markdown);
    disconnect = () => client.disconnect();
  }
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json()
    .ownerHandle as string;
  return { ctx, ownerId: owner.id, ownerHandle, email, session, token, tokenId, noteId: note.id, disconnect };
}

/** ⚠ heading 一律**同級**：`## B` 會被 sectionize 併進 A 段（#106 三棒踩過三次）。 */
const THREE_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容\n\n# C\n\n第三段內容";

/** 250 段（heading 逐段唯一編號）：19d 要 `truncated: true`，段數必須 ≥ 221——outline 是
 *  **251** 筆（`sectionize()` 無條件把 `_top` 放第 0 筆），`slice(120, 220)` 取 100 筆，
 *  `251 > 220` 才成立。150 段時 outline 只有 151 筆，`151 > 151` 為 false，**算術上不可能**。 */
const BIG_SECTIONS = 250;
const bigMarkdown = () =>
  Array.from({ length: BIG_SECTIONS }, (_, i) => `# ${String(i).padStart(4, "0")}\n\nbody-${String(i).padStart(4, "0")}`).join("\n\n");

describe("#108 edit_note：五個 op 的落盤與 REST 對等（案 19）", () => {
  // 每個 op 兩篇**種子完全相同**的筆記：一篇走 MCP、一篇走 REST，比對**匯出的 markdown**
  // （block id 是隨機的，`docText()` 比不了；markdown 是 id-free 的那一份真相）。
  // ⚠ **回應形不比**：MCP 的成功回應與 `NoteEditResultDto` 逐欄不同（19b 另案守），
  //   這一案守的是「落盤結果一樣」。
  it("五個 op 各一發：MCP 與 REST 落盤後匯出的 markdown 逐字相同，各留一列 note_ai_edits", async () => {
    const s = await scene(THREE_SECTIONS);
    const app = s.ctx.app;
    const NEW = "# B2\n\n改過的第二段";

    for (const op of ["replace_all", "replace_section", "insert_after", "append", "delete_section"] as const) {
      const mine = await s.ctx.createNote(s.ownerId);
      const theirs = await s.ctx.createNote(s.ownerId);
      const c1 = await seedContent(s.ctx, s.session, mine.id, THREE_SECTIONS);
      const c2 = await seedContent(s.ctx, s.session, theirs.id, THREE_SECTIONS);

      const build = async (noteId: string): Promise<Record<string, unknown>> => {
        const rest = await restOutline(app, noteId, s.token);
        const target = rest.outline[2]!; // 「B」段
        switch (op) {
          case "replace_all":
            return { op, markdown: NEW, if_match: rest.fingerprint };
          case "replace_section":
            return { op, section_id: target.sectionId, markdown: NEW, if_match: target.fingerprint };
          case "insert_after":
            return { op, section_id: target.sectionId, markdown: NEW, if_match: target.fingerprint };
          case "append":
            return { op, markdown: NEW };
          case "delete_section":
            return { op, section_id: target.sectionId, if_match: target.fingerprint };
        }
      };

      payloadOf<EditPayload>(await editNote(app, s.token, { note_id: mine.id, ...(await build(mine.id)) }));
      const rest = await app.inject({
        method: "POST",
        url: `/api/notes/${theirs.id}/edits`,
        headers: bearer(s.token),
        payload: await build(theirs.id),
      });
      expect(rest.statusCode, `${op} 的 REST 對照發`).toBe(201);

      const a = (await restOutline(app, mine.id, s.token)).markdown;
      const b = (await restOutline(app, theirs.id, s.token)).markdown;
      expect(a, `${op} 的落盤內容`).toBe(b);
      // 兩條路徑各留一列紀錄、op 相同（MCP 的寫入與 REST 在 `note_ai_edits` 上不可區分，§11.1）。
      for (const id of [mine.id, theirs.id]) {
        const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, id));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.op).toBe(op);
      }
      c1.disconnect();
      c2.disconnect();
    }
    s.disconnect();
  });
});

describe("#108 edit_note：成功回應的形（案 19b／19c／S4）", () => {
  it("頂層 key 集合逐字 {editId, fingerprint, outline, unboundWikilinks}；outline 只有 {sections, truncated}；每個 entry 都有 fingerprint（案 19b）", async () => {
    const s = await scene(THREE_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: rest.outline[2]!.sectionId,
        markdown: "# B2\n\n改過",
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    expect(Object.keys(out).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"].sort());
    // **沒有 `nextSectionOffset`**（§8.6 明文：沒有續讀入口就別回一個沒有工具收得下的游標）。
    expect(Object.keys(out.outline).sort()).toEqual(["sections", "truncated"].sort());
    expect(out.outline.sections.length).toBeGreaterThan(0);
    for (const entry of out.outline.sections) {
      // M12 的**明文例外**：只有 `edit_note` 的成功回應帶逐段指紋（D18 的 REST 對等）。
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(entry).sort()).toEqual(["chars", "fingerprint", "heading", "level", "sectionId"].sort());
    }
    expect(out.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(out.unboundWikilinks).toBe(0);
    s.disconnect();
  });

  it("append 不帶 section_id 成功、不帶 if_match 也成功（案 19c：M-7 的選配 ＋ P15 的逐鍵展開）", async () => {
    const s = await scene(THREE_SECTIONS);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "追加一行" })
    );
    expect(out.editId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).toContain("追加一行");
    s.disconnect();
  });

  // ⚠ **這兩發是 P15 那顆雷唯一的守衛**：`.strict()` 看的是 `Object.keys`，把 args 整包展開
  //   （不濾 `undefined`）之後，`{op:"append", section_id: undefined}` 會被判 `unrecognized_keys`
  //   → 每一發合法的 `append`／`delete_section` 都會退化成 `invalid_body`。實測過。
  it("逐鍵條件展開：append 不帶 section_id、delete_section 不帶 markdown，兩發都成功（S4／P15）", async () => {
    const s = await scene(THREE_SECTIONS);
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "追加一行" }));
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "delete_section",
        section_id: rest.outline[2]!.sectionId,
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).not.toContain("第二段內容");
    s.disconnect();
  });
});

describe("#108 edit_note：必填矩陣的拒絕側（D-N）", () => {
  // ⚠⚠ **這一發守的是「跳過指紋核對直接落盤」**，是資料正確性層級的關，不是形狀檢查。
  //   raw shape 把 `if_match` 宣告成 `.optional()`（它對 `append` 真的是選配），所以 SDK 的
  //   `validateToolInput` **會放行**一發不帶 `if_match` 的 `replace_section`；MCP 路徑上
  //   **唯一**擋下它的是 handler 第 2 步共用的 `editBodySchema`（per-op 必填矩陣）。
  //   那一關失效 ＝ 整段內容在沒有比對過指紋的情況下被覆寫，而且不會有任何錯誤。
  // 突變實測（2026-09-08）：把第 2 步換成恆 `success: true` 的直通 → **只有本案紅**，
  //   而且紅在**落盤那一件**（`note_ai_edits` 由 0 變 1）——所以下面的斷言順序刻意是
  //   「先四件副作用、後錯誤形」：`errorOf()` 會在 `isError` 那一行就中止整個 `it`，
  //   排在它後面的四件在突變下**一件都跑不到**，紅的訊息也就指不到病因。
  //   **本案之前，`invalid_body`／`invalidBodyMessage()` 在整份 PR2 零執行。**
  it("replace_section 不帶 if_match → invalid_body，訊息點名缺的欄位，且四件零副作用（D-N）", async () => {
    const s = await scene(THREE_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const doc = () => s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const before = docText(doc());
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    // ⚠ 這一發用的是**剛剛做過 `restOutline` 的那顆讀寫 token**，所以它的名牌此刻已經在
    //   awareness 上了，而寫入的 touch 用的是**同一組 `(noteId, tokenId)`**——只會就地更新
    //   同一個 clientId 的 state。**光比 key 集合抓不到「presence 被 touch」**（實測：突變讓
    //   寫入真的成功時，key 集合逐字不變）。所以這裡比的是**那顆 client 的整個 state 深度**：
    //   `PresenceRegistry.emit` 每次都寫一個新的 `beat`（`presence.ts` 逐字：「`beat` 不是
    //   裝飾品」），touch 一定改得動它。
    //   ⚠ **S2 沒有這個問題**是因為那邊的呼叫端是另一顆唯讀 token，clientId 不同、key 集合
    //   本身就是活的判準——**兩案的正確形不同，不要互抄。**
    const rwClientId = presenceClientId(s.noteId, s.tokenId);
    const keysBefore = [...doc().awareness.getStates().keys()].sort();
    const stateBefore = structuredClone(doc().awareness.getStates().get(rwClientId));
    expect(stateBefore, "前提：讀寫 token 的名牌此刻已在 awareness 上，否則下面那條深度比對是恆真的").toBeDefined();

    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: rest.outline[2]!.sectionId,
      markdown: "# 不該寫進去",
    });

    // M6 的四件：無新 `note_ai_edits` 列、live doc 內容不變、`documents` 沒多一份、
    // 無新名牌**且**既有那面名牌沒被 touch。
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    expect(docText(doc())).toBe(before);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    expect([...doc().awareness.getStates().keys()].sort()).toEqual(keysBefore);
    expect(doc().awareness.getStates().get(rwClientId)).toEqual(stateBefore);

    const err = errorOf(call);
    expect(err.code).toBe("invalid_body");
    // 訊息要點名缺的欄位，模型才知道自己少了什麼（`invalidBodyMessage()` 的唯一執行點）。
    expect(err.message).toContain("if_match");
    expect(err.message).toContain("replace_section");
    s.disconnect();
  });
});

describe("#108 edit_note：取頁規則（案 19d／19e／19f，D-J）", () => {
  // 19d／19e／19f **合為一個 `it`、共用一次 250 段的 `seedContent`**——散開就會 seed 好幾次。
  //
  // ⚠ **`sections[0]` 在 offset 0 那一頁恆為 `_top`，不是第一個編號段**：`sectionize()` 無條件
  //   把 `{sectionId:"_top", level:0, heading:"", chars:0}` 放在 outline 第 0 筆（連空文件都有）。
  //   所以三格「offset ＝ 0」一律斷言 `sectionId === "_top"`，不是 heading。
  // ⚠ **只有 `replace_section` 那一格用 `heading`，而且是對的**：它的 offset ≠ 0（＝落點那一段
  //   的索引），`_top` 不在那一頁；而新段的 `sectionId` 是寫入時才生出來的 uuid，測試事先不知道。
  //
  // ⚠ **順序刻意與 plan 的字面不同**：`replace_section` → `delete_section` → `append` →
  //   `replace_all`（plan 寫的是 append 在 delete_section 之前）。理由是 plan 同時要求
  //   「拿 `append` 回應裡的整篇 `fingerprint` 再發一次 `replace_all` 成功」——夾一發
  //   `delete_section` 在中間會讓那個指紋過期，兩條要求無法同時成立。`replace_all` 仍然排最後
  //   （它會把 250 段整個換掉），delete/append 的先後對三格取頁斷言沒有影響。
  it("250 段：replace_section 從落點起算且 truncated；delete_section／append／replace_all 從第 0 段起算", async () => {
    const s = await scene(bigMarkdown());
    const app = s.ctx.app;
    const before = await restOutline(app, s.noteId, s.token);
    expect(before.outline).toHaveLength(BIG_SECTIONS + 1); // `_top` ＋ 250 段

    // ── 19d：replace_section 打第 120 筆（heading 「0119」）→ 落點那一頁 ＋ truncated ──
    const marker = `WRITTEN-MARKER-${randomUUID()}`;
    const target = before.outline[120]!;
    expect(target.heading).toBe("0119");
    const written = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: target.sectionId,
        markdown: `# ${marker}\n\n改過的內容`,
        if_match: target.fingerprint,
      })
    );
    // 以 heading 開頭 ⇒ `afterBlockIds[0]` 就是那顆新 heading、它自成一段 ⇒ offset ＝ 120。
    expect(written.outline.sections[0]!.heading).toBe(marker);
    expect(written.outline.sections).toHaveLength(MCP_PAGE_MAX);
    expect(written.outline.truncated).toBe(true);
    // 落點那一頁**不含** `_top`——這正是它不是第 0 頁的正面證據。
    expect(written.outline.sections.map(x => x.sectionId)).not.toContain("_top");

    // ── 19d(b)：insert_after 也是 section-scoped → 落點那一頁（`.describe()` 逐字對模型宣告
    //    「replace_section **and insert_after**」，所以這一格不能只打 replace_section）──
    // ⚠ 突變實測（2026-09-08）：把 `insert_after` 從 `SECTION_SCOPED` 移出去 → **只有這兩行紅**
    //   （`expected '' to be 'INSERTED-MARKER-…'`）；沒有它，那半句宣告零守衛。
    const insertMarker = `INSERTED-MARKER-${randomUUID()}`;
    const insertTarget = (await restOutline(app, s.noteId, s.token)).outline[150]!;
    const inserted = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "insert_after",
        section_id: insertTarget.sectionId,
        markdown: `# ${insertMarker}\n\n插入的內容`,
        if_match: insertTarget.fingerprint,
      })
    );
    expect(inserted.outline.sections[0]!.heading).toBe(insertMarker);
    expect(inserted.outline.sections.map(x => x.sectionId)).not.toContain("_top");

    // ── 19f(a)：delete_section → offset ＝ 0 ──
    const mid = (await restOutline(app, s.noteId, s.token)).outline[200]!;
    const deleted = payloadOf<EditPayload>(
      await editNote(app, s.token, { note_id: s.noteId, op: "delete_section", section_id: mid.sectionId, if_match: mid.fingerprint })
    );
    // `delete_section` 的 `afterBlockIds` 恆為空 → `afterSectionIndex` 為 null → 第 0 頁。
    // 「被刪的那一段已經不存在」，「包含落點的那一頁」在它身上沒有定義（D-J 的刻意選擇）。
    expect(deleted.outline.sections[0]!.sectionId).toBe("_top");
    expect(deleted.outline.truncated).toBe(true);

    // ── 19f(b)：append → offset ＝ 0，而且那一頁**不含**剛 append 的那一段 ──
    // ⚠ 「以唯一 heading 開頭」對這一格是**必要條件**：不以 heading 開頭的 append 會被併進
    //   最後一段、根本不會有那個 heading，「整頁不含 marker」就變成恆真。
    const appendMarker = `APPENDED-MARKER-${randomUUID()}`;
    const appended = payloadOf<EditPayload>(
      await editNote(app, s.token, { note_id: s.noteId, op: "append", markdown: `# ${appendMarker}\n\n追加的內容` })
    );
    expect(appended.outline.sections[0]!.sectionId).toBe("_top");
    expect(appended.outline.sections.map(x => x.heading)).not.toContain(appendMarker);
    // 整篇 `fingerprint` 是**純量**，不受分頁影響——>100 段的筆記上照樣回得到（案 14d 的對照面）。
    expect(appended.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(appended.fingerprint).not.toBe(before.fingerprint);
    // 那一段真的寫進去了（marker 只是不在**這一頁**，不是沒寫成功）。
    expect((await restOutline(app, s.noteId, s.token)).markdown).toContain(appendMarker);

    // ── 19e：replace_all（拿上一發回應裡的整篇指紋）→ offset ＝ 0，`sections[0]` 是 `_top` ──
    const all = payloadOf<EditPayload>(
      await editNote(app, s.token, {
        note_id: s.noteId,
        op: "replace_all",
        markdown: "# X\n\nxxx\n\n# Y\n\nyyy",
        if_match: appended.fingerprint,
      })
    );
    expect(all.outline.sections[0]!.sectionId).toBe("_top");
    expect(all.outline.sections.map(x => x.heading)).toEqual(["", "X", "Y"]);
    expect(all.outline.truncated).toBe(false);
    s.disconnect();
  });
});

describe("#108 edit_note：錯誤側（案 20）", () => {
  it("過期 if_match → fingerprint_mismatch，structuredContent 恰為 {code, message, outline}，整個回應不含任何指紋與 markdown", async () => {
    const s = await scene(THREE_SECTIONS);
    const before = await restOutline(s.ctx.app, s.noteId, s.token);
    // 先用一發成功的 append 把最後一段改掉，讓它的指紋過期。
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "先改一次" }));
    // ⚠ `replace_section` 的指紋比對是**逐段**的，所以要打的是被改動的那一段——`append` 會把
    //   新 block 併進最後一段（「C」段），所以用 outline 最後一筆當目標。
    const last = before.outline[before.outline.length - 1]!;
    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "# 不該寫進去",
      if_match: last.fingerprint,
    });
    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    expect(Object.keys(err).sort()).toEqual(["code", "message", "outline"].sort());
    const outline = err.outline as { sections: Array<Record<string, unknown>>; truncated: boolean };
    expect(Object.keys(outline).sort()).toEqual(["sections", "truncated"].sort());
    // ⚠ **這一行是錯誤側取頁規則唯一的守衛**：取頁＝請求的 `section_id` 在**目前** outline
    //   的索引（這裡是 3，最後一段），退化成恆 0 時 `sections[0]` 會變成 `_top`。
    //   突變實測（2026-09-08）：把 `mismatchError()` 的 `const at = …` 拿掉、offset 恆 0
    //   → **只有本行紅**（`expected '_top' to be '<最後一段的 id>'`）；沒有它，那條規則
    //   在三段筆記上（outline 4 筆、一頁裝得下）**完全觀察不到**。
    expect(outline.sections[0]!.sectionId).toBe(last.sectionId);
    // **錯誤側一律不帶指紋**：你的視圖已經過期，遞一個新權杖讓你盲目重試是錯的。
    for (const entry of outline.sections) {
      expect(Object.keys(entry).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    // 非啟發式的第二道：`"fingerprint"` 這個**欄位名**一次都不得出現，`markdown` 同理
    // （案 20 逐字：回應裡不含任何 markdown——所以走 `loadNoteDoc` + `outlineOf`，不走
    // `readNoteContent`，那一支會 mount 編輯器並匯出整篇）。
    expect(call.raw).not.toContain('"fingerprint"');
    expect(call.raw).not.toContain('"markdown"');
    // 真值也逐一掃過（塞進 heading 也算命中）。
    const after = await restOutline(s.ctx.app, s.noteId, s.token);
    for (const fp of [after.fingerprint, ...after.outline.map(o => o.fingerprint)]) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(call.raw).not.toContain(fp);
    }
    // M6：拒絕不留副作用——那一發沒有再產生 `note_ai_edits` 列（只有前面那發 append 的一列）。
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("append");
    expect(after.markdown).not.toContain("不該寫進去");
    s.disconnect();
  });
});

describe("#108 edit_note：紀錄、撤回與 presence（案 23／23b）", () => {
  it("MCP 寫入後 REST 的修改紀錄看得到那一列（agentLabel 非 null、revertable），且撤得掉（案 23）", async () => {
    const s = await scene(THREE_SECTIONS);
    const out = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "AI 追加的一行" })
    );
    const list = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.noteId}/edits`, headers: bearer(s.token) });
    expect(list.statusCode).toBe(200);
    const edits = list.json().edits as Array<{ id: string; op: string; agentLabel: string | null; revertable: boolean }>;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.id).toBe(out.editId);
    expect(edits[0]!.op).toBe("append");
    // #106 D7：MCP 的寫入與 REST 寫入在紀錄上不可區分（§11.1），名牌一樣是 PAT 名稱派生的。
    expect(edits[0]!.agentLabel).toBe("claude");
    expect(edits[0]!.revertable).toBe(true);

    const revert = await s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.noteId}/edits/${out.editId}/revert`,
      headers: bearer(s.token),
    });
    expect(revert.statusCode).toBe(201);
    expect((await restOutline(s.ctx.app, s.noteId, s.token)).markdown).not.toContain("AI 追加的一行");
    s.disconnect();
  });

  it("MCP 的 replace_section → presence 落在寫入後的第一顆 block，不是原 heading 的 id（案 23b／M8）", async () => {
    const s = await scene(THREE_SECTIONS);
    const client = await s.session.connect(s.noteId);
    const clientId = presenceClientId(s.noteId, s.tokenId);
    const remote = () =>
      client.provider.awareness!.getStates().get(clientId) as { user?: { name: string }; cursor?: { anchor: unknown } } | undefined;
    const cursorText = (): string | null => {
      const r = remote();
      if (!r?.cursor) return null;
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r.cursor.anchor as never), client.doc);
      return abs ? (abs.type as Y.XmlText).toString() : null;
    };

    // 先讀整篇把游標拉到文件開頭（heading「A」），下面那一發才有鑑別力。
    await getContent(s.ctx.app, s.noteId, s.token);
    await tick();
    await waitFor("游標先在文件開頭", 2_000, () => (cursorText() ?? "").includes("A"));

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, {
        note_id: s.noteId,
        op: "replace_section",
        section_id: rest.outline[2]!.sectionId,
        markdown: "# B2\n\nAI 改過的第二段",
        if_match: rest.outline[2]!.fingerprint,
      })
    );
    await tick();
    await waitFor("名字到達", 2_000, () => remote()?.user?.name === `${s.ownerHandle} (claude)`);
    // `replace_section` 把 heading 一起換掉了 → 舊 section_id 已不存在。目標若還用它（自組
    // `{kind:"section", sectionId: args.section_id}` 是**編得過**的），cursorFor 找不到就退回
    // 文件開頭（＝「A」），這條就紅。
    await waitFor("游標落在新寫下的 B2 heading", 2_000, () => (cursorText() ?? "").includes("B2"));
    expect(cursorText()).not.toContain("A");
    client.disconnect();
  });
});

describe("#108 edit_note：宣告面與 scope 過濾（案 S1／S2／S3）", () => {
  // ⚠ **這一案是 P6 那個症狀唯一的守衛**：把整個 `editBodySchema`（zod v3 的
  //   discriminatedUnion）當 `inputSchema` 傳給 `registerTool` **不會 throw、執行期驗證
  //   照常**，但公告出去的 JSON Schema 會靜默變成 `{"type":"object","properties":{}}`
  //   （entry 從 641 bytes 掉到 126，模型看不到任何欄位）。突變實測（2026-09-08）：本案紅在
  //   `expected [] to deeply equal ['if_match','markdown',…(3)]`。
  // ⚠ 同一條突變在**今天的接線上**還讓另外八案紅，但那是巧合不是守衛——raw shape 有
  //   `note_id` 而 union 每個分支都 `.strict()`，所以每一發呼叫都被判 `unrecognized_keys`。
  //   union 哪天多一個 `note_id` 鍵，那八案就全部恢復綠，只剩本案紅。
  it("tools/list 的 edit_note.inputSchema.properties 含全部五個欄位名（S1／P6）", async () => {
    const s = await scene(null);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    const entry = tools.find(t => t.name === "edit_note");
    expect(entry, "讀寫憑證的 tools/list 必須含 edit_note").toBeDefined();
    expect(Object.keys(entry!.inputSchema!.properties ?? {}).sort()).toEqual(
      ["if_match", "markdown", "note_id", "op", "section_id"].sort()
    );
  });

  // ⚠ **不是 `insufficient_scope`**（P16，見檔頭）：註冊時已按 scope 過濾，唯讀憑證拿到的是
  //   SDK 的 (4a) 形——`isError` ＋ 「Tool edit_note not found」＋ **沒有** `structuredContent`。
  //   本案真正的價值在下半段的四件零副作用（M6）。
  it("唯讀憑證：tools/list 不含 edit_note，直接呼叫拿到 SDK 的 (4a) 形，且零副作用（S2）", async () => {
    const s = await scene(THREE_SECTIONS);
    const { token: ro, tokenId: roTokenId } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");
    const list = await mcpPost(s.ctx.app, rpc("tools/list"), { token: ro });
    const names = (list.json().result.tools as { name: string }[]).map(t => t.name);
    expect(names).not.toContain("edit_note");

    const before = docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!);
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const call = await editNote(s.ctx.app, ro, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: rest.outline[2]!.sectionId,
      markdown: "# 不該寫進去",
      if_match: rest.outline[2]!.fingerprint,
    });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain("Tool edit_note not found");
    expect(call.result.structuredContent).toBeUndefined();

    // M6 的四件：無新 `note_ai_edits` 列、live doc 內容不變、`documents` 沒多一份、無 presence。
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId))).toHaveLength(0);
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!)).toBe(before);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    // ⚠ **這裡不能寫 `awareness.getStates().size === 0`，理由不是「種子留了一條瀏覽器連線」**
    //   （實測 2026-09-08：`seedContent` 之後 awareness **是空的** size=0——那個 provider
    //   不設 awareness 狀態）。真正的原因是**上面那一發帶 token 的 `GET /content`**
    //   （`restOutline`）touch 了讀取 presence，所以此刻 awareness 恰好有**讀寫那顆 token**
    //   的名牌。所以正確形是釘住**用戶端識別的集合**：唯讀那顆 token 的名牌不得出現。
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    expect([...doc.awareness.getStates().keys()].sort()).toEqual([presenceClientId(s.noteId, s.tokenId)]);
    expect([...doc.awareness.getStates().keys()]).not.toContain(presenceClientId(s.noteId, roTokenId));
    s.disconnect();
  });

  // D-Q：`instructions` 是 **per-request 二選一**（不是相加）。兩支共用同一段 BASE，尾巴
  // 依憑證挑一支——P11 量過讀寫那支只剩 23 字元餘裕，再追加一句必破 1000。
  // ⚠ 讀寫版**現在就在講 `create_note`**，而那支工具要到下一棒才存在——那是刻意的（字串是
  //   一份）。**本案只斷言字串內容，不得順手加「`tools/list` 含 create_note」那種斷言。**
  it("instructions 二選一：唯讀版含處置字樣且不提寫入工具，讀寫版講寫入工具，兩版都 ≤ 1000（S3／D-Q）", async () => {
    const s = await scene(null);
    const { token: ro } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");

    const rw = (await mcpPost(s.ctx.app, INITIALIZE, { token: s.token })).json().result.instructions as string;
    const readOnly = (await mcpPost(s.ctx.app, INITIALIZE, { token: ro })).json().result.instructions as string;

    expect(rw).toContain("edit_note");
    expect(rw).toContain("create_note");
    expect(rw).toContain("notes:write");
    expect(rw.length).toBeLessThanOrEqual(1000);

    // D7 的處置字樣：`insufficient_scope` 那條路在 HTTP 上到不了模型，`instructions` 是它
    // 唯一到得了的落點。對唯讀憑證描述它沒有的工具，與 D32「不宣告我們做不到的 capability」
    // 是同一個原則——所以這一版**刻意不提**兩支寫入工具的名字。
    expect(readOnly).toContain("Settings");
    expect(readOnly).toContain("notes:write");
    expect(readOnly).not.toContain("edit_note");
    expect(readOnly).not.toContain("create_note");
    expect(readOnly.length).toBeLessThanOrEqual(1000);
    // 兩版真的不同（同一個常數兩邊都回的話上面全部照樣綠，除了這一行）。
    expect(readOnly).not.toBe(rw);
  });
});
