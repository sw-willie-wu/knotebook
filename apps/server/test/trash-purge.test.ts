/** #181：保留期清理工作。 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { createTrashPurger } from "../src/trash/purge.js";
import { deleteUploadFiles, uploadFilePath } from "../src/uploads/service.js";
import { seedNote, seedUser, sleep, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { seedAttachment } from "./storage-helpers.js";
import { inject, markTrashed } from "./trash-helpers.js";

const silent = pino({ level: "silent" }) as unknown as FastifyBaseLogger;
const exists = async (db: Db, id: string) => (await db.$client.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;
const uploadRow = async (db: Db, id: string) => (await db.$client.query(`select 1 from uploads where id = $1`, [id])).rowCount === 1;
const setRetention = (db: Db, v: number | null) => db.execute(sql`update site_settings set trash_retention_days = ${v}`);
const expired = async (db: Db, owner: string, ago = "8 days") => {
  const n = await seedNote(db, { ownerId: owner });
  await markTrashed(db.$client, n.id, owner, ago);
  return n.id;
};

describe("PU1 到期邊界與附件", () => {
  it("停用帳號的筆記照樣清理；7 天＋1 分鐘前的刪、7 天－1 分鐘前與活筆記留下", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db, { disabled: true });
    const old = await seedNote(db, { ownerId: owner.id });
    await markTrashed(db.$client, old.id, owner.id, "7 days 1 minute");
    const up = await seedAttachment(db, uploadsDir, old.id, owner.id, 12);
    const fresh = await seedNote(db, { ownerId: owner.id });
    await markTrashed(db.$client, fresh.id, owner.id, "6 days 23 hours 59 minutes");
    const live = await seedNote(db, { ownerId: owner.id });
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);

    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, old.id)).toBe(false);
    expect(await uploadRow(db, up)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(false);
    expect(await exists(db, fresh.id)).toBe(true);
    expect(await exists(db, live.id)).toBe(true);
  });
});

describe("PU2 保留天數改動下一輪才生效", () => {
  it("NULL 不刪、改回 7 後刪；縮短同理", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    const a = await expired(db, owner.id, "30 days");
    await setRetention(db, null);
    expect(await purger.runOnce()).toBe(0);
    expect(await exists(db, a)).toBe(true);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, a)).toBe(false);

    const b = await expired(db, owner.id, "10 days");
    await setRetention(db, 30);
    expect(await purger.runOnce()).toBe(0);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, b)).toBe(false);
  });
});

describe("PU3 單輪上限", () => {
  it("batchSize 2、maxBatches 3，7 篇到期 → 6 再 1", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    for (let i = 0; i < 7; i += 1) await expired(db, owner.id);
    const purger = createTrashPurger({ db, log: silent, uploadsDir, batchSize: 2, maxBatches: 3 });
    expect(await purger.runOnce()).toBe(6);
    expect(await purger.runOnce()).toBe(1);
  });
});

describe("PU4 與還原併發（SKIP LOCKED）", () => {
  it("還原持鎖時 runOnce 回 0 且不等鎖；放行後 x 活著", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    const hook: GroupTestHook = async point => {
      if (point === "note-restore-locked") {
        entered();
        await gate;
      }
    };
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: hook });
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const restoring = inject(app, "POST", "/api/trash/restore", owner.id, { ids: [x] });
    await inside;
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    const run = purger.runOnce();
    expect(await waitForBlockedOrSettled(db.$client, run)).toBe("settled");
    expect(await run).toBe(0);
    release();
    const res = await restoring;
    expect(res.statusCode, res.body).toBe(200);
    expect(await exists(db, x)).toBe(true);
    const { rows } = await db.$client.query(`select deleted_at from notes where id = $1`, [x]);
    expect(rows[0].deleted_at).toBeNull();
  });
});

describe("PU5／PU6 重入與 stop", () => {
  it("兩發同時：第二發回 0、總數等於到期數；第二發根本沒開交易（SKIP LOCKED 之外另有重入擋）", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    for (let i = 0; i < 3; i += 1) await expired(db, owner.id);
    let txs = 0;
    const groupTestHook: GroupTestHook = async point => {
      if (point === "trash-purge-locked") txs += 1;
    };
    const purger = createTrashPurger({ db, log: silent, uploadsDir, groupTestHook });
    const [a, b] = await Promise.all([purger.runOnce(), purger.runOnce()]);
    expect(b).toBe(0);
    expect(a + b).toBe(3);
    expect(txs, "清理交易只開一次").toBe(1);
  });

  it("stop() 之後 runOnce 回 0、不刪", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    await purger.stop();
    expect(await purger.runOnce()).toBe(0);
    expect(await exists(db, x)).toBe(true);
  });
});

describe("PU7 log 不帶標題", () => {
  it("輸出含 purged:1、不含標題標記字串", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const marker = "SECRET-TITLE-MARKER-9f3a";
    const n = await seedNote(db, { ownerId: owner.id }, { title: marker });
    await markTrashed(db.$client, n.id, owner.id, "8 days");
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ level: "info" }, sink) as unknown as FastifyBaseLogger;
    expect(await createTrashPurger({ db, log, uploadsDir }).runOnce()).toBe(1);
    expect(out).toContain('"purged":1');
    expect(out).not.toContain(marker);
  });
});

describe("PU8 排程", () => {
  it("startTrashPurge → 到期筆記在 5 s 內消失；app.close() 之後新造的不被刪", async () => {
    const { app, db } = await buildTestApp({ startTrashPurge: true, trashPurgeFirstDelayMs: 50, trashPurgeIntervalMs: 50 });
    const owner = await seedUser(db);
    const a = await expired(db, owner.id);
    await expect.poll(() => exists(db, a), { timeout: 5_000 }).toBe(false);
    await app.close();
    const b = await expired(db, owner.id);
    await sleep(300);
    expect(await exists(db, b)).toBe(true);
  });

  it("沒有 startTrashPurge → 不排程", async () => {
    const { app, db } = await buildTestApp({ trashPurgeFirstDelayMs: 50, trashPurgeIntervalMs: 50 });
    const owner = await seedUser(db);
    const a = await expired(db, owner.id);
    await sleep(300);
    expect(await exists(db, a)).toBe(true);
    await app.close();
  });
});

describe("PU9 交易爆不先刪檔", () => {
  it("trigger raise → runOnce reject、列／uploads／磁碟檔都在；拿掉 trigger 再跑刪掉", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    const up = await seedAttachment(db, uploadsDir, x, owner.id, 12);
    await db.$client.query(
      `create function pu9_boom() returns trigger language plpgsql as $$ begin if old.id = '${x}' then raise exception 'pu9 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger pu9_trg before delete on notes for each row execute function pu9_boom()`);
    const purger = createTrashPurger({ db, log: silent, uploadsDir });
    await expect(purger.runOnce()).rejects.toThrow();
    expect(await exists(db, x)).toBe(true);
    expect(await uploadRow(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);
    await db.$client.query(`drop trigger pu9_trg on notes`);
    expect(await purger.runOnce()).toBe(1);
    expect(await exists(db, x)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(false);
  });
});

describe("PU10 刪檔失敗的 log 只記 name／code／uploadId（T9 concern 3）", () => {
  it("缺檔 → log.error 的物件鍵恰為 name、code、uploadId，沒有 err", async () => {
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "kn-pu10-"));
    const calls: unknown[] = [];
    await deleteUploadFiles(uploadsDir, ["00000000-0000-4000-8000-000000000001"], { error: obj => calls.push(obj) });
    expect(calls).toEqual([{ name: "Error", code: "ENOENT", uploadId: "00000000-0000-4000-8000-000000000001" }]);
  });
});

describe("PU11 讀不到 site_settings 列", () => {
  it("runOnce 回 0、warn { table }、不刪", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await expired(db, owner.id);
    await db.$client.query(`delete from site_settings`);
    const lines: Array<Record<string, unknown>> = [];
    const log = { warn: (o: Record<string, unknown>) => lines.push(o), info: () => undefined } as unknown as FastifyBaseLogger;
    expect(await createTrashPurger({ db, log, uploadsDir }).runOnce()).toBe(0);
    expect(lines).toEqual([{ table: "site_settings" }]);
    expect(await exists(db, x)).toBe(true);
  });
});

describe("PU12 第 k 批失敗仍記前面已刪的篇數", () => {
  it("batchSize 1、第二篇的刪除被 trigger 擋 → reject，log 有 purged:1", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    await expired(db, owner.id, "10 days");
    const y = await expired(db, owner.id, "9 days");
    await db.$client.query(
      `create function pu12_boom() returns trigger language plpgsql as $$ begin if old.id = '${y}' then raise exception 'pu12 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger pu12_trg before delete on notes for each row execute function pu12_boom()`);
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ level: "info" }, sink) as unknown as FastifyBaseLogger;
    await expect(createTrashPurger({ db, log, uploadsDir, batchSize: 1 }).runOnce()).rejects.toThrow();
    expect(out).toContain('"purged":1');
    expect(await exists(db, y)).toBe(true);
  });
});
