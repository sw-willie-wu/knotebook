import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, freshLimiters, type TestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf } from "./group-helpers.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import { filesIn, giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, usedOf } from "./storage-helpers.js";

const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const noteCount = async (pool: import("pg").Pool) => (await pool.query("select count(*)::int n from notes")).rows[0].n as number;

/** Source note: one attachment per size (DB size as given, small PNG on disk), all referenced by the document. */
async function srcWith(db: TestApp["db"], uploadsDir: string, owner: { ownerId: string } | { groupId: string }, uploaderId: string, sizes: number[], title = "Src") {
  const n = await seedNote(db, owner, { title });
  const ids: string[] = [];
  for (const s of sizes) ids.push(await seedAttachment(db, uploadsDir, n.id, uploaderId, s));
  await seedDoc(db, n.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
  return { id: n.id, uploadIds: ids };
}

describe("copy", () => {
  it("to a full personal space (with attachments) -> pre-check 409 (incomingBytes null, owner sees the three numbers); no note created, no new file on disk, upload bucket not charged", async () => {
    // The upload bucket allows only 1: after the rejection that 1 is still there, proving the pre-check runs before consumeMany.
    const uploadBucket = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload: uploadBucket }) });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, b.id, 100);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 100);
    const src = await srcWith(db, uploadsDir, { ownerId: a.id }, a.id, [10]);
    await seedShare(db, src.id, b.id, "viewer");
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r = await copy(app, src.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 100, quotaBytes: 100 }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
    expect(uploadBucket.consume(b.id)).toBe(true);
  });

  it("not full, each attachment would fit alone but their total doesn't -> lock-free 409 before any file is written (incomingBytes = the total); no new note, the copy step never ran, upload bucket not charged", async () => {
    const points: string[] = [];
    const uploadBucket = new FixedWindowLimiter({ limit: 2, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({
      limiters: freshLimiters({ upload: uploadBucket }),
      groupTestHook: async point => { points.push(point); },
    });
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 1000);
    const src = await srcWith(db, uploadsDir, { ownerId: a.id }, a.id, [300, 400]); // usage is already 700, the copy needs another 700
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r = await copy(app, src.id, a.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 700, usedBytes: 700, quotaBytes: 1000 }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
    expect(points).not.toContain("note-copy-files-copied");
    expect(uploadBucket.consume(a.id)).toBe(true);
    expect(uploadBucket.consume(a.id)).toBe(true);
  });

  it("room taken after the lock-free check (another attachment lands while the files are being copied) -> 409 inside the transaction (incomingBytes = bytes copied); no new note, the temp files are cleaned up; the copy step holds no pool connection and runs before note-copy-authorized", async () => {
    const holder: { db?: TestApp["db"]; uploadsDir?: string; noteId?: string; userId?: string; done?: boolean; busyAtHook?: number } = {};
    const points: string[] = [];
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        points.push(point);
        if (point !== "note-copy-files-copied" || holder.done) return;
        holder.done = true;
        const pool = holder.db!.$client;
        holder.busyAtHook = pool.totalCount - pool.idleCount;
        await seedAttachment(holder.db!, holder.uploadsDir!, holder.noteId!, holder.userId!, 500, { noFile: true });
      },
    });
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 1000);
    const other = await seedNote(db, { ownerId: a.id });
    Object.assign(holder, { db, uploadsDir, noteId: other.id, userId: a.id });
    const src = await srcWith(db, uploadsDir, { ownerId: a.id }, a.id, [100, 200]);
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r = await copy(app, src.id, a.id);
    expect(holder.done).toBe(true);
    expect(holder.busyAtHook).toBe(0);
    expect(points.indexOf("note-copy-files-copied")).toBeGreaterThan(-1);
    expect(points.indexOf("note-copy-files-copied")).toBeLessThan(points.indexOf("note-copy-authorized"));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 300, usedBytes: 800, quotaBytes: 1000 }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("to a full group: manageGroup -> three numbers; ordinary member -> incomingBytes only", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [gAdmin, gMember] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 50);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, gAdmin.id, 50);
    const s1 = await srcWith(db, uploadsDir, { ownerId: gAdmin.id }, gAdmin.id, [10]);
    const s2 = await srcWith(db, uploadsDir, { ownerId: gMember.id }, gMember.id, [10]);
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r1 = await copy(app, s1.id, gAdmin.id, { groupId: g.id });
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 50, quotaBytes: 50 }));
    const r2 = await copy(app, s2.id, gMember.id, { groupId: g.id });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual(quotaBody({ incomingBytes: null }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("attachments missing on disk are not counted as incoming (neither by the lock-free check nor in the transaction): it fits exactly because of that -> 201; the missing one is still charged to the upload bucket", async () => {
    const uploadBucket = new FixedWindowLimiter({ limit: 2, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload: uploadBucket }) });
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 1000);
    const n = await seedNote(db, { ownerId: a.id }, { title: "Src" });
    const ok = await seedAttachment(db, uploadsDir, n.id, a.id, 200);
    const gone = await seedAttachment(db, uploadsDir, n.id, a.id, 500, { noFile: true });
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${ok}`, `/api/uploads/${gone}`]));
    // Usage 700; counting two would need 700 (over), counting only the 200 actually copied gives 900 <= 1000.
    const r = await copy(app, n.id, a.id);
    expect(r.statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(900);
    expect(uploadBucket.consume(a.id)).toBe(false);
  });

  it("source document references the same attachment twice, exactly one copy fits -> 201 (incoming counted once)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 600);
    const n = await seedNote(db, { ownerId: a.id }, { title: "Src" });
    const u1 = await seedAttachment(db, uploadsDir, n.id, a.id, 300);
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`]));
    const r = await copy(app, n.id, a.id);
    expect(r.statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(600);
  });

  it("space with quota 0 and an over-quota space - a copy without attachments is 201 either way (the pre-check runs only when there are attachments to copy)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [z, over] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, z.id, 0);
    await giveUserQuota(db, over.id, 10);
    const on = await seedNote(db, { ownerId: over.id });
    await seedAttachment(db, uploadsDir, on.id, over.id, 500);
    const plain1 = await seedNote(db, { ownerId: z.id }, { title: "P1" });
    const plain2 = await seedNote(db, { ownerId: over.id }, { title: "P2" });
    expect((await copy(app, plain1.id, z.id)).statusCode).toBe(201);
    expect((await copy(app, plain2.id, over.id)).statusCode).toBe(201);
  });
});

