/**
 * #108 PR1 Task 5／PR2 Task 4：`tools/list` 的內容（規格 §14.2 案 8～10、案 2 的
 * `listChanged` 那半）與批次（§10.3／§14.6 案 33）。
 *
 * 兩種 harness 各有被測對象，**不可互換**（D-A 的分工表）：
 * - `buildCollabTestApp` ＝生產形態（collab ＋ editing 都在）→ 讀寫憑證上六支工具全在。
 * - `buildTestApp` ＝無 collab → 只有查得動 DB 的工具（讀寫憑證上多 `create_note`，D-M）。
 *
 * ⚠ **案 8 從 PR2 起才是守衛**：PR1 落地時 `edit_note`／`create_note` 還不存在，那兩行
 * `not.toContain` 是同義反覆（PR1 的 PR 描述已聲明過，不得回頭宣稱它當時守住了 scope 過濾）。
 * 案 9／9b／10（讀寫憑證六支、寫死的六元清單、跳過清單直接呼叫 `edit_note`）與 P13 的
 * `runTool()` 涵蓋率是本棒（PR2 Task 4）才落地的。
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { noteAiEdits, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { INITIALIZE, mcpPost, rpc } from "./mcp-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

/** 只查 DB 的兩支——**任何**部署形態上都必須在。 */
const DB_ONLY_TOOLS = ["list_notes", "search_notes"];
/** 讀 live doc 的兩支——只在 `collab && editing` 都在時才宣告（D-A）。 */
const LIVE_DOC_TOOLS = ["read_note_outline", "read_note_section"];
/** `register.ts` 的**註冊順序**（M11）：list_notes → search_notes → 兩支讀取 → edit_note →
 *  （閘門外）create_note。案 9b 逐字釘住這個順序，不排序。 */
const SIX_TOOLS_IN_ORDER = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note"];

/** `{ sort: false }` 走一條不排序的取名路徑——**既有呼叫端全部不傳，行為不變**（default true）。
 *  ⚠ 走 `.sort()` 的版本永遠測不到順序（gate r1 M9）：案 9b 必須用 `{ sort: false }`。 */
async function toolNames(app: FastifyInstance, token: string, opts: { sort?: boolean } = {}): Promise<string[]> {
  const res = await mcpPost(app, rpc("tools/list"), { token });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.error).toBeUndefined();
  const names = (body.result.tools as { name: string }[]).map(t => t.name);
  return opts.sort === false ? names : names.sort();
}

