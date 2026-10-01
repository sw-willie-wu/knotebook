/**
 * #175 §9：MCP 對群組筆記（Q23：PR1 就要讀得到、`edit_note` 改得動）。harness 照 mcp-notes／mcp-content 兩檔。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { noteAiEdits } from "../src/db/schema.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

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
