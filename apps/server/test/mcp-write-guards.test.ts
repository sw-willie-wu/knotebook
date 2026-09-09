/**
 * #108 PR2 Task 4：跨工具的驗收族——§14.5 的拒絕族（案 24–28(a)／29b／30／32／32b）、
 * 串行（案 22／M5）、以及案 14c 後半／14d（§8.4／§8.10）。
 *
 * 這是「兩支寫入工具都在了」之後才有鑑別力的一批：Task 1–3 各自的既有測試檔（
 * `mcp-edit-note.test.ts`／`mcp-create-note.test.ts`）已經驗過各工具**自己**的行為，
 * 本檔驗的是**跨工具**的東西——同一顆桶被兩支工具共用、同一個 service 讓 REST 與 MCP
 * 串行、同一套「拒絕就零副作用」紀律要在多種拒絕原因下都成立。
 *
 * 每一種拒絕都斷言（能斷的就斷）**四件事**（M6）：無新 `note_ai_edits` 列、live doc 內容
 * 位元組不變、`hocuspocus.documents` 未因此新增文件、無 presence 被 touch。共用的
 * `snapshot()`／`expectNoSideEffects()` 收在檔頭，避免四件事在每一案各寫一份、漏一件。
 *
 * ⚠ **presence 的「沒被 touch」逐案分兩種形，不是全部等價**（I1 修正）：拒絕路徑本身都在
 * `applyToNote` 真正 touch presence 之前就返回，差別在**呼叫 `snapshot()` 那一刻 awareness
 * 是不是已經因為「前面那發鋪陳用的成功呼叫」而非空**：
 * - **before 時 awareness 為空**（key 集合比較與深比對在這裡等價，走 key 集合即可）：
 *   案 24／25／26／27／28(a)／32／32b——這些案要嘛目標筆記從沒被任何呼叫碰過，要嘛
 *   `before` snapshot 拍在任何成功呼叫之前。
 * - **before 時 awareness 已非空**（key 集合比較對「偷 touch」零鑑別力，必須走深比對）：
 *   案 30——`before` 之前先有一發**成功**的 `append`（「先改一次」）讓這顆 token 的名牌現身，
 *   之後若 handler 偷跑一次 touch，只會「就地更新同一個 clientId 的 state」（`presence.ts:147`
 *   的 `emit(existing,"updated")`），key 集合一個字都不變——`mcp-edit-note.test.ts` D-N 案
 *   （`:258-268`）那個雷本檔只有案 30 會踩到，見該案內的深度比對與突變記述。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, notes } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { NUL } from "../src/notes/schemas.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";
import { ERROR_CODES } from "@knotebook/shared";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
}

interface EditPayload extends Record<string, unknown> {
  editId: string;
  fingerprint: string;
  outline: { sections: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint?: string }>; truncated: boolean };
  unboundWikilinks: number;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
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
const createNote = (app: FastifyInstance, token: string, args: Record<string, unknown> = {}) => callTool(app, token, "create_note", args);

/** REST 側的同一篇 outline——`sectionId`／`fingerprint` 的**獨立**真相。 */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    markdown: string;
    fingerprint: string;
    outline: Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
  };
}

const countNotes = async (ctx: CollabTestCtx, ownerId: string): Promise<number> =>
  (await ctx.db.select().from(notes).where(eq(notes.ownerId, ownerId))).length;

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  session: HttpSession;
  token: string;
  tokenId: string;
  noteId: string;
  disconnect: () => void;
}

/** ⚠ heading 一律**同級**：`## B` 會被 sectionize 併進 A 段（#106 三棒踩過三次）。 */
const THREE_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容\n\n# C\n\n第三段內容";

/** owner ＋ 一顆讀寫 PAT（名稱固定 "Claude Code" ⇒ agent label "claude"）＋ 一篇筆記。 */
async function scene(
  markdown: string | null = THREE_SECTIONS,
  opts: Parameters<typeof buildCollabTestApp>[0] = {}
): Promise<Scene> {
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
  return { ctx, ownerId: owner.id, session, token, tokenId, noteId: note.id, disconnect };
}

/** M6 四件零副作用的快照。`documents.get(noteId)` 可能是 `undefined`（例如目標筆記從沒被
 *  任何人開過的情境，見案 26）——那種情況 docText 視為空字串、awareness key 集合視為空。 */
interface SideEffectSnapshot {
  editsCount: number;
  docText: string;
  documentsSize: number;
  awarenessKeys: number[];
}

