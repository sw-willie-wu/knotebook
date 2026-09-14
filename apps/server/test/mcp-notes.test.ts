/**
 * #108 PR1 Task 3：`list_notes`／`search_notes` 兩支唯讀工具（規格 §8.2／§8.5、§14.2／§14.5）。
 *
 * 這一族預設用 `buildCollabTestApp`（＝生產形態）；**只有 29d 那一案走 `buildTestApp`**
 * ——只有它收得到 `options.logger`（`buildCollabTestApp` 建 app 時寫死 `{ logger: false }`），
 * 而依 D-A 這兩支工具在無 collab 的 app 上仍然註冊。
 */
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { notes, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, buildTestApp, type CollabTestCtx } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";
const NUL = String.fromCharCode(0);

/** 一列 `NoteSummary`。索引簽章是刻意的——key 集合斷言要看得到多出來的欄位。 */
type Summary = Record<string, unknown> & { id: string; title: string; role: string; ownerHandle: string; url: string };

/** `tools/call` 的 `result`；SDK 自產錯誤時 `structuredContent` 會缺席。 */
interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string };
}

interface ToolPayload extends Record<string, unknown> {
  notes: Summary[];
  nextCursor?: string | null;
  truncated?: boolean;
  matchedOn?: string;
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** 整個 wire body 的字串（29d 的哨兵掃描用）。 */
  raw: string;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** 成功呼叫的 `structuredContent`（順手守住 M10 的鏡像等式）。 */
function payloadOf(call: ToolCall): ToolPayload {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as ToolPayload;
}

/** 排序斷言要決定性的 `updated_at`，所以逐篇明寫，不靠 `defaultNow()` 的相鄰時間戳。 */
async function setUpdatedAt(db: Db, noteId: string, iso: string): Promise<void> {
  await db.update(notes).set({ updatedAt: new Date(iso) }).where(eq(notes.id, noteId));
}

/**
 * 微秒精度的 `updated_at`。**不能走 drizzle 的 `.set({ updatedAt: new Date(...) })`**——JS 的
 * `Date` 只有毫秒，那樣寫出去的值本身就已經沒有微秒了，測不到要測的東西。
 * ⚠ 這才是**生產的常態**：生產程式碼的每一個寫入點都走 pg 的 `now()`（微秒精度）
 * ——也就是**所有筆記的 `updated_at` 都是微秒**。
 */
async function setUpdatedAtMicros(db: Db, noteId: string, literal: string): Promise<void> {
  await db.execute(sql`update notes set updated_at = ${literal}::timestamptz where id = ${noteId}::uuid`);
}

async function handleOf(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ handle: users.handle }).from(users).where(eq(users.id, userId));
  return row!.handle;
}

async function slugOf(db: Db, noteId: string): Promise<string> {
  const [row] = await db.select({ slug: notes.slug }).from(notes).where(eq(notes.id, noteId));
  return row!.slug;
}

/** owner ＋ 一位被分享者 ＋ 一位無關者的標準場景。 */
async function scenario(ctx: CollabTestCtx): Promise<{
  ownerId: string;
  otherId: string;
  token: string;
  otherToken: string;
}> {
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const other = await ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id);
  const { token: otherToken } = await seedTokenForUser(ctx.db, other.id);
  return { ownerId: owner.id, otherId: other.id, token, otherToken };
}

