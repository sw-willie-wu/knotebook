import type { FastifyBaseLogger } from "fastify";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";

export const NOTIFICATION_PURGE_INTERVAL_MS = 60 * 60_000;
export const NOTIFICATION_PURGE_FIRST_DELAY_MS = 5 * 60_000;
export const NOTIFICATION_PURGE_BATCH = 1000;
export const NOTIFICATION_PURGE_MAX_BATCHES = 20;

export interface NotificationPurgerDeps {
  db: Db;
  log: FastifyBaseLogger;
  batchSize?: number;
  maxBatches?: number;
}

export interface NotificationPurger {
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

export function createNotificationPurger(deps: NotificationPurgerDeps): NotificationPurger {
  const batchSize = deps.batchSize ?? NOTIFICATION_PURGE_BATCH;
  const maxBatches = deps.maxBatches ?? NOTIFICATION_PURGE_MAX_BATCHES;
  let running: Promise<number> | null = null;
  let stopping = false;

  /** Oldest first, so the subquery walks `notifications(created_at)` and stops at the batch size. */
  async function deleteBatch(retentionDays: number): Promise<number> {
    const res = await deps.db.execute(sql`
      delete from notifications
       where id in (
         select id from notifications
          where created_at < now() - (${retentionDays}::int * interval '1 day')
          order by created_at
          limit ${batchSize}
          for update skip locked)
    `);
    return res.rowCount ?? 0;
  }

  async function round(): Promise<number> {
    const [row] = await deps.db
      .select({ retentionDays: siteSettings.notificationRetentionDays })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    if (!row) {
      deps.log.warn({ table: "site_settings" }, "Notification cleanup: site settings row is missing, skipping this round");
      return 0;
    }
    if (row.retentionDays === null) return 0;
    let total = 0;
    try {
      for (let i = 0; i < maxBatches && !stopping; i += 1) {
        const n = await deleteBatch(row.retentionDays);
        total += n;
        if (n < batchSize) break;
      }
    } finally {
      // Earlier batches may already have committed when a later one fails: log the real count.
      deps.log.info({ purged: total }, "Notification cleanup: deleted expired notifications");
    }
    return total;
  }

  return {
    runOnce(): Promise<number> {
      if (running || stopping) return Promise.resolve(0);
      const p = round().finally(() => {
        running = null;
      });
      running = p;
      return p;
    },
    async stop(): Promise<void> {
      stopping = true;
      if (running) await running.catch(() => undefined);
    },
  };
}
