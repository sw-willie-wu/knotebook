/**
 * #175 §9：MCP 對群組筆記（Q23：PR1 就要讀得到、`edit_note` 改得動）。harness 照 mcp-notes／mcp-content 兩檔。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { noteAiEdits, notes, groups } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { FORBIDDEN_MESSAGE } from "../src/mcp/tools/edit-note.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { bearer, getContent, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const PASSWORD = "correct-horse-battery";

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as { isError?: true; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };
}

/** 成功路徑的 `notes`：先斷工具沒回錯（否則紅在「工具回了 internal」這一行，而不是之後讀 `notes` 時的 TypeError）。 */
async function notesOf(app: FastifyInstance, token: string, name: string, args: unknown = {}) {
  const result = await callTool(app, token, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent as { notes: Array<Record<string, unknown>>; nextCursor?: string | null };
}

describe("#175 list_notes／search_notes 的群組筆記", () => {
  it("三支混在一起以 limit 2 翻頁湊回全集；群組列 owner={kind:group}、url /g/、role editor／viewer、從不 owner；無閱讀旗標看不到", async () => {
    const { app, db } = await buildTestApp();
    const [me, other, reader, blind] = await Promise.all(Array.from({ length: 4 }, () => seedUser(db)));
    const g = await seedGroup(db, "Team", [
      { userId: me!.id, role: "member" },
      { userId: reader!.id, role: "member" },
      { userId: blind!.id, role: "member" },
    ]);
    await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageGroup: true }));
    const mine = await seedNote(db, { ownerId: me!.id }, { title: "Mine" });
    const theirs = await seedNote(db, { ownerId: other!.id }, { title: "Theirs" });
    await seedShare(db, theirs.id, me!.id, "viewer");
    const gn1 = await seedNote(db, { groupId: g.id }, { title: "G1" });
    const gn2 = await seedNote(db, { groupId: g.id }, { title: "G2" });
    const { token } = await seedTokenForUser(db, me!.id, "notes:read");
    const seen: Array<Record<string, unknown>> = [];
    let cursor: string | null | undefined;
    do {
      const out = await notesOf(app, token, "list_notes", { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...out.notes);
      cursor = out.nextCursor;
    } while (cursor);
    expect(seen.map(n => n.id).sort()).toEqual([mine.id, theirs.id, gn1.id, gn2.id].sort());
    const g1 = seen.find(n => n.id === gn1.id)!;
    expect(g1).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, role: "editor" });
    expect(g1.url).toBe(`/g/${g.id}/${gn1.slug}`);
    expect(seen.find(n => n.id === mine.id)).toMatchObject({ owner: { kind: "user", handle: me!.handle }, role: "owner" });
    expect(seen.filter(n => n.role === "owner").map(n => n.id)).toEqual([mine.id]);
    const readerToken = (await seedTokenForUser(db, reader!.id, "notes:read")).token;
    const readerRows = (await notesOf(app, readerToken, "list_notes")).notes;
    expect(readerRows.map(n => n.role)).toEqual(["viewer", "viewer"]);
    const blindToken = (await seedTokenForUser(db, blind!.id, "notes:read")).token;
    expect((await notesOf(app, blindToken, "list_notes")).notes).toEqual([]);
  });

  it("search_notes：rank（完全相等 → 前綴 → 子字串）跨三支成立；非成員的群組筆記不出現", async () => {
    const { app, db } = await buildTestApp();
    const [me, outsider] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: outsider.id, role: "admin" }]);
    const exact = await seedNote(db, { groupId: g.id }, { title: "plan" });
    const prefix = await seedNote(db, { ownerId: me.id }, { title: "plan b" });
    const infix = await seedNote(db, { groupId: g.id }, { title: "the plan" });
    await seedNote(db, { groupId: foreign.id }, { title: "plan" });
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const hits = (await notesOf(app, token, "search_notes", { query: "plan" })).notes;
    expect(hits.map(h => h.id)).toEqual([exact.id, prefix.id, infix.id]);
    expect(hits[0]).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, url: `/g/${g.id}/${exact.slug}`, role: "editor" });
    expect(hits[2]).toMatchObject({ owner: { kind: "group", id: g.id, name: "Team" }, url: `/g/${g.id}/${infix.slug}`, role: "editor" });
    expect(hits[1]).toMatchObject({ owner: { kind: "user", handle: me.handle }, url: `/n/${me.handle}/${prefix.slug}`, role: "owner" });
  });
});

