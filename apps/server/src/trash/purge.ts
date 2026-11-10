/**
 * #181：保留期清理。每輪最多 `maxBatches` 批，每批 `purgeExpiredBatchInTx`（SKIP LOCKED，到期判斷全在 DB 端）→ commit 後才刪磁碟檔。
 * 保留天數 NULL＝不自動刪。進行中再呼叫、或 `stop()` 之後，一律回 0。
 */
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { purgeExpiredBatchInTx } from "../notes/tx/trash.js";
import { deleteUploadFiles } from "../uploads/service.js";

export const TRASH_PURGE_INTERVAL_MS = 60 * 60_000;
export const TRASH_PURGE_FIRST_DELAY_MS = 5 * 60_000;
export const TRASH_PURGE_BATCH = 100;
export const TRASH_PURGE_MAX_BATCHES = 20;

export interface TrashPurgerDeps {
  db: Db;
  log: FastifyBaseLogger;
  uploadsDir: string;
  batchSize?: number;
  maxBatches?: number;
  groupTestHook?: GroupTestHook;
}

export interface TrashPurger {
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

export function createTrashPurger(deps: TrashPurgerDeps): TrashPurger {
  const batchSize = deps.batchSize ?? TRASH_PURGE_BATCH;
  const maxBatches = deps.maxBatches ?? TRASH_PURGE_MAX_BATCHES;
  let running: Promise<number> | null = null;
  let stopping = false;

  async function round(): Promise<number> {
    const [row] = await deps.db
      .select({ retentionDays: siteSettings.trashRetentionDays })
      .from(siteSettings)
      .where(eq(siteSettings.singleton, true))
      .limit(1);
    if (!row) {
      deps.log.warn({ table: "site_settings" }, "垃圾桶清理：站台設定遺失，略過這一輪");
      return 0;
    }
    if (row.retentionDays === null) return 0;
    const input = { retentionDays: row.retentionDays, limit: batchSize };
    let total = 0;
    try {
      for (let i = 0; i < maxBatches && !stopping; i += 1) {
        const out = await deps.db.transaction(tx => purgeExpiredBatchInTx(tx, input, deps.groupTestHook));
        await deleteUploadFiles(deps.uploadsDir, out.uploadIds, deps.log);
        total += out.noteIds.length;
        if (out.noteIds.length < batchSize) break;
      }
    } finally {
      // 第 k 批失敗時前 k-1 批已 commit：仍記下實際刪了幾篇。
      deps.log.info({ purged: total }, "垃圾桶清理：永久刪除到期筆記");
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
