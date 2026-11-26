/** Cases without collab use `buildTestApp` (it returns `uploadsDir`, so disk files can be counted); the live-doc case needs `buildCollabTestApp`. Model-facing strings are written as literals. */
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
import { COPY_NEEDS_MOVE_MESSAGE } from "../src/mcp/tools/copy-note.js";

const RW = "notes:read notes:write" as const;
/** #239: copy_note with `group_id` (success or failure) needs notes:move, so these tests use a read-write-move token; expected values are unchanged. */
const RWM = "notes:read notes:write notes:move" as const;
const GROUP_NO_CREATE = "No group with that id among your groups where your role can create notes.";
const WRITE_RATE = "Too many note writes right now. Wait a moment before writing again.";
const TOKEN_RATE = "Too many writes with this credential right now. Wait a few minutes before writing again.";
// #397: the message names the current limit of the limiter that blocked the request; the upload limiter injected in its test has limit 1.
const UPLOAD_LIMIT_MSG =
  "Copying this note's images would go over your upload limit (1 files per 10 minutes, copies included), so nothing was copied. Wait a few minutes and try again.";
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
  it("personal: a viewer share copies someone else's note -> owner = caller, role owner, same title as the source, url the same text as list_notes", async () => {
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

  it("group: a create-only role copies into the group -> role viewer, owner is the group", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(db, g.id, me.id, await seedRole(db, g.id, "Creator", { canRead: true, canCreate: true }));
    const src = await seedNote(db, { ownerId: me.id }, { title: "Mine" });
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id });
    expect(note.role).toBe("viewer");
    expect(note.owner).toEqual({ kind: "group", id: g.id, name: "Team" });
  });

  it("content: live doc newer than note_states - copying with lowercase and uppercase note_id once each, both copies contain MARK; editing the copy afterwards leaves the source unchanged", async () => {
    const PASSWORD = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const email = `c3-${randomUUID()}@example.com`;
    const u = await ctx.createUser({ email, password: PASSWORD });
    const src = await ctx.createNote(u.id, "Live source");
    const session = await ctx.loginAs(email, PASSWORD);
    const MARK = `MARK-${randomUUID()}`;
    const client = await seedContent(ctx, session, src.id, `# Head\n\n${MARK}`); // keep the connection: within onStoreDocument's 2-second debounce note_states doesn't have MARK yet
    const stateHasMark = async () => { const d = await loadDoc(ctx.db, src.id); return d !== null && xmlOf(d).includes(MARK); };
    expect(await stateHasMark()).toBe(false); // precondition
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const lower = await copied(ctx.app, token, { note_id: src.id });
    const upper = await copied(ctx.app, token, { note_id: src.id.toUpperCase() });
    for (const c of [lower, upper]) expect(xmlOf((await loadDoc(ctx.db, c.id))!)).toContain(MARK);
    expect(await stateHasMark()).toBe(false); // precondition still holds: note_states can only gain MARK once the 2-second store debounce fires, and the copies finish before that
    const Y = `Y-${randomUUID()}`;
    const ap = await call(ctx.app, token, "edit_note", { note_id: lower.id, op: "append", markdown: Y });
    expect(ap.isError).toBeUndefined();
    expect(docText(ctx.collab.hocuspocus.documents.get(src.id)!)).not.toContain(Y);
    client.disconnect();
  });

  it("images: two own uploads + one referencing another note -> the copy gets two new uploads rows (belonging to the copy, files on disk), the other note's URL is unchanged", async () => {
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

  it("group_not_found: nonexistent, non-member and member without can_create are byte-identical and equal GROUP_NO_CREATE", async () => {
    const { app, db } = await buildTestApp();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const ro = await seedGroup(db, "ReadOnly", [{ userId: me.id, role: "member" }]);
    await setMemberRole(db, ro.id, me.id, await seedRole(db, ro.id, "Reader", { canRead: true }));
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RWM);
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

  it("not carried over: shares, public link, AI edits -> copy has 0 shares, public_token NULL, 0 AI records, lastEdited null; the source's AI record count is unchanged", async () => {
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

  describe("quota (four cases, mirroring storage-copy-move.test.ts)", () => {
    it("full personal space pre-check -> full text visible (no \"they need\") + two extra numbers, no new note, upload limiter not charged", async () => {
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

    it("not full but the attachments' total doesn't fit -> lock-free refusal before any file is written, includes incomingBytes, no new file, no new note", async () => {
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

    it("room taken after the lock-free check (another attachment lands while the files are being copied) -> the in-transaction refusal, includes incomingBytes = bytes copied, temp files cleaned up, no new note", async () => {
      const holder: { db?: Db; uploadsDir?: string; noteId?: string; userId?: string; done?: boolean } = {};
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => {
          if (point !== "note-copy-files-copied" || holder.done) return;
          holder.done = true;
          await seedAttachment(holder.db!, holder.uploadsDir!, holder.noteId!, holder.userId!, 500, { noFile: true });
        },
      });
      const a = await seedUser(db);
      await giveUserQuota(db, a.id, 1000);
      const other = await seedNote(db, { ownerId: a.id });
      Object.assign(holder, { db, uploadsDir, noteId: other.id, userId: a.id });
      const src = await seedNote(db, { ownerId: a.id });
      const ids = [await seedAttachment(db, uploadsDir, src.id, a.id, 100), await seedAttachment(db, uploadsDir, src.id, a.id, 200)];
      await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
      const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
      const { token } = await seedTokenForUser(db, a.id, RW);
      const r = await call(app, token, "copy_note", { note_id: src.id });
      expect(holder.done).toBe(true);
      expect(r.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: `Your storage space has no room for this note's images (800 B of 1000 B used; they need 300 B), so the note was not copied. ${TAIL}`,
        usedBytes: 800,
        quotaBytes: 1000,
        incomingBytes: 300,
      });
      expect(await noteCount(db)).toBe(before);
      expect(await filesIn(uploadsDir)).toEqual(files);
    });

    it("full group: manageGroup member -> numbers and extra; plain member -> no numbers, no extra", async () => {
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
      const r1 = await call(app, (await seedTokenForUser(db, gAdmin.id, RWM)).token, "copy_note", { note_id: s1, group_id: g.id });
      expect(r1.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: `The group's storage space has no room for this note's images (50 B of 50 B used), so the note was not copied. ${TAIL}`,
        usedBytes: 50,
        quotaBytes: 50,
      });
      const r2 = await call(app, (await seedTokenForUser(db, gMember.id, RWM)).token, "copy_note", { note_id: s2, group_id: g.id });
      expect(r2.structuredContent).toEqual({
        code: "storage_quota_exceeded",
        message: "The group's storage space has no room for this note's images, so the note was not copied. Ask a site admin for more space.",
      });
    });

    it("copy without attachments into a full (quota 0) space -> succeeds", async () => {
      const { app, db } = await buildTestApp();
      const z = await seedUser(db);
      await giveUserQuota(db, z.id, 0);
      const plain = await seedNote(db, { ownerId: z.id }, { title: "Plain" });
      const { token } = await seedTokenForUser(db, z.id, RW);
      expect((await copied(app, token, { note_id: plain.id })).title).toBe("Plain");
    });
  });

  it("upload limiter short (limit 1, 1 used; the source has two images) -> COPY_UPLOAD_LIMIT, no new note, no new file on disk", async () => {
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const ids = [await seedAttachment(db, uploadsDir, src.id, me.id, 10), await seedAttachment(db, uploadsDir, src.id, me.id, 10)];
    await seedDoc(db, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
    expect(upload.consume(me.id)).toBe(true); // must be used up first: consumeMany clamps to the whole-window limit (an empty window lets n > limit through)
    const [before, files] = [await noteCount(db), await filesIn(uploadsDir)];
    const { token } = await seedTokenForUser(db, me.id, RW);
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: UPLOAD_LIMIT_MSG });
    expect(await noteCount(db)).toBe(before);
    expect(await filesIn(uploadsDir)).toEqual(files);
  });

  it("edit limiter used up -> WRITE_RATE; tokenWrite used up -> TOKEN_RATE", async () => {
    const edit = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit, tokenWrite }) });
    const me = await seedUser(db);
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RW);
    expect(edit.consume(me.id)).toBe(true);
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: WRITE_RATE });
    // tokenWrite was already charged 1 by the previous call (requireWriteScope runs before edit).
    expect((await call(app, token, "copy_note", { note_id: src.id })).structuredContent).toEqual({ code: "too_many_requests", message: TOKEN_RATE });
  });

  for (const code of ["55P03", "40P01", "40001"]) {
    it(`server_busy (storage-space-locked seam throws ${code}) -> COPY_BUSY, no new note, copied files cleaned up`, async () => {
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

  it("app without collab: copy_note is registered and succeeds (reads note_states)", async () => {
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

  it("full-text index: search_notes with a distinctive string from the source body -> the copy matches with matchedOn body", async () => {
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

  it("old key groupId (source with attachments) -> first assert zero new notes and no new file on disk, then the SDK validation error (no code, message contains groupId)", async () => {
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

  it("uppercase group_id -> succeeds; owner.id, url and DB group_id are all lowercase", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id.toUpperCase() });
    expect(note.owner).toMatchObject({ kind: "group", id: g.id });
    expect(note.url.startsWith(`/g/${g.id}/`)).toBe(true);
    const [row] = await db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, note.id));
    expect(row!.groupId).toBe(g.id);
  });

  it("copy within the same group: group note -> same group -> new group note, slug deduplicated -2, original untouched", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "member" }]);
    const src = await seedNote(db, { groupId: g.id }, { title: "Plan", slug: "plan" });
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const note = await copied(app, token, { note_id: src.id, group_id: g.id });
    expect(note.slug).toBe("plan-2");
    expect(note.url).toBe(`/g/${g.id}/plan-2`);
    expect(note.role).toBe("editor");
    const [orig] = await db.select().from(notes).where(eq(notes.id, src.id));
    expect(orig).toMatchObject({ slug: "plan", groupId: g.id, title: "Plan" });
  });

  // This variant of the text only appears with canMove, so this test uses a read-write-move token; the read-write variants are pinned by mcp-tools-list.
  it("model-facing strings asserted on the wire (all)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const { token } = await seedTokenForUser(db, me.id, RWM);
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
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["folder_id", "group_id", "note_id"]); // folders: one more key, folder_id
    for (const s of [DESC, GID, OUT]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
  });

  // copy_note with group_id has its move check **reachable** over HTTP (copy_note is on the read-write token's list). The check runs before copyNote => nothing is created
  // and tokenWrite isn't charged; it also runs before the note lookup => a nonexistent note_id gets insufficient_scope first.
  it("read-write token with group_id -> insufficient_scope, message verbatim, nothing created, tokenWrite not charged", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }); // injected like the tokenWrite limiter in the rate-limit test above
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenWrite }) });
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "admin" }]);
    const src = await seedNote(db, { ownerId: me.id }, { title: "Mine" });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const before = await noteCount(db);
    const r = await call(app, token, "copy_note", { note_id: src.id, group_id: g.id });
    expect(r.structuredContent).toEqual({ code: "insufficient_scope", message: COPY_NEEDS_MOVE_MESSAGE });
    expect(await noteCount(db)).toBe(before);
    // The single tokenWrite slot is still free: a copy without group_id succeeds.
    await copied(app, token, { note_id: src.id });
  });

  // Guards against looking up the note before the scope check and returning not_found early. The opposite regression (check moved after copyNote) is caught by the previous test's row count.
  it("a nonexistent note_id with group_id also gets insufficient_scope (the check is before the note lookup)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: me.id, role: "admin" }]);
    const { token } = await seedTokenForUser(db, me.id, RW);
    const r = await call(app, token, "copy_note", { note_id: randomUUID(), group_id: g.id });
    expect(r.structuredContent).toEqual({ code: "insufficient_scope", message: COPY_NEEDS_MOVE_MESSAGE });
  });
});
