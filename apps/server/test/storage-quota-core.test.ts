/**
 * `assertSpaceRoomInTx`／`storage/usage.ts` 直測（spec §5.3、§5.4、A4、§11.1 S15 函式層、Review Focus RF1）。
 * 交易一律 `db.transaction(tx => …)`（READ COMMITTED），另一方用另一條 pool 連線。
 */
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
const sqlShow = () => sql`show lock_timeout`; // `show` 的結果欄名就是設定名

describe("assertSpaceRoomInTx（spec §5.3）", () => {
  it("A4：incoming ≤ 0 → 不取鎖、不讀配額（另一交易持同空間鎖時也立刻回；已超額也不拋）", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 0);
    // 已超額（100 > 0）：若讀了配額與 SUM，`used + incoming > quota` 會拋——不拋才證明沒讀
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 100);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [spaceLockKey({ kind: "user", id: u.id })]);
      const t0 = Date.now();
      await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 0, opts));
      await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, -5, opts));
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("used + incoming == quota → 過；> quota → StorageQuotaExceeded（409、storage_quota_exceeded、帶 space／三數，數字 typeof number）", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, n.id, u.id, 600);
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 400, opts));
    const err = await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 401, opts)).catch(e => e);
    expect(err).toBeInstanceOf(StorageQuotaExceeded);
    expect(err).toMatchObject({ status: 409, errCode: "storage_quota_exceeded", message: "儲存空間已滿", usedBytes: 600, quotaBytes: 1000, incomingBytes: 401, space: { kind: "user", id: u.id } });
    for (const k of ["usedBytes", "quotaBytes", "incomingBytes"] as const) expect(typeof err[k], k).toBe("number");
  });

  it("群組空間只算群組筆記；個人空間只算 owner 的個人筆記；配額 NULL → 一律過", async () => {
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

  it("鎖後 SUM 看得到前一持鎖者已 commit 的列（兩句、READ COMMITTED）；縫在取鎖之後觸發一次、帶 hookCtx", async () => {
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
      // 斷言在 commit 前失敗時，別把持鎖、帶未提交列的交易還回 pool
      if (!committed) await holder.query("rollback");
      holder.release();
    }
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(700);
  });

  it("RF1：同一空間 id 大寫與小寫取的是同一把鎖（第二筆被擋）", async () => {
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
      // 縫在取鎖之後才觸發：第一筆進了縫＝已持鎖，再發第二筆（不數 pg_locks——整個 cluster 共用，平行的測試檔會干擾）
      await inHook;
      second = db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id.toLowerCase() }, 1, opts));
      expect(await waitForBlockedOrSettled(db.$client, second)).toBe("blocked");
    } finally {
      // 斷言失敗也要放行第一筆，否則它永遠停在縫上、持著連線，拖到 hook 逾時
      release();
    }
    await first;
    await second;
  });

  it("S15 函式層：lock_timeout 只罩取鎖那一句——等太久 → 55P03；取到之後回到維運者在 database 層設的值（不是硬寫 0）", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    // database 層設 7s（spec m6：`TO DEFAULT` 要回到這個值）；只有之後新開的連線吃得到，故另開 pool
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

  it("lockTimeoutMs 必須是正整數（0／負數／小數 → throw，不送進 PG）；預設值 5000", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: u.id }, 1, { lockTimeoutMs: bad })), String(bad)).rejects.toThrow(/lockTimeoutMs/);
    }
    expect(DEFAULT_STORAGE_LOCK_TIMEOUT_MS).toBe(5000);
  });
});

describe("storage/usage.ts（spec §5.4）", () => {
  it("readSpaceUsage：數字 typeof number、planName；不存在的空間 → null", async () => {
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

  it("canViewSpaceUsage：個人＝本人或站台 admin；群組＝manageGroup（含非成員站台 admin），一般成員與非成員 false；空間 id 大寫同效", async () => {
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
    // 空間 id 大寫（路由傳入原值）與小寫同效
    expect(await canViewSpaceUsage(db, me(owner), { kind: "user", id: owner.id.toUpperCase() })).toBe(true);
    expect(await canViewSpaceUsage(db, me(gAdmin), { kind: "group", id: g.id.toUpperCase() })).toBe(true);
  });

  it("listSpaceUsage：一次 GROUP BY；值 typeof number；沒有附件的空間不在 Map 裡", async () => {
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
