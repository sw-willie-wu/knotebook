/** Assertions that read the live doc (read_note_outline, edit_note, the byte comparison, version history) use the collab app; the rest use buildTestApp. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { groups, noteAiEdits, noteRedirects, notes } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sharesOf, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAttachment, giveGroupQuota } from "./storage-helpers.js";
import { seedDoc } from "./copy-helpers.js";
import { NO_PENDING, noteBase, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

/** #239: move_note_to_group registers only with notes:move, so every call to it in this file (success or failure) uses a read-write-move token; expected values unchanged. */
const RWM = "notes:read notes:write notes:move" as const;
/** Read-write token without move: move_note_to_group isn't on its tool list. */
const RW = "notes:read notes:write" as const;
const FORBIDDEN_MOVE = "Only the owner of a personal note can move it into a group; this note is someone else's, or it is already in a group.";
const GROUP_NO_CREATE = "No group with that id among your groups where your role can create notes.";
const CREATE_GROUP_NOT_FOUND = "No group with that id among the groups you belong to.";
const CONFLICT = "This note stopped being your personal note after your access was checked, so it was not moved.";
const BUSY = "The server was busy, so the note was not moved. Try again in a moment.";
const TOKEN_RATE = "Too many writes with this credential right now. Wait a few minutes before writing again.";
const EDIT_FORBIDDEN = "You can read this note but not change it. Ask whoever manages your access to it for editing rights.";
const TAIL = "A site admin can assign a larger storage plan; deleting notes that have files also frees space.";

type Result = { isError?: true; content: { text: string }[]; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };
type Note = { id: string; slug: string; url: string; role: string; owner: { kind: string; id?: string; name?: string } };

