/**
 * #397：`update` 的驗證、修改紀錄、並行與載入：
 * `SiteLimits.load`／`update` 接拋棄式 DB。actor 一律是本測試在同一個 DB 建的 admin（`site_limit_changes.actor_user_id`
 * 有外鍵）；只有「交易失敗」案刻意用不存在的 uuid。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SiteLimitKey } from "@knotebook/shared";
import { siteLimitChanges, siteLimits, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { LimitLockedError, LimitRangeError, LimitStepError } from "../src/site-limits/errors.js";
import { SiteLimits } from "../src/site-limits/store.js";
import type { LimitEnv } from "../src/site-limits/types.js";
import { freshDb, testConfig } from "./helpers.js";

interface LogLine {
  level: "warn" | "error";
  obj: object;
  msg: string;
}

function makeLog() {
  const lines: LogLine[] = [];
  return {
    lines,
    log: {
      warn: (obj: object, msg: string) => void lines.push({ level: "warn", obj, msg }),
      error: (obj: object, msg: string) => void lines.push({ level: "error", obj, msg }),
    },
  };
}

async function insertAdmin(db: Db): Promise<{ id: string }> {
  const [u] = await db
    .insert(users)
    .values({ email: `sl-admin-${randomUUID()}@example.com`, displayName: "Admin", isAdmin: true })
    .returning({ id: users.id });
  return u!;
}

async function setup(limitEnv: LimitEnv = {}) {
  const { db } = await freshDb();
  const admin = await insertAdmin(db);
  const { lines, log } = makeLog();
  const s = await SiteLimits.load(db, { limitEnv, machine: testConfig.machine, log });
  return { db, admin, s, lines, log };
}

const countRows = async (db: Db) => ({
  limits: (await db.select().from(siteLimits)).length,
  changes: (await db.select().from(siteLimitChanges)).length,
});

/** 回傳 update 丟出的錯誤（沒丟就 fail）。 */
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected update to reject");
}

describe("SiteLimits.update 的驗證", () => {
  it("update 擋越界／沒對齊／env 鎖，且什麼都不寫", async () => {
    const { db, admin, s } = await setup();
    const range = await caught(s.update(admin.id, { rateEdit: 2 }));
    expect(range).toBeInstanceOf(LimitRangeError);
    expect((range as LimitRangeError).key).toBe("rateEdit");
    const step = await caught(s.update(admin.id, { noteMaxBytes: 1048577 }));
    expect(step).toBeInstanceOf(LimitStepError);
    expect((step as LimitStepError).key).toBe("noteMaxBytes");

    const { log } = makeLog();
    const locked = await SiteLimits.load(db, { limitEnv: { noteMaxBytes: 2097152 }, machine: testConfig.machine, log });
    const lockErr = await caught(locked.update(admin.id, { noteMaxBytes: null }));
    expect(lockErr).toBeInstanceOf(LimitLockedError);
    expect((lockErr as LimitLockedError).key).toBe("noteMaxBytes");
    expect((lockErr as LimitLockedError).env).toBe("NOTE_MAX_BYTES");

    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });
    expect(s.get("rateEdit")).toBe(30);
    expect(s.get("noteMaxBytes")).toBe(5242880);
  });

  it("多個錯只報註冊表順序第一個；鎖先於範圍", async () => {
    const { db, admin, s } = await setup();
    const e1 = await caught(s.update(admin.id, { rateEdit: 2, noteMaxBytes: 1 }));
    expect(e1).toBeInstanceOf(LimitRangeError);
    expect((e1 as LimitRangeError).key).toBe("noteMaxBytes");

    const { log } = makeLog();
    const locked = await SiteLimits.load(db, { limitEnv: { noteMaxBytes: 2097152 }, machine: testConfig.machine, log });
    const e2 = await caught(locked.update(admin.id, { rateEdit: 2, noteMaxBytes: 2097152 }));
    expect(e2).toBeInstanceOf(LimitLockedError);
    expect((e2 as LimitLockedError).key).toBe("noteMaxBytes");
    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });
  });

  it("單一輪驗證", async () => {
    const { db, admin, s } = await setup();
    const e = await caught(s.update(admin.id, { noteMaxBytes: 1048577, rateEdit: 2 }));
    expect(e).toBeInstanceOf(LimitStepError);
    expect((e as LimitStepError).key).toBe("noteMaxBytes");
    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });
  });

  it("全有或全無", async () => {
    const { db, admin, s } = await setup();
    const e = await caught(s.update(admin.id, { rateEdit: 10, rateSearch: 1 }));
    expect(e).toBeInstanceOf(LimitRangeError);
    expect((e as LimitRangeError).key).toBe("rateSearch");
    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });
    expect(s.get("rateEdit")).toBe(30);
  });
});

