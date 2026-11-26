/**
 * The "someone online with unsaved edits" case over a real collab connection is at the end of `groups-v2-revocation.test.ts`.
 * The first transaction step takes KEY SHARE on the target groups and re-verifies membership: copy || removing a member in both orders, and same-group copy
 * || "groups FOR UPDATE -> that group's notes FOR UPDATE" (the delete-all shape) don't deadlock. The role/permissions of the 201 come from the flags read inside the transaction;
 * when a downgrade lands between the route check and that read, the downgraded value is returned.
 */
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteLinks, noteShares, notes, uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { purgeTrashedNotesInTx } from "../src/notes/tx/trash.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { imageDoc, loadDoc, seedDoc, seedUpload, wikilinkDoc, xmlOf } from "./copy-helpers.js";

const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };
const OWNER_PERMS = { read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true };
const EXTERNAL = "https://example.com/x.png";

const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

const noteCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>("select count(*)::int as n from notes")).rows[0]!.n;
const uploadCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>("select count(*)::int as n from uploads")).rows[0]!.n;
const filesIn = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();
const uploadsOf = (db: Db, noteId: string) =>
  db.select({ id: uploads.id, uploaderId: uploads.uploaderId, mime: uploads.mime, size: uploads.size }).from(uploads).where(eq(uploads.noteId, noteId));