async function snapshot(ctx: CollabTestCtx, noteId: string): Promise<SideEffectSnapshot> {
  const doc = ctx.collab.hocuspocus.documents.get(noteId);
  return {
    editsCount: (await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId))).length,
    docText: doc ? docText(doc) : "",
    documentsSize: ctx.collab.hocuspocus.documents.size,
    awarenessKeys: doc ? [...doc.awareness.getStates().keys()].sort() : [],
  };
}

async function expectNoSideEffects(ctx: CollabTestCtx, noteId: string, before: SideEffectSnapshot): Promise<void> {
  const after = await snapshot(ctx, noteId);
  expect(after.editsCount, "M6：無新 note_ai_edits 列").toBe(before.editsCount);
  expect(after.docText, "M6：live doc 內容位元組不變").toBe(before.docText);
  expect(after.documentsSize, "M6：hocuspocus.documents 未因此新增文件").toBe(before.documentsSize);
  expect(after.awarenessKeys, "M6：無新名牌加入 awareness（本檔全是拒絕案，見檔頭）").toEqual(before.awarenessKeys);
}

describe("#108 §14.5 拒絕族：四件零副作用逐案照斷", () => {
  // 案 24：scope 不足（唯讀憑證呼叫 edit_note）→ (4a) 形，不是 insufficient_scope（P16）。
  // 本案的價值在四件零副作用照斷——與 `mcp-tools-list.test.ts` 案 10 的差異是那邊只斷
  // note_ai_edits 一件，本檔統一走完整四件。
  it("scope 不足（唯讀憑證呼叫 edit_note）→ SDK 的 (4a) 形，四件零副作用（案 24）", async () => {
    const s = await scene();
    const { token: ro } = await seedTokenForUser(s.ctx.db, s.ownerId, "notes:read", "Reader");
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, ro, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain("Tool edit_note not found");
    expect(call.result.structuredContent).toBeUndefined();
    s.disconnect();
  });

  // 案 25：viewer 呼叫 edit_note → forbidden。
  it("viewer 呼叫 edit_note → forbidden，四件零副作用（案 25）", async () => {
    const s = await scene();
    const viewer = await s.ctx.createUser({ email: `v-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.noteId, viewer.id, "viewer");
    const { token: viewerToken } = await seedTokenForUser(s.ctx.db, viewer.id, "notes:read notes:write", "Viewer PAT");
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, viewerToken, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("forbidden");
    s.disconnect();
  });

  // 案 26：role === "none"（別人的私有筆記）→ not_found，訊息與案 17（`NOTE_NOT_FOUND_MESSAGE`）
  // 逐位元組同形。⚠ 另外持一顆自己的 `edit` 桶，順手驗「`edit` 桶排在角色檢查之後扣、
  // role===none 的 404 不啃它」——這是下面 Step 3 突變（把 edit 桶移到 resolveRole 之前）
  // 唯一抓得住的地方（案 27 對那條突變零鑑別力，見該案註解）。
  // 突變實測（2026-09-09，`edit-note.ts` 把 `edit` 桶消耗那段移到 `resolveRole` 之前）：
  // 只有本案紅——`role===none 的 404 不得啃掉 edit 桶: expected 29 to be 30`（桶被啃掉一格）；
  // 其餘 11 案（含案 27）全綠，已 revert。
  it("角色為 none（別人的私有筆記）→ not_found，訊息與案 17 逐位元組同形，不啃 edit 桶，四件零副作用（案 26）", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const s = await scene(THREE_SECTIONS, { limiters: { edit } });
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const strangerNote = await s.ctx.createNote(stranger.id);
    const before = await snapshot(s.ctx, strangerNote.id);

    const call = await editNote(s.ctx.app, s.token, { note_id: strangerNote.id, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, strangerNote.id, before);
    // 順序守衛：`edit` 桶還是滿的——持有者手上這顆桶的 key 是裸 userId（`ctx.userId`）。
    let left = 0;
    while (edit.consume(s.ownerId)) left += 1;
    expect(left, "role===none 的 404 不得啃掉 edit 桶").toBe(EDIT_LIMIT.limit);

    const err = errorOf(call);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe(NOTE_NOT_FOUND_MESSAGE);
    s.disconnect();
  });

  // 案 27：`edit` 桶用罄 → too_many_requests。
  // ⚠ **本案對案 26 那條「edit 桶移到 resolveRole 之前」的突變確定零鑑別力**：本案的桶
  // `limit:0`，`consume()` 恆回 `false`，不管排在角色檢查前或後結果都是 `too_many_requests`
  // ——順序調換對本案的可觀察行為一個字都不改，守衛落在案 26 身上（見該案的突變記述）。
  it("edit 桶用罄 → too_many_requests，四件零副作用（案 27）", async () => {
    const s = await scene(THREE_SECTIONS, { limiters: { edit: new FixedWindowLimiter({ limit: 0, windowMs: 600_000 }) } });
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("too_many_requests");
    s.disconnect();
  });

  // 案 28(a)：佇列忙碌逾時（`editingQueueWaitMs: 50` ＋ `beforeMerge` 卡住）→ edit_note 回
  // `server_busy`。第一發卡在 `beforeMerge` 裡（佔住這篇筆記的佇列），第二發等不到、逾時。
  it("佇列忙碌逾時（editingQueueWaitMs: 50 ＋ beforeMerge 卡住）→ edit_note 回 server_busy，四件零副作用（案 28(a)）", async () => {
    let entered = false;
    let release: () => void = () => {};
    const hold = new Promise<void>(r => {
      release = r;
    });
    const s = await scene(THREE_SECTIONS, {
      editingQueueWaitMs: 50,
      editingTestHooks: {
        beforeMerge: async () => {
          entered = true;
          await hold;
        },
      },
    });
    const before = await snapshot(s.ctx, s.noteId);

    const first = editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "first" });
    await waitFor("first 已卡在 beforeMerge（佔住佇列）", 2_000, () => entered);

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(call);
    expect(err.code).toBe("server_busy");

    release();
    await first; // 讓第一發跑完，避免懸空 promise 拖到下一案。
    s.disconnect();
  });

  // 案 29b：兩種我們自產、而且 HTTP 上到得了的寫入側錯誤——`forbidden`（viewer，同案 25 的
  // 造法）與 `fingerprint_mismatch`——都在 `ERROR_CODES` 裡，且 `content[0].text` 鏡像
  // `structuredContent`（M10）。⚠ 規格 §14.5 案 29b 舉的 `insufficient_scope` 在整合層
  // （走 HTTP）不可達（P16）：唯讀憑證根本沒有 `edit_note` 可呼叫（案 24 的 (4a) 形），
  // 讀寫憑證在 `requireWriteScope` 第 1 步（session 或 scope 檢查）就放行——這是 P16 那條
  // 裁決漏列的第四處，逐字記在這裡免得下一輪對規格時判成漏做。
  it("寫入側的兩種我們自產錯誤（forbidden／fingerprint_mismatch）都在 ERROR_CODES 裡，且 content 鏡像 structuredContent（案 29b）", async () => {
    // forbidden：viewer 呼叫 edit_note（造法同案 25）。
    const s1 = await scene();
    const viewer = await s1.ctx.createUser({ email: `v-${randomUUID()}@example.com`, password: PASSWORD });
    await s1.ctx.share(s1.noteId, viewer.id, "viewer");
    const { token: viewerToken } = await seedTokenForUser(s1.ctx.db, viewer.id, "notes:read notes:write", "Viewer PAT");
    const forbiddenCall = await editNote(s1.ctx.app, viewerToken, { note_id: s1.noteId, op: "append", markdown: "x" });
    expect(forbiddenCall.result.isError).toBe(true);
    expect(forbiddenCall.result.content[0]!.text).toBe(JSON.stringify(forbiddenCall.result.structuredContent));
    expect(ERROR_CODES).toContain(forbiddenCall.result.structuredContent!.code);
    expect(forbiddenCall.result.structuredContent!.code).toBe("forbidden");
    s1.disconnect();

    // fingerprint_mismatch：過期 if_match（造法同 mcp-edit-note.test.ts 案 20）。
    const s2 = await scene();
    const before = await restOutline(s2.ctx.app, s2.noteId, s2.token);
    payloadOf<EditPayload>(await editNote(s2.ctx.app, s2.token, { note_id: s2.noteId, op: "append", markdown: "先改一次" }));
    const last = before.outline[before.outline.length - 1]!;
    const mismatchCall = await editNote(s2.ctx.app, s2.token, {
      note_id: s2.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "不該寫進去",
      if_match: last.fingerprint,
    });
    expect(mismatchCall.result.isError).toBe(true);
    expect(mismatchCall.result.content[0]!.text).toBe(JSON.stringify(mismatchCall.result.structuredContent));
    expect(ERROR_CODES).toContain(mismatchCall.result.structuredContent!.code);
    expect(mismatchCall.result.structuredContent!.code).toBe("fingerprint_mismatch");
    s2.disconnect();
  });

  // 案 30：指紋不符 → fingerprint_mismatch（零副作用面；回應形由 Task 2 的案 20 守，本案不重複）。
  // ⚠ **本案是本檔唯一「before 時 awareness 已非空」的案**（見檔頭列舉）：拿 `before` 快照
  //   之前先有一發**成功**的 `append`（「先改一次」，為了讓 `last.fingerprint` 過期而必須
  //   先寫一次），那一發會 touch presence——`snapshot()` 的 key 集合對「fingerprint_mismatch
  //   那條路徑偷 touch」因此零鑑別力，改走 `mcp-edit-note.test.ts:258-268`（D-N 案）的深度
  //   比對：同一顆 clientId 的整個 state（`structuredClone`）逐位元組比對。
  //   突變實測（2026-09-09，`edit-note.ts` 的 `mismatchError` 回傳前偷插一次
  //   `ctx.presence.touch(args.note_id, ctx.tokenId!, { name: "mut", color: "#000" },
  //   { kind: "doc-start" })`）：**只有深度比對那一行紅**（`beat` 從 2 變 3、`user.name` 從
  //   `"user-… (claude)"` 變 `"mut"`），`expectNoSideEffects()` 的四件（含 key 集合）排在它
  //   之前先跑、維持全綠——證明 key 集合對「fingerprint_mismatch 偷 touch」這條路徑確定零
  //   鑑別力，深度比對才是活的。已 revert。
  it("過期 if_match → fingerprint_mismatch，四件零副作用（presence 走深度比對，案 30；回應形由案 20 守）", async () => {
    const s = await scene();
    const before0 = await restOutline(s.ctx.app, s.noteId, s.token);
    payloadOf<EditPayload>(await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "先改一次" }));
    const last = before0.outline[before0.outline.length - 1]!;

    const doc = () => s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const clientId = presenceClientId(s.noteId, s.tokenId);
    const stateBefore = structuredClone(doc().awareness.getStates().get(clientId));
    expect(
      stateBefore,
      "前提：先前那發成功的 append 已經讓這顆 token 的名牌現身，否則下面的深度比對是恆真的"
    ).toBeDefined();
    const before = await snapshot(s.ctx, s.noteId);

    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: last.sectionId,
      markdown: "不該寫進去",
      if_match: last.fingerprint,
    });

    await expectNoSideEffects(s.ctx, s.noteId, before);
    expect(doc().awareness.getStates().get(clientId), "presence 的 state 沒有再被 touch（深度比對）").toEqual(stateBefore);

    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    s.disconnect();
  });

  // 案 32：兩支寫入工具各跑一次，`tokenWrite` 桶（覆寫成 `limit: 1`）用罄 → 被擋。
  // ⚠ `create_note` 那一發**要帶 `content`**（規格逐字）；`tokenWrite` 由測試自己持有並
  // 直接 `consume()` 吃掉唯一一格，不必先發一次浪費的成功呼叫。
  it("兩支寫入工具各跑一次：tokenWrite 桶（limit: 1）用罄 → 被擋（案 32）", async () => {
    {
      const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
      const s = await scene(THREE_SECTIONS, { limiters: { tokenWrite } });
      tokenWrite.consume(`token:${s.ownerId}`);
      const before = await snapshot(s.ctx, s.noteId);

      const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "不該寫進去" });
      await expectNoSideEffects(s.ctx, s.noteId, before);

      const err = errorOf(call);
      expect(err.code).toBe("too_many_requests");
      s.disconnect();
    }
    {
      const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
      const s = await scene(null, { limiters: { tokenWrite } });
      tokenWrite.consume(`token:${s.ownerId}`);
      const before = await countNotes(s.ctx, s.ownerId);

      const call = await createNote(s.ctx.app, s.token, { title: "T", content: "內容" });
      expect(await countNotes(s.ctx, s.ownerId), "M6：notes 表零新增列").toBe(before);

      const err = errorOf(call);
      expect(err.code).toBe("too_many_requests");
      s.disconnect();
    }
  });

  // 案 32b（Important 6，必辦）：扣點順序的唯一守衛。第一發打別人的私有筆記（role===none）→
  // not_found，但 `tokenWrite` 已被啃掉（`requireWriteScope` 排在 `resolveRole` 之前，
  // 對齊 REST 的 preHandler 扣點順序）；緊接著對自己的合法筆記發一發合法的 `edit_note` →
  // 被 `too_many_requests` 擋下。案 32 兩發都打看得見的筆記，對這個順序**確定**零鑑別力。
  // 突變實測（2026-09-09，`edit-note.ts` 把 `requireWriteScope(ctx)` 移到 `resolveRole` 之後）：
  // 只有本案紅（`expected undefined to be true`——第二發不再被擋，直接寫成功，`errorOf` 的
  // `isError` 斷言先炸）；其餘 11 案（含案 32）全綠，已 revert。
  it("扣點順序的唯一守衛：role=none 那發雖 404 仍啃 tokenWrite，緊接著合法一發被擋（案 32b）", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const s = await scene(THREE_SECTIONS, { limiters: { tokenWrite } });
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const strangerNote = await s.ctx.createNote(stranger.id);

    const first = await editNote(s.ctx.app, s.token, { note_id: strangerNote.id, op: "append", markdown: "x" });
    expect(errorOf(first).code).toBe("not_found");

    const before = await snapshot(s.ctx, s.noteId);
    const second = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "應該被擋" });
    await expectNoSideEffects(s.ctx, s.noteId, before);

    const err = errorOf(second);
    expect(err.code).toBe("too_many_requests");
    s.disconnect();
  });
});

