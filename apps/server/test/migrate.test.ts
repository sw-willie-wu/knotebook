import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_AVATAR_DISPLAY_BYTES, MAX_PROVIDER_ICON_BYTES, SITE_LIMITS, autoSlugFromTitle, validateHandle, validateSlug } from "@knotebook/shared";
import { applyMigrationsThrough, freshDb, freshEmptyDb, idxOfTag, journalEntries } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDb } from "../src/db/index.js";
import { Pool } from "pg";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { apiTokens, authProviders, folders, groupMembers, groupRoles, groups, noteFavorites, notePlacements, noteRedirects, notes, oauthClients, oauthCodes, noteSearchSections, noteSearchState, noteLinkConversion, noteTags, noteVersions, handleRenames, oauthRequests, oneTimeLinks, sessions, siteLimitChanges, siteLimits, siteSettings, storagePlans, tags, transferBases, transferCreates, transferTokens, userAvatars, userIdentities, users } from "../src/db/schema.js";

const drizzleDirForTest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** Drizzle's serialization of `schema.ts`; the declaration-drift guard compares against the latest snapshot (update the file name with each new migration). */
const SNAPSHOT_FILE = "meta/0043_snapshot.json";
const snapshotLatest = JSON.parse(readFileSync(path.join(drizzleDirForTest, SNAPSHOT_FILE), "utf8")) as {
  tables: Record<string, {
    checkConstraints?: Record<string, { name: string; value: string }>;
    columns?: Record<string, { notNull: boolean }>;
    foreignKeys?: Record<string, { name: string; onDelete?: string }>;
    indexes?: Record<string, { isUnique: boolean; where?: string }>;
  }>;
};
const pgDialect = new PgDialect();

describe("runMigrations", () => {
  it("migrating twice is idempotent and 42 tables exist", async () => {
    const { db, pool } = await freshDb();
    await runMigrations(db); // freshDb already ran it once; this is the second run
    const r = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
    const tableNames = r.rows.map(x => x.table_name);
    for (const t of ["users", "instance_setup", "notes", "note_states", "note_state_backups", "note_shares", "note_links", "uploads", "ai_providers", "ai_models", "ai_actions", "handles", "api_tokens", "oauth_clients", "oauth_requests", "oauth_codes", "note_ai_edits", "groups", "group_members", "group_roles", "note_redirects", "auth_providers", "user_identities", "site_settings", "note_search_sections", "note_search_state", "transfer_tokens", "storage_plans", "note_versions", "note_link_conversion", "handle_renames", "one_time_links", "folders", "note_placements", "transfer_bases", "transfer_creates", "sessions", "site_limits", "site_limit_changes", "note_favorites", "user_avatars", "tags", "note_tags"])
      expect(tableNames).toContain(t);
  });

  it("note_shares.role CHECK rejects invalid values", async () => {
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

  it("instance_setup.singleton CHECK rejects false", async () => {
    const { pool } = await freshDb();
    await expect(
      pool.query(`insert into instance_setup (singleton) values (false)`)
    ).rejects.toMatchObject({ code: "23514", constraint: "instance_setup_singleton_chk" });
  });

  it("note_links_target_idx exists (used by the backlink query)", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(`select indexname from pg_indexes where tablename = 'note_links'`);
    const indexNames = r.rows.map(x => x.indexname);
    expect(indexNames).toContain("note_links_target_idx");
  });

  it("notes_owner_idx/note_shares_user_idx/uploads_note_idx exist (each of the two UNION ALL branches of GET /api/notes does its own index scan)", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(
      `select tablename, indexname from pg_indexes where indexname in ('notes_owner_idx', 'note_shares_user_idx', 'uploads_note_idx')`
    );
    const indexNames = r.rows.map(x => x.indexname);
    expect(indexNames).toContain("notes_owner_idx");
    expect(indexNames).toContain("note_shares_user_idx");
    expect(indexNames).toContain("uploads_note_idx");
  });

  it("users_email_lower_idx exists, is on lower(email), and is **not unique** (issue #18)", async () => {
    const { pool } = await freshDb();
    const r = await pool.query(
      `select indexdef from pg_indexes where tablename = 'users' and indexname = 'users_email_lower_idx'`
    );
    expect(r.rowCount).toBe(1);
    const indexdef: string = r.rows[0].indexdef;
    expect(indexdef).toContain("lower(email)");
    // Non-unique is deliberate: rows with duplicate emails differing only in case are currently allowed, and OIDC's multi-row
    // detection (oidc_conflict) depends on that (docs/known-limitations.md). Making it UNIQUE would turn that path from a
    // detectable conflict into a write failure; this assertion guards that.
    expect(indexdef).not.toContain("UNIQUE");
  });

  it("duplicate lower(email) rows can still be inserted (the premise of oidc_conflict detection isn't broken by the new index)", async () => {
    // Together with the previous case this is the full guard, not a duplicate to delete: the previous one only checks the indexdef of
    // the name `users_email_lower_idx`, so someone adding a lower(email) UNIQUE index under another name would keep it green; this
    // case's actual insert catches that.
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('Case@Example.com', 'A')`);
    // Same lower() value, different case: the email column's own UNIQUE doesn't block it and the new index must not either.
    await expect(
      pool.query(`insert into users (email, display_name) values ('case@example.com', 'B')`)
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("queries really use the index: both real query shapes' plans use users_email_lower_idx (issue #18)", async () => {
    // Asserting that the index exists doesn't pin this issue's claim: rewriting the query to lowercase in the app or adding a COLLATE
    // would leave the index in place but unusable, silently voiding the CHANGELOG claim (this repo's recurring defect shape). So seed
    // 5000 rows, analyze, and check the planner's choice directly. The two shapes match real call sites: login/share user lookup
    // (ORDER BY + LIMIT 1) and OIDC linking (deliberately no limit, relying on multi-row detection oidc_conflict). Both reliably pick
    // this index on pg17.
    const { pool } = await freshDb();
    // handle is written explicitly (not the DEFAULT, an 8-hex-char uuid truncation): 5000 rows on the DEFAULT have about a 0.29%
    // chance of colliding on users_handle_unique (birthday problem, issue #150); the test doesn't care what the handle is, so use a sequence number that is certainly unique.
    await pool.query(
      `insert into users (email, display_name, handle)
       select 'u' || g || '@example.com', 'U' || g, 'u' || g from generate_series(1, 5000) g`
    );
    await pool.query(`analyze users`);

    const planOf = async (sql: string): Promise<string> => {
      const { rows } = await pool.query(`explain (costs off) ${sql}`);
      return rows.map(r => r["QUERY PLAN"]).join("\n");
    };

    // The login/share user lookup shape (auth.ts / notes.ts)
    expect(
      await planOf(`select id from users where lower(email) = 'u1@example.com' order by created_at, id limit 1`)
    ).toContain("users_email_lower_idx");
    // The OIDC linking shape (oidc.ts: no order/limit, multiple rows allowed)
    expect(await planOf(`select * from users where lower(email) = 'u1@example.com'`)).toContain(
      "users_email_lower_idx"
    );
  });

  it("notes.public_token column + partial unique index exist (#72: NULLs don't conflict, non-NULL values are globally unique)", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select data_type, is_nullable from information_schema.columns
       where table_name = 'notes' and column_name = 'public_token'`
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]).toEqual({ data_type: "text", is_nullable: "YES" });

    // Pin the full indexdef: UNIQUE plus the WHERE clause, dropping either means different semantics (a unique without WHERE also
    // allows multiple NULLs in pg, but partial is the explicit intent; same convention as users_email_lower_idx: pin the indexdef of that name).
    const { rows: idx } = await pool.query(
      `select indexdef from pg_indexes where tablename = 'notes' and indexname = 'notes_public_token_idx'`
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/WHERE \(?public_token IS NOT NULL\)?/);
  });

  it("#240 0020: deletes self-link rows of note_links and keeps normal rows; running runMigrations again leaves data alone", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0019_note-versions"));
    const u = "00000000-0000-4000-8000-0000000000a1";
    const a = "00000000-0000-4000-8000-0000000000b1";
    const b = "00000000-0000-4000-8000-0000000000b2";
    await pool.query(`insert into users (id, email, display_name) values ($1, 'r9m@x.example', 'U')`, [u]);
    await pool.query(`insert into notes (id, owner_id, title) values ($1, $3, 'A'), ($2, $3, 'B')`, [a, b, u]);
    await pool.query(`insert into note_links (source_note_id, target_note_id) values ($1, $1), ($1, $2)`, [a, b]);
    await runMigrations(db);
    const rows = async () => (await pool.query(`select source_note_id, target_note_id from note_links order by target_note_id`)).rows;
    expect(await rows()).toEqual([{ source_note_id: a, target_note_id: b }]);
    await runMigrations(db);
    expect(await rows()).toEqual([{ source_note_id: a, target_note_id: b }]);
  });

  it("#247 last_login_at: users rows existing before the migration are NULL afterwards (no backfill); column is timestamptz, nullable, no default", async () => {
    const { pool, db } = await freshEmptyDb();
    const target = journalEntries().find(e => e.tag.endsWith("_users-last-login-at"));
    expect(target, "journal 裡要有 *_users-last-login-at").toBeDefined();
    await applyMigrationsThrough(pool, target!.idx - 1);
    const id = "00000000-0000-4000-8000-0000000000c1";
    await pool.query(`insert into users (id, email, display_name) values ($1, 'll@x.example', 'L')`, [id]);
    await runMigrations(db);
    expect((await pool.query(`select last_login_at from users where id = $1`, [id])).rows).toEqual([{ last_login_at: null }]);
    const col = (await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'last_login_at'`,
    )).rows;
    expect(col).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
  });

  it("#247 0023 uploads.charged_to_id: existing rows backfilled with uploader_id (NULL stays NULL); column is uuid, nullable, no default; FK -> users ON DELETE SET NULL; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0022_users-last-login-at"));
    const u = "00000000-0000-4000-8000-0000000000d1";
    const n = "00000000-0000-4000-8000-0000000000d2";
    const withUploader = "00000000-0000-4000-8000-0000000000d3";
    const orphan = "00000000-0000-4000-8000-0000000000d4";
    const u2 = "00000000-0000-4000-8000-0000000000d5";
    const withUploader2 = "00000000-0000-4000-8000-0000000000d6";
    await pool.query(`insert into users (id, email, display_name) values ($1, 'ct@x.example', 'C')`, [u]);
    await pool.query(`insert into users (id, email, display_name) values ($1, 'ct2@x.example', 'C2')`, [u2]);
    await pool.query(`insert into notes (id, owner_id, title) values ($1, $2, 'N')`, [n, u]);
    await pool.query(
      `insert into uploads (id, note_id, uploader_id, mime, size) values ($1, $3, $4, 'image/png', 10), ($2, $3, null, 'image/png', 20), ($5, $3, $6, 'image/png', 30)`,
      [withUploader, orphan, n, u, withUploader2, u2],
    );
    await runMigrations(db);
    const rows = async () => (await pool.query(`select id, uploader_id, charged_to_id from uploads order by id`)).rows;
    expect(await rows()).toEqual([
      { id: withUploader, uploader_id: u, charged_to_id: u },
      { id: orphan, uploader_id: null, charged_to_id: null },
      { id: withUploader2, uploader_id: u2, charged_to_id: u2 },
    ]);
    const col = (await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'uploads' and column_name = 'charged_to_id'`,
    )).rows;
    expect(col).toEqual([{ data_type: "uuid", is_nullable: "YES", column_default: null }]);
    const fk = (await pool.query(
      `select c.conname, c.confrelid::regclass::text as ref, c.confdeltype
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.conrelid = 'public.uploads'::regclass and c.contype = 'f' and a.attname = 'charged_to_id'`,
    )).rows;
    expect(fk).toEqual([{ conname: "uploads_charged_to_id_users_id_fk", ref: "users", confdeltype: "n" }]);
    await runMigrations(db);
    expect(await rows()).toEqual([
      { id: withUploader, uploader_id: u, charged_to_id: u },
      { id: orphan, uploader_id: null, charged_to_id: null },
      { id: withUploader2, uploader_id: u2, charged_to_id: u2 },
    ]);
  });

  it("#267 0024 users.last_active_at: existing rows backfilled with last_login_at (NULL stays NULL); column is timestamptz, nullable, no default; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0023_uploads-charged-to"));
    const seen = "00000000-0000-4000-8000-0000000000e1";
    const seen2 = "00000000-0000-4000-8000-0000000000e2";
    const never = "00000000-0000-4000-8000-0000000000e3";
    await pool.query(
      `insert into users (id, email, display_name, last_login_at) values
         ($1, 'la1@x.example', 'A', '2026-10-01T09:12:00.123456Z'), ($2, 'la2@x.example', 'B', '2026-09-30T23:59:59Z'), ($3, 'la3@x.example', 'C', null)`,
      [seen, seen2, never],
    );
    await runMigrations(db);
    const rows = async () =>
      (await pool.query(`select id, (last_active_at at time zone 'UTC')::text as active, last_active_at is not distinct from last_login_at as same from users order by id`)).rows;
    const expected = [
      { id: seen, active: "2026-10-01 09:12:00.123456", same: true },
      { id: seen2, active: "2026-09-30 23:59:59", same: true },
      { id: never, active: null, same: true },
    ];
    expect(await rows()).toEqual(expected);
    const col = (await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'last_active_at'`,
    )).rows;
    expect(col).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
    await runMigrations(db);
    expect(await rows()).toEqual(expected);
  });

  it("#269 0026 note_link_conversion: one pending row seeded per note existing at migration time; notes created later get none (the candidate set is frozen)", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0026_note-link-conversion") - 1);
    const u = (await pool.query(`insert into users (email, display_name) values ('lc@x.example', 'L') returning id`)).rows[0].id as string;
    const before = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id as string;
    await runMigrations(db);
    const after = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id as string;
    const rows = (await pool.query(`select note_id, status, attempts, converted, unresolved from note_link_conversion order by note_id`)).rows;
    expect(rows).toEqual([{ note_id: before, status: "pending", attempts: 0, converted: 0, unresolved: 0 }]);
    expect(rows.some((r: { note_id: string }) => r.note_id === after)).toBe(false);
    await expect(pool.query(`update note_link_conversion set status = 'bogus' where note_id = $1`, [before])).rejects.toMatchObject({ code: "23514" });
    await pool.query(`delete from notes where id = $1`, [before]);
    expect((await pool.query(`select count(*)::int as n from note_link_conversion`)).rows[0].n).toBe(0);
  });
});

describe("#291 0027_handle-renames", () => {
  it("handle_renames shape: three columns (type/NOT NULL/default), FK -> users ON DELETE CASCADE, (user_id, renamed_at) index; deleting a user deletes its rows", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'handle_renames' order by column_name`,
    )).rows;
    expect(cols).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "renamed_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO", column_default: null },
    ]);
    const fks = (await pool.query(
      `select confdeltype, confrelid::regclass::text as ref from pg_constraint where conrelid = 'handle_renames'::regclass and contype = 'f'`,
    )).rows;
    expect(fks).toEqual([{ confdeltype: "c", ref: "users" }]);
    const idx = (await pool.query(
      `select indexdef from pg_indexes where indexname = 'handle_renames_user_time_idx'`,
    )).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(user_id, renamed_at\)/);
    const u = (await pool.query(`insert into users (email, display_name) values ('hr@x.example', 'H') returning id`)).rows[0].id as string;
    await pool.query(`insert into handle_renames (user_id) values ($1), ($1)`, [u]);
    expect((await pool.query(`select count(*)::int as n from handle_renames`)).rows[0].n).toBe(2);
    await pool.query(`delete from users where id = $1`, [u]);
    expect((await pool.query(`select count(*)::int as n from handle_renames`)).rows[0].n).toBe(0);
  });

  it("0027 data: released rows within 24 h are backfilled (renamed_at = released_at), older ones aren't, orphan released rows are skipped, no released rows remain in handles afterwards, live rows untouched; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0027_handle-renames") - 1);
    const a = (await pool.query(`insert into users (email, display_name, handle) values ('mig-a@x.example', 'A', 'mig-a') returning id`)).rows[0].id as string;
    const b = (await pool.query(`insert into users (email, display_name, handle) values ('mig-b@x.example', 'B', 'mig-b') returning id`)).rows[0].id as string;
    await pool.query(
      `insert into handles (handle, user_id, state, released_at) values
        ('mig-a', $1, 'live', null),
        ('mig-a-old1', $1, 'released', now() - interval '1 hour'),
        ('mig-a-old2', $1, 'released', now() - interval '2 days'),
        ('ghost-old', $3, 'released', now() - interval '1 hour'),
        ('mig-b', $2, 'live', null)`,
      [a, b, randomUUID()],
    );
    const expected = (await pool.query(`select released_at::text as t from handles where handle = 'mig-a-old1'`)).rows[0].t as string;
    await runMigrations(db);
    const renames = async () => (await pool.query(`select user_id, renamed_at::text as renamed_at from handle_renames`)).rows;
    const handleRows = async () => (await pool.query(`select handle, state from handles order by handle`)).rows;
    expect(await renames()).toEqual([{ user_id: a, renamed_at: expected }]);
    expect(await handleRows()).toEqual([{ handle: "mig-a", state: "live" }, { handle: "mig-b", state: "live" }]);
    await runMigrations(db);
    expect(await renames()).toEqual([{ user_id: a, renamed_at: expected }]);
    expect(await handleRows()).toEqual([{ handle: "mig-a", state: "live" }, { handle: "mig-b", state: "live" }]);
  });
});

describe("note-width 0028_note-public-width", () => {
  it("notes.public_width shape: text NOT NULL default 'standard'; CHECK accepts only three values (constraint name notes_public_width_chk)", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'notes' and column_name = 'public_width'`,
    )).rows;
    expect(cols).toEqual([{ data_type: "text", is_nullable: "NO", column_default: "'standard'::text" }]);
    // The live DB's CHECK literal: if the SQL were hand-edited to accept one more value (other than 'huge'), the rejection/three-value loop below can't see it, but this literal comparison goes red.
    const chk = (await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notes_public_width_chk' and conrelid = 'notes'::regclass`,
    )).rows;
    expect(chk).toEqual([{ def: "CHECK ((public_width = ANY (ARRAY['standard'::text, 'wide'::text, 'full'::text])))" }]);
    const u = (await pool.query(`insert into users (email, handle, display_name) values ('w@x.example', 'w-user', 'W') returning id`)).rows[0].id as string;
    const n = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id as string;
    expect((await pool.query(`select public_width from notes where id = $1`, [n])).rows[0].public_width).toBe("standard");
    await expect(pool.query(`update notes set public_width = 'huge' where id = $1`, [n])).rejects.toMatchObject({
      code: "23514",
      constraint: "notes_public_width_chk",
    });
    for (const w of ["standard", "wide", "full"]) {
      await pool.query(`update notes set public_width = $2 where id = $1`, [n, w]);
      expect((await pool.query(`select public_width from notes where id = $1`, [n])).rows[0].public_width).toBe(w);
    }
  });

  it("0028 on existing data: old notes are all 'standard'; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0028_note-public-width") - 1);
    const u = (await pool.query(`insert into users (email, display_name, handle) values ('old@x.example', 'O', 'old-user') returning id`)).rows[0].id as string;
    await pool.query(`insert into notes (owner_id, slug) values ($1, 'old-note')`, [u]);
    await runMigrations(db);
    const widths = async () => (await pool.query(`select public_width from notes`)).rows;
    expect(await widths()).toEqual([{ public_width: "standard" }]);
    await runMigrations(db);
    expect(await widths()).toEqual([{ public_width: "standard" }]);
  });
});

describe("0029_auth-provider-optional-client-id", () => {
  const SECRET = `'{"v":2,"keyId":"k","iv":"i","tag":"t","ct":"c"}'::jsonb`;
  const base = `id, template, display_name, issuer_url, client_id`;

  it("shape: auth_providers.client_id is text and nullable; the new CHECK's literal", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select data_type, is_nullable from information_schema.columns where table_name = 'auth_providers' and column_name = 'client_id'`,
    )).rows;
    expect(cols).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const chk = (await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auth_providers_enabled_client_id_chk' and conrelid = 'auth_providers'::regclass`,
    )).rows;
    expect(chk).toEqual([{ def: "CHECK (((NOT enabled) OR (client_id IS NOT NULL)))" }]);
  });

  it("a disabled row with client_id NULL can be stored; enabled + NULL is rejected by the new CHECK; an empty string is still rejected by the length CHECK", async () => {
    const { pool } = await freshDb();
    const ins = (cols: string, vals: string) => pool.query(`insert into auth_providers (${cols}) values (${vals})`);
    const off = randomUUID();
    await ins(base, `'${off}', 'gitlab', 'GitLab', 'https://gitlab.example', null`);
    expect((await pool.query(`select client_id, enabled from auth_providers where id = $1`, [off])).rows).toEqual([
      { client_id: null, enabled: false },
    ]);
    await expect(
      ins(`${base}, enabled, client_secret_encrypted`, `'${randomUUID()}', 'oidc', 'SSO', 'https://idp.example', null, true, ${SECRET}`),
    ).rejects.toMatchObject({ code: "23514", constraint: "auth_providers_enabled_client_id_chk" });
    await expect(ins(base, `'${randomUUID()}', 'oidc', 'SSO', 'https://idp.example', ''`)).rejects.toMatchObject({
      code: "23514",
      constraint: "auth_providers_client_id_chk",
    });
  });

  it("a disabled row missing both client ID and secret turned enabled hits auth_providers_enabled_client_id_chk (with several CHECKs on one row, the order is alphabetical by name)", async () => {
    const { pool } = await freshDb();
    const id = randomUUID();
    await pool.query(`insert into auth_providers (${base}) values ($1, 'gitlab', 'GitLab', 'https://gitlab.example', null)`, [id]);
    await expect(pool.query(`update auth_providers set enabled = true where id = $1`, [id])).rejects.toMatchObject({
      code: "23514",
      constraint: "auth_providers_enabled_client_id_chk",
    });
    expect((await pool.query(`select enabled from auth_providers where id = $1`, [id])).rows).toEqual([{ enabled: false }]);
  });

  it("applied to existing data: existing disabled rows' client_id unchanged; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0029_auth-provider-optional-client-id") - 1);
    const id = randomUUID();
    await pool.query(`insert into auth_providers (${base}) values ($1, 'gitlab', 'GitLab', 'https://gitlab.example', 'old-client')`, [id]);
    const rows = async () => (await pool.query(`select client_id, enabled from auth_providers`)).rows;
    await runMigrations(db);
    expect(await rows()).toEqual([{ client_id: "old-client", enabled: false }]);
    await runMigrations(db);
    expect(await rows()).toEqual([{ client_id: "old-client", enabled: false }]);
  });
});