async function call(app: FastifyInstance, auth: { token?: string; cookie?: string }, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
const move = (app: FastifyInstance, token: string, noteId: string, groupId: string) =>
  call(app, { token }, "move_note_to_group", { note_id: noteId, group_id: groupId });
async function moved(app: FastifyInstance, token: string, noteId: string, groupId: string): Promise<Note> {
  const r = await move(app, token, noteId, groupId);
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent!.note as Note;
}
const redirectCount = async (db: Db) => (await db.select().from(noteRedirects)).length;

describe("#180 move_note_to_group", () => {
  it("happy path: shares / public link cleared, AI records kept, updated_at unchanged, the old /n/ redirects to it for a month, the former share recipients get not_found", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, friend] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db)]);
    const g = await seedGroup(ctx.db, "Team", [{ userId: owner.id, role: "member" }]);
    const token43 = "m".repeat(43);
    const n = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Mine", slug: "mine", publicToken: token43, publicSlug: "alias" });
    await seedShare(ctx.db, n.id, friend.id, "editor");
    await ctx.db.insert(noteAiEdits).values({ noteId: n.id, userId: owner.id, op: "append" });
    const before = await noteState(ctx.db.$client, n.id);
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWM);

    const note = await moved(ctx.app, token, n.id, g.id);

    expect(note.owner).toEqual({ kind: "group", id: g.id, name: "Team" });
    expect(note.url).toBe(`/g/${g.id}/${note.slug}`);
    expect(note.role).toBe("editor");
    const after = await noteState(ctx.db.$client, n.id);
    expect(after).toMatchObject({ owner_id: null, group_id: g.id, public_token: null, public_slug: null, updated_at: before.updated_at });
    expect(await sharesOf(ctx.db, n.id)).toEqual([]);
    expect(await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id))).toHaveLength(1);
    const old = await ctx.app.inject({ method: "GET", url: `/api/notes/by-path/${owner.handle}/mine`, cookies: await cookieOf(owner.id) });
    expect(old.statusCode).toBe(200);
    expect(old.json().id).toBe(n.id);
    const { rows } = await ctx.db.$client.query(
      `select expires_at > now() + interval '27 days' and expires_at < now() + interval '32 days' as ok from note_redirects where note_id = $1`, [n.id],
    );
    expect(rows).toEqual([{ ok: true }]);
    expect((await ctx.app.inject({ method: "GET", url: `/api/public/notes/${token43}` })).statusCode).toBe(404);
    const ft = (await seedTokenForUser(ctx.db, friend.id, RWM)).token;
    expect((await call(ctx.app, { token: ft }, "read_note_outline", { note_id: n.id })).structuredContent!.code).toBe("not_found");
  });

  it("create-only role moving in -> role viewer; then edit_note -> forbidden", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "Team", [{ userId: me.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, me.id, await seedRole(ctx.db, g.id, "Creator", { canRead: true, canCreate: true }));
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const { token } = await seedTokenForUser(ctx.db, me.id, RWM);
    expect((await moved(ctx.app, token, n.id, g.id)).role).toBe("viewer");
    expect((await call(ctx.app, { token }, "edit_note", { note_id: n.id, op: "append", markdown: "x" })).structuredContent).toEqual({ code: "forbidden", message: EDIT_FORBIDDEN });
  });

  it("revocation: rejected calls (group_not_found, forbidden, quota, server_busy) trigger it zero times; success exactly once (share recipients + caller); an uppercase note_id gets the lowercase id", async () => {
    const spy = spyCollabHooks();
    const busy = { on: false };
    const { app, db, uploadsDir } = await buildTestApp({
      collabHooks: spy,
      groupTestHook: async point => { if (busy.on && point === "storage-space-locked") throw Object.assign(new Error("55P03"), { code: "55P03" }); },
    });
    const [owner, friend] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "Team", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, friend.id, "viewer");
    const { token } = await seedTokenForUser(db, owner.id, RWM);
    expect((await move(app, token, n.id, randomUUID())).structuredContent!.code).toBe("group_not_found");
    const ft = (await seedTokenForUser(db, friend.id, RWM)).token;
    expect((await move(app, ft, n.id, g.id)).structuredContent!.code).toBe("forbidden");
    // Quota rejection: another group with a quota of 10, and a note with an 11 B attachment.
    const full = await seedGroup(db, "Full", [{ userId: owner.id, role: "member" }]);
    await giveGroupQuota(db, full.id, 10);
    const heavy = await seedNote(db, { ownerId: owner.id });
    await seedAttachment(db, uploadsDir, heavy.id, owner.id, 11);
    expect((await move(app, token, heavy.id, full.id)).structuredContent!.code).toBe("storage_quota_exceeded");
    // server_busy: the space-lock seam throws 55P03 (the space lock is only taken when there are attachments).
    busy.on = true;
    expect((await move(app, token, heavy.id, g.id)).structuredContent!.code).toBe("server_busy");
    busy.on = false;
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(0);
    await moved(app, token, n.id, g.id);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [ids, users] = spy.onGroupAccessChanged.mock.calls[0]!;
    expect(ids).toEqual([n.id]);
    expect([...users].sort()).toEqual([friend.id, owner.id].sort());
    const n2 = await seedNote(db, { ownerId: owner.id });
    await moved(app, token, n2.id.toUpperCase(), g.id);
    expect(spy.onGroupAccessChanged.mock.calls[1]![0]).toEqual([n2.id]);
  });

  it("forbidden in three shapes (shared editor, shared viewer, group note admin) is byte-identical; a stranger and a nonexistent note -> not_found with the same words as read_note_outline", async () => {
    const ctx = await buildCollabTestApp();
    const [owner, ed, vw, stranger] = await Promise.all([seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db), seedUser(ctx.db)]);
    const g = await seedGroup(ctx.db, "Team", [{ userId: ed.id, role: "admin" }, { userId: vw.id, role: "member" }]);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    await seedShare(ctx.db, n.id, ed.id, "editor");
    await seedShare(ctx.db, n.id, vw.id, "viewer");
    const gn = await seedNote(ctx.db, { groupId: g.id });
    const edT = (await seedTokenForUser(ctx.db, ed.id, RWM)).token;
    const vwT = (await seedTokenForUser(ctx.db, vw.id, RWM)).token;
    const bodies = [
      JSON.stringify((await move(ctx.app, edT, n.id, g.id)).structuredContent),
      JSON.stringify((await move(ctx.app, vwT, n.id, g.id)).structuredContent),
      JSON.stringify((await move(ctx.app, edT, gn.id, g.id)).structuredContent),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ code: "forbidden", message: FORBIDDEN_MOVE });
    const st = (await seedTokenForUser(ctx.db, stranger.id, RWM)).token;
    const outline = JSON.stringify((await call(ctx.app, { token: st }, "read_note_outline", { note_id: n.id })).structuredContent);
    expect(JSON.stringify((await move(ctx.app, st, n.id, g.id)).structuredContent)).toBe(outline);
    expect(JSON.stringify((await move(ctx.app, st, randomUUID(), g.id)).structuredContent)).toBe(outline);
  });

  it("group_not_found in three shapes (nonexistent, non-member, member without can_create) is byte-identical and equals GROUP_NO_CREATE, which differs from create_note's; non-uuid -> SDK validation shape; note unchanged", async () => {
    const { app, db } = await buildTestApp();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const ro = await seedGroup(db, "ReadOnly", [{ userId: me.id, role: "member" }]);
    await setMemberRole(db, ro.id, me.id, await seedRole(db, ro.id, "Reader", { canRead: true }));
    const n = await seedNote(db, { ownerId: me.id });
    const before = await noteState(db.$client, n.id);
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const bodies = [];
    for (const gid of [randomUUID(), foreign.id, ro.id]) bodies.push(JSON.stringify((await move(app, token, n.id, gid)).structuredContent));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ code: "group_not_found", message: GROUP_NO_CREATE });
    expect(GROUP_NO_CREATE).not.toBe(CREATE_GROUP_NOT_FOUND);
    const bad = await move(app, token, n.id, "not-a-uuid");
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    expect(await noteState(db.$client, n.id)).toEqual(before);
  });

  it("quota: manageGroup member -> numbers and three extra figures; plain member -> none; note / shares / redirects / slug all unchanged", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [admin, member, friend] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 100);
    const a = await seedNote(db, { ownerId: admin.id }, { slug: "keep" });
    await seedAttachment(db, uploadsDir, a.id, admin.id, 101);
    await seedShare(db, a.id, friend.id, "editor");
    const before = await noteState(db.$client, a.id);
    const r1 = await move(app, (await seedTokenForUser(db, admin.id, RWM)).token, a.id, g.id);
    expect(r1.structuredContent).toEqual({
      code: "storage_quota_exceeded",
      message: `The group's storage space has no room for this note's files (0 B of 100 B used; they need 101 B), so the note was not moved. ${TAIL}`,
      usedBytes: 0,
      quotaBytes: 100,
      incomingBytes: 101,
    });
    expect(await noteState(db.$client, a.id)).toEqual(before);
    expect(await sharesOf(db, a.id)).toEqual([{ userId: friend.id, role: "editor" }]);
    expect(await redirectCount(db)).toBe(0);
    const m = await seedNote(db, { ownerId: member.id });
    await seedAttachment(db, uploadsDir, m.id, member.id, 101);
    const r2 = await move(app, (await seedTokenForUser(db, member.id, RWM)).token, m.id, g.id);
    expect(r2.structuredContent).toEqual({
      code: "storage_quota_exceeded",
      message: "The group's storage space has no room for this note's files, so the note was not moved. Ask a site admin for more space.",
    });
  });

  it("conflict: while a REST move holds FOR UPDATE (note-move-locked), the MCP move to another group blocks -> conflict, the note stays in the first group", async () => {
    type RaceState = { fire?: () => Promise<Result>; second?: Promise<Result>; interleave?: string };
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const hook = async (p: GroupRacePoint) => {
      if (p !== "note-move-locked" || !state.fire || state.second) return;
      state.second = state.fire();
      state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
    };
    const spy = spyCollabHooks();
    const built = await buildTestApp({ groupTestHook: hook, collabHooks: spy });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const owner = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: owner.id, role: "member" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    const { token } = await seedTokenForUser(db, owner.id, RWM);
    state.fire = () => move(app, token, n.id, g2.id);
    const first: LightMyRequestResponse = await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(owner.id), payload: { groupId: g1.id } });
    const second = await state.second!;
    expect(state.interleave).toBe("blocked");
    expect(first.statusCode).toBe(200);
    expect(second.structuredContent).toEqual({ code: "conflict", message: CONFLICT });
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g1.id });
    // The conflict half of the revocation rule (rejected cases revoke zero times): only the REST move that succeeded revokes; the rejected MCP call doesn't.
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
  });

  for (const code of ["55P03", "40P01", "40001"]) {
    it(`server_busy (storage-space-locked seam throws ${code}) -> MOVE_BUSY, note unchanged`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const o = await seedUser(db);
      const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
      const n = await seedNote(db, { ownerId: o.id });
      await seedAttachment(db, uploadsDir, n.id, o.id, 10); // the space lock is only taken when incomingBytes > 0 (storage/tx/quota.ts)
      const before = await noteState(db.$client, n.id);
      expect((await move(app, (await seedTokenForUser(db, o.id, RWM)).token, n.id, g.id)).structuredContent).toEqual({ code: "server_busy", message: BUSY });
      expect(await noteState(db.$client, n.id)).toEqual(before);
    });
  }

  it("tokenWrite limit 1: one create_note uses it up first -> move too_many_requests, note unchanged; move doesn't charge the edit limiter (the edit remainder is the same before and after)", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenWrite, edit }) });
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: me.id });
    const before = await noteState(db.$client, n.id);
    const { token } = await seedTokenForUser(db, me.id, RWM);
    expect((await call(app, { token }, "create_note", {})).isError).toBeUndefined(); // without content: charges only tokenWrite, not edit
    expect((await move(app, token, n.id, g.id)).structuredContent).toEqual({ code: "too_many_requests", message: TOKEN_RATE });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    // The edit half: the session path doesn't charge tokenWrite, so after moving one note the edit limiter is still full.
    const cookie = Object.values(await cookieOf(me.id))[0]!;
    expect((await call(app, { cookie }, "move_note_to_group", { note_id: n.id, group_id: g.id })).isError).toBeUndefined();
    let left = 0;
    while (edit.consume(me.id)) left += 1;
    expect(left).toBe(EDIT_LIMIT.limit);
  });

  it("session MCP move succeeds", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: me.id });
    const cookie = Object.values(await cookieOf(me.id))[0]!;
    const r = await call(app, { cookie }, "move_note_to_group", { note_id: n.id, group_id: g.id });
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent!.note as Note).owner).toMatchObject({ kind: "group", id: g.id });
  });

  // #239: a read-write token without move has no move_note_to_group on its list (register.ts registers by canMove); calling it directly, skipping the list, gets the SDK's
  // unknown-tool form (like edit_note in mcp-tools-list), not insufficient_scope; the note stays personal.
  it("#239: read-write token tools/call move_note_to_group -> Tool not found, the note stays personal", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: me.id });
    const { token } = await seedTokenForUser(db, me.id, RW);
    const r = await move(app, token, n.id, g.id);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Tool move_note_to_group not found");
    expect(r.structuredContent).toBeUndefined();
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: me.id, group_id: null });
  });

  it("model-facing strings asserted on the wire (all)", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const res = await mcpPost(app, rpc("tools/list"), { token });
    const tool = (res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> }; outputSchema: { properties: Record<string, { description?: string }> } }>).find(t => t.name === "move_note_to_group")!;
    const DESC =
      "Move one of your own personal notes into one of your groups, where the group's roles then decide who can read and change it. " +
      "A single note can't be taken out of a group again, here or in the web app — copy_note can copy it out instead. Moving removes the " +
      "note's per-person shares and its public link, and gives it the group's URL (the old one forwards to it for a month); it also removes " +
      "the note's version history and comments unless you pass keep_history: true, which brings both along: the group's editors then see the " +
      "earlier versions and who edited them, and everyone in the group sees the comments. Your own access becomes what your group role allows, which can be read-only — see the reply's `role`.";
    const GID = "The id of one of your groups where your role lets you create notes. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes.";
    const OUT = "The note after the move, in the same shape list_notes returns.";
    const KEEP = "Set true to bring the note's version history and comments along. Leave it out or set false and both are removed and can't be restored. Kept versions keep their names and still list who edited each one (handle, avatar, agent label); the group's editors can see that list, and it can name people who are not in the group.";
    expect(tool.description).toBe(DESC);
    expect(tool.inputSchema.properties.group_id!.description).toBe(GID);
    expect(tool.inputSchema.properties.note_id!.description).toBe("The note's id, as returned by list_notes or search_notes.");
    expect(tool.outputSchema.properties.note!.description).toBe(OUT);
    expect(tool.inputSchema.properties.keep_history!.description).toBe(KEEP);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["folder_id", "group_id", "keep_history", "note_id"]);
    for (const s of [DESC, GID, OUT, KEEP]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
  });

  it("version history: save one version first -> MCP moves the loaded note -> note_versions cleared, count 0, base NULL; spaceKey g:<id>, autoEnabled recomputed from the group's switch", async () => {
    const PASSWORD = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const email = `v13-${randomUUID()}@example.com`;
    const u = await ctx.createUser({ email, password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs(email, PASSWORD);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "admin" }]);
    await ctx.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, g.id)); // personal default on, group off -> false after the recompute
    const client = await seedContent(ctx, session, note.id, "個人時期的內容");
    const live = ctx.collab.hocuspocus.documents.get(note.id)!;
    await ctx.collab.versions.cutIfDirty(note.id, live, { kind: "manual" });
    expect(await versionsOf(ctx.db, note.id)).toHaveLength(1);
    expect(ctx.collab.versions.debugState(note.id)!.autoEnabled).toBe(true);
    const { token } = await seedTokenForUser(ctx.db, u.id, RWM);
    await moved(ctx.app, token, note.id, g.id);
    expect(await versionsOf(ctx.db, note.id)).toEqual([]);
    expect(await noteBase(ctx.db, note.id)).toEqual({ counter: 0, baseSeq: null, baseFingerprint: null });
    await waitFor("狀態重建", 5_000, () => ctx.collab.versions.debugState(note.id)?.initialized === true && ctx.collab.versions.debugState(note.id)?.spaceKey === `g:${g.id}`);
    expect(ctx.collab.versions.debugState(note.id)!.autoEnabled).toBe(false);
    client.disconnect();
  });

  it("keep_history: true keeps versions, counter and base; false and omitted clear; pending is cleared in each case", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const { token } = await seedTokenForUser(db, me.id, RWM);
    const pending = { versionPendingAt: new Date("2026-10-14T00:00:00.000Z"), versionPendingEditors: [{ user_id: me.id, agent_label: null }], versionPendingRefFingerprint: "ref" };
    const seeded = async () => {
      const n = await seedNote(db, { ownerId: me.id });
      await seedDoc(db, n.id, paraDoc(["personal"]));
      const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies: await cookieOf(me.id), payload: {} });
      expect(r.statusCode).toBe(201);
      await db.update(notes).set(pending).where(eq(notes.id, n.id));
      return n.id;
    };
    const kept = await seeded();
    const r1 = await call(app, { token }, "move_note_to_group", { note_id: kept, group_id: g.id, keep_history: true });
    expect(r1.isError, JSON.stringify(r1.structuredContent)).toBeUndefined();
    expect(await versionsOf(db, kept)).toHaveLength(1);
    expect(await noteBase(db, kept)).toMatchObject({ counter: 1, baseSeq: 1 });
    expect(await pendingOf(db, kept)).toEqual(NO_PENDING);
    for (const args of [{ keep_history: false }, {}]) {
      const id = await seeded();
      const r = await call(app, { token }, "move_note_to_group", { note_id: id, group_id: g.id, ...args });
      expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
      expect(await versionsOf(db, id)).toEqual([]);
      expect(await noteBase(db, id)).toEqual({ counter: 0, baseSeq: null, baseFingerprint: null });
      expect(await pendingOf(db, id)).toEqual(NO_PENDING);
    }
  });

  it("{note_id, group_id, groupId} -> SDK validation error, note unchanged", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: me.id });
    const before = await noteState(db.$client, n.id);
    const r = await call(app, { token: (await seedTokenForUser(db, me.id, RWM)).token }, "move_note_to_group", { note_id: n.id, group_id: g.id, groupId: g.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0]!.text).toContain("groupId");
    expect(await noteState(db.$client, n.id)).toEqual(before);
  });

  it("uppercase group_id -> success; owner.id, url and DB group_id are lowercase", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: me.id });
    const note = await moved(app, (await seedTokenForUser(db, me.id, RWM)).token, n.id, g.id.toUpperCase());
    expect(note.owner).toMatchObject({ kind: "group", id: g.id });
    expect(note.url.startsWith(`/g/${g.id}/`)).toBe(true);
    expect((await noteState(db.$client, n.id)).group_id).toBe(g.id);
  });

  it("custom URL: slug_is_custom kept, the group url uses the same custom slug, the old /n/<handle>/<custom> redirects to it", async () => {
    const { app, db } = await buildTestApp();
    const me = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: me.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: me.id }, { slug: "my-custom", slugIsCustom: true });
    const note = await moved(app, (await seedTokenForUser(db, me.id, RWM)).token, n.id, g.id);
    expect(note.url).toBe(`/g/${g.id}/my-custom`);
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "my-custom", slug_is_custom: true });
    const old = await app.inject({ method: "GET", url: `/api/notes/by-path/${me.handle}/my-custom`, cookies: await cookieOf(me.id) });
    expect(old.statusCode).toBe(200);
    expect(old.json().id).toBe(n.id);
  });
});
