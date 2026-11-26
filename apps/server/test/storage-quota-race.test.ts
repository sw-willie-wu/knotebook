// Race cases are injected with storageLockTimeoutMs = 60000. The first mover stops at `storage-space-locked` (space lock taken, after
// lock_timeout is restored) or an existing test hook, and the other side fires from the hook; `waitForBlockedOrSettled` returning
// "blocked" proves an interleaving was really tested.
// The other side's time from firing to finish is always < 10 s: under the 60 s space-lock wait cap, "finished quickly after blocked"
// distinguishes "first mover released, then its turn" from "waited all the way to timeout"; deadlocks (40P01) are detected by PG's
// deadlock_timeout (default 1 s) and are unaffected by this cap.
// Existing cases re-verified elsewhere are not repeated here: groups-v2-delete-race.test.ts, notes-delete-race.test.ts (#188), and the move x delete-group cases of groups-v2-move-race.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { UserGate } from "../src/auth/session.js";
import { createDb, type Db } from "../src/db/index.js";
import { createPool } from "../src/db/pool.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import {
  filesIn, giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, seedPlan, upload, usedOf, waitForAdvisoryWaiters,
} from "./storage-helpers.js";

const RACE = { storageLockTimeoutMs: 60_000 };
/** Upper bound for the other side (fired in the hook) from firing to finish; above it someone waited on the 60 s lock_timeout. */
const OTHER_MAX_MS = 10_000;
const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });

interface Holder {
  app?: FastifyInstance;
  db?: Db;
  fired?: boolean;
  other?: Promise<LightMyRequestResponse>;
  otherMs?: number;
  interleave?: string;
  fire?: () => Promise<LightMyRequestResponse>;
}

/** Other sides still running when a test fails (an assertion throws): afterEach waits for them so requests do not leak into the next case. */
const pending: Array<Promise<unknown>> = [];
afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
});

function raceHook(
  holder: Holder,
  match: (ctx: { noteId?: string; groupId?: string }) => boolean,
  point: GroupRacePoint = "storage-space-locked",
): GroupTestHook {
  return async (p, ctx) => {
    if (p !== point || holder.fired || !match(ctx)) return;
    holder.fired = true;
    const t0 = Date.now();
    holder.other = holder.fire!();
    // What is stored in pending is the new promise derived by .finally(): it rejects too when the other side rejects, and without a catch before afterEach collects it would be recorded as an unhandled rejection.
    pending.push(holder.other.finally(() => { holder.otherMs = Date.now() - t0; }).catch(() => {}));
    holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.other);
  };
}

async function settleOther(holder: Holder): Promise<LightMyRequestResponse> {
  const res = await holder.other!;
  expect(holder.interleave).toBe("blocked");
  expect(holder.otherMs!).toBeLessThan(OTHER_MAX_MS);
  return res;
}