describe("0031_auth-provider-auto-create", () => {
  const SECRET = `'{"v":2,"keyId":"k","iv":"i","tag":"t","ct":"c"}'::jsonb`;
  const base = `id, template, display_name, issuer_url, client_id`;
  const TAG = "0031_auth-provider-auto-create";

  it("shape: auth_providers.auto_create_enabled is boolean NOT NULL default false; inserting without it gives false", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns where table_name = 'auth_providers' and column_name = 'auto_create_enabled'`,
    )).rows;
    expect(cols).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    const id = randomUUID();
    await pool.query(`insert into auth_providers (${base}) values ($1, 'gitlab', 'GitLab', 'https://gitlab.example', 'c')`, [id]);
    expect((await pool.query(`select auto_create_enabled from auth_providers where id = $1`, [id])).rows).toEqual([{ auto_create_enabled: false }]);
  });

  it.each([[true, true], [false, false]])("registration_enabled=%s before the upgrade -> existing services are all %s; running runMigrations again changes nothing; rows added afterwards are false", async (reg, expected) => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG) - 1);
    await pool.query(`update site_settings set registration_enabled = $1`, [reg]);
    await pool.query(`insert into auth_providers (${base}) values ($1, 'gitlab', 'GitLab', 'https://gitlab.example', 'off-client')`, [randomUUID()]);
    await pool.query(
      `insert into auth_providers (${base}, enabled, client_secret_encrypted) values ($1, 'oidc', 'SSO', 'https://idp.example', 'on-client', true, ${SECRET})`,
      [randomUUID()],
    );
    const values = async () => (await pool.query(`select auto_create_enabled from auth_providers order by client_id`)).rows;
    await runMigrations(db);
    expect(await values()).toEqual([{ auto_create_enabled: expected }, { auto_create_enabled: expected }]);
    await pool.query(`update site_settings set registration_enabled = $1`, [!reg]);
    await runMigrations(db);
    expect(await values()).toEqual([{ auto_create_enabled: expected }, { auto_create_enabled: expected }]);
    const third = randomUUID();
    await pool.query(`insert into auth_providers (${base}) values ($1, 'google', 'Google', 'https://accounts.example', 'third-client')`, [third]);
    expect((await pool.query(`select auto_create_enabled from auth_providers where id = $1`, [third])).rows).toEqual([{ auto_create_enabled: false }]);
  });

  it("migrating when site_settings has no row -> existing services are false", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG) - 1);
    await pool.query(`delete from site_settings`);
    await pool.query(`insert into auth_providers (${base}) values ($1, 'gitlab', 'GitLab', 'https://gitlab.example', 'c')`, [randomUUID()]);
    await runMigrations(db);
    expect((await pool.query(`select auto_create_enabled from auth_providers`)).rows).toEqual([{ auto_create_enabled: false }]);
  });
});

/**
 * 0006_user-handle (#122). Shape cases run on freshDb (all migrations); backfill data cases run on the migration data-case harness
 * (freshEmptyDb -> applyThrough(0005) -> seed 0005-shaped fixtures -> runMigrations runs 0006 -> assert); fixtures give explicit id
 * and created_at to control the deterministic order of the DO loop (rows inserted in one tx all have equal created_at, so the order would be decided by random uuids).
 */
describe("0006_user-handle", () => {
  it("handles table shape: PK + three CHECKs (charset/length, state enum, released_at <-> state consistency)", async () => {
    const { pool } = await freshDb();

    await pool.query(`insert into users (email, display_name) values ('h@example.com', 'H')`);
    const { rows } = await pool.query(`select id from users limit 1`);
    const userId = rows[0].id;

    // valid row
    await pool.query(`insert into handles (handle, user_id, state) values ('ok-name', $1, 'live')`, [userId]);
    // charset/length
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('BAD', $1, 'live')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_handle_chk" });
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('${"a".repeat(33)}', $1, 'live')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_handle_chk" });
    // state enum
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('zombie-x', $1, 'zombie')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_state_chk" });
    // released_at <-> state consistency (released without a timestamp / live with one are both rejected)
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('tomb-x', $1, 'released')`, [userId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_released_at_chk" });
    await expect(
      pool.query(
        `insert into handles (handle, user_id, state, released_at) values ('live-x', $1, 'live', now())`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "handles_released_at_chk" });
    // PK = the allocation decision: blocks a live name collision
    await expect(
      pool.query(`insert into handles (handle, user_id, state) values ('ok-name', $1, 'live')`, [randomUUID()]),
    ).rejects.toMatchObject({ code: "23505", constraint: "handles_pkey" });
    // user_id deliberately has zero FK (the structural premise of registry-first ordering, load-bearing in the schema.ts comment)
    const { rows: fks } = await pool.query(
      `select count(*)::int as n from pg_constraint where conrelid = 'handles'::regclass and contype = 'f'`,
    );
    expect(fks[0].n).toBe(0);
    // index for lookups by user_id
    const { rows: idx } = await pool.query(
      `select indexname from pg_indexes where tablename = 'handles' and indexname = 'handles_user_idx'`,
    );
    expect(idx).toHaveLength(1);
  });

  it("users.handle: NOT NULL + DEFAULT (user-<uuid8> form) + users_handle_unique is a **constraint, not an index** (the discriminating contract key)", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select is_nullable, column_default from information_schema.columns
       where table_name = 'users' and column_name = 'handle'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].is_nullable).toBe("NO");
    expect(cols[0].column_default).toMatch(/gen_random_uuid/);

    // The discriminating contract is bound to the constraint name: in pg_indexes a UNIQUE constraint and a UNIQUE INDEX appear under
    // the same name, only pg_constraint.contype='u' tells them apart (it must not become an index)
    const { rows: cons } = await pool.query(
      `select contype from pg_constraint where conname = 'users_handle_unique'`,
    );
    expect(cons).toHaveLength(1);
    expect(cons[0].contype).toBe("u");

    // DB default as a safety net (old code inserting without handle during the rollback window still works): the value is user-<uuid8> form
    await pool.query(`insert into users (email, display_name) values ('d@example.com', 'D')`);
    const { rows } = await pool.query(`select handle from users where email = 'd@example.com'`);
    expect(rows[0].handle).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it("backfill cross-group collision (counter-example): foo + existing foo-2 + a second foo -> three distinct handles, the third person doesn't hijack foo-2", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // Explicit id + increasing created_at (rows inserted in one tx all have equal now(), so the order would be decided by random uuids).
    // The physical insert order is deliberately the reverse of created_at: when the two agree, removing ORDER BY from the DO loop
    // leaves a seq scan returning the same order and the assertion stays green; reverse order really pins the product-visible semantics "order by created_at" (older accounts keep clean names).
    await pool.query(
      `insert into users (id, email, display_name, created_at) values
       ('00000000-0000-4000-8000-000000000003', 'foo@z.example',   'C', '2026-01-03T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000002', 'foo-2@y.example', 'B', '2026-01-02T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000001', 'foo@x.example',   'A', '2026-01-01T00:00:00Z')`,
    );
    await runMigrations(db);

    const { rows } = await pool.query(`select email, handle from users order by created_at`);
    expect(rows.map((r: { handle: string }) => r.handle)).toEqual(["foo", "foo-2", "foo-3"]);
    // Order-independent invariants as a double check: distinct + each row valid + registry one-to-one (live)
    const handles = rows.map((r: { handle: string }) => r.handle);
    expect(new Set(handles).size).toBe(3);
    for (const h of handles) expect(validateHandle(h), h).toBeNull();
    const { rows: reg } = await pool.query(
      `select u.handle from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg).toHaveLength(3);
  });

  it("backfill truncation point lands on a dash: after truncating to 30 a trailing dash must be trimmed, the result passes validateHandle", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // local-part = 29 a's + '-' + tail -> truncating to 30 stops exactly on '-'
    await pool.query(
      `insert into users (id, email, display_name, created_at) values
       ('00000000-0000-4000-8000-000000000011', '${"a".repeat(29)}-tail@x.example', 'T', '2026-01-01T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select handle from users`);
    expect(rows[0].handle).toBe("a".repeat(29));
    // registry one-to-one (join form: counting live rows alone can't catch handle/user_id mismatches)
    const { rows: reg } = await pool.query(
      `select count(*)::int as n from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg[0].n).toBe(1);
  });

  it("backfill fallback form: uuid-shaped local-part (judged before truncation), all symbols, non-ASCII -> user-<uuid8>", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0005_public-share"));
    // The first 8 characters of the three ids must differ: all fallbacks go to user-<uuid8>, and identical first 8 characters would make
    // fallbacks collide, so backfill would rightly append a -2 suffix and the plain user-<uuid8> form wouldn't be tested.
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
    // registry one-to-one
    const { rows: reg } = await pool.query(
      `select count(*)::int as n from users u join handles hs on hs.handle = u.handle and hs.user_id = u.id and hs.state = 'live'`,
    );
    expect(reg[0].n).toBe(3);
  });

  it("no CONCURRENTLY in the 0006 file (helper grep for the single-tx premise; the structural guarantee is the harness's single-tx execution)", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0006"));
    expect(entry, "0006 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    // A COMMIT's failure mode is **silent** (drizzle's closing COMMIT only warns, it doesn't blow up): more worth pinning than
    // CONCURRENTLY; match on line-leading statement shape to avoid hitting comment literals.
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * 0007_note-slug (#122). Same convention as 0006: shape cases run on freshDb (all migrations); backfill data cases run on the
 * migration data-case harness (freshEmptyDb -> applyThrough(0006) -> seed 0006-shaped fixtures -> runMigrations runs 0007 -> assert),
 * with explicit id and created_at to control the deterministic order of the DO loop.
 */
describe("0007_note-slug", () => {
  it("notes shape: slug NOT NULL + DEFAULT (untitled-<uuid8> form), slug_is_custom, three indexes, the old global index retired", async () => {
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

    // DB default as a safety net (old code POSTing without slug during the rollback window still works): the value is untitled-<uuid8> form
    await pool.query(`insert into users (email, display_name) values ('n@example.com', 'N')`);
    const { rows: u } = await pool.query(`select id from users limit 1`);
    await pool.query(`insert into notes (owner_id) values ($1)`, [u[0].id]);
    const { rows: n } = await pool.query(`select slug, slug_is_custom, prev_slug, legacy_slug from notes`);
    expect(n[0].slug).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(n[0]).toMatchObject({ slug_is_custom: false, prev_slug: null, legacy_slug: null });

    // Pin the full indexdef of the three indexes (same convention as notes_public_token_idx); the old global notes_slug_idx is retired
    const { rows: idx } = await pool.query(
      `select indexname, indexdef from pg_indexes where tablename = 'notes'`,
    );
    const defs = Object.fromEntries(idx.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef]));
    expect(defs.notes_slug_idx).toBeUndefined();
    expect(defs.notes_owner_slug_idx).toMatch(/UNIQUE/);
    expect(defs.notes_owner_slug_idx).toMatch(/owner_id, slug/);
    expect(defs.notes_owner_slug_idx).not.toMatch(/WHERE/); // slug is NOT NULL, unique over the whole table
    expect(defs.notes_legacy_slug_idx).toMatch(/UNIQUE/);
    expect(defs.notes_legacy_slug_idx).toMatch(/WHERE \(?legacy_slug IS NOT NULL\)?/);
    expect(defs.notes_owner_prev_slug_idx).not.toMatch(/UNIQUE/); // the same owner may release and reuse a name in turn; the >1 judgement is on the query side
    expect(defs.notes_owner_prev_slug_idx).toMatch(/WHERE \(?prev_slug IS NOT NULL\)?/);
  });

  it("per-user uniqueness: same owner collides (constraint name = notes_owner_slug_idx), the same name coexists across owners", async () => {
    const { pool } = await freshDb();
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A'),
       ('00000000-0000-4000-8000-0000000000b1', 'b@example.com', 'B')`,
    );
    await pool.query(
      `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'X', 'same-name')`,
    );
    // Same name across owners: coexist (positive proof of per-user semantics)
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000b1', 'Y', 'same-name')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // Same owner same name: hits the unique index; the constraint name is what the PATCH side's 409 is decided on
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'Z', 'same-name')`,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "notes_owner_slug_idx" });
  });

  it("legacy_slug immutability trigger: UPDATE of it must blow up, UPDATE of title/slug doesn't, pg_trigger exists", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t@example.com', 'T')`);
    const { rows: u } = await pool.query(`select id from users limit 1`);
    await pool.query(`insert into notes (owner_id, title, slug) values ($1, 'T', 'keep-me')`, [u[0].id]);

    await expect(pool.query(`update notes set legacy_slug = 'hijack'`)).rejects.toMatchObject({
      message: expect.stringContaining("legacy_slug is immutable"),
    });
    // WHEN condition: ordinary UPDATEs that don't touch legacy_slug pass at zero cost
    await expect(pool.query(`update notes set title = 'T2', slug = 'renamed'`)).resolves.toMatchObject({
      rowCount: 1,
    });
    const { rows: trg } = await pool.query(
      `select tgname from pg_trigger where tgrelid = 'notes'::regclass and tgname = 'notes_legacy_slug_guard'`,
    );
    expect(trg).toHaveLength(1);
  });

  it("two snapshot states: existing custom slug -> custom=true + legacy frozen; row without slug -> custom=false + legacy NULL", async () => {
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

  it("two owners with the same title -> each gets foo (the case proving the global index is dropped before backfill)", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-000000000001', 'a@x.example', 'A'),
       ('00000000-0000-4000-8000-000000000002', 'b@x.example', 'B')`,
    );
    // If the old global unique index were still present during backfill, the second owner's 'foo' would blow up: this case is that counter-example
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'Foo', null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000002', 'Foo', null, '2026-01-02T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select owner_id, slug from notes order by owner_id`);
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["foo", "foo"]);
  });

  it("same-owner collision dedupe: auto collides with an existing custom, created_at order (the reversed physical insert order pins ORDER BY)", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    // An existing custom 'foo' holds the name; two auto rows with the same title Foo, **the physical insert order is deliberately the
    // reverse of created_at** (0006 convention: when they agree, removing ORDER BY leaves a seq scan returning the same order and the assertion stays green).
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

  it("SQL/TS dual implementation comparison: for a set of pure-ASCII titles, 0007's output equals autoSlugFromTitle", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    // Each title gets its own owner: fallback forms (new/empty symbols/uuid-shaped) all land on 'untitled', and the same owner would
    // trigger the dedupe suffix and distort the comparison. The set covers: ordinary, mixed case, separator folding, reserved words,
    // all symbols, uuid-shaped, truncation to 60, truncation point on a dash.
    const titles = [
      "Hello World",
      "MiXeD CaSe 42",
      "  spaces   and---dashes  ",
      "new",
      "!!! ??? ***",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      // A `-<uuid>` suffix form (not a whole uuid): without this check the SQL version would produce a value colliding with the old
      // /notes/<vanity>-<uuid>, while the TS version falls back to untitled (the whole-uuid case can't catch the check missing)
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

  it("dedupe suffix re-truncation: a long base (59 chars) colliding for the same owner -> the second is exactly 60 chars, same boundary as the TS version", async () => {
    // Re-truncating the base so the total stays <= 60 is the only arithmetic the SQL and TS implementations must agree on; dedupe
    // cases with short bases (foo/untitled) can't exercise it: changing left(base, 60-length(...)) back to left(base, 60) would stay green.
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    const longTitle = "a".repeat(59) + " bbbb"; // derived base = a x59 (same value as the matrix test)
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000001', $1, null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000001', $1, null, '2026-01-02T00:00:00Z')`,
      [longTitle],
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select slug from notes order by created_at`);
    expect(rows[0].slug).toBe("a".repeat(59));
    expect(rows[1].slug).toBe("a".repeat(58) + "-2"); // 58 + '-2' = exactly 60
    for (const r of rows as Array<{ slug: string }>) expect(validateSlug(r.slug)).toBeNull();
  });

  it("non-ASCII titles -> the SQL version always gives the untitled form (divergence policy; the TS version would give istanbul for the Turkish dotted-I title: deliberate difference)", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    // Two non-ASCII rows of the same owner: the second takes the dedupe suffix, which also pins that the fallback dedupes within the owner's scope
    await pool.query(
      `insert into notes (id, owner_id, title, slug, created_at) values
       ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000001', '日本語メモ', null, '2026-01-01T00:00:00Z'),
       ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000001', 'İstanbul', null, '2026-01-02T00:00:00Z')`,
    );
    await runMigrations(db);
    const { rows } = await pool.query(`select slug from notes order by created_at`);
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["untitled", "untitled-2"]);
  });

  it("queries really use the index: the legacy-form lookup plan uses notes_legacy_slug_idx (same convention as #18)", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0006_user-handle"));
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000001', 'o@x.example', 'O')`);
    await pool.query(
      `insert into notes (owner_id, title, slug)
       select '00000000-0000-4000-8000-000000000001', 'T' || g, 's' || g from generate_series(1, 5000) g`,
    );
    await runMigrations(db); // the snapshot froze 5000 slugs into legacy_slug
    await pool.query(`analyze notes`);
    const { rows } = await pool.query(`explain (costs off) select id from notes where legacy_slug = 's1'`);
    expect(rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n")).toContain("notes_legacy_slug_idx");
  });

  it("queries really use the index: both by-path branches (current slug / prev lookup) use their own index in the plan", async () => {
    // The by-path JOIN needs the planner to start a nested loop from users.handle's unique key to reach (owner_id, slug); with the
    // join order flipped `slug = $` alone can't use this index, silently voiding the claim in the routes comment. Same convention as #18: seed 5000 rows + analyze, then check explain.
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

  it("no CONCURRENTLY/line-leading COMMIT in the 0007 file (helper grep for the single-tx premise, like 0006)", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0007"));
    expect(entry, "0007 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * 0008_public-slug (#122). Just a column + partial unique index with no backfill: the public alias is an explicit opt-in, so existing
 * rows are all NULL and there is no "what should old data grow into" question; shape and semantics cases all run on freshDb.
 */
describe("0008_public-slug", () => {
  it("notes.public_slug column shape (nullable text) + full partial unique indexdef", async () => {
    const { pool } = await freshDb();

    const { rows: cols } = await pool.query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'notes' and column_name = 'public_slug'`,
    );
    expect(cols).toHaveLength(1);
    // No DB default: unlike slug there is no INSERT-compatibility issue in the rollback window; NULL is a legal initial value
    expect(cols[0]).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });

    // Pin the full indexdef (same convention as notes_public_token_idx): UNIQUE + two columns + WHERE, dropping any means different
    // semantics (without WHERE pg still doesn't make NULLs conflict, but partial is the explicit intent)
    const { rows: idx } = await pool.query(
      `select indexdef from pg_indexes where tablename = 'notes' and indexname = 'notes_owner_public_slug_idx'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/UNIQUE/);
    expect(idx[0].indexdef).toMatch(/owner_id, public_slug/);
    expect(idx[0].indexdef).toMatch(/WHERE \(?public_slug IS NOT NULL\)?/);
  });

  it("per-user uniqueness: same owner collides (constraint name = notes_owner_public_slug_idx), coexists across owners, multiple NULL rows coexist", async () => {
    const { pool } = await freshDb();
    await pool.query(
      `insert into users (id, email, display_name) values
       ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A'),
       ('00000000-0000-4000-8000-0000000000b1', 'b@example.com', 'B')`,
    );
    // Multiple NULL rows coexist (two notes of the same owner without an alias don't interfere). This cell also holds for a plain
    // non-partial unique (pg defaults to NULLS DISTINCT): what really pins partial is the previous case's indexdef regex; this is only a behavioural sanity check.
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
    // The same alias across owners: coexist (per-user semantics)
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000b1', 'Y', 'y', 'same-alias')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // The same alias for the same owner: hits the unique index: the constraint name is what the endpoint's 409 public_slug_taken is decided on
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'Z', 'z', 'same-alias')`,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "notes_owner_public_slug_idx" });
  });

  it("public_slug and private slug/prev/legacy are different namespaces: an owner's alias may collide with their own private slug", async () => {
    // Pins that "alias uniqueness is decided only within the public_slug column": if someone folds the two columns into one index (or
    // adds a cross-column check), public aliases and private slugs would occupy each other's names, breaking the design that they are independent columns.
    const { pool } = await freshDb();
    await pool.query(`insert into users (id, email, display_name) values ('00000000-0000-4000-8000-0000000000a1', 'a@example.com', 'A')`);
    await pool.query(
      `insert into notes (owner_id, title, slug) values ('00000000-0000-4000-8000-0000000000a1', 'P', 'shared-name')`,
    );
    // Cross-row form: Q's alias collides with P's private slug
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'Q', 'q', 'shared-name')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    // Same-row form (the most common real use): the user sets the public alias to the same name as their own private URL
    await expect(
      pool.query(
        `insert into notes (owner_id, title, slug, public_slug) values
         ('00000000-0000-4000-8000-0000000000a1', 'R', 'r-note', 'r-note')`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("schema.ts declaration <-> DB: drizzle metadata has matching columns and indexes (prevents silent schema.ts drift)", async () => {
    // Every other case in this describe runs on "the DB made by 0008's SQL", so the schema.ts half never enters a test path: deleting
    // the whole publicSlug column and index declarations would leave the tests and typecheck green, but the next `db:generate` would
    // emit a DROP INDEX migration. Pin the declarations with drizzle's own metadata and match them against the DB's actual index names to join both sides.
    const cfg = getTableConfig(notes);
    const col = cfg.columns.find(c => c.name === "public_slug");
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(false);
    const idx = cfg.indexes.find(i => i.config.name === "notes_owner_public_slug_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.columns.map(c => (c as { name?: string }).name)).toEqual(["owner_id", "public_slug"]);
    expect(idx!.config.where).toBeDefined();

    // The declared index-name set is a subset of the DB's actual index names (the same name really exists in the migration-built DB)
    const { pool } = await freshDb();
    const { rows } = await pool.query(`select indexname from pg_indexes where tablename = 'notes'`);
    const dbNames = rows.map((r: { indexname: string }) => r.indexname);
    for (const i of cfg.indexes) expect(dbNames).toContain(i.config.name);
  });

  it("queries really use the index: the public alias JOIN (logged-out surface) plan uses notes_owner_public_slug_idx", async () => {
    // Same as 0007's by-path planner guard: the public side is the logged-out surface, and this JOIN degrading to a seq scan costs more
    // than on the logged-in side. The JOIN shape equals routes/public.ts's pathSpec.lookup (including the non-null public_token predicate).
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

  it("no CONCURRENTLY/line-leading COMMIT in the 0008 file (helper grep for the single-tx premise, like 0007)", () => {
    const entry = journalEntries().find((e) => e.tag.startsWith("0008"));
    expect(entry, "0008 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

/**
 * 0009 (#107): `api_tokens` and the three OAuth tables.
 *
 * The three OAuth tables had no write path at all in #130 (all four were created at once only so #132 wouldn't need another
 * migration; empty tables are harmless), so this describe is their structural guard on the DB side: one more case ties
 * `schema.ts`'s declarations back via `getTableConfig`.
 */
describe("0009_api-tokens", () => {

  it("the kind/scope CHECKs of api_tokens reject invalid values", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t1@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('ck','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    // All other columns are filled so only kind violates: a bare kind='bogus' would violate client/refresh/expiry all three at once
    // (`(kind='pat') = (...)` becomes false=true when kind isn't pat), and then which constraint name appears depends on Postgres's
    // evaluation order, with no spec guarantee.
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash, refresh_token_hash, client_id, access_expires_at)
         values ($1,'bogus','n','notes:read','h1','r1','ck', now() + interval '1 day')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_kind_chk" });

    // The stored form is a **set**: a bare 'notes:write' is not a legal value (write always includes read explicitly)
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:write','h2')`,
        [userId]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_scope_chk" });
  });

  it("kind='pat' must not carry client_id/refresh_token_hash; kind='oauth' must have an expiry", async () => {
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

  it("a non-expiring PAT is a legal row (access_expires_at may be NULL)", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t2b@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    // This is the reverse pin: if the CHECK were written as "every kind needs access_expires_at", no default PAT could be created,
    // and the three negative cases above can't catch that.
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

  it("api_tokens_oauth_user_client_uidx constrains only oauth rows (structural guarantee), PATs are unconstrained", async () => {
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
    // A user's PATs aren't constrained by this partial index (their client_id is NULL)
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

    // The "two PATs coexist" case above can't prove partial: a PAT's client_id is NULL and PG's UNIQUE defaults to NULLS DISTINCT, so
    // dropping the WHERE (making it table-wide unique) stays green. Pinning partial needs the DB-side full indexdef (same family of guards as 0008).
    const { rows: idxRows } = await pool.query(
      `select indexdef from pg_indexes where indexname = 'api_tokens_oauth_user_client_uidx'`
    );
    expect(idxRows).toHaveLength(1);
    expect(idxRows[0].indexdef).toContain("UNIQUE INDEX");
    // The regex is deliberately loose (parentheses and the ::text cast optional): the existing partial guards in this file
    // (notes_legacy_slug_idx etc.) are written that way, so a pg major version changing pg_get_expr's rendering doesn't produce a false
    // red as "partial disappeared". Removing the WHERE still turns it red, so discriminating power is unchanged.
    expect(idxRows[0].indexdef, "WHERE 不可省——省了就變全表唯一").toMatch(
      /WHERE \(?kind = 'oauth'(::text)?\)?/
    );
  });

  it("access_token_hash is globally unique (one token can't map to two rows)", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t3b@example.com', 'T'), ('t3c@example.com','T2')`);
    const users = (await pool.query(`select id from users order by email`)).rows;
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','dup')`,
      [users[0].id]
    );
    // Even **different users** can't reuse a hash: Bearer auth looks up one row by hash, and allowing duplicates would map the same plaintext to two identities.
    await expect(
      pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read','dup')`,
        [users[1].id]
      )
    ).rejects.toMatchObject({ code: "23505", constraint: "api_tokens_access_token_hash_unique" });
  });

  it("deleting oauth_clients CASCADEs its grants/requests/codes; deleting users CASCADEs their grants", async () => {
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

    // On the users side: recreate the client and code, then delete from the **user** end. The first half deleted the client, which
    // already emptied oauth_codes, so the FK "deleting a user also cascades its codes" was never exercised: an admin deleting a user
    // with a pending code would hit the FK as a 500.
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
    // the client itself doesn't disappear with the user (it belongs to no one)
    const clients = await pool.query(`select count(*)::int as c from oauth_clients`);
    expect(clients.rows[0].c).toBe(1);
  });

  it("oauth_requests.state length CHECK (2048) and NULL are both legal", async () => {
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

  it("oauth_requests/oauth_codes scope also has a set CHECK", async () => {
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

  it("four-cell matrix: kind='oauth' missing client_id/refresh_token_hash is also rejected (the other half of the two-way implication)", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t6@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ('c1','MCP client','["http://127.0.0.1:1/cb"]'::jsonb)`
    );
    // The group above only pinned "pat => no client/refresh"; weakening the CHECK to a one-way implication (`kind <> 'pat' or
    // client_id is null`) would stay green. These two cells add "oauth => both present", the shape that should be blocked when #132's /oauth/token omits a column.
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

  it("client_name and api_tokens.name have length limits; redirect_uris must be an array of 1..8 elements", async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into users (email, display_name) values ('t7@example.com', 'T')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;

    // DCR is an unauthenticated endpoint and client_name is rendered on the consent page: the length is blocked at the DB.
    // Use a **boundary pair** (64 passes / 65 fails) rather than "insert 201 chars": the latter is green for any limit between 64 and
    // 200, so the limit value itself isn't pinned.
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

    // Shape: an object instead of an array, an empty array, and more than 8 are all invalid
    for (const [id, uris] of [
      ["obj", `'{"a":1}'::jsonb`],
      ["empty-arr", `'[]'::jsonb`],
      // The ::text can't be dropped: a bare literal under jsonb_agg leaves PG unable to resolve the polymorphic parameter type
      // (42P18), which would be a query error rather than the CHECK violation we want to test.
      ["too-many", `(select jsonb_agg('http://127.0.0.1:1/cb'::text) from generate_series(1,9))`],
    ] as const) {
      await expect(
        pool.query(`insert into oauth_clients (client_id, client_name, redirect_uris) values ($1,'n',${uris})`, [id]),
        id
      ).rejects.toMatchObject({ code: "23514", constraint: "oauth_clients_redirect_uris_chk" });
    }

    // The same boundary pair. The two tables' limits must match: api_tokens.name is a snapshot of client_name, so if this side
    // were stricter #132's copy would hit the CHECK.
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

  it("refresh_token_hash is globally unique, but NULLs of multiple PATs don't conflict (#132 relies on it to hit exactly one row)", async () => {
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
    // Grants of different clients aren't constrained by oauth_user_client_uidx, so the collision here is necessarily the
    // refresh_token_hash UNIQUE (without it this case would be green).
    await expect(oauth("a2", "c2")).rejects.toMatchObject({
      code: "23505",
      constraint: "api_tokens_refresh_token_hash_unique",
    });

    // Reverse: the refresh_token_hash of multiple PATs is NULL, UNIQUE must not block (NULLS DISTINCT)
    for (const h of ["p1", "p2", "p3"])
      await pool.query(
        `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read',$2)`,
        [userId, h]
      );
    const pats = await pool.query(`select count(*)::int as c from api_tokens where kind = 'pat'`);
    expect(pats.rows[0].c).toBe(3);
  });

  it("oauth_clients.last_used_at is NOT NULL DEFAULT now() (#132's cleanup predicate needn't handle NULL)", async () => {
    const { pool } = await freshDb();
    // Deliberately the opposite of api_tokens.last_used_at (nullable, NULL = never used): this difference is a load-bearing design
    // decision written in the JSDoc; this is its pin.
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

  it("all six indexes exist (five of them support FKs: CASCADE deletes shouldn't degrade to full-table scans)", async () => {
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

  it("the thirty-two schema.ts table declarations listed here haven't silently drifted: columns, index names, CHECK names and expressions (verbatim against the snapshot), notNull and FKs", async () => {
    // Same family of guards as 0008: match schema.ts's declarations against the migration-built DB. Without this case a declaration
    // could drift from the DB unnoticed until the next db:generate emits a DROP/ALTER.
    // Guarded (schema.ts <-> DB): column name sets, "declared index names exist in the DB", "declared CHECK names exist in the DB".
    // This case also compares schema.ts <-> snapshot CHECK name sets and expressions (verbatim): that is schema.ts <-> snapshot, not <-> DB.
    // Not checked against the DB: PK and FK (FK names and onDelete are compared only schema.ts <-> snapshot), index shape (unique/partial)
    // except for the partial unique indexes asserted at the end of this case, an extra index in the DB that schema.ts lacks, CHECK expressions in the DB (0012 SQL) disagreeing with schema.ts/snapshot (hand-reordered
    // SQL with a wrong expression): the latter is caught only for the combinations the 0012 describe's DB guard cases test one by one.
    // Full schema.ts <-> snapshot equivalence (beyond CHECKs) is guarded by `drizzle-kit generate` answering "No schema changes"
    // (without looking at the DB); the migration-harness 3-way case compares the same SQL run via the harness and via drizzle, not schema.ts <-> DB.
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
      groups: ["id", "name", "created_by", "created_at", "storage_plan_id", "auto_versions"],
      group_members: ["group_id", "user_id", "role_id", "created_at"],
      group_roles: [
        "id", "group_id", "builtin", "name", "can_read", "can_create", "can_edit", "can_delete",
        "can_manage_public_link", "can_manage_members", "can_manage_group", "created_at",
      ],
      note_redirects: ["old_path", "note_id", "expires_at", "created_at"],
      auth_providers: [
        "id", "template", "display_name", "issuer_url", "resolved_issuer", "client_id", "client_secret_encrypted",
        "enabled", "sort_order", "legacy_callback", "config_version", "auto_create_enabled", "created_at", "updated_at",
        "icon_kind", "icon_data", "icon_mime", "icon_version",
      ],
      user_identities: ["id", "user_id", "issuer", "sub", "created_at", "last_login_at", "last_picture_url", "picture_dismissed_url"],
      site_settings: [
        "singleton", "registration_enabled", "password_login_enabled", "legacy_oidc_env_handled_at", "updated_at",
        "default_user_storage_plan_id", "default_group_storage_plan_id",
        "version_keep_all_days", "version_daily_until_days", "auto_versions_enabled", "version_auto_wait_minutes", "trash_retention_days",
      ],
      note_search_sections: ["id", "note_id", "source_kind", "source_id", "section_id", "ord", "heading", "body"],
      note_search_state: ["note_id", "extractor_version", "source_version", "content_hash", "indexed_units", "capped", "indexed_at"],
      transfer_tokens: ["id", "token_hash", "parent_token_id", "note_id", "purpose", "expires_at", "consumed_at", "created_at", "access", "range"],
      transfer_bases: [
        "key", "user_id", "note_id", "salt", "key_id", "body_sha", "title_sha", "line_hashes", "line_kinds", "segments",
        "applied_body_sha", "applied_edit_ids", "applied_title_sha", "created_at", "last_used_at",
      ],
      transfer_creates: ["user_id", "file_sha", "note_id", "key_id", "created_at"],
      notes: [
        "id", "owner_id", "title", "slug", "slug_is_custom", "prev_slug", "legacy_slug", "public_token", "public_slug", "public_width",
        "links_clock", "created_at", "updated_at", "last_edited_at", "last_edited_by", "last_edited_token_id",
        "last_edited_agent_label", "deleted_at", "deleted_by", "group_id",
        "version_counter", "version_base_seq", "version_base_fingerprint", "version_pending_at", "version_pending_editors", "version_pending_ref_fingerprint", "version_base_version_id",
        "folder_id", "trash_folder_path",
      ],
      folders: ["id", "kind", "owner_id", "group_id", "parent_id", "name", "created_by", "created_at"],
      note_placements: ["user_id", "note_id", "folder_id"],
      note_favorites: ["user_id", "note_id", "created_at"],
      tags: ["id", "owner_id", "group_id", "name", "name_key", "color", "created_by", "created_at"],
      note_tags: ["note_id", "tag_id", "created_at"],
      users: [
        "id", "email", "handle", "password_hash", "oidc_issuer", "oidc_sub", "display_name", "avatar_url", "is_admin",
        "disabled_at", "token_version", "must_change_password", "created_at", "storage_plan_id", "auto_versions",
        "last_login_at", "last_active_at", "avatar_auto",
      ],
      storage_plans: ["id", "name", "quota_bytes", "created_at", "updated_at"],
      note_versions: ["id", "note_id", "seq", "ydoc", "kind", "name", "editors", "base_seq", "base_version_id", "created_at"],
      note_link_conversion: ["note_id", "status", "attempts", "converted", "unresolved", "updated_at"],
      handle_renames: ["id", "user_id", "renamed_at"],
      one_time_links: ["id", "kind", "token_hash", "target_user_id", "created_by_id", "expires_at", "used_at", "revoked_at", "created_at", "label", "used_by_id"],
      sessions: ["id", "user_id", "created_at", "expires_at"],
      site_limits: ["key", "value", "updated_at"],
      site_limit_changes: ["id", "key", "old_value", "new_value", "old_effective", "new_effective", "actor_user_id", "changed_at"],
      user_avatars: [
        "id", "user_id", "source", "identity_id", "oidc_picture_url", "original_file", "original_sha256", "original_mime",
        "original_size", "original_width", "original_height", "crop_x", "crop_y", "crop_size", "display_data", "display_mime",
        "display_size", "version", "is_current", "created_at",
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
      ["transfer_bases", transferBases],
      ["transfer_creates", transferCreates],
      ["users", users],
      ["storage_plans", storagePlans],
      ["note_versions", noteVersions],
      ["note_link_conversion", noteLinkConversion],
      ["handle_renames", handleRenames],
      ["one_time_links", oneTimeLinks],
      ["folders", folders],
      ["note_placements", notePlacements],
      ["sessions", sessions],
      ["site_limits", siteLimits],
      ["site_limit_changes", siteLimitChanges],
      ["note_favorites", noteFavorites],
      ["tags", tags],
      ["note_tags", noteTags],
      ["user_avatars", userAvatars],
    ] as const) {
      const cfg = getTableConfig(decl);
      // declared column names = DB column names = the hardcoded expectation here (three-way alignment, red if any side drifts)
      const declared = cfg.columns.map(c => c.name).sort();
      const { rows } = await pool.query(
        `select column_name from information_schema.columns where table_name = $1`,
        [table]
      );
      const inDb = rows.map((r: { column_name: string }) => r.column_name).sort();
      expect(declared, table).toEqual(expectedColumns[table]!.slice().sort());
      expect(inDb, table).toEqual(expectedColumns[table]!.slice().sort());

      // every declared index name really exists in the DB
      const idxRows = await pool.query(`select indexname from pg_indexes where tablename = $1`, [table]);
      const dbIdx = idxRows.rows.map((r: { indexname: string }) => r.indexname);
      for (const i of cfg.indexes) expect(dbIdx, `${table}.${i.config.name}`).toContain(i.config.name);

      // every declared CHECK name really exists in the DB
      const chkRows = await pool.query(
        `select conname from pg_constraint where conrelid = $1::regclass and contype = 'c'`,
        [table]
      );
      const dbChk = chkRows.rows.map((r: { conname: string }) => r.conname);
      for (const c of cfg.checks) expect(dbChk, `${table}.${c.name}`).toContain(c.name);

      // Names alone aren't enough: changing a number in a schema.ts CHECK without re-running db:generate leaves the name present and
      // the DB at the old value, so everything above stays green, and the next generate silently emits a DROP/ADD CONSTRAINT.
      // The snapshot is drizzle's serialization of schema.ts, and a verbatim comparison against it is the real drift guard.
      const snapshotChecks = snapshotLatest.tables[`public.${table}`]?.checkConstraints ?? {};
      expect(Object.keys(snapshotChecks).sort(), `${table} 的 CHECK 名集合`).toEqual(
        cfg.checks.map(c => c.name).sort()
      );
      for (const c of cfg.checks) {
        expect(pgDialect.sqlToQuery(c.value).sql, `${table}.${c.name} 的運算式`).toBe(
          snapshotChecks[c.name]!.value
        );
      }

      // notNull and FKs (name + onDelete) are also compared to the snapshot: red if schema.ts changed without regenerating.
      const snapTable = snapshotLatest.tables[`public.${table}`];
      for (const c of cfg.columns) {
        expect(snapTable?.columns?.[c.name]?.notNull, `${table}.${c.name} 的 notNull`).toBe(c.notNull);
      }
      const snapFks = snapTable?.foreignKeys ?? {};
      expect(Object.keys(snapFks).sort(), `${table} 的 FK 名集合`).toEqual(cfg.foreignKeys.map(f => f.getName()).sort());
      for (const f of cfg.foreignKeys) {
        expect(snapFks[f.getName()]?.onDelete ?? "no action", `${table}.${f.getName()} 的 onDelete`).toBe(f.onDelete ?? "no action");
      }
    }

    // shape of the partial unique index (without where it becomes table-wide unique and PATs would be wrongly blocked)
    const apiCfg = getTableConfig(apiTokens);
    const uidx = apiCfg.indexes.find(i => i.config.name === "api_tokens_oauth_user_client_uidx");
    expect(uidx).toBeDefined();
    expect(uidx!.config.unique).toBe(true);
    expect(uidx!.config.where, "partial where 不可省略").toBeDefined();
    expect(uidx!.config.columns.map(c => (c as { name?: string }).name)).toEqual(["user_id", "client_id"]);

    // user_avatars' two partial unique indexes: dropping unique or where would degrade "at most one current avatar" / "at most one
    // per identity" (or over-block). Compare all three sides: declaration (unique/where/columns), snapshot (isUnique/where verbatim), DB (indexdef).
    const avatarCfg = getTableConfig(userAvatars);
    const avatarSnap = snapshotLatest.tables["public.user_avatars"]!.indexes!;
    for (const [name, column, dbWhere] of [
      ["user_avatars_identity_idx", "identity_id", "(identity_id IS NOT NULL)"],
      ["user_avatars_current_idx", "user_id", "is_current"],
    ] as const) {
      const idx = avatarCfg.indexes.find(i => i.config.name === name);
      expect(idx, `${name} 宣告存在`).toBeDefined();
      expect(idx!.config.unique, `${name} 必須是 unique`).toBe(true);
      expect(idx!.config.where, `${name} 的 partial where 不可省略`).toBeDefined();
      expect(idx!.config.columns.map(c => (c as { name?: string }).name), `${name} 的欄`).toEqual([column]);
      expect(pgDialect.sqlToQuery(idx!.config.where!).sql, `${name} 的 where 對 snapshot`).toBe(avatarSnap[name]!.where);
      expect(avatarSnap[name]!.isUnique, `${name} 的 snapshot isUnique`).toBe(true);
      const { rows } = await pool.query(`select indexdef from pg_indexes where tablename = 'user_avatars' and indexname = $1`, [name]);
      expect(rows[0]?.indexdef, `${name} 的 DB 定義`).toBe(`CREATE UNIQUE INDEX ${name} ON public.user_avatars USING btree (${column}) WHERE ${dbWhere}`);
    }
  });

  it("no CONCURRENTLY/line-leading COMMIT in the 0009 file (helper grep for the single-tx premise, like 0007/0008)", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0009"));
    expect(entry, "0009 migration 必須存在").toBeDefined();
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("0010: the four CHECKs of note_ai_edits take effect, revert_of CASCADE, deleting a note deletes its records, api_tokens.agent_label CHECK", async () => {
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

  it("no CONCURRENTLY/line-leading COMMIT in the 0011 file (helper grep for the single-tx premise, like 0009)", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0011"));
    expect(entry, "0011 migration 必須存在").toBeDefined();
    expect(entry!.tag).toBe("0011_groups");
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("0011: applied to existing data group_id=null, group_role='editor'; three CHECKs, two CASCADEs and two SET NULLs take effect", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0010_ai-editing"));
    const owner = (await pool.query(`insert into users (email, handle, display_name) values ('m@x', 'm0011', 'M') returning id`)).rows[0].id;
    const preexisting = (await pool.query(`insert into notes (owner_id, slug) values ($1, 'pre-0011') returning id`, [owner])).rows[0].id;
    // #175: stop at 0011: runMigrations would run on to 0012, which retires group_role and changes the FK to RESTRICT.
    await applyMigrationsThrough(pool, idxOfTag("0011_groups"), idxOfTag("0011_groups"));

    expect((await pool.query(`select group_id, group_role from notes where id = $1`, [preexisting])).rows[0]).toEqual({
      group_id: null,
      group_role: "editor",
    });

    // CHECK: name of 1..80 characters (length() counts code points: 80 emoji pass, their UTF-16 length is 160)
    await expect(pool.query(`insert into groups (name) values ('')`)).rejects.toMatchObject({ code: "23514", constraint: "groups_name_chk" });
    await expect(pool.query(`insert into groups (name) values ($1)`, ["x".repeat(81)])).rejects.toMatchObject({ code: "23514", constraint: "groups_name_chk" });
    const g = (await pool.query(`insert into groups (name, created_by) values ($1, $2) returning id`, ["\u{1F600}".repeat(80), owner])).rows[0].id;
    await expect(pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`, [g, owner])).rejects.toMatchObject({ code: "23514", constraint: "group_members_role_chk" });
    await expect(pool.query(`update notes set group_role = 'owner' where id = $1`, [preexisting])).rejects.toMatchObject({ code: "23514", constraint: "notes_group_role_chk" });

    // deleting a group: notes.group_id SET NULL, group_members CASCADE
    await pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')`, [g, owner]);
    await pool.query(`update notes set group_id = $1 where id = $2`, [g, preexisting]);
    await pool.query(`delete from groups where id = $1`, [g]);
    expect((await pool.query(`select group_id from notes where id = $1`, [preexisting])).rows[0].group_id).toBeNull();
    expect((await pool.query(`select 1 from group_members where group_id = $1`, [g])).rowCount).toBe(0);

    // deleting a user (one with no notes: notes.owner_id is RESTRICT): groups.created_by SET NULL, group_members CASCADE
    const creator = (await pool.query(`insert into users (email, handle, display_name) values ('c@x', 'c0011', 'C') returning id`)).rows[0].id;
    const g2 = (await pool.query(`insert into groups (name, created_by) values ('G2', $1) returning id`, [creator])).rows[0].id;
    await pool.query(`insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')`, [g2, creator]);
    await pool.query(`delete from users where id = $1`, [creator]);
    expect((await pool.query(`select created_by from groups where id = $1`, [g2])).rows[0].created_by).toBeNull();
    expect((await pool.query(`select 1 from group_members where user_id = $1`, [creator])).rowCount).toBe(0);
  });
});

/**
 * #175: 0012_groups-v2. All fixtures run on the data-case harness: applyThrough(0011) -> seed 0011-shaped data -> runMigrations
 * (0012 and 0013 pending) -> compare column by column.
 */
describe("0012_groups-v2 (#175)", () => {
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

  it("dedupe within a group meeting/meeting-3/meeting-2, personal meeting-2 untouched, 4 redirect rows, group notes' shares and aliases cleared while personal notes' share/alias/prev are kept as is, roles mounted", async () => {
    const { pool } = await migrateWith(`${users3}
      insert into groups (id, name, created_by) values ('${G}','G','${A}'), ('${H}','Empty','${A}');
      insert into group_members (group_id, user_id, role) values ('${G}','${A}','admin'), ('${G}','${B}','member'), ('${H}','${A}','admin');
      insert into notes (id, owner_id, title, slug, group_id, group_role, created_at, public_token, public_slug) values
        ('${n("01")}','${A}','m','meeting','${G}','editor', now()-interval '3 day', null, null),
        ('${n("02")}','${B}','m','meeting','${G}','viewer', now()-interval '2 day', null, null),
        ('${n("03")}','${B}','m2','meeting-2','${G}','editor', now()-interval '1 day','tok1','m2pub'),
        ('${n("04")}','${C}','c','carol-a1','${G}','editor', now(), null, null),
        ('${n("05")}','${A}','p','meeting-2', null,'editor', now(), null, null);
      -- 「不該動」方向：個人筆記帶 share、公開別名、prev（prev 恰等於群組篇的 slug）
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
    // Group note n01's share is cleared, personal note n06's stays
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
    // Each group has exactly two built-in roles (the empty group Empty too), name always NULL; seven flags follow the migration's second step
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
    // Redirects last one month: expires_at falls within now()+1 month +/- 1 minute
    const { rows: e } = await pool.query(
      `select bool_and(abs(extract(epoch from (expires_at - (now() + interval '1 month')))) < 60) as ok from note_redirects`,
    );
    expect(e[0].ok).toBe(true);
  });

  it("counter-example: the renamed note's original owner also has a same-named personal note -> migration succeeds, bob's group note -> meeting-2, personal meeting-2 untouched", async () => {
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

  it("legacy kept, group notes' prev cleared, alias cleared with the token kept, note A1 present, redirects only for the current slug (3 rows); personal notes' old prev untouched", async () => {
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

  it("the older one (custom, alias + token) keeps spec; the newer skips the taken -2 -> spec-3; /n/carol/spec redirects to the older one", async () => {
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

  it("counter-example: only the current slug gets a redirect; no /n/alice/z (z is still personal note P's live URL); B and C's old prevs are invalid", async () => {
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

  it("DB guards: constraint names asserted one by one (asserting only SQLSTATE would be a false green)", async () => {
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
    // Custom role names: names differing only in case hit group_roles_name_idx; two built-in rows with NULL names don't collide (the first case above already has two rows)
    await pool.query(`insert into group_roles (group_id, name) values ($1, 'Reader')`, [G]);
    await expect(pool.query(`insert into group_roles (group_id, name) values ($1, 'reader')`, [G])).rejects.toMatchObject({
      code: "23505",
      constraint: "group_roles_name_idx",
    });
    // The name length upper bound itself is legal (40 chars)
    await pool.query(`insert into group_roles (group_id, name) values ($1, repeat('y', 40))`, [G]);
    // A role still mounted by members can't be deleted (composite FK without ON DELETE)
    await expect(pool.query(`delete from group_roles where id = $1`, [adminRoleH])).rejects.toMatchObject({
      code: "23503",
      constraint: "group_members_role_fk",
    });
    // A personal and a group note can share a slug; a group with no notes but **members** can be deleted (the real shape of group deletion), members and roles CASCADE with it
    await pool.query(`insert into notes (owner_id, title, slug) values ($1, 't', 'dup')`, [A]);
    const countIn = async (table: string) =>
      (await pool.query(`select count(*)::int as c from ${table} where group_id = $1`, [H])).rows[0].c as number;
    expect(await countIn("group_members")).toBe(1);
    await pool.query(`delete from groups where id = $1`, [H]);
    expect([await countIn("group_members"), await countIn("group_roles")]).toEqual([0, 0]);
    // note_redirects.note_id ON DELETE CASCADE: the redirect 0012 backfilled for n01 disappears with the note
    const redirectsOfN01 = async () =>
      (await pool.query(`select old_path from note_redirects where note_id = $1`, [n("01")])).rows.map(r => r.old_path as string);
    expect(await redirectsOfN01()).toEqual(["/n/alice/dup"]);
    await pool.query(`delete from notes where id = $1`, [n("01")]);
    expect(await redirectsOfN01()).toEqual([]);
  });

  it("no CONCURRENTLY/line-leading COMMIT in the 0012 file (helper grep for the single-tx premise, like 0011)", () => {
    const entry = journalEntries().find(e => e.tag.startsWith("0012"));
    expect(entry, "0012 migration 必須存在").toBeDefined();
    expect(entry!.tag).toBe("0012_groups-v2");
    const sql = readFileSync(path.join(drizzleDirForTest, `${entry!.tag}.sql`), "utf8");
    expect(sql.toUpperCase()).not.toContain("CONCURRENTLY");
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

describe("0013_role-create-without-edit (#175)", () => {
  it("0012 blocks create-only roles; after 0013 they pass, the other CHECKs remain", async () => {
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

describe("0014_auth-providers (#187)", () => {
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

  it("complete oidc columns -> one identity row (created_at carried over); password-only -> none; half-filled -> none; old columns kept as is", async () => {
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

  it("site_settings has exactly one row, registration_enabled=true, password_login_enabled=true, legacy_oidc_env_handled_at NULL: same result whether instance_setup has a row or not", async () => {
    for (const fixture of ["", `insert into instance_setup (singleton) values (true);`]) {
      const { pool } = await migrateWith(fixture);
      const { rows } = await pool.query(`select singleton, registration_enabled, password_login_enabled, legacy_oidc_env_handled_at from site_settings`);
      expect(rows).toEqual([{ singleton: true, registration_enabled: true, password_login_enabled: true, legacy_oidc_env_handled_at: null }]);
      // Since the quota migration, site_settings has two more NOT NULL default-plan columns; omitting them would hit 23502 first and never reach the CHECK/PK under test.
      const plan = `(select id from storage_plans where name = 'Basic')`;
      await expect(pool.query(`insert into site_settings (singleton, default_user_storage_plan_id, default_group_storage_plan_id) values (false, ${plan}, ${plan})`)).rejects.toMatchObject({
        code: "23514",
        constraint: "site_settings_singleton_chk",
      });
      await expect(pool.query(`insert into site_settings (singleton, default_user_storage_plan_id, default_group_storage_plan_id) values (true, ${plan}, ${plan})`)).rejects.toMatchObject({
        code: "23505",
        constraint: "site_settings_pkey",
      });
    }
  });

  it("password_login_enabled is true after migration: same with or without an instance_setup row (on for fresh and upgraded alike); the column is NOT NULL (SET NULL rejected)", async () => {
    // Overlaps the previous case's expected row (which also asserts true), but NOT NULL needs a case of its own: the true expectation alone wouldn't notice the column becoming nullable.
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

  it("enabling without a secret is rejected, a second legacy is rejected, an issuer of 513 chars is rejected, template/display name/client id guarded (constraint names asserted one by one)", async () => {
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
    // Non-legacy rows can be many (the partial unique constrains only legacy_callback = true).
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
    // An issuer of 512 chars fits exactly (the upper bound is closed).
    await ins(base, `'${randomUUID()}', 'oidc', 'X', 'https://${"i".repeat(504)}', 'c'`);
    await expect(
      pool.query(`update auth_providers set resolved_issuer = $1 where id = '${P2}'`, ["https://" + "r".repeat(505)]),
    ).rejects.toMatchObject({ code: "23514", constraint: "auth_providers_resolved_issuer_chk" });
    const defaults = await pool.query(
      `select enabled, sort_order, legacy_callback, config_version, resolved_issuer from auth_providers where id = '${P2}'`,
    );
    expect(defaults.rows).toEqual([{ enabled: false, sort_order: 0, legacy_callback: false, config_version: 1, resolved_issuer: null }]);
  });

  it("user_identities: (issuer, sub) globally unique; one person can have several rows; deleting users CASCADEs", async () => {
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

  it("no CONCURRENTLY/line-leading COMMIT in the 0014 file (helper grep for the single-tx premise, like the ones before 0013)", () => {
    // Matches the **whole file** (including `--` comments): SQL comments must not contain these two words.
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0014_auth-providers.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0015_provider-icon (provider icon)", () => {
  const P = "33333333-3333-4333-8333-333333333333";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const insertBase = (pool: import("pg").Pool) =>
    pool.query(`insert into auth_providers (id, template, display_name, issuer_url, client_id) values ('${P}', 'oidc', 'SSO', 'https://idp.example', 'c')`);

  it("existing rows (created in the 0014 era, e.g. the env-import row) after migration: icon_kind='template', icon_version=0, icon_data/icon_mime NULL", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0014_auth-providers"));
    await insertBase(pool);
    await runMigrations(db);
    const { rows } = await pool.query(`select icon_kind, icon_data, icon_mime, icon_version from auth_providers where id = '${P}'`);
    expect(rows).toEqual([{ icon_kind: "template", icon_data: null, icon_mime: null, icon_version: 0 }]);
  });

  it("CHECKs: each shape violates exactly one, constraint names asserted one by one; legal shapes pass (including the 262144-byte upper bound)", async () => {
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

  it("the allow side lets the whitelist through one by one: each of three mimes once, each of five kinds once", async () => {
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

  it("no CONCURRENTLY/line-leading COMMIT in the 0015 file (helper grep for the single-tx premise, like 0014)", () => {
    // Matches the whole file (including `--` comments): the header comment must not contain these two words.
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0015_provider-icon.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0016_note-search (#93 full-text search)", () => {
  const seedNote = async (pool: import("pg").Pool): Promise<string> => {
    const u = (await pool.query(`insert into users (email, handle, display_name) values ('s93@x', 's93', 'S') returning id`)).rows[0].id;
    return (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id;
  };
  const SRC = "44444444-4444-4444-8444-444444444444";

  it("three CHECKs: each shape violates exactly one, constraint names asserted one by one; legal shapes pass (including attachment + source_id, a 64-char id)", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    const ins = (kind: string, sourceId: string | null, sectionId: string) =>
      pool.query(`insert into note_search_sections (note_id, source_kind, source_id, section_id, ord, body) values ($1, $2, $3, $4, 0, 'b')`, [n, kind, sourceId, sectionId]);
    // PG checks CHECKs in name alphabetical order (section < source_id < source_kind): each shape violates only one, so the reported name is the one under test.
    await expect(ins("pdf", SRC, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_kind_chk" });
    await expect(ins("note", SRC, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_id_chk" });
    await expect(ins("attachment", null, "a")).rejects.toMatchObject({ code: "23514", constraint: "nss_source_id_chk" });
    await expect(ins("note", null, "a/b")).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" });
    await expect(ins("note", null, "x".repeat(65))).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" });
    await expect(ins("note", null, "")).rejects.toMatchObject({ code: "23514", constraint: "nss_section_id_chk" }); // lower bound of {1,64}
    await ins("note", null, "_top");
    await ins("attachment", SRC, "x".repeat(64));
    const { rows } = await pool.query(`select count(*)::int as c from note_search_sections where note_id = $1`, [n]);
    expect(rows[0].c).toBe(2);
  });

  it("id is identity always: an explicit id is rejected; heading defaults to '', source_kind defaults to 'note'", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    await expect(pool.query(`insert into note_search_sections (id, note_id, section_id, ord, body) values (1, $1, 'a', 0, 'b')`, [n])).rejects.toMatchObject({ code: "428C9" });
    await pool.query(`insert into note_search_sections (note_id, section_id, ord, body) values ($1, 'a', 0, 'b')`, [n]);
    const { rows } = await pool.query(`select source_kind, source_id, heading from note_search_sections where note_id = $1`, [n]);
    expect(rows).toEqual([{ source_kind: "note", source_id: null, heading: "" }]);
  });

  it("deleting a note cascades to both tables", async () => {
    const { pool } = await freshDb();
    const n = await seedNote(pool);
    await pool.query(`insert into note_search_sections (note_id, section_id, ord, body) values ($1, '_top', 0, 'b')`, [n]);
    await pool.query(`insert into note_search_state (note_id, extractor_version, source_version, content_hash, indexed_units, capped) values ($1, 1, 1, 'h', 1, false)`, [n]);
    await pool.query(`delete from notes where id = $1`, [n]);
    const a = await pool.query(`select count(*)::int as c from note_search_sections`);
    const b = await pool.query(`select count(*)::int as c from note_search_state`);
    expect([a.rows[0].c, b.rows[0].c]).toEqual([0, 0]);
  });

  it("no CONCURRENTLY/line-leading COMMIT in the 0016 file (helper grep for the single-tx premise, like 0015)", () => {
    // Matches the whole file (including `--` comments): the header comment must not contain these two words. If the file is regenerated under another number before merging, change the name here too.
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0016_note-search.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("transfer_tokens (#200)", () => {
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

  it("three CHECKs: each shape violates exactly one, constraint names asserted one by one; legal shapes pass", async () => {
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
    // valid: an upload can be consumed; a download carries no consumed_at
    await pool.query(insertSql, [`d-${randomUUID()}`, p.tokenId, p.noteId, "upload", "10 minutes", new Date()]);
    await pool.query(insertSql, [`e-${randomUUID()}`, p.tokenId, p.noteId, "download", "10 minutes", null]);
    const { rows } = await pool.query(`select count(*)::int as n from transfer_tokens`);
    expect(rows[0].n).toBe(2);
  });

  it("token_hash is unique", async () => {
    const { pool } = await freshDb();
    const p = await seedParent(pool);
    await pool.query(insertSql, ["dup", p.tokenId, p.noteId, "download", "10 minutes", null]);
    await expect(pool.query(insertSql, ["dup", p.tokenId, p.noteId, "download", "10 minutes", null])).rejects.toMatchObject({
      code: "23505",
      constraint: "transfer_tokens_token_hash_unique",
    });
  });

  it("both FKs are ON DELETE CASCADE: deleting the parent credential or the note takes the child rows", async () => {
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

  it("the transfer-tokens SQL file has no CONCURRENTLY/line-leading COMMIT (helper grep for the single-tx premise, like 0014/0015)", () => {
    // Find the file by tag suffix: it is regenerated under the next number on main before merging, so the number isn't hardcoded.
    const entries = journalEntries().filter(e => e.tag.endsWith("_transfer-tokens"));
    expect(entries, "journal 裡要恰有一支 *_transfer-tokens").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("one_time_links (#286)", () => {
  async function seedUser(pool: import("pg").Pool): Promise<string> {
    const u = await pool.query(`insert into users (email, display_name) values ($1, 'O') returning id`, [`otl-${randomUUID()}@example.com`]);
    return u.rows[0].id as string;
  }
  interface LinkRow {
    kind?: string;
    tokenHash?: string;
    target?: string | null;
    createdBy?: string | null;
    createdAt?: string | null;
    expiresAt?: string | null;
    usedAt?: Date | null;
    revokedAt?: Date | null;
    label?: string | null;
    usedBy?: string | null;
  }
  /** Default: an unused, unrevoked reset row expiring in one hour. */
  function insertLink(pool: import("pg").Pool, r: LinkRow) {
    return pool.query(
      `insert into one_time_links (kind, token_hash, target_user_id, created_by_id, created_at, expires_at, used_at, revoked_at, label, used_by_id)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), coalesce($6::timestamptz, now() + interval '1 hour'), $7, $8, $9, $10)
       returning id`,
      [
        r.kind ?? "password_reset", r.tokenHash ?? `h-${randomUUID()}`, r.target ?? null, r.createdBy ?? null,
        r.createdAt ?? null, r.expiresAt ?? null, r.usedAt ?? null, r.revokedAt ?? null, r.label ?? null, r.usedBy ?? null,
      ],
    );
  }

  it("shape: eleven columns (type/NOT NULL/default), target FK cascade, created_by FK set null, used_by FK set null, `one_time_links_reset_active_uidx` partial unique index, (kind, created_at) index", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'one_time_links' order by column_name`,
    )).rows;
    const tz = "timestamp with time zone";
    expect(cols).toEqual([
      { column_name: "created_at", data_type: tz, is_nullable: "NO", column_default: "now()" },
      { column_name: "created_by_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "expires_at", data_type: tz, is_nullable: "NO", column_default: null },
      { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "kind", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "label", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "revoked_at", data_type: tz, is_nullable: "YES", column_default: null },
      { column_name: "target_user_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "token_hash", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "used_at", data_type: tz, is_nullable: "YES", column_default: null },
      { column_name: "used_by_id", data_type: "uuid", is_nullable: "YES", column_default: null },
    ]);
    const fks = (await pool.query(
      `select a.attname as col, c.confdeltype, c.confrelid::regclass::text as ref
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.conrelid = 'one_time_links'::regclass and c.contype = 'f' order by a.attname`,
    )).rows;
    expect(fks).toEqual([
      { col: "created_by_id", confdeltype: "n", ref: "users" },
      { col: "target_user_id", confdeltype: "c", ref: "users" },
      { col: "used_by_id", confdeltype: "n", ref: "users" },
    ]);
    const uidx = (await pool.query(`select indexdef from pg_indexes where indexname = 'one_time_links_reset_active_uidx'`)).rows;
    expect(uidx).toHaveLength(1);
    const def = uidx[0].indexdef as string;
    expect(def).toMatch(/^CREATE UNIQUE INDEX .* \(target_user_id\) WHERE /);
    expect(def).toContain("'password_reset'");
    expect(def).toContain("used_at IS NULL");
    expect(def).toContain("revoked_at IS NULL");
    const kidx = (await pool.query(`select indexdef from pg_indexes where indexname = 'one_time_links_kind_created_idx'`)).rows;
    expect(kidx).toHaveLength(1);
    expect(kidx[0].indexdef).toMatch(/\(kind, created_at\)/);
  });

  it("four CHECKs: each shape violates exactly one, constraint names asserted one by one; the unused/used/revoked legal shapes pass", async () => {
    const { pool } = await freshDb();
    const t = "2026-01-01T00:00:00Z";
    const cases: Array<[LinkRow, string]> = [
      [{ kind: "t285_bogus", target: await seedUser(pool) }, "one_time_links_kind_chk"],
      [{ target: null }, "one_time_links_reset_target_chk"],
      [{ target: await seedUser(pool), createdAt: t, expiresAt: t }, "one_time_links_expiry_chk"],
      [{ target: await seedUser(pool), usedAt: new Date(), revokedAt: new Date() }, "one_time_links_end_chk"],
    ];
    for (const [row, constraint] of cases) {
      await expect(insertLink(pool, row), constraint).rejects.toMatchObject({ code: "23514", constraint });
    }
    expect((await pool.query(`select count(*)::int as n from one_time_links`)).rows[0].n).toBe(0);
    await insertLink(pool, { target: await seedUser(pool) });
    await insertLink(pool, { target: await seedUser(pool), usedAt: new Date() });
    await insertLink(pool, { target: await seedUser(pool), revokedAt: new Date() });
    expect((await pool.query(`select count(*)::int as n from one_time_links`)).rows[0].n).toBe(3);
  });

  it("the same person's second unused unrevoked reset row hits one_time_links_reset_active_uidx (also when the first is expired); after the first is marked revoked/used it can be inserted; different people don't affect each other", async () => {
    const { pool } = await freshDb();
    const i3 = { code: "23505", constraint: "one_time_links_reset_active_uidx" };

    // First one active -> collides; after marking it revoked a new one can be inserted
    const a = await seedUser(pool);
    const a1 = (await insertLink(pool, { target: a })).rows[0].id as string;
    await expect(insertLink(pool, { target: a }), "a：第二支").rejects.toMatchObject(i3);
    // Different people don't affect each other (a still has one active row)
    const d = await seedUser(pool);
    await insertLink(pool, { target: d });
    await pool.query(`update one_time_links set revoked_at = now() where id = $1`, [a1]);
    await insertLink(pool, { target: a });

    // The first is expired but neither used nor revoked -> still collides (an expired row still holds the `one_time_links_reset_active_uidx` slot)
    const c = await seedUser(pool);
    await insertLink(pool, { target: c, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" });
    await expect(insertLink(pool, { target: c }), "c：第一支已過期").rejects.toMatchObject(i3);

    // After the first is marked used a new one can be inserted
    const b = await seedUser(pool);
    const b1 = (await insertLink(pool, { target: b })).rows[0].id as string;
    await expect(insertLink(pool, { target: b }), "b：第二支").rejects.toMatchObject(i3);
    await pool.query(`update one_time_links set used_at = now() where id = $1`, [b1]);
    await insertLink(pool, { target: b });
  });

  it("token_hash is unique (one_time_links_token_hash_unique)", async () => {
    const { pool } = await freshDb();
    await insertLink(pool, { target: await seedUser(pool), tokenHash: "dup" });
    await expect(insertLink(pool, { target: await seedUser(pool), tokenHash: "dup" })).rejects.toMatchObject({
      code: "23505",
      constraint: "one_time_links_token_hash_unique",
    });
  });

  it("FK: deleting the target user -> the row disappears; deleting the creator -> created_by_id becomes NULL and the row stays", async () => {
    const { pool } = await freshDb();
    const admin = await seedUser(pool);
    const target = await seedUser(pool);
    const other = await seedUser(pool);
    const gone = (await insertLink(pool, { target, createdBy: admin })).rows[0].id as string;
    const kept = (await insertLink(pool, { target: other, createdBy: admin })).rows[0].id as string;
    await pool.query(`delete from users where id = $1`, [target]);
    expect((await pool.query(`select id from one_time_links where id = $1`, [gone])).rows).toHaveLength(0);
    await pool.query(`delete from users where id = $1`, [admin]);
    const rows = (await pool.query(`select id, created_by_id, target_user_id from one_time_links`)).rows;
    expect(rows).toEqual([{ id: kept, created_by_id: null, target_user_id: other }]);
  });

  it("the one-time-links SQL file has no CONCURRENTLY/line-leading COMMIT (helper grep for the single-tx premise, like transfer-tokens)", () => {
    // Find the file by tag suffix: it may be regenerated under the next number on main before merging, so the number isn't hardcoded.
    const entries = journalEntries().filter(e => e.tag.endsWith("_one-time-links"));
    expect(entries, "journal 裡要恰有一支 *_one-time-links").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });

  describe("one_time_links invite extension (#285)", () => {
    it("four new CHECKs: each shape violates exactly one, constraint names asserted one by one", async () => {
      const { pool } = await freshDb();
      const cases: Array<[string, LinkRow, string]> = [
        ["invite 帶 target", { kind: "invite", target: await seedUser(pool) }, "one_time_links_invite_target_chk"],
        ["重設列帶 label", { target: await seedUser(pool), label: "x" }, "one_time_links_invite_fields_chk"],
        ["重設列帶 used_by", { target: await seedUser(pool), usedBy: await seedUser(pool), usedAt: new Date() }, "one_time_links_invite_fields_chk"],
        ["label 空字串", { kind: "invite", label: "" }, "one_time_links_label_chk"],
        ["label 101 字", { kind: "invite", label: "字".repeat(101) }, "one_time_links_label_chk"],
        ["used_by 沒有 used_at", { kind: "invite", usedBy: await seedUser(pool) }, "one_time_links_used_by_chk"],
      ];
      for (const [name, row, constraint] of cases) {
        await expect(insertLink(pool, row), name).rejects.toMatchObject({ code: "23514", constraint });
      }
      expect((await pool.query(`select count(*)::int as n from one_time_links`)).rows[0].n).toBe(0);
    });

    it("legal shapes: multiple unused invites coexist, a label of 100 code points (including emoji), a used invite; deleting the used_by user -> the column becomes NULL and the row stays", async () => {
      const { pool } = await freshDb();
      await insertLink(pool, { kind: "invite" });
      await insertLink(pool, { kind: "invite" });
      await insertLink(pool, { kind: "invite", label: "字".repeat(100) });
      await insertLink(pool, { kind: "invite", label: "😀".repeat(100) }); // 100 code points, 200 UTF-16 units
      const user = await seedUser(pool);
      const usedAt = new Date("2026-01-01T00:00:00Z");
      const usedId = (await insertLink(pool, { kind: "invite", usedAt, usedBy: user })).rows[0].id as string;
      expect((await pool.query(`select count(*)::int as n from one_time_links`)).rows[0].n).toBe(5);
      await pool.query(`delete from users where id = $1`, [user]);
      const row = (await pool.query(`select used_by_id, used_at from one_time_links where id = $1`, [usedId])).rows[0];
      expect(row.used_by_id).toBeNull();
      expect(row.used_at).toEqual(usedAt);
    });

    it("upgrade shape: an existing reset row survives the kind_chk DROP + ADD, and an invite row can be inserted", async () => {
      const { pool, db } = await freshEmptyDb();
      const base = journalEntries().filter(e => e.tag.endsWith("_one-time-links"));
      expect(base, "journal 裡要恰有一支 *_one-time-links").toHaveLength(1);
      await applyMigrationsThrough(pool, base[0]!.idx);
      const target = await seedUser(pool);
      // Old shape (no label/used_by_id yet)
      await pool.query(
        `insert into one_time_links (kind, token_hash, target_user_id, expires_at) values ('password_reset', 'old-row', $1, now() + interval '1 hour')`,
        [target],
      );
      await runMigrations(db);
      expect((await pool.query(`select kind, label, used_by_id from one_time_links where token_hash = 'old-row'`)).rows)
        .toEqual([{ kind: "password_reset", label: null, used_by_id: null }]);
      await insertLink(pool, { kind: "invite" });
      expect((await pool.query(`select count(*)::int as n from one_time_links`)).rows[0].n).toBe(2);
    });

    it("the invites SQL file has no CONCURRENTLY/line-leading COMMIT, and the kind_chk DROP comes before ADD", () => {
      const entries = journalEntries().filter(e => e.tag.endsWith("_invites"));
      expect(entries, "journal 裡要恰有一支 *_invites").toHaveLength(1);
      const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
      expect(sqlText).not.toMatch(/CONCURRENTLY/i);
      expect(sqlText).not.toMatch(/^\s*COMMIT/im);
      const drop = sqlText.indexOf(`DROP CONSTRAINT "one_time_links_kind_chk"`);
      const add = sqlText.indexOf(`ADD CONSTRAINT "one_time_links_kind_chk"`);
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(add).toBeGreaterThan(drop);
    });
  });
});

describe("storage quota migration", () => {
  // After a rebase change only these two tags (and SNAPSHOT_FILE at the top).
  const QUOTA_TAG = "0018_storage-quota";
  const PREV_TAG = "0017_transfer-tokens";
  const GIB = 1024 ** 3;

  async function seededBeforeQuota() {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(PREV_TAG));
    const u = await pool.query<{ id: string }>(
      `insert into users (email, handle, display_name) values ('a@x.test','qa','A'),('b@x.test','qb','B'),('c@x.test','qc','C') returning id`,
    );
    const [a, b, c] = u.rows.map(r => r.id);
    const g = await pool.query<{ id: string }>(`insert into groups (name) values ('G1'),('G2') returning id`);
    const [g1, g2] = g.rows.map(r => r.id);
    // Three users and two groups, each with an attachment: five spaces, one note each, each with an attachment.
    const note = async (col: "owner_id" | "group_id", id: string, slug: string) =>
      (await pool.query<{ id: string }>(`insert into notes (${col}, slug) values ($1, $2) returning id`, [id, slug])).rows[0]!.id;
    const [na, nb, nc, ng1, ng2] = [
      await note("owner_id", a!, "na"), await note("owner_id", b!, "nb"), await note("owner_id", c!, "nc"),
      await note("group_id", g1!, "ng1"), await note("group_id", g2!, "ng2"),
    ];
    // uploads.size is an integer (max 2^31-1 < 2 GiB): two rows of 1.5 GiB each push a's space over 2 GiB.
    await pool.query(`insert into uploads (note_id, uploader_id, mime, size) values ($1,$2,'image/png',$3),($1,$2,'image/png',$3)`, [na, a, Math.floor(1.5 * GIB)]);
    await pool.query(
      `insert into uploads (note_id, uploader_id, mime, size) values ($1,$5,'image/png',100),($2,$6,'image/png',200),($3,$5,'image/png',300),($4,$6,'image/png',400)`,
      [nb, nc, ng1, ng2, b, c],
    );
    return { pool, db, userIds: u.rows.map(r => r.id), groupIds: g.rows.map(r => r.id) };
  }

  it("existing users and groups -> Basic; Basic is 2 GiB; both defaults = Basic; a space over 2 GiB leaves data alone (no deletion, no usage backfill)", async () => {
    const { pool, db, userIds, groupIds } = await seededBeforeQuota();
    await runMigrations(db);
    const basic = (await pool.query(`select id, name, quota_bytes from storage_plans`)).rows;
    expect(basic).toHaveLength(1);
    expect(basic[0]).toMatchObject({ name: "Basic", quota_bytes: "2147483648" }); // int8 comes back as a string through pool.query
    const basicId = basic[0].id as string;
    const users = (await pool.query(`select id, storage_plan_id from users order by id`)).rows;
    expect(users.map(r => r.storage_plan_id)).toEqual(userIds.map(() => basicId));
    const groups = (await pool.query(`select storage_plan_id from groups`)).rows;
    expect(groups.map(r => r.storage_plan_id)).toEqual(groupIds.map(() => basicId));
    expect((await pool.query(`select default_user_storage_plan_id u, default_group_storage_plan_id g from site_settings`)).rows)
      .toEqual([{ u: basicId, g: basicId }]);
    expect((await pool.query(`select count(*)::int n, sum(size)::text s from uploads`)).rows[0]).toEqual({ n: 6, s: String(2 * Math.floor(1.5 * GIB) + 1000) });
  });

  it("DEFAULT function = snapshot: a direct insert without a plan gets the current default; after changing the default new rows follow it and old rows don't; users read the user default, groups the group default (set to different plans); same when search_path doesn't include public", async () => {
    const { pool } = await freshDb();
    const basicId = (await pool.query(`select id from storage_plans where name = 'Basic'`)).rows[0].id;
    const client = await pool.connect();
    const insUser = async (h: string) =>
      (await client.query(`insert into public.users (email, handle, display_name) values ($1, $2, 'D') returning storage_plan_id`, [`${h}@x.test`, h])).rows[0].storage_plan_id;
    const insGroup = async (name: string) =>
      (await client.query(`insert into public.groups (name) values ($1) returning storage_plan_id`, [name])).rows[0].storage_plan_id;
    try {
      expect(await insUser("d1")).toBe(basicId);
      expect(await insGroup("G1")).toBe(basicId);
      const p = (await pool.query(`insert into storage_plans (name, quota_bytes) values ('Pro', null) returning id`)).rows[0].id;
      const q = (await pool.query(`insert into storage_plans (name, quota_bytes) values ('Team', 1) returning id`)).rows[0].id;
      // Change only the user default: a new user -> P, a new group is still Basic (groups must not read the user default).
      await pool.query(`update site_settings set default_user_storage_plan_id = $1`, [p]);
      expect(await insUser("d2")).toBe(p);
      expect(await insGroup("G2")).toBe(basicId);
      // Then change the group default to Q (!= P): a new group -> Q, a new user is still P (users must not read the group default).
      await pool.query(`update site_settings set default_group_storage_plan_id = $1`, [q]);
      expect(await insGroup("G3")).toBe(q);
      expect(await insUser("d3")).toBe(p);
      // Snapshot: old rows untouched.
      expect((await pool.query(`select storage_plan_id from users where handle = 'd1'`)).rows[0].storage_plan_id).toBe(basicId);
      expect((await pool.query(`select name, storage_plan_id from groups order by name`)).rows)
        .toEqual([{ name: "G1", storage_plan_id: basicId }, { name: "G2", storage_plan_id: basicId }, { name: "G3", storage_plan_id: q }]);
      // search_path without public: the function body must write `public.site_settings` itself.
      await client.query(`set search_path to pg_catalog`);
      expect(await insUser("d4")).toBe(p);
      expect(await insGroup("G4")).toBe(q);
    } finally {
      await client.query(`reset search_path`);
      client.release();
    }
  });

  it("CHECKs and unique index: name empty string/41 chars, quota -1/2^50+1 each hit the right constraint; lower(name) unique; 2^50, 0 and NULL pass", async () => {
    const { pool } = await freshDb();
    const ins = (name: string, q: string | null) => pool.query(`insert into storage_plans (name, quota_bytes) values ($1, $2::bigint)`, [name, q]);
    await expect(ins("", "1")).rejects.toMatchObject({ code: "23514", constraint: "storage_plans_name_chk" });
    await expect(ins("x".repeat(41), "1")).rejects.toMatchObject({ code: "23514", constraint: "storage_plans_name_chk" });
    await expect(ins("neg", "-1")).rejects.toMatchObject({ code: "23514", constraint: "storage_plans_quota_chk" });
    await expect(ins("big", "1125899906842625")).rejects.toMatchObject({ code: "23514", constraint: "storage_plans_quota_chk" });
    await expect(ins("bAsIc", "1")).rejects.toMatchObject({ code: "23505", constraint: "storage_plans_name_lower_idx" });
    await ins("x".repeat(40), "1125899906842624");
    await ins("zero", "0");
    await ins("unlimited", null);
    expect((await pool.query(`select count(*)::int n from storage_plans`)).rows[0].n).toBe(4);
  });

  it("four FK names, ON DELETE RESTRICT, both indexes exist; deleting an assigned plan -> 23503", async () => {
    const { pool } = await freshDb();
    const fks = (await pool.query(
      `select conname, confdeltype from pg_constraint where contype = 'f' and confrelid = 'storage_plans'::regclass order by conname`,
    )).rows;
    expect(fks).toEqual([
      { conname: "groups_storage_plan_fk", confdeltype: "r" },
      { conname: "site_settings_default_group_plan_fk", confdeltype: "r" },
      { conname: "site_settings_default_user_plan_fk", confdeltype: "r" },
      { conname: "users_storage_plan_fk", confdeltype: "r" },
    ]);
    const idx = (await pool.query(`select indexname from pg_indexes where indexname in ('users_storage_plan_idx','groups_storage_plan_idx','storage_plans_name_lower_idx') order by 1`)).rows.map(r => r.indexname);
    expect(idx).toEqual(["groups_storage_plan_idx", "storage_plans_name_lower_idx", "users_storage_plan_idx"]);
    // Basic is referenced only by site_settings' two columns here (freshDb has no users/groups); which one fires first depends on RI trigger order, so only assert it is one of the two.
    await expect(pool.query(`delete from storage_plans where name = 'Basic'`)).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^site_settings_default_(user|group)_plan_fk$/),
    });
    const p = (await pool.query(`insert into storage_plans (name, quota_bytes) values ('P', 1) returning id`)).rows[0].id;
    const q = (await pool.query(`insert into storage_plans (name, quota_bytes) values ('Q', 1) returning id`)).rows[0].id;
    await pool.query(`insert into users (email, handle, display_name, storage_plan_id) values ('f@x.test','f1','F',$1)`, [p]);
    await pool.query(`insert into groups (name, storage_plan_id) values ('G', $1)`, [q]);
    await expect(pool.query(`delete from storage_plans where id = $1`, [p])).rejects.toMatchObject({ code: "23503", constraint: "users_storage_plan_fk" });
    await expect(pool.query(`delete from storage_plans where id = $1`, [q])).rejects.toMatchObject({ code: "23503", constraint: "groups_storage_plan_fk" });
  });

  it("site_settings has no row -> a direct user insert hits 23502 (column storage_plan_id) and leaves no row (contract change)", async () => {
    const { pool } = await freshDb();
    await pool.query(`delete from site_settings`);
    await expect(pool.query(`insert into users (email, handle, display_name) values ('e@x.test','e1','E')`))
      .rejects.toMatchObject({ code: "23502", column: "storage_plan_id" });
    await expect(pool.query(`insert into groups (name) values ('G')`)).rejects.toMatchObject({ code: "23502", column: "storage_plan_id" });
    expect((await pool.query(`select count(*)::int n from users`)).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int n from groups`)).rows[0].n).toBe(0);
  });

  it("no concurrent index build/line-leading commit in this file (helper grep for the single-tx premise, like 0015)", () => {
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${QUOTA_TAG}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("version history migration", () => {
  // After a rebase change only these two tags (and SNAPSHOT_FILE at the top).
  const VERSIONS_TAG = "0019_note-versions";
  const PREV_TAG = "0018_storage-quota";

  it("existing rows take defaults: note count 0, no base; users and groups on; site 7/30/on", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(PREV_TAG));
    const u = await pool.query<{ id: string }>(`insert into users (email, handle, display_name) values ('v@x.test','vv','V') returning id`);
    await pool.query(`insert into groups (name) values ('G')`);
    await pool.query(`insert into notes (owner_id, slug) values ($1, 'n1')`, [u.rows[0]!.id]);
    await runMigrations(db);
    expect((await pool.query(`select version_counter, version_base_seq, version_base_fingerprint from notes`)).rows)
      .toEqual([{ version_counter: 0, version_base_seq: null, version_base_fingerprint: null }]);
    expect((await pool.query(`select auto_versions from users`)).rows).toEqual([{ auto_versions: true }]);
    expect((await pool.query(`select auto_versions from groups`)).rows).toEqual([{ auto_versions: true }]);
    expect((await pool.query(`select version_keep_all_days, version_daily_until_days, auto_versions_enabled from site_settings`)).rows)
      .toEqual([{ version_keep_all_days: 7, version_daily_until_days: 30, auto_versions_enabled: true }]);
    expect(journalEntries().map(e => e.tag)).toContain(VERSIONS_TAG);
  });

  it("CHECK: days 1 <= F <= D <= 3650; the two base columns come and go together; kind accepts only auto/manual", async () => {
    const { pool } = await freshDb();
    for (const [f, d] of [[0, 30], [8, 7], [1, 3651]] as const) {
      await expect(pool.query(`update site_settings set version_keep_all_days = $1, version_daily_until_days = $2`, [f, d]))
        .rejects.toMatchObject({ code: "23514", constraint: "site_settings_version_days_chk" });
    }
    await pool.query(`update site_settings set version_keep_all_days = 1, version_daily_until_days = 1`); // F = D is legal
    await pool.query(`update site_settings set version_keep_all_days = 3650, version_daily_until_days = 3650`);
    const u = await pool.query<{ id: string }>(`insert into users (email, display_name) values ('c@x.test','C') returning id`);
    const n = await pool.query<{ id: string }>(`insert into notes (owner_id) values ($1) returning id`, [u.rows[0]!.id]);
    const noteId = n.rows[0]!.id;
    await expect(pool.query(`update notes set version_base_seq = 1 where id = $1`, [noteId]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_version_base_pair_chk" });
    await expect(pool.query(`update notes set version_base_fingerprint = 'x' where id = $1`, [noteId]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_version_base_pair_chk" });
    await pool.query(`update notes set version_base_seq = 1, version_base_fingerprint = 'x' where id = $1`, [noteId]);
    await expect(pool.query(`insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, $2, 'bogus')`, [noteId, Buffer.from([0])]))
      .rejects.toMatchObject({ code: "23514", constraint: "note_versions_kind_chk" });
  });

  it("(note_id, seq) unique; editors defaults to []; deleting a note CASCADEs", async () => {
    const { pool } = await freshDb();
    const u = await pool.query<{ id: string }>(`insert into users (email, display_name) values ('d@x.test','D') returning id`);
    const n = await pool.query<{ id: string }>(`insert into notes (owner_id) values ($1) returning id`, [u.rows[0]!.id]);
    const noteId = n.rows[0]!.id;
    await pool.query(`insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, $2, 'auto')`, [noteId, Buffer.from([0])]);
    await expect(pool.query(`insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, $2, 'manual')`, [noteId, Buffer.from([0])]))
      .rejects.toMatchObject({ code: "23505", constraint: "note_versions_note_seq_idx" });
    expect((await pool.query(`select editors, name, base_seq from note_versions`)).rows).toEqual([{ editors: [], name: null, base_seq: null }]);
    await pool.query(`delete from notes where id = $1`, [noteId]);
    expect((await pool.query(`select count(*)::int as n from note_versions`)).rows).toEqual([{ n: 0 }]);
  });
});

describe("0021_notes-move-scope (#239)", () => {
  // When renumbering change only this one string: the previous one is taken by relative position in the journal, not by a hardcoded tag.
  const TAG = "0021_notes-move-scope";
  it("existing read/write rows are kept as is; all three tables accept the third shape and reject read + move and bare move", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG) - 1);
    await pool.query(`insert into users (email, display_name) values ('m20@example.com','M')`);
    const userId = (await pool.query(`select id from users limit 1`)).rows[0].id;
    await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n','notes:read notes:write','h-old')`,
      [userId]
    );
    await applyMigrationsThrough(pool, idxOfTag(TAG), idxOfTag(TAG));
    expect((await pool.query(`select scope from api_tokens where access_token_hash='h-old'`)).rows[0].scope).toBe("notes:read notes:write");

    await pool.query(`insert into oauth_clients (client_id, client_name, redirect_uris) values ('c20','C','["http://127.0.0.1:1/cb"]'::jsonb)`);
    const RWM = "notes:read notes:write notes:move";
    await pool.query(`insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n',$2,'h-new')`, [userId, RWM]);
    await pool.query(
      `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, expires_at) values ('r20','c20','http://127.0.0.1:1/cb','${"a".repeat(43)}',$1, now() + interval '1 minute')`,
      [RWM]
    );
    await pool.query(
      `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at) values ('k20','c20',$1,$2,'http://127.0.0.1:1/cb','${"a".repeat(43)}', now() + interval '1 minute')`,
      [userId, RWM]
    );
    for (const bad of ["notes:read notes:move", "notes:move"]) {
      await expect(
        pool.query(`insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n',$2,$3)`, [userId, bad, `h-${bad}`])
      ).rejects.toMatchObject({ code: "23514", constraint: "api_tokens_scope_chk" });
      await expect(
        pool.query(
          `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, expires_at) values ($1,'c20','http://127.0.0.1:1/cb','${"a".repeat(43)}',$2, now() + interval '1 minute')`,
          [`r-${bad}`, bad]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "oauth_requests_scope_chk" });
      await expect(
        pool.query(
          `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at) values ($1,'c20',$2,$3,'http://127.0.0.1:1/cb','${"a".repeat(43)}', now() + interval '1 minute')`,
          [`k-${bad}`, userId, bad]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "oauth_codes_scope_chk" });
    }
  });
});

describe("0025_version-pending-and-base-id (#272)", () => {
  // When renumbering change only this one string: the previous one is taken by relative position in the journal.
  const TAG = "0025_version-pending-and-base-id";

  it("backfill: base row still exists -> uuid filled, absent -> NULL (both notes and note_versions); the three pending-cut columns and X take defaults; running runMigrations again changes nothing", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG) - 1);
    const u = (await pool.query<{ id: string }>(`insert into users (email, handle, display_name) values ('p25@x.test', 'p25', 'P') returning id`)).rows[0]!.id;
    const note = async (slug: string, baseSeq: number) =>
      (await pool.query<{ id: string }>(
        `insert into notes (owner_id, slug, version_counter, version_base_seq, version_base_fingerprint) values ($1, $2, 9, $3, 'fp') returning id`,
        [u, slug, baseSeq],
      )).rows[0]!.id;
    const a = await note("a", 2); // base v2 still exists
    const b = await note("b", 5); // base v5 no longer exists
    const ver = async (noteId: string, seq: number, baseSeq: number | null) =>
      (await pool.query<{ id: string }>(
        `insert into note_versions (note_id, seq, ydoc, kind, base_seq) values ($1, $2, $3, 'auto', $4) returning id`,
        [noteId, seq, Buffer.from([0]), baseSeq],
      )).rows[0]!.id;
    const a1 = await ver(a, 1, null);
    const a2 = await ver(a, 2, null);
    const a3 = await ver(a, 3, 1); // derived from a1 (exists)
    const a4 = await ver(a, 4, 7); // derived from 7 (absent)
    const b1 = await ver(b, 1, null);
    await runMigrations(db);
    const notesRows = async () =>
      (await pool.query(
        `select id, version_base_version_id as base_id, version_pending_at as at, version_pending_editors as editors, version_pending_ref_fingerprint as ref from notes order by slug`,
      )).rows;
    const versionRows = async () => (await pool.query(`select id, base_version_id as base_id from note_versions order by note_id = $1 desc, seq`, [a])).rows;
    const expectedNotes = [
      { id: a, base_id: a2, at: null, editors: [], ref: null },
      { id: b, base_id: null, at: null, editors: [], ref: null },
    ];
    const expectedVersions = [
      { id: a1, base_id: null }, { id: a2, base_id: null }, { id: a3, base_id: a1 }, { id: a4, base_id: null }, { id: b1, base_id: null },
    ];
    expect(await notesRows()).toEqual(expectedNotes);
    expect(await versionRows()).toEqual(expectedVersions);
    expect((await pool.query(`select version_auto_wait_minutes from site_settings`)).rows).toEqual([{ version_auto_wait_minutes: 5 }]);
    await runMigrations(db);
    expect(await notesRows()).toEqual(expectedNotes);
    expect(await versionRows()).toEqual(expectedVersions);
  });

  it("CHECK: with nothing pending the editors must be [] and the reference fingerprint NULL; wait 1-60; the partial index covers only pending rows", async () => {
    const { pool } = await freshDb();
    const u = (await pool.query<{ id: string }>(`insert into users (email, display_name) values ('c25@x.test', 'C') returning id`)).rows[0]!.id;
    const n = (await pool.query<{ id: string }>(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0]!.id;
    await expect(pool.query(`update notes set version_pending_editors = '[{"user_id":"x","agent_label":null}]'::jsonb where id = $1`, [n]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_version_pending_chk" });
    await expect(pool.query(`update notes set version_pending_ref_fingerprint = 'r' where id = $1`, [n]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_version_pending_chk" });
    await pool.query(
      `update notes set version_pending_at = now(), version_pending_editors = '[{"user_id":"x","agent_label":null}]'::jsonb, version_pending_ref_fingerprint = 'r' where id = $1`,
      [n],
    );
    for (const m of [0, 61]) {
      await expect(pool.query(`update site_settings set version_auto_wait_minutes = $1`, [m]))
        .rejects.toMatchObject({ code: "23514", constraint: "site_settings_version_auto_wait_chk" });
    }
    await pool.query(`update site_settings set version_auto_wait_minutes = 1`);
    await pool.query(`update site_settings set version_auto_wait_minutes = 60`);
    const idx = (await pool.query(`select indexdef from pg_indexes where indexname = 'notes_version_pending_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(version_pending_at\) WHERE \(version_pending_at IS NOT NULL\)/);
  });
});

describe("0033_trash (#181)", () => {
  async function seedUser(pool: import("pg").Pool): Promise<string> {
    const u = await pool.query(`insert into users (email, display_name) values ($1, 'T') returning id`, [`trash-${randomUUID()}@example.com`]);
    return u.rows[0].id as string;
  }
  async function seedNote(pool: import("pg").Pool, owner: string): Promise<string> {
    return (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [owner])).rows[0].id as string;
  }

  it("shape: two new columns, FK set null, partial index", async () => {
    const { pool } = await freshDb();
    const col = async (table: string, column: string) =>
      (await pool.query(
        `select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [table, column],
      )).rows;
    expect(await col("notes", "deleted_by")).toEqual([{ data_type: "uuid", is_nullable: "YES", column_default: null }]);
    expect(await col("site_settings", "trash_retention_days")).toEqual([{ data_type: "integer", is_nullable: "YES", column_default: "7" }]);
    const fk = (await pool.query(`select confdeltype, confrelid = 'users'::regclass as to_users from pg_constraint where conname = 'notes_deleted_by_fk'`)).rows;
    expect(fk).toEqual([{ confdeltype: "n", to_users: true }]);
    const idx = (await pool.query(`select indexdef from pg_indexes where indexname = 'notes_deleted_at_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(deleted_at\) WHERE \(deleted_at IS NOT NULL\)$/);
  });

  it("CHECK: deleted_by must accompany deleted_at; retention days NULL or 1-3650", async () => {
    const { pool } = await freshDb();
    const u = await seedUser(pool);
    const n = await seedNote(pool, u);
    await expect(pool.query(`update notes set deleted_by = $1 where id = $2`, [u, n]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_deleted_by_chk" });
    await pool.query(`update notes set deleted_at = now(), deleted_by = $1 where id = $2`, [u, n]);
    await pool.query(`update notes set deleted_by = null where id = $1`, [n]);
    expect((await pool.query(`select deleted_at is not null as d, deleted_by from notes where id = $1`, [n])).rows).toEqual([{ d: true, deleted_by: null }]);
    for (const d of [0, 3651]) {
      await expect(pool.query(`update site_settings set trash_retention_days = $1`, [d]))
        .rejects.toMatchObject({ code: "23514", constraint: "site_settings_trash_retention_chk" });
    }
    for (const d of [1, 3650, null]) await pool.query(`update site_settings set trash_retention_days = $1`, [d]);
    const def = (await pool.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'site_settings_trash_retention_chk'`)).rows;
    expect(def).toHaveLength(1);
    expect(def[0].def).toContain("3650");
  });

  it("upgrade of existing data: leftover deleted_at values are neither backfilled nor cleaned; deleted_by NULL; retention days 7; running again changes nothing", async () => {
    const { db, pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0033_trash") - 1);
    const u = await seedUser(pool);
    const live = await seedNote(pool, u);
    const stale = await seedNote(pool, u);
    await pool.query(`update notes set deleted_at = '2026-01-02T03:04:05Z' where id = $1`, [stale]);
    await runMigrations(db);
    const rows = async () => (await pool.query(
      `select id, to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as at, deleted_by from notes order by id`,
    )).rows;
    const expected = [
      { id: live, at: null, deleted_by: null },
      { id: stale, at: "2026-01-02T03:04:05", deleted_by: null },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(await rows()).toEqual(expected);
    expect((await pool.query(`select trash_retention_days from site_settings`)).rows).toEqual([{ trash_retention_days: 7 }]);
    await runMigrations(db);
    expect(await rows()).toEqual(expected);
    expect((await pool.query(`select trash_retention_days from site_settings`)).rows).toEqual([{ trash_retention_days: 7 }]);
  });

  it("the account that trashed it is deleted: deleted_by becomes NULL, the note and deleted_at unchanged", async () => {
    const { pool } = await freshDb();
    const owner = await seedUser(pool);
    const x = await seedUser(pool);
    const n = await seedNote(pool, owner);
    await pool.query(`update notes set deleted_at = now(), deleted_by = $1 where id = $2`, [x, n]);
    const bystander = await seedNote(pool, owner);
    await pool.query(`update notes set deleted_at = now(), deleted_by = $1 where id = $2`, [owner, bystander]);
    const before = (await pool.query(`select deleted_at from notes where id = $1`, [n])).rows[0].deleted_at;
    await pool.query(`delete from users where id = $1`, [x]);
    const after = (await pool.query(`select deleted_at, deleted_by from notes where id = $1`, [n])).rows;
    expect(after).toEqual([{ deleted_at: before, deleted_by: null }]);
    expect((await pool.query(`select deleted_by from notes where id = $1`, [bystander])).rows).toEqual([{ deleted_by: owner }]);
  });

  it("the trash SQL file has no CONCURRENTLY/line-leading COMMIT (helper grep for the single-tx premise)", () => {
    const entries = journalEntries().filter(e => e.tag.endsWith("_trash"));
    expect(entries, "journal 裡要恰有一支 *_trash").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0034_folders", () => {
  type Pool = import("pg").Pool;
  async function seedUser(pool: Pool): Promise<string> {
    const u = await pool.query(`insert into users (email, display_name) values ($1, 'F') returning id`, [`folders-${randomUUID()}@example.com`]);
    return u.rows[0].id as string;
  }
  async function seedGroup(pool: Pool): Promise<string> {
    return (await pool.query(`insert into groups (name) values ('G') returning id`)).rows[0].id as string;
  }
  async function seedNote(pool: Pool, owner: { ownerId: string } | { groupId: string }, folderId: string | null = null): Promise<string> {
    const [col, val] = "ownerId" in owner ? ["owner_id", owner.ownerId] : ["group_id", owner.groupId];
    return (await pool.query(`insert into notes (${col}, folder_id) values ($1, $2) returning id`, [val, folderId])).rows[0].id as string;
  }
  type Space = { personal: string } | { shared: string } | { group: string };
  async function seedFolder(pool: Pool, space: Space, name: string, parentId: string | null = null): Promise<string> {
    const [kind, ownerId, groupId] =
      "personal" in space ? ["personal", space.personal, null] : "shared" in space ? ["shared", space.shared, null] : ["group", null, space.group];
    return (await pool.query(
      `insert into folders (kind, owner_id, group_id, parent_id, name) values ($1, $2, $3, $4, $5) returning id`,
      [kind, ownerId, groupId, parentId, name],
    )).rows[0].id as string;
  }
  const folderIdOf = async (pool: Pool, noteId: string) =>
    (await pool.query(`select folder_id from notes where id = $1`, [noteId])).rows[0]?.folder_id as string | null | undefined;
  const byId = <T extends { id: string }>(rows: T[]) => rows.slice().sort((x, y) => (x.id < y.id ? -1 : 1));

  it("shape: new columns, FK onDelete, the placement's composite FK", async () => {
    const { pool } = await freshDb();
    const cols = async (table: string, only: string[] | null = null) =>
      (await pool.query(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = $1 and ($2::text[] is null or column_name = any($2)) order by ordinal_position`,
        [table, only],
      )).rows;
    expect(await cols("folders")).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "kind", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "owner_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "group_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "parent_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "name", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_by", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    ]);
    expect(await cols("note_placements")).toEqual([
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "note_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "folder_id", data_type: "uuid", is_nullable: "NO", column_default: null },
    ]);
    expect(await cols("notes", ["folder_id", "trash_folder_path"])).toEqual([
      { column_name: "folder_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      { column_name: "trash_folder_path", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    const fks = (await pool.query(
      `select c.conname, c.confdeltype, c.confrelid::regclass::text as ref,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
         from pg_constraint c
        where c.contype = 'f' and c.conrelid in ('folders'::regclass, 'note_placements'::regclass, 'notes'::regclass)
          and (c.conrelid <> 'notes'::regclass or c.conname = 'notes_folder_fk')
        order by c.conname`,
    )).rows;
    expect(fks).toEqual([
      { conname: "folders_created_by_users_id_fk", confdeltype: "n", ref: "users", cols: ["created_by"] },
      { conname: "folders_group_id_groups_id_fk", confdeltype: "c", ref: "groups", cols: ["group_id"] },
      { conname: "folders_owner_id_users_id_fk", confdeltype: "c", ref: "users", cols: ["owner_id"] },
      { conname: "folders_parent_id_folders_id_fk", confdeltype: "c", ref: "folders", cols: ["parent_id"] },
      { conname: "note_placements_folder_id_folders_id_fk", confdeltype: "c", ref: "folders", cols: ["folder_id"] },
      { conname: "note_placements_share_fk", confdeltype: "c", ref: "note_shares", cols: ["note_id", "user_id"] },
      { conname: "notes_folder_fk", confdeltype: "n", ref: "folders", cols: ["folder_id"] },
    ]);
  });

  it("CHECK: kind, space, name length, not pointing to itself, snapshot shape", async () => {
    const { pool } = await freshDb();
    const u = await seedUser(pool);
    const g = await seedGroup(pool);
    const ins = (kind: string, ownerId: string | null, groupId: string | null, name = "N") =>
      pool.query(`insert into folders (kind, owner_id, group_id, name) values ($1, $2, $3, $4)`, [kind, ownerId, groupId, name]);
    await expect(ins("x", u, null)).rejects.toMatchObject({ code: "23514", constraint: "folders_kind_chk" });
    await expect(ins("personal", null, g)).rejects.toMatchObject({ code: "23514", constraint: "folders_space_chk" });
    await expect(ins("group", u, null)).rejects.toMatchObject({ code: "23514", constraint: "folders_space_chk" });
    await expect(ins("personal", null, null)).rejects.toMatchObject({ code: "23514", constraint: "folders_space_chk" });
    await expect(ins("personal", u, null, "")).rejects.toMatchObject({ code: "23514", constraint: "folders_name_chk" });
    await expect(ins("personal", u, null, "a".repeat(81))).rejects.toMatchObject({ code: "23514", constraint: "folders_name_chk" });
    await ins("personal", u, null, "\u{1F600}".repeat(80));
    const self = randomUUID();
    await expect(
      pool.query(`insert into folders (id, kind, owner_id, parent_id, name) values ($1, 'personal', $2, $1, 'S')`, [self, u]),
    ).rejects.toMatchObject({ code: "23514", constraint: "folders_parent_not_self_chk" });
    const n = await seedNote(pool, { ownerId: u });
    await expect(pool.query(`update notes set trash_folder_path = '{}'::jsonb where id = $1`, [n]))
      .rejects.toMatchObject({ code: "23514", constraint: "notes_trash_folder_path_chk" });
    await pool.query(`update notes set trash_folder_path = '[]'::jsonb where id = $1`, [n]);
  });

  it("sibling names are unique case-insensitively (the root level too); different spaces or parents can share a name", async () => {
    const { pool } = await freshDb();
    const u1 = await seedUser(pool);
    const u2 = await seedUser(pool);
    const g1 = await seedGroup(pool);
    const g2 = await seedGroup(pool);
    await seedFolder(pool, { personal: u1 }, "Docs");
    await expect(seedFolder(pool, { personal: u1 }, "docs")).rejects.toMatchObject({ code: "23505", constraint: "folders_sibling_name_idx" });
    await seedFolder(pool, { personal: u2 }, "docs");
    const p = await seedFolder(pool, { personal: u1 }, "P");
    await seedFolder(pool, { personal: u1 }, "docs", p);
    await seedFolder(pool, { shared: u1 }, "Docs");
    await seedFolder(pool, { group: g1 }, "Docs");
    await seedFolder(pool, { group: g2 }, "Docs");
    await expect(seedFolder(pool, { group: g1 }, "DOCS")).rejects.toMatchObject({ code: "23505", constraint: "folders_sibling_name_idx" });
    const idx = (await pool.query(`select indexdef from pg_indexes where indexname = 'folders_sibling_name_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain("NULLS NOT DISTINCT");
    expect(idx[0].indexdef).toContain("lower(name)");
  });

  it("trigger 1: note and folder in the same space (KF001); ownership changed while folder_id didn't -> heals to NULL", async () => {
    const { pool } = await freshDb();
    const u1 = await seedUser(pool);
    const u2 = await seedUser(pool);
    const g = await seedGroup(pool);
    const f1 = await seedFolder(pool, { personal: u1 }, "Mine");
    const f2 = await seedFolder(pool, { personal: u2 }, "Theirs");
    const s1 = await seedFolder(pool, { shared: u1 }, "SharedMine");
    const gf = await seedFolder(pool, { group: g }, "GroupF");
    await expect(seedNote(pool, { ownerId: u1 }, f2)).rejects.toMatchObject({ code: "KF001" });
    await expect(seedNote(pool, { ownerId: u1 }, s1)).rejects.toMatchObject({ code: "KF001" });
    await expect(seedNote(pool, { groupId: g }, f1)).rejects.toMatchObject({ code: "KF001" });
    const mine = await seedNote(pool, { ownerId: u1 }, f1);
    const inGroup = await seedNote(pool, { groupId: g }, gf);
    expect(await folderIdOf(pool, mine)).toBe(f1);
    expect(await folderIdOf(pool, inGroup)).toBe(gf);
    const loose = await seedNote(pool, { ownerId: u1 });
    await expect(pool.query(`update notes set folder_id = $1 where id = $2`, [f2, loose])).rejects.toMatchObject({ code: "KF001" });
    // The folder doesn't exist: trigger 1 lets it pass and the FK reports 23503
    await expect(seedNote(pool, { ownerId: u1 }, randomUUID())).rejects.toMatchObject({ code: "23503", constraint: "notes_folder_fk" });
    // Self-heal: old code's move to a group (owner -> group) and transfer shape (owner changes hands) leave folder_id untouched -> NULL
    await pool.query(`update notes set owner_id = null, group_id = $1 where id = $2`, [g, mine]);
    expect(await folderIdOf(pool, mine)).toBeNull();
    const mine2 = await seedNote(pool, { ownerId: u1 }, f1);
    await pool.query(`update notes set owner_id = $1 where id = $2`, [u2, mine2]);
    expect(await folderIdOf(pool, mine2)).toBeNull();
  });

  it("trigger 2: parent and child in the same space (KF002); one UPDATE moving a whole tree passes; changing only a child in that statement is rejected", async () => {
    const { pool } = await freshDb();
    const u1 = await seedUser(pool);
    const u2 = await seedUser(pool);
    const g1 = await seedGroup(pool);
    const g2 = await seedGroup(pool);
    const gParent = await seedFolder(pool, { group: g1 }, "GP");
    await expect(seedFolder(pool, { group: g2 }, "C", gParent)).rejects.toMatchObject({ code: "KF002" });
    const pParent = await seedFolder(pool, { personal: u1 }, "PP");
    await expect(seedFolder(pool, { shared: u1 }, "C", pParent)).rejects.toMatchObject({ code: "KF002" });
    const other = await seedFolder(pool, { personal: u2 }, "Other");
    await expect(pool.query(`update folders set parent_id = $1 where id = $2`, [pParent, other])).rejects.toMatchObject({ code: "KF002" });
    expect((await pool.query(`select parent_id from folders where id = $1`, [other])).rows).toEqual([{ parent_id: null }]);

    const top = await seedFolder(pool, { group: g2 }, "Top");
    const mid = await seedFolder(pool, { group: g2 }, "Mid", top);
    const leaf = await seedFolder(pool, { group: g2 }, "Leaf", mid);
    // Assert inside begin that "that statement itself" rejects: under autocommit the DEFERRABLE version's error would surface at the following COMMIT, indistinguishable
    const c = await pool.connect();
    try {
      await c.query("begin");
      await expect(
        c.query(`update folders set kind = 'personal', owner_id = $1, group_id = null where id = $2`, [u1, leaf]),
      ).rejects.toMatchObject({ code: "KF002" });
    } finally {
      await c.query("rollback");
      c.release();
    }
    await pool.query(`update folders set kind = 'personal', owner_id = $1, group_id = null where group_id = $2`, [u1, g2]);
    const tree = (await pool.query(`select id, kind, owner_id, group_id from folders where id = any($1)`, [[top, mid, leaf]])).rows;
    expect(byId(tree)).toEqual(byId([top, mid, leaf].map(id => ({ id, kind: "personal", owner_id: u1, group_id: null }))));
  });

  it("trigger 3 and the placement FK: only into one's own shared folder (KF003); share row, note or folder disappearing -> placement disappears", async () => {
    const { pool } = await freshDb();
    const owner = await seedUser(pool);
    const u2 = await seedUser(pool);
    const u3 = await seedUser(pool);
    const n = await seedNote(pool, { ownerId: owner });
    const n2 = await seedNote(pool, { ownerId: owner });
    for (const [note, user] of [[n, u2], [n2, u2], [n, u3]] as const) {
      await pool.query(`insert into note_shares (note_id, user_id, role) values ($1, $2, 'viewer')`, [note, user]);
    }
    const personal2 = await seedFolder(pool, { personal: u2 }, "P2");
    const shared2 = await seedFolder(pool, { shared: u2 }, "S2");
    const shared2b = await seedFolder(pool, { shared: u2 }, "S2b");
    const shared3 = await seedFolder(pool, { shared: u3 }, "S3");
    const place = (user: string, note: string, folder: string) =>
      pool.query(`insert into note_placements (user_id, note_id, folder_id) values ($1, $2, $3)`, [user, note, folder]);
    const placements = async () =>
      (await pool.query(`select user_id, note_id, folder_id from note_placements order by user_id, note_id`)).rows;
    const sorted = (rows: Array<{ user_id: string; note_id: string; folder_id: string }>) =>
      rows.slice().sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.note_id < b.note_id ? -1 : 1));
    await expect(place(u2, n, personal2)).rejects.toMatchObject({ code: "KF003" });
    await expect(place(u2, n, shared3)).rejects.toMatchObject({ code: "KF003" });
    await place(u2, n, shared2);
    await place(u2, n2, shared2b);
    await expect(pool.query(`update note_placements set folder_id = $1 where user_id = $2 and note_id = $3`, [personal2, u2, n]))
      .rejects.toMatchObject({ code: "KF003" });
    const owner3 = await seedUser(pool);
    const unshared = await seedNote(pool, { ownerId: owner3 });
    await expect(place(u3, unshared, shared3)).rejects.toMatchObject({ code: "23503", constraint: "note_placements_share_fk" });
    await place(u3, n, shared3);

    await pool.query(`delete from note_shares where note_id = $1 and user_id = $2`, [n, u2]);
    expect(await placements()).toEqual(sorted([
      { user_id: u2, note_id: n2, folder_id: shared2b },
      { user_id: u3, note_id: n, folder_id: shared3 },
    ]));
    await pool.query(`delete from notes where id = $1`, [n2]);
    expect((await pool.query(`select count(*)::int as c from note_shares where note_id = $1`, [n2])).rows).toEqual([{ c: 0 }]);
    expect(await placements()).toEqual([{ user_id: u3, note_id: n, folder_id: shared3 }]);
    await pool.query(`delete from folders where id = $1`, [shared3]);
    expect(await placements()).toEqual([]);
  });

  it("deleting a folder: subfolders CASCADE, notes pointing into the subtree (live and trashed) get folder_id -> NULL; bystanders untouched", async () => {
    const { pool } = await freshDb();
    const u = await seedUser(pool);
    const a = await seedFolder(pool, { personal: u }, "A");
    const b = await seedFolder(pool, { personal: u }, "B", a);
    const c = await seedFolder(pool, { personal: u }, "C");
    const live = await seedNote(pool, { ownerId: u }, a);
    const trashed = await seedNote(pool, { ownerId: u }, a);
    await pool.query(`update notes set deleted_at = now() where id = $1`, [trashed]);
    const inChild = await seedNote(pool, { ownerId: u }, b);
    const bystander = await seedNote(pool, { ownerId: u }, c);
    await pool.query(`delete from folders where id = $1`, [a]);
    expect((await pool.query(`select id from folders where id = any($1)`, [[a, b, c]])).rows).toEqual([{ id: c }]);
    const rows = (await pool.query(`select id, folder_id from notes where id = any($1)`, [[live, trashed, inChild, bystander]])).rows;
    expect(byId(rows)).toEqual(byId([
      { id: live, folder_id: null },
      { id: trashed, folder_id: null },
      { id: inChild, folder_id: null },
      { id: bystander, folder_id: c },
    ]));
  });

  it("upgrade of existing data: existing notes (including trashed) are all at root with no snapshot; running again changes nothing", async () => {
    const { db, pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0034_folders") - 1);
    const u = await seedUser(pool);
    const v = await seedUser(pool);
    const live = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [u])).rows[0].id as string;
    const stale = (await pool.query(`insert into notes (owner_id, deleted_at, deleted_by) values ($1, now(), $1) returning id`, [u])).rows[0].id as string;
    await pool.query(`insert into note_shares (note_id, user_id, role) values ($1, $2, 'editor')`, [live, v]);
    await runMigrations(db);
    const rows = async () => byId((await pool.query(`select id, folder_id, trash_folder_path from notes`)).rows);
    const expected = byId([
      { id: live, folder_id: null, trash_folder_path: null },
      { id: stale, folder_id: null, trash_folder_path: null },
    ]);
    expect(await rows()).toEqual(expected);
    expect((await pool.query(`select count(*)::int as c from note_placements`)).rows).toEqual([{ c: 0 }]);
    await runMigrations(db);
    expect(await rows()).toEqual(expected);
  });

  it("rollback shape: old code's restore (only clears deleted_at) succeeds on a note with a snapshot; the SQL file has no CONCURRENTLY/line-leading COMMIT", async () => {
    const { pool } = await freshDb();
    const u = await seedUser(pool);
    const n = await seedNote(pool, { ownerId: u });
    await pool.query(`update notes set deleted_at = now(), deleted_by = $1, trash_folder_path = '["A","B"]'::jsonb where id = $2`, [u, n]);
    await pool.query(`update notes set deleted_at = null, deleted_by = null where id = $1`, [n]);
    expect((await pool.query(`select deleted_at, trash_folder_path from notes where id = $1`, [n])).rows).toEqual([
      { deleted_at: null, trash_folder_path: ["A", "B"] },
    ]);
    const entries = journalEntries().filter(e => e.tag.endsWith("_folders"));
    expect(entries, "journal 裡要恰有一支 *_folders").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0035_notes-delete-scope (#181)", () => {
  const TAG = "0035_notes-delete-scope";
  // The previous one is taken by relative position in the journal (0034_folders after merging): while numbers are skipped `idxOfTag(TAG) - 1` doesn't exist.
  const es = journalEntries();
  const prevIdx = es[es.findIndex(e => e.tag === TAG) - 1]!.idx;
  const R = "notes:read";
  const RW = "notes:read notes:write";
  const RWM = "notes:read notes:write notes:move";
  const RWD = "notes:read notes:write notes:delete";
  const RWMD = "notes:read notes:write notes:move notes:delete";
  const CH = "a".repeat(43);
  const CB = "http://127.0.0.1:1/cb";
  const TABLES = ["api_tokens", "oauth_requests", "oauth_codes"] as const;

  async function seedBase(pool: import("pg").Pool): Promise<string> {
    const userId = (await pool.query(`insert into users (email, display_name) values ($1,'D') returning id`, [`del-${randomUUID()}@example.com`])).rows[0].id as string;
    await pool.query(`insert into oauth_clients (client_id, client_name, redirect_uris) values ('c35','C','["${CB}"]'::jsonb)`);
    return userId;
  }
  function insertScope(pool: import("pg").Pool, table: (typeof TABLES)[number], userId: string, scope: string, key: string) {
    if (table === "api_tokens")
      return pool.query(`insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1,'pat','n',$2,$3)`, [userId, scope, key]);
    if (table === "oauth_requests")
      return pool.query(
        `insert into oauth_requests (id, client_id, redirect_uri, code_challenge, scope, expires_at) values ($1,'c35','${CB}','${CH}',$2, now() + interval '1 minute')`,
        [key, scope],
      );
    return pool.query(
      `insert into oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at) values ($1,'c35',$2,$3,'${CB}','${CH}', now() + interval '1 minute')`,
      [key, userId, scope],
    );
  }
  const scopes = async (pool: import("pg").Pool) =>
    (await pool.query(
      `select 'api_tokens' as t, access_token_hash as k, scope from api_tokens
       union all select 'oauth_requests', id, scope from oauth_requests
       union all select 'oauth_codes', code_hash, scope from oauth_codes order by 1, 2`,
    )).rows;
  const constraintDefs = async (pool: import("pg").Pool) =>
    (await pool.query(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('api_tokens_scope_chk','oauth_requests_scope_chk','oauth_codes_scope_chk') order by conname`,
    )).rows;
  async function seedOldForms(pool: import("pg").Pool): Promise<string> {
    const userId = await seedBase(pool);
    await insertScope(pool, "api_tokens", userId, R, "h-r");
    await insertScope(pool, "api_tokens", userId, RW, "h-rw");
    await insertScope(pool, "api_tokens", userId, RWM, "h-rwm");
    await insertScope(pool, "oauth_requests", userId, RWM, "r-rwm");
    await insertScope(pool, "oauth_codes", userId, RWM, "k-rwm");
    return userId;
  }
  const OLD = [
    { t: "api_tokens", k: "h-r", scope: R },
    { t: "api_tokens", k: "h-rw", scope: RW },
    { t: "api_tokens", k: "h-rwm", scope: RWM },
    { t: "oauth_codes", k: "k-rwm", scope: RWM },
    { t: "oauth_requests", k: "r-rwm", scope: RWM },
  ];

  it("existing rows as is: the three old shapes each keep their original value after upgrade and don't gain notes:delete", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, prevIdx);
    await seedOldForms(pool);
    await applyMigrationsThrough(pool, idxOfTag(TAG), idxOfTag(TAG));
    expect(await scopes(pool)).toEqual(OLD);
  });

  it("three tables accept the two new shapes (RWD, RWMD)", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG));
    const userId = await seedBase(pool);
    for (const table of TABLES)
      for (const [scope, key] of [[RWD, "rwd"], [RWMD, "rwmd"]] as const) await insertScope(pool, table, userId, scope, `${table}-${key}`);
    const got = await scopes(pool);
    expect(got).toHaveLength(6);
    for (const table of TABLES) {
      expect(got).toContainEqual({ t: table, k: `${table}-rwd`, scope: RWD });
      expect(got).toContainEqual({ t: table, k: `${table}-rwmd`, scope: RWMD });
    }
  });

  it("three tables reject: read + delete, bare delete, read + move + delete, four items out of order", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag(TAG));
    const userId = await seedBase(pool);
    for (const bad of ["notes:read notes:delete", "notes:delete", "notes:read notes:move notes:delete", "notes:read notes:write notes:delete notes:move"])
      for (const table of TABLES)
        await expect(insertScope(pool, table, userId, bad, `${table}-${bad}`), `${table} ← ${bad}`).rejects.toMatchObject({
          code: "23514",
          constraint: `${table}_scope_chk`,
        });
  });

  it("the 0035 SQL file has no CONCURRENTLY/line-leading COMMIT, and all three DROPs come before all three ADDs", () => {
    const entries = journalEntries().filter(e => e.tag === TAG);
    expect(entries, `journal 裡要恰有一支 ${TAG}`).toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${TAG}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
    const drops = TABLES.map(t => sqlText.indexOf(`DROP CONSTRAINT "${t}_scope_chk"`));
    const adds = TABLES.map(t => sqlText.indexOf(`ADD CONSTRAINT "${t}_scope_chk"`));
    for (const d of drops) expect(d).toBeGreaterThanOrEqual(0);
    for (const a of adds) expect(a).toBeGreaterThan(Math.max(...drops));
  });

  it("after applying 0035 via runMigrations, running again leaves the five scope rows and three constraint definitions unchanged", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, prevIdx);
    await seedOldForms(pool);
    await runMigrations(db);
    const defs = await constraintDefs(pool);
    expect(defs).toHaveLength(3);
    for (const d of defs) expect(d.def).toContain(RWMD);
    expect(await scopes(pool)).toEqual(OLD);
    await runMigrations(db);
    expect(await scopes(pool)).toEqual(OLD);
    expect(await constraintDefs(pool)).toEqual(defs);
  });
});

describe("bulk transfer (0036)", () => {
  async function seedParent(pool: import("pg").Pool): Promise<{ userId: string; noteId: string; tokenId: string }> {
    const u = await pool.query(`insert into users (email, display_name) values ($1, 'B') returning id`, [`bt-${randomUUID()}@example.com`]);
    const userId = u.rows[0].id as string;
    const n = await pool.query(`insert into notes (owner_id) values ($1) returning id`, [userId]);
    const t = await pool.query(
      `insert into api_tokens (user_id, kind, name, scope, access_token_hash) values ($1, 'pat', 'n', 'notes:read notes:write', $2) returning id`,
      [userId, `h-${randomUUID()}`],
    );
    return { userId, noteId: n.rows[0].id as string, tokenId: t.rows[0].id as string };
  }
  const insertTok =
    `insert into transfer_tokens (token_hash, parent_token_id, note_id, purpose, expires_at, consumed_at, access, range)
     values ($1, $2, $3, $4, now() + ($5::text)::interval, $6, $7, $8::jsonb) returning id`;
  const ALL = '{"kind":"all"}';
  const insertBase = (pool: import("pg").Pool, key: string, userId: string, noteId: string) =>
    pool.query(
      `insert into transfer_bases (key, user_id, note_id, salt, key_id, body_sha, title_sha, line_hashes, line_kinds)
       values ($1, $2, $3, $4, 'abcd1234', $4, $4, $4, $4)`,
      [key, userId, noteId, Buffer.alloc(16, 1)],
    );
  const insertCreate = (pool: import("pg").Pool, userId: string, fileSha: Buffer, noteId: string) =>
    pool.query(`insert into transfer_creates (user_id, file_sha, note_id, key_id) values ($1, $2, $3, 'abcd1234')`, [userId, fileSha, noteId]);

  it("CHECK matrix of transfer_tokens: each shape violates exactly one (including existing purpose/consumed), legal bulk shapes pass", async () => {
    const { pool } = await freshDb();
    const p = await seedParent(pool);
    const h = () => `bt-${randomUUID()}`;
    const cases: Array<[unknown[], string]> = [
      [[h(), p.tokenId, p.noteId, "bulk", "10 minutes", null, "read", ALL], "transfer_tokens_bulk_note_chk"],
      [[h(), p.tokenId, null, "download", "10 minutes", null, null, null], "transfer_tokens_bulk_note_chk"],
      [[h(), p.tokenId, null, "bulk", "10 minutes", null, null, ALL], "transfer_tokens_bulk_access_chk"],
      [[h(), p.tokenId, p.noteId, "upload", "10 minutes", null, "read", null], "transfer_tokens_bulk_access_chk"],
      [[h(), p.tokenId, null, "bulk", "10 minutes", null, "read", null], "transfer_tokens_bulk_range_chk"],
      [[h(), p.tokenId, p.noteId, "download", "10 minutes", null, null, ALL], "transfer_tokens_bulk_range_chk"],
      [[h(), p.tokenId, null, "bulk", "10 minutes", null, "admin", ALL], "transfer_tokens_access_chk"],
      [[h(), p.tokenId, p.noteId, "other", "10 minutes", null, null, null], "transfer_tokens_purpose_chk"],
      [[h(), p.tokenId, null, "bulk", "10 minutes", new Date(), "read", ALL], "transfer_tokens_consumed_chk"],
    ];
    for (const [params, constraint] of cases) {
      await expect(pool.query(insertTok, params), `${String(params[3])}/${String(params[6])} → ${constraint}`).rejects.toMatchObject({ code: "23514", constraint });
    }
    await pool.query(insertTok, [h(), p.tokenId, null, "bulk", "10 minutes", null, "write", ALL]);
    await pool.query(insertTok, [h(), p.tokenId, null, "bulk", "10 minutes", null, "read", '{"kind":"folder","folderId":"0b6f1a52-6a4b-4c1e-9d0e-6f1f2a3b4c5d"}']);
    // The two existing purposes remain legal (note present, access/range empty)
    await pool.query(insertTok, [h(), p.tokenId, p.noteId, "download", "10 minutes", null, null, null]);
    const { rows } = await pool.query(`select purpose, note_id, access, range from transfer_tokens order by purpose, access nulls first`);
    expect(rows).toEqual([
      { purpose: "bulk", note_id: null, access: "read", range: { kind: "folder", folderId: "0b6f1a52-6a4b-4c1e-9d0e-6f1f2a3b4c5d" } },
      { purpose: "bulk", note_id: null, access: "write", range: { kind: "all" } },
      { purpose: "download", note_id: p.noteId, access: null, range: null },
    ]);
  });

  it("deleting the parent credential takes bulk rows; bulk rows of another parent credential (bystander) stay", async () => {
    const { pool } = await freshDb();
    const a = await seedParent(pool);
    const b = await seedParent(pool);
    await pool.query(insertTok, [`ba-${randomUUID()}`, a.tokenId, null, "bulk", "10 minutes", null, "read", ALL]);
    await pool.query(insertTok, [`bb-${randomUUID()}`, b.tokenId, null, "bulk", "10 minutes", null, "read", ALL]);
    await pool.query(`delete from api_tokens where id = $1`, [a.tokenId]);
    const { rows } = await pool.query(`select parent_token_id from transfer_tokens`);
    expect(rows).toEqual([{ parent_token_id: b.tokenId }]);
  });

  it("transfer_bases: deleting a note and deleting a user each take only their own rows (bystander rows stay)", async () => {
    const { pool } = await freshDb();
    const a = await seedParent(pool);
    // c owns no note (notes.owner_id is restrict), so deleting c takes its rows only via transfer_bases.user_id's cascade
    const c = (await pool.query(`insert into users (email, display_name) values ($1, 'C') returning id`, [`bt-${randomUUID()}@example.com`])).rows[0].id as string;
    const n2 = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [a.userId])).rows[0].id as string;
    await insertBase(pool, "k-a-n1", a.userId, a.noteId);
    await insertBase(pool, "k-c-n1", c, a.noteId);
    await insertBase(pool, "k-a-n2", a.userId, n2);
    await insertBase(pool, "k-c-n2", c, n2);
    const keys = async () => (await pool.query(`select key from transfer_bases order by key`)).rows.map((r: { key: string }) => r.key);
    await pool.query(`delete from notes where id = $1`, [a.noteId]);
    expect(await keys()).toEqual(["k-a-n2", "k-c-n2"]);
    await pool.query(`delete from users where id = $1`, [c]);
    expect(await keys()).toEqual(["k-a-n2"]);
  });

  it("transfer_creates: deleting a note and deleting a user each take only their own rows; a second row with the same (user_id, file_sha) hits the PK", async () => {
    const { pool } = await freshDb();
    const a = await seedParent(pool);
    const c = (await pool.query(`insert into users (email, display_name) values ($1, 'C') returning id`, [`bt-${randomUUID()}@example.com`])).rows[0].id as string;
    const n2 = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [a.userId])).rows[0].id as string;
    const sha = (k: number) => Buffer.alloc(32, k);
    await insertCreate(pool, a.userId, sha(1), a.noteId);
    await insertCreate(pool, a.userId, sha(2), n2);
    await insertCreate(pool, c, sha(1), n2);
    await expect(insertCreate(pool, a.userId, sha(1), n2)).rejects.toMatchObject({ code: "23505", constraint: "transfer_creates_user_id_file_sha_pk" });
    const rowsOf = async () =>
      (await pool.query(`select user_id, file_sha from transfer_creates`)).rows
        .map((r: { user_id: string; file_sha: Buffer }) => `${r.user_id === a.userId ? "a" : "c"}:${r.file_sha[0]}`)
        .sort();
    await pool.query(`delete from notes where id = $1`, [a.noteId]);
    expect(await rowsOf()).toEqual(["a:2", "c:1"]);
    await pool.query(`delete from users where id = $1`, [c]);
    expect(await rowsOf()).toEqual(["a:2"]);
  });

  it("note_ai_edits: file_sync's anchor <=> no after block; existing ops' anchor rules and op enum unchanged", async () => {
    const { pool } = await freshDb();
    const p = await seedParent(pool);
    const ins = (op: string, anchor: string | null, after: string, fp: string | null) =>
      pool.query(
        `insert into note_ai_edits (note_id, user_id, op, anchor, after_block_ids, after_fingerprint) values ($1, $2, $3, $4::jsonb, $5::text[], $6)`,
        [p.noteId, p.userId, op, anchor, after, fp],
      );
    const ANCHOR = '{"after":"x"}';
    await ins("file_sync", ANCHOR, "{}", null); // deletion zone
    await ins("file_sync", null, "{a}", "0000000000000000"); // rewrite/insert zone
    await expect(ins("file_sync", ANCHOR, "{a}", "0000000000000000"), "file_sync＋anchor＋after").rejects.toMatchObject({ code: "23514", constraint: "note_ai_edits_anchor_chk" });
    await expect(ins("file_sync", null, "{}", null), "file_sync 無 anchor 無 after").rejects.toMatchObject({ code: "23514", constraint: "note_ai_edits_anchor_chk" });
    await expect(ins("delete_section", null, "{}", null), "delete_section 無 anchor").rejects.toMatchObject({ code: "23514", constraint: "note_ai_edits_anchor_chk" });
    await expect(ins("replace_all", ANCHOR, "{a}", "0000000000000000"), "replace_all 帶 anchor").rejects.toMatchObject({ code: "23514", constraint: "note_ai_edits_anchor_chk" });
    await expect(ins("bogus", null, "{a}", "0000000000000000"), "op bogus").rejects.toMatchObject({ code: "23514", constraint: "note_ai_edits_op_chk" });
    await ins("delete_section", ANCHOR, "{}", null);
    await ins("replace_all", null, "{a}", "0000000000000000");
    const { rows } = await pool.query(`select op, count(*)::int as n from note_ai_edits group by op order by op`);
    expect(rows).toEqual([
      { op: "delete_section", n: 1 },
      { op: "file_sync", n: 2 },
      { op: "replace_all", n: 1 },
    ]);
  });

  it("the note_id indexes of transfer_bases/transfer_creates exist and lead with note_id (supporting the FK cascade)", async () => {
    const { pool } = await freshDb();
    const { rows } = await pool.query(
      `select indexname, indexdef from pg_indexes where indexname in ('transfer_bases_note_idx', 'transfer_creates_note_idx') order by indexname`,
    );
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual(["transfer_bases_note_idx", "transfer_creates_note_idx"]);
    for (const r of rows as Array<{ indexname: string; indexdef: string }>) expect(r.indexdef, r.indexname).toMatch(/USING btree \(note_id\)$/);
  });

  it("#388 0038 sessions: deleting a user cascades; index exists; SQL file has no CONCURRENTLY/line-leading COMMIT", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0038_sessions"));
    const u = (await pool.query(`insert into users (email, display_name) values ('s388@example.com', 'S') returning id`)).rows[0].id as string;
    const other = (await pool.query(`insert into users (email, display_name) values ('s388b@example.com', 'T') returning id`)).rows[0].id as string;
    await pool.query(`insert into sessions (user_id, expires_at) values ($1, now() + interval '1 day'), ($1, now() + interval '1 day'), ($2, now() + interval '1 day')`, [u, other]);
    const ids = (await pool.query(`select id::text from sessions`)).rows.map((r: { id: string }) => r.id);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // gen_random_uuid = v4
    await pool.query(`delete from users where id = $1`, [u]);
    const left = (await pool.query(`select user_id from sessions`)).rows.map((r: { user_id: string }) => r.user_id);
    expect(left).toEqual([other]);
    const { rows } = await pool.query(`select indexname from pg_indexes where tablename = 'sessions' order by indexname`);
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual(["sessions_expires_idx", "sessions_pkey", "sessions_user_idx"]);
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0038_sessions.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });

  it("#397 0039 site_limits/site_limit_changes: CHECKs, actor ON DELETE SET NULL, changed_at DESC index; SQL file has no CONCURRENTLY/line-leading COMMIT", async () => {
    const { pool } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0039_site-limits"));
    await expect(pool.query(`insert into site_limits (key, value) values ('1bad', 1)`)).rejects.toMatchObject({ code: "23514", constraint: "site_limits_key_chk" });
    await expect(pool.query(`insert into site_limits (key, value) values ('rateEdit', -1)`)).rejects.toMatchObject({ code: "23514", constraint: "site_limits_value_chk" });
    await pool.query(`insert into site_limits (key, value) values ('rateEdit', 0)`);
    const u = (await pool.query(`insert into users (email, display_name) values ('s397@example.com', 'S') returning id`)).rows[0].id as string;
    await pool.query(`insert into site_limit_changes (key, old_value, new_value, old_effective, new_effective, actor_user_id) values ('rateEdit', null, 10, 30, 10, $1)`, [u]);
    await pool.query(`delete from users where id = $1`, [u]);
    const left = (await pool.query(`select key, actor_user_id from site_limit_changes`)).rows;
    expect(left).toEqual([{ key: "rateEdit", actor_user_id: null }]);
    const { rows } = await pool.query(`select indexdef from pg_indexes where tablename = 'site_limit_changes'`);
    expect(rows.map((r: { indexdef: string }) => r.indexdef)).toEqual(expect.arrayContaining([expect.stringMatching(/USING btree \(changed_at DESC( NULLS LAST)?\)$/)]));
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0039_site-limits.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });

  it("the bulk-transfer SQL file has no CONCURRENTLY/line-leading COMMIT (helper grep for the single-tx premise)", () => {
    // Find the file by tag suffix: numbers may be regenerated when the integration branch merges.
    const entries = journalEntries().filter(e => e.tag.endsWith("_bulk-transfer"));
    expect(entries, "journal 裡要恰有一支 *_bulk-transfer").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
  });
});

describe("0041_user-avatars (#404 user avatars)", () => {
  const newUser = async (pool: import("pg").Pool, email: string): Promise<string> =>
    (await pool.query(`insert into users (email, display_name) values ($1, 'U') returning id`, [email])).rows[0].id as string;
  const newIdentity = async (pool: import("pg").Pool, userId: string, sub: string): Promise<string> =>
    (await pool.query(`insert into user_identities (user_id, issuer, sub) values ($1, 'https://idp.example', $2) returning id`, [userId, sub])).rows[0].id as string;
  /** A row that is exactly a legal upload candidate; `over` overrides per column (keys with value undefined are skipped, null is written). */
  const insertAvatar = async (pool: import("pg").Pool, userId: string, over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      user_id: userId,
      source: "upload",
      original_file: randomUUID(),
      original_sha256: Buffer.alloc(32, 1),
      original_mime: "image/png",
      original_size: 10,
      display_data: Buffer.from([1]),
      display_mime: "image/png",
      display_size: 1,
      ...over,
    };
    const keys = Object.keys(row).filter(k => row[k] !== undefined);
    return pool.query(
      `insert into user_avatars (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      keys.map(k => row[k]),
    );
  };
  const pendingOidc = (over: Record<string, unknown> = {}) => ({
    source: "oidc", oidc_picture_url: "https://idp.example/p.png", display_data: null, display_mime: null, display_size: 0, ...over,
  });

  it("column types, NOT NULL and defaults", async () => {
    const { pool } = await freshDb();
    const u = await newUser(pool, "av-cols@example.com");
    const { rows: userRows } = await pool.query(`select avatar_auto from users where id = $1`, [u]);
    expect(userRows).toEqual([{ avatar_auto: true }]);
    const id = (await insertAvatar(pool, u)).rows[0].id as string;
    const { rows } = await pool.query(`select version, is_current, created_at is not null as has_created from user_avatars where id = $1`, [id]);
    expect(rows).toEqual([{ version: 1, is_current: false, has_created: true }]);
    // display_size defaults to 0: OIDC rows awaiting a display image needn't supply it
    const pendingId = (await insertAvatar(pool, u, pendingOidc({ display_size: undefined }))).rows[0].id as string;
    const { rows: pending } = await pool.query(`select display_size from user_avatars where id = $1`, [pendingId]);
    expect(pending).toEqual([{ display_size: 0 }]);
    const { rows: cols } = await pool.query(
      `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'user_avatars' order by column_name`,
    );
    const by = Object.fromEntries(cols.map((r: { column_name: string; data_type: string; is_nullable: string }) => [r.column_name, `${r.data_type}/${r.is_nullable}`]));
    expect(by).toMatchObject({
      id: "uuid/NO", user_id: "uuid/NO", source: "text/NO", identity_id: "uuid/YES", oidc_picture_url: "text/YES",
      original_file: "uuid/NO", original_sha256: "bytea/NO", original_mime: "text/NO", original_size: "bigint/NO",
      original_width: "integer/YES", original_height: "integer/YES", crop_x: "integer/YES", crop_y: "integer/YES", crop_size: "integer/YES",
      display_data: "bytea/YES", display_mime: "text/YES", display_size: "integer/NO", version: "integer/NO",
      is_current: "boolean/NO", created_at: "timestamp with time zone/NO",
    });
    const { rows: idCols } = await pool.query(
      `select column_name, is_nullable from information_schema.columns where table_name = 'user_identities' and column_name in ('last_picture_url', 'picture_dismissed_url') order by column_name`,
    );
    expect(idCols).toEqual([{ column_name: "last_picture_url", is_nullable: "YES" }, { column_name: "picture_dismissed_url", is_nullable: "YES" }]);
  });

  it("CHECKs: each shape violates exactly one, constraint names asserted one by one; each has a just-legal counterpart row", async () => {
    const { pool } = await freshDb();
    const u = await newUser(pool, "av-chk@example.com");
    const url2048 = "https://idp.example/" + "a".repeat(2048 - "https://idp.example/".length);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["source 不在白名單", { source: "bogus" }, "user_avatars_source_chk"],
      ["oidc 缺網址", pendingOidc({ oidc_picture_url: null }), "user_avatars_oidc_url_chk"],
      ["upload 帶了網址", { oidc_picture_url: "https://idp.example/p.png" }, "user_avatars_oidc_url_chk"],
      ["網址 2049 字", pendingOidc({ oidc_picture_url: url2048 + "b" }), "user_avatars_oidc_url_len_chk"],
      ["sha256 31 位元組", { original_sha256: Buffer.alloc(31) }, "user_avatars_sha256_chk"],
      ["sha256 33 位元組", { original_sha256: Buffer.alloc(33) }, "user_avatars_sha256_chk"],
      ["原圖 gif", { original_mime: "image/gif" }, "user_avatars_original_mime_chk"],
      ["原圖大小 0", { original_size: 0 }, "user_avatars_original_size_chk"],
      ["原圖大小超過上限", { original_size: SITE_LIMITS.uploadMaxBytes.max + 1 }, "user_avatars_original_size_chk"],
      ["裁切只有 x", { crop_x: 1 }, "user_avatars_crop_chk"],
      ["裁切缺 size", { crop_x: 1, crop_y: 1 }, "user_avatars_crop_chk"],
      ["裁切 size 為 0", { crop_x: 0, crop_y: 0, crop_size: 0 }, "user_avatars_crop_chk"],
      ["顯示圖超過上限", { display_data: Buffer.alloc(MAX_AVATAR_DISPLAY_BYTES + 1), display_size: MAX_AVATAR_DISPLAY_BYTES + 1 }, "user_avatars_display_size_max_chk"],
      ["有顯示圖沒有 mime", { display_mime: null }, "user_avatars_display_pair_chk"],
      ["有 mime 沒有顯示圖", pendingOidc({ display_mime: "image/png" }), "user_avatars_display_pair_chk"],
      ["顯示圖 gif", { display_mime: "image/gif" }, "user_avatars_display_mime_chk"],
      ["upload 沒有顯示圖", { display_data: null, display_mime: null, display_size: 0 }, "user_avatars_upload_display_chk"],
      ["display_size 與位元組不一致", { display_size: 5 }, "user_avatars_display_size_chk"],
      ["version 為 0", { version: 0 }, "user_avatars_version_chk"],
    ];
    for (const [label, over, constraint] of cases) {
      await expect(insertAvatar(pool, u, over), label).rejects.toMatchObject({ code: "23514", constraint });
    }
    // Counterpart rows: the legal boundary of each CHECK
    await insertAvatar(pool, u);
    await insertAvatar(pool, u, { original_size: SITE_LIMITS.uploadMaxBytes.max });
    await insertAvatar(pool, u, { original_mime: "image/jpeg", display_mime: "image/webp" });
    await insertAvatar(pool, u, { crop_x: 0, crop_y: 0, crop_size: 1, original_width: 8, original_height: 8 });
    await insertAvatar(pool, u, { display_data: Buffer.alloc(MAX_AVATAR_DISPLAY_BYTES), display_size: MAX_AVATAR_DISPLAY_BYTES });
    await insertAvatar(pool, u, pendingOidc({ oidc_picture_url: url2048 }));
    await insertAvatar(pool, u, pendingOidc({ oidc_picture_url: "https://idp.example/q.png", display_data: Buffer.from([2]), display_mime: "image/png", display_size: 1 }));
    const { rows } = await pool.query(`select count(*)::int as n from user_avatars where user_id = $1`, [u]);
    expect(rows[0].n).toBe(7);
  });

  it("the identity row's two URL columns: 2049 chars rejected, 2048 allowed", async () => {
    const { pool } = await freshDb();
    const u = await newUser(pool, "av-idchk@example.com");
    const id = await newIdentity(pool, u, "sub-chk");
    const long = "https://idp.example/" + "a".repeat(2048 - "https://idp.example/".length);
    await expect(pool.query(`update user_identities set last_picture_url = $2 where id = $1`, [id, long + "b"])).rejects.toMatchObject({ code: "23514", constraint: "user_identities_last_picture_url_chk" });
    await expect(pool.query(`update user_identities set picture_dismissed_url = $2 where id = $1`, [id, long + "b"])).rejects.toMatchObject({ code: "23514", constraint: "user_identities_picture_dismissed_url_chk" });
    await pool.query(`update user_identities set last_picture_url = $2, picture_dismissed_url = $2 where id = $1`, [id, long]);
    const { rows } = await pool.query(`select char_length(last_picture_url) as a, char_length(picture_dismissed_url) as b from user_identities where id = $1`, [id]);
    expect(rows).toEqual([{ a: 2048, b: 2048 }]);
  });

  it("the DB's limits align literally with the shared constants: display image MAX_AVATAR_DISPLAY_BYTES, original SITE_LIMITS.uploadMaxBytes.max", async () => {
    const { pool } = await freshDb();
    const u = await newUser(pool, "av-const@example.com");
    await expect(
      insertAvatar(pool, u, { display_data: Buffer.alloc(MAX_AVATAR_DISPLAY_BYTES + 1), display_size: MAX_AVATAR_DISPLAY_BYTES + 1 }),
    ).rejects.toMatchObject({ code: "23514", constraint: "user_avatars_display_size_max_chk" });
    await insertAvatar(pool, u, { display_data: Buffer.alloc(MAX_AVATAR_DISPLAY_BYTES), display_size: MAX_AVATAR_DISPLAY_BYTES });
    await expect(insertAvatar(pool, u, { original_size: SITE_LIMITS.uploadMaxBytes.max + 1 })).rejects.toMatchObject({
      code: "23514",
      constraint: "user_avatars_original_size_chk",
    });
    await insertAvatar(pool, u, { original_size: SITE_LIMITS.uploadMaxBytes.max });
  });

  it("three unique indexes each block once; different people can each have one current avatar", async () => {
    const { pool } = await freshDb();
    const alice = await newUser(pool, "av-alice@example.com");
    const bob = await newUser(pool, "av-bob@example.com");
    const file = randomUUID();
    await insertAvatar(pool, alice, { original_file: file });
    await expect(insertAvatar(pool, bob, { original_file: file })).rejects.toMatchObject({ code: "23505", constraint: "user_avatars_original_file_idx" });

    const ident = await newIdentity(pool, alice, "sub-a");
    await insertAvatar(pool, alice, pendingOidc({ identity_id: ident }));
    await expect(insertAvatar(pool, alice, pendingOidc({ identity_id: ident }))).rejects.toMatchObject({ code: "23505", constraint: "user_avatars_identity_idx" });
    // A candidate with no source identity (identity_id NULL) isn't constrained by that index
    await insertAvatar(pool, alice, pendingOidc({ identity_id: null }));
    await insertAvatar(pool, alice, pendingOidc({ identity_id: null }));

    await insertAvatar(pool, alice, { is_current: true });
    await expect(insertAvatar(pool, alice, { is_current: true })).rejects.toMatchObject({ code: "23505", constraint: "user_avatars_current_idx" });
    await insertAvatar(pool, alice, { is_current: false });
    await insertAvatar(pool, bob, { is_current: true });
    const { rows } = await pool.query(`select user_id from user_avatars where is_current`);
    expect(rows.map((r: { user_id: string }) => r.user_id).sort()).toEqual([alice, bob].sort());
  });

  it("FK: deleting a user takes their candidates without affecting others; deleting an identity row only sets identity_id to NULL", async () => {
    const { pool } = await freshDb();
    const alice = await newUser(pool, "av-fk-a@example.com");
    const bob = await newUser(pool, "av-fk-b@example.com");
    await insertAvatar(pool, alice);
    await insertAvatar(pool, alice);
    const bobAvatar = (await insertAvatar(pool, bob)).rows[0].id as string;
    await pool.query(`delete from users where id = $1`, [alice]);
    const { rows } = await pool.query(`select id, user_id from user_avatars`);
    expect(rows).toEqual([{ id: bobAvatar, user_id: bob }]);

    const ident = await newIdentity(pool, bob, "sub-fk");
    const oidcId = (await insertAvatar(pool, bob, pendingOidc({ identity_id: ident }))).rows[0].id as string;
    await pool.query(`delete from user_identities where id = $1`, [ident]);
    const { rows: left } = await pool.query(`select identity_id from user_avatars where id = $1`, [oidcId]);
    expect(left).toEqual([{ identity_id: null }]);
  });

  it("upgrading a database that has data: users, notes and identity rows unchanged, avatar_auto defaults true, the avatar table is empty, the new columns are NULL", async () => {
    const { pool, db } = await freshEmptyDb();
    await applyMigrationsThrough(pool, idxOfTag("0041_user-avatars") - 1);
    const alice = await newUser(pool, "av-upgrade@example.com");
    const note = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [alice])).rows[0].id as string;
    const ident = await newIdentity(pool, alice, "sub-upgrade");
    await runMigrations(db);
    const { rows: users1 } = await pool.query(`select email, avatar_auto from users where id = $1`, [alice]);
    expect(users1).toEqual([{ email: "av-upgrade@example.com", avatar_auto: true }]);
    expect((await pool.query(`select 1 from notes where id = $1 and owner_id = $2`, [note, alice])).rowCount).toBe(1);
    const { rows: identRows } = await pool.query(`select last_picture_url, picture_dismissed_url from user_identities where id = $1`, [ident]);
    expect(identRows).toEqual([{ last_picture_url: null, picture_dismissed_url: null }]);
    expect((await pool.query(`select count(*)::int as n from user_avatars`)).rows[0].n).toBe(0);
    // The upgraded database can add avatars normally
    await insertAvatar(pool, alice, { is_current: true });
  });

  it("SQL file has no CONCURRENTLY/line-leading COMMIT; deletes nothing and doesn't touch users.avatar_url", () => {
    const sqlText = readFileSync(path.join(drizzleDirForTest, "0041_user-avatars.sql"), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
    expect(sqlText).not.toMatch(/\bDROP\b/i);
    expect(sqlText).not.toMatch(/"avatar_url"/);
  });
});

describe("note_favorites (#334)", () => {
  it("three columns' type/NOT NULL/default, PK (user_id, note_id), both FKs ON DELETE CASCADE, note_id index", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'note_favorites' order by column_name`,
    )).rows;
    expect(cols.map((c: { column_name: string; data_type: string; is_nullable: string }) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ["created_at", "timestamp with time zone", "NO"],
      ["note_id", "uuid", "NO"],
      ["user_id", "uuid", "NO"],
    ]);
    const byName = Object.fromEntries(cols.map((c: { column_name: string; column_default: string | null }) => [c.column_name, c.column_default]));
    expect(byName.created_at).toContain("date_trunc('milliseconds'");
    expect(byName.created_at).toContain("now()");
    expect(byName.note_id).toBeNull();
    expect(byName.user_id).toBeNull();

    const pk = (await pool.query(
      `select a.attname from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'note_favorites'::regclass and c.contype = 'p'
        order by k.ord`,
    )).rows.map((r: { attname: string }) => r.attname);
    expect(pk).toEqual(["user_id", "note_id"]);

    const fks = (await pool.query(
      `select a.attname as col, c.confrelid::regclass::text as ref, c.confdeltype
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.conrelid = 'note_favorites'::regclass and c.contype = 'f'
        order by col`,
    )).rows;
    expect(fks).toEqual([
      { col: "note_id", ref: "notes", confdeltype: "c" },
      { col: "user_id", ref: "users", confdeltype: "c" },
    ]);

    const idx = (await pool.query(`select indexdef from pg_indexes where indexname = 'note_favorites_note_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/USING btree \(note_id\)$/);
  });

  it("default is stored as whole milliseconds; deleting a note takes only that note's rows, deleting a user only theirs (bystander rows stay)", async () => {
    const { pool } = await freshDb();
    const alice = (await pool.query(`insert into users (email, display_name) values ('alice-fav@example.com', 'Alice') returning id`)).rows[0].id as string;
    // bob owns no note (notes.owner_id is restrict), so deleting bob takes his rows only via note_favorites.user_id's cascade
    const bob = (await pool.query(`insert into users (email, display_name) values ('bob-fav@example.com', 'Bob') returning id`)).rows[0].id as string;
    const n1 = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [alice])).rows[0].id as string;
    const n2 = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [alice])).rows[0].id as string;
    await pool.query(
      `insert into note_favorites (user_id, note_id) values ($1, $3), ($1, $4), ($2, $3), ($2, $4)`,
      [alice, bob, n1, n2],
    );
    // default is stored as whole milliseconds: the microsecond part is always 0
    const sub = (await pool.query(`select count(*)::int as n from note_favorites where extract(microseconds from created_at)::bigint % 1000 <> 0`)).rows[0].n;
    expect(sub).toBe(0);

    const rows = async () => (await pool.query(`select user_id, note_id from note_favorites`)).rows
      .map((r: { user_id: string; note_id: string }) => `${r.user_id === alice ? "alice" : "bob"}:${r.note_id === n1 ? "n1" : "n2"}`)
      .sort();
    expect(await rows()).toEqual(["alice:n1", "alice:n2", "bob:n1", "bob:n2"]);
    await pool.query(`delete from notes where id = $1`, [n1]);
    expect(await rows()).toEqual(["alice:n2", "bob:n2"]);
    await pool.query(`delete from users where id = $1`, [bob]);
    expect(await rows()).toEqual(["alice:n2"]);
  });

  it("SQL file has only a table, two FKs and one index; no CONCURRENTLY/line-leading COMMIT", () => {
    // Find the file by tag suffix: numbers may be regenerated when the integration branch merges.
    const entries = journalEntries().filter(e => e.tag.endsWith("_note-favorites"));
    expect(entries, "journal 裡要恰有一支 *_note-favorites").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map(s => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(s => s.length > 0);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE TABLE "note_favorites"/);
    expect(statements.filter(s => /^ALTER TABLE "note_favorites" ADD CONSTRAINT "[^"]+" FOREIGN KEY .* ON DELETE cascade/.test(s))).toHaveLength(2);
    expect(statements.filter(s => /^CREATE INDEX "note_favorites_note_idx"/.test(s))).toHaveLength(1);
  });
});

describe("search-trigram (pg_trgm body index)", () => {
  it("pg_trgm is installed; nss_body_trgm_idx is a gin_trgm_ops index on lower(body)", async () => {
    const { pool } = await freshDb();
    const ext = (await pool.query(`select 1 from pg_extension where extname = 'pg_trgm'`)).rows;
    expect(ext).toHaveLength(1);
    const idx = (await pool.query(`select tablename, indexdef from pg_indexes where indexname = 'nss_body_trgm_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].tablename).toBe("note_search_sections");
    expect(idx[0].indexdef).toMatch(/USING gin \(lower\(body\) gin_trgm_ops\)$/);
  });

  it("a non-superuser database owner can run every migration (pg_trgm is a trusted extension)", async () => {
    const baseUrl = process.env.TEST_DATABASE_URL!;
    const fresh = await freshEmptyDb();
    const role = `owner_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: baseUrl });
    let ownerPool: Pool | undefined;
    try {
      const dbName = new URL(fresh.url).pathname.slice(1);
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query(`ALTER DATABASE "${dbName}" OWNER TO "${role}"`);
      const ownerUrl = new URL(fresh.url);
      ownerUrl.username = role;
      ownerUrl.password = password;
      ownerPool = new Pool({ connectionString: ownerUrl.toString() });
      // DROP DATABASE … WITH (FORCE) sends 57P01 to leftover connections; without a listener vitest fails the run (as in helpers.ts close()).
      ownerPool.on("error", () => {});
      const ownerDb = createDb(ownerPool);
      const su = (await ownerPool.query(`select rolsuper from pg_roles where rolname = current_user`)).rows[0].rolsuper;
      expect(su).toBe(false);
      // Absent before, owned by the new role after: the non-superuser owner created it through the trusted-extension path.
      expect((await ownerPool.query(`select 1 from pg_extension where extname = 'pg_trgm'`)).rows).toHaveLength(0);
      await runMigrations(ownerDb);
      const extOwner = await ownerPool.query(
        `select r.rolname from pg_extension e join pg_roles r on r.oid = e.extowner where e.extname = 'pg_trgm'`,
      );
      expect(extOwner.rows).toEqual([{ rolname: role }]);
      expect((await ownerPool.query(`select 1 from pg_indexes where indexname = 'nss_body_trgm_idx'`)).rows).toHaveLength(1);
    } finally {
      // Order matters: the role owns the objects the migrations created, so the database must be dropped before DROP ROLE (handing ownership back is not enough).
      await ownerPool?.end();
      await fresh.close();
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  });

  it("SQL file: CREATE EXTENSION plus one CREATE INDEX; no CONCURRENTLY or leading COMMIT", () => {
    const entries = journalEntries().filter(e => e.tag.endsWith("_search-trigram"));
    expect(entries, "journal must have exactly one *_search-trigram entry").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map(s => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(s => s.length > 0);
    expect(statements).toEqual([
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
      `CREATE INDEX "nss_body_trgm_idx" ON "note_search_sections" USING gin (lower("body") gin_trgm_ops);`,
    ]);
  });
});

describe("0043_tags", () => {
  type Pool = import("pg").Pool;
  const insertTag = async (pool: Pool, cols: string, vals: unknown[]) =>
    (await pool.query(`insert into tags (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)).rows[0].id as string;
  const user = async (pool: Pool, email: string) =>
    (await pool.query(`insert into users (email, display_name) values ($1, $1) returning id`, [email])).rows[0].id as string;
  const group = async (pool: Pool, owner: string, name: string) =>
    (await pool.query(`insert into groups (name, created_by) values ($1, $2) returning id`, [name, owner])).rows[0].id as string;
  const outcome = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { const x = e as { code?: string; constraint?: string }; return `${x.code}:${x.constraint}`; }
    return "ok";
  };

  it("columns, the generated name_key, checks, both partial unique indexes and the FKs with their ON DELETE", async () => {
    const { pool } = await freshDb();
    const cols = (await pool.query(
      `select column_name, data_type, is_nullable, column_default, is_generated, generation_expression from information_schema.columns where table_name = 'tags' order by column_name`,
    )).rows as { column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string; generation_expression: string | null }[];
    expect(cols.map(c => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ["color", "text", "NO"],
      ["created_at", "timestamp with time zone", "NO"],
      ["created_by", "uuid", "YES"],
      ["group_id", "uuid", "YES"],
      ["id", "uuid", "NO"],
      ["name", "text", "NO"],
      ["name_key", "text", "NO"],
      ["owner_id", "uuid", "YES"],
    ]);
    const nameKey = cols.find(c => c.column_name === "name_key")!;
    expect(nameKey.is_generated).toBe("ALWAYS");
    expect(nameKey.generation_expression).toBe("lower(name)");
    expect(cols.find(c => c.column_name === "id")!.column_default).toContain("gen_random_uuid()");

    const checks = (await pool.query(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'tags'::regclass and contype = 'c' order by conname`,
    )).rows as { conname: string; def: string }[];
    expect(checks.map(c => c.conname)).toEqual(["tags_color_chk", "tags_name_len_chk", "tags_space_chk"]);

    const idx = (await pool.query(`select indexname, indexdef from pg_indexes where tablename = 'tags' and indexname like '%\\_name\\_idx' order by indexname`)).rows as { indexname: string; indexdef: string }[];
    expect(idx.map(i => i.indexname)).toEqual(["tags_group_name_idx", "tags_owner_name_idx"]);
    expect(idx[0]!.indexdef).toBe("CREATE UNIQUE INDEX tags_group_name_idx ON public.tags USING btree (group_id, name_key) WHERE (group_id IS NOT NULL)");
    expect(idx[1]!.indexdef).toBe("CREATE UNIQUE INDEX tags_owner_name_idx ON public.tags USING btree (owner_id, name_key) WHERE (owner_id IS NOT NULL)");

    const fks = (await pool.query(
      `select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref, c.confdeltype
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.conrelid in ('tags'::regclass, 'note_tags'::regclass)
        order by tbl, col`,
    )).rows;
    expect(fks).toEqual([
      { tbl: "note_tags", col: "note_id", ref: "notes", confdeltype: "c" },
      { tbl: "note_tags", col: "tag_id", ref: "tags", confdeltype: "c" },
      { tbl: "tags", col: "created_by", ref: "users", confdeltype: "n" },
      { tbl: "tags", col: "group_id", ref: "groups", confdeltype: "c" },
      { tbl: "tags", col: "owner_id", ref: "users", confdeltype: "c" },
    ]);

    const nt = (await pool.query(`select column_name, is_nullable from information_schema.columns where table_name = 'note_tags' order by column_name`)).rows;
    expect(nt).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "note_id", is_nullable: "NO" },
      { column_name: "tag_id", is_nullable: "NO" },
    ]);
    const pk = (await pool.query(
      `select a.attname from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'note_tags'::regclass and c.contype = 'p' order by k.ord`,
    )).rows.map((r: { attname: string }) => r.attname);
    expect(pk).toEqual(["note_id", "tag_id"]);
    const tIdx = (await pool.query(`select indexdef from pg_indexes where indexname = 'note_tags_tag_idx'`)).rows;
    expect(tIdx).toHaveLength(1);
    expect(tIdx[0].indexdef).toMatch(/USING btree \(tag_id\)$/);
  });

  it("the same name differing only in case is 23505 tags_owner_name_idx in one personal space, allowed in another user's space and in a group", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag@example.com");
    const bob = await user(pool, "bob-tag@example.com");
    const g = await group(pool, alice, "g1");
    await insertTag(pool, "owner_id, name, color", [alice, "AWS", "blue"]);
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "aws", "blue"]))).toBe("23505:tags_owner_name_idx");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [bob, "aws", "blue"]))).toBe("ok");
    expect(await outcome(insertTag(pool, "group_id, name, color", [g, "aws", "blue"]))).toBe("ok");
    expect((await pool.query(`select name_key from tags where owner_id = $1`, [alice])).rows[0].name_key).toBe("aws");
  });

  it("the same name differing only in case is 23505 tags_group_name_idx within one group", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag2@example.com");
    const g1 = await group(pool, alice, "g1");
    const g2 = await group(pool, alice, "g2");
    await insertTag(pool, "group_id, name, color", [g1, "Ops", "green"]);
    expect(await outcome(insertTag(pool, "group_id, name, color", [g1, "OPS", "green"]))).toBe("23505:tags_group_name_idx");
    expect(await outcome(insertTag(pool, "group_id, name, color", [g2, "OPS", "green"]))).toBe("ok");
  });

  it("color outside the nine is 23514 tags_color_chk; both or neither of owner_id and group_id is 23514 tags_space_chk; 41 code points is 23514 tags_name_len_chk", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag3@example.com");
    const g = await group(pool, alice, "g1");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "a", "default"]))).toBe("23514:tags_color_chk");
    expect(await outcome(insertTag(pool, "owner_id, group_id, name, color", [alice, g, "a", "blue"]))).toBe("23514:tags_space_chk");
    expect(await outcome(insertTag(pool, "name, color", ["a", "blue"]))).toBe("23514:tags_space_chk");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "", "blue"]))).toBe("23514:tags_name_len_chk");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "x".repeat(41), "blue"]))).toBe("23514:tags_name_len_chk");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "x".repeat(40), "blue"]))).toBe("ok");
    // length() counts code points, not UTF-16 units: 40 astral characters pass, 41 do not
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "\u{1F600}".repeat(40), "blue"]))).toBe("ok");
    expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, "\u{1F600}".repeat(41), "blue"]))).toBe("23514:tags_name_len_chk");
    for (const c of ["blue", "green", "orange", "purple", "pink", "red", "yellow", "brown", "gray"]) {
      expect(await outcome(insertTag(pool, "owner_id, name, color", [alice, `c-${c}`, c])), c).toBe("ok");
    }
  });

  it("deleting a group deletes its tags and their note_tags rows; permanently deleting a note deletes only its note_tags rows", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag4@example.com");
    const g = await group(pool, alice, "g1");
    const n1 = (await pool.query(`insert into notes (group_id) values ($1) returning id`, [g])).rows[0].id as string;
    const n2 = (await pool.query(`insert into notes (group_id) values ($1) returning id`, [g])).rows[0].id as string;
    const t1 = await insertTag(pool, "group_id, name, color, created_by", [g, "one", "blue", alice]);
    const t2 = await insertTag(pool, "group_id, name, color", [g, "two", "red"]);
    await pool.query(`insert into note_tags (note_id, tag_id) values ($1, $3), ($1, $4), ($2, $3)`, [n1, n2, t1, t2]);
    await pool.query(`delete from notes where id = $1`, [n1]);
    expect((await pool.query(`select count(*)::int as n from tags`)).rows[0].n).toBe(2);
    expect((await pool.query(`select note_id, tag_id from note_tags`)).rows).toEqual([{ note_id: n2, tag_id: t1 }]);
    // a group must be empty to be deleted, so the note is handed to a member first
    await pool.query(`update notes set owner_id = $2, group_id = null where id = $1`, [n2, alice]);
    await pool.query(`delete from groups where id = $1`, [g]);
    expect((await pool.query(`select count(*)::int as n from tags`)).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from note_tags`)).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from notes where id = $1`, [n2])).rows[0].n).toBe(1);
  });

  it("deleting the creator keeps the tag with created_by null; deleting the owner removes the personal tags", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag5@example.com");
    const bob = await user(pool, "bob-tag5@example.com");
    const t = await insertTag(pool, "owner_id, name, color, created_by", [alice, "mine", "blue", bob]);
    await pool.query(`delete from users where id = $1`, [bob]);
    expect((await pool.query(`select created_by from tags where id = $1`, [t])).rows[0].created_by).toBeNull();
    await pool.query(`delete from users where id = $1`, [alice]);
    expect((await pool.query(`select count(*)::int as n from tags`)).rows[0].n).toBe(0);
  });

  it("note_tags.created_at defaults to whole milliseconds", async () => {
    const { pool } = await freshDb();
    const alice = await user(pool, "alice-tag6@example.com");
    const n = (await pool.query(`insert into notes (owner_id) values ($1) returning id`, [alice])).rows[0].id as string;
    const t = await insertTag(pool, "owner_id, name, color", [alice, "x", "blue"]);
    await pool.query(`insert into note_tags (note_id, tag_id) values ($1, $2)`, [n, t]);
    const sub = (await pool.query(`select count(*)::int as n from note_tags where extract(microseconds from created_at)::bigint % 1000 <> 0`)).rows[0].n;
    expect(sub).toBe(0);
    const def = (await pool.query(`select column_default from information_schema.columns where table_name = 'note_tags' and column_name = 'created_at'`)).rows[0].column_default as string;
    expect(def).toContain("date_trunc('milliseconds'");
  });

  it("SQL file only creates the two tables and their own constraints and indexes; no CONCURRENTLY/line-leading COMMIT", () => {
    const entries = journalEntries().filter(e => e.tag.endsWith("_tags"));
    expect(entries, "journal has exactly one *_tags").toHaveLength(1);
    const sqlText = readFileSync(path.join(drizzleDirForTest, `${entries[0]!.tag}.sql`), "utf8");
    expect(sqlText).not.toMatch(/CONCURRENTLY/i);
    expect(sqlText).not.toMatch(/^\s*COMMIT/im);
    const statements = sqlText.split("--> statement-breakpoint").map(s => s.replace(/^\s*--.*$/gm, "").trim()).filter(s => s.length > 0);
    expect(statements.filter(s => /^CREATE TABLE "(tags|note_tags)"/.test(s))).toHaveLength(2);
    for (const st of statements) {
      expect(st).toMatch(/^(CREATE TABLE "(tags|note_tags)"|ALTER TABLE "(tags|note_tags)" ADD CONSTRAINT|CREATE (UNIQUE )?INDEX "(tags|note_tags)_)/);
    }
  });
});