describe("#108 串行（案 22／M5）", () => {
  // ⚠ 規格 rev 4 明文刪掉了結果碼形——改釘在併發本身：A（REST）卡在 `beforeMerge`，B（MCP）
  // 在那段期間發出，斷言 B 沒有進入 `beforeMerge`（`inFlight`／`maxInFlight` 計數形，照抄
  // `test/unit/editing-queue.test.ts:26-48`）。
  // 突變實測（2026-09-09，`app.ts` 的 `mcpRoutes({...})` 呼叫把共用的 `writes` 換成
  // `new NoteWriteService({...})`——MCP 自己一份 `NoteWriteQueue`，繞過與 REST 共用的實例）：
  // 本案紅在 `B 在 A 還卡著時沒有進入 beforeMerge: expected 2 to be 1`（`maxInFlight === 2`，
  // B 沒有排隊、直接跟 A 併發跑進 `beforeMerge`）。這是 Task 1 那整個重構唯一的行為面守衛，
  // 已 revert。
  it("REST 與 MCP 寫入同一篇筆記時仍然串行（inFlight 計數形，不是結果碼形，案 22／M5）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>(r => {
      releaseA = r;
    });
    let firstCall = true;
    const beforeMerge = async (): Promise<void> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (firstCall) {
        firstCall = false;
        await gateA;
      }
      inFlight -= 1;
    };
    const s = await scene(THREE_SECTIONS, { editingTestHooks: { beforeMerge } });
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);

    // A：REST `POST /:id/edits`，卡在 beforeMerge。
    const a = s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.noteId}/edits`,
      headers: bearer(s.token),
      payload: { op: "replace_all", markdown: "# A 改的\n\nA 的內容", if_match: rest.fingerprint },
    });
    await waitFor("A 已卡在 beforeMerge（佔住佇列）", 2_000, () => inFlight === 1);

    // B：MCP edit_note，同一篇筆記，帶**同一個**已被 A 佔用而必過期的 if_match。
    const b = editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_all",
      markdown: "# B 改的\n\nB 的內容",
      if_match: rest.fingerprint,
    });

    await new Promise(r => setTimeout(r, 30)); // 串行被破壞的話，這段時間足夠讓 B 併行跑進 beforeMerge
    expect(inFlight, "前提守衛：A 此刻確實還卡著，否則整案空轉").toBe(1);
    expect(maxInFlight, "B 在 A 還卡著時沒有進入 beforeMerge").toBe(1);

    releaseA();
    const aRes = await a;
    expect(aRes.statusCode, "A 的 REST 寫入成功").toBe(201);
    const bCall = await b;
    // 附帶斷言（不是 M5 的守點）：落敗方（B，if_match 已過期）拿到下列碼之一。
    expect(bCall.result.isError).toBe(true);
    expect(["fingerprint_mismatch", "section_not_found", "server_busy"]).toContain(bCall.result.structuredContent!.code);
    expect(maxInFlight).toBe(1);
    s.disconnect();
  });
});

describe("#108 案 14c 後半／14d（§8.4／§8.10）", () => {
  // 14c 後半：段落被截斷（`truncated: true`）時 `read_note_section` **不回** `fingerprint`；
  // 此時拿一個猜的／過期的 `if_match` 去 `replace_section` → `fingerprint_mismatch`。
  // （前半——讀完整段含 fingerprint——在 PR1 `mcp-content.test.ts` 案 14c 前半已有。）
  it("段落被截斷時 read_note_section 不回 fingerprint；拿猜的 if_match 去 replace_section → fingerprint_mismatch（案 14c 後半）", async () => {
    const LONG = "L".repeat(9_000);
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest.outline[1]!; // 「Long」段

    const page = payloadOf<{ section: { fingerprint?: string }; truncated: boolean }>(
      await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: target.sectionId })
    );
    expect(page.truncated).toBe(true);
    expect(page.section.fingerprint).toBeUndefined();

    // 猜的／過期的 if_match：格式合法（16 hex）但呼叫端從沒真的讀到過它。
    const guessed = "0".repeat(16);
    const call = await editNote(s.ctx.app, s.token, {
      note_id: s.noteId,
      op: "replace_section",
      section_id: target.sectionId,
      markdown: "# Long\n\n改過",
      if_match: guessed,
    });
    const err = errorOf(call);
    expect(err.code).toBe("fingerprint_mismatch");
    s.disconnect();
  });

  // 14d：期望結果是「成功」——零讀取繞過。`append` 一顆非空 block（不帶 `if_match`）→
  // 成功，回應帶整篇 `fingerprint`；再拿它 `replace_all` → 成功。**這是刻意行為不是洞**
  // （§8.10 的 (A) 裁決）：使用者會在筆記裡看到那段垃圾，而且 `note_ai_edits` 有一列、撤得回。
  // ⚠ `markdown: "\n"` 造不出來（`isBlankParseResult` 會回 `empty_content`）——測資是一顆
  //   真的非空 block。⚠ 測資用一篇已有內容、且 ≤100 段的筆記（`THREE_SECTIONS`）。
  it("append 不讀就寫、成功且回整篇 fingerprint，再用它 replace_all 也成功（案 14d／§8.10(A)）", async () => {
    const s = await scene(THREE_SECTIONS);
    const appended = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "# 零讀取追加\n\n沒讀過就寫的內容" })
    );
    expect(appended.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const edits = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.op).toBe("append");

    const replaced = payloadOf<EditPayload>(
      await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "replace_all", markdown: "# X\n\nxxx", if_match: appended.fingerprint })
    );
    expect(replaced.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    s.disconnect();
  });
});

describe("#108 M14 案 21b(ii) 的 HTTP 落點（「無任何落盤」那一半）", () => {
  // ⚠ **這半段的 schema 層 safeParse 斷言在 `test/unit/mcp-write-schemas.test.ts`**——這裡
  //   只補「同一份 payload 經 tools/call 打進去」的那一半：需要 `buildCollabTestApp()`（真
  //   DB），與 `vitest.unit.config.ts` 刻意不帶 `globalSetup`（保證 `test:unit` 永不用
  //   docker）衝突，所以搬到這個既有的整合測試檔。案號與斷言內容與 brief 原文一字不改。
  it("markdown 含 NUL：經 HTTP 也是 SDK 的 (4a) 形、note_ai_edits 零新增列（案 21b(ii)）", async () => {
    const s = await scene(null);
    const before = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));

    const call = await editNote(s.ctx.app, s.token, { note_id: s.noteId, op: "append", markdown: "x" + NUL });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    // SDK 自己拒絕 raw shape 驗證失敗的呼叫——(4a) 形，沒有 `structuredContent`（我們的
    // handler 從沒被呼叫到，`toolError()` 也就沒有機會產生它）。
    expect(call.result.structuredContent).toBeUndefined();

    const after = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.noteId));
    expect(after).toHaveLength(before.length);
    s.disconnect();
  });

  it("create_note 空字串 title：經 HTTP 也是 (4a) 形、notes 表零新增列（案 21b(ii)）", async () => {
    const s = await scene(null);
    const before = await countNotes(s.ctx, s.ownerId);

    const call = await createNote(s.ctx.app, s.token, { title: "" });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent).toBeUndefined();

    expect(await countNotes(s.ctx, s.ownerId)).toBe(before);
    s.disconnect();
  });
});