describe("concurrent uploads racing for quota", () => {
  it("deterministic version: while the first stops at the hook the second is blocked; first 201, second decided by the SUM after the first commits -> 409 (three numbers); the loser leaves no file under either name", async () => {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, () => true) });
    Object.assign(holder, { app, db });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    holder.fire = () => upload(app, n.id, u.id, 600);
    const first = await upload(app, n.id, u.id, 600);
    const second = await settleOther(holder);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(409);
    // Both passed the room cap while streaming (each saw 1000 free), so the space lock decided: the in-transaction refusal carries the size.
    expect(second.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    const { id } = first.json() as { id: string };
    expect(first.json()).toEqual({ id, url: `/api/uploads/${id}`, mime: "image/png", kind: "image" });
    expect(await filesIn(uploadsDir)).toEqual([id]);
  });

  it("the first upload held at upload-received while a second one runs to completion: both passed the streaming cap, the second takes the room (201), the first gets the in-transaction 409, one file", async () => {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, () => true, "upload-received") });
    Object.assign(holder, { app, db });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    holder.fire = () => upload(app, n.id, u.id, 600);
    const first = await upload(app, n.id, u.id, 600);
    const second = await holder.other!;
    expect(holder.otherMs!).toBeLessThan(OTHER_MAX_MS);
    // The second upload runs to completion inside the first one's hook, so it takes the room first.
    expect(second.statusCode, second.body).toBe(201);
    expect(first.statusCode, first.body).toBe(409);
    expect(first.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect(await filesIn(uploadsDir)).toEqual([(second.json() as { id: string }).id]);
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(600);
  });

  it("same race by an editor share on someone else's note: the in-transaction 409 shows the editor no numbers, and the bytes count for the owner", async () => {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, () => true, "upload-received") });
    Object.assign(holder, { app, db });
    const [o, e] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, o.id, 1000);
    const n = await seedNote(db, { ownerId: o.id });
    await seedShare(db, n.id, e.id, "editor");
    holder.fire = () => upload(app, n.id, e.id, 600);
    const first = await upload(app, n.id, e.id, 600);
    const second = await holder.other!;
    expect(holder.otherMs!).toBeLessThan(OTHER_MAX_MS);
    expect(second.statusCode, second.body).toBe(201);
    expect(first.statusCode, first.body).toBe(409);
    expect(first.json()).toEqual(quotaBody({ incomingBytes: 600 }));
    expect(await filesIn(uploadsDir)).toEqual([(second.json() as { id: string }).id]);
    expect(await usedOf(db.$client, { kind: "user", id: o.id })).toBe(600);
  });

  it("500 left, 20 concurrent of 100 each -> exactly 5 are 201; final SUM = quota; exactly 5 more files on disk", async () => {
    // Window at the hook: the lock holder stops until "some connection in this DB waits on an advisory lock" or 300 ms. In correct
    // code the other requests queue on the lock and the holder barely stops; if the space lock stops working nobody waits on an
    // advisory lock, so every request in a transaction stops the full 300 ms at the hook and reads the old SUM -> oversell. Without
    // this window, removing the space lock would not reliably oversell (transactions too short for natural interleaving to hit).
    // Quota is 500 (not 1000): the app pool defaults to 10 connections, so at most 10 requests are in a transaction at once; with
    // quota exactly 10 x 100, even with the space lock broken the final state only reaches 1000 = no visible oversell (the other 10
    // wait for connections, and are rejected by the preHandler pre-check once the first 10 commit). That is an observation, not a
    // guaranteed bound (when a connection-waiting request passes the pre-check and reads SUM depends on scheduling) - so the number
    // that fits is < 10, so that when broken more requests are in transactions than fit.
    // Probe through a separate 1-connection pool: the app's pool (10 by default) is filled by transactions stopped at the hook, and
    // borrowing from it inside the hook to query pg_stat_activity would deadlock until the test times out.
    const probe: { pool?: Pool } = {};
    const built = await buildTestApp({
      ...RACE,
      groupTestHook: async point => { if (point === "storage-space-locked") await waitForAdvisoryWaiters(probe.pool!, 1, 300); },
    });
    const { app, db, uploadsDir } = built;
    probe.pool = new Pool({ connectionString: db.$client.options.connectionString, max: 1 });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 500);
    const n = await seedNote(db, { ownerId: u.id });
    const before = await filesIn(uploadsDir);
    const t0 = Date.now();
    let results: LightMyRequestResponse[];
    try {
      results = await Promise.all(Array.from({ length: 20 }, () => upload(app, n.id, u.id, 100)));
    } finally {
      await probe.pool.end();
    }
    expect(Date.now() - t0).toBeLessThan(OTHER_MAX_MS);
    expect(results.filter(r => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter(r => r.statusCode === 409)).toHaveLength(15);
    expect(results.filter(r => r.statusCode === 409).every(r => r.json().error.code === "storage_quota_exceeded")).toBe(true);
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(500);
    expect((await filesIn(uploadsDir)).length).toBe(before.length + 5);
  });
});

