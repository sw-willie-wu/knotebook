import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";

/**
 * #122 PR1 Task 1：§7-H migration 資料案例 harness 的自測（spec §7-H、plan Task 1）。
 *
 * 用途：0006+ 的 backfill 守衛需要「先建到第 N 支的 schema、塞舊資料、再跑目標
 * migration」——drizzle 的 `migrate()` 沒有跑到一半的參數，freshDb() 又無條件跑完。
 * `applyMigrationsThrough(pool, upToIdx)` 以 committed SQL 檔逐支重放（單一 tx）並寫
 * `drizzle.__drizzle_migrations` 記帳；之後對同一顆 DB 呼叫既有 `runMigrations` 就只會
 * 跑剩餘 pending（目標 migration 由它執行——天然單一 tx，`CONCURRENTLY` 自然紅）。
 *
 * ⚠ 記帳形承重（plan gate M1，對 drizzle-orm 0.44.7 dialect.js 核實）：跳過判準只看
 * 「order by created_at desc limit 1 的 created_at < folderMillis」——`created_at`
 * 必須寫 journal entry 的 `when`；寫 `Date.now()` 會讓之後的每一支 migration 被
 * **靜默跳過**（journal 的 when 都小於現在），整個守衛假綠。hash＝整份 .sql 檔文字
 * 的 sha256 hex（NOT NULL 必填但不參與跳過判準）。
 */

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

// JournalEntry／journalEntries／idxOfTag 由 helpers.ts 匯出（Task 2 起 migrate.test.ts 共用）。

describe("freshEmptyDb（不跑 migration 的乾淨 DB 入口）", () => {
  it("回來的 DB 沒有任何 public 表、也沒有 drizzle journal", async () => {
    const { pool } = await freshEmptyDb();
    const tables = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.rows[0].n).toBe(0);
    const drizzleSchema = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(drizzleSchema.rows[0].n).toBe(0);
  });
});

describe("applyMigrationsThrough（§7-H harness）", () => {
  it("重放 0..最末支後：抽樣形狀＋記帳形（created_at＝journal when；全等價由下方 M-2 案守）", async () => {
    const entries = journalEntries();
    const lastIdx = entries[entries.length - 1].idx;

    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, lastIdx);

    // 形狀抽樣：核心表都在、來自 0005_public-share 的 public_token 欄在（全等價由下面 M-2 案守）
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((row: { table_name: string }) => row.table_name);
    for (const expected of ["users", "notes", "note_shares", "note_states", "uploads"]) {
      expect(names, expected).toContain(expected);
    }
    const publicToken = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(publicToken.rows[0].n).toBe(1);

    // 記帳形：逐列 created_at＝journal when、hash＝整份 sql 的 sha256（獨立現算比對）
    const ledger = await pool.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
    expect(ledger.rows.length).toBe(entries.length);
    entries.forEach((entry, i) => {
      expect(Number(ledger.rows[i].created_at), entry.tag).toBe(entry.when);
      const sql = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8");
      expect(ledger.rows[i].hash, entry.tag).toBe(createHash("sha256").update(sql).digest("hex"));
    });
  });

  it("重放到最末支之後，runMigrations 視為已全跑（不重跑、不炸），且 seed 照常", async () => {
    const entries = journalEntries();
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, entries[entries.length - 1].idx);

    // 「誤判全沒跑過」的方向（會把已存在的表再 CREATE 而炸）由此斷言守；
    // created_at 寫錯的方向（靜默跳過）這裡觀察不到——由下面那案守。
    await expect(runMigrations(db)).resolves.toBeUndefined();

    const ledger = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(ledger.rows[0].n).toBe(entries.length);
    // runMigrations 尾端的 idempotent seed 有跑（內建 AI 動作存在）
    const actions = await pool.query(`SELECT count(*)::int AS n FROM ai_actions`);
    expect(actions.rows[0].n).toBeGreaterThan(0);
  });

  it("applyThrough(N-1) 之後 runMigrations 真的把剩餘 pending 跑完（M1 承重：created_at 寫錯的失效是**靜默跳過**，只有這案殺得掉——突變審查 F1；記帳筆數斷言與「最末支是誰」無關，migration 增加不漂移——讀碼審查 M-1）", async () => {
    const entries = journalEntries();
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, entries[entries.length - 2].idx);
    await runMigrations(db);
    // runMigrations 對每支真的執行的 migration 都會寫一列記帳——被靜默跳過就停在 N-1。
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(ledger.rows[0].n, "pending 必須被 runMigrations 跑完（被跳過＝Task 2 的資料案例守衛全假綠）").toBe(
      entries.length,
    );
  });

  it("中途失敗＝零殘留（全程單一 tx——spec §7-H 的結構不變量，CONCURRENTLY 自然紅靠它；突變審查 F2）", async () => {
    const entries = journalEntries();
    const { pool } = await freshEmptyDb();
    // PG 的 index 與 table 共用 relation 名稱空間：先佔掉 0001 要建的 index 名，
    // 讓重放在 0000 成功之後、0001 中途炸掉。
    await pool.query(`CREATE TABLE note_shares_user_idx (x int)`);
    await expect(applyMigrationsThrough(pool, entries[entries.length - 1].idx)).rejects.toThrow();

    const users = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(users.rows[0].n, "0000 建的表必須隨整個 tx rollback").toBe(0);
    const drizzleSchema = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(drizzleSchema.rows[0].n).toBe(0);
  });

  it("能造出「舊版 schema」的資料庫（tag 尋址釘死 0004/0005 這一對，migration 增加不漂移——讀碼審查 M-1）", async () => {
    // 0005_public-share 加了 notes.public_token——重放到 0004 必無、到 0005 必有。
    const at0004 = await freshEmptyDb();
    await applyMigrationsThrough(at0004.pool, idxOfTag("0004_email-lower-index"));
    const before = await at0004.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(before.rows[0].n).toBe(0);

    const at0005 = await freshEmptyDb();
    await applyMigrationsThrough(at0005.pool, idxOfTag("0005_public-share"));
    const after = await at0005.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'public_token'`,
    );
    expect(after.rows[0].n).toBe(1);
  });

  it("applyThrough(最末支) 與 freshDb 的 public schema **真等價**（欄位/索引/約束三份全比對——讀碼審查 M-2：抽樣比對下「掉每支最後一條語句」整族突變全活）", async () => {
    const entries = journalEntries();
    const replayed = await freshEmptyDb();
    await applyMigrationsThrough(replayed.pool, entries[entries.length - 1].idx);
    const reference = await freshDb();

    const columnsSql = `SELECT table_name, column_name, data_type, is_nullable, column_default
                        FROM information_schema.columns WHERE table_schema = 'public'
                        ORDER BY table_name, column_name`;
    const indexesSql = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`;
    const constraintsSql = `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
                            FROM pg_constraint WHERE connamespace = 'public'::regnamespace
                            ORDER BY tbl, conname`;

    for (const sql of [columnsSql, indexesSql, constraintsSql]) {
      const a = await replayed.pool.query(sql);
      const b = await reference.pool.query(sql);
      expect(a.rows).toEqual(b.rows);
    }
  });
});
