import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoSlugFromTitle, validateHandle, validateSlug } from "@knotebook/shared";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";

const drizzleDirForTest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("runMigrations", () => {
  it("migrate 兩次 idempotent 且 12 張表存在", async () => {
    const { db, pool } = await freshDb();
    await runMigrations(db); // freshDb 已跑過一次——此為第二次
    const r = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
    const tableNames = r.rows.map(x => x.table_name);
    for (const t of ["users", "instance_setup", "notes", "note_states", "note_state_backups", "note_shares", "note_links", "uploads", "ai_providers", "ai_models", "ai_actions", "handles"])
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

/**
 * 0006_user-handle（#122 PR1 Task 2）。形狀案跑在 freshDb（全 migration）上；backfill
 * 資料案例跑在 §7-H harness 上（freshEmptyDb → applyThrough(0005) → 塞 0005 形 fixture
 * → runMigrations 跑 0006 → 斷言），fixture 顯式指定 id 與 created_at 控制 DO 迴圈的
 * 確定性次序（plan gate M7——同 tx 插入的 created_at 全等，次序會由隨機 uuid 決定）。
 */
describe("0006_user-handle", () => {
  it("handles 表形狀：PK＋三個 CHECK（charset/長度、state 枚舉、released_at↔state 一致）", async () => {
    const { pool } = await freshDb();

    await pool.query(`insert into users (email, display_name) values ('h@example.com', 'H')`);
    const { rows } = await pool.query(`select id from users limit 1`);
    const userId = rows[0].id;

    // 合法列
    await pool.query(`insert into handles (handle, user_id, state) values ('ok-name', $1, 'live')`, [userId]);
    // charset/長度
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('BAD', $1, 'live')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_handle_chk" });
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('${"a".repeat(33)}', $1, 'live')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_handle_chk" });
    // state 枚舉
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('zombie-x', $1, 'zombie')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_state_chk" });
    // released_at↔state 一致（released 無時間戳／live 帶時間戳都拒）
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('tomb-x', $1, 'released')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_released_at_chk" });
    await expect(
      pool.query(
        `insert into handles (handle, user_id, state, released_at) values ('live-x', $1, 'live', now())`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_released_at_chk" });
    // PK＝配置裁決（含墓碑——released 列也占住名字）
    await pool.query(
      `insert into handles (handle, user_id, state, released_at) values ('tomb-ok', $1, 'released', now())`,
      [userId],
    );
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('tomb-ok', $1, 'live')`, [userId]),
    ).rejects.toMatchObject({ code: "23505", constraint: "handles_pkey" });
    // user_id **刻意零 FK**（registry-first 順序的結構前提，schema.ts 註解承重——讀碼審查 minor 3）
    const { rows: fks } = await pool.query(
      `select count(*)::int as n from pg_constraint where conrelid = 'handles'::regclass and contype = 'f'`,
    );
    expect(fks[0].n).toBe(0);
    // Task 4 額度查詢的反向索引（minor 7）
    const { rows: idx } = await pool.query(
      `select indexname from pg_indexes where tablename = 'handles' and indexname = 'handles_user_idx'`,
    );
    expect(idx).toHaveLength(1);
  });

  it("users.handle：NOT NULL＋DEFAULT（user-<uuid8> 形）＋users_handle_unique 是 **constraint 非 index**（判別契約鍵）", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select is_nullable, column_default from information_schema.columns
       where table_name = 'users' and column_name = 'handle'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].is_nullable).toBe("NO");
    expect(cols[0].column_default).toMatch(/gen_random_uuid/);

    // 判別契約（spec §2a M4-2）綁 constraint 名——pg_indexes 裡 UNIQUE constraint 與
    // UNIQUE INDEX 會同名出現，只有 pg_constraint.contype='u' 分得出來（不得落成 index）
    const { rows: cons } = await pool.query(
      `select contype from pg_constraint where conname = 'users_handle_unique'`,
    );
    expect(cons).toHaveLength(1);
    expect(cons[0].contype).toBe("u");

    // DB default 兜底（回滾窗期舊碼 insert 不帶 handle 也活）：值是 user-<uuid8> 形
    await pool.query(`insert into users (email, display_name) values ('d@example.com', 'D')`);
    const { rows } = await pool.query(`select handle from users where email = 'd@example.com'`);
    expect(rows[0].handle).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it("backfill 跨組撞名（round 1 C2 反例）：foo＋既有 foo-2＋第二個 foo → 三 handle 互異、第三人不劫 foo-2", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // 顯式 id＋遞增 created_at（M7：同 tx 的 now() 全等，次序會被隨機 uuid 決定）。
    // ⚠ **實體插入順序刻意與 created_at 順序相反**（突變審查 F1）：兩者同向時，DO 迴圈
    // 拿掉 ORDER BY 後 seq scan 恰好回同序、斷言照樣綠——反序才真的釘住「依 created_at
    // 排序」這條產品可見語意（舊帳號留乾淨名字）。
    await pool.query(
      `insert into users (id, email, display_name, created_at) values
       ('00000000-0000-4000-8000-000000000003', 'foo@z.example',   'C', '2026-01-03T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000002', 'foo-2@y.example', 'B', '2026-01-02T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000001', 'foo@x.example',   'A', '2026-01-01T00:00:00Z')`,
    );
    await runMigrations(db);

    const { rows } = await pool.query(`select email, handle from users order by created_at`);
    expect(rows.map((r: { handle: string }) => r.handle)).toEqual(["foo", "foo-2", "foo-3"]);
    // 次序無關的不變量雙保險：互異＋逐列合法＋registry 一一對應（live）
    const handles = rows.map((r: { handle: string }) => r.handle);
    expect(new Set(handles).size).toBe(3);
    for (const h of handles) expect(validateHandle(h), h).toBeNull();
    const { rows: reg } = await pool.query(
      `select u.handle from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg).toHaveLength(3);
  });

  it("backfill 截斷點落在 dash：截 30 後尾 dash 必 trim、產物過 validateHandle（plan gate M2-6）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // local-part＝29 個 a ＋ '-' ＋ tail → 截 30 恰好停在 '-' 上
    await pool.query(
      `insert into users (id, email, display_name, created_at) values
       ('00000000-0000-4000-8000-000000000011', '${"a".repeat(29)}-tail@x.example', 'T', '2026-01-01T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select handle from users`);
    expect(rows[0].handle).toBe("a".repeat(29));
    // registry 一一對應（突變審查 F2；join 形——只數 live 列數守不住 handle/user_id 對不上的形）
    const { rows: reg } = await pool.query(
      `select count(*)::int as n from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg[0].n).toBe(1);
  });

  it("backfill 退位形：uuid 形 local-part（截斷前判——plan 注意事項 9）、全符號、非 ASCII → user-<uuid8>", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // ⚠ 三個 id 的前 8 碼必須互異：退位形全走 user-<uuid8>，前 8 碼相同會讓 fallback
    // 互撞、backfill 正確地補 -2 尾碼，反而測不到「乾淨的 user-<uuid8> 形」（實踩過）。
    await pool.query(
      `insert into users (id, email, display_name, created_at) values
       ('11111111-0000-4000-8000-000000000021', '550e8400-e29b-41d4-a716-446655440000@x.example', 'U', '2026-01-01T00:00:00Z'),
       ('22222222-0000-4000-8000-000000000022', '!!!@x.example', 'S', '2026-01-02T00:00:00Z'),
       ('33333333-0000-4000-8000-000000000023', '日本語@x.example', 'J', '2026-01-03T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select id, handle from users order by created_at`);
    for (const row of rows as Array<{ id: string; handle: string }>) {
      expect(row.handle, row.id).toMatch(/^user-[0-9a-f]{8}$/);
      expect(row.handle).toBe(`user-${row.id.slice(0, 8)}`);
      expect(validateHandle(row.handle)).toBeNull();
    }
    // registry 一一對應（突變審查 F2）
    const { rows: reg } = await pool.query(
      `select count(*)::int as n from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg[0].n).toBe(3);
  });

  it("0006 檔內無 CONCURRENTLY（單一 tx 前提的輔助 grep——結構保證在 harness 的單 tx 執行）", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0006"));
    expect(entry, "0006 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    // COMMIT 的失效模式是**靜默**（drizzle 收尾 COMMIT 只 warn 不炸）——比 CONCURRENTLY
    // 更該釘；用行首語句形比對，避免被註解字面誤中（讀碼審查 minor 4）。
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * 0007_note-slug（#122 PR2 Task 2）。同 0006 慣例：形狀案跑 freshDb（全 migration）；
 * backfill 資料案例跑 §7-H harness（freshEmptyDb → applyThrough(0006) → 塞 0006 形
 * fixture → runMigrations 跑 0007 → 斷言），fixture 顯式指定 id 與 created_at 控制
 * DO 迴圈的確定性次序。
 */
describe("0007_note-slug", () => {
  it("notes 形狀：slug NOT NULL＋DEFAULT（untitled-<uuid8> 形）、slug_is_custom、三索引、舊全域索引退場", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
       where table_name = 'notes' and column_name in ('slug', 'slug_is_custom', 'prev_slug', 'legacy_slug')
       order by column_name`,
    );
    type ColRow = { column_name: string; is_nullable: string; column_default: string | null };
    expect((cols as ColRow[]).map(c => c.column_name)).toEqual([
      "legacy_slug", "prev_slug", "slug", "slug_is_custom",
    ]);
    const byName = Object.fromEntries((cols as ColRow[]).map(c => [c.column_name, c]));
    expect(byName.slug.is_nullable).toBe("NO");
    expect(byName.slug.column_default).toMatch(/gen_random_uuid/);
    expect(byName.slug_is_custom).toMatchObject({ is_nullable: "NO", column_default: "false" });
    expect(byName.prev_slug.is_nullable).toBe("YES");
    expect(byName.legacy_slug.is_nullable).toBe("YES");

    // DB default 兜底（回滾窗期舊碼 POST 不帶 slug 也活）：值是 untitled-<uuid8> 形
    await pool.query(`insert into users (email, display_name) values ('n@example.com', 'N')`);
    const { rows: u } = await pool.query(`select id from users limit 1`);
    await pool.query(`insert into notes (owner_id) values ($1)`, [u[0].id]);
    const { rows: n } = await pool.query(`select slug, slug_is_custom, prev_slug, legacy_slug from notes`);
    expect(n[0].slug).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(n[0]).toMatchObject({ slug_is_custom: false, prev_slug: null, legacy_slug: null });

    // 三索引釘 indexdef 全形（比照 notes_public_token_idx 慣例）；舊全域 notes_slug_idx 退場
    const { rows: idx } = await pool.query(
      `select indexname, indexdef from pg_indexes where tablename = 'notes'`,
    );
    const defs = Object.fromEntries(idx.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef]));
    expect(defs.notes_slug_idx).toBeUndefined();
    expect(defs.notes_owner_slug_idx).toMatch(/UNIQUE/);
    expect(defs.notes_owner_slug_idx).toMatch(/owner_id, slug/);
    expect(defs.notes_owner_slug_idx).not.toMatch(/WHERE/); // slug NOT NULL，全表唯一
    expect(defs.notes_legacy_slug_idx).toMatch(/UNIQUE/);
    expect(defs.notes_legacy_slug_idx).toMatch(/WHERE \(?legacy_slug IS NOT NULL\)?/);
    expect(defs.notes_owner_prev_slug_idx).not.toMatch(/UNIQUE/); // 同 owner 可先後釋放同名，>1 判定在查詢端
    expect(defs.notes_owner_prev_slug_idx).toMatch(/WHERE \(?prev_slug IS NOT NULL\)?/);
  });

  it("per-user 唯一語意：同 owner 撞（constraint 名＝notes_owner_slug_idx）、跨 owner 同名共存", async () => {
    const { pool } = await freshDb();
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A'),
       ('00000000-0000-4000-8000-0000000000b1', 'b@example.com', 'B')`,
    );
    await pool.query(
      `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'X', 'same-name')`,
    );
    // 跨 owner 同名：可共存（per-user 語意的正向證明）
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000b1', 'Y', 'same-name')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // 同 owner 同名：撞唯一索引，constraint 名是 PATCH 端 409 判別的依據
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'Z', 'same-name')`,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "notes_owner_slug_idx" });
  });

  it("legacy_slug 不可變 trigger：UPDATE 它必炸、UPDATE title/slug 不炸、pg_trigger 存在", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t@example.com', 'T')`);
    const { rows: u } = await pool.query(`select id from users limit 1`);
    await pool.query(`insert into notes (owner_id, title, slug) values ($1, 'T', 'keep-me')`, [u[0].id]);

    await expect(pool.query(`update notes set legacy_slug = 'hijack'`)).rejects.toMatchObject({
      message: expect.stringContaining("legacy_slug is immutable"),
    });
    // WHEN 條件：不動 legacy_slug 的常規 UPDATE 零成本通過
    await expect(pool.query(`update notes set title = 'T2', slug = 'renamed'`)).resolves.toMatchObject({
      rowCount: 1,
    });
    const { rows: trg } = await pool.query(
      `select tgname from pg_trigger where tgrelid = 'notes'::regclass and tgname = 'notes_legacy_slug_guard'`,
    );
    expect(trg).toHaveLength(1);
  });

  it("快照兩態：既有自訂 slug → custom=true＋legacy 凍結；無 slug 列 → custom=false＋legacy NULL", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'My Custom', 'my-custom', '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'Plain Note', null, '2026-01-02T00:00:00Z')`,
    );
    await runMigrations(db);

    const { rows } = await pool.query(`select slug, slug_is_custom, legacy_slug, prev_slug from notes order by created_at`);
    expect(rows[0]).toEqual({ slug: "my-custom", slug_is_custom: true, legacy_slug: "my-custom", prev_slug: null });
    expect(rows[1]).toEqual({ slug: "plain-note", slug_is_custom: false, legacy_slug: null, prev_slug: null });
  });

  it("雙 owner 同標題 → 各自得 foo（③drop 全域索引先於 backfill 的證明案）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-000000000001', 'a@x.example', 'A'),
       ('00000000-0000-4000-8000-000000000002', 'b@x.example', 'B')`,
    );
    // 若舊全域唯一索引在 backfill 時仍在場，第二個 owner 的 'foo' 直接炸——本案就是那個反例
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'Foo', null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000002', 'Foo', null, '2026-01-02T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select owner_id, slug from notes order by owner_id`);
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["foo", "foo"]);
  });

  it("同 owner 撞名去重：auto 撞既有自訂、created_at 序（物理插入序反向釘 ORDER BY）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    // 既有自訂 'foo' 占位；兩篇同標題 Foo 的 auto 列——**實體插入順序刻意與 created_at
    // 相反**（0006 慣例：同向時拿掉 ORDER BY 後 seq scan 恰好回同序、斷言照樣綠）。
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001', 'Foo', null, '2026-01-03T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', 'Foo', null, '2026-01-02T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', 'Anchor', 'foo', '2026-01-01T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select slug from notes order by created_at`);
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["foo", "foo-2", "foo-3"]);
    for (const r of rows as Array<{ slug: string }>) expect(validateSlug(r.slug)).toBeNull();
  });

  it("SQL/TS 雙實作對照：純 ASCII 標題集合，0007 產物與 autoSlugFromTitle 全等", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    // 每個標題各配一個 owner——退位形（new/空符號/uuid 形）全落 'untitled'，同 owner 會
    // 觸發去重尾碼、對照就失真。集合覆蓋：一般、大小寫混合、分隔摺疊、保留字、全符號、
    // uuid 形、截 60（Task 1 同值）、截斷點落 dash（Task 1 同值）。
    const titles = [
      "Hello World",
      "MiXeD CaSe 42",
      "  spaces   and---dashes  ",
      "new",
      "!!! ??? ***",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      // -<uuid> 尾綴形（非整串 uuid）——SQL 版少了這條檢查會產出與舊 /notes/<vanity>-<uuid>
      // 撞號的值，TS 版則退 untitled（突變審查 G3：整串 uuid 案殺不掉這刀）
      "Meeting f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "Q3 Planning Meeting Notes For The Whole Engineering Organization Retro",
      "a".repeat(59) + " bbbb",
    ];
    for (let i = 0; i < titles.length; i++) {
      const ownerId = `00000000-0000-4000-8000-0000000004${String(i).padStart(2, "0")}`;
      await pool.query(`insert into users (id, email, display_name) values ($1, $2, 'U')`, [ownerId, `u${i}@x.example`]);
      await pool.query(`insert into notes (owner_id, title, slug) values ($1, $2, null)`, [ownerId, titles[i]]);
    }
    await runMigrations(db);
    for (const title of titles) {
      const { rows } = await pool.query(`select slug from notes where title = $1`, [title]);
      expect(rows[0].slug, JSON.stringify(title)).toBe(autoSlugFromTitle(title));
    }
  });

  it("去重尾碼重截：長 base（59 字元）同 owner 撞名 → 第二篇恰 60 字元、與 TS 版同界", async () => {
    // 「重截基底使總長 ≤60」是 SQL/TS 兩份實作唯一必須對齊的算術；短 base（foo/untitled）
    // 的去重案測不到它——把 left(base, 60-length(...)) 改回 left(base, 60) 原本全綠
    // （突變審查 G4／讀碼審查 M2）。
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    const longTitle = "a".repeat(59) + " bbbb"; // 派生 base＝a×59（Task 1／矩陣測試同值）
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000001', $1, null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000001', $1, null, '2026-01-02T00:00:00Z')`,
      [longTitle],
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select slug from notes order by created_at`);
    expect(rows[0].slug).toBe("a".repeat(59));
    expect(rows[1].slug).toBe("a".repeat(58) + "-2"); // 58 + '-2' ＝ 恰 60
    for (const r of rows as Array<{ slug: string }>) expect(validateSlug(r.slug)).toBeNull();
  });

  it("非 ASCII 標題 → SQL 版一律 untitled 形（分岔政策；TS 版對 İstanbul 會給 istanbul——刻意分歧）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    // 同 owner 兩篇非 ASCII：第二篇吃去重尾碼——順帶釘 fallback 也走 owner 範圍去重
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000001', '日本語メモ', null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000001', 'İstanbul', null, '2026-01-02T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select slug from notes order by created_at`);
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["untitled", "untitled-2"]);
  });

  it("查詢真的用得上索引：舊形查找計畫走 notes_legacy_slug_idx（比照 #18 慣例）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    await pool.query(
      `insert into notes (owner_id, title, slug)
       select '00000000-0000-4000-8000-000000000001', 'T' || g, 's' || g from generate_series(1, 5000) g`,
    );
    await runMigrations(db); // 快照把 5000 個 slug 凍進 legacy_slug
    await pool.query(`analyze notes`);
    const { rows } = await pool.query(`explain (costs off) select id from notes where legacy_slug = 's1'`);
    expect(rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n")).toContain("notes_legacy_slug_idx");
  });

  it("查詢真的用得上索引：by-path 兩支（現行 slug／prev 補查）的計畫各走自己的索引（讀碼審查 m4）", async () => {
    // by-path 的 JOIN 形要 planner 從 users.handle 唯一鍵起算 nested loop 才吃得到
    // (owner_id, slug)——join 順序翻過來的話 `slug = $` 單獨吃不到這把索引，routes 註解
    // 的宣稱就靜默失效。比照 #18 慣例：seed 5000 列＋analyze 後驗 explain。
    const { pool } = await freshDb();
    await pool.query(`insert into users (id, email, display_name, handle) values
      ('00000000-0000-4000-8000-000000000001', 'p@x.example', 'P', 'planner-user')`);
    await pool.query(
      `insert into notes (owner_id, title, slug, prev_slug)
       select '00000000-0000-4000-8000-000000000001', 'T' || g, 's' || g, 'p' || g from generate_series(1, 5000) g`,
    );
    await pool.query(`analyze users`);
    await pool.query(`analyze notes`);

    const planOf = async (q: string): Promise<string> => {
      const { rows } = await pool.query(`explain (costs off) ${q}`);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    };
    expect(
      await planOf(
        `select notes.id from notes join users on users.id = notes.owner_id
         where users.handle = 'planner-user' and notes.slug = 's1'`,
      ),
    ).toContain("notes_owner_slug_idx");
    expect(
      await planOf(
        `select notes.id from notes join users on users.id = notes.owner_id
         where users.handle = 'planner-user' and notes.prev_slug = 'p1' limit 2`,
      ),
    ).toContain("notes_owner_prev_slug_idx");
  });

  it("0007 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0006）", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0007"));
    expect(entry, "0007 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