describe("#175 read_note_outline／edit_note 的群組筆記（需 collab）", () => {
  it("成員讀群組筆記的 outline：note.owner 是群組（INNER JOIN 時是 not_found）；一般成員 append 成功並留紀錄；只讀角色 forbidden 且訊息不提 owner", async () => {
    const ctx = await buildCollabTestApp();
    const memberEmail = `m-${randomUUID()}@example.com`;
    const member = await ctx.createUser({ email: memberEmail, password: PASSWORD });
    const reader = await ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const g = await seedGroup(ctx.db, "Team", [
      { userId: member.id, role: "member" },
      { userId: reader.id, role: "member" },
    ]);
    await setMemberRole(ctx.db, g.id, reader.id, await seedRole(ctx.db, g.id, "Reader", { canRead: true }));
    const note = await seedNote(ctx.db, { groupId: g.id }, { title: "Shared plan" });
    const session = await ctx.loginAs(memberEmail, PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段");
    client.disconnect();
    const memberToken = (await seedTokenForUser(ctx.db, member.id, "notes:read notes:write", "Claude Code")).token;
    const outline = await callTool(ctx.app, memberToken, "read_note_outline", { note_id: note.id });
    expect(outline.isError).toBeUndefined();
    expect(outline.structuredContent!.note).toMatchObject({ id: note.id, owner: { kind: "group", id: g.id, name: "Team" }, role: "editor" });
    const appended = await callTool(ctx.app, memberToken, "edit_note", { note_id: note.id, op: "append", markdown: "追加" });
    expect(appended.isError).toBeUndefined();
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(1);
    const readerToken = (await seedTokenForUser(ctx.db, reader.id, "notes:read notes:write", "Claude Code")).token;
    const denied = await callTool(ctx.app, readerToken, "edit_note", { note_id: note.id, op: "append", markdown: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      code: "forbidden",
      message: "You can read this note but not change it. Ask whoever manages your access to it for editing rights.",
    });
    expect(String(denied.structuredContent!.message)).not.toMatch(/owner/i);
  });
});

// ───────────────────────────── #175 PR5：create_note {group_id}（spec §9.3、§12.1、Q23） ─────────────────────────────

/** spec §9.2 兩句專用訊息，逐字（測試**不**從實作 import——字面值才釘得住 spec）。 */
const E1_GROUP_NOT_FOUND = "No group with that id among the groups you belong to.";
const E2_CREATE_FORBIDDEN = "Your role in that group can't create notes. Leave out `group_id` to create a personal note.";
const RW = "notes:read notes:write" as const;

interface CreatedNote {
  id: string;
  slug: string;
  url: string;
  role: string;
  owner: { kind: string; id?: string; name?: string; handle?: string };
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
}

/** 成功呼叫的 `note`：先斷工具沒回錯（否則紅在「回了 internal」這一行，而不是之後讀 `note` 時的 TypeError）。 */
async function createdNote(app: FastifyInstance, token: string, args: unknown): Promise<CreatedNote> {
  const result = await callTool(app, token, "create_note", args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent!.note as unknown as CreatedNote;
}

async function noteCount(db: Db): Promise<number> {
  return (await db.select({ id: notes.id }).from(notes)).length;
}

/** `edit` 桶（測試自己持有的那一顆）還剩幾格：一路 consume 到被拒。 */
function cellsLeft(limiter: FixedWindowLimiter, userId: string): number {
  let n = 0;
  while (limiter.consume(userId)) n += 1;
  return n;
}

describe("#175 PR5 create_note {group_id}", () => {
  it("A 一般成員：群組列、owner＝群組、url /g/、role editor；slug 去重範圍＝該群組（不對稱測資：個人那發另得 plan-3）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await seedNote(db, { groupId: g.id }, { title: "Plan", slug: "plan" });
    await seedNote(db, { ownerId: me.id }, { title: "Plan", slug: "plan" });
    await seedNote(db, { ownerId: me.id }, { title: "Plan 2", slug: "plan-2" });
    const { token } = await seedTokenForUser(db, me.id, RW);

    const inGroup = await createdNote(app, token, { title: "Plan", group_id: g.id });
    const [row] = await db.select().from(notes).where(eq(notes.id, inGroup.id));
    expect(row!.groupId).toBe(g.id);
    expect(row!.ownerId).toBeNull();
    expect(inGroup.slug).toBe("plan-2");
    expect(inGroup.url).toBe(`/g/${g.id}/plan-2`);
    expect(inGroup.role).toBe("editor");
    expect(inGroup.owner).toEqual({ kind: "group", id: g.id, name: "Team" });

    const personal = await createdNote(app, token, { title: "Plan" });
    expect(personal.slug).toBe("plan-3");
    expect(personal.role).toBe("owner");
    expect(personal.owner).toEqual({ kind: "user", handle: me.handle });
  });

  it("A2 反向：個人有 plan、群組沒有任何筆記 → 群組那發 slug 就是 plan（個人筆記不佔群組範圍）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await seedNote(db, { ownerId: me.id }, { title: "Plan", slug: "plan" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const inGroup = await createdNote(app, token, { title: "Plan", group_id: g.id });
    expect(inGroup.slug).toBe("plan");
    expect(inGroup.url).toBe(`/g/${g.id}/plan`);
  });

  it("B 帶 content（collab app）：內容落盤、note_ai_edits 一列、role editor、owner 是群組、lastEdited 非 null（rereadVisibleNote 走了 grouped 分支）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW, "Claude Code");
    const note = await createdNote(ctx.app, token, { title: "Doc", content: "# Hello\n\n群組內容", group_id: g.id });
    expect(note.role).toBe("editor");
    expect(note.owner).toEqual({ kind: "group", id: g.id, name: "Team" });
    expect(note.url.startsWith("/g/")).toBe(true);
    expect(note.lastEdited).not.toBeNull();
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(1);
    const content = await getContent(ctx.app, note.id, token);
    expect(content.statusCode).toBe(200);
    expect(JSON.stringify(content.json())).toContain("群組內容");
  });

  it("C create-only 角色：不帶與帶 content 都建得成、role viewer（不是 editor）、之後 edit_note forbidden、同一把 token 的 REST revert 也是 403 forbidden", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, me.id, await seedRole(ctx.db, g.id, "Creator", { canRead: true, canCreate: true }));
    const { token } = await seedTokenForUser(ctx.db, me.id, RW, "Claude Code");

    const empty = await createdNote(ctx.app, token, { title: "Empty", group_id: g.id });
    const filled = await createdNote(ctx.app, token, { title: "Filled", content: "# Body\n\n文字", group_id: g.id });
    expect(empty.role).toBe("viewer");
    expect(filled.role).toBe("viewer");
    expect(empty.owner).toEqual({ kind: "group", id: g.id, name: "Team" });

    for (const n of [empty, filled]) {
      const denied = await callTool(ctx.app, token, "edit_note", { note_id: n.id, op: "append", markdown: "x" });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent!.code).toBe("forbidden");
      expect(denied.structuredContent!.message).toBe(FORBIDDEN_MESSAGE);
      expect(String(denied.structuredContent!.message)).not.toContain("owner");
    }

    // docs/mcp.md「undone by anyone who can edit the note, which leaves out the creator…」的依據：
    // 帶 content 建出的那一篇有一列 note_ai_edits（回應不帶 editId，從 DB 取），create-only 的建立者撤回它 → 403。
    const edits = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, filled.id));
    expect(edits).toHaveLength(1);
    const revert = await ctx.app.inject({ method: "POST", url: `/api/notes/${filled.id}/edits/${edits[0]!.id}/revert`, headers: bearer(token) });
    expect(revert.statusCode).toBe(403);
    expect(revert.json().error.code).toBe("forbidden");
  });

  it("D 非成員的群組與不存在的 uuid：零新增列、edit 桶不啃、structuredContent 逐位元組相同、group_not_found＋E1、不是 NOTE_NOT_FOUND_MESSAGE", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const [me, other] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db)]);
    await seedGroup(ctx.db, "Mine", [{ userId: me.id, role: "member" }]);
    const foreign = await seedGroup(ctx.db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const before = await noteCount(ctx.db);

    const nonMember = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: foreign.id });
    const missing = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: randomUUID() });

    expect(await noteCount(ctx.db)).toBe(before);
    expect(cellsLeft(edit, me.id), "group_not_found 不得啃 edit 桶").toBe(EDIT_LIMIT.limit);
    for (const r of [nonMember, missing]) {
      expect(r.isError).toBe(true);
      expect(r.structuredContent!.code).toBe("group_not_found");
      expect(r.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);
      expect(r.structuredContent!.message).not.toBe(NOTE_NOT_FOUND_MESSAGE);
    }
    expect(nonMember.structuredContent).toEqual(missing.structuredContent);
    expect(JSON.stringify(nonMember.structuredContent)).toBe(JSON.stringify(missing.structuredContent));
  });

  it("E 是成員但角色沒有新建旗標：零新增列、edit 桶不啃、forbidden＋E2", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, me.id, await seedRole(ctx.db, g.id, "NoCreate", { canRead: true, canEdit: true }));
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const before = await noteCount(ctx.db);

    const r = await callTool(ctx.app, token, "create_note", { title: "T", content: "# x", group_id: g.id });

    expect(await noteCount(ctx.db)).toBe(before);
    expect(cellsLeft(edit, me.id), "forbidden 不得啃 edit 桶").toBe(EDIT_LIMIT.limit);
    expect(r.isError).toBe(true);
    expect(r.structuredContent!.code).toBe("forbidden");
    expect(r.structuredContent!.message).toBe(E2_CREATE_FORBIDDEN);
  });

  it("F 站台 admin 非成員：與一般非成員／不存在的 uuid 的 structuredContent 逐位元組相同（§5.5 無豁免）", async () => {
    const { app, db } = await buildTestApp();
    const [admin, plain, other] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const adminToken = (await seedTokenForUser(db, admin.id, RW)).token;
    const plainToken = (await seedTokenForUser(db, plain.id, RW)).token;
    const before = await noteCount(db);

    const asAdmin = await callTool(app, adminToken, "create_note", { title: "T", group_id: foreign.id });
    const asPlain = await callTool(app, plainToken, "create_note", { title: "T", group_id: foreign.id });
    const adminMissing = await callTool(app, adminToken, "create_note", { title: "T", group_id: randomUUID() });

    expect(await noteCount(db)).toBe(before);
    expect(asAdmin.isError).toBe(true);
    expect(asAdmin.structuredContent!.code).toBe("group_not_found");
    expect(JSON.stringify(asAdmin.structuredContent)).toBe(JSON.stringify(asPlain.structuredContent));
    expect(JSON.stringify(asAdmin.structuredContent)).toBe(JSON.stringify(adminMissing.structuredContent));
  });

  it("G group_id 不是 uuid：零新增列、isError 且沒有 structuredContent（SDK 輸入驗證形，無 code）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);
    const r = await callTool(app, token, "create_note", { title: "T", group_id: "not-a-uuid" });
    expect(await noteCount(db)).toBe(before);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it("H 成員檢查之後群組被刪（membership-checked 縫）：不帶與帶 content 都回 group_not_found＋E1（不是 internal）、零新增列", async () => {
    // 刪空群組：PR1 起只有空群組可刪，本案群組無筆記。hook 拿 db 的方式：app 建好才有 db，所以用 holder。
    const holder: { db?: Db } = {};
    const hook: GroupTestHook = async (point, hctx) => {
      if (point === "membership-checked") await holder.db!.delete(groups).where(eq(groups.id, hctx.groupId!));
    };

    const plain = await buildTestApp({ groupTestHook: hook });
    holder.db = plain.db;
    const me1 = await seedUser(plain.db);
    const g1 = await seedGroup(plain.db, "Doomed", [{ userId: me1.id, role: "member" }]);
    const t1 = (await seedTokenForUser(plain.db, me1.id, RW)).token;
    const r1 = await callTool(plain.app, t1, "create_note", { title: "T", group_id: g1.id });
    expect(await noteCount(plain.db)).toBe(0);
    expect(r1.isError).toBe(true);
    expect(r1.structuredContent!.code).toBe("group_not_found");
    expect(r1.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);

    const collab = await buildCollabTestApp({ groupTestHook: hook });
    holder.db = collab.db;
    const me2 = await seedUser(collab.db);
    const g2 = await seedGroup(collab.db, "Doomed", [{ userId: me2.id, role: "member" }]);
    const t2 = (await seedTokenForUser(collab.db, me2.id, RW)).token;
    const r2 = await callTool(collab.app, t2, "create_note", { title: "T", content: "# x", group_id: g2.id });
    expect(await noteCount(collab.db)).toBe(0);
    expect(await collab.db.select().from(noteAiEdits)).toHaveLength(0);
    expect(r2.isError).toBe(true);
    expect(r2.structuredContent!.code).toBe("group_not_found");
    expect(r2.structuredContent!.message).toBe(E1_GROUP_NOT_FOUND);
  });

  it("I 大寫 uuid 的 group_id：成功，owner.id 與 url 都是小寫", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await createdNote(app, token, { title: "Up", group_id: g.id.toUpperCase() });
    expect(note.owner.id).toBe(g.id);
    expect(note.url).toBe(`/g/${g.id}/${note.slug}`);
    expect(note.url).toBe(note.url.toLowerCase());
  });
});

