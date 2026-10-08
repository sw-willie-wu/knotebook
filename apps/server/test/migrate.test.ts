import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PROVIDER_ICON_BYTES, autoSlugFromTitle, validateHandle, validateSlug } from "@knotebook/shared";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { apiTokens, authProviders, groupMembers, groupRoles, groups, noteRedirects, notes, oauthClients, oauthCodes, noteSearchSections, noteSearchState, oauthRequests, siteSettings, transferTokens, userIdentities } from "../src/db/schema.js";

const drizzleDirForTest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** drizzle 對 `schema.ts` 的序列化；宣告漂移守衛拿最新一支（0017）當比對基準。 */
const snapshot0017 = JSON.parse(
  readFileSync(path.join(drizzleDirForTest, "meta/0017_snapshot.json"), "utf8"),
) as { tables: Record<string, { checkConstraints?: Record<string, { name: string; value: string }> }> };
const pgDialect = new PgDialect();

describe("runMigrations", () => {
  it("migrate 兩次 idempotent 且 27 張表存在", async () => {
    const { db, pool } = await freshDb();
    await runMigrations(db); // freshDb 已跑過一次——此為第二次
    const r = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
    const tableNames = r.rows.map(x => x.table_name);
    for (const t of ["users", "instance_setup", "notes", "note_states", "note_state_backups", "note_shares", "note_links", "uploads", "ai_providers", "ai_models", "ai_actions", "handles", "api_tokens", "oauth_clients", "oauth_requests", "oauth_codes", "note_ai_edits", "groups", "group_members", "group_roles", "note_redirects", "auth_providers", "user_identities", "site_settings", "note_search_sections", "note_search_state", "transfer_tokens"])
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
    // 多列偵測 oidc_conflict）。審查已在 pg17 實測這兩種查詢形狀都穩定選中這把索引。
    const { pool } = await freshDb();
    // handle 明寫（非吃 DEFAULT 的 8-hex-字元 uuid 截斷）：5000 列吃 DEFAULT 有約
    // 0.29% 機率撞 users_handle_unique（生日問題，issue #150）——測試不在乎 handle
    // 是什麼，明寫成確定唯一的序號即可。
    await pool.query(
      `insert into users (email, display_name, handle)
       select 'u' || g || '@example.com', 'U' || g, 'u' || g from generate_series(1, 5000) g`
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

  it("schema.ts 的十五個宣告沒有靜默漂移（四個 OAuth／token 宣告零 import；#103／#175 的四張表的 CHECK 也在這裡逐字比對、#187 的三張表、#93 的兩張表、#200 的一張表）", async () => {
    // 比照 0008 的同族守衛：把 schema.ts 的宣告與 migration 造出來的 DB 對起來。
    // 沒有這一案的話，把 schema.ts 的四段 pgTable 整個刪掉，全套測試照樣綠——
    // 只有下一次 db:generate 會產出 DROP TABLE。
    // 守到的（schema.ts ↔ DB）：欄名集合、「宣告的索引名在 DB 裡存在」、「宣告的 CHECK 名在 DB 裡存在」。
    // 本案另比 schema.ts ↔ snapshot 的 CHECK 名集合與運算式（逐字）——那是 schema.ts ↔ snapshot，不是 ↔ DB。
    // 守不到的（#175 Task 1 審查 r1 M2／r2 M1 實測存活）：索引的形狀（unique／partial）、PK 與 FK（含 schema.ts 刪掉
    // `foreignKey` 宣告）、DB 裡多出一把 schema.ts 沒有的索引、DB（0012 SQL）裡的 CHECK 運算式與 schema.ts／snapshot
    // 不一致（人工重排的 SQL 改錯運算式）——後者只有 0012 describe 的 DB 守衛案守到它逐條測過的那幾個組合。
    // schema.ts ↔ snapshot 的完整等價（CHECK 以外）由 `drizzle-kit generate` 回「No schema changes」守（不看 DB）；
    // migration-harness 的 3-way 案比的是同一份 SQL 走 harness 與走 drizzle 兩條路的結果，不是 schema.ts ↔ DB。
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
        "agent_label",
        "created_at",
      ],
      oauth_requests: ["id", "client_id", "redirect_uri", "code_challenge", "scope", "state", "expires_at"],
      oauth_codes: ["code_hash", "client_id", "user_id", "scope", "redirect_uri", "code_challenge", "expires_at"],
      groups: ["id", "name", "created_by", "created_at"],
      group_members: ["group_id", "user_id", "role_id", "created_at"],
      group_roles: [
        "id", "group_id", "builtin", "name", "can_read", "can_create", "can_edit", "can_delete",
        "can_manage_public_link", "can_manage_members", "can_manage_group", "created_at",
      ],
      note_redirects: ["old_path", "note_id", "expires_at", "created_at"],
      auth_providers: [
        "id", "template", "display_name", "issuer_url", "resolved_issuer", "client_id", "client_secret_encrypted",
        "enabled", "sort_order", "legacy_callback", "config_version", "created_at", "updated_at",
        "icon_kind", "icon_data", "icon_mime", "icon_version",
      ],
      user_identities: ["id", "user_id", "issuer", "sub", "created_at", "last_login_at"],
      site_settings: ["singleton", "registration_enabled", "password_login_enabled", "legacy_oidc_env_handled_at", "updated_at"],
      note_search_sections: ["id", "note_id", "source_kind", "source_id", "section_id", "ord", "heading", "body"],
      note_search_state: ["note_id", "extractor_version", "source_version", "content_hash", "indexed_units", "capped", "indexed_at"],
      transfer_tokens: ["id", "token_hash", "parent_token_id", "note_id", "purpose", "expires_at", "consumed_at", "created_at"],
      notes: [
        "id", "owner_id", "title", "slug", "slug_is_custom", "prev_slug", "legacy_slug", "public_token", "public_slug",
        "links_clock", "created_at", "updated_at", "last_edited_at", "last_edited_by", "last_edited_token_id",
        "last_edited_agent_label", "deleted_at", "group_id",
      ],
    };

    for (const [table, decl] of [
      ["oauth_clients", oauthClients],
      ["api_tokens", apiTokens],
      ["oauth_requests", oauthRequests],
      ["oauth_codes", oauthCodes],
      ["groups", groups],
      ["group_members", groupMembers],
      ["group_roles", groupRoles],
      ["note_redirects", noteRedirects],
      ["notes", notes],
      ["auth_providers", authProviders],
      ["user_identities", userIdentities],
      ["site_settings", siteSettings],
      ["note_search_sections", noteSearchSections],
      ["note_search_state", noteSearchState],
      ["transfer_tokens", transferTokens],
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
      const snapshotChecks = snapshot0017.tables[`public.${table}`]?.checkConstraints ?? {};
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

  it("0010：note_ai_edits 的四條 CHECK 生效、revert_of CASCADE、note 刪除連帶刪紀錄、api_tokens.agent_label CHECK", async () => {
    const { pool } = await freshDb();
    const u = (await pool.query(`insert into users (email, handle, display_name) values ('a@x', 'a', 'A') returning id`)).rows[0].id;
    const n = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id;
    await expect(pool.query(`insert into note_ai_edits (note_id, user_id, op) values ($1,$2,'nope')`, [n, u])).rejects.toThrow(/note_ai_edits_op_chk/);
    await expect(pool.query(`insert into note_ai_edits (note_id, user_id, op, after_block_ids) values ($1,$2,'append','{a}')`, [n, u])).rejects.toThrow(/note_ai_edits_fingerprint_chk/);
    await expect(pool.query(`insert into note_ai_edits (note_id, user_id, op) values ($1,$2,'delete_section')`, [n, u])).rejects.toThrow(/note_ai_edits_anchor_chk/);
    const orig = (await pool.query(`insert into note_ai_edits (note_id, user_id, op, after_block_ids, after_fingerprint) values ($1,$2,'append','{a}','0000000000000000') returning id`, [n, u])).rows[0].id;
    await expect(pool.query(`insert into note_ai_edits (note_id, user_id, op) values ($1,$2,'revert')`, [n, u])).rejects.toThrow(/note_ai_edits_revert_chk/);
    const rev = (await pool.query(`insert into note_ai_edits (note_id, user_id, op, revert_of) values ($1,$2,'revert',$3) returning id`, [n, u, orig])).rows[0].id;
    await pool.query(`delete from note_ai_edits where id = $1`, [orig]);
    expect((await pool.query(`select 1 from note_ai_edits where id = $1`, [rev])).rowCount).toBe(0);
    await pool.query(`delete from notes where id = $1`, [n]);
    expect((await pool.query(`select 1 from note_ai_edits where note_id = $1`, [n])).rowCount).toBe(0);
    const t = (await pool.query(`insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','t','notes:read','h') returning id`, [u])).rows[0].id;
    await expect(pool.query(`update api_tokens set agent_label = 'bad label!' where id = $1`, [t])).rejects.toThrow(/api_tokens_agent_label_chk/);
    await expect(pool.query(`update api_tokens set agent_label = 'claude' where id = $1`, [t])).resolves.toBeTruthy();
  });

  it("0011 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0009）", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0011"));
    expect(entry, "0011 migration 必須存在").toBeDefined();
    expect(entry!.tag).toBe("0011_groups");
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("0011：套到既有資料上 group_id=null、group_role='editor'；三條 CHECK、兩條 CASCADE、兩條 SET NULL 生效", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0010_ai-editing"));
    const owner = (await pool.query(`insert into users (email, handle, display_name) values ('m@x', 'm0011', 'M') returning id`)).rows[0].id;
    const preexisting = (await pool.query(`insert into notes (owner_id, slug) values ($1, 'pre-0011') returning id`, [owner])).rows[0].id;
    // #175：停在 0011——runMigrations 會一路跑到 0012，而 0012 廢了 group_role、FK 改 RESTRICT。
    await applyMigrationsThrough(pool, idxOfTag("0011_groups"), idxOfTag("0011_groups"));

    expect((await pool.query(`select group_id, group_role from notes where id = $1`, [preexisting])).rows[0]).toEqual({
      group_id: null,
      group_role: "editor",
    });

    // CHECK：名稱 1..80 個字元（length() 數 code point——80 個 emoji 過得了，UTF-16 長度是 160）
    await expect(pool.query(`insert into groups (name) values ('')`)).rejects.toMatchObject({ code: "23514", constraint: "groups_name_chk" });
    await expect(pool.query(`insert into groups (name) values ($1)`, ["x".repeat(81)])).rejects.toMatchObject({ code: "23514", constraint: "groups_name_chk" });
    const g = (await pool.query(`insert into groups (name, created_by) values ($1, $2) returning id`, ["\u{1F600}".repeat(80), owner])).rows[0].id;
    await expect(pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`, [g, owner])).rejects.toMatchObject({ code: "23514", constraint: "group_members_role_chk" });
    await expect(pool.query(`update notes set group_role = 'owner' where id = $1`, [preexisting])).rejects.toMatchObject({ code: "23514", constraint: "notes_group_role_chk" });

    // 刪群組：notes.group_id SET NULL、group_members CASCADE
    await pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')`, [g, owner]);
    await pool.query(`update notes set group_id = $1 where id = $2`, [g, preexisting]);
    await pool.query(`delete from groups where id = $1`, [g]);
    expect((await pool.query(`select group_id from notes where id = $1`, [preexisting])).rows[0].group_id).toBeNull();
    expect((await pool.query(`select 1 from group_members where group_id = $1`, [g])).rowCount).toBe(0);

    // 刪使用者（一位沒有筆記的——notes.owner_id 是 RESTRICT）：groups.created_by SET NULL、group_members CASCADE
    const creator = (await pool.query(`insert into users (email, handle, display_name) values ('c@x', 'c0011', 'C') returning id`)).rows[0].id;
    const g2 = (await pool.query(`insert into groups (name, created_by) values ('G2', $1) returning id`, [creator])).rows[0].id;
    await pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')`, [g2, creator]);
    await pool.query(`delete from users where id = $1`, [creator]);
    expect((await pool.query(`select created_by from groups where id = $1`, [g2])).rows[0].created_by).toBeNull();
    expect((await pool.query(`select 1 from group_members where user_id = $1`, [creator])).rowCount).toBe(0);
  });
});

/**
 * #175 PR1：0012_groups-v2（spec §10）。五組 fixture（S／F2／F3／X1／X2）都跑在 §7-H harness 上：
 * applyThrough(0011) → 塞 0011 形資料 → runMigrations（0012、0013 pending）→ 逐欄比對。
 * fixture 與預期值逐字取自 spec gate r1–r3 的實跑（`175-spec-gate-r{1,2,3}-report.md`）。
 */
describe("0012_groups-v2（#175）", () => {
  const G = "11111111-1111-1111-1111-111111111111";
  const H = "22222222-2222-2222-2222-222222222222";
  const A = "00000000-0000-0000-0000-00000000000a";
  const B = "00000000-0000-0000-0000-00000000000b";
  const C = "00000000-0000-0000-0000-00000000000c";
  const n = (suffix: string) => `aaaaaaaa-0000-0000-0000-0000000000${suffix}`;

  async function migrateWith(fixtureSql: string): Promise<{ pool: import("pg").Pool }> {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0011_groups"));
    await pool.query(fixtureSql);
    await runMigrations(db);
    return { pool };
  }
  async function notesOf(pool: import("pg").Pool) {
    const { rows } = await pool.query(
      `select id, owner_id, group_id, slug, slug_is_custom, prev_slug, public_slug, public_token, legacy_slug from notes order by id`,
    );
    return rows as Array<Record<string, string | boolean | null>>;
  }
  async function redirectsOf(pool: import("pg").Pool) {
    const { rows } = await pool.query(`select old_path, note_id from note_redirects order by old_path`);
    return rows as Array<{ old_path: string; note_id: string }>;
  }
  const users3 = `insert into users (id, email, display_name, handle) values
    ('${A}','a@x','A','alice'), ('${B}','b@x','B','bob'), ('${C}','c@x','C','carol');`;

  it("S（spec §10.3）：群組內去重 meeting／meeting-3／meeting-2、個人 meeting-2 不動、轉址 4 列、群組筆記的 shares 與別名清空而個人筆記的 share／別名／prev 原樣保留、角色掛載", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name, created_by) values ('${G}','G','${A}'), ('${H}','Empty','${A}');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${G}','${B}','member'), ('${H}','${A}','admin');
      insert into notes (id, owner_id, title, slug, group_id, group_role, created_at, public_token, public_slug) values
        ('${n("01")}','${A}','m','meeting','${G}','editor', now()-interval '3 day', null, null),
        ('${n("02")}','${B}','m','meeting','${G}','viewer', now()-interval '2 day', null, null),
        ('${n("03")}','${B}','m2','meeting-2','${G}','editor', now()-interval '1 day','tok1','m2pub'),
        ('${n("04")}','${C}','c','carol-a1','${G}','editor', now(), null, null),
        ('${n("05")}','${A}','p','meeting-2', null,'editor', now(), null, null);
      -- 「不該動」方向（Task 1 審查 r1 I1）：個人筆記帶 share、公開別名、prev（prev 恰等於群組篇的 slug）
      insert into notes (id, owner_id, title, slug, slug_is_custom, prev_slug, group_id, public_token, public_slug) values
        ('${n("06")}','${A}','solo','solo', true,'meeting', null,'tokA','alice-pub');
      insert into note_shares (note_id, user_id, role) values ('${n("01")}','${C}','viewer'), ('${n("06")}','${B}','editor');`);

    const rows = await notesOf(pool);
    expect(rows.map(r => [r.id, r.owner_id, r.group_id, r.slug, r.prev_slug, r.public_slug, r.public_token])).toEqual([
      [n("01"), null, G, "meeting", null, null, null],
      [n("02"), null, G, "meeting-3", null, null, null],
      [n("03"), null, G, "meeting-2", null, null, "tok1"],
      [n("04"), null, G, "carol-a1", null, null, null],
      [n("05"), A, null, "meeting-2", null, null, null],
      [n("06"), A, null, "solo", "meeting", "alice-pub", "tokA"],
    ]);
    expect(await redirectsOf(pool)).toEqual([
      { old_path: "/n/alice/meeting", note_id: n("01") },
      { old_path: "/n/bob/meeting", note_id: n("02") },
      { old_path: "/n/bob/meeting-2", note_id: n("03") },
      { old_path: "/n/carol/carol-a1", note_id: n("04") },
    ]);
    // 群組筆記 n01 的 share 被清（S5），個人筆記 n06 的留著
    expect((await pool.query(`select note_id, user_id, role from note_shares order by note_id, user_id`)).rows).toEqual([
      { note_id: n("06"), user_id: B, role: "editor" },
    ]);
    const { rows: m } = await pool.query(
      `select gm.group_id, gm.user_id, r.builtin from group_members gm join group_roles r on r.id = gm.role_id order by 1, 2`,
    );
    expect(m).toEqual([
      { group_id: G, user_id: A, builtin: "admin" },
      { group_id: G, user_id: B, builtin: "member" },
      { group_id: H, user_id: A, builtin: "admin" },
    ]);
    // 每個群組恰兩個內建角色（空群組 Empty 也有），name 恆 NULL；七旗標照 §10.2 步驟 2
    const { rows: r } = await pool.query(
      `select group_id, builtin, name, can_read, can_create, can_edit, can_delete, can_manage_public_link, can_manage_members, can_manage_group
       from group_roles order by group_id, builtin`,
    );
    expect(r).toEqual([
      { group_id: G, builtin: "admin", name: null, can_read: true, can_create: true, can_edit: true, can_delete: true, can_manage_public_link: true, can_manage_members: true, can_manage_group: true },
      { group_id: G, builtin: "member", name: null, can_read: true, can_create: true, can_edit: true, can_delete: false, can_manage_public_link: false, can_manage_members: false, can_manage_group: false },
      { group_id: H, builtin: "admin", name: null, can_read: true, can_create: true, can_edit: true, can_delete: true, can_manage_public_link: true, can_manage_members: true, can_manage_group: true },
      { group_id: H, builtin: "member", name: null, can_read: true, can_create: true, can_edit: true, can_delete: false, can_manage_public_link: false, can_manage_members: false, can_manage_group: false },
    ]);
    // 轉址一個月（Q20）：expires_at 落在 now()+1 month 的 ±1 分鐘內
    const { rows: e } = await pool.query(
      `select bool_and(abs(extract(epoch from (expires_at - (now() + interval '1 month')))) < 60) as ok from note_redirects`,
    );
    expect(e[0].ok).toBe(true);
  });

  it("F2（gate r1 I1 反例）：被改名篇的原 owner 另有同名個人筆記 → migration 成功、bob 的群組篇 → meeting-2、個人 meeting-2 不動", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name) values ('${G}','G');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${G}','${B}','member');
      insert into notes (id, owner_id, title, slug, group_id, created_at) values
        ('${n("01")}','${A}','m','meeting','${G}', now()-interval '3 day'),
        ('${n("02")}','${B}','m','meeting','${G}', now()-interval '2 day'),
        ('${n("06")}','${B}','p','meeting-2', null, now());`);
    expect((await notesOf(pool)).map(r => [r.id, r.owner_id, r.group_id, r.slug])).toEqual([
      [n("01"), null, G, "meeting"],
      [n("02"), null, G, "meeting-2"],
      [n("06"), B, null, "meeting-2"],
    ]);
    expect((await redirectsOf(pool)).map(x => x.old_path)).toEqual(["/n/alice/meeting", "/n/bob/meeting"]);
  });

  it("F3：legacy 保留、群組筆記 prev 清空、別名清空 token 保留、A1 篇在、轉址只有現行 slug 3 列；個人筆記的舊 prev 不動", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name) values ('${G}','G');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${G}','${B}','member');
      insert into notes (id, owner_id, title, slug, slug_is_custom, prev_slug, legacy_slug, group_id, created_at, public_token, public_slug) values
        ('${n("01")}','${A}','m','plan', true,'old-plan','legacy-plan-x','${G}', now()-interval '3 day', null, null),
        ('${n("02")}','${B}','m','plan', false, null, null,'${G}', now()-interval '2 day','tokB','bobpub'),
        ('${n("03")}','${C}','c','a1-note', true,'a1-old', null,'${G}', now()-interval '1 day','tokC','carolpub'),
        ('${n("07")}','${A}','x','other', true,'plan', null, null, now(), null, null);`);
    expect((await notesOf(pool)).map(r => [r.id, r.owner_id, r.slug, r.slug_is_custom, r.prev_slug, r.public_slug, r.public_token, r.legacy_slug])).toEqual([
      [n("01"), null, "plan", true, null, null, null, "legacy-plan-x"],
      [n("02"), null, "plan-2", false, null, null, "tokB", null],
      [n("03"), null, "a1-note", true, null, null, "tokC", null],
      [n("07"), A, "other", true, "plan", null, null, null],
    ]);
    expect(await redirectsOf(pool)).toEqual([
      { old_path: "/n/alice/plan", note_id: n("01") },
      { old_path: "/n/bob/plan", note_id: n("02") },
      { old_path: "/n/carol/a1-note", note_id: n("03") },
    ]);
  });

  it("X1（gate r2）：較舊者（A1、custom、別名＋token）保留 spec；較新者跳過已佔的 -2 → spec-3；/n/carol/spec 轉址到較舊者", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name) values ('${G}','G');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${G}','${B}','member');
      insert into notes (id, owner_id, title, slug, slug_is_custom, group_id, created_at, public_token, public_slug) values
        ('${n("01")}','${C}','s','spec', true,'${G}', now()-interval '3 day','tokC','carol-spec'),
        ('${n("02")}','${B}','s','spec', false,'${G}', now()-interval '2 day', null, null),
        ('${n("03")}','${A}','s2','spec-2', false,'${G}', now()-interval '1 day', null, null);`);
    expect((await notesOf(pool)).map(r => [r.id, r.slug, r.slug_is_custom, r.public_slug, r.public_token])).toEqual([
      [n("01"), "spec", true, null, "tokC"],
      [n("02"), "spec-3", false, null, null],
      [n("03"), "spec-2", false, null, null],
    ]);
    expect(await redirectsOf(pool)).toEqual([
      { old_path: "/n/alice/spec-2", note_id: n("03") },
      { old_path: "/n/bob/spec", note_id: n("02") },
      { old_path: "/n/carol/spec", note_id: n("01") },
    ]);
  });

  it("X2（gate r2 I-1 反例）：只寫現行 slug 的轉址；沒有 /n/alice/z（z 仍是個人筆記 P 的活網址）；B、C 的舊 prev 失效", async () => {
    const { pool } = await migrateWith(`
      insert into users (id, email, display_name, handle) values ('${A}','a@x','A','alice');
      insert into groups (id, name) values ('${G}','G'), ('${H}','H');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${H}','${A}','admin');
      insert into notes (id, owner_id, title, slug, slug_is_custom, prev_slug, group_id, created_at) values
        ('${n("0a")}','${A}','A','x', true, null,'${G}', now()),
        ('${n("0b")}','${A}','B','y', true,'x','${H}', now()-interval '1 day'),
        ('${n("f0")}','${A}','P','z', true, null, null, now()),
        ('${n("0c")}','${A}','C','w', true,'z','${G}', now());`);
    expect(await redirectsOf(pool)).toEqual([
      { old_path: "/n/alice/w", note_id: n("0c") },
      { old_path: "/n/alice/x", note_id: n("0a") },
      { old_path: "/n/alice/y", note_id: n("0b") },
    ]);
    expect((await notesOf(pool)).filter(r => r.prev_slug !== null)).toEqual([]);
    expect((await notesOf(pool)).find(r => r.id === n("f0"))).toMatchObject({ owner_id: A, slug: "z" });
  });

  it("DB 守衛（spec §4.1／§4.2）：constraint 名逐一斷言（只斷 SQLSTATE 會假綠——gate r2 M-9）", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name) values ('${G}','G'), ('${H}','H');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${H}','${B}','admin');
      insert into notes (id, owner_id, title, slug, group_id) values ('${n("01")}','${A}','m','dup','${G}');`);
    const role = async (g: string, b: string) =>
      (await pool.query(`select id from group_roles where group_id = $1 and builtin = $2`, [g, b])).rows[0].id as string;
    const memberRoleG = await role(G, "member");
    const adminRoleH = await role(H, "admin");
    const cases: Array<[string, unknown[], string, string]> = [
      [`update group_roles set can_delete = false where group_id = $1 and builtin = 'admin'`, [G], "23514", "group_roles_admin_all_chk"],
      [`insert into group_roles (group_id, name, can_read, can_edit) values ($1, 'r', false, true)`, [G], "23514", "group_roles_read_implied_chk"],
      [`insert into group_roles (group_id, name, can_read, can_manage_public_link) values ($1, 'p', false, true)`, [G], "23514", "group_roles_read_implied_chk"],
      [`update group_roles set name = 'x' where id = $1`, [memberRoleG], "23514", "group_roles_name_chk"],
      [`insert into group_roles (group_id) values ($1)`, [G], "23514", "group_roles_name_chk"],
      [`insert into group_roles (group_id, name) values ($1, '')`, [G], "23514", "group_roles_name_len_chk"],
      [`insert into group_roles (group_id, name) values ($1, repeat('x', 41))`, [G], "23514", "group_roles_name_len_chk"],
      [`insert into group_roles (group_id, builtin) values ($1, 'owner')`, [G], "23514", "group_roles_builtin_chk"],
      [`insert into group_roles (group_id, builtin, can_read, can_create, can_edit, can_delete, can_manage_public_link, can_manage_members, can_manage_group) values ($1, 'admin', true, true, true, true, true, true, true)`, [G], "23505", "group_roles_builtin_idx"],
      [`update group_members set role_id = $1 where group_id = $2 and user_id = $3`, [adminRoleH, G, A], "23503", "group_members_role_fk"],
      [`insert into notes (owner_id, title, slug, group_id) values ($1, 't', 'xor', $2)`, [A, G], "23514", "notes_owner_xor_group_chk"],
      [`insert into notes (title, slug) values ('t', 'none')`, [], "23514", "notes_owner_xor_group_chk"],
      [`insert into notes (title, slug, group_id) values ('t', 'dup', $1)`, [G], "23505", "notes_group_slug_idx"],
      [`update notes set public_slug = 'p' where id = $1`, [n("01")], "23514", "notes_group_no_public_slug_chk"],
      [`delete from groups where id = $1`, [G], "23503", "notes_group_id_groups_id_fk"],
    ];
    for (const [sql, params, code, constraint] of cases) {
      await expect(pool.query(sql, params), sql).rejects.toMatchObject({ code, constraint });
    }
    // 自訂角色名：大小寫不同撞 group_roles_name_idx；兩個內建列 name 都 NULL 不互撞（上面 S 案已有兩列）
    await pool.query(`insert into group_roles (group_id, name) values ($1, 'Reader')`, [G]);
    await expect(pool.query(`insert into group_roles (group_id, name) values ($1, 'reader')`, [G])).rejects.toMatchObject({
      code: "23505",
      constraint: "group_roles_name_idx",
    });
    // 名稱長度上界本身合法（40 字）
    await pool.query(`insert into group_roles (group_id, name) values ($1, repeat('y', 40))`, [G]);
    // 仍有成員掛著的角色刪不掉（複合 FK 無 ON DELETE，§4.1；gate r1 A-N2）
    await expect(pool.query(`delete from group_roles where id = $1`, [adminRoleH])).rejects.toMatchObject({
      code: "23503",
      constraint: "group_members_role_fk",
    });
    // 個人與群組同 slug 並存；沒有筆記、但**還有成員**的群組可刪（T5 的真實形），成員與角色隨之 CASCADE
    await pool.query(`insert into notes (owner_id, title, slug) values ($1, 't', 'dup')`, [A]);
    const countIn = async (table: string) =>
      (await pool.query(`select count(*)::int as c from ${table} where group_id = $1`, [H])).rows[0].c as number;
    expect(await countIn("group_members")).toBe(1);
    await pool.query(`delete from groups where id = $1`, [H]);
    expect([await countIn("group_members"), await countIn("group_roles")]).toEqual([0, 0]);
    // note_redirects.note_id ON DELETE CASCADE（spec §4.3；審查 r1 M1）：0012 回填給 n01 的轉址隨筆記刪除消失
    const redirectsOfN01 = async () =>
      (await pool.query(`select old_path from note_redirects where note_id = $1`, [n("01")])).rows.map(r => r.old_path as string);
    expect(await redirectsOfN01()).toEqual(["/n/alice/dup"]);
    await pool.query(`delete from notes where id = $1`, [n("01")]);
    expect(await redirectsOfN01()).toEqual([]);
  });

  it("0012 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0011）", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0012"));
    expect(entry, "0012 migration 必須存在").toBeDefined();
    expect(entry!.tag).toBe("0012_groups-v2");
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * #175 PR3：0013_role-create-without-edit——拿掉 `group_roles_create_needs_edit_chk`（Willie 2026-10-01 裁決：新建不蘊含編輯）。
 */
describe("0013_role-create-without-edit（#175 PR3）", () => {
  it("0012 擋 create-only 角色；0013 之後放行，其餘 CHECK 仍在", async () => {
    const { db, pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0012_groups-v2"));
    const G = (await pool.query(`insert into groups (name) values ('G') returning id`)).rows[0].id as string;
    const createOnly = `insert into group_roles (group_id, name, can_read, can_create, can_edit) values ($1, 'c', true, true, false)`;
    await expect(pool.query(createOnly, [G])).rejects.toMatchObject({ code: "23514", constraint: "group_roles_create_needs_edit_chk" });

    await runMigrations(db);

    await pool.query(createOnly, [G]);
    const gone = await pool.query(`select count(*)::int as n from pg_constraint where conname = 'group_roles_create_needs_edit_chk'`);
    expect(gone.rows[0].n).toBe(0);
    await expect(
      pool.query(`insert into group_roles (group_id, name, can_read, can_edit) values ($1, 'r', false, true)`, [G]),
    ).rejects.toMatchObject({ code: "23514", constraint: "group_roles_read_implied_chk" });
  });
});

describe("0014_auth-providers（#187）", () => {
  const A = "00000000-0000-0000-0000-00000000000a";
  const B = "00000000-0000-0000-0000-00000000000b";
  const C = "00000000-0000-0000-0000-00000000000c";
  const P1 = "11111111-1111-1111-1111-111111111111";
  const P2 = "22222222-2222-2222-2222-222222222222";
  const SECRET = `'{"v":2,"keyId":"k","iv":"i","tag":"t","ct":"c"}'::jsonb`;

  async function migrateWith(fixtureSql: string): Promise<{ pool: import("pg").Pool }> {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0013_role-create-without-edit"));
    if (fixtureSql !== "") await pool.query(fixtureSql);
    await runMigrations(db);
    return { pool };
  }

  it("F1–F3：完整 oidc 欄 → 一列 identity（created_at 沿用）；純密碼 → 無；半套 → 無；舊欄原樣保留（B11）", async () => {
    const { pool } = await migrateWith(`
      insert into users (id, email, display_name, handle, oidc_issuer, oidc_sub, created_at) values
        ('${A}', 'a@x', 'A', 'alice', 'https://idp.example', 'sub-a', '2026-01-02T03:04:05Z'),
        ('${B}', 'b@x', 'B', 'bob', null, null, now()),
        ('${C}', 'c@x', 'C', 'carol', 'https://idp.example', null, now());`);
    const { rows } = await pool.query(
      `select user_id, issuer, sub, created_at = '2026-01-02T03:04:05Z'::timestamptz as same_created, last_login_at from user_identities order by user_id`,
    );
    expect(rows).toEqual([{ user_id: A, issuer: "https://idp.example", sub: "sub-a", same_created: true, last_login_at: null }]);
    const old = await pool.query(`select id, oidc_issuer, oidc_sub from users order by id`);
    expect(old.rows).toEqual([
      { id: A, oidc_issuer: "https://idp.example", oidc_sub: "sub-a" },
      { id: B, oidc_issuer: null, oidc_sub: null },
      { id: C, oidc_issuer: "https://idp.example", oidc_sub: null },
    ]);
    const idx = await pool.query(`select count(*)::int as n from pg_indexes where indexname = 'users_oidc_idx'`);
    expect(idx.rows[0].n).toBe(1);
  });

  it("F4：site_settings 恰一列、registration_enabled=true、password_login_enabled=true、legacy_oidc_env_handled_at NULL——instance_setup 有列或無列結果相同（W23／W24）", async () => {
    for (const fixture of ["", `insert into instance_setup (singleton) values (true);`]) {
      const { pool } = await migrateWith(fixture);
      const { rows } = await pool.query(`select singleton, registration_enabled, password_login_enabled, legacy_oidc_env_handled_at from site_settings`);
      expect(rows).toEqual([{ singleton: true, registration_enabled: true, password_login_enabled: true, legacy_oidc_env_handled_at: null }]);
      await expect(pool.query(`insert into site_settings (singleton) values (false)`)).rejects.toMatchObject({
        code: "23514",
        constraint: "site_settings_singleton_chk",
      });
      await expect(pool.query(`insert into site_settings (singleton) values (true)`)).rejects.toMatchObject({
        code: "23505",
        constraint: "site_settings_pkey",
      });
    }
  });

  it("F7（rev 10，W24）：password_login_enabled 遷移後為 true——instance_setup 有列或無列相同（全新與升級皆開）；欄位 NOT NULL（SET NULL 被拒）", async () => {
    // spec §11 F7：值與 F4 的期望列重疊（F4 也斷言 true），但突變表要有獨立一列——NOT NULL 只有本案守。PR1 的程式碼不讀這欄（§14.1 第 20 條）。
    for (const fixture of ["", `insert into instance_setup (singleton) values (true);`]) {
      const { pool } = await migrateWith(fixture);
      const { rows } = await pool.query(`select password_login_enabled from site_settings`);
      expect(rows).toEqual([{ password_login_enabled: true }]);
      await expect(pool.query(`update site_settings set password_login_enabled = null`)).rejects.toMatchObject({
        code: "23502",
        column: "password_login_enabled",
      });
    }
  });

  it("F5／F6 與其他 CHECK：啟用無 secret 被拒、第二個 legacy 被拒、issuer 513 字被拒、範本／顯示名／client id 守住（constraint 名逐一斷言）", async () => {
    const { pool } = await migrateWith("");
    const ins = (cols: string, vals: string) => pool.query(`insert into auth_providers (${cols}) values (${vals})`);
    const base = `id, template, display_name, issuer_url, client_id`;
    await expect(ins(`${base}, enabled`, `'${P1}', 'oidc', 'SSO', 'https://idp.example', 'c', true`)).rejects.toMatchObject({
      code: "23514",
      constraint: "auth_providers_enabled_secret_chk",
    });
    await ins(`${base}, enabled, client_secret_encrypted, legacy_callback`, `'${P1}', 'oidc', 'SSO', 'https://idp.example', 'c', true, ${SECRET}, true`);
    await expect(ins(`${base}, legacy_callback`, `'${P2}', 'oidc', 'SSO2', 'https://idp2.example', 'c', true`)).rejects.toMatchObject({
      code: "23505",
      constraint: "auth_providers_legacy_callback_idx",
    });
    // 非 legacy 的列可以有很多（partial unique 只約束 legacy_callback = true）。
    await ins(`${base}`, `'${P2}', 'gitlab', 'GitLab', 'https://gitlab.com', 'c'`);
    const cases: Array<[string, string]> = [
      [`'${randomUUID()}', 'github', 'X', 'https://x.example', 'c'`, "auth_providers_template_chk"],
      [`'${randomUUID()}', 'oidc', '', 'https://x.example', 'c'`, "auth_providers_display_name_chk"],
      [`'${randomUUID()}', 'oidc', '${"n".repeat(41)}', 'https://x.example', 'c'`, "auth_providers_display_name_chk"],
      [`'${randomUUID()}', 'oidc', 'X', 'ftp://x.example', 'c'`, "auth_providers_issuer_url_chk"],
      [`'${randomUUID()}', 'oidc', 'X', 'https://${"i".repeat(505)}', 'c'`, "auth_providers_issuer_url_chk"],
      [`'${randomUUID()}', 'oidc', 'X', 'https://x.example', ''`, "auth_providers_client_id_chk"],
    ];
    for (const [vals, constraint] of cases) {
      await expect(ins(base, vals), constraint).rejects.toMatchObject({ code: "23514", constraint });
    }
    // 512 字的 issuer 剛好放得下（r3-M3 的上界是閉區間）。
    await ins(base, `'${randomUUID()}', 'oidc', 'X', 'https://${"i".repeat(504)}', 'c'`);
    await expect(
      pool.query(`update auth_providers set resolved_issuer = $1 where id = '${P2}'`, ["https://" + "r".repeat(505)]),
    ).rejects.toMatchObject({ code: "23514", constraint: "auth_providers_resolved_issuer_chk" });
    const defaults = await pool.query(
      `select enabled, sort_order, legacy_callback, config_version, resolved_issuer from auth_providers where id = '${P2}'`,
    );
    expect(defaults.rows).toEqual([{ enabled: false, sort_order: 0, legacy_callback: false, config_version: 1, resolved_issuer: null }]);
  });

  it("user_identities：(issuer, sub) 全域唯一；同一人可多列；刪 users CASCADE", async () => {
    const { pool } = await migrateWith(`insert into users (id, email, display_name, handle) values ('${A}', 'a@x', 'A', 'alice'), ('${B}', 'b@x', 'B', 'bob');`);
    await pool.query(`insert into user_identities (user_id, issuer, sub) values ('${A}', 'https://i1', 's1'), ('${A}', 'https://i2', 's1')`);
    await expect(pool.query(`insert into user_identities (user_id, issuer, sub) values ('${B}', 'https://i1', 's1')`)).rejects.toMatchObject({
      code: "23505",
      constraint: "user_identities_issuer_sub_idx",
    });
    const idx = await pool.query(`select indexname from pg_indexes where tablename = 'user_identities' order by indexname`);
    expect(idx.rows.map(r => r.indexname)).toEqual(["user_identities_issuer_sub_idx", "user_identities_pkey", "user_identities_user_idx"]);
    await pool.query(`delete from users where id = '${A}'`);
    const left = await pool.query(`select count(*)::int as n from user_identities`);
    expect(left.rows[0].n).toBe(0);
  });

  it("0014 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0013 之前各支）", () => {
    // ⚠ 比對的是**全檔**（含 `--` 註解）：SQL 的註解裡不得寫出這兩個字——gate r1 t1-7 I1，舊版檔頭註解就因此必紅。
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0014_auth-providers.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0015_provider-icon（登入服務圖示，spec §3）", () => {
  const P = "33333333-3333-4333-8333-333333333333";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const insertBase = (pool: import("pg").Pool) =>
    pool.query(`insert into auth_providers (id, template, display_name, issuer_url, client_id) values ('${P}', 'oidc', 'SSO', 'https://idp.example', 'c')`);

  it("既有列（0014 時代建的，例如 env 匯入那一列）遷移後：icon_kind='template'、icon_version=0、icon_data／icon_mime 為 NULL（§3.3）", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0014_auth-providers"));
    await insertBase(pool);
    await runMigrations(db);
    const { rows } = await pool.query(`select icon_kind, icon_data, icon_mime, icon_version from auth_providers where id = '${P}'`);
    expect(rows).toEqual([{ icon_kind: "template", icon_data: null, icon_mime: null, icon_version: 0 }]);
  });

  it("S5 的 CHECK：每一形恰違反一條，constraint 名逐一斷言；合法形放行（含 262144 位元組上界）", async () => {
    const { pool } = await freshDb();
    await insertBase(pool);
    const upd = (set: string, params: unknown[] = []) => pool.query(`update auth_providers set ${set} where id = '${P}'`, params);
    const cases: Array<[string, unknown[], string]> = [
      ["icon_kind = 'upload'", [], "auth_providers_icon_upload_chk"],
      ["icon_kind = 'upload', icon_data = $1", [PNG], "auth_providers_icon_upload_chk"],
      ["icon_kind = 'upload', icon_mime = 'image/png'", [], "auth_providers_icon_upload_chk"],
      ["icon_kind = 'none', icon_mime = 'image/png'", [], "auth_providers_icon_upload_chk"],
      ["icon_kind = 'gitlab', icon_data = $1", [PNG], "auth_providers_icon_upload_chk"],
      ["icon_kind = 'svg'", [], "auth_providers_icon_kind_chk"],
      ["icon_kind = 'upload', icon_data = $1, icon_mime = 'image/gif'", [PNG], "auth_providers_icon_mime_chk"],
      ["icon_kind = 'upload', icon_data = $1, icon_mime = 'image/png'", [Buffer.alloc(MAX_PROVIDER_ICON_BYTES + 1)], "auth_providers_icon_size_chk"],
    ];
    for (const [set, params, constraint] of cases) {
      await expect(upd(set, params), set).rejects.toMatchObject({ code: "23514", constraint });
    }
    await upd("icon_kind = 'upload', icon_data = $1, icon_mime = 'image/webp', icon_version = icon_version + 1", [Buffer.alloc(MAX_PROVIDER_ICON_BYTES)]);
    await upd("icon_kind = 'none', icon_data = null, icon_mime = null");
    const { rows } = await pool.query(`select icon_kind, icon_data, icon_mime, icon_version from auth_providers where id = '${P}'`);
    expect(rows).toEqual([{ icon_kind: "none", icon_data: null, icon_mime: null, icon_version: 1 }]);
  });

  it("放行端逐一放行白名單：mime 三種各一次、kind 五種各一次", async () => {
    const { pool } = await freshDb();
    await insertBase(pool);
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      await pool.query(`update auth_providers set icon_kind = 'upload', icon_data = $1, icon_mime = $2 where id = '${P}'`, [PNG, mime]);
      const { rows } = await pool.query(`select icon_kind, icon_mime from auth_providers where id = '${P}'`);
      expect(rows, mime).toEqual([{ icon_kind: "upload", icon_mime: mime }]);
    }
    for (const kind of ["template", "gitlab", "google", "none", "upload"]) {
      if (kind === "upload") {
        await pool.query(`update auth_providers set icon_kind = 'upload', icon_data = $1, icon_mime = 'image/png' where id = '${P}'`, [PNG]);
      } else {
        await pool.query(`update auth_providers set icon_kind = $1, icon_data = null, icon_mime = null where id = '${P}'`, [kind]);
      }
      const { rows } = await pool.query(`select icon_kind from auth_providers where id = '${P}'`);
      expect(rows, kind).toEqual([{ icon_kind: kind }]);
    }
  });

  it("0015 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0014）", () => {
    // ⚠ 比對全檔（含 `--` 註解）：檔頭註解裡不得寫出這兩個字。
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0015_provider-icon.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0016_note-search（#93 全文搜尋，spec §3）", () => {
  const seedNote = async (pool: import("pg").Pool): Promise<string> => {
    const u = (await pool.query(`insert into users (email, handle, display_name) values ('s93@x', 's93', 'S') returning id`)).rows[0].id;
    return (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id;
  };
  const SRC = "44444444-4444-4444-8444-444444444444";

  it("三條 CHECK：每形恰違反一條，constraint 名逐一斷言；合法形放行（含 attachment＋source_id、64 字 id）", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    const ins = (kind: string, sourceId: string | null, sectionId: string) =>
      pool.query(`insert into note_search_sections (note_id, source_kind, source_id, section_id, ord, body) values ($1, $2, $3, $4, 0, 'b')`, [n, kind, sourceId, sectionId]);
    // PG 依名稱字母序檢查 CHECK（section < source_id < source_kind）：每一形只違反一條，報出的名字才是要測的那條。
    await expect(ins("pdf", SRC, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_kind_chk" });
    await expect(ins("note", SRC, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_id_chk" });
    await expect(ins("attachment", null, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_id_chk" });
    await expect(ins("note", null, "a/b")).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" });
    await expect(ins("note", null, "x".repeat(65))).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" });
    await expect(ins("note", null, "")).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" }); // {1,64} 的下界
    await ins("note", null, "_top");
    await ins("attachment", SRC, "x".repeat(64));
    const { rows } = await pool.query(`select count(*)::int as c from note_search_sections where note_id = $1`, [n]);
    expect(rows[0].c).toBe(2);
  });

  it("id 是 identity always：明寫 id 被拒；heading 預設 ''、source_kind 預設 'note'", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    await expect(pool.query(`insert into note_search_sections (id, note_id, section_id, ord, body) values (1, $1, 'a', 0, 'b')`, [n])).rejects.toMatchObject({ code: "428C9" });
    await pool.query(`insert into note_search_sections (note_id, section_id, ord, body) values ($1, 'a', 0, 'b')`, [n]);
    const { rows } = await pool.query(`select source_kind, source_id, heading from note_search_sections where note_id = $1`, [n]);
    expect(rows).toEqual([{ source_kind: "note", source_id: null, heading: "" }]);
  });

  it("刪筆記 cascade 兩表", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    await pool.query(`insert into note_search_sections (note_id, section_id, ord, body) values ($1, '_top', 0, 'b')`, [n]);
    await pool.query(`insert into note_search_state (note_id, extractor_version, source_version, content_hash, indexed_units, capped) values ($1, 1, 1, 'h', 1, false)`, [n]);
    await pool.query(`delete from notes where id = $1`, [n]);
    const a = await pool.query(`select count(*)::int as c from note_search_sections`);
    const b = await pool.query(`select count(*)::int as c from note_search_state`);
    expect([a.rows[0].c, b.rows[0].c]).toEqual([0, 0]);
  });

  it("0016 檔內無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0015）", () => {
    // ⚠ 比對全檔（含 `--` 註解）：檔頭註解裡不得寫出這兩個字。合併前若重產成別的編號，檔名跟著改。
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0016_note-search.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("transfer_tokens（#200 spec §3）", () => {
  /** user＋個人筆記＋PAT 一支，回三個 id。 */
  async function seedParent(pool: import("pg").Pool): Promise<{ userId: string; noteId: string; tokenId: string }> {
    const u = await pool.query(`insert into users (email, display_name) values ($1, 'T') returning id`, [`tt-${randomUUID()}@example.com`]);
    const userId = u.rows[0].id as string;
    const n = await pool.query(`insert into notes (owner_id) values ($1) returning id`, [userId]);
    const t = await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1, 'pat', 'n', 'notes:read notes:write', $2) returning id`,
      [userId, `h-${randomUUID()}`],
    );
    return { userId, noteId: n.rows[0].id as string, tokenId: t.rows[0].id as string };
  }
  const insertSql =
    `insert into transfer_tokens (token_hash, parent_token_id, note_id, purpose, expires_at, consumed_at)
     values ($1, $2, $3, $4, now() + ($5::text)::interval, $6) returning id`;

  it("三條 CHECK：每一形恰違反一條，constraint 名逐一斷言；合法形放行", async () => {
    const { pool } = await freshDb();
    const p = await seedParent(pool);
    const cases: Array<[unknown[], string]> = [
      [[`a-${randomUUID()}`, p.tokenId, p.noteId, "other", "10 minutes", null], "transfer_tokens_purpose_chk"],
      [[`b-${randomUUID()}`, p.tokenId, p.noteId, "download", "10 minutes", new Date()], "transfer_tokens_consumed_chk"],
      [[`c-${randomUUID()}`, p.tokenId, p.noteId, "upload", "-1 minute", null], "transfer_tokens_expiry_chk"],
    ];
    for (const [params, constraint] of cases) {
      await expect(pool.query(insertSql, params), constraint).rejects.toMatchObject({ code: "23514", constraint });
    }
    // 合法：upload 可以被消費；download 不帶 consumed_at
    await pool.query(insertSql, [`d-${randomUUID()}`, p.tokenId, p.noteId, "upload", "10 minutes", new Date()]);
    await pool.query(insertSql, [`e-${randomUUID()}`, p.tokenId, p.noteId, "download", "10 minutes", null]);
    const { rows } = await pool.query(`select count(*)::int as n from transfer_tokens`);
    expect(rows[0].n).toBe(2);
  });

  it("token_hash 唯一", async () => {
    const { pool } = await freshDb();
    const p = await seedParent(pool);
    await pool.query(insertSql, ["dup", p.tokenId, p.noteId, "download", "10 minutes", null]);
    await expect(pool.query(insertSql, ["dup", p.tokenId, p.noteId, "download", "10 minutes", null])).rejects.toMatchObject({
      code: "23505",
      constraint: "transfer_tokens_token_hash_unique",
    });
  });

  it("兩條 FK 都 ON DELETE CASCADE：刪母憑證、刪筆記都帶走子列（spec §3.2）", async () => {
    const { pool } = await freshDb();
    const a = await seedParent(pool);
    const b = await seedParent(pool);
    await pool.query(insertSql, [`x-${randomUUID()}`, a.tokenId, a.noteId, "upload", "10 minutes", null]);
    await pool.query(insertSql, [`y-${randomUUID()}`, b.tokenId, b.noteId, "download", "10 minutes", null]);
    await pool.query(`delete from api_tokens where id = $1`, [a.tokenId]);
    await pool.query(`delete from notes where id = $1`, [b.noteId]);
    const { rows } = await pool.query(`select count(*)::int as n from transfer_tokens`);
    expect(rows[0].n).toBe(0);
  });

  it("transfer-tokens 的 SQL 檔無 CONCURRENTLY／行首 COMMIT（單一 tx 前提的輔助 grep，比照 0014／0015）", () => {
    // 以 tag 後綴找檔：合併前會在 main 上重產成下一號（spec 檔頭 I6 規則），編號不寫死。
    const entries = journalEntries().filter(e => e.tag.endsWith("_transfer-tokens"));
    expect(entries, "journal 裡要恰有一支 *_transfer-tokens").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});