describe("#108 list_notes", () => {
  it("回自有 ＋ 被分享的筆記，決定性排序，每列帶 url／role／ownerHandle", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, otherId, token } = await scenario(ctx);
    const mine = await ctx.createNote(ownerId, "Mine");
    const theirs = await ctx.createNote(otherId, "Theirs");
    const invisible = await ctx.createNote(otherId, "Invisible");
    await ctx.share(theirs.id, ownerId, "viewer");
    await setUpdatedAt(ctx.db, mine.id, "2026-01-02T00:00:00.000Z");
    await setUpdatedAt(ctx.db, theirs.id, "2026-01-01T00:00:00.000Z");

    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes.map(n => n.id)).toEqual([mine.id, theirs.id]);
    expect(out.notes.map(n => n.id)).not.toContain(invisible.id);
    expect(out.nextCursor).toBeNull();

    const ownerHandle = await handleOf(ctx.db, ownerId);
    const otherHandle = await handleOf(ctx.db, otherId);
    expect(out.notes[0].role).toBe("owner");
    expect(out.notes[0].ownerHandle).toBe(ownerHandle);
    expect(out.notes[0].url).toBe(canonicalNotePath({ ownerHandle, slug: await slugOf(ctx.db, mine.id) }));
    expect(out.notes[1].role).toBe("viewer");
    expect(out.notes[1].ownerHandle).toBe(otherHandle);
    expect(out.notes[1].url).toBe(canonicalNotePath({ ownerHandle: otherHandle, slug: await slugOf(ctx.db, theirs.id) }));
  });

  it("同一個 updatedAt 之下以 id desc 決勝（M3 的次要排序鍵）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const note = await ctx.createNote(ownerId, `Same ${i}`);
      await setUpdatedAt(ctx.db, note.id, "2026-02-02T00:00:00.000Z");
      ids.push(note.id);
    }
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes.map(n => n.id)).toEqual([...ids].sort().reverse());
  });

  it("limit／cursor 分頁接得上：三頁湊回全集、無重複無遺漏、最後一頁 nextCursor 為 null", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const all: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const note = await ctx.createNote(ownerId, `P${i}`);
      await setUpdatedAt(ctx.db, note.id, `2026-03-0${i + 1}T00:00:00.000Z`);
      all.push(note.id);
    }
    const expected = [...all].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const out: ToolPayload = payloadOf(
        await callTool(ctx.app, token, "list_notes", cursor === null ? { limit: 2 } : { limit: 2, cursor })
      );
      seen.push(...out.notes.map(n => n.id));
      cursor = out.nextCursor ?? null;
      if (page < 2) expect(typeof cursor).toBe("string");
      else expect(cursor).toBeNull();
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(5);
  });

  // ⚠ 這一案守的是一個**靜默漏列**：`notes.updated_at` 是 `timestamptz`（微秒），而 cursor 走
  // JS `Date` → `toISOString()`（毫秒）。若排序鍵留在微秒而 cursor 只有毫秒，`(updated_at, id)
  // < (cursor.ts, cursor.id)` 會把「同一毫秒內、微秒較小」的列整批切掉——**不報錯、不重複，
  // 就是不見**。修法是把排序鍵與 keyset 都 `date_trunc('milliseconds', …)` 降到與 cursor 同精度。
  // 曝險比直覺高：所有筆記的 `updated_at` 全部來自 pg 的 `now()`＝微秒。
  it("cursor 不因 updated_at 的微秒精度漏列（排序鍵與 cursor 同精度）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const a = await ctx.createNote(ownerId, "Micro A");
    const b = await ctx.createNote(ownerId, "Micro B");
    // 同一毫秒（.123）內的兩個不同微秒值——cursor 編碼會把兩者都寫成 `…00.123Z`。
    await setUpdatedAtMicros(ctx.db, a.id, "2026-04-01T00:00:00.123456Z");
    await setUpdatedAtMicros(ctx.db, b.id, "2026-04-01T00:00:00.123200Z");

    const p1 = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1 }));
    expect(p1.notes).toHaveLength(1);
    expect(typeof p1.nextCursor).toBe("string");
    const p2 = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1, cursor: p1.nextCursor! }));
    // 兩頁的聯集必須等於全集：漏列時第二頁是空的，而且沒有任何錯誤訊號。
    expect([...p1.notes, ...p2.notes].map(n => n.id)).toEqual([a.id, b.id].sort().reverse());
    expect(p2.nextCursor).toBeNull();
  });

  it("壞 cursor 四發（亂碼／解出來不是 uuid／不是日期／時間戳後接 NUL）→ 工具錯誤 invalid_body", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "One");
    await ctx.createNote(ownerId, "Two"); // 兩篇才發得出 nextCursor，下面的對照面才成立
    const encode = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    const bad = [
      "not-a-cursor!!",
      encode("2026-01-01T00:00:00.000Z|not-a-uuid"),
      encode(`not-a-date|${randomUUID()}`),
      // ⚠ **NUL 必須接在時間戳後面，不能落在 id 欄**——這一發是 `decodeCursor` 的 `noNul`
      // 唯一的守衛，而落點決定它有沒有鑑別力：
      //   - 落 id 欄（`…000Z|<NUL>`）→ 殺掉它的是 `UUID_RE`，拿掉 `noNul` 照樣綠（舊寫法，
      //     本檔一度據此宣稱「結構上做不出守衛」——**那句是錯的**）。
      //   - 落時間戳後面 → `new Date("2099-01-01T00:00:00.000Z" + NUL)` **仍然有效**
      //     （實測 `toISOString()` 回 `2099-01-01T00:00:00.000Z`），`UUID_RE` 也管不到 id 欄，
      //     所以三關只剩 `noNul` 擋得住它。
      // 突變實測（2026-09-07）：拿掉 `if (!noNul(decoded))` → **只有這一發紅**
      // （`isError` 變 `undefined`、回了一整頁筆記——日期取未來值，keyset 述詞會放行全部）。
      encode(`2099-01-01T00:00:00.000Z${NUL}|${randomUUID()}`),
    ];
    for (const cursor of bad) {
      const call = await callTool(ctx.app, token, "list_notes", { cursor });
      expect(call.status).toBe(200);
      expect(call.result.isError).toBe(true);
      expect(call.result.structuredContent!.code).toBe("invalid_body");
    }
    // 對照面：合法 cursor 仍然成功——上面四發不是「任何 cursor 都被拒」。
    const first = payloadOf(await callTool(ctx.app, token, "list_notes", { limit: 1 }));
    expect(payloadOf(await callTool(ctx.app, token, "list_notes", { cursor: first.nextCursor! }))).toBeTruthy();
  });

  it("title 截到 200 code unit 並附 titleTruncated（M16）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const title = "T".repeat(260_000);
    await ctx.createNote(ownerId, title);
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(out.notes[0].title.length).toBe(200);
    expect(out.notes[0].title).toBe("T".repeat(200));
    expect(out.notes[0].titleTruncated).toBe(true);
  });

  it("頂層與每一列的 key 集合逐字相符（殺「照抄 NoteDto」）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "K");
    const out = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(Object.keys(out).sort()).toEqual(["nextCursor", "notes"]);
    expect(Object.keys(out.notes[0]).sort()).toEqual(
      ["id", "lastEdited", "ownerHandle", "role", "slug", "title", "updatedAt", "url"].sort()
    );
    // 未被截斷時**沒有** `titleTruncated` 這把 key（不是 `undefined`）。
    expect("titleTruncated" in out.notes[0]!).toBe(false);
    expect(out.notes[0]!.lastEdited).toBeNull();
    expect(out.notes[0]!.updatedAt).toBe(new Date(String(out.notes[0]!.updatedAt)).toISOString());
  });
});