describe("move into a group", () => {
  it("move into a full group (with attachments) -> 409; owner/shares/redirects/slug all unchanged", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [o, s] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 100);
    const n = await seedNote(db, { ownerId: o.id }, { slug: "keep" });
    await seedAttachment(db, uploadsDir, n.id, o.id, 101);
    await seedShare(db, n.id, s.id, "editor");
    const before = await noteState(db.$client, n.id);
    const r = await move(app, n.id, o.id, g.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 101, usedBytes: 0, quotaBytes: 100 }));
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: s.id, role: "editor" }]);
    expect((await db.$client.query("select count(*)::int n from note_redirects")).rows[0].n).toBe(0);
  });

  it("success -> personal usage down, group usage up; a note without attachments moved into a full group (including quota 0) -> 200", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    const n = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, n.id, o.id, 700);
    expect((await move(app, n.id, o.id, g.id)).statusCode).toBe(200);
    expect(await usedOf(db.$client, { kind: "user", id: o.id })).toBe(0);
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(700);
    const g0 = await seedGroup(db, "Z", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g0.id, 0);
    const plain = await seedNote(db, { ownerId: o.id });
    expect((await move(app, plain.id, o.id, g0.id)).statusCode).toBe(200);
  });

  it("ordinary member (may create) rejected on move-in -> incomingBytes only", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 10);
    const n = await seedNote(db, { ownerId: m.id });
    await seedAttachment(db, uploadsDir, n.id, m.id, 11);
    const r = await move(app, n.id, m.id, g.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 11 }));
  });
});

describe("busy mapping (copy/move) and lock_timeout scope", () => {
  for (const code of ["40P01", "55P03"]) {
    it(`test hook storage-space-locked throws ${code}: copy -> 409 server_busy, copied files cleaned up, no new note; move -> 409 server_busy, note unchanged`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const o = await seedUser(db);
      const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
      const src = await srcWith(db, uploadsDir, { ownerId: o.id }, o.id, [10, 20]);
      const [nb, fb] = [await noteCount(db.$client), await filesIn(uploadsDir)];
      const c = await copy(app, src.id, o.id);
      expect(c.statusCode).toBe(409);
      expect(c.json().error.code).toBe("server_busy");
      expect(await noteCount(db.$client)).toBe(nb);
      expect(await filesIn(uploadsDir)).toEqual(fb);
      const before = await noteState(db.$client, src.id);
      const m = await move(app, src.id, o.id, g.id);
      expect(m.statusCode).toBe(409);
      expect(m.json().error.code).toBe("server_busy");
      expect(await noteState(db.$client, src.id)).toEqual(before);
    });
  }

  it("storageLockTimeoutMs=200; after the copy takes the space lock, insertNoteWithAutoSlug waits 300 ms on another connection's uncommitted same slug -> after the other side rolls back the copy is 201 (the row-lock wait after taking the lock is not bound by lock_timeout)", async () => {
    const holder: { ownerId?: string; started?: boolean; inserted?: boolean; pool?: import("pg").Pool } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.started) return;
        holder.started = true;
        const c = await holder.pool!.connect();
        try {
          await c.query("begin");
          // The holder's own wait gets an upper bound: if the copy's slug write ran before the space lock (lock order broken), the copy's
          // uncommitted 'plan' already exists, this statement waits for the copy, and the copy waits on this hook at the test hook - a
          // deadlock at the JS level that PG cannot detect (the test would hang until timeout). With the bound, a 55P03 after 2 s fails the case fast.
          await c.query("set local lock_timeout = '2000ms'");
          await c.query("insert into notes (owner_id, slug, title) values ($1, 'plan', 'Other')", [holder.ownerId]);
        } catch (err) {
          await c.query("rollback").catch(() => {});
          c.release();
          throw err;
        }
        holder.inserted = true;
        setTimeout(() => { void c.query("rollback").finally(() => c.release()); }, 300);
      },
    });
    holder.pool = db.$client;
    const o = await seedUser(db);
    holder.ownerId = o.id;
    await giveUserQuota(db, o.id, 10_000);
    // The source's slug is a random value from seedNote; the copy derives 'plan' from the title "Plan" - exactly the one the holder has uncommitted.
    const src = await srcWith(db, uploadsDir, { ownerId: o.id }, o.id, [10], "Plan");
    const t0 = Date.now();
    const r = await copy(app, src.id, o.id);
    expect(holder.inserted).toBe(true);
    expect(r.statusCode).toBe(201);
    expect(r.json().slug).toBe("plan");
    // Wait at least until the other side rolls back (300 ms, 50 ms measurement slack): proves the copy really waited on the unique index and was not cut off by lock_timeout after more than 200 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});