// ───────────────────────────── #180 W15：create_note 改鍵名 group_id（spec §4.7、§10.5a） ─────────────────────────────

describe("#180 create_note 的 group_id 與 strict 註冊", () => {
  it("M-G1 用舊鍵 groupId（合法群組 id）→ 先斷零新增筆記，再斷 SDK 輸入驗證錯誤（isError、無 code、訊息含 groupId）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);

    const res = await mcpPost(app, rpc("tools/call", { name: "create_note", arguments: { title: "Old key", groupId: g.id } }), { token });

    expect(await noteCount(db)).toBe(before);
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; content: { text: string }[]; structuredContent?: { code?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toContain("groupId");
  });

  it("M-G3 REST POST /api/notes {groupId} 照舊 201（鍵名偏離只在 MCP，createBodySchema 不動）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(me.id), payload: { title: "REST", groupId: g.id } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ groupId: g.id, ownerId: null });
  });
});

// ───────────────────────────── #239 W9：notes:move 不管 create_note／edit_note（spec §11.2 M6） ─────────────────────────────

describe("#239 W9：notes:move 不管 create_note／edit_note", () => {
  it("讀寫無搬移憑證：create_note {group_id} 成功、owner 是群組；edit_note append 群組筆記成功", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "admin" }]);
    // 第三參數明寫讀寫（無 notes:move），不依賴 seedTokenForUser 的預設值——預設值日後若改，這案的意圖不能跟著變。
    const { token } = await seedTokenForUser(ctx.db, me.id, "notes:read notes:write");
    const created = await createdNote(ctx.app, token, { title: "W9", group_id: g.id });
    expect(created.owner.kind).toBe("group");
    const appended = await callTool(ctx.app, token, "edit_note", { note_id: created.id, op: "append", markdown: "W9" });
    expect(appended.isError).toBeUndefined();
  });
});