describe("#175 POST /api/notes/:id/copy", () => {
  it("personal -> group: 201 group-shaped DTO; note_states version 1, XML differs only in the rewritten URLs; this site's attachments get new ids and new files, external images and other notes' attachments unchanged; AI log/shares/token/aliases/prev/legacy/last_edited not carried; copy's updated_at later than the source", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id }, {
      title: "Plan", slug: "plan", slugIsCustom: true, prevSlug: "old", legacySlug: "legacy-x", publicToken: "t".repeat(43), publicSlug: "alias",
    });
    const other = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, src.id, c.id, "editor");
    await db.insert(noteAiEdits).values({ noteId: src.id, userId: owner.id, op: "append" });
    await db.update(notes).set({ lastEditedAt: new Date(), lastEditedBy: owner.id }).where(eq(notes.id, src.id));
    const b1 = Buffer.from("bytes-of-u1"), b2 = Buffer.from("bytes-of-u2-longer");
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id, b1);
    const u2 = await seedUpload(db, uploadsDir, src.id, c.id, b2);
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`, `/api/uploads/${u2}`, EXTERNAL, `/api/uploads/${u3}`]));
    const srcXml = xmlOf((await loadDoc(db, src.id))!);
    const filesBefore = await filesIn(uploadsDir);
    const srcRowBefore = (await db.$client.query("select * from notes where id = $1", [src.id])).rows[0];

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      groupId: g.id, ownerId: null, ownerHandle: null, role: "editor", group: { id: g.id, name: "G" }, permissions: MEMBER_PERMS,
      lastEdited: null, prevSlug: null, title: "Plan", slugIsCustom: false,
    });
    expect(body.id).not.toBe(src.id);
    const copyId = body.id as string;

    // The copy's attachments: exactly two rows (one each for u1 and u2: u1 referenced twice is still one copy), uploader = caller, mime/size same as the source, new file bytes same as the source.
    const rows = await uploadsOf(db, copyId);
    expect(rows).toHaveLength(2);
    const bySize = new Map(rows.map(r => [r.size, r]));
    const n1 = bySize.get(b1.length)!, n2 = bySize.get(b2.length)!;
    for (const r of [n1, n2]) expect(r).toMatchObject({ uploaderId: owner.id, mime: "image/png" });
    expect(await readFile(uploadFilePath(uploadsDir, n1.id))).toEqual(b1);
    expect(await readFile(uploadFilePath(uploadsDir, n2.id))).toEqual(b2);
    expect(await filesIn(uploadsDir)).toEqual([...filesBefore, n1.id, n2.id].sort());

    // Copy XML: with new ids swapped back to old ids it is verbatim equal to the source (u3, another note's attachment, and the external URL unchanged); version 1.
    const copyXml = xmlOf((await loadDoc(db, copyId))!);
    expect(copyXml.split(`/api/uploads/${n1.id}`).length - 1).toBe(2);
    expect(copyXml).toContain(`/api/uploads/${u3}`);
    expect(copyXml).toContain(EXTERNAL);
    expect(copyXml.replaceAll(n1.id, u1).replaceAll(n2.id, u2)).toBe(srcXml);
    expect((await db.$client.query("select version from note_states where note_id = $1", [copyId])).rows).toEqual([{ version: 1 }]);

    expect((await db.$client.query("select * from notes where id = $1", [src.id])).rows[0]).toEqual(srcRowBefore);
    expect(xmlOf((await loadDoc(db, src.id))!)).toBe(srcXml);
    expect((await uploadsOf(db, src.id)).map(r => r.id).sort()).toEqual([u1, u2].sort());
    expect(await readFile(uploadFilePath(uploadsDir, u1))).toEqual(b1);

    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, copyId))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, copyId))).toEqual([]);
    const { rows: [cp] } = await db.$client.query(
      "select owner_id, group_id, public_token, public_slug, prev_slug, legacy_slug, slug_is_custom, last_edited_at, last_edited_by from notes where id = $1",
      [copyId],
    );
    expect(cp).toEqual({
      owner_id: null, group_id: g.id, public_token: null, public_slug: null, prev_slug: null, legacy_slug: null, slug_is_custom: false,
      last_edited_at: null, last_edited_by: null,
    });
    // The copy is a new note, `updated_at` takes the DB default - later than the source (the MCP `list_notes` description relies on this).
    const { rows: [cmp] } = await db.$client.query<{ later: boolean }>(
      "select (select updated_at from notes where id = $1) > (select updated_at from notes where id = $2) as later",
      [copyId, src.id],
    );
    expect(cmp!.later).toBe(true);
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(srcRowBefore.updated_at).getTime());
  });

  it("group -> personal (a read-only custom role works too): 201 owner shape; slug is deduplicated by title within the caller's personal scope", async () => {
    const { app, db } = await buildTestApp();
    const [admin, reader] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: reader.id, role: "member" }]);
    const readerRole = await seedRole(db, g.id, "Reader", { canRead: true });
    await setMemberRole(db, g.id, reader.id, readerRole);
    const auto = autoSlugFromTitle("Weekly Plan");
    const src = await seedNote(db, { groupId: g.id }, { title: "Weekly Plan", slug: auto });
    await seedNote(db, { ownerId: reader.id }, { title: "Weekly Plan", slug: auto });

    const res = await copy(app, src.id, reader.id);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ownerId: reader.id, ownerHandle: reader.handle, groupId: null, group: null, role: "owner", permissions: OWNER_PERMS,
      title: "Weekly Plan", slug: nextSlugCandidate(auto, 2),
    });
    expect(res.json().slug).toBe(`${auto}-2`);
  });

  it("source authorization: a stranger (personal note without shares), non-member (group note) -> 404 not_found, byte-for-byte identical to a nonexistent id; no row created", async () => {
    const { app, db } = await buildTestApp();
    const [owner, stranger, admin] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const personal = await seedNote(db, { ownerId: owner.id });
    const grouped = await seedNote(db, { groupId: g.id });
    const before = await noteCount(db);

    const missing = await copy(app, "00000000-0000-4000-8000-000000000000", stranger.id);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "No note with that id." } });
    for (const noteId of [personal.id, grouped.id, "not-a-uuid"]) {
      const res = await copy(app, noteId, stranger.id);
      expect(res.statusCode, noteId).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect(await noteCount(db)).toBe(before);
  });

  it("target: non-UUID, nonexistent, non-member, member without can_create -> 404 group_not_found (the four byte-for-byte identical), no row created, no file written", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const readOnly = await seedGroup(db, "ReadOnly", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, readOnly.id, "Reader", { canRead: true });
    await setMemberRole(db, readOnly.id, owner.id, reader);
    const src = await seedNote(db, { ownerId: owner.id });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const [notesBefore, uploadsBefore, filesBefore] = [await noteCount(db), await uploadCount(db), await filesIn(uploadsDir)];

    const bodies: string[] = [];
    for (const groupId of ["not-a-uuid", "00000000-0000-4000-8000-00000000abcd", notMine.id, readOnly.id]) {
      const res = await copy(app, src.id, owner.id, { groupId });
      expect(res.statusCode, groupId).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("strict body: extra key, groupId not a string / null -> 400 invalid_body, no row created", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id });
    const before = await noteCount(db);
    for (const payload of [{ groupId: g.id, extra: 1 }, { extra: 1 }, { groupId: 42 }, { groupId: null }]) {
      const res = await copy(app, src.id, owner.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await noteCount(db)).toBe(before);
  });

  it("copying into a group with a name collision: beforeInsert snatches the slug -> savepoint retry succeeds, 201", async () => {
    const holder: { db?: Db; groupId?: string; candidates: string[] } = { candidates: [] };
    const { app, db } = await buildTestApp({
      noteCreateHooks: {
        beforeInsert: async candidate => {
          holder.candidates.push(candidate);
          // Another connection first commits a group note with the same slug - the copy's INSERT hits notes_group_slug_idx.
          if (holder.candidates.length === 1) await seedNote(holder.db!, { groupId: holder.groupId! }, { slug: candidate });
        },
      },
    });
    holder.db = db;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    holder.groupId = g.id;
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan", slug: "plan" });

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(holder.candidates).toEqual(["plan", "plan-2"]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "plan-2", groupId: g.id });
    expect((await db.$client.query("select count(*)::int as n from note_states where note_id = $1", [res.json().id])).rows[0].n).toBe(1);
  });

  it("note-copy-files-copied test hook throws -> 500; the temp files written before the transaction are cleaned up, no copy note (the hook is inside the same cleanup try as the copy step)", async () => {
    const seen: { tempsAtHook?: number } = {};
    const holder: { uploadsDir?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-files-copied") return;
        seen.tempsAtHook = (await filesIn(holder.uploadsDir!)).filter(f => f.endsWith(".tmp")).length;
        throw new Error("boom");
      },
    });
    holder.uploadsDir = uploadsDir;
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u2}`]));
    const [notesBefore, uploadsBefore] = [await noteCount(db), await uploadCount(db)];

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(500);
    expect(seen.tempsAtHook).toBe(2);
    expect(await filesIn(uploadsDir)).toEqual([u1, u2].sort());
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
  });

  it("copy keeps each attachment's file_name (and a null one stays null)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const named = await seedUpload(db, uploadsDir, src.id, owner.id, Buffer.from("named-bytes"), { fileName: "Quarterly report.pdf" });
    const unnamed = await seedUpload(db, uploadsDir, src.id, owner.id, Buffer.from("unnamed"));
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${named}`, `/api/uploads/${unnamed}`]));

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(201);
    const rows = await db.select({ size: uploads.size, fileName: uploads.fileName }).from(uploads).where(eq(uploads.noteId, res.json().id));
    expect(rows.sort((a, b) => a.size - b.size)).toEqual([{ size: 7, fileName: null }, { size: 11, fileName: "Quarterly report.pdf" }]);
  });

  it("a failure inside the transaction before the renames (note-copy-locked throws) -> 500; the temp files existed at that point and neither name is left afterwards", async () => {
    const seen: { names?: string[] } = {};
    const holder: { uploadsDir?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked") return;
        seen.names = await filesIn(holder.uploadsDir!);
        throw new Error("boom");
      },
    });
    holder.uploadsDir = uploadsDir;
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u2}`]));
    const [notesBefore, uploadsBefore] = [await noteCount(db), await uploadCount(db)];

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(500);
    expect(seen.names!.filter(f => f.endsWith(".tmp"))).toHaveLength(2);
    expect(seen.names!.filter(f => !f.endsWith(".tmp"))).toEqual([u1, u2].sort());
    expect(await filesIn(uploadsDir)).toEqual([u1, u2].sort());
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
  });

  it("a failure after the renames (search-index afterWriteForTest throws) -> 500; the final-named files existed at that point and neither name is left; the already-gone temp names log nothing", async () => {
    const seen: { names?: string[] } = {};
    const holder: { uploadsDir?: string } = {};
    const out: string[] = [];
    const { app, db, uploadsDir } = await buildTestApp(
      {
        searchIndexHooks: {
          afterWriteForTest: async () => {
            seen.names = await filesIn(holder.uploadsDir!);
            throw new Error("after-write boom");
          },
        },
      },
      { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } },
    );
    holder.uploadsDir = uploadsDir;
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u2}`]));
    const [notesBefore, uploadsBefore] = [await noteCount(db), await uploadCount(db)];

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(500);
    expect(seen.names!.filter(f => f.endsWith(".tmp"))).toEqual([]);
    expect(seen.names!).toHaveLength(4);
    expect(await filesIn(uploadsDir)).toEqual([u1, u2].sort());
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
    const records = out.map(line => JSON.parse(line) as { msg?: string; code?: string | null; context?: string });
    // Non-vacuous: the failure itself reached this log.
    expect(records.some(r => r.context === "copy note")).toBe(true);
    expect(records.filter(r => r.code === "ENOENT" || /delet/i.test(r.msg ?? ""))).toEqual([]);
  });

  it("files are copied outside any transaction: with the source row held FOR UPDATE by another connection, the copy step still reaches note-copy-files-copied; the copy is 201 once the holder lets go", async () => {
    const holder: { release?: () => Promise<void>; heldAtHook?: boolean; released?: boolean } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-files-copied") return;
        holder.heldAtHook = holder.released !== true;
        await holder.release!();
      },
    });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const c = await db.$client.connect();
    await c.query("begin");
    await c.query("select id from notes where id = $1 for update", [src.id]);
    holder.release = async () => {
      if (holder.released) return;
      holder.released = true;
      await c.query("rollback");
      c.release();
    };
    // Bounded: a copy step that waited on this row lock would reach the hook only after this release, and the assertion below fails instead of hanging.
    const safety = setTimeout(() => void holder.release!(), 3_000);

    const res = await copy(app, src.id, owner.id);

    clearTimeout(safety);
    expect(holder.heldAtHook).toBe(true);
    expect(res.statusCode).toBe(201);
    const [n1] = await uploadsOf(db, res.json().id);
    expect(await filesIn(uploadsDir)).toEqual([u1, n1!.id].sort());
  });

  it("deleting the source while the copy holds FOR KEY SHARE -> DELETE (move to trash) blocks on the row lock (blocked) -> copy 201 -> move 204 -> the copy's image still 200 for the caller; still 200 after the source is permanently deleted", async () => {
    const holder: { app?: FastifyInstance; db?: Db; srcId?: string; cookie?: Record<string, string>; del?: Promise<{ statusCode: number }>; interleave?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked" || holder.del) return;
        holder.del = holder.app!.inject({ method: "DELETE", url: `/api/notes/${holder.srcId}`, cookies: holder.cookie });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.del);
      },
    });
    Object.assign(holder, { app, db });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    Object.assign(holder, { srcId: src.id, cookie: await cookieOf(owner.id) });

    const res = await copy(app, src.id, owner.id);

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect((await holder.del!).statusCode).toBe(204);
    const [srcRow] = await db.select({ deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, src.id));
    expect(srcRow?.deletedAt).not.toBeNull();
    const [n1] = await uploadsOf(db, res.json().id);
    const img = await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) });
    expect(img.statusCode).toBe(200);
    expect(await filesIn(uploadsDir)).toEqual([u1, n1!.id].sort()); // moving to the trash doesn't delete files (#181); the copy has its own
    // Source permanently deleted (the transaction body called directly; deleting files is the service layer's job after commit): the copy's row and image are unaffected.
    const purged = await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [src.id], by: owner.id }));
    expect(purged.uploadIds).toEqual([u1]);
    expect(await db.select().from(notes).where(eq(notes.id, src.id))).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) })).statusCode).toBe(200);
  });

  it("while the copy holds its lock, an ordinary UPDATE of the source (last_edited_at) isn't blocked", async () => {
    const holder: { db?: Db; srcId?: string; upd?: Promise<"done">; outcome?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked") return;
        const upd = holder.db!.update(notes).set({ lastEditedAt: new Date() }).where(eq(notes.id, holder.srcId!)).then(() => "done" as const);
        holder.upd = upd;
        // Don't await `upd` itself: if blocked it is released after 1 second and the copy commits as usual, then the blocked UPDATE completes right away (no dangling connection).
        holder.outcome = await Promise.race([upd, new Promise<string>(r => setTimeout(() => r("timeout"), 1000))]);
      },
    });
    holder.db = db;
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    holder.srcId = src.id;

    const res = await copy(app, src.id, owner.id);

    await holder.upd;
    expect(res.statusCode).toBe(201);
    expect(holder.outcome).toBe("done");
  });

  it("after the copy is made public anonymous readers get the image; after the source goes to the trash and is permanently deleted the copy's image is still 200 for the owner", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));

    const res = await copy(app, src.id, owner.id);
    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const [n1] = await uploadsOf(db, copyId);
    // The image id comes from the copy's document (the URL the user actually sees) and matches the copy's uploads row.
    const docUrl = /\/api\/uploads\/([0-9a-f-]{36})/.exec(xmlOf((await loadDoc(db, copyId))!))![1];
    expect(docUrl).toBe(n1!.id);
    const pub = await app.inject({ method: "PUT", url: `/api/notes/${copyId}/public-link`, cookies: await cookieOf(owner.id) });
    expect(pub.statusCode).toBe(200);
    const anon = await app.inject({ method: "GET", url: `/api/public/notes/${pub.json().token}/uploads/${n1!.id}` });
    expect(anon.statusCode).toBe(200);
    // Contrast: the source's attachment id read under the copy's public link doesn't work (proves the previous check really relies on the rewritten new id).
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${pub.json().token}/uploads/${u1}` })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/notes/${src.id}`, cookies: await cookieOf(owner.id) })).statusCode).toBe(204);
    const img = await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) });
    expect(img.statusCode).toBe(200);
    expect((await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [src.id], by: owner.id }))).done).toEqual([src.id]);
    expect((await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) })).statusCode).toBe(200);
  });

  it("outgoing note_links: written as the copier - targets he can see have rows, ones he can't don't; the visible target's backlinks list the copy", async () => {
    const { app, db } = await buildTestApp();
    const [owner, copier] = await Promise.all([seedUser(db), seedUser(db)]);
    const visible = await seedNote(db, { ownerId: copier.id });
    const hidden = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Links" });
    await seedShare(db, src.id, copier.id, "viewer");
    await seedDoc(db, src.id, wikilinkDoc([visible.id, hidden.id]));

    const res = await copy(app, src.id, copier.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const links = await db.select({ target: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, copyId));
    expect(links).toEqual([{ target: visible.id }]);
    const bl = await app.inject({ method: "GET", url: `/api/notes/${visible.id}/backlinks`, cookies: await cookieOf(copier.id) });
    expect(bl.statusCode).toBe(200);
    expect((bl.json().backlinks as Array<{ id: string }>).map(b => b.id)).toEqual([copyId]);
    // Both wikilinks in the copy's document are kept as is (the invisible one shows as unresolved in the copy).
    const xml = xmlOf((await loadDoc(db, copyId))!);
    expect(xml).toContain(visible.id);
    expect(xml).toContain(hidden.id);
  });

  it("a note that was never opened (no note_states) -> 201, the copy has one note_states row (version 1, empty document)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Never opened" });
    expect(await loadDoc(db, src.id)).toBeNull();

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    expect((await db.$client.query("select version from note_states where note_id = $1", [copyId])).rows).toEqual([{ version: 1 }]);
    expect(xmlOf((await loadDoc(db, copyId))!)).toBe("");
  });

  it("attachment row present, disk file missing -> 201; that node keeps the original URL and no uploads row is created for it; other attachments are copied as usual", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const lost = await seedUpload(db, uploadsDir, src.id, owner.id, undefined, { noFile: true });
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${lost}`]));

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const rows = await uploadsOf(db, copyId);
    expect(rows).toHaveLength(1);
    const xml = xmlOf((await loadDoc(db, copyId))!);
    expect(xml).toContain(`/api/uploads/${rows[0]!.id}`);
    expect(xml).toContain(`/api/uploads/${lost}`);
    expect(xml).not.toContain(`/api/uploads/${u1}`);
    expect(await filesIn(uploadsDir)).toEqual([u1, rows[0]!.id].sort());
  });

  it("throttle: edit bucket exhausted -> 429, no row created", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const before = await noteCount(db);
    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    const second = await copy(app, src.id, owner.id);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");
    expect(await noteCount(db)).toBe(before + 1);
  });

  it("target rejected (non-member) -> 404 group_not_found, charges neither the edit bucket nor the upload bucket (the fast-check member predicate needs the userId)", async () => {
    const edit = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ edit, upload }) });
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    // The target group has someone else (admin) with can_create; owner isn't a member.
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const notesBefore = await noteCount(db);

    const res = await copy(app, src.id, owner.id, { groupId: notMine.id });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("group_not_found");
    expect(await noteCount(db)).toBe(notesBefore);
    // Accounting: the rejected request charged no bucket -> the edit bucket has the whole window of 2 left, the upload bucket the whole window of 1.
    expect(edit.consume(owner.id)).toBe(true);
    expect(edit.consume(owner.id)).toBe(true);
    expect(edit.consume(owner.id)).toBe(false);
    expect(upload.consume(owner.id)).toBe(true);
    expect(upload.consume(owner.id)).toBe(false);
  });

  it("upload bucket: charged by the number of attachments that will be copied (other notes' attachments and external images don't count); not enough quota -> 429 too_many_requests, no row, no file, the rejected request isn't charged", async () => {
    const upload = new FixedWindowLimiter({ limit: 3, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const other = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`, `/api/uploads/${u2}`, `/api/uploads/${u3}`, EXTERNAL]));

    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201); // charges 2 (u1 referenced twice counts once; u3 and the external image don't count)
    const [notesBefore, uploadsBefore, filesBefore] = [await noteCount(db), await uploadCount(db), await filesIn(uploadsDir)];

    const second = await copy(app, src.id, owner.id); // needs 2, 1 left
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: { code: "too_many_requests", message: "Too many requests. Wait a moment and try again." } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
    // Accounting: the first charged 2, the rejected second isn't recorded -> exactly 1 left.
    expect(upload.consume(owner.id)).toBe(true);
    expect(upload.consume(owner.id)).toBe(false);
  });

  it("upload bucket: attachment count > whole-window quota -> the first request in a new window 201 (clamped to the whole window, charged in full), another copy in the same window right after 429, no row created", async () => {
    const upload = new FixedWindowLimiter({ limit: 2, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedUpload(db, uploadsDir, src.id, owner.id));
    await seedDoc(db, src.id, imageDoc(ids.map(u => `/api/uploads/${u}`)));

    const first = await copy(app, src.id, owner.id); // needs 3 > limit 2: clamped to 2, the new window lets it through (without the clamp it would be 429 forever)
    expect(first.statusCode).toBe(201);
    expect(await uploadsOf(db, first.json().id)).toHaveLength(3); // all three are copied as usual
    const notesBefore = await noteCount(db);

    const second = await copy(app, src.id, owner.id);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: { code: "too_many_requests", message: "Too many requests. Wait a moment and try again." } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(upload.consume(owner.id)).toBe(false); // the first request already used the whole window
  });

  it("upload bucket: no attachment to copy (only other notes' attachments and external images) -> upload bucket untouched", async () => {
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const other = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u3}`, EXTERNAL]));

    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    expect(upload.consume(owner.id)).toBe(true); // quota 1 is still there
  });

  it("copy kicks nobody: neither onGroupAccessChanged nor onShareChanged is called", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    await seedShare(db, src.id, c.id, "editor");
    const gn = await seedNote(db, { groupId: g.id }, { title: "Group" });

    expect((await copy(app, src.id, owner.id, { groupId: g.id })).statusCode).toBe(201);
    expect((await copy(app, gn.id, owner.id)).statusCode).toBe(201);
    expect(spy.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(spy.onShareChanged).not.toHaveBeenCalled();
    expect(spy.onUserRevoked).not.toHaveBeenCalled();
  });

  it("create-only role copying into a group -> 201, the copy's response has role viewer, permissions.edit false", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const contributor = await seedRole(db, g.id, "Contributor", { canRead: true, canCreate: true });
    await setMemberRole(db, g.id, owner.id, contributor);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      groupId: g.id, ownerId: null, role: "viewer",
      permissions: { read: true, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
  });
});

