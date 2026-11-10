/**
 * #180：`edit_note` 的 `rename`（R1–R12）。collab app（`edit_note` 在 collab 閘門內）。
 * #381：rename 必帶 `if_match`＝標題指紋（`read_note_outline` 的 `titleFingerprint`）。
 * 模型面字串一律寫字面值。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import { groups, noteAiEdits, noteRedirects, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { fingerprintOf } from "../src/notes/editing/fingerprint.js";
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
  "`markdown`; every operation except append needs `if_match` (for rename, the title's `titleFingerprint`); rename needs `title`, " +
  "and no other operation takes it. Fields that do not belong to the operation are rejected.";
/** #381：標題指紋不符（工具層錯誤、英文；同其他 op 的 `fingerprint_mismatch` 碼）。 */
const RENAME_MISMATCH =
  "`if_match` is not the fingerprint of the note's current title — most likely the title was changed after you got that " +
  "fingerprint — so the note was not renamed. Call read_note_outline to see the current title and its `titleFingerprint`, " +
  "then retry with that as `if_match` if you still want to rename it.";
/** 格式合法、但不會是任何測試標題指紋的值（拿不到真指紋的呼叫者——陌生人、不存在的筆記——用它）。 */
const DUMMY_FP = "0123456789abcdef";

type Result = { isError?: true; content: { text: string }[]; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };

async function call(app: FastifyInstance, auth: { token?: string; cookie?: string }, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
/** #381：照模型的真實流程，先以**同一個憑證** `read_note_outline` 拿 `titleFingerprint`；讀不到（not_found）就送 DUMMY_FP。
 *  `ifMatch` 明給時不讀。 */
async function titleFpVia(app: FastifyInstance, auth: { token?: string; cookie?: string }, noteId: string): Promise<string> {
  const o = await call(app, auth, "read_note_outline", { note_id: noteId });
  return o.isError ? DUMMY_FP : (o.structuredContent!.titleFingerprint as string);
}
const rename = async (app: FastifyInstance, token: string, noteId: string, title: string, ifMatch?: string) =>
  call(app, { token }, "edit_note", { note_id: noteId, op: "rename", title, if_match: ifMatch ?? (await titleFpVia(app, { token }, noteId)) });
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
  it("R1 正路（個人、auto slug）：回應恰 {title,titleFingerprint,url}、無 isError；DB title／slug／updated_at；url 與 list_notes 同字；舊 by-path 404、無轉址列；不留 AI 紀錄", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Old title", slug: "old-title" });
    const before = await row(ctx.db, n.id);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);

    // #381：read_note_outline 的 titleFingerprint＝fingerprintOf(標題全文)。
    const fp0 = await titleFpVia(ctx.app, { token }, n.id);
    expect(fp0).toBe(fingerprintOf("Old title"));
    const r = await rename(ctx.app, token, n.id, "New title", fp0);

    expect(r.isError).toBeUndefined();
    expect(Object.keys(r.structuredContent!).sort()).toEqual(["title", "titleFingerprint", "url"]);
    expect(r.structuredContent).toEqual({ title: "New title", titleFingerprint: fingerprintOf("New title"), url: `/n/${me.handle}/new-title` });
    // 成功回的新指紋＝之後重讀拿到的那一顆（連續改名不必回頭讀）。
    expect(await titleFpVia(ctx.app, { token }, n.id)).toBe(r.structuredContent!.titleFingerprint);
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
    expect(r.structuredContent).toEqual({ title: "Renamed by editor", titleFingerprint: fingerprintOf("Renamed by editor"), url: `/n/${owner.handle}/renamed-by-editor` });
  });

  it("R3 群組 editor 改群組筆記 → /g/<group id>/<slug>", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(ctx.db, { groupId: g.id }, { title: "Group note" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Group renamed");
    expect(r.structuredContent).toEqual({ title: "Group renamed", titleFingerprint: fingerprintOf("Group renamed"), url: `/g/${g.id}/group-renamed` });
  });

  it("R4 先 REST PATCH {slug:'keep-me'} 設自訂 → rename：slug、url 不變、標題已換", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Custom" });
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { slug: "keep-me" } })).statusCode).toBe(200);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const r = await rename(ctx.app, token, n.id, "Totally different");
    expect(r.structuredContent).toEqual({ title: "Totally different", titleFingerprint: fingerprintOf("Totally different"), url: `/n/${me.handle}/keep-me` });
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

  it("R6 矩陣經 HTTP：rename 無 if_match（#381）、rename＋markdown、replace_all＋title → invalid_body；rename 無 title → Check: title. ＋尾段；空字串與含 NUL → SDK 驗證形；DB 不變", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Stay" });
    const before = await row(ctx.db, n.id);
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    // #381：舊形的 rename 呼叫（只帶 title）被拒——工具層 invalid_body、英文、點名 if_match。
    const e1 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title: "x" });
    expect(e1.structuredContent).toEqual({
      code: "invalid_body",
      message: `This \`rename\` call does not match what that operation needs. Check: if_match. ${INVALID_TAIL}`,
    });
    const e1b = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title: "x", if_match: fingerprintOf("Stay"), markdown: "m" });
    expect(e1b.structuredContent!.code).toBe("invalid_body");
    const e2 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "replace_all", markdown: "m", if_match: DUMMY_FP, title: "x" });
    expect(e2.structuredContent!.code).toBe("invalid_body");
    const e3 = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", if_match: fingerprintOf("Stay") });
    expect(e3.structuredContent!.code).toBe("invalid_body");
    expect(e3.structuredContent!.message).toContain("Check: title.");
    expect(e3.structuredContent!.message).toContain(INVALID_TAIL);
    expect((await row(ctx.db, n.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    for (const title of ["", `a${String.fromCharCode(0)}b`]) {
      const e = await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "rename", title, if_match: fingerprintOf("Stay") });
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
    // #381：連發時用上一發回的 titleFingerprint 接下一發（不回頭讀）。
    let fp = fingerprintOf("T1");
    for (let i = 0; i < 11; i += 1) {
      const r = await call(ctx.app, { cookie }, "edit_note", { note_id: n.id, op: "rename", title: `S${i}`, if_match: fp });
      expect(r.isError, `第 ${i + 1} 發`).toBeUndefined();
      fp = r.structuredContent!.titleFingerprint as string;
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
    // #381：指紋算的是標題**全文**，不是截斷後的顯示字串；outline 那邊同一顆（outline 的 title 也被截）。
    expect(r.structuredContent!.titleFingerprint).toBe(fingerprintOf(long));
    const o = await call(ctx.app, { token }, "read_note_outline", { note_id: n.id });
    expect((o.structuredContent!.note as { titleTruncated?: true }).titleTruncated).toBe(true);
    expect(o.structuredContent!.titleFingerprint).toBe(fingerprintOf(long));
    // 用它再改一次名照樣成功。
    expect((await rename(ctx.app, token, n.id, "Short again", fingerprintOf(long))).isError).toBeUndefined();
  });

  it("R10 網頁 PATCH 仍是 last-write-wins；MCP 讀過現值再改則成功（MCP rename A 後 REST PATCH B → B；PATCH C 後 MCP 重讀再 rename A → A）", async () => {
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
    const r = await call(ctx.app, { cookie: await sessionCookie(me.id) }, "edit_note", { note_id: n.id, op: "rename", title: "Session", if_match: fingerprintOf("S") });
    expect(r.structuredContent).toEqual({ title: "Session", titleFingerprint: fingerprintOf("Session"), url: `/n/${me.handle}/session` });
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

  it("邊界標題：同標題 → 網址不變；撞同範圍另一篇 → -2；純標點 → untitled 形", async () => {
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

  it("R14 #381 讀 → 別人在網頁改標題 → rename 帶舊 if_match → fingerprint_mismatch（恰 code＋message）、標題是別人改的、slug／updated_at 不動；重讀後再改成功", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "A", slug: "a" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const stale = await titleFpVia(ctx.app, { token }, n.id);
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title: "B" } })).statusCode).toBe(200);
    const afterB = await row(ctx.db, n.id);
    expect(afterB.title).toBe("B");

    const r = await rename(ctx.app, token, n.id, "C", stale);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    const still = await row(ctx.db, n.id);
    expect(still.title).toBe("B");
    expect(still.slug).toBe(afterB.slug);
    expect(still.updatedAt.getTime()).toBe(afterB.updatedAt.getTime());

    const fresh = await titleFpVia(ctx.app, { token }, n.id);
    expect(fresh).toBe(fingerprintOf("B"));
    expect((await rename(ctx.app, token, n.id, "C", fresh)).structuredContent!.title).toBe("C");
    expect((await row(ctx.db, n.id)).title).toBe("C");
  });

  it("R15 #381 併發：比對通過後、UPDATE 之前（slugUpdateTestHook）別人改了標題 → fingerprint_mismatch、標題是別人改的；重讀後再改成功", async () => {
    const mode: { act?: (db: Parameters<typeof seedUser>[0]) => Promise<void> } = {};
    const holder: { db?: Parameters<typeof seedUser>[0] } = {};
    const ctx = await buildCollabTestApp({ slugUpdateTestHook: async () => { if (mode.act) { const f = mode.act; mode.act = undefined; await f(holder.db!); } } });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Before", slug: "before" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const fp = await titleFpVia(ctx.app, { token }, n.id);
    // 搶在 rename 的 pre-read（含指紋比對）之後、條件式 UPDATE 之前寫進別人的標題（＝網頁 PATCH 已提交的那一句）。
    mode.act = async db => { await db.update(notes).set({ title: "Theirs" }).where(eq(notes.id, n.id)); };
    const r = await rename(ctx.app, token, n.id, "Mine", fp);
    expect(mode.act).toBeUndefined(); // hook 真的在這一發裡觸發過
    expect(r.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect((await row(ctx.db, n.id)).title).toBe("Theirs");

    const fresh = await titleFpVia(ctx.app, { token }, n.id);
    expect(fresh).toBe(fingerprintOf("Theirs"));
    expect((await rename(ctx.app, token, n.id, "Mine", fresh)).isError).toBeUndefined();
    expect((await row(ctx.db, n.id)).title).toBe("Mine");
  });

  it("R16 #381 內文 if_match 不含標題：拿到段落／整篇指紋後別人改標題 → replace_section、replace_all 照樣成功；反向：拿到 titleFingerprint 後改內文 → rename 照樣成功；內文指紋當 rename 的 if_match → fingerprint_mismatch", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "Body" });
    const { token } = await seedTokenForUser(ctx.db, me.id, RW);
    const patch = async (title: string) =>
      expect((await ctx.app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(me.id), payload: { title } })).statusCode).toBe(200);
    const edit = (args: Record<string, unknown>) => call(ctx.app, { token }, "edit_note", { note_id: n.id, ...args });

    const ap = await edit({ op: "append", markdown: "# Head\n\nfirst" });
    expect(ap.isError).toBeUndefined();
    const head = (ap.structuredContent!.outline as { sections: Array<{ sectionId: string; heading: string; fingerprint: string }> }).sections.find(s => s.heading === "Head")!;

    await patch("Renamed in browser 1");
    const rs = await edit({ op: "replace_section", section_id: head.sectionId, markdown: "# Head\n\nsecond", if_match: head.fingerprint });
    expect(rs.isError, JSON.stringify(rs.structuredContent)).toBeUndefined();

    await patch("Renamed in browser 2");
    const ra = await edit({ op: "replace_all", markdown: "# Head\n\nthird", if_match: rs.structuredContent!.fingerprint });
    expect(ra.isError, JSON.stringify(ra.structuredContent)).toBeUndefined();

    const tfp = await titleFpVia(ctx.app, { token }, n.id);
    expect((await edit({ op: "append", markdown: "more" })).isError).toBeUndefined();
    const wrongKind = await rename(ctx.app, token, n.id, "Nope", ra.structuredContent!.fingerprint as string);
    expect(wrongKind.structuredContent).toEqual({ code: "fingerprint_mismatch", message: RENAME_MISMATCH });
    expect((await row(ctx.db, n.id)).title).toBe("Renamed in browser 2");
    expect((await rename(ctx.app, token, n.id, "Final", tfp)).isError).toBeUndefined();
    expect((await row(ctx.db, n.id)).title).toBe("Final");
  });
});