/** 無 collab 的 app 不需要密碼登入，直接塞一列 user（省掉 argon2；同 `mcp-endpoint.test.ts`）。 */
async function seedUser(db: Db): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mcp-${randomUUID()}@example.com`, displayName: "M" })
    .returning();
  return user!.id;
}

describe("#108 tools/list", () => {
  // 案 8。⚠ **它要守的那件事在 PR1 上零鑑別力**：下面兩行 `not.toContain` 當時是**同義反覆**
  // ——`edit_note`／`create_note` 還不存在，怎麼寫實作都綠（PR1 的 PR 描述已聲明過）。
  // **PR2 Task 4 起兩支寫入工具都已註冊，這一案從本棒起才是真正的守衛**：它擋得住「唯讀憑證上
  // 漏了 scope 過濾就把寫入工具列出來」。
  // 突變實測（2026-09-09，把 `register.ts` 的 `const canWrite = canWriteNotes(ctx)` 換成
  // `const canWrite = true`）：**本案與案 10 紅**（唯讀憑證此時也拿到 `edit_note`／
  // `create_note`：`insufficient_scope` 那條死碼反而消失，本案 `toEqual` 少了兩支多兩支、
  // 案 10 從「Tool edit_note not found」退化成 `insufficient_scope`）。
  // ⚠ **推翻 plan 的預期**：plan 原寫「案 8 與案 9b 紅、案 9 紅」——實測**案 9／9b 兩案在這條
  //   突變下維持全綠**。理由：案 9／9b 用的是**讀寫**憑證，這條突變只影響「唯讀憑證還看不看得
  //   到過濾」，讀寫憑證原本就看得到全部工具，`canWrite` 對它而言本來就是 `true`——把判斷式换成
  //   恆真對它的可見清單一個字都不改。**scope 過濾唯一的守衛是本案（唯讀憑證的四支集合）與
  //   案 10（唯讀憑證跳過清單直接呼叫）**；案 9／9b 守的是完全不同的東西（六支的集合／順序），
  //   對「唯讀憑證是否被過濾」這件事**確定**零鑑別力。已依實測結果改掉本檔內每一處相關註解，
  //   不回頭把測試遷就那個推翻掉的預期。
  // 今天有鑑別力的除了 scope 過濾本身，還有 `toEqual` 那一行（**生產形態上恰好這四個名字**，
  // 一支不多一支不少、改名也會紅），那是形狀斷言。
  // ⚠ **不要為了「看起來重複」把它與下面那條 D-A 案合併**：兩案的被測對象是**兩種部署形態**，
  //   合併必然丟掉一邊——MUT-1（拿掉閘門）只讓 D-A 紅、案 8 綠，就是它們互不涵蓋的證明。
  it("唯讀憑證的 tools/list ＝恰好四支讀取工具，不含 edit_note／create_note（案 8）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const names = await toolNames(ctx.app, token);
    expect(names).toEqual([...DB_ONLY_TOOLS, ...LIVE_DOC_TOOLS].sort());
    expect(names).not.toContain("edit_note");
    expect(names).not.toContain("create_note");
  });

  // D-A 的形狀斷言：**這是那道部署形態閘門唯一的守衛**。
  //   1. 突變實測（2026-09-09，PR2 讀寫憑證版）：`register.ts` 的 `if (ctx.collab &&
  //      ctx.editing)` 換成 `if (true)` → **只有本案紅**（`expected ['create_note',
  //      'edit_note', …(4)] to deeply equal ['create_note','list_notes','search_notes']`——
  //      無 collab 的 app 上此時也冒出 `edit_note`／`read_note_outline`／`read_note_section`，
  //      六支對三支）；案 8／9／9b／10 全部走 `buildCollabTestApp`（本來就有 collab），這條突變
  //      對它們零效果，維持全綠。
  //   2. 反過來把 `list_notes`／`search_notes` 也移進閘門 → 本案紅（一支都沒註冊，
  //      `tools/list` 退成 `-32601`），連帶 `mcp-notes.test.ts` 的 29d 紅——它也走無 collab 的 app
  //      （2026-09-07 PR1 實測，唯讀憑證版下與讀寫憑證版下行為一致，未在本棒重跑第 2 條）。
  // ⚠ **PR2 起改用讀寫憑證**（Task 3 留給 Task 4 的必辦 #4）：既有唯讀憑證的版本碰不到
  //   `edit_note`——那支工具在**註冊時**就先被 scope 過濾掉，唯讀憑證測不出「它有沒有被部署
  //   形態閘門擋下」；只有讀寫憑證能區分「沒宣告是因為沒有 collab」與「沒宣告是因為沒有 scope」。
  //   `create_note` 不進這道閘門（D-M），所以三支裡它必須在，`edit_note` 必須不在。
  it("無 collab 的 app ＋讀寫憑證：只宣告查得動 DB 的兩支與 create_note（D-M 不進閘門，D-A）", async () => {
    const { app, db } = await buildTestApp();
    const userId = await seedUser(db);
    const { token } = await seedTokenForUser(db, userId, "notes:read notes:write");

    expect(await toolNames(app, token)).toEqual(["create_note", ...DB_ONLY_TOOLS].sort());
  });

  // 案 9：讀寫憑證的 `tools/list` ＝六支（生產形態）。與案 9b 的差異：這裡走 `.sort()`，
  // 守的是**集合**，不重疊案 9b 的順序斷言。
  it("讀寫憑證的 tools/list 含六支工具（案 9）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");

    const names = await toolNames(ctx.app, token);
    expect(names).toEqual([...DB_ONLY_TOOLS, ...LIVE_DOC_TOOLS, "edit_note", "create_note"].sort());
  });

  // 案 9b（M11）：名字陣列**逐字**等於寫死的六元清單，**含順序**——`{ sort: false }` 的
  // `toolNames()` 才測得到；走 `.sort()` 的版本（案 9 那條）對順序永遠零鑑別力。
  // ⚠ **本案對「拿掉 scope 過濾」這條突變零鑑別力**（案 8 那條的註解已詳述、實測推翻了
  //   plan 的預期）：本案打的是讀寫憑證，讀寫憑證的六支清單在那條突變前後一個字都不變。
  //   本案真正殺的是**順序**。突變實測（2026-09-09，把 `register.ts` 的 `list_notes`／
  //   `search_notes` 註冊順序對調）：**只有本案紅**（`expected ['search_notes','list_notes',
  //   …(4)] to deeply equal ['list_notes','search_notes',…(4)]`），案 9（走 `.sort()`）
  //   維持綠——這就是兩案不重疊的證明：一個守集合，一個守順序。
  it("讀寫憑證的 tools/list 名字陣列逐字等於寫死的六元清單，含順序（案 9b／M11）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");

    const names = await toolNames(ctx.app, token, { sort: false });
    expect(names).toEqual(SIX_TOOLS_IN_ORDER);
  });

  // 案 10：唯讀憑證**跳過** `tools/list`，直接 `tools/call` `edit_note`——scope 過濾只在
  // 註冊時擋，沒有第二道守衛防「client 記得舊清單／瞎猜工具名」。⚠ **不是 `insufficient_scope`**
  // （P16 的裁決）：`register.ts` 沒註冊這個名字，SDK 直接判「未知工具名」，(4a) 形——`isError`、
  // `content[0].text` 含 "Tool edit_note not found"、**沒有** `structuredContent`。本案剩下的
  // 鑑別力是 M6 的零副作用那半：那個呼叫從沒進到我們的 handler，`note_ai_edits` 必然零新增列。
  it("唯讀憑證跳過 tools/list 直接呼叫 edit_note → SDK 的 (4a) 形，且無新 note_ai_edits 列（案 10）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const before = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
    expect(before).toHaveLength(0);

    const call = await mcpPost(
      ctx.app,
      rpc("tools/call", { name: "edit_note", arguments: { note_id: note.id, op: "append", markdown: "不該寫進去" } }),
      { token }
    );
    expect(call.statusCode).toBe(200);
    const result = call.json().result as { isError?: true; content: { text: string }[]; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Tool edit_note not found");
    expect(result.structuredContent).toBeUndefined();

    const after = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
    expect(after).toHaveLength(0);
  });

  // P13：`runTool()` 涵蓋率守衛現在分散在三個檔（`register.ts` 檔頭已具名）——這裡守
  // `edit_note`／`create_note` 那一半。`mcp-notes.test.ts` 只打 `list_notes`／`search_notes`、
  // `mcp-content.test.ts` 只打兩支讀取工具，兩者對這兩支寫入工具都**恆綠**（不在它們的名字
  // 集合裡）；沒有這一案，PR2 新增的兩支工具就沒有 D31／M15 的 try/catch 守衛。
  it("P13：runTool() 涵蓋率——beforeTool 看到的名字集合逐字等於 {edit_note, create_note}", async () => {
    const seen: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const note = await ctx.createNote(owner.id);

    await mcpPost(ctx.app, rpc("tools/call", { name: "edit_note", arguments: { note_id: note.id, op: "append", markdown: "x" } }), {
      token,
    });
    await mcpPost(ctx.app, rpc("tools/call", { name: "create_note", arguments: {} }), { token });

    expect([...new Set(seen)].sort()).toEqual(["create_note", "edit_note"]);
  });

  // 案 2 的 `listChanged` 那半（Task 2 從傳輸層那一族移過來的）。
  // ⚠ **順序是契約**（§8.1 D32）：`registerTool` 內部會無條件把 `listChanged` 設回 `true`，
  // 所以 `registerCapabilities({tools:{listChanged:false}})` 必須排在**註冊完工具之後**。
  // 這一案在 Task 3 之前零鑑別力（沒有 `registerTool` 就沒有東西會把旗標翻回去）——
  // Task 3 的 reviewer 當時實測「把 `registerCapabilities` 挪到註冊工具之前，三個測試檔全綠」。
  // 突變實測（2026-09-07，同一條突變、67 案）：**只有本案紅**（`expected true to be false`），
  // `mcp-endpoint`／`mcp-notes`／`mcp-content`／`mcp-size` 全綠。
  // **它是那條順序契約今天唯一的守衛。**
  it("initialize 宣告 capabilities.tools.listChanged === false（案 2／D32 的順序契約）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const res = await mcpPost(ctx.app, INITIALIZE, { token });
    expect(res.statusCode).toBe(200);
    const caps = res.json().result.capabilities;
    // 我們是 stateless ＋ GET 回 405，沒有 server→client 的推送通道，所以誠實宣告 false。
    expect(caps.tools.listChanged).toBe(false);
  });
});