describe("#108 search_notes", () => {
  it("query 的 %／_／NUL 三發：前兩者當字面字元，NUL 在 handler 之外就被擋下", async () => {
    const seenTools: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seenTools.push(name) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "Q3 50% growth");
    await ctx.createNote(ownerId, "50 percent growth");
    await ctx.createNote(ownerId, "a_b config");
    await ctx.createNote(ownerId, "axb config");

    // `%` 是字面字元：只命中標題真的有 `50%` 的那一列。用 `LIKE` 而不跳脫會多命中另一列。
    const pct = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "50%" }));
    expect(pct.notes.map(n => n.title)).toEqual(["Q3 50% growth"]);
    // 單一個 `%` 同理：`LIKE '%'` 會命中全部四列，非 pattern 判定只命中含字面 `%` 的一列。
    const onlyPct = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "%" }));
    expect(onlyPct.notes.map(n => n.title)).toEqual(["Q3 50% growth"]);
    // `_` 是字面字元：`LIKE 'a_b%'` 會連 `axb` 一起命中。
    const underscore = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "a_b" }));
    expect(underscore.notes.map(n => n.title)).toEqual(["a_b config"]);

    // 正向對照（上面三發）已證明 `search_notes` 真的經過 `runTool()`；NUL 這一發之後
    // 計數**不變**，才證明它是在 handler **之外**（zod 輸入 schema）被擋掉的。
    const before = seenTools.filter(n => n === "search_notes").length;
    expect(before).toBe(3);
    const nul = await callTool(ctx.app, token, "search_notes", { query: `a${NUL}b` });
    expect(nul.status).toBe(200);
    expect(nul.result.isError).toBe(true);
    // ⚠ `.refine(noNul)` 在 JSON Schema 裡**看不見**（zod 的 refine 沒有對應的關鍵字），
    // 但 SDK 的 `validateToolInput` 真的會跑它——所以擋下 NUL 的是 zod 不是 JSON Schema。
    expect(nul.result.content[0]!.text).toContain("Input validation error");
    expect(seenTools.filter(n => n === "search_notes").length).toBe(3);
  });

  it("回應沒有 nextCursor／cursor，只有 truncated（D33）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    for (let i = 0; i < 3; i += 1) await ctx.createNote(ownerId, `dup ${i}`);
    const full = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "dup" }));
    expect(Object.keys(full).sort()).toEqual(["matchedOn", "notes", "truncated"]);
    expect(full.matchedOn).toBe("title");
    expect(full.truncated).toBe(false);
    expect(full.notes).toHaveLength(3);

    const capped = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "dup", limit: 2 }));
    expect(capped.notes).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(Object.keys(capped)).not.toContain("nextCursor");
  });

  it("排序：完全相等 → 前綴 → 子字串，同組內 updatedAt desc, id desc", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const exact = await ctx.createNote(ownerId, "report");
    const prefix = await ctx.createNote(ownerId, "report of Q3");
    const substrOld = await ctx.createNote(ownerId, "the report draft");
    const substrNew = await ctx.createNote(ownerId, "annual report 2026");
    await setUpdatedAt(ctx.db, exact.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, prefix.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, substrOld.id, "2026-01-01T00:00:00.000Z");
    await setUpdatedAt(ctx.db, substrNew.id, "2026-06-01T00:00:00.000Z");

    const out = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "report" }));
    expect(out.notes.map(n => n.id)).toEqual([exact.id, prefix.id, substrNew.id, substrOld.id]);
  });

  it("大小寫不敏感，且只比標題不比內文（D17）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, token } = await scenario(ctx);
    const owner = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, ownerId));
    const titled = await ctx.createNote(ownerId, "Quarterly PLAN");
    const bodyOnly = await ctx.createNote(ownerId, "unrelated");
    const session = await ctx.loginAs(owner[0]!.email, PASSWORD);
    const client = await seedContent(ctx, session, bodyOnly.id, "# unrelated\n\nquarterly plan lives in the body\n");
    client.disconnect();

    const out = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "quarterly plan" }));
    expect(out.notes.map(n => n.id)).toEqual([titled.id]);
  });

  it("搜尋範圍＝呼叫者看得見的筆記（M2：別人的私有筆記不出現）", async () => {
    const ctx = await buildCollabTestApp();
    const { ownerId, otherId, token, otherToken } = await scenario(ctx);
    const secret = await ctx.createNote(otherId, "secret roadmap");
    const shared = await ctx.createNote(otherId, "shared roadmap");
    await ctx.share(shared.id, ownerId, "editor");

    const mine = payloadOf(await callTool(ctx.app, token, "search_notes", { query: "roadmap" }));
    expect(mine.notes.map(n => n.id)).toEqual([shared.id]);
    expect(mine.notes[0].role).toBe("editor");

    const list = payloadOf(await callTool(ctx.app, token, "list_notes"));
    expect(list.notes.map(n => n.id)).not.toContain(secret.id);

    // 對照面：secret 的主人自己看得到——上面不是「這篇筆記查不到」。
    const theirs = payloadOf(await callTool(ctx.app, otherToken, "search_notes", { query: "roadmap" }));
    expect(theirs.notes.map(n => n.id).sort()).toEqual([secret.id, shared.id].sort());
  });
});