describe("SiteLimits.update 的寫入與修改紀錄", () => {
  it("寫入＋紀錄", async () => {
    const { db, admin, s } = await setup();
    const [bystander] = await db
      .insert(siteLimitChanges)
      .values({ key: "rateAi", oldValue: null, newValue: 5, oldEffective: 30, newEffective: 5, actorUserId: admin.id })
      .returning();

    const view = await s.update(admin.id, { rateEdit: 10, noteMaxBytes: 2097152 });
    expect(s.get("rateEdit")).toBe(10);
    expect(s.get("noteMaxBytes")).toBe(2097152);
    expect(view.items.find(i => i.key === "rateEdit")).toMatchObject({ value: 10, source: "admin", stored: 10 });
    const stored = await db.select().from(siteLimits);
    expect(new Map(stored.map(r => [r.key, r.value]))).toEqual(new Map([["rateEdit", 10], ["noteMaxBytes", 2097152]]));

    const others = async () => (await db.select().from(siteLimitChanges)).filter(r => r.id !== bystander!.id);
    const recs = await others();
    expect(recs).toHaveLength(2);
    expect(recs[0]!.changedAt.getTime()).toBe(recs[1]!.changedAt.getTime());
    const byKey = new Map(recs.map(r => [r.key, r]));
    expect(byKey.get("rateEdit")).toMatchObject({ actorUserId: admin.id, oldValue: null, newValue: 10, oldEffective: 30, newEffective: 10 });
    expect(byKey.get("noteMaxBytes")).toMatchObject({ actorUserId: admin.id, oldValue: null, newValue: 2097152, oldEffective: 5242880, newEffective: 2097152 });

    // 旁觀者列逐欄不變。
    const [bAfter] = await db.select().from(siteLimitChanges).where(eq(siteLimitChanges.id, bystander!.id));
    expect(bAfter).toEqual(bystander);

    // 同值再 update → 不加列。
    await s.update(admin.id, { rateEdit: 10, noteMaxBytes: 2097152 });
    expect(await others()).toHaveLength(2);

    // null → 刪列、紀錄 new_value null、new_effective＝預設。
    await s.update(admin.id, { rateEdit: null });
    expect(s.get("rateEdit")).toBe(30);
    expect((await db.select().from(siteLimits).where(eq(siteLimits.key, "rateEdit"))).length).toBe(0);
    const after = await others();
    expect(after).toHaveLength(3);
    const restore = after.find(r => r.key === "rateEdit" && r.newValue === null);
    expect(restore).toMatchObject({ oldValue: 10, newValue: null, oldEffective: 10, newEffective: 30, actorUserId: admin.id });
    const [bFinal] = await db.select().from(siteLimitChanges).where(eq(siteLimitChanges.id, bystander!.id));
    expect(bFinal).toEqual(bystander);
  });

  it("存成等於預設的值", async () => {
    const { db, admin, s } = await setup();
    const calls: Array<ReadonlySet<SiteLimitKey>> = [];
    s.onChange(keys => void calls.push(keys));
    await s.update(admin.id, { rateEdit: 30 });
    const recs = await db.select().from(siteLimitChanges);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ key: "rateEdit", oldValue: null, newValue: 30, oldEffective: 30, newEffective: 30 });
    expect(s.view().items.find(i => i.key === "rateEdit")).toMatchObject({ value: 30, source: "admin", stored: 30 });
    expect(calls).toEqual([]);
  });

  it("null 設在沒列的 key", async () => {
    const { db, admin, s } = await setup();
    const calls: Array<ReadonlySet<SiteLimitKey>> = [];
    s.onChange(keys => void calls.push(keys));
    await expect(s.update(admin.id, { rateSearch: null })).resolves.toBeDefined();
    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });
    expect(calls).toEqual([]);
  });

  it("onChange 只發有變的 key，含連帶自動項", async () => {
    const { admin, s } = await setup();
    const calls: Array<ReadonlySet<SiteLimitKey>> = [];
    s.onChange(keys => void calls.push(keys));
    await s.update(admin.id, { parseTimeoutMs: 5000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(new Set(["parseTimeoutMs", "parseQueueWaitMs"]));
    expect(s.get("parseQueueWaitMs")).toBe(25000);
  });

  it("listener 拋錯不影響", async () => {
    const { admin, s, lines } = await setup();
    let second = 0;
    s.onChange(() => {
      throw new Error("boom");
    });
    s.onChange(() => {
      second++;
    });
    await expect(s.update(admin.id, { rateEdit: 10 })).resolves.toBeDefined();
    expect(second).toBe(1);
    const errs = lines.filter(l => l.level === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.msg).toBe("site limits onChange listener failed");
    expect((errs[0]!.obj as { err?: Error }).err?.message).toBe("boom");
    await expect(s.update(admin.id, { rateEdit: 20 })).resolves.toBeDefined();
    expect(s.get("rateEdit")).toBe(20);
    expect(second).toBe(2);
  });

  it("交易失敗：鎖放掉、記憶體不動", async () => {
    const { db, admin, s } = await setup();
    const err = (await caught(s.update("00000000-0000-0000-0000-000000000000", { rateEdit: 10 }))) as { code?: string; cause?: { code?: string } };
    expect(err.code ?? err.cause?.code, "actor 外鍵 23503").toBe("23503");
    expect(s.get("rateEdit")).toBe(30);
    expect(await countRows(db)).toEqual({ limits: 0, changes: 0 });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("鎖沒放：交易失敗後的下一次 update 2 秒內沒有 resolve")), 2000);
    });
    try {
      await Promise.race([s.update(admin.id, { rateEdit: 10 }), timeout]);
    } finally {
      clearTimeout(timer);
    }
    expect(s.get("rateEdit")).toBe(10);
  });

  it("並行：記憶體＝DB，紀錄串得起來（20 輪）", async () => {
    const { db, admin, s } = await setup();
    const u = (v: number) => s.update(admin.id, { rateEdit: v });
    for (let round = 0; round < 20; round++) {
      await s.update(admin.id, { rateEdit: null });
      await db.delete(siteLimitChanges);
      await Promise.all([u(10), u(20)]);

      const [row] = await db.select().from(siteLimits).where(eq(siteLimits.key, "rateEdit"));
      expect(row, `round ${round}`).toBeDefined();
      expect(s.get("rateEdit"), `round ${round}：記憶體＝DB`).toBe(row!.value);

      const recs = await db.select().from(siteLimitChanges);
      expect(recs, `round ${round}`).toHaveLength(2);
      const last = recs.find(r => r.newValue === row!.value)!;
      const first = recs.find(r => r !== last)!;
      expect(last, `round ${round}`).toBeDefined();
      expect(first, `round ${round}`).toBeDefined();
      expect({ oldValue: first.oldValue, oldEffective: first.oldEffective }, `round ${round}：前一筆從 null/30 起`).toEqual({ oldValue: null, oldEffective: 30 });
      expect({ oldValue: last.oldValue, oldEffective: last.oldEffective }, `round ${round}：紀錄串接`).toEqual({
        oldValue: first.newValue,
        oldEffective: first.newEffective,
      });
    }
  });
});

