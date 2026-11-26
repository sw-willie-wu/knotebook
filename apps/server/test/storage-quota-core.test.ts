// Transactions are always `db.transaction(tx => ...)` (READ COMMITTED); the other side uses another pool connection.
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db/index.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { seedGroup, seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, seedAttachment, seedPlan, setUserPlan, usedOf } from "./storage-helpers.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS, StorageQuotaExceeded, assertSpaceRoomInTx } from "../src/storage/tx/quota.js";
import { canViewSpaceUsage, listSpaceUsage, readSpaceUsage } from "../src/storage/usage.js";
import { spaceLockKey } from "../src/storage/space.js";

const opts = { lockTimeoutMs: 60_000 };
const lockTimeoutOf = async (pool: Pool) => (await pool.query<{ lock_timeout: string }>("show lock_timeout")).rows[0]!.lock_timeout;
const sqlShow = () => sql`show lock_timeout`; // the result column of `show` is the setting name

describe("assertSpaceRoomInTx", () => {
  it("incoming <= 0 -> takes no lock and reads no quota (returns at once even when another transaction holds the same space lock; no throw when already over quota)", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 0);
    // Already over quota (100 > 0): if quota and SUM were read, `used + incoming > quota` would throw - not throwing proves they were not read.
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 100);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [spaceLockKey({ kind: "user", id: u.id })]);
      // Deterministic proof of "no lock taken" (no wall clock): the holder holds the lock, so any attempt to take it must wait - the
      // function's own limit is 1 ms and the transaction itself first runs `set local lock_timeout = '1ms'` (so a write that takes
      // the lock without set_config first cannot fall back to the session's 0 = wait forever), so taking the lock = immediate 55P03 -> red;
      // both committing proves no lock was taken. Independent of machine speed.
      // Also count the advisory locks this connection holds in the same transaction: blocks variants the above would not catch, such as
      // switching to pg_try_advisory_xact_lock or taking a different key.
      const noLock = { lockTimeoutMs: 1 };
      for (const incoming of [0, -5]) {
        await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '1ms'`);
          await assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, incoming, noLock);
          const held = await tx.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`);
          expect(held.rows[0]!.n, `incoming=${incoming}`).toBe(0);
        });
      }
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("used + incoming == quota -> passes; > quota -> StorageQuotaExceeded (409, storage_quota_exceeded, carries space and the three numbers, typeof number)", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 600);
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 400, opts));
    const err = await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 401, opts)).catch(e => e);
    expect(err).toBeInstanceOf(StorageQuotaExceeded);
    expect(err).toMatchObject({ status: 409, errCode: "storage_quota_exceeded", message: "This space's storage quota is full.", usedBytes: 600, quotaBytes: 1000, incomingBytes: 401, space: { kind: "user", id: u.id } });
    for (const k of ["usedBytes", "quotaBytes", "incomingBytes"] as const) expect(typeof err[k], k).toBe("number");
  });

  it("a group space counts only group notes; a personal space counts only the owner's personal notes; quota NULL -> always passes", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 500);
    await giveUserQuota(db, u.id, null);
    const pn = await seedNote(db, { ownerId: u.id });
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, pn.id, u.id, 10_000);
    await seedAttachment(db, uploadsDir, gn.id, u.id, 400);
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id }, 100, opts));
    await expect(db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id }, 101, opts))).rejects.toBeInstanceOf(StorageQuotaExceeded);
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 10 ** 12, opts));
  });

  it("after the lock, SUM sees rows committed by the previous lock holder (two statements, READ COMMITTED); the test hook fires once after taking the lock, with hookCtx", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    const holder = await db.$client.connect();
    const calls: unknown[] = [];
    let committed = false;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [spaceLockKey({ kind: "user", id: u.id })]);
      await holder.query("insert into uploads (note_id, uploader_id, mime, size) values ($1, $2, 'image/png', 700)", [n.id, u.id]);
      const pending = db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 400, {
        lockTimeoutMs: 60_000, hookCtx: { noteId: n.id }, hook: async (point, ctx) => { calls.push([point, ctx]); },
      })).catch(e => e);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      committed = true;
      const err = await pending;
      expect(err).toBeInstanceOf(StorageQuotaExceeded);
      expect(err).toMatchObject({ usedBytes: 700 });
      expect(calls).toEqual([["storage-space-locked", { noteId: n.id }]]);
    } finally {
      // If the assertion fails before commit, do not return the lock-holding, uncommitted transaction to the pool.
      if (!committed) await holder.query("rollback");
      holder.release();
    }
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(700);
  });

  it("the same space id in upper and lower case takes the same lock (the second one is blocked)", async () => {
    const { db } = await buildTestApp();
    const g = await seedGroup(db, "G", []);
    await giveGroupQuota(db, g.id, 1000);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inHook = new Promise<void>(r => { entered = r; });
    const first = db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id.toUpperCase() }, 1, {
      lockTimeoutMs: 60_000, hook: async () => { entered(); await gate; },
    }));
    let second: Promise<void> | undefined;
    try {
      // The test hook fires only after the lock is taken: the first one entering the hook holds the lock, then send the second (pg_locks is not counted - it is cluster-wide and parallel test files would interfere).
      await inHook;
      second = db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id.toLowerCase() }, 1, opts));
      expect(await waitForBlockedOrSettled(db.$client, second)).toBe("blocked");
    } finally {
      // Release the first even if the assertion fails, otherwise it stays on the hook holding a connection until the hook times out.
      release();
    }
    await first;
    await second;
  });

  it("function level: lock_timeout covers only the lock statement - waiting too long -> 55P03; after acquiring, it returns to the value the operator set at database level (not a hard-coded 0)", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    // The database-level setting is 7s (`TO DEFAULT` must return to it); only connections opened afterwards see it, hence a separate pool.
    const dbName = (await db.$client.query<{ d: string }>("select current_database() as d")).rows[0]!.d;
    await db.$client.query(`alter database "${dbName}" set lock_timeout = '7s'`);
    const pool2 = new Pool({ connectionString: url, max: 2 });
    try {
      const db2 = createDb(pool2);
      const before = await lockTimeoutOf(pool2);
      expect(before).toBe("7s");
      const holder = await db.$client.connect();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [spaceLockKey({ kind: "user", id: u.id })]);
        const err = await db2.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 1, { lockTimeoutMs: 200 })).catch(e => e);
        expect(err?.cause?.code ?? err?.code).toBe("55P03");
      } finally {
        await holder.query("rollback");
        holder.release();
      }
      let inside = "";
      await db2.transaction(async tx => {
        await assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 1, { lockTimeoutMs: 200 });
        inside = String((await tx.execute<{ lock_timeout: string }>(sqlShow())).rows[0]!.lock_timeout);
      });
      expect(inside).toBe(before);
      expect(await lockTimeoutOf(pool2)).toBe(before);
    } finally {
      await pool2.end();
      await db.$client.query(`alter database "${dbName}" reset lock_timeout`);
    }
  });

  it("lockTimeoutMs must be a positive integer (0/negative/fraction -> throw, not sent to PG); default 5000", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 1, { lockTimeoutMs: bad })), String(bad)).rejects.toThrow(/lockTimeoutMs/);
    }
    expect(DEFAULT_STORAGE_LOCK_TIMEOUT_MS).toBe(5000);
  });
});

