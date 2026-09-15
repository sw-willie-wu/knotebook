/**
 * #108 PR2 Task 3：`create_note`（規格 §8.7、§14.4 案 21／21a／21b／28(b)、裁決 D-M）。
 *
 * ⚠ **D-M 那一案走 `buildTestApp`（無 collab），其餘走 `buildCollabTestApp`**——`create_note`
 * 是唯一**不**進部署形態閘門的工具：不帶 `content` 時它只 insert 一列，完全不碰 live doc，
 * 而 REST 的 `POST /api/notes` 本來就無條件註冊、帶 content 而沒有 collab 時回 400
 * （`routes/notes.ts` 逐字「此部署不支援帶內容建立筆記」）。MCP 照抄它就是 D18 的對等。
 * ⚠ **每一案都用讀寫憑證**：唯讀憑證在**註冊時**就被過濾掉 `create_note`，用它寫這一族會得到
 * 一個與被測對象無關的綠（唯讀側的斷言是 `mcp-tools-list.test.ts` 案 8 的事）。
 *
 * ⚠ `callTool`／`payloadOf`／`errorOf` 與 `mcp-edit-note.test.ts` 的同名 helper 是**第四份**
 * （同樣的理由：`test/mcp-helpers.ts` 不在本棒的觸及面內，各自只有幾行）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { QueueBusyError } from "../src/notes/editing/queue.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { UserGate } from "../src/auth/session.js";
import { buildCollabTestApp, buildTestApp, freshDb, freshLimiters, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { Db } from "../src/db/index.js";
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
}

interface NoteSummary {
  id: string;
  title: string;
  titleTruncated?: true;
  ownerHandle: string;
  slug: string;
  url: string;
  role: string;
  updatedAt: string;
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}

/** 成功呼叫的 `structuredContent`（順手守住 M10 的鏡像等式）。 */
function payloadOf(call: ToolCall): { note: NoteSummary } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as { note: NoteSummary };
}

/** 我們自產的 (4b) 工具錯誤。 */
function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

const createNote = (app: FastifyInstance, token: string, args: Record<string, unknown> = {}) =>
  callTool(app, token, "create_note", args);

const countNotes = async (db: Db, ownerId: string): Promise<number> =>
  (await db.select().from(notes).where(eq(notes.ownerId, ownerId))).length;

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  token: string;
  tokenId: string;
}

/** owner ＋ 一顆讀寫 PAT（名稱固定 "Claude Code" ⇒ agent label "claude"）。**不預建筆記**——
 *  這一族的被測對象就是「建出來的那一篇」，多一篇會讓 `countNotes` 的斷言要多記一個基數。 */
async function scene(opts: Parameters<typeof buildCollabTestApp>[0] = {}): Promise<Scene> {
  const ctx = await buildCollabTestApp(opts);
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const [row] = await ctx.db.select().from(users).where(eq(users.id, owner.id));
  return { ctx, ownerId: owner.id, ownerHandle: row!.handle, token, tokenId };
}