describe("#108 JSON-RPC 批次", () => {
  // 案 33。一發 POST 帶兩個 `tools/call`：一個看得見的筆記、一個只是「存在但你沒權限」的
  // 筆記（**不是**隨機 UUID——要驗的是授權而不只是存在性）。
  // 兩件事要同時成立：(1) 各自獨立授權（一成功一 `not_found`）；
  // (2) 各自獨立扣桶，而 `role === "none"` 那發**不啃桶**（M6／§14.6 案 31 的同一條紀律）。
  // 桶只有 2 格：批次扣掉 1 格 → 之後還能成功 1 發 → 第 3 發才 429。
  // 突變實測（2026-09-07）：把 `note-read.ts` 的 `consume` 移到 `resolveRole` **之前**
  // （＝失敗那發也啃桶）→ 本案紅（`expected true to be undefined`：批次啃掉兩格，
  // 下一發就 429）。⚠ **同一條突變也讓 `mcp-content.test.ts` 的案 31 紅**——「失敗不啃桶」
  // 那一半本案**不是**唯一的守衛。本案唯一守得住的是**批次那個形**：一發 POST 裡的兩個
  // `tools/call` 各自跑一次授權、各自結一次帳（全樹沒有第二條測試打過批次）。
  it("一發 POST 兩個 tools/call：各自授權、各自扣桶，失敗那發不啃桶（案 33）", async () => {
    const ctx = await buildCollabTestApp({
      limiters: { contentRead: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) },
    });
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const stranger = await ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const mine = await ctx.createNote(owner.id, "Mine");
    const theirs = await ctx.createNote(stranger.id, "Theirs");

    const call = (id: number, noteId: string) =>
      rpc("tools/call", { name: "read_note_outline", arguments: { note_id: noteId } }, id);
    const res = await mcpPost(ctx.app, [call(1, mine.id), call(2, theirs.id)], { token });
    expect(res.statusCode).toBe(200);

    const bodies = res.json() as { id: number; result: { isError?: true; structuredContent?: { code?: string } } }[];
    expect(Array.isArray(bodies)).toBe(true);
    expect(bodies).toHaveLength(2);
    const byId = new Map(bodies.map(b => [b.id, b.result]));
    // (1) 各自獨立授權：owner 那發拿到 outline，陌生人那發是 `not_found`
    //     （**不得**洩漏「存在但你沒權限」——M2）。
    expect(byId.get(1)!.isError).toBeUndefined();
    expect(byId.get(2)!.isError).toBe(true);
    expect(byId.get(2)!.structuredContent!.code).toBe("not_found");

    // (2) 批次只啃掉 1 格：還剩 1 格。
    const second = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_outline", arguments: { note_id: mine.id } }), { token });
    expect(second.json().result.isError).toBeUndefined();
    // 第 3 發（桶內第 3 次成功授權的呼叫）才被擋。
    const third = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_outline", arguments: { note_id: mine.id } }), { token });
    expect(third.json().result.structuredContent.code).toBe("too_many_requests");
  });
});