describe("storage/usage.ts", () => {
  it("readSpaceUsage: numbers are typeof number, planName; missing space -> null", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    const planName = `core-${u.id.slice(0, 8)}`;
    const pid = await seedPlan(db, planName, 5000);
    await setUserPlan(db, u.id, pid);
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 1234);
    const r = await readSpaceUsage(db, { kind: "user", id: u.id });
    expect(r).toEqual({ usedBytes: 1234, quotaBytes: 5000, planId: pid, planName });
    expect(typeof r!.usedBytes).toBe("number");
    expect(typeof r!.quotaBytes).toBe("number");
    expect(await readSpaceUsage(db, { kind: "group", id: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  });

  it("canViewSpaceUsage: personal = the user or a site admin; group = manageGroup (including a non-member site admin), ordinary member and non-member false; an uppercase space id works the same", async () => {
    const { db } = await buildTestApp();
    const [owner, other, admin, gAdmin, gMember] = await Promise.all([seedUser(db), seedUser(db), seedUser(db, { isAdmin: true }), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    const me = (x: { id: string }, isAdmin = false) => ({ id: x.id, isAdmin });
    expect(await canViewSpaceUsage(db, me(owner), { kind: "user", id: owner.id })).toBe(true);
    expect(await canViewSpaceUsage(db, me(other), { kind: "user", id: owner.id })).toBe(false);
    expect(await canViewSpaceUsage(db, me(admin, true), { kind: "user", id: owner.id })).toBe(true);
    expect(await canViewSpaceUsage(db, me(gAdmin), { kind: "group", id: g.id })).toBe(true);
    expect(await canViewSpaceUsage(db, me(gMember), { kind: "group", id: g.id })).toBe(false);
    expect(await canViewSpaceUsage(db, me(other), { kind: "group", id: g.id })).toBe(false);
    expect(await canViewSpaceUsage(db, me(admin, true), { kind: "group", id: g.id })).toBe(true);
    expect(await canViewSpaceUsage(db, me(owner), { kind: "user", id: owner.id.toUpperCase() })).toBe(true);
    expect(await canViewSpaceUsage(db, me(gAdmin), { kind: "group", id: g.id.toUpperCase() })).toBe(true);
  });

  it("a single attachment row above 2^31 bytes is summed exactly and counts against the quota", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 3_500_000_000);
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 3_000_000_000);
    expect((await readSpaceUsage(db, { kind: "user", id: u.id }))?.usedBytes).toBe(3_000_000_000);
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 500_000_000, opts));
    await expect(db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 500_000_001, opts))).rejects.toBeInstanceOf(StorageQuotaExceeded);
  });

  it("listSpaceUsage: one GROUP BY; values typeof number; a space without attachments is not in the Map", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const na = await seedNote(db, { ownerId: a.id });
    await seedAttachment(db, uploadsDir, na.id, a.id, 3_000_000_000 / 2);
    await seedAttachment(db, uploadsDir, na.id, a.id, 3_000_000_000 / 2);
    const m = await listSpaceUsage(db, "user");
    expect(m.get(a.id)).toBe(3_000_000_000);
    expect(typeof m.get(a.id)).toBe("number");
    expect(m.has(b.id)).toBe(false);
  });
});