describe("#108 create_note", () => {
  // 案 21：「解析在建列**之前**」是逐字寫下的契約（`write-service.ts` 的 docstring），所以壞
  // content 一列都不會建。
  // ⚠ **plan 寫的測資（「含不支援的 block」→ `unsupported_block`）在整合層造不出來**，理由與
  //   `note-edits.test.ts:322-328` 逐字寫過的完全相同：headless schema ＝ `defaultBlockSpecs`
  //   全集＋mermaid／codeBlock，**BlockNote 的 markdown parser 產得出來的 type 一定在白名單裡**，
  //   所以 `unsupported_block` 這個碼從 markdown 到不了。白名單那條分支由
  //   `test/unit/editing-markdown.test.ts` 以收窄的假 schema 驗。這裡改用**同一條管線上到得了**
  //   的 `empty_content`（與 REST 的 `note-create-content.test.ts` 第二案同一份測資），
  //   被測的契約（先解析、後建列）一個字都沒變。
  // 突變實測（把 `createWithContent` 的 insert 搬到解析**之前**）：本案紅（`expected 1 to be +0`）。
  // ⚠ **但本案不是那條契約唯一的守衛**——同一條突變也讓 `note-create-content.test.ts` 的
  //   「壞 content → 400 無新列」紅（兩案共用 service 裡那一份實作）。本案獨有的是「MCP 這條
  //   呼叫路徑上也成立」。
  it("壞 content → 對應的 parse 錯誤碼，且 notes 表零新增列（案 21）", async () => {
    const s = await scene();
    const call = await createNote(s.ctx.app, s.token, { title: "T", content: "   \n" });
    const err = errorOf(call);
    expect(err.code).toBe("empty_content");
    expect(err.message).toBeTruthy();
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(0);
  });

  // 案 21a：不帶 `content` ＝ REST 的 201 等價（DB 的 default 標題、`lastEdited` 恆 null）。
  // `title` 未帶時**整把鍵都不放進 values**（`notes/create.ts` 的 `insertNoteWithAutoSlug`），
  // DB 的 default `"Untitled"`／`untitled-<uuid8>` 才生效——應用層不再寫死第二份同一個字面量。
  it("不帶 content → 成功，title 走 DB default、url 逐字等於 canonicalNotePath、lastEdited 為 null（案 21a）", async () => {
    const s = await scene();
    const { note } = payloadOf(await createNote(s.ctx.app, s.token));

    expect(note.title).toBe("Untitled");
    expect(note.role).toBe("owner");
    expect(note.ownerHandle).toBe(s.ownerHandle);
    expect(note.url).toBe(canonicalNotePath({ ownerHandle: s.ownerHandle, slug: note.slug }));
    expect(note.titleTruncated).toBeUndefined();

    // 真的建出來了（回應不是憑空組的）。
    const [row] = await s.ctx.db.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.ownerId).toBe(s.ownerId);
    expect(row!.title).toBe("Untitled");
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(1);

    // ⚠ **這條路是一次裸 insert：不留任何 `note_ai_edits` 列** ⇒ 沒有 editId、**沒有東西撤得回**。
    //   `CREATE_NOTE_DESCRIPTION` 的末句因此限定到帶 `content` 那條路——原本寫成「Creating a
    //   note is recorded and can be undone like any other write.」是對模型說謊，而模型會照它
    //   決定「先建空筆記再 edit_note」安不安全。**本行守的是那個事實**（文案本身的逐字檢查歸
    //   Task 5 的列舉句實打）。
    // ⚠ **它必須排在下面那行 `lastEdited` 之前**：兩者會被同一種迴歸（讓這條路也走
    //   `createWithContent`）一起打紅，而 vitest 在第一個失敗就中止整個 `it`——排在後面的話，
    //   紅的訊息會是「`lastEdited` 不是 null」，指不到「多了一列可撤回紀錄」這個病因。
    //   突變實測（`args.content ?? "New note"` ＋ 恆走 content 分支）：紅在**本行**。
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    expect(note.lastEdited).toBeNull();
  });

  // #145：issue 的原始症狀在測試層的直接反例——demo 實測用 `create_note` 帶
  // `title: "#108 PR3 實機驗證 2026-09-14"` 建出來的筆記網址是 `untitled-c2af7053`。
  // 派生在建列的同一發裡完成，所以**同一次回應**的 `slug`／`url` 就是最終值，不需要第二次寫入。
  it("#145：帶 title → 同一次回應的 slug 與 url 就是派生形（不是 untitled-<8hex>）", async () => {
    const s = await scene();
    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "MCP Title 145" }));

    // ⚠ 第一條斷言是 `slug`：這是 issue 的症狀本身，排前面才讓漏改 MCP 那條路的突變紅在病因上。
    expect(note.slug).toBe("mcp-title-145");
    expect(note.url).toBe(canonicalNotePath({ ownerHandle: s.ownerHandle, slug: "mcp-title-145" }));
    expect(note.url).not.toMatch(/untitled-[0-9a-f]{8}$/);

    // 回查 DB：回應不是憑空組的（`url` 走 `canonicalNotePath`，`slug` 來自 insert 的 returning）。
    const [row] = await s.ctx.db.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.slug).toBe("mcp-title-145");
    expect(row!.slugIsCustom).toBe(false);
  });

  // 案 21b：帶 content 走的是 REST `POST /api/notes` 的**同一條管線**（`createWithContent`），
  // 所以落盤內容必須逐欄相同。⚠ 兩篇筆記的 `sectionId` 是 block id，必然不同；`fingerprint`
  // 不含 id（`canonicalizeNode` 逐字濾掉 `id`），所以它是可比的那一欄。
  // `lastEdited` 非 null 是**重讀那一步**的守衛：insert 的 `returning()` 那一列在合併之前就
  // 取好了，四欄還是 null，不重讀就恆得 `lastEdited: null`。
  it("帶合法 content → 落盤內容與 POST /api/notes 同一份 content 逐欄相同，且 lastEdited 非 null（案 21b）", async () => {
    const s = await scene();
    const CONTENT = "# 標題一\n\n第一段內容\n\n# 標題二\n\n第二段內容";

    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "MCP", content: CONTENT }));
    const rest = await s.ctx.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: bearer(s.token),
      payload: { title: "REST", content: CONTENT },
    });
    expect(rest.statusCode).toBe(201);

    const mine = (await getContent(s.ctx.app, note.id, s.token)).json();
    const theirs = (await getContent(s.ctx.app, rest.json().id as string, s.token)).json();
    expect(mine.markdown).toBe(theirs.markdown);
    expect(mine.fingerprint).toBe(theirs.fingerprint);
    const shape = (o: { outline: Array<{ level: number; heading: string; chars: number; fingerprint: string }> }) =>
      o.outline.map(e => ({ level: e.level, heading: e.heading, chars: e.chars, fingerprint: e.fingerprint }));
    expect(shape(mine)).toEqual(shape(theirs));

    // 重讀那一步的守衛（拿掉它 → 恆為 null）。落款人是呼叫者本人，agent 名來自 token 名稱。
    expect(note.lastEdited).not.toBeNull();
    expect(note.lastEdited!.byHandle).toBe(s.ownerHandle);
    expect(note.lastEdited!.agentLabel).toBe("claude");
    expect(note.title).toBe("MCP");
  });

  // 案 28(b)：**這一案測的是「catch 不分辨例外型別 → 刪列 → `internal`」那條映射**，
  // ⚠ **不是**真的佇列逾時。`QueueBusyError` 在建立路徑上**結構性不可達**：`NoteWriteQueue` 是
  //   per-note 的，而這條路用的是**這一發剛 insert 的新 id**，`chains.get(newId)` 恆為空、gate
  //   立刻 resolve `"ok"`，沒有任何併發者拿得到它。所以這裡直接從 `beforeMerge`（我們自己的
  //   注入縫）把那顆例外丟出來，走的是同一條 catch。
  //   順帶：`docs/ai-editing.md` 逐字寫的「including waiting too long for the queue」描述的是
  //   一條到不了的路徑（已回報 controller，本棒不改那句）。
  it("帶 content 時 beforeMerge 丟 QueueBusyError → internal 不是 server_busy，且剛建的列已被刪（案 28(b)）", async () => {
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { throw new QueueBusyError(); } } });
    const err = errorOf(await createNote(s.ctx.app, s.token, { title: "T", content: "內容" }));
    expect(err.code).toBe("internal");
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(0);
  });

  // 裁決 D-M：判準是「這支工具要不要讀 live doc」，不是「它比較像哪一支」。
  // ⚠ 用**讀寫**憑證（唯讀憑證看不到 `create_note`，那樣寫這一案恆綠且與 D-M 無關）。
  // ⚠ **`edit` 桶由測試自己持有**（`freshLimiters({ edit })`）：唯一到得了「`available` 為假」
  //   那個分支的部署形態就是這個 app，而它上面 `edit` 桶**沒有第二個消費端**——但那不代表
  //   觀察不到。桶握在測試手上，直接數它剩幾格就是判準（見本案最後兩行）。
  it("無 collab 的 app：tools/list 含 create_note，不帶 content 可用、帶 content → invalid_body 零新增列且不啃 edit 桶（D-M）", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit }) });
    const [user] = await db.insert(users).values({ email: `p-${randomUUID()}@example.com`, displayName: "P" }).returning();
    const userId = user!.id;
    const { token } = await seedTokenForUser(db, userId, "notes:read notes:write");

    const list = await mcpPost(app, rpc("tools/list"), { token });
    const tools = list.json().result.tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    const names = tools.map(t => t.name).sort();
    expect(names).toContain("create_note");
    // 讀 live doc 的三支在這個部署形態上整條不宣告——`create_note` 是它們的反例，所以
    // 這一行順帶釘住「它真的在閘門外」。
    expect(names).toEqual(["create_note", "list_notes", "search_notes"]);

    // P6：`inputSchema` **只能傳 raw shape**——傳錯時公告出去的 JSON Schema 會靜默變成
    // `{"type":"object","properties":{}}`（模型看不到任何欄位），而本檔另外五案（全部都自己
    // 送對參數）**照樣全綠**。這一行是那個症狀在 `create_note` 上唯一的守衛（`edit_note` 是 S1）。
    // ⚠ **「傳錯」在這支工具上是哪一種形，是量出來的，不是照抄 P6**（2026-09-08 實跑）：
    //   - `z.object(createNoteInput)`（純 `ZodObject`）→ 公告的 schema **與 raw shape 逐位元組
    //     相同**（entry 都是 1995）。**這條突變殺不掉**——P6 量的是 `z.discriminatedUnion`。
    //   - `z.object(createNoteInput).refine(…)`（`ZodEffects`）→ **properties 真的空掉**
    //     （entry 1995 → 1467），而且**只有本行紅**（`expected [] to deeply equal
    //     [ 'content', 'title' ]`），`mcp-create-note` 另外五案 ＋ `mcp-edit-note` 12 案全綠。
    //   也就是本行守的是 `ZodEffects`／union 那一族，不是「所有非 raw shape 的寫法」。
    const entry = tools.find(t => t.name === "create_note")!;
    expect(Object.keys(entry.inputSchema.properties ?? {}).sort()).toEqual(["content", "title"]);

    const { note } = payloadOf(await createNote(app, token));
    expect(note.title).toBe("Untitled");
    expect(await countNotes(db, userId)).toBe(1);

    const err = errorOf(await createNote(app, token, { title: "T", content: "x" }));
    expect(err.code).toBe("invalid_body");
    expect(await countNotes(db, userId)).toBe(1);

    // M6（拒絕零副作用）＋ `create-note.ts` 那兩行的**順序**：`available` 閘門排在扣 `edit` 桶
    // **之前**，所以上面那兩發（不帶 content 的成功建立、帶 content 的 `invalid_body`）
    // **一格都不該啃**。桶是這個測試自己 new 的，所以「還剩幾格」直接數得出來——不需要
    // 第二個消費端。突變實測（兩行對調）：本行紅，`expected 29 to be 30`。
    let left = 0;
    while (edit.consume(userId)) left += 1;
    expect(left, "帶 content 的 invalid_body 與不帶 content 的成功建立都不得消耗 edit 桶").toBe(EDIT_LIMIT.limit);
  });

  // #145 ＋ M6（拒絕零副作用）：`insertNoteWithAutoSlug` 會發探測查詢，所以它**不能**擺在
  // `ctx.writes.available` 閘門之前（本棒之前那個位置只是在組一個 values 物件，純物件、零
  // 查詢，擺在閘門前無妨）。搬回去的話「這個部署不支援 content」的拒絕路徑就開始打 DB。
  //
  // ⚠ **這一案守的是哪一形，是量出來的**（2026-09-15 實測，兩發突變）：
  //   (a) **整支呼叫**搬到閘門之前 → 4 failed / 4 passed，紅的是 D-M 的 `countNotes`
  //       （`expected 2 to be 1`）、案 21 與案 28(b) 的零新增列（`expected 1 to be +0`），
  //       **再加本案的 `probes()`**。也就是說既有的列數斷言**抓得到**這一形——原本這裡寫
  //       「D-M 一條都不會紅」是把因果說反了。
  //   (b) **只把探測搬到閘門之前、INSERT 留在原位** → **整包 925 案只有本案紅**，紅在
  //       `probes()`（`expected [Array(1)] to have a length of +0 but got 1`）——列數一列
  //       都沒動 ⇒ `probes()` 半邊是 (b) 形唯一的守衛，這才是本案的價值。
  it("#145／M6：帶 content 的拒絕路徑（無 collab）零探測、零建列", async () => {
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // gate 也要跟著換（同 `notes-slug.test.ts` 的語句形狀案）：只換 db 會讓認證查到另一個庫。
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb), limiters: freshLimiters() });
    const [user] = await db.insert(users).values({ email: `q-${randomUUID()}@example.com`, displayName: "Q" }).returning();
    const { token } = await seedTokenForUser(db, user!.id, "notes:read notes:write");

    const probes = () => queries.filter(q => /^select/i.test(q.trim()) && /"slug"\s*=/.test(q));
    const noteInserts = () => queries.filter(q => /^insert into "notes"/i.test(q.trim()));

    queries.length = 0;
    const err = errorOf(await createNote(app, token, { title: "X", content: "x" }));
    expect(err.code).toBe("invalid_body");
    expect(probes()).toHaveLength(0);
    expect(noteInserts()).toHaveLength(0);

    // **自我驗證刻意排在後面**（與 `notes-slug.test.ts` 語句形狀案的 N3 規矩相反，理由是
    // 「失配時誰會先紅」）：那一案兩半各自發請求、各自數自己那批 query，regex 失配時「恰 0」
    // 那半**真空通過**而「恰 1」那半**會紅**，所以「恰 1」必須排前面。這裡「恰 0」那半是
    // **拒絕路徑**（本來就不該有 query），失配時它同樣真空通過、不會失敗 ⇒ vitest 不會提前
    // 中止，後面這半照樣跑得到並且會紅。**兩案的順序不同是算過的，不是抄漏。**
    queries.length = 0;
    const { note } = payloadOf(await createNote(app, token, { title: "X" }));
    expect(note.slug).toBe("x");
    expect(probes()).toHaveLength(1);
    expect(noteInserts()).toHaveLength(1);
  });

  // 案 P：`create_note` **不 touch presence**——`routes/notes.ts` 搬進 service 的那段註解逐字
  // 「另外三條寫入路徑都 touch，只有它不 touch 是刻意的——不要當成漏接補上去」。
  //
  // ⚠⚠ **誠實：這一案抓不到「有人把 touch 補回去」，plan 的突變預期不成立**（實跑推翻）。
  //   plan 寫「加上 `presence?.touch(...)` → 案 P 必須紅」；2026-09-08 在
  //   `createWithContent` 的 `applyEdit` 成功之後補上
  //   `this.touch(note.id, …, presenceTargetForWrite("replace_all", result.afterBlockIds))`
  //   → **59 案全綠**。
  //   原因就是 `write-service.ts` 那段註解自己寫的那句：`PresenceRegistry.touch` 內部要先
  //   `documents.get(noteId)`，而這篇筆記是這一發剛建出來的、直連在 `applyEdit` 結束時就
  //   `disconnect()` 了，**文件那一刻必然沒有載入 ⇒ touch 必然是 no-op**。
  //   造不出反例的原因（都試過了）：(a) 呼叫前不可能有人連上一篇還不存在的筆記；
  //   (b) 事後連上去看 awareness 也沒用——awareness 不落盤，那時的狀態早就沒了；
  //   (c) `buildCollabTestApp` 沒有可注入的假 `PresenceRegistry`（只收 `presenceOptions`）。
  //   **所以「不 touch」在這條路徑上是由構造保證的，不是被測試守著的**——本案守的是**結果面**：
  //   建完之後 hocuspocus 不留一份載入中的文件。它擋得住「直連沒關」那一類的迴歸，
  //   **擋不住「補一行 touch」**。
  //   ⚠ 本案**沒有任何 awareness／presence 斷言**（`it` 的標題因此也不提名牌）：那篇筆記連
  //   文件都沒有載入，`documents.get(id)` 是 `undefined`，根本沒有 awareness 物件可以比。
  it("create_note 之後 hocuspocus 不留一份載入中的文件（案 P）", async () => {
    const s = await scene();
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "T", content: "# H\n\n內容" }));

    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    expect(s.ctx.collab.hocuspocus.documents.get(note.id)).toBeUndefined();
  });
});