describe("upload and move-in racing on the same group (both orders)", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    await giveUserQuota(db, o.id, null);
    const gn = await seedNote(db, { groupId: g.id });
    const pn = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, pn.id, o.id, 500);
    return { holder, app, db, o, g, gn, pn };
  }

  it("upload takes the group space lock first -> move-in blocked -> upload 201 (600) -> move-in 409 (600+500>1000), the note is still personal", async () => {
    let ids: { gn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.gn));
    ids = { gn: s.gn.id };
    s.holder.fire = () => move(s.app, s.pn.id, s.o.id, s.g.id);
    const up = await upload(s.app, s.gn.id, s.o.id, 600);
    const mv = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(mv.statusCode, mv.body).toBe(409);
    expect(mv.json()).toEqual(quotaBody({ incomingBytes: 500, usedBytes: 600, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "group", id: s.g.id })).toBe(600);
    const { rows } = await s.db.$client.query("select owner_id, group_id from notes where id = $1", [s.pn.id]);
    expect(rows[0]).toEqual({ owner_id: s.o.id, group_id: null });
  });

  it("move-in takes the group space lock first -> upload blocked -> move-in 200 (500) -> upload 409 (500+600>1000)", async () => {
    let ids: { pn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.pn));
    ids = { pn: s.pn.id };
    s.holder.fire = () => upload(s.app, s.gn.id, s.o.id, 600);
    const mv = await move(s.app, s.pn.id, s.o.id, s.g.id);
    const up = await settleOther(s.holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 500, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "group", id: s.g.id })).toBe(500);
  });
});

describe("upload on the same note while a move holds the note FOR UPDATE", () => {
  it("the upload's explicit KEY SHARE is blocked; after the move commits the upload counts for the group space -> the group cannot fit -> 409 (an unlimited personal space does not help)", async () => {
    let ids: { n?: string } = {};
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, ctx => ctx.noteId === ids.n, "note-move-locked") });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    await giveUserQuota(db, o.id, null);
    const n = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, n.id, o.id, 900);
    ids = { n: n.id };
    holder.fire = () => upload(app, n.id, o.id, 200);
    const mv = await move(app, n.id, o.id, g.id);
    const up = await settleOther(holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(900);
  });
});

describe("copy and upload to the same target space (both orders)", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const [a, x] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    await giveUserQuota(db, x.id, null);
    const src = await seedNote(db, { ownerId: x.id }, { title: "Src" });
    const att = await seedAttachment(db, uploadsDir, src.id, x.id, 600);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    await seedShare(db, src.id, a.id, "viewer");
    const an = await seedNote(db, { ownerId: a.id });
    return { holder, app, db, uploadsDir, a, src, an };
  }

  it("copy takes a's space lock first -> upload blocked -> copy 201 (600) -> upload 409", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => upload(s.app, s.an.id, s.a.id, 600);
    const cp = await copy(s.app, s.src.id, s.a.id);
    const up = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "user", id: s.a.id })).toBe(600);
  });

  it("upload takes a's space lock first -> copy (files already copied) blocked -> upload 201 -> copy 409, copied files cleaned up, no copy", async () => {
    let ids: { an?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.an));
    ids = { an: s.an.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.a.id);
    const filesBefore = await filesIn(s.uploadsDir);
    const up = await upload(s.app, s.an.id, s.a.id, 600);
    const cp = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(cp.statusCode, cp.body).toBe(409);
    expect(cp.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect((await filesIn(s.uploadsDir)).length).toBe(filesBefore.length + 1);
    expect((await s.db.$client.query("select count(*)::int n from notes where owner_id = $1", [s.a.id])).rows[0].n).toBe(1);
  });
});

describe("transfer and upload to the recipient's personal note (both orders; no 40P01)", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 600);
    const bn = await seedNote(db, { ownerId: b.id });
    return { holder, app, db, b, g, bn };
  }

  it("transfer takes b's space lock first -> upload blocked -> transfer 204 -> upload 409", async () => {
    let ids: { g?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.groupId === ids.g && ctx.noteId === undefined));
    ids = { g: s.g.id };
    s.holder.fire = () => upload(s.app, s.bn.id, s.b.id, 600);
    const tr = await transfer(s.app, s.g.id, s.b.id, s.b.id);
    const up = await settleOther(s.holder);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
  });

  it("upload takes b's space lock first -> transfer (group and notes already locked) blocked -> upload 201 -> transfer 409 storage_quota_exceeded (not server_busy)", async () => {
    let ids: { bn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.bn));
    ids = { bn: s.bn.id };
    s.holder.fire = () => transfer(s.app, s.g.id, s.b.id, s.b.id);
    const up = await upload(s.app, s.bn.id, s.b.id, 600);
    const tr = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(409);
    expect(tr.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
  });
});

