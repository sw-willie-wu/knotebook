/**
 * #180 spec §10.4：MCP `copy_note`（C1–C13）＋ M-G2（copy 半）＋ Review Focus RF1（大寫 group_id）、RF3（同群組內複製）。
 * 無 collab 的案用 `buildTestApp`（它回 `uploadsDir`，可數磁碟檔）；C3 要 live doc，用 `buildCollabTestApp`。
 * 模型面字串一律寫字面值（spec §6.6 逐字）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { noteAiEdits, noteShares, notes, uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { docText, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { imageDoc, loadDoc, seedDoc, xmlOf } from "./copy-helpers.js";
import { filesIn, giveGroupQuota, giveUserQuota, seedAttachment } from "./storage-helpers.js";
import { searchDoc } from "./search-doc.js";

const RW = "notes:read notes:write" as const;
const GROUP_NO_CREATE = "No group with that id among your groups where your role can create notes.";
const WRITE_RATE = "Too many note writes right now. Wait a moment before writing again.";
const TOKEN_RATE = "Too many writes with this credential right now. Wait a few minutes before writing again.";
const UPLOAD_LIMIT_MSG =
  "Copying this note's images would go over your upload limit (120 files per 10 minutes, copies included), so nothing was copied. Wait a few minutes and try again.";
const BUSY = "The server was busy, so no copy was made. Try again in a moment.";
const TAIL = "A site admin can assign a larger storage plan; deleting notes that have images also frees space.";

type Result = { isError?: true; content: { text: string }[]; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };
type Note = { id: string; title: string; url: string; role: string; slug: string; owner: { kind: string; id?: string; handle?: string; name?: string }; lastEdited: unknown };

async function call(app: FastifyInstance, token: string, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
async function copied(app: FastifyInstance, token: string, args: unknown): Promise<Note> {
  const r = await call(app, token, "copy_note", args);
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent!.note as Note;
}
const noteCount = async (db: Db) => (await db.select({ id: notes.id }).from(notes)).length;
async function listUrl(app: FastifyInstance, token: string, id: string): Promise<string> {
  const r = await call(app, token, "list_notes", { limit: 100 });
  return (r.structuredContent!.notes as Array<{ id: string; url: string }>).find(n => n.id === id)!.url;
}

describe("#180 copy_note", () => {
  it("C1 個人：分享 viewer 複製別人的筆記 → owner＝呼叫者、role owner、title 同來源、url 與 list_notes 同字", async () => {
    const { app, db } = await buildTestApp();
    const [owner, me] = await Promise.all([seedUser(db), seedUser(db)]);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Shared source" });
    await seedShare(db, src.id, me.id, "viewer");
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id });
    expect(note.owner).toEqual({ kind: "user", handle: me.handle });
    expect(note.role).toBe("owner");
    expect(note.title).toBe("Shared source");
    expect(note.id).not.toBe(src.id);
    expect(await listUrl(app, token, note.id)).toBe(note.url);
  });

  it("C2 群組：create-only 角色複製進群組 → role viewer、owner 是群組", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(db, g.id, me.id, await seedRole(db, g.id, "Creator", { canRead: true, canCreate: true }));
    const src = await seedNote(db, { ownerId: me.id }, { title: "Mine" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id });
    expect(note.role).toBe("viewer");
    expect(note.owner).toEqual({ kind: "group", id: g.id, name: "Team" });
  });

  it("C3 內容：live doc 比 note_states 新——小寫、大寫 note_id 各複製一次，副本都有 MARK；之後改副本，來源不變", async () => {
    const PASSWORD = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const email = `c3-${randomUUID()}@example.com`;
    const u = await ctx.createUser({ email, password: PASSWORD });
    const src = await ctx.createNote(u.id, "Live source");
    const session = await ctx.loginAs(email, PASSWORD);
    const MARK = `MARK-${randomUUID()}`;
    const client = await seedContent(ctx, session, src.id, `# Head\n\n${MARK}`); // 保持連線：onStoreDocument 的 2 秒 debounce 內 note_states 還沒有 MARK
    const stateHasMark = async () => { const d = await loadDoc(ctx.db, src.id); return d !== null && xmlOf(d).includes(MARK); };
    expect(await stateHasMark()).toBe(false); // 前提
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const lower = await copied(ctx.app, token, { note_id: src.id });
    const upper = await copied(ctx.app, token, { note_id: src.id.toUpperCase() });
    for (const c of [lower, upper]) expect(xmlOf((await loadDoc(ctx.db, c.id))!)).toContain(MARK);
    expect(await stateHasMark()).toBe(false); // 前提仍成立（只會由真變假——2 秒內完成，前例 groups-v2-revocation.test.ts:226-237）
    const Y = `Y-${randomUUID()}`;
    const ap = await call(ctx.app, token, "edit_note", { note_id: lower.id, op: "append", markdown: Y });
    expect(ap.isError).toBeUndefined();
    expect(docText(ctx.collab.hocuspocus.documents.get(src.id)!)).not.toContain(Y);
    client.disconnect();
  });

  it("C4 圖片：兩張自己的上傳＋一張引用別篇的 → 副本兩張新 uploads 列（屬副本、檔在磁碟），別篇那張網址不變", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const other = await seedNote(db, { ownerId: me.id }, { title: "Other" });
    const foreign = await seedAttachment(db, uploadsDir, other.id, me.id, 10);
    const src = await seedNote(db, { ownerId: me.id }, { title: "Pics" });
    const a = await seedAttachment(db, uploadsDir, src.id, me.id, 10);
    const b = await seedAttachment(db, uploadsDir, src.id, me.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${a}`, `/api/uploads/${b}`, `/api/uploads/${foreign}`]));
    const filesBefore = await filesIn(uploadsDir);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id });
    const mine = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, note.id));
    expect(mine).toHaveLength(2);
    const filesAfter = await filesIn(uploadsDir);
    for (const { id } of mine) expect(filesAfter).toContain(id);
    expect(filesAfter.length).toBe(filesBefore.length + 2);
    const xml = xmlOf((await loadDoc(db, note.id))!);
    for (const { id } of mine) expect(xml).toContain(`/api/uploads/${id}`);
    expect(xml).toContain(`/api/uploads/${foreign}`);
    expect(xml).not.toContain(`/api/uploads/${a}`);
  });

  it("C5 group_not_found：不存在、非成員、成員無 can_create 三形逐位元組相同且＝GROUP_NO_CREATE", async () => {
    const { app, db } = await buildTestApp();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const ro = await seedGroup(db, "ReadOnly", [{ userId: me.id, role: "member" }]);
    await setMemberRole(db, ro.id, me.id, await seedRole(db, ro.id, "Reader", { canRead: true }));
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);
    const bodies = [];
    for (const gid of [randomUUID(), foreign.id, ro.id]) {
      const r = await call(app, token, "copy_note", { note_id: src.id, group_id: gid });
      bodies.push(JSON.stringify(r.structuredContent));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ code: "group_not_found", message: GROUP_NO_CREATE });
    expect(await noteCount(db)).toBe(before);
  });

  it("C6 不帶過去：分享、公開連結、AI 編輯 → 副本 0 shares、public_token NULL、0 AI 紀錄、lastEdited null；來源的 AI 紀錄數不變", async () => {
    const { app, db } = await buildTestApp();
    const [me, friend] = await Promise.all([seedUser(db), seedUser(db)]);
    const src = await seedNote(db, { ownerId: me.id }, { publicToken: "q".repeat(43), publicSlug: "alias" });
    await seedShare(db, src.id, friend.id, "editor");
    await db.insert(noteAiEdits).values({ noteId: src.id, userId: me.id, op: "append" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id });
    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, note.id))).toEqual([]);
    const [row] = await db.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.publicToken).toBeNull();
    expect(row!.publicSlug).toBeNull();
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, src.id))).toHaveLength(1);
    expect(note.lastEdited).toBeNull();
  });

  describe("C7 配額四案（照 storage-copy-move.test.ts:29／:48／:61／:107）", () => {
    it("已滿個人空間預檢 → 可見全文（無 they need）＋extra 兩數、無新筆記、upload 桶未扣", async () => {
      const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
      const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
      const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
      await giveUserQuota(db, b.id, 100);
      const bn = await seedNote(db, { ownerId: b.id });
      await seedAttachment(db, uploadsDir, bn.id, b.id, 100);
      const src = await seedNote(db, { ownerId: a.id });
      const att = await seedAttachment(db, uploadsDir, src.id, a.id, 10);
      await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
      await seedShare(db, src.id, b.id, "viewer");
      const before = await noteCount(db);
      const { token } = await seedTokenForUser(db, b.id, RW);
      const r = await call(app, token, "copy_note", { note_id: src.id });
      expect(r.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: `Your storage space has no room for this note's images (100 B of 100 B used), so the note was not copied. ${TAIL}`,
        usedBytes: 100,
        quotaBytes: 100,
      });
      expect(await noteCount(db)).toBe(before);
      expect(upload.consume(b.id)).toBe(true);
    });

    it("未滿但放不下 → 交易內、含 incomingBytes、已複製檔清掉、無新筆記", async () => {
      const { app, db, uploadsDir } = await buildTestApp();
      const a = await seedUser(db);
      await giveUserQuota(db, a.id, 1000);
      const src = await seedNote(db, { ownerId: a.id });
      const ids = [await seedAttachment(db, uploadsDir, src.id, a.id, 300), await seedAttachment(db, uploadsDir, src.id, a.id, 400)];
      await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
      const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
      const { token } = await seedTokenForUser(db, a.id, RW);
      const r = await call(app, token, "copy_note", { note_id: src.id });
      expect(r.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: `Your storage space has no room for this note's images (700 B of 1000 B used; they need 700 B), so the note was not copied. ${TAIL}`,
        usedBytes: 700,
        quotaBytes: 1000,
        incomingBytes: 700,
      });
      expect(await noteCount(db)).toBe(before);
      expect(await filesIn(uploadsDir)).toEqual(files);
    });

    it("已滿群組：manageGroup 成員 → 帶數字與 extra；一般成員 → 不帶數字、無 extra", async () => {
      const { app, db, uploadsDir } = await buildTestApp();
      const [gAdmin, gMember] = await Promise.all([seedUser(db), seedUser(db)]);
      const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
      await giveGroupQuota(db, g.id, 50);
      const gn = await seedNote(db, { groupId: g.id });
      await seedAttachment(db, uploadsDir, gn.id, gAdmin.id, 50);
      const mk = async (uid: string) => {
        const n = await seedNote(db, { ownerId: uid });
        const att = await seedAttachment(db, uploadsDir, n.id, uid, 10);
        await seedDoc(db, n.id, imageDoc([`/api/uploads/${att}`]));
        return n.id;
      };
      const [s1, s2] = [await mk(gAdmin.id), await mk(gMember.id)];
      const r1 = await call(app, (await seedTokenForUser(db, gAdmin.id, RW)).token, "copy_note", { note_id: s1, group_id: g.id });
      expect(r1.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: `The group's storage space has no room for this note's images (50 B of 50 B used), so the note was not copied. ${TAIL}`,
        usedBytes: 50,
        quotaBytes: 50,
      });
      const r2 = await call(app, (await seedTokenForUser(db, gMember.id, RW)).token, "copy_note", { note_id: s2, group_id: g.id });
      expect(r2.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: "The group's storage space has no room for this note's images, so the note was not copied. Ask a site admin for more space.",
      });
    });

    it("無附件的複製到已滿（配額 0）的空間 → 成功", async () => {
      const { app, db } = await buildTestApp();
      const z = await seedUser(db);
      await giveUserQuota(db, z.id, 0);
      const plain = await seedNote(db, { ownerId: z.id }, { title: "Plain" });
      const { token } = await seedTokenForUser(db, z.id, RW);
      expect((await copied(app, token, { note_id: plain.id })).title).toBe("Plain");
    });
  });

  it("C8 upload 桶不足（limit 1、已用 1；來源兩張圖）→ COPY_UPLOAD_LIMIT、無新筆記、磁碟無新檔", async () => {
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const ids = [await seedAttachment(db, uploadsDir, src.id, me.id, 10), await seedAttachment(db, uploadsDir, src.id, me.id, 10)];
    await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
    expect(upload.consume(me.id)).toBe(true); // ⚠ 必須先用掉：consumeMany 夾在整窗額度（n>limit 時空窗放行，rate-limit.ts:119-127）
    const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
    const { token } = await seedTokenForUser(db, me.id, RW);
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: UPLOAD_LIMIT_MSG });
    expect(await noteCount(db)).toBe(before);
    expect(await filesIn(uploadsDir)).toEqual(files);
  });

  it("C9 edit 桶已用盡 → WRITE_RATE；tokenWrite 已用盡 → TOKEN_RATE", async () => {
    const edit = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, tokenWrite }) });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RW);
    expect(edit.consume(me.id)).toBe(true);
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: WRITE_RATE });
    // tokenWrite 已被上一發扣掉 1（requireWriteScope 在 edit 之前）
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: TOKEN_RATE });
  });

  for (const code of ["55P03", "40P01", "40001"]) {
    it(`C10 server_busy（storage-space-locked 縫拋 ${code}）→ COPY_BUSY、無新筆記、已複製檔清掉`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const me = await seedUser(db);
      const src = await seedNote(db, { ownerId: me.id });
      const ids = [await seedAttachment(db, uploadsDir, src.id, me.id, 10), await seedAttachment(db, uploadsDir, src.id, me.id, 20)];
      await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
      const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
      const { token } = await seedTokenForUser(db, me.id, RW);
      expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "server_busy", message: BUSY });
      expect(await noteCount(db)).toBe(before);
      expect(await filesIn(uploadsDir)).toEqual(files);
    });
  }

  it("C11 無 collab 的 app：copy_note 有註冊且成功（讀 note_states）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id }, { title: "Stored" });
    const MARK = `stored-${randomUUID()}`;
    await seedDoc(db, src.id, searchDoc([{ id: "p", text: MARK }]));
    const { token } = await seedTokenForUser(db, me.id, RW);
    const names = ((await mcpPost(app, rpc("tools/list"), { token })).json().result.tools as { name: string }[]).map(t => t.name);
    expect(names).toContain("copy_note");
    const note = await copied(app, token, { note_id: src.id });
    expect(xmlOf((await loadDoc(db, note.id))!)).toContain(MARK);
  });

  it("C12 全文索引：以來源內文的獨特字串 search_notes → 副本命中且 matchedOn body", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id }, { title: "Indexed" });
    const word = `zq${randomUUID().slice(0, 8)}`;
    await seedDoc(db, src.id, searchDoc([{ id: "p", text: `body ${word} text` }]));
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id });
    const hits = (await call(app, token, "search_notes", { query: word })).structuredContent!.notes as Array<{ id: string; matchedOn: string }>;
    expect(hits.find(h => h.id === note.id)?.matchedOn).toBe("body");
  });

  it("M-G2-copy 用舊鍵 groupId（來源帶附件）→ 先斷零新增筆記與磁碟無新檔，再斷 SDK 驗證錯誤（無 code、訊息含 groupId）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: me.id });
    const att = await seedAttachment(db, uploadsDir, src.id, me.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
    const { token } = await seedTokenForUser(db, me.id, RW);
    const r = await call(app, token, "copy_note", { note_id: src.id, groupId: g.id });
    expect(await noteCount(db)).toBe(before);
    expect(await filesIn(uploadsDir)).toEqual(files);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0]!.text).toContain("groupId");
  });

  it("RF1-copy 大寫 group_id → 成功；owner.id、url、DB group_id 都是小寫", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id.toUpperCase() });
    expect(note.owner).toMatchObject({ kind: "group", id: g.id });
    expect(note.url.startsWith(`/g/${g.id}/`)).toBe(true);
    const [row] = await db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, note.id));
    expect(row!.groupId).toBe(g.id);
  });

  it("RF3 同群組內複製：群組筆記 → 同群組 → 新群組筆記、slug 去重 -2、原篇不動", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const src = await seedNote(db, { groupId: g.id }, { title: "Plan", slug: "plan" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id });
    expect(note.slug).toBe("plan-2");
    expect(note.url).toBe(`/g/${g.id}/plan-2`);
    expect(note.role).toBe("editor");
    const [orig] = await db.select().from(notes).where(eq(notes.id, src.id));
    expect(orig).toMatchObject({ slug: "plan", groupId: g.id, title: "Plan" });
  });

  it("C13 模型面字串 wire 斷言（spec §6.6 全部）", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const res = await mcpPost(app, rpc("tools/list"), { token });
    const tool = (res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> }; outputSchema: { properties: Record<string, { description?: string }> } }>).find(t => t.name === "copy_note")!;
    const DESC =
      "Copy a note you can read into a new note — yours, or in one of your groups when you pass `group_id`. The copy gets the note's " +
      "title and its current content, and usually its own copies of the images uploaded to that note; from then on the two notes change " +
      "separately. Per-person shares, the public link and the edit history are not copied, and making the copy isn't recorded in any " +
      "note's history. The reply is the new note in the shape list_notes returns; in a group, its `role` can be `viewer`.";
    const GID =
      "The id of one of your groups where your role lets you create notes; the copy then belongs to the group. Leave it out to copy " +
      "into your personal notes. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";
    const NID = "The note's id, as returned by list_notes or search_notes.";
    const OUT = "The new copy, in the same shape list_notes returns.";
    expect(tool.description).toBe(DESC);
    expect(tool.inputSchema.properties.group_id!.description).toBe(GID);
    expect(tool.inputSchema.properties.note_id!.description).toBe(NID);
    expect(tool.outputSchema.properties.note!.description).toBe(OUT);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["group_id", "note_id"]);
    for (const s of [DESC, GID, OUT]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
  });
});
