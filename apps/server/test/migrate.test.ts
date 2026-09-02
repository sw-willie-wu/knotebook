import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoSlugFromTitle, validateHandle, validateSlug } from "@knotebook/shared";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { apiTokens, notes, oauthClients, oauthCodes, oauthRequests } from "../src/db/schema.js";

const drizzleDirForTest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** drizzle 對 `schema.ts` 的序列化；0009 的宣告漂移守衛拿它當比對基準。 */
const snapshot0009 = JSON.parse(
  readFileSync(path.join(drizzleDirForTest, "meta/0009_snapshot.json"), "utf8"),
) as { tables: Record<string, { checkConstraints?: Record<string, { name: string; value: string }> }> };
const pgDialect = new PgDialect();

describe("runMigrations", () => {
  it("migrate 兩次 idempotent 且 16 張表存在", async () => {
    const { db, pool } = await freshDb();
    await runMigrations(db); // freshDb 已跑過一次——此為第二次
    const r = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
    const tableNames = r.rows.map(x => x.table_name);
    for (const t of ["users", "instance_setup", "notes", "note_states", "note_state_backups", "note_shares", "note_links", "uploads", "ai_providers", "ai_models", "ai_actions", "handles", "api_tokens", "oauth_clients", "oauth_requests", "oauth_codes"])
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

/**
 * 0008_public-slug（#122 PR3 Task 1）。純加欄＋partial unique 索引，無 backfill——
 * 公開別名是顯式 opt-in（spec §4），既有列一律 NULL，故不需要 §7-H harness 的資料
 * 案例（沒有「舊資料要長出什麼值」的問題），形狀與語意案全部跑在 freshDb 上。
 */
describe("0008_public-slug", () => {
  it("notes.public_slug 欄形（nullable text）＋partial unique indexdef 全形", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'notes' and column_name = 'public_slug'`,
    );
    expect(cols).toHaveLength(1);
    // 無 DB default：不像 slug 有回滾窗期的 INSERT 相容問題——NULL 就是合法初值
    expect(cols[0]).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });

    // 釘 indexdef 全形（比照 notes_public_token_idx 慣例）：UNIQUE＋兩欄＋WHERE 缺一
    // 都是另一種語意（少 WHERE 時 pg 對 NULL 仍不互斥，但 partial 是明確意圖）
    const { rows: idx } = await pool.query(
      `select indexdef from pg_indexes where tablename = 'notes' and indexname = 'notes_owner_public_slug_idx'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/owner_id, public_slug/);
    expect(idx[0].indexdef).toMatch(/WHERE \(?public_slug IS NOT NULL\)?/);
  });

  it("per-user 唯一語意：同 owner 撞（constraint 名＝notes_owner_public_slug_idx）、跨 owner 共存、多列 NULL 共存", async () => {
    const { pool } = await freshDb();
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A'),
       ('00000000-0000-4000-8000-0000000000b1', 'b@example.com', 'B')`,
    );
    // 多列 NULL 共存（同 owner 兩篇未設別名互不干擾）。⚠ 這一格對非 partial 的
    // 普通 unique 也成立（pg 預設 NULLS DISTINCT）——真正釘 partial 的是上一案的
    // indexdef regex，這裡只是行為面的 sanity。
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'N1', 'n1'),
         ('00000000-0000-4000-8000-0000000000a1', 'N2', 'n2')`,
      ),
    ).resolves.toMatchObject({ rowCount: 2 });
    await pool.query(
      `insert into notes (owner_id, title, slug, public_slug) values
       ('00000000-0000-4000-8000-0000000000a1', 'X', 'x', 'same-alias')`,
    );
    // 跨 owner 同名別名：可共存（per-user 語意）
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000b1', 'Y', 'y', 'same-alias')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // 同 owner 同名別名：撞唯一索引——constraint 名是 T2 端點 409 public_slug_taken 的分流依據
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'Z', 'z', 'same-alias')`,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "notes_owner_public_slug_idx" });
  });

  it("public_slug 與私人 slug/prev/legacy 不同命名空間：同 owner 的別名可撞自己的私人 slug", async () => {
    // 這條釘住「別名唯一性只在 public_slug 欄內裁決」——若未來有人把兩欄折進同一把
    // 索引（或加跨欄檢查），公開別名跟私人 slug 會互相佔名，破 spec §4 的獨立欄位設計。
    const { pool } = await freshDb();
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A')`);
    await pool.query(
      `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'P', 'shared-name')`,
    );
    // 跨列形：Q 的別名撞 P 的私人 slug
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'Q', 'q', 'shared-name')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // 同列形（T2 上線後最常見的真實用法）：使用者把公開別名設成跟自己私人網址同名
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'R', 'r-note', 'r-note')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("schema.ts 宣告↔DB 對照：drizzle metadata 有同形的欄與索引（防 schema.ts 靜默漂移）", async () => {
    // 突變審 A1：本 describe 其他案全跑在「0008 SQL 造出的 DB」上，schema.ts 那半邊
    // 從不進測試路徑——把 publicSlug 欄與索引宣告整段刪掉，856 測＋typecheck 照樣全
    // 綠，但下一次 `db:generate` 會產出 DROP INDEX 的 migration（實測）。這裡用
    // drizzle 自己的 metadata 把宣告釘住，再與 DB 的實際索引名對照接起兩邊。
    const cfg = getTableConfig(notes);
    const col = cfg.columns.find(c => c.name === "public_slug");
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(false);
    const idx = cfg.indexes.find(i => i.config.name === "notes_owner_public_slug_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.columns.map(c => (c as { name?: string }).name)).toEqual(["owner_id", "public_slug"]);
    expect(idx!.config.where).toBeDefined();

    // 宣告的索引名集合 ⊆ DB 實際索引名集合（同一把名字真的存在於 migration 造出的 DB）
    const { pool } = await freshDb();
    const { rows } = await pool.query(`select indexname from pg_indexes where tablename = 'notes'`);
    const dbNames = rows.map((r: { indexname: string }) => r.indexname);
    for (const i of cfg.indexes) expect(dbNames).toContain(i.config.name);
  });

  it("查詢真的用得上索引：公開別名 JOIN（免登入面）的計畫走 notes_owner_public_slug_idx", async () => {
    // 比照 0007 的 by-path planner 守衛：公開端是免登入面，這條 JOIN 掉成 seq scan
    // 的代價比登入面更大。JOIN 形同 routes/public.ts 的 pathSpec.lookup（含
    // public_token 非空述詞）。
    const { pool } = await freshDb();
    await pool.query(`insert into users (id, email, display_name, handle) values
      ('00000000-0000-4000-8000-000000000001', 'pa@x.example', 'PA', 'alias-planner')`);
    await pool.query(
      `insert into notes (owner_id, title, slug, public_slug, public_token)
       select '00000000-0000-4000-8000-000000000001', 'T' || g, 's' || g, 'a' || g, 'tok' || g from generate_series(1, 5000) g`,
    );
    await pool.query(`analyze users`);
    await pool.query(`analyze notes`);
    const { rows } = await pool.query(
      `explain (costs off)
       select notes.id from notes join users on users.id = notes.owner_id
       where users.handle = 'alias-planner' and notes.public_slug = 'a1' and notes.public_token is not null`,
    );
    expect(rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n")).toContain("notes_owner_public_slug_idx");
  });

  it("0008 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0007）", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0008"));
    expect(entry, "0008 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * 0009（#107）：`api_tokens` 與 OAuth 三張表。
 *
 * OAuth 三張表在 #130 完全沒有寫入路徑（四張一次建齊只是為了讓 #132 不必再開一次
 * migration，空表無害），所以這個 describe 是它們在 DB 端的**唯一**結構守衛——
 * 另有一案用 `getTableConfig` 把 `schema.ts` 的宣告接回來（那四個 export 目前沒有
 * 任何程式碼 import，整段刪掉的話 typecheck 與其餘測試都不會紅）。
 */
describe("0009_api-tokens", () => {

  it("api_tokens 的 kind／scope CHECK 擋住非法值", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t1@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('ck','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    // ⚠ 其他欄位一律補到「只剩 kind 違反」——裸的 kind='bogus' 會同時違反 client／
    // refresh／expiry 三條（`(kind='pat') = (...)` 在 kind 非 pat 時變成 false=true），
    // 那時 constraint 名要看 Postgres 的評估順序，沒有規格保證。
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id, access_expires_at)
         values ($1,'bogus','n','notes:read','h1','r1','ck', now() + interval '1 day')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_kind_chk" });

    // 落庫形是**集合**：裸 'notes:write' 不是合法值（write 一定把 read 顯式補進去）
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:write','h2')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_scope_chk" });
  });

  it("kind='pat' 不得帶 client_id／refresh_token_hash；kind='oauth' 必須有到期", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t2@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, client_id) values ($1,'pat','n','notes:read','h3','c1')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_client_chk" });
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash) values ($1,'pat','n','notes:read','h4','r4')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_refresh_chk" });
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id) values ($1,'oauth','n','notes:read','h5','r5','c1')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_oauth_expiry_chk" });
  });

  it("不到期的 PAT 是合法列（access_expires_at 可 NULL——D4 的預設）", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t2b@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    // 這條是反向釘：CHECK 若寫成「所有 kind 都要有 access_expires_at」，每支預設 PAT
    // 都建不出來，而上面三條全是負向案，抓不到。
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','ok1')`,
      [userId]
    );
    const r = await pool.query(`select access_expires_at, last_used_at, created_at from api_tokens`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].access_expires_at).toBeNull();
    expect(r.rows[0].last_used_at).toBeNull();
    expect(r.rows[0].created_at).not.toBeNull(); // defaultNow()
  });

  it("api_tokens_oauth_user_client_uidx 只約束 oauth 列（I7 的結構性保證），pat 不受限", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t3@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    const oauthRow = (hash: string) =>
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id, access_expires_at)
         values ($1,'oauth','n','notes:read',$2,$3,'c1', now() + interval '1 day')`,
        [userId, hash, `r-${hash}`]
      );
    await oauthRow("oh1");
    await expect(oauthRow("oh2")).rejects.toMatchObject({
      code: "23505",
      constraint: "api_tokens_oauth_user_client_uidx",
    });
    // 同一使用者的 PAT 不受這條 partial index 約束（它的 client_id 是 NULL）
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','a','notes:read','ph1')`,
      [userId]
    );
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','b','notes:read','ph2')`,
      [userId]
    );
    const count = await pool.query(`select count(*)::int as c from api_tokens where user_id = $1 and kind = 'pat'`, [
      userId,
    ]);
    expect(count.rows[0].c).toBe(2);

    // ⚠ 上面「兩支 PAT 共存」**證明不了 partial**：PAT 的 client_id 是 NULL，而 PG 的
    // UNIQUE 預設 NULLS DISTINCT——把 WHERE 拿掉變成全表唯一，這一段照樣綠。要釘住
    // partial 只能看 DB 端的 indexdef 全形（比照 0008 的同族守衛）。
    const { rows: idxRows } = await pool.query(
      `select indexdef from pg_indexes where indexname = 'api_tokens_oauth_user_client_uidx'`
    );
    expect(idxRows).toHaveLength(1);
    expect(idxRows[0].indexdef).toContain("UNIQUE INDEX");
    // regex 刻意寬鬆（括號與 ::text cast 都可有可無）：同檔既有的 partial 守衛
    // （notes_legacy_slug_idx 等）就是這個寫法，PG 大版本改變 pg_get_expr 的渲染時
    // 才不會以「partial 不見了」的形式假紅。拿掉 WHERE 照樣會紅，鑑別力不變。
    expect(idxRows[0].indexdef, "WHERE 不可省——省了就變全表唯一").toMatch(
      /WHERE \(?kind = 'oauth'(::text)?\)?/
    );
  });

  it("access_token_hash 全域唯一（同一支 token 不可能對到兩列）", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t3b@example.com', 'T'), ('t3c@example.com','T2')`);
    const users = (await pool.query(`select id from users order by email`)).rows;
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','dup')`,
      [users[0].id]
    );
    // 連**不同使用者**都不能重用同一個 hash——Bearer 驗證是「拿 hash 查一列」，
    // 允許重複就會變成「同一串明文對到兩個身分」。
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','dup')`,
        [users[1].id]
      )
    ).rejects.toMatchObject({ code: "23505", constraint: "api_tokens_access_token_hash_unique" });
  });

  it("刪 oauth_clients 會 CASCADE 掉其 grant／request／code；刪 users 會 CASCADE 掉其 grant", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t4@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id, access_expires_at)
       values ($1,'oauth','n','notes:read','oh1','r1','c1', now() + interval '1 day')`,
      [userId]
    );
    await pool.query(
      `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, expires_at)
       values ('req1','c1','http://127.0.0.1:1/cb','ch','notes:read', now() + interval '10 minutes')`
    );
    await pool.query(
      `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at)
       values ('code1','c1',$1,'notes:read','http://127.0.0.1:1/cb','ch', now() + interval '10 minutes')`,
      [userId]
    );

    await pool.query(`delete from oauth_clients where client_id = 'c1'`);
    for (const table of ["api_tokens", "oauth_requests", "oauth_codes"]) {
      const left = await pool.query(`select count(*)::int as c from ${table}`);
      expect(left.rows[0].c, table).toBe(0);
    }

    // users 那一側：重建 client 與 code，再從**使用者**這一端刪。
    // 前半段先刪 client 已經把 oauth_codes 清空了，所以「刪 user 也會連帶清 code」
    // 那條 FK 從來沒被走過——admin 刪一個還有 pending code 的使用者會撞 FK 500。
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c2','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    await pool.query(
      `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at)
       values ('code2','c2',$1,'notes:read','http://127.0.0.1:1/cb','ch', now() + interval '10 minutes')`,
      [userId]
    );
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','ph9')`,
      [userId]
    );

    await pool.query(`delete from users where id = $1`, [userId]);
    for (const table of ["api_tokens", "oauth_codes"]) {
      const left = await pool.query(`select count(*)::int as c from ${table}`);
      expect(left.rows[0].c, table).toBe(0);
    }
    // client 本身不隨使用者消失（它不屬於任何人）
    const clients = await pool.query(`select count(*)::int as c from oauth_clients`);
    expect(clients.rows[0].c).toBe(1);
  });

  it("oauth_requests.state 的長度 CHECK（2048）與 NULL 都合法", async () => {
    const { pool } = await freshDb();
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    const insertState = (id: string, state: string | null) =>
      pool.query(
        `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, state, expires_at)
         values ($1,'c1','http://127.0.0.1:1/cb','ch','notes:read',$2, now() + interval '10 minutes')`,
        [id, state]
      );
    await insertState("r-null", null);
    await insertState("r-2048", "s".repeat(2048));
    await expect(insertState("r-2049", "s".repeat(2049))).rejects.toMatchObject({
      code: "23514",
      constraint: "oauth_requests_state_chk",
    });
  });

  it("oauth_requests／oauth_codes 的 scope 也有集合 CHECK", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t5@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    await expect(
      pool.query(
        `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, expires_at)
         values ('r1','c1','http://127.0.0.1:1/cb','ch','notes:write', now() + interval '10 minutes')`
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "oauth_requests_scope_chk" });
    await expect(
      pool.query(
        `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at)
         values ('c-1','c1',$1,'notes:write','http://127.0.0.1:1/cb','ch', now() + interval '10 minutes')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "oauth_codes_scope_chk" });
  });

  it("四格矩陣：kind='oauth' 少了 client_id／refresh_token_hash 也要被擋（雙向蘊含的另一半）", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t6@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    // 上面那一族只釘了「pat ⇒ 沒有 client／refresh」那半邊；把 CHECK 弱化成單向蘊含
    // （`kind <> 'pat' or client_id is null`）全部照樣綠。這兩格補的是「oauth ⇒ 兩者都有」，
    // 也就是 #132 的 /oauth/token 少塞一欄時該被擋下的那個形。
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, access_expires_at)
         values ($1,'oauth','n','notes:read','m1','mr1', now() + interval '1 day')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_client_chk" });
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, client_id, access_expires_at)
         values ($1,'oauth','n','notes:read','m2','c1', now() + interval '1 day')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_refresh_chk" });
  });

  it("client_name 與 api_tokens.name 有長度上限；redirect_uris 必須是 1..8 個元素的陣列", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t7@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;

    // DCR 是免認證端點，client_name 又要渲染在同意頁上——長度在 DB 端就擋。
    // ⚠ 用**邊界對**（64 過／65 紅）而不是「插 201 字」：後者對任何 64..200 之間的
    // 界線都會綠，界線值本身等於沒被釘住（曾因此讓一次 200→64 的半套回滾靜默通過）。
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('at-limit', $1, '["http://127.0.0.1:1/cb"]'::jsonb)`,
      ["n".repeat(64)]
    );
    await expect(
      pool.query(
        `insert into oauth_clients (client_id, client_name, redirect_uris) values ('over', $1, '["http://127.0.0.1:1/cb"]'::jsonb)`,
        ["n".repeat(65)]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "oauth_clients_name_chk" });
    await expect(
      pool.query(
        `insert into oauth_clients (client_id, client_name, redirect_uris) values ('empty', '', '["http://127.0.0.1:1/cb"]'::jsonb)`
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "oauth_clients_name_chk" });

    // 形狀：物件不是陣列、空陣列、超過 8 筆都不行
    for (const [id, uris] of [
      ["obj", `'{"a":1}'::jsonb`],
      ["empty-arr", `'[]'::jsonb`],
      // ::text 不可省——裸字面在 jsonb_agg 下 PG 判不出多型別參數（42P18），
      // 那會變成查詢錯誤而不是我們要驗的 CHECK 違反。
      ["too-many", `(select jsonb_agg('http://127.0.0.1:1/cb'::text) from generate_series(1,9))`],
    ] as const) {
      await expect(
        pool.query(`insert into oauth_clients (client_id, client_name, redirect_uris) values ($1,'n',${uris})`, [id]),
        id
      ).rejects.toMatchObject({ code: "23514", constraint: "oauth_clients_redirect_uris_chk" });
    }

    // 同一組邊界對。兩張表的上限必須一致——api_tokens.name 是 client_name 的快照，
    // 這邊較嚴的話 #132 複製時會撞 CHECK。
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat',$2,'notes:read','n64')`,
      [userId, "x".repeat(64)]
    );
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat',$2,'notes:read','n65')`,
        [userId, "x".repeat(65)]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_name_chk" });
  });

  it("refresh_token_hash 全域唯一，但多支 PAT 的 NULL 互不衝突（#132 的 I4 靠它只命中一列）", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t8@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','A','["http://127.0.0.1:1/cb"]'::jsonb), ('c2','B','["http://127.0.0.1:2/cb"]'::jsonb)`
    );
    const oauth = (hash: string, client: string) =>
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id, access_expires_at)
         values ($1,'oauth','n','notes:read',$2,'same-refresh',$3, now() + interval '1 day')`,
        [userId, hash, client]
      );
    await oauth("a1", "c1");
    // 不同 client 的兩個 grant 不受 oauth_user_client_uidx 約束，所以這一發撞的
    // 一定是 refresh_token_hash 的 UNIQUE（拿掉它這案就綠了）。
    await expect(oauth("a2", "c2")).rejects.toMatchObject({
      code: "23505",
      constraint: "api_tokens_refresh_token_hash_unique",
    });

    // 反向：多支 PAT 的 refresh_token_hash 都是 NULL，UNIQUE 不該擋（NULLS DISTINCT）
    for (const h of ["p1", "p2", "p3"])
      await pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read',$2)`,
        [userId, h]
      );
    const pats = await pool.query(`select count(*)::int as c from api_tokens where kind = 'pat'`);
    expect(pats.rows[0].c).toBe(3);
  });

  it("oauth_clients.last_used_at 是 NOT NULL DEFAULT now()（#132 的清理述詞不必處理 NULL）", async () => {
    const { pool } = await freshDb();
    // 與 api_tokens.last_used_at（nullable，NULL＝從未使用）刻意相反——這個差異是
    // 承重的設計決定，JSDoc 有寫，這裡是它的釘子。
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','A','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    const { rows } = await pool.query(`select last_used_at, created_at from oauth_clients`);
    expect(rows[0].last_used_at).not.toBeNull();
    await expect(
      pool.query(
        `insert into oauth_clients (client_id, client_name, redirect_uris, last_used_at) values ('c2','B','["http://127.0.0.1:2/cb"]'::jsonb, null)`
      )
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("六把索引都在（其中五把支撐 FK——CASCADE 刪除不該退化成全表掃描）", async () => {
    const { pool } = await freshDb();
    const { rows } = await pool.query(
      `select indexname from pg_indexes where tablename in ('api_tokens','oauth_requests','oauth_codes')`
    );
    const names = rows.map((r: { indexname: string }) => r.indexname);
    for (const i of [
      "api_tokens_user_idx",
      "api_tokens_client_idx",
      "api_tokens_oauth_user_client_uidx",
      "oauth_requests_client_idx",
      "oauth_codes_client_idx",
      "oauth_codes_user_idx",
    ])
      expect(names, i).toContain(i);
  });

  it("schema.ts 的四個宣告沒有靜默漂移（那四個 export 目前零 import，typecheck 保護不到）", async () => {
    // 比照 0008 的同族守衛：把 schema.ts 的宣告與 migration 造出來的 DB 對起來。
    // 沒有這一案的話，把 schema.ts 的四段 pgTable 整個刪掉，全套測試照樣綠——
    // 只有下一次 db:generate 會產出 DROP TABLE。
    const { pool } = await freshDb();
    const expectedColumns: Record<string, string[]> = {
      oauth_clients: ["client_id", "client_name", "redirect_uris", "created_at", "last_used_at"],
      api_tokens: [
        "id",
        "user_id",
        "kind",
        "name",
        "scope",
        "access_token_hash",
        "refresh_token_hash",
        "client_id",
        "access_expires_at",
        "last_used_at",
        "created_at",
      ],
      oauth_requests: ["id", "client_id", "redirect_uri", "code_challenge", "scope", "state", "expires_at"],
      oauth_codes: ["code_hash", "client_id", "user_id", "scope", "redirect_uri", "code_challenge", "expires_at"],
    };

    for (const [table, decl] of [
      ["oauth_clients", oauthClients],
      ["api_tokens", apiTokens],
      ["oauth_requests", oauthRequests],
      ["oauth_codes", oauthCodes],
    ] as const) {
      const cfg = getTableConfig(decl);
      // 宣告的欄名 = DB 的欄名 = 這裡寫死的期望（三方對齊，任一邊漂移就紅）
      const declared = cfg.columns.map(c => c.name).sort();
      const { rows } = await pool.query(
        `select column_name from information_schema.columns where table_name = $1`,
        [table]
      );
      const inDb = rows.map((r: { column_name: string }) => r.column_name).sort();
      expect(declared, table).toEqual(expectedColumns[table]!.slice().sort());
      expect(inDb, table).toEqual(expectedColumns[table]!.slice().sort());

      // 宣告的索引名都真的存在於 DB
      const idxRows = await pool.query(`select indexname from pg_indexes where tablename = $1`, [table]);
      const dbIdx = idxRows.rows.map((r: { indexname: string }) => r.indexname);
      for (const i of cfg.indexes) expect(dbIdx, `${table}.${i.config.name}`).toContain(i.config.name);

      // 宣告的 CHECK 名都真的存在於 DB
      const chkRows = await pool.query(
        `select conname from pg_constraint where conrelid = $1::regclass and contype = 'c'`,
        [table]
      );
      const dbChk = chkRows.rows.map((r: { conname: string }) => r.conname);
      for (const c of cfg.checks) expect(dbChk, `${table}.${c.name}`).toContain(c.name);

      // ⚠ **只比名字不夠**：把 schema.ts 某條 CHECK 的數字改掉而不重新 db:generate，
      // 名字仍在、DB 仍是舊值，上面每一條都綠——下一次 generate 才會靜默吐出一支
      // DROP/ADD CONSTRAINT。這個 PR 就踩過一次（長度上限 200↔64 的半套回滾）。
      // snapshot 是 drizzle 對 schema.ts 的序列化，逐字比對它＝真正的漂移守衛。
      const snapshotChecks = snapshot0009.tables[`public.${table}`]?.checkConstraints ?? {};
      expect(Object.keys(snapshotChecks).sort(), `${table} 的 CHECK 名集合`).toEqual(
        cfg.checks.map(c => c.name).sort()
      );
      for (const c of cfg.checks) {
        expect(pgDialect.sqlToQuery(c.value).sql, `${table}.${c.name} 的運算式`).toBe(
          snapshotChecks[c.name]!.value
        );
      }
    }

    // partial unique index 的形狀（拿掉 where 就變成全表唯一，PAT 會被誤擋）
    const apiCfg = getTableConfig(apiTokens);
    const uidx = apiCfg.indexes.find(i => i.config.name === "api_tokens_oauth_user_client_uidx");
    expect(uidx).toBeDefined();
    expect(uidx!.config.unique).toBe(true);
    expect(uidx!.config.where, "partial where 不可省略").toBeDefined();
    expect(uidx!.config.columns.map(c => (c as { name?: string }).name)).toEqual(["user_id", "client_id"]);
  });

  it("0009 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0007／0008）", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0009"));
    expect(entry, "0009 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
