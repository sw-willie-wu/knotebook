import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";

describe("runMigrations", () => {
  it("migrate 兩次 idempotent 且 11 張表存在", async () => {
    const { db, pool } = await freshDb();
    await runMigrations(db); // freshDb 已跑過一次——此為第二次
    const r = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
    const tableNames = r.rows.map(x => x.table_name);
    for (const t of ["users", "instance_setup", "notes", "note_states", "note_state_backups", "note_shares", "note_links", "uploads", "ai_providers", "ai_models", "ai_actions"])
      expect(tableNames).toContain(t);
  });

  it("note_shares.role CHECK 拒絕非法值", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('a@example.com', 'A')`);
    const users = await pool.query(`select id from users limit 1`);
    const userId = users.rows[0].id;
    const note = await pool.query(`insert into notes (owner_id) values ($1) returning id`, [userId]);
    const noteId = note.rows[0].id;
    await expect(
      pool.query(`insert into note_shares (note_id, user_id, role) values ($1, $2, 'admin')`, [noteId, userId])
    ).rejects.toMatchObject({ code: "23514", constraint: "note_shares_role_chk" });
  });

  it("instance_setup.singleton CHECK 拒絕 false", async () => {
    const { pool } = await freshDb();
    await expect(
      pool.query(`insert into instance_setup (singleton) values (false)`)
    ).rejects.toMatchObject({ code: "23514", constraint: "instance_setup_singleton_chk" });
  });

  it("note_links_target_idx 存在（反向連結查詢用）", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(`select indexname from pg_indexes where tablename = 'note_links'`);
    const indexNames = r.rows.map(x => x.indexname);
    expect(indexNames).toContain("note_links_target_idx");
  });

  it("notes_owner_idx／note_shares_user_idx／uploads_note_idx 存在（Task 10 審查 I1：GET /api/notes 改 UNION ALL 兩支各自的 index scan 用）", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(
      `select tablename, indexname from pg_indexes where indexname in ('notes_owner_idx', 'note_shares_user_idx', 'uploads_note_idx')`
    );
    const indexNames = r.rows.map(x => x.indexname);
    expect(indexNames).toContain("notes_owner_idx");
    expect(indexNames).toContain("note_shares_user_idx");
    expect(indexNames).toContain("uploads_note_idx");
  });
});