describe("#175 copy x group locks", () => {
  const membersOf = async (db: Db, groupId: string, userId: string): Promise<number> =>
    (await db.$client.query<{ n: number }>("select count(*)::int as n from group_members where group_id = $1 and user_id = $2", [groupId, userId])).rows[0]!.n;
  const notesInGroup = async (db: Db, groupId: string): Promise<string[]> =>
    (await db.$client.query<{ title: string }>("select title from notes where group_id = $1 order by title", [groupId])).rows.map(r => r.title);

  it("copy first holds the lock (note-copy-locked: target groups KEY SHARE + source) -> removing a member's lockGroup waits for its commit (blocked) -> copy 201, remove 204; final state = copy first, remove after", async () => {
    const holder: { app?: FastifyInstance; db?: Db; groupId?: string; userId?: string; cookie?: Record<string, string>; rm?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked" || holder.rm) return;
        holder.rm = holder.app!.inject({ method: "DELETE", url: `/api/groups/${holder.groupId}/members/${holder.userId}`, cookies: holder.cookie });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.rm);
      },
    });
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    Object.assign(holder, { app, db, groupId: g.id, userId: m.id, cookie: await cookieOf(admin.id) });
    const src = await seedNote(db, { ownerId: m.id }, { title: "Copied" });

    const res = await copy(app, src.id, m.id, { groupId: g.id });
    const removed = await holder.rm!;

    // Removing the KEY SHARE on the target group from the transaction: the source's KEY SHARE doesn't block lockGroup -> this line goes red (settled).
    // With it removed entirely the final state seen is: the removal 204 lands first and the copy is still 201 - a non-member created a note in the group.
    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect(removed.statusCode).toBe(204);
    expect(await membersOf(db, g.id, m.id)).toBe(0);
    expect(await notesInGroup(db, g.id)).toEqual(["Copied"]);
  });

  it("member removal first takes the lock (group-members-checked) -> the copy's route check reads the pre-commit membership and passes, the in-transaction KEY SHARE waits for the removal to commit -> re-verification 404 group_not_found; the group gets no new note, no file written", async () => {
    const holder: { pool?: Db["$client"]; fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "group-members-checked" || !holder.fire || holder.second) return;
        holder.second = holder.fire();
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.second);
      },
    });
    const { app, db, uploadsDir } = built;
    holder.pool = db.$client;
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: m.id }, { title: "Copied" });
    const u1 = await seedUpload(db, uploadsDir, src.id, m.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const [notesBefore, filesBefore] = [await noteCount(db), await filesIn(uploadsDir)];
    holder.fire = () => copy(app, src.id, m.id, { groupId: g.id });

    const removed = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${m.id}`, cookies: await cookieOf(admin.id) });
    const copied = await holder.second!;

    // With the member re-verification removed and only the KEY SHARE kept: the copy is still blocked, but after the removal commits it is still 201.
    expect(holder.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(copied.statusCode).toBe(404);
    expect(copied.json()).toEqual({ error: { code: "group_not_found", message: "No group with that id." } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await notesInGroup(db, g.id)).toEqual([]);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("downgrade first takes the lock (group-members-checked) -> the copy's route check reads the pre-downgrade admin and passes, the transaction re-reads after the downgrade commits -> the 201's role/permissions are the downgraded member values, consistent with GET of the copy", async () => {
    const holder: { pool?: Db["$client"]; fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "group-members-checked" || !holder.fire || holder.second) return;
        holder.second = holder.fire();
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.second);
      },
    });
    holder.pool = db.$client;
    const [a1, a2] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    const src = await seedNote(db, { ownerId: a2.id }, { title: "Copied" });
    holder.fire = () => copy(app, src.id, a2.id, { groupId: g.id });

    const demoted = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a2.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    const copied = await holder.second!;

    expect(holder.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(copied.statusCode).toBe(201);
    // If the route went back to building the DTO from the out-of-transaction `loadCreateTarget` value, this line goes red: the response would be admin's delete/managePublicLink/changeSlug true.
    expect(copied.json()).toMatchObject({
      groupId: g.id, group: { id: g.id, name: "G" }, role: "editor",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    const got = await app.inject({ method: "GET", url: `/api/notes/${copied.json().id}`, cookies: await cookieOf(a2.id) });
    expect(got.json().permissions).toEqual(copied.json().permissions);
  });

  it("same-group copy (source and target both in G) holding the target groups KEY SHARE while another transaction does 'groups FOR UPDATE -> G's notes FOR UPDATE' (the shape of group delete-all) -> the other waits for the copy to commit (blocked), both complete, no 40P01", async () => {
    const holder: { db?: Db; groupId?: string; other?: Promise<string>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        // The hook after the copy transaction's **first lock**: in the current order it is after the target groups KEY SHARE (note-copy-target-locked, holds only groups KEY SHARE).
        // If the lock order were changed back to "source -> groups" (or the target groups KEY SHARE removed and groups taken via the INSERT's FK), the first hook reached would be
        // note-copy-locked (holds only the source): the other side gets groups and then waits for the source, and the copy then waits for groups -> a cycle (40P01).
        if ((point !== "note-copy-target-locked" && point !== "note-copy-locked") || holder.other) return;
        holder.other = (async () => {
          const c = await holder.db!.$client.connect();
          try {
            await c.query("begin");
            await c.query("select id from groups where id = $1 for update", [holder.groupId]);
            await c.query("select id from notes where group_id = $1 for update", [holder.groupId]);
            await c.query("commit");
            return "committed";
          } catch (err) {
            await c.query("rollback").catch(() => {});
            return `error ${(err as { code?: string }).code}`;
          } finally {
            c.release();
          }
        })();
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.other);
      },
    });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    Object.assign(holder, { db, groupId: g.id });
    const src = await seedNote(db, { groupId: g.id }, { title: "Same group" });

    const res = await copy(app, src.id, admin.id, { groupId: g.id });

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect(await holder.other!).toBe("committed");
    expect(await notesInGroup(db, g.id)).toEqual(["Same group", "Same group"]);
  });
});