describe("upload holds KEY SHARE on a note of the group being transferred", () => {
  it("the transferred group's notes FOR UPDATE are blocked; upload 201 counts for the group -> the transfer's incoming includes it -> the recipient cannot fit -> 409", async () => {
    let ids: { gn?: string } = {};
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, ctx => ctx.noteId === ids.gn) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, null);
    await giveUserQuota(db, b.id, 500);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 300);
    ids = { gn: gn.id };
    holder.fire = () => transfer(app, g.id, b.id, b.id);
    const up = await upload(app, gn.id, b.id, 400);
    const tr = await settleOther(holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(409);
    expect(tr.json()).toEqual(quotaBody({ incomingBytes: 700, usedBytes: 0, quotaBytes: 500 }));
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(700);
  });
});

describe("copy to the recipient's personal space and transfer to the same recipient (space lock before the slug write; no deadlock in either order)", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, null);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id }, { title: "X", slug: "x" });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 10);
    const src = await seedNote(db, { ownerId: b.id }, { title: "X" }); // the copy derives slug "x" from the title, colliding with the transferred note's (b, x)
    const att = await seedAttachment(db, uploadsDir, src.id, b.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    return { holder, app, db, b, g, src };
  }
  const slugsOf = async (db: Db, ownerId: string) =>
    (await db.$client.query<{ slug: string }>("select slug from notes where owner_id = $1 and slug like 'x%' order by slug", [ownerId])).rows.map(r => r.slug);

  it("transfer takes b's space lock first -> copy blocked (before insertNoteWithAutoSlug) -> transfer 204, copy 201; slugs x and x-2", async () => {
    let ids: { g?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.groupId === ids.g && ctx.noteId === undefined));
    ids = { g: s.g.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.b.id);
    const tr = await transfer(s.app, s.g.id, s.b.id, s.b.id);
    const cp = await settleOther(s.holder);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(await slugsOf(s.db, s.b.id)).toEqual(["x", "x-2"]);
  });

  it("copy takes b's space lock first -> transfer blocked (before writeSlugInTx) -> copy 201, transfer 204", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => transfer(s.app, s.g.id, s.b.id, s.b.id);
    const cp = await copy(s.app, s.src.id, s.b.id);
    const tr = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(await slugsOf(s.db, s.b.id)).toEqual(["x", "x-2"]);
  });
});

describe("move form: move-in to a group and copy into the same group (space lock before the group-scoped slug write; no deadlock in either order)", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    await giveUserQuota(db, o.id, null);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, null);
    const pn = await seedNote(db, { ownerId: o.id }, { title: "Y", slug: "y" }); // move-in dedupes within the group by its old slug "y"
    await seedAttachment(db, uploadsDir, pn.id, o.id, 10);
    const src = await seedNote(db, { ownerId: o.id }, { title: "Y" }); // the copy derives slug "y" from the title, colliding with the moved note's (G, y)
    const att = await seedAttachment(db, uploadsDir, src.id, o.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    return { holder, app, db, o, g, pn, src };
  }
  const groupSlugs = async (db: Db, groupId: string) =>
    (await db.$client.query<{ slug: string }>("select slug from notes where group_id = $1 order by slug", [groupId])).rows.map(r => r.slug);

  it("move-in takes the group space lock first -> copy blocked (before insertNoteWithAutoSlug) -> move-in 200, copy 201; group slugs y and y-2", async () => {
    let ids: { pn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.pn));
    ids = { pn: s.pn.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.o.id, { groupId: s.g.id });
    const mv = await move(s.app, s.pn.id, s.o.id, s.g.id);
    const cp = await settleOther(s.holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(await groupSlugs(s.db, s.g.id)).toEqual(["y", "y-2"]);
  });

  it("copy takes the group space lock first -> move-in blocked (before writeSlugInTx) -> copy 201, move-in 200", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => move(s.app, s.pn.id, s.o.id, s.g.id);
    const cp = await copy(s.app, s.src.id, s.o.id, { groupId: s.g.id });
    const mv = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(await groupSlugs(s.db, s.g.id)).toEqual(["y", "y-2"]);
  });
});

