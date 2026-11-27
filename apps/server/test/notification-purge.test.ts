import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../src/db/index.js";
import { noteComments, notifications } from "../src/db/schema.js";
import { createNotificationPurger } from "../src/notifications/retention.js";
import { seedNamedUser } from "./comment-helpers.js";
import { seedNote, sleep } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";

const silent = pino({ level: "silent" }) as unknown as FastifyBaseLogger;
const setRetention = (db: Db, v: number | null) => db.execute(sql`update site_settings set notification_retention_days = ${v}`);
const count = async (db: Db) => (await db.$client.query(`select count(*)::int as n from notifications`)).rows[0].n as number;

async function scene(db: Db) {
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const note = await seedNote(db, { ownerId: alice.id });
  const [c] = await db.insert(noteComments).values({ noteId: note.id, authorId: alice.id, body: "hi" }).returning({ id: noteComments.id });
  const add = async (ago: string): Promise<string> => {
    const res = await db.$client.query<{ id: string }>(
      `insert into notifications (user_id, kind, note_id, comment_id, actor_id, created_at) values ($1, 'mention', $2, $3, $4, clock_timestamp() - $5::interval) returning id`,
      [bob.id, note.id, c!.id, alice.id, ago],
    );
    return res.rows[0]!.id;
  };
  return { add };
}

describe("expiry boundary", () => {
  it("default 30 days: 30 days + 1 minute goes, 30 days - 1 minute and fresh rows stay", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    const old = await add("30 days 1 minute");
    const edge = await add("29 days 23 hours 59 minutes");
    const fresh = await add("0 seconds");
    expect(await createNotificationPurger({ db, log: silent }).runOnce()).toBe(1);
    const left = (await db.select({ id: notifications.id }).from(notifications)).map(r => r.id).sort();
    expect(left).toEqual([edge, fresh].sort());
    expect(left).not.toContain(old);
  });
});

describe("a change of retention days takes effect on the next round", () => {
  it("NULL deletes nothing; back to 7 it deletes; shortening likewise", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    const purger = createNotificationPurger({ db, log: silent });
    await add("100 days");
    await setRetention(db, null);
    expect(await purger.runOnce()).toBe(0);
    expect(await count(db)).toBe(1);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);

    await add("10 days");
    await setRetention(db, 30);
    expect(await purger.runOnce()).toBe(0);
    await setRetention(db, 7);
    expect(await purger.runOnce()).toBe(1);
    expect(await count(db)).toBe(0);
  });
});

describe("per-round limit", () => {
  it("batchSize 2, maxBatches 3, 7 rows due -> 6 then 1", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    for (let i = 0; i < 7; i += 1) await add(`${40 + i} days`);
    const purger = createNotificationPurger({ db, log: silent, batchSize: 2, maxBatches: 3 });
    expect(await purger.runOnce()).toBe(6);
    expect(await purger.runOnce()).toBe(1);
  });

  it("batches take the oldest rows first", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    const oldest = await add("90 days");
    const middle = await add("60 days");
    const newest = await add("40 days");
    await createNotificationPurger({ db, log: silent, batchSize: 1, maxBatches: 1 }).runOnce();
    const left = (await db.select({ id: notifications.id }).from(notifications)).map(r => r.id).sort();
    expect(left).toEqual([middle, newest].sort());
    expect(left).not.toContain(oldest);
  });
});

describe("re-entry and stop", () => {
  it("two at once: the second returns 0, the total equals the number due", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    for (let i = 0; i < 3; i += 1) await add("40 days");
    const purger = createNotificationPurger({ db, log: silent });
    const [a, b] = await Promise.all([purger.runOnce(), purger.runOnce()]);
    expect(b).toBe(0);
    expect(a + b).toBe(3);
  });

  it("after stop() runOnce returns 0 and deletes nothing", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    await add("40 days");
    const purger = createNotificationPurger({ db, log: silent });
    await purger.stop();
    expect(await purger.runOnce()).toBe(0);
    expect(await count(db)).toBe(1);
  });
});

describe("log", () => {
  it("records the purged count", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    await add("40 days");
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ level: "info" }, sink) as unknown as FastifyBaseLogger;
    expect(await createNotificationPurger({ db, log }).runOnce()).toBe(1);
    expect(out).toContain('"purged":1');
  });

  it("an unreadable site_settings row: runOnce returns 0, warn { table }, nothing deleted", async () => {
    const { db } = await buildTestApp();
    const { add } = await scene(db);
    await add("40 days");
    await db.$client.query(`delete from site_settings`);
    const lines: Array<Record<string, unknown>> = [];
    const log = { warn: (o: Record<string, unknown>) => lines.push(o), info: () => undefined } as unknown as FastifyBaseLogger;
    expect(await createNotificationPurger({ db, log }).runOnce()).toBe(0);
    expect(lines).toEqual([{ table: "site_settings" }]);
    expect(await count(db)).toBe(1);
  });
});

describe("scheduling", () => {
  it("startNotificationPurge -> due rows disappear within 5 s; rows made after app.close() stay", async () => {
    const { app, db } = await buildTestApp({ startNotificationPurge: true, notificationPurgeFirstDelayMs: 50, notificationPurgeIntervalMs: 50 });
    const { add } = await scene(db);
    await add("40 days");
    await expect.poll(() => count(db), { timeout: 5_000 }).toBe(0);
    await app.close();
    await add("40 days");
    await sleep(300);
    expect(await count(db)).toBe(1);
  });

  it("without startNotificationPurge -> nothing scheduled", async () => {
    const { app, db } = await buildTestApp({ notificationPurgeFirstDelayMs: 50, notificationPurgeIntervalMs: 50 });
    const { add } = await scene(db);
    await add("40 days");
    await sleep(300);
    expect(await count(db)).toBe(1);
    await app.close();
  });
});
