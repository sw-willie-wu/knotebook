/**
 * #180 spec §10.2：`edit_note` 的 `rename`（R1–R12）＋ Review Focus RF2。collab app（`edit_note` 在 collab 閘門內）。
 * 模型面字串一律寫字面值（spec §4.3 逐字）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import { groups, noteAiEdits, noteRedirects, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const RW = "notes:read notes:write" as const;
const FORBIDDEN = "You can read this note but not change it. Ask whoever manages your access to it for editing rights.";
const RENAME_CONFLICT =
  "The note was moved into a group, or its group was deleted, after your access was checked, so its title was not changed. Try again.";
const TOKEN_RATE_LIMITED = "Too many writes with this credential right now. Wait a few minutes before writing again.";
const INVALID_TAIL =
  "replace_section, insert_after and delete_section need `section_id`; every operation except delete_section and rename needs " +
  "`markdown`; every operation except append and rename needs `if_match`; rename needs `title`, and no other operation takes it. " +
  "Fields that do not belong to the operation are rejected.";

type Result = { isError?: true; content: { text: string }[]; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };

async function call(app: FastifyInstance, auth: { token?: string; cookie?: string }, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
const rename = (app: FastifyInstance, token: string, noteId: string, title: string) =>
  call(app, { token }, "edit_note", { note_id: noteId, op: "rename", title });
const sessionCookie = async (userId: string) => (await cookieOf(userId))[SESSION_COOKIE]!;
async function row(db: Parameters<typeof seedUser>[0], id: string) {
  const [r] = await db.select().from(notes).where(eq(notes.id, id));
  return r!;
}
async function listUrl(app: FastifyInstance, token: string, id: string): Promise<string> {
  const r = await call(app, { token }, "list_notes", { limit: 100 });
  return ((r.structuredContent!.notes as Array<{ id: string; url: string }>).find(n => n.id === id))!.url;
}

describe("#180 edit_note rename", () => {
  it("R1 正路（個人、auto slug）：回應恰 {title,url}、無 isError；DB title／slug／updated_at；url 與 list_notes 同字；舊 by-path 404、無轉址列；不留 AI 紀錄", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Old title", slug: "old-title" });
    const before = await row(ctx.db, n.id);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);

    const r = await rename(ctx.app, token, n.id, "New title");

    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent!).sort()).toEqual(["title", "url"]);
    expect(r.structuredContent).toEqual({ title: "New title", url: `/n/${me.handle}/new-title` });
    const after = await row(ctx.db, n.id);
    expect(after.title).toBe("New title");
    expect(after.slug).toBe("new-title");
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(await listUrl(ctx.app, token, n.id)).toBe(r.structuredContent!.url);
    const old = await ctx.app.inject({ method: "GET", url: `/api/notes/by-path/${me.handle}/old-title`, cookies: await cookieOf(me.id) });
    expect(old.statusCode).toBe(404);
    expect(await ctx.db.select().from(noteRedirects).where(eq(noteRedirects.noteId, n.id))).toEqual([]);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id))).toEqual([]);
    const edits = await ctx.app.inject({ method: "GET", url: `/api/notes/${n.id}/edits`, cookies: await cookieOf(me.id) });
    expect(edits.statusCode).toBe(200);
    expect(edits.json().edits).toEqual([]);
  });

  it("R2 分享 editor 改別人的個人筆記 → url 用 owner 的 handle", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, ed] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db)]);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Theirs" });
    await seedShare(ctx.db, n.id, ed.id, "editor");
    const { token } = await seedTokenForUser(ctx.db, ed.id, RW);
    const r = await rename(ctx.app, token, n.id, "Renamed by editor");
    expect(r.structuredContent).toEqual({ title: "Renamed by editor", url: `/n/${owner.handle}/renamed-by-editor` });
  });

  it("R3 群組 editor 改群組筆記 → /g/<group id>/<slug>", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(ctx.db, { groupId: g.id }, { title: "Group note" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Group renamed");
    expect(r.structuredContent).toEqual({ title: "Group renamed", url: `/g/${g.id}/group-renamed` });
  });

  it("R4 先 REST PATCH {slug:'keep-me'} 設自訂 → rename：slug、url 不變、標題已換", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Custom" });
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { slug: "keep-me" } })).statusCode).toBe(200);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Totally different");
    expect(r.structuredContent).toEqual({ title: "Totally different", url: `/n/${me.handle}/keep-me` });
    expect((await row(ctx.db, n.id)).slug).toBe("keep-me");
  });

  it("R5 權限：陌生人與不存在 → not_found，body 與 read_note_outline 逐位元組相同；分享 viewer、群組 create-only 角色 → forbidden", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, stranger, viewer, creator] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db)]);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Private" });
    await seedShare(ctx.db, n.id, viewer.id, "viewer");
    const st = (await seedTokenForUser(ctx.db, stranger.id, RW)).token;
    const outline = await call(ctx.app, { token: st }, "read_note_outline", { note_id: n.id });
    const a = await rename(ctx.app, st, n.id, "x");
    const b = await rename(ctx.app, st, randomUUID(), "x");
    expect(a.structuredContent!.code).toBe("not_found");
    expect(JSON.stringify(a.structuredContent)).toBe(JSON.stringify(outline.structuredContent));
    expect(JSON.stringify(b.structuredContent)).toBe(JSON.stringify(outline.structuredContent));
    const vt = (await seedTokenForUser(ctx.db, viewer.id, RW)).token;
    expect((await rename(ctx.app, vt, n.id, "x")).structuredContent).toEqual({ code: "forbidden", message: FORBIDDEN });

    const g = await seedGroup(ctx.db, "Team", [{ userId: creator.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, creator.id, await seedRole(ctx.db, g.id, "Creator", { canRead: true, canCreate: true }));
    const ct = (await seedTokenForUser(ctx.db, creator.id, RW)).token;
    const created = await call(ctx.app, { token: ct }, "create_note", { title: "Mine in group", group_id: g.id });
    const note = created.structuredContent!.note as { id: string; role: string };
    expect(note.role).toBe("viewer");
    expect((await rename(ctx.app, ct, note.id, "x")).structuredContent).toEqual({ code: "forbidden", message: FORBIDDEN });
    expect((await row(ctx.db, n.id)).title).toBe("Private");
  });

  it("R6 矩陣經 HTTP：rename＋if_match、replace_all＋title → invalid_body；rename 無 title → Check: title. ＋尾段；空字串與含 NUL → SDK 驗證形；DB 不變", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Stay" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const e1 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title: "x", if_match: "0123456789abcdef" });
    expect(e1.structuredContent!.code).toBe("invalid_body");
    const e2 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "replace_all", markdown: "m", if_match: "0123456789abcdef", title: "x" });
    expect(e2.structuredContent!.code).toBe("invalid_body");
    const e3 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename" });
    expect(e3.structuredContent!.code).toBe("invalid_body");
    expect(e3.structuredContent!.message).toContain("Check: title.");
    expect(e3.structuredContent!.message).toContain(INVALID_TAIL);
    for (const title of ["", `a${String.fromCharCode(0)}b`]) {
      const e = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title });
      expect(e.isError).toBe(true);
      expect(e.structuredContent).toBeUndefined();
    }
    expect((await row(ctx.db, n.id)).title).toBe("Stay");
  });

  it("R7 節流：tokenWrite limit 1 → 第二發 too_many_requests；edit 桶已用盡 rename 照樣成功；session 連發 11 次全成功", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const edit = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite, edit } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "T0" });
    expect(edit.consume(me.id)).toBe(true); // edit 桶用盡
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    expect((await rename(ctx.app, token, n.id, "T1")).isError).toBeUndefined();
    expect((await rename(ctx.app, token, n.id, "T2")).structuredContent).toEqual({ code: "too_many_requests", message: TOKEN_RATE_LIMITED });
    const cookie = await sessionCookie(me.id);
    for (let i = 0; i < 11; i += 1) {
      const r = await call(ctx.app, { cookie }, "edit_note", { note_id: n.id, op: "rename", title: `S${i}` });
      expect(r.isError, `第 ${i + 1} 發`).toBeUndefined();
    }
  });

  it("R8 交錯：slugUpdateTestHook 內把筆記移進群組 → conflict＋RENAME_CONFLICT、標題未寫；hook 內刪筆記 → not_found", async () => {
    const mode: { act?: (db: Parameters<typeof seedUser>[0]) => Promise<void> } = {};
    const holder: { db?: Parameters<typeof seedUser>[0] } = {};
    const ctx = await buildCollabTestApp({ slugUpdateTestHook: async () => { if (mode.act) { const f = mode.act; mode.act = undefined; await f(holder.db!); } } });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Before" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    mode.act = async db => { await db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, n.id)); };
    expect((await rename(ctx.app, token, n.id, "After")).structuredContent).toEqual({ code: "conflict", message: RENAME_CONFLICT });
    expect((await row(ctx.db, n.id)).title).toBe("Before");

    const n2 = await seedNote(ctx.db, { ownerId: me.id }, { title: "Doomed" });
    mode.act = async db => { await db.delete(notes).where(eq(notes.id, n2.id)); };
    expect((await rename(ctx.app, token, n2.id, "After")).structuredContent!.code).toBe("not_found");
    expect(await ctx.db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("R9 長標題（JSON 逃脫後 > 200）→ 回應 title 截斷＋titleTruncated:true、DB 存全文", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Short" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const long = '"'.repeat(150);
    const r = await rename(ctx.app, token, n.id, long);
    expect(r.structuredContent!.titleTruncated).toBe(true);
    expect((r.structuredContent!.title as string).length).toBeLessThan(long.length);
    expect((await row(ctx.db, n.id)).title).toBe(long);
  });

  it("R10 last-write-wins：MCP rename A 後 REST PATCH B → B；反序 → A", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Start" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const patch = async (title: string) =>
      expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title } })).statusCode).toBe(200);
    await rename(ctx.app, token, n.id, "A");
    await patch("B");
    expect((await row(ctx.db, n.id)).title).toBe("B");
    await patch("C");
    await rename(ctx.app, token, n.id, "A");
    expect((await row(ctx.db, n.id)).title).toBe("A");
  });

  it("R11 session MCP rename 成功且不扣 tokenWrite", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "S" });
    const r = await call(ctx.app, { cookie: await sessionCookie(me.id) }, "edit_note", { note_id: n.id, op: "rename", title: "Session" });
    expect(r.structuredContent).toEqual({ title: "Session", url: `/n/${me.handle}/session` });
    expect(tokenWrite.consume(`token:${me.id}`)).toBe(true);
  });

  it("R12 五個舊 op 的回應仍帶四欄（replace_all、append 各一發）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Content" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const ap = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "append", markdown: "first para" });
    expect(Object.keys(ap.structuredContent!).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"]);
    const ra = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "replace_all", markdown: "replaced", if_match: ap.structuredContent!.fingerprint });
    expect(Object.keys(ra.structuredContent!).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"]);
  });

  it("RF2 邊界標題：同標題 → 網址不變；撞同範圍另一篇 → -2；純標點 → untitled 形", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    await seedNote(ctx.db, { ownerId: me.id }, { title: "Taken", slug: "taken" });
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Same", slug: "same" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    expect((await rename(ctx.app, token, n.id, "Same")).structuredContent!.url).toBe(`/n/${me.handle}/same`);
    expect((await rename(ctx.app, token, n.id, "Taken")).structuredContent!.url).toBe(`/n/${me.handle}/taken-2`);
    const p = await rename(ctx.app, token, n.id, "!!!");
    expect(p.isError).toBeUndefined();
    expect(p.structuredContent!.url).toMatch(new RegExp(`^/n/${me.handle}/untitled(-\\d+)?$`));
  });
});
