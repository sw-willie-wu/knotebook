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

  it("users_email_lower_idx 存在、蓋在 lower(email) 上、且**非唯一**（issue #18）", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(
      `select indexdef from pg_indexes where tablename = 'users' and indexname = 'users_email_lower_idx'`
    );
    expect(r.rowCount).toBe(1);
    const indexdef: string = r.rows[0].indexdef;
    expect(indexdef).toContain("lower(email)");
    // ⚠ 非唯一是刻意的：目前允許大小寫不同的重複 email 列存在，OIDC 的多列偵測
    // （oidc_conflict）依賴這個前提（docs/known-limitations.md）。改成 UNIQUE 會讓
    // 那條路徑從「可偵測的衝突」變成「寫入直接炸」——這條斷言就是防那個。
    expect(indexdef).not.toContain("UNIQUE");
  });

  it("lower(email) 的重複列仍可插入（oidc_conflict 偵測的前提不被新索引破壞）", async () => {
    // ⚠ 與上一條**合起來**才是完整防護、不可當重複刪掉（審查指出）：上一條只查
    // `users_email_lower_idx` 這個名字的 indexdef，若有人另外用別的名字加一個
    // lower(email) 的 UNIQUE 索引，上一條照樣綠——這一條的實際插入才擋得住。
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('Case@Example.com', 'A')`);
    // 同 lower() 值、不同大小寫——email 欄位本身的 UNIQUE 擋不到、新索引也不得擋。
    await expect(
      pool.query(`insert into users (email, display_name) values ('case@example.com', 'B')`)
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("查詢真的用得上索引：兩種實際查詢形狀的計畫都走 users_email_lower_idx（issue #18）", async () => {
    // 光斷言「索引存在」釘不住本 issue 的主張——把查詢改寫成 app 端先 lower、或加
    // COLLATE，索引還在、卻沒人用得上，CHANGELOG 的宣稱靜默失效（本 repo 的慣性缺陷
    // 形）。這裡 seed 5000 列 + analyze 後直接驗 planner 的選擇；兩種形狀對應真實
    // 呼叫點：登入／分享查人（ORDER BY + LIMIT 1）與 OIDC 連結（刻意不設上限，靠
    // 多列偵測 oidc_conflict）。審查已在 pg17 實測此斷言穩定不 flake。
    const { pool } = await freshDb();
    await pool.query(
      `insert into users (email, display_name)
       select 'u' || g || '@example.com', 'U' || g from generate_series(1, 5000) g`
    );
    await pool.query(`analyze users`);

    const planOf = async (sql: string): Promise<string> => {
      const { rows } = await pool.query(`explain (costs off) ${sql}`);
      return rows.map(r => r["QUERY PLAN"]).join("\n");
    };

    // 登入／分享查人的形狀（auth.ts / notes.ts）
    expect(
      await planOf(`select id from users where lower(email) = 'u1@example.com' order by created_at, id limit 1`)
    ).toContain("users_email_lower_idx");
    // OIDC 連結的形狀（oidc.ts：無 order/limit，允許多列）
    expect(await planOf(`select * from users where lower(email) = 'u1@example.com'`)).toContain(
      "users_email_lower_idx"
    );
  });

  it("notes.public_token 欄位＋partial unique index 存在（#72：NULL 不互斥、非 NULL 全域唯一）", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select data_type, is_nullable from information_schema.columns
       where table_name = 'notes' and column_name = 'public_token'`
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]).toEqual({ data_type: "text", is_nullable: "YES" });

    // 釘 indexdef 全形：UNIQUE ＋ WHERE 子句缺一都是另一種語意（無 WHERE 的
    // unique 對多筆 NULL 也成立於 pg，但寫成 partial 是明確意圖——比照
    // users_email_lower_idx 的「釘這個名字的 indexdef」慣例）。
    const { rows: idx } = await pool.query(
      `select indexdef from pg_indexes where tablename = 'notes' and indexname = 'notes_public_token_idx'`
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/WHERE \(?public_token IS NOT NULL\)?/);
  });
});
