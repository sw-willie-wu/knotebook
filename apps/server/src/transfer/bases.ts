/**
 * bulk transfer：基底的寫入與清理。路由檔不開交易（單句多列 INSERT；S14）。
 * DB 錯誤只記 `pgErrorSummary`（`{code, constraint}`），不記原始 err（drizzle 的 message 帶 params）。
 */
import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/index.js";
import { transferBases } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";

export type TransferBaseInsert = typeof transferBases.$inferInsert;

/** 保留：`last_used_at` 超過 30 天刪；每 (user, note) 只留最新 10 列。 */
export const BASE_RETENTION_DAYS = 30;
export const BASES_PER_NOTE = 10;

/** 一句多列 INSERT（整包每批 ≤ 50 列）。失敗：只記 code／constraint，丟一個不帶 params 的 Error。 */
export async function insertBases(db: Db, log: FastifyBaseLogger, rows: TransferBaseInsert[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(transferBases).values(rows);
  } catch (err) {
    log.warn({ ...pgErrorSummary(err), rows: rows.length }, "寫入 transfer 基底失敗");
    throw new Error("insertBases failed");
  }
}

/**
 * fire-and-forget 清理：① 30 天沒用過的列 ② 這位讀者這幾篇各只留最新 10 列。兩句都 `for update skip locked`
 * （window function 不能與 FOR UPDATE 同句，所以 ② 先選 key、再鎖著刪）。失敗只 warn。
 */
export function pruneBases(db: Db, log: FastifyBaseLogger, userId: string, noteIds: string[]): void {
  void (async () => {
    await db.execute(
      sql`delete from ${transferBases} where ${transferBases.key} in (select ${transferBases.key} from ${transferBases} where ${transferBases.lastUsedAt} < now() - make_interval(days => ${BASE_RETENTION_DAYS}::int) for update skip locked)`,
    );
    if (noteIds.length === 0) return;
    const ids = sql.join(noteIds.map(id => sql`${id}::uuid`), sql`, `);
    const extra = await db.execute<{ key: string }>(
      sql`select t.key from (select ${transferBases.key} as key, row_number() over (partition by ${transferBases.noteId} order by ${transferBases.createdAt} desc, ${transferBases.key} desc) as rn from ${transferBases} where ${transferBases.userId} = ${userId} and ${transferBases.noteId} in (${ids})) t where t.rn > ${BASES_PER_NOTE}`,
    );
    const keys = extra.rows.map(r => r.key);
    if (keys.length === 0) return;
    const ks = sql.join(keys.map(k => sql`${k}`), sql`, `);
    await db.execute(
      sql`delete from ${transferBases} where ${transferBases.key} in (select ${transferBases.key} from ${transferBases} where ${transferBases.key} in (${ks}) for update skip locked)`,
    );
  })().catch((err: unknown) => {
    log.warn({ ...pgErrorSummary(err) }, "清理 transfer 基底失敗");
  });
}