describe("SiteLimits.load", () => {
  it("load 忽略越界與未知列", async () => {
    const { db } = await freshDb();
    const admin = await insertAdmin(db);
    await db.insert(siteLimits).values([
      { key: "noteMaxBytes", value: 6291456 },
      { key: "bogusKey", value: 1 },
    ]);
    const { lines, log } = makeLog();
    const s = await SiteLimits.load(db, { limitEnv: {}, machine: testConfig.machine, log });
    expect(s.get("noteMaxBytes")).toBe(5242880);
    expect(s.view().items.find(i => i.key === "noteMaxBytes")).toMatchObject({ value: 5242880, source: "default", stored: 6291456, storedIgnored: true });
    const warns = lines.filter(l => l.level === "warn");
    expect(warns).toHaveLength(2);
    for (const w of warns) expect(w.msg).toBe("site limit stored value ignored");
    expect(warns.map(w => w.obj)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "noteMaxBytes", value: 6291456, min: 1048576, max: 5242880 }),
        expect.objectContaining({ key: "bogusKey", value: 1 }),
      ]),
    );

    await s.update(admin.id, { rateEdit: 10 });
    expect(s.get("rateEdit")).toBe(10);
    expect(s.get("noteMaxBytes")).toBe(5242880);
    expect(s.view().items.find(i => i.key === "noteMaxBytes")).toMatchObject({ value: 5242880, stored: 6291456, storedIgnored: true });
    const rows = new Map((await db.select().from(siteLimits)).map(r => [r.key, r.value]));
    expect(rows).toEqual(new Map([["noteMaxBytes", 6291456], ["bogusKey", 1], ["rateEdit", 10]]));
  });
});