describe("#108 兩支工具的共同接線", () => {
  // 這兩句是規格逐字要求、且是某個「模型會踩但不會報錯」的形**唯一**的處置：
  // - `list_notes`：keyset 分頁不是快照，分頁期間有人新建／改名會靜默漏列（§8.2 的處置 (b)）。
  //   ⚠ #146 換過措辭：舊句說「邊列邊改會漏列」，而 `edit_note` 根本不動 `notes.updated_at`
  //   （成因與查證在 `tools/list-notes.ts` 檔頭）。斷言仍是**整句逐字**、仍打 wire，只是換成
  //   新那句的核心；連同下一行的「Editing a note's content does not move it.」一起釘，
  //   把「真正的成因」與「刻意否定掉的假成因」兩半都守住。
  // - `search_notes`：只比標題，不講清楚模型會在搜不到時得出「這個 workspace 沒有這篇筆記」
  //   的錯誤結論（§8.5 D17）。
  // 沒有這一案，刪掉它們不會有任何東西變紅。斷言的是**送到 wire 上的 `tools/list`**，
  // 不是原始碼常數——改對了常數卻沒接上 `registerTool` 的形也要抓得到。
  it("tools/list 的兩句逐字文案在 wire 上出現（§8.2 的分頁警告、§8.5 的只搜標題）", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as { name: string; description: string }[];
    const byName = (name: string): string => tools.find(t => t.name === name)!.description;
    expect(byName("list_notes")).toContain(
      "creating a note, or changing a note's title or slug, moves it to the top of this order, above the " +
        "cursor you are holding, so no later page shows it."
    );
    expect(byName("list_notes")).toContain("Editing a note's content does not move it.");
    expect(byName("search_notes")).toContain(
      "Searches note titles only — not the body text. If you cannot find a note, its title may simply not contain your words."
    );
  });

  it("不吃 contentRead 桶（§8.8）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "bucket");
    for (let i = 0; i < 5; i += 1) {
      expect(payloadOf(await callTool(ctx.app, token, "list_notes")).notes).toHaveLength(1);
      expect(payloadOf(await callTool(ctx.app, token, "search_notes", { query: "bucket" })).notes).toHaveLength(1);
    }
  });

  it("runTool() 涵蓋率：beforeTool 看到的名字集合逐字等於 {list_notes, search_notes}", async () => {
    const seen: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "coverage");
    payloadOf(await callTool(ctx.app, token, "list_notes"));
    payloadOf(await callTool(ctx.app, token, "search_notes", { query: "coverage" }));
    // 漏把某一支包進 `runTool()` 就沒有 D31／M15 的 try/catch，未捕捉例外會被 SDK 原樣
    // 送進模型脈絡（29d 守的正是那條）——所以「每一支都經過 runTool」必須自己有守衛。
    expect([...new Set(seen)].sort()).toEqual(["list_notes", "search_notes"]);
  });

  it("案 29b：我們自產的兩種錯誤都帶 ERROR_CODES 的碼，且 content 與 structuredContent 等價", async () => {
    const ctx = await buildCollabTestApp({
      mcpTestHooks: {
        beforeTool: name => {
          if (name === "search_notes") throw new Error("forced");
        },
      },
    });
    const { ownerId, token } = await scenario(ctx);
    await ctx.createNote(ownerId, "e29b");

    const invalid = await callTool(ctx.app, token, "list_notes", { cursor: "!!!" });
    const internal = await callTool(ctx.app, token, "search_notes", { query: "e29b" });
    for (const [call, code] of [
      [invalid, "invalid_body"],
      [internal, "internal"],
    ] as const) {
      expect(call.result.isError).toBe(true);
      expect(call.result.structuredContent!.code).toBe(code);
      expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
    }
  });

  it("案 29d：handler 丟含哨兵字串的例外 → code internal、body 不含哨兵、log.error 有被呼叫", async () => {
    // ⚠ 走 `buildTestApp`：只有它收得到 `options.logger`（`buildCollabTestApp` 寫死
    // `logger: false`）。依 D-A，這兩支工具在無 collab 的 app 上仍然註冊。
    const sentinel = `SENTINEL-${randomUUID()}`;
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { app, db } = await buildTestApp(
      {
        mcpTestHooks: {
          beforeTool: () => {
            throw new Error(sentinel);
          },
        },
      },
      { logger: { level: "error", stream } }
    );
    const [user] = await db.insert(users).values({ email: `s-${randomUUID()}@example.com`, displayName: "S" }).returning();
    const { token } = await seedTokenForUser(db, user!.id);

    const call = await callTool(app, token, "list_notes");
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent!.code).toBe("internal");
    // 殺「不包 try/catch，讓例外冒到 SDK」——實測那樣寫時原始 error.message 會原樣進
    // `content[0].text`。
    expect(call.raw).not.toContain(sentinel);
    expect(lines.join("")).toContain(sentinel);
    expect(lines.some(l => l.includes(`"tool":"list_notes"`))).toBe(true);
  });

  // ⚠ 下面三條是 **SDK 特徵化測試，對我們的實作零鑑別力**（同案 6b 一族）：斷言的是 SDK
  // 自己組出來的固定字串。它們的存在理由是把 D12 的 (3) 協定層 error 信封與 (4a) SDK 自產
  // 工具錯誤的分界釘死——兩者在 HTTP 上都是 200，只有 body 形狀不同。用 `toContain` 只釘短語，
  // 版本由 lockfile 釘死；SDK 升版後這三條若紅，是 SDK 換了字串，不是我們寫壞了。
  // ⚠ 實測記錄（Task 3 首跑）：**29(c) 在零工具形之下就已經是綠的**——`resources/list` 不論
  // 有沒有註冊工具都回 `-32601`。它守的是分界（29(a)／29(b) 在同一個 200 上長得不一樣），
  // 不是我們的實作；29(a)／29(b) 則要「至少註冊一支工具」才寫得出來，所以三條同在這一棒。
  it("案 29(a)：tools/call 一個沒註冊的名字 → 200、isError、structuredContent 缺席", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const call = await callTool(ctx.app, token, "nope");
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect("structuredContent" in call.result).toBe(false);
    expect(call.result.content[0]!.text).toContain("Tool ");
    expect(call.result.content[0]!.text).toContain(" not found");
  });

  it("案 29(b)：輸入 schema 不符（limit 給字串）→ 200、isError、structuredContent 缺席", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const call = await callTool(ctx.app, token, "list_notes", { limit: "50" });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect("structuredContent" in call.result).toBe(false);
    expect(call.result.content[0]!.text).toContain("Input validation error");
  });

  it("案 29(c)：未知的 JSON-RPC method → 200 ＋ 真正的 error 信封（有 error、沒有 result）", async () => {
    const ctx = await buildCollabTestApp();
    const { token } = await scenario(ctx);
    const res = await mcpPost(ctx.app, rpc("resources/list", undefined, 7), { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32601);
  });
});
