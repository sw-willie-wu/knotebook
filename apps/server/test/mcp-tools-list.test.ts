/**
 * #108 PR1 Task 5：`tools/list` 的內容（規格 §14.2 案 8、案 2 的 `listChanged` 那半）與
 * 批次（§10.3／§14.6 案 33）。
 *
 * 兩種 harness 各有被測對象，**不可互換**（D-A 的分工表）：
 * - `buildCollabTestApp` ＝生產形態（collab ＋ editing 都在）→ 四支工具全在。
 * - `buildTestApp` ＝無 collab → 只有查得動 DB 的兩支；那一案的被測對象**就是**「沒有 collab」。
 *
 * 案 9／9b／10（讀寫憑證六支、寫死的六元清單、跳過清單直接呼叫 `edit_note`）**不在本棒**——
 * 那兩支工具還不存在。不放 `it.todo` 佔位，PR2 才是它們的落點。
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { users } from "../src/db/schema.js";
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

async function toolNames(app: FastifyInstance, token: string): Promise<string[]> {
  const res = await mcpPost(app, rpc("tools/list"), { token });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.error).toBeUndefined();
  return (body.result.tools as { name: string }[]).map(t => t.name).sort();
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
  // 案 8。⚠ **它要守的那件事在 PR1 上零鑑別力**：下面兩行 `not.toContain` 是**同義反覆**
  // ——`edit_note`／`create_note` 還不存在，怎麼寫實作都綠。案 8 真正的守點是 PR2
  // （寫入工具落地後，它才擋得住「唯讀憑證上漏了 scope 過濾就把寫入工具列出來」）。
  // **不得在 PR 描述裡宣稱案 8 今天守住了 scope 過濾。**
  // 今天有鑑別力的只有 `toEqual` 那一行（**生產形態上恰好這四個名字**，一支不多一支不少、
  // 改名也會紅），那是形狀斷言不是 scope 的守衛。
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

  // D-A 的形狀斷言：**這是那道部署形態閘門唯一的守衛**。兩條突變都實跑過（2026-09-07，
  // 打 `mcp-tools-list`／`mcp-size`／`mcp-endpoint`／`mcp-notes`／`mcp-content` 共 67 案）：
  //   1. `register.ts` 的 `if (ctx.collab && ctx.editing)` 換成恆真 → **只有本案紅**
  //      （`expected ['list_notes', …(3)] to deeply equal ['list_notes','search_notes']`）。
  //   2. 反過來把 `list_notes`／`search_notes` 也移進閘門 → 本案紅（一支都沒註冊，
  //      `tools/list` 退成 `-32601`），連帶 `mcp-notes.test.ts` 的 29d 紅——它也走無 collab 的 app。
  it("無 collab 的 app 上只宣告查得動 DB 的兩支（D-A）", async () => {
    const { app, db } = await buildTestApp();
    const userId = await seedUser(db);
    const { token } = await seedTokenForUser(db, userId, "notes:read");

    expect(await toolNames(app, token)).toEqual([...DB_ONLY_TOOLS].sort());
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