const assignBoth = async (app: FastifyInstance, adminId: string, ids: { userId: string; groupId: string }, planId: string) => {
  const cookies = await cookieOf(adminId);
  return Promise.all([
    app.inject({ method: "PATCH", url: `/api/admin/users/${ids.userId}/storage-plan`, cookies, payload: { planId } }),
    app.inject({ method: "PATCH", url: `/api/admin/groups/${ids.groupId}/storage-plan`, cookies, payload: { planId } }),
  ]);
};

describe("assigning a plan does not block in-flight additions (a non-key UPDATE = NO KEY UPDATE, compatible with FK KEY SHARE)", () => {
  // What each case guards. The first two (upload stopped at the hook): assignment does not take the space lock. An upload stopped at
  // the hook holds the note row's KEY SHARE plus the space advisory lock, with no INSERT into uploads yet and no lock on users/groups
  // rows - so these two cannot catch "assignment upgraded to a key lock", only "assignment takes the space lock". The personal-note case
  // guards the user assignment and the group-note case the group assignment (only the one matching the upload's space can hit its lock).
  // The third case (another connection holds FK KEY SHARE): the assignment UPDATE is NO KEY UPDATE (compatible with FK KEY SHARE); covers both.
  // In the hook wait only for "blocked or settled", not for both assignments to finish: if an assignment is blocked by the upload
  // transaction's lock, waiting for it to finish inside the hook would deadlock until the test times out.
  async function assignDuringUpload(noteSpace: "user" | "group") {
    const holder: Holder & { both?: Promise<LightMyRequestResponse[]>; ids?: { userId: string; groupId: string }; admin?: string; plan?: string } = {};
    const { app, db } = await buildTestApp({
      ...RACE,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.fired) return;
        holder.fired = true;
        holder.both = assignBoth(app, holder.admin!, holder.ids!, holder.plan!);
        pending.push(holder.both.catch(() => {}));
        holder.interleave = await waitForBlockedOrSettled(db.$client, holder.both);
      },
    });
    const [admin, o] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    const n = await seedNote(db, noteSpace === "user" ? { ownerId: o.id } : { groupId: g.id });
    Object.assign(holder, { admin: admin.id, ids: { userId: o.id, groupId: g.id }, plan: await giveUserQuota(db, o.id, 10_000) });
    const up = await upload(app, n.id, o.id, 100);
    expect(holder.fired).toBe(true);
    expect(holder.interleave).toBe("settled");
    expect((await holder.both!).map(r => r.statusCode)).toEqual([200, 200]);
    expect(up.statusCode, up.body).toBe(201);
  }

  it("upload (personal note) stopped at storage-space-locked, admin changes the owner's plan and the group plan -> both settled (200)", async () => {
    await assignDuringUpload("user");
  });

  it("upload (group note) stopped at storage-space-locked, admin changes the owner's plan and the group plan -> both settled (200)", async () => {
    await assignDuringUpload("group");
  });

  it("another connection holds FK KEY SHARE on the users and groups rows (uncommitted uploads/notes INSERT) -> both assignments settled", async () => {
    const { app, db } = await buildTestApp();
    const [admin, o] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: o.id });
    const plan = await giveUserQuota(db, o.id, 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("insert into uploads (note_id, uploader_id, mime, size) values ($1, $2, 'image/png', 1)", [n.id, o.id]);
      await holder.query("insert into notes (group_id, slug) values ($1, 'held')", [g.id]);
      const both = assignBoth(app, admin.id, { userId: o.id, groupId: g.id }, plan);
      pending.push(both.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, both)).toBe("settled");
      expect((await both).map(r => r.statusCode)).toEqual([200, 200]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});

describe("deleting a plan racing with assignment / default change (the FK decides on the DB side)", () => {
  // The holder transaction is always rolled back in finally (a harmless WARNING if already committed), so no connection returns to the pool with an unfinished transaction.
  it("another connection assigns a user to P (uncommitted) -> deleting P blocked -> the other commits -> 409 storage_plan_in_use", async () => {
    const { app, db } = await buildTestApp();
    const [admin, u] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update users set storage_plan_id = $1 where id = $2", [p, u.id]);
      const del = app.inject({ method: "DELETE", url: `/api/admin/storage-plans/${p}`, cookies: await cookieOf(admin.id) });
      pending.push(del.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      await holder.query("commit");
      const res = await del;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("storage_plan_in_use");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("another connection deletes P (uncommitted) -> assigning to P blocked -> the other commits -> 404 storage_plan_not_found", async () => {
    const { app, db } = await buildTestApp();
    const [admin, u] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("delete from storage_plans where id = $1", [p]);
      const asg = app.inject({ method: "PATCH", url: `/api/admin/users/${u.id}/storage-plan`, cookies: await cookieOf(admin.id), payload: { planId: p } });
      pending.push(asg.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, asg)).toBe("blocked");
      await holder.query("commit");
      const res = await asg;
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("storage_plan_not_found");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("another connection changes the user default to P (uncommitted) -> deleting P blocked (the subquery snapshot cannot see it) -> the other commits -> 409 storage_plan_is_default", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update site_settings set default_user_storage_plan_id = $1", [p]);
      const del = app.inject({ method: "DELETE", url: `/api/admin/storage-plans/${p}`, cookies: await cookieOf(admin.id) });
      pending.push(del.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      await holder.query("commit");
      const res = await del;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("storage_plan_is_default");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});

describe("small pool (max=3, connection-acquire timeout 2 s: borrowing a second connection inside a transaction shows as 500 instead of hanging)", () => {
  /** The app uses its own max=3 pool; seeding and probing use freshDb's pool (default 10) so they do not compete with it for connections. */
  async function smallPoolApp(opts: { hook?: GroupTestHook; limiters?: ReturnType<typeof freshLimiters> } = {}) {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 });
    const db = createDb(pool);
    const built = await buildTestApp({
      db, gate: new UserGate(db), ...RACE,
      ...(opts.hook ? { groupTestHook: opts.hook } : {}),
      ...(opts.limiters ? { limiters: opts.limiters } : {}),
    });
    return { ...built, seedDb: target.db, pool };
  }
  /**
   * The first transaction to take the space lock waits at the hook until 2 other connections are also waiting on the advisory lock (or
   * 5 s; normally it returns at once on seeing 2, 5 s only guards against false red when requests arrive late on slow machines), so all 3
   * connections are held by transactions at once. The wait count seen is stored in `ref.seen`: the final assertion is 2, proving the pool's
   * 3 connections really were in transactions at the same time (the barrier was not released by timeout).
   */
  const barrier = (ref: { pool?: Pool; seen?: number }): GroupTestHook => {
    let first = true;
    return async point => {
      if (point !== "storage-space-locked" || !first) return;
      first = false;
      ref.seen = await waitForAdvisoryWaiters(ref.pool!, 2, 5_000);
    };
  };

  it("max+1 concurrent uploads to the same space -> all 201; GET /api/storage works afterwards", async () => {
    const ref: { pool?: Pool; seen?: number } = {};
    const s = await smallPoolApp({ hook: barrier(ref) });
    ref.pool = s.seedDb.$client;
    try {
      const u = await seedUser(s.seedDb);
      await giveUserQuota(s.seedDb, u.id, null);
      const n = await seedNote(s.seedDb, { ownerId: u.id });
      const rs = await Promise.all(Array.from({ length: 4 }, () => upload(s.app, n.id, u.id, 100)));
      expect(rs.map(r => r.statusCode)).toEqual([201, 201, 201, 201]);
      expect(ref.seen).toBe(2);
      expect((await s.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    } finally {
      await s.pool.end();
    }
  });

  it("max+1 concurrent move-ins to the same group (each with attachments) -> all 200", async () => {
    const ref: { pool?: Pool; seen?: number } = {};
    const s = await smallPoolApp({ hook: barrier(ref) });
    ref.pool = s.seedDb.$client;
    try {
      const o = await seedUser(s.seedDb);
      const g = await seedGroup(s.seedDb, "G", [{ userId: o.id, role: "admin" }]);
      const ns = await Promise.all(Array.from({ length: 4 }, () => seedNote(s.seedDb, { ownerId: o.id })));
      for (const n of ns) await seedAttachment(s.seedDb, s.uploadsDir, n.id, o.id, 10);
      const rs = await Promise.all(ns.map(n => move(s.app, n.id, o.id, g.id)));
      expect(rs.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(ref.seen).toBe(2);
    } finally {
      await s.pool.end();
    }
  });

  it("copy of a note with many attachments (200): max+1 uploads to the same space plus 1 to another space fired while the copy is after copyFile and before taking the space lock (note-copy-files-copied) -> all finish before the copy is released, all 201", async () => {
    // copyFile holds no space lock. Uploads are fired from the copy's own hook so the interleaving is deterministic: in correct code the
    // copy takes only 1 connection and no space lock, the 5 uploads take turns on the remaining 2 connections and finish within the hook's
    // 4 s window; if the copy took the space lock before copyFile (a regression), same-space uploads would block on the lock holding those
    // 2 connections and the rest would time out borrowing a connection after 2 s -> 500.
    // Copy charges the upload bucket per attachment (200 > default UPLOAD_LIMIT 120): this case uses a big bucket (shape follows
    // freshLimiters({ upload }) in test/groups-v2-copy.test.ts).
    const box: { fired?: boolean; done?: boolean; reqs?: Array<Promise<LightMyRequestResponse>>; app?: FastifyInstance; a?: string; other?: string; an?: string; on?: string } = {};
    const hook: GroupTestHook = async point => {
      if (point !== "note-copy-files-copied" || box.fired) return;
      box.fired = true;
      box.reqs = [
        ...Array.from({ length: 4 }, () => upload(box.app!, box.an!, box.a!, 100)),
        upload(box.app!, box.on!, box.other!, 100),
      ];
      for (const r of box.reqs) pending.push(r.catch(() => {}));
      await Promise.race([
        Promise.allSettled(box.reqs).then(() => { box.done = true; }),
        new Promise(r => setTimeout(r, 4_000)),
      ]);
    };
    const s = await smallPoolApp({ hook, limiters: freshLimiters({ upload: new FixedWindowLimiter({ limit: 10_000, windowMs: 600_000 }) }) });
    box.app = s.app;
    try {
      const [a, other] = await Promise.all([seedUser(s.seedDb), seedUser(s.seedDb)]);
      await giveUserQuota(s.seedDb, a.id, null);
      const src = await seedNote(s.seedDb, { ownerId: a.id }, { title: "Big" });
      const ids: string[] = [];
      for (let i = 0; i < 200; i++) ids.push(await seedAttachment(s.seedDb, s.uploadsDir, src.id, a.id, 10));
      await seedDoc(s.seedDb, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
      const an = await seedNote(s.seedDb, { ownerId: a.id });
      const on = await seedNote(s.seedDb, { ownerId: other.id });
      Object.assign(box, { a: a.id, other: other.id, an: an.id, on: on.id });
      const cp = await copy(s.app, src.id, a.id);
      expect(box.fired).toBe(true);
      const ups = await Promise.all(box.reqs!);
      expect([cp.statusCode, ...ups.map(r => r.statusCode)]).toEqual([201, 201, 201, 201, 201, 201]);
      expect(box.done).toBe(true);
    } finally {
      await s.pool.end();
    }
  });
});
