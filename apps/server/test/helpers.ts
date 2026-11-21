import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { WebSocket as WsWebSocket } from "ws";
import * as Y from "yjs";
import { NOTE_SCHEMA_VERSION, SESSION_COOKIE, SITE_LIMITS, type Role } from "@knotebook/shared";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp, type AppDeps, type BuildAppOptions } from "../src/app.js";
import { signSession, UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { buildFixedLimiters, type Limiters } from "../src/http/limiters.js";
import { hashPassword } from "../src/auth/password.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import type { CollabHooksLogger } from "../src/collab/hooks-impl.js";
import { COLLAB_PATH, createCollabServer, type CollabDeps, type CollabServer } from "../src/collab/server.js";
import { notes, noteShares, users } from "../src/db/schema.js";
import { createAiRuntime } from "../src/ai/runtime.js";
import { createEditingRuntime, type EditingRuntime } from "../src/notes/editing/runtime.js";
import { SiteLimits, type SiteLimitsLog } from "../src/site-limits/store.js";

export interface FreshDb {
  db: Db;
  pool: Pool;
  /** For opening a second pool on the same database. */
  url: string;
  /** Manual close for non-test use; inside a test, onTestFinished already does it. */
  close: () => Promise<void>;
}

/**
 * Creates a fresh database (random name) WITHOUT running any migration: the entry point of the migration harness, which needs to build the schema up to
 * migration N, insert old data, and then run the target migration (`freshDb()` always runs them all). Use `freshDb()` for ordinary tests.
 *
 * Deliberately not `DROP SCHEMA public CASCADE; CREATE SCHEMA public`: drizzle's migration journal lives in the `drizzle` schema, so after dropping public
 * drizzle would still think every migration ran and a second migrate would silently skip creating the tables. A random-name CREATE DATABASE guarantees
 * a clean database whose journal matches its tables.
 *
 * Inside a vitest test, cleanup runs through `onTestFinished` (close the pool, then DROP the database, see `close`) even when an assertion throws,
 * so no connection or database leaks; `close()` is also returned for non-test contexts. Both are idempotent.
 *
 * @param opts.cLocale When `true`, create the database from template0 with `LC_COLLATE` and `LC_CTYPE` set to `C`
 *   (by default it inherits the cluster's locale).
 */
export async function freshEmptyDb(opts: { cLocale?: boolean } = {}): Promise<FreshDb> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL 未設定——確認 vitest globalSetup（test/global-setup.ts）有跑過");

  const dbName = `test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: baseUrl });
  try {
    await adminPool.query(
      opts.cLocale === true
        ? `CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`
        : `CREATE DATABASE "${dbName}"`,
    );
  } finally {
    await adminPool.end();
  }

  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  const pool = new Pool({ connectionString: dbUrl.toString() });
  const db = createDb(pool);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Must be dropped: otherwise 400+ tests in one run accumulate hundreds of test_<random> databases in the same container until CREATE DATABASE fails
    // (issue #51: a whole integration run went red once and was green on rerun). End our own pool first, then connect to base separately (a database can't be dropped from itself).
    // - `pool.end()` sits in the try of a try/finally so the DROP still runs if it throws (otherwise that db leaks forever);
    // - WITH (FORCE) (PG 13+) kicks leftover connections so a test that didn't close cleanly doesn't make the DROP fail;
    // - a failing DROP is only logged, never thrown: cleanup must not turn a green test red.
    //
    // Attach a swallowing error listener to the pool as soon as close starts: WITH (FORCE) sends FATAL 57P01 (terminating connection due to administrator command)
    // to leftover connections whose `pool.end()` has resolved but whose socket isn't fully closed; that client's error bubbles to the pool, and without an error
    // listener it is a process-level uncaught error, which vitest records as an unhandled error that fails an otherwise green run (hit once in CI; a timing window).
    // Pool errors after close starts are expected fallout of the cleanup itself; pool errors during the test are unaffected (the listener is only attached at close).
    // helpers.test.ts has a test pinning this line: without it the suite stays green (timing window) and only that test fails.
    pool.on("error", () => {});
    try {
      await pool.end();
    } finally {
      const dropPool = new Pool({ connectionString: baseUrl });
      try {
        await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch (err) {
        console.warn(`[freshEmptyDb] 清理測試資料庫 ${dbName} 失敗（忽略）：`, err);
      } finally {
        await dropPool.end();
      }
    }
  };

  // onTestFinished only works inside a vitest test (it throws otherwise); freshDb() can also be called from manual contexts (e.g. debugging scripts), where the caller must call close() itself.
  try {
    onTestFinished(close);
  } catch {
  }

  return { db, pool, url: dbUrl.toString(), close };
}

export async function freshDb(): Promise<FreshDb> {
  const fresh = await freshEmptyDb();
  await runMigrations(fresh.db);
  await installTestDefaultSessions(fresh.pool);
  return fresh;
}

/**
 * #388: a session JWT must match a row in `sessions`. Many tests sign a cookie directly without logging in (`cookieFor`/`cookieOf`/`signTestSession` in each file);
 * so that hundreds of call sites needn't take a db, `freshDb()` installs a **test-only** trigger: every new user automatically gets a "test default session" row
 * with id = `testSessionId(userId)` (`md5(user_id::text)::uuid`, the same formula in Node) that expires in 100 years. `signTestSession` signs exactly that row.
 *
 * Only `freshDb()` has it (not `freshEmptyDb()`/the migration harness); real migrations don't contain the trigger. Names carry `public.` because some tests
 * insert users on a connection whose search_path excludes public (the storage-quota DEFAULT case in `migrate.test.ts`). To test session-row behaviour itself
 * (logout, password change replacing the row, expiry) use a real login (`POST /api/auth/login`) or `insertSession` - those rows have random ids unrelated
 * to this one; assertions that count rows must remember this one exists.
 */
async function installTestDefaultSessions(pool: Pool): Promise<void> {
  await pool.query(`
    create function public.test_default_session() returns trigger language plpgsql as $$
    begin
      insert into public.sessions (id, user_id, expires_at) values (md5(new.id::text)::uuid, new.id, now() + interval '100 years');
      return null;
    end $$;
    create trigger test_default_session after insert on public.users for each row execute function public.test_default_session();
  `);
}

/** Must match the trigger's `md5(user_id::text)::uuid`. */
export function testSessionId(userId: string): string {
  const h = createHash("md5").update(userId.toLowerCase()).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Lifetime for test-signed session JWTs and directly created session rows = the registry default (7 days). */
export const TEST_SESSION_TTL = SITE_LIMITS.sessionTtlSeconds.default;

export function signTestSession(payload: { userId: string; tv: number }): Promise<string> {
  return signSession(testConfig.appSecret, { ...payload, sid: testSessionId(payload.userId) }, TEST_SESSION_TTL);
}

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/** Address by tag: positional indexes (`entries.length - 2` style) drift in meaning with every new migration (half the tests go red, the other half silently stay true); a tag is permanently stable. */
export function idxOfTag(tag: string): number {
  const entry = journalEntries().find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`journal 裡沒有 tag=${tag}`);
  return entry.idx;
}

/**
 * Replays migrations from the committed SQL files up to journal `idx <= upToIdx` (split on `--> statement-breakpoint` like the drizzle migrator; no SQL parsing,
 * so DO `$$` blocks are safe), all statements in a single transaction, and records bookkeeping in `drizzle.__drizzle_migrations`. A later `runMigrations` on
 * the same database then only runs the remaining pending ones (drizzle wraps pending migrations in one transaction, so `CONCURRENTLY` fails naturally).
 *
 * The bookkeeping shape is load-bearing (checked against drizzle-orm 0.44.7 pg-core/dialect.js): drizzle's skip rule only looks at the row from
 * `order by created_at desc limit 1` and `created_at < folderMillis`, so `created_at` must be the journal entry's `when`. Writing `Date.now()` fails
 * silently: it is larger than every journal `when`, so every later pending migration is skipped with no error. migration-harness.test.ts guards this line
 * (its bookkeeping row-count test after applyThrough + runMigrations is the only one that catches it). `hash` = sha256 hex of the whole .sql text
 * (NOT NULL, but not part of the skip rule).
 *
 * The execution protocol is looser than drizzle's: this runs pg's simple protocol per segment (a segment may hold several statements) while drizzle uses the
 * extended protocol (one statement per segment), so a green harness doesn't guarantee a green drizzle; every migration still goes through drizzle's path
 * in freshDb/runMigrations, so the gap is covered.
 *
 * `fromIdx` (#175): replays only `fromIdx..upToIdx` - for "build up to N-1, insert data, then run only N" (`runMigrations` runs to the last one and can't stop
 * in the middle; replaying from 0 on the same database would fail with `already exists`). Default 0 = from the start, so existing callers are unchanged.
 */
export async function applyMigrationsThrough(pool: Pool, upToIdx: number, fromIdx = 0): Promise<void> {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  // upToIdx must exist: running everything silently when it is out of range would build the "old schema fixture" on the new schema and misalign the whole data case - fail loudly.
  if (!journal.entries.some((entry) => entry.idx === upToIdx)) {
    const available = journal.entries.map((entry) => entry.idx).join(", ");
    throw new Error(`applyMigrationsThrough: upToIdx=${upToIdx} 不存在於 journal（可用：${available}）`);
  }
  if (!journal.entries.some((entry) => entry.idx === fromIdx) || fromIdx > upToIdx) {
    throw new Error(`applyMigrationsThrough: fromIdx=${fromIdx} 不存在或大於 upToIdx=${upToIdx}`);
  }
  const entries = journal.entries.filter((entry) => entry.idx >= fromIdx && entry.idx <= upToIdx);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The bookkeeping table shape copies the drizzle migrator (schema/column names and types are load-bearing: otherwise runMigrations can't read it).
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    for (const entry of entries) {
      const sql = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        await client.query(statement);
      }
      await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [
        createHash("sha256").update(sql).digest("hex"),
        entry.when,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `AppDeps.uploadsDir` is required and `buildApp` probes it for writability at startup (`assertUploadsDirWritable` in app.ts); passing a path without creating
 * the directory would make every integration test throw synchronously at `buildApp()`. Cleanup follows `freshDb()`: `onTestFinished` deletes it recursively;
 * outside a test context (not expected, all internal callers run inside tests) it is skipped and the caller must clean up.
 */
export function freshUploadsDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-"));
  try {
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  } catch {
  }
  return dir;
}

// Fixed test config for buildTestApp: databaseUrl only has to pass loadConfig's format validation; the real DB connection always comes from freshDb()
// (a fresh database per test) and is unrelated to this DATABASE_URL. Exported so tests that need session cookies the buildTestApp() app accepts
// (e.g. the auth chain test in app.test.ts) can use the same appSecret.
export const testConfig: AppConfig = loadConfig({
  DATABASE_URL: "postgres://u:p@localhost:5432/test",
  APP_SECRET: "a".repeat(64),
  PUBLIC_URL: "http://localhost:3000",
});

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  uploadsDir: string;
  siteLimits: SiteLimits;
  /** Manual close; a no-op when `db` is overridden (its creator closes it). Inside a test it is already hooked via onTestFinished. */
  close: () => Promise<void>;
}

const silentLog: SiteLimitsLog = { warn: () => {}, error: () => {} };

/** Test-only probe routes, not part of any production route module; `/__test/protected` returns `request.user`. */
export function withTestRoutes(app: FastifyInstance): FastifyInstance {
  app.get("/__test/protected", { preHandler: app.authenticate }, async req => req.user);
  app.get("/__test/admin", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  app.get("/__test/throw", async () => {
    throw new Error("boom");
  });
  app.post("/__test/echo", async req => req.body);
  return app;
}

// Test default for AppDeps.limiters: builds a brand-new instance on every call (`FixedWindowLimiter` state is an in-memory Map; a module-level constant shared across
// tests would leak request counts between files / buildTestApp() calls, e.g. a "429 after 61 requests" test would depend on counts consumed by earlier tests and go red or green by run order).
// Only the 22 fixed limiters (`buildFixedLimiters()`, same values as production) plus overrides; the 9 site-tunable ones are filled in by `buildApp` from the app's
// `deps.siteLimits` (#397), so throttling in tests matches production.
//
// `overrides` lets one test replace just the limiter it checks (e.g. `{ bearerMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }`) without spelling out every key:
// the key count keeps growing (#132), and copying all keys per file means missed edits the next time a limiter changes.
//
// Callers that take an optional limiter set themselves should forward the whole overrides object, not expand it key by key (`{ publicMiss: overrides.publicMiss, ... }`):
// unspecified keys would get an explicit `undefined` that overwrites the defaults here (tsconfig doesn't enable `exactOptionalPropertyTypes`, so TS doesn't catch it),
// and at runtime it is `undefined.consume`.
/** The tunable limiters are filled in only when not overridden. */
export function freshLimiters(overrides: Partial<Limiters> = {}): Partial<Limiters> {
  return { ...buildFixedLimiters(), ...overrides };
}

/**
 * #106: the jsdom editing runtime shared by integration tests (both `AppDeps.editing` and `seedContent` in `editing-helpers.ts` inject this one). The **module-level
 * singleton is deliberate**, unlike `freshLimiters`' "new each time": the runtime has no counting state that could leak between tests, whereas building a jsdom per test
 * would re-run `installGlobals()` and re-mount the global window/document, pulling the window out from under editors built earlier in the same file, and each leftover costs about 0.53 MB.
 *
 * #397: the pool config takes the site defaults (it is built before any DB exists, so it uses `SiteLimits.defaults`) and **never follows any app's `siteLimits`**:
 * it is shared by many apps, and one app's PATCH must not change another test's pool. `buildTestApp`/`buildCollabTestApp` reject `editingFollowsSiteLimits: true`
 * when `editing` is this one (including when it is omitted and defaults to it); tests that need a pool that follows changes build their own runtime.
 */
export const testEditingRuntime = createEditingRuntime(testConfig, SiteLimits.defaults({ machine: testConfig.machine }).parseLimits());

const SHARED_RUNTIME_FOLLOW_ERROR = "testEditingRuntime is shared; pass your own editing runtime to follow site limits";

/**
 * FastifyInstance with default deps (freshDb + real UserGate/LoginThrottle + noop collab hooks) for integration tests; any dep can be replaced via `overrides`.
 *
 * Does **not** call `initializeInstance`: app construction doesn't need the initialization check, the fail-fast only runs from `index.ts` (production start).
 * Integration tests create accounts with `db.insert(users)` directly (see `createUser` in `buildCollabTestApp`).
 *
 * The logger is off by default (quiet output); `options.logger` turns it back on (e.g. to debug one test's request log).
 *
 * #397: decide the `config` and `db` the app actually uses first, then `SiteLimits.load` once with them (`overrides.siteLimits` wins if given); these three are placed
 * after the remaining `overrides`, so they can't be overwritten - the lock state (`config.limitEnv`) and the DB each have a single source.
 */
export async function buildTestApp(overrides: Partial<AppDeps> = {}, options: BuildAppOptions = {}): Promise<TestApp> {
  if (overrides.editing === testEditingRuntime && overrides.editingFollowsSiteLimits === true) throw new Error(SHARED_RUNTIME_FOLLOW_ERROR);
  const { config: configOverride, db: dbOverride, siteLimits: siteLimitsOverride, ...rest } = overrides;
  const config = configOverride ?? testConfig;
  const fresh = dbOverride ? null : await freshDb();
  const db = dbOverride ?? fresh!.db;
  const close = fresh?.close ?? (async () => {});
  const siteLimits = siteLimitsOverride ?? (await SiteLimits.load(db, { limitEnv: config.limitEnv, machine: config.machine, log: silentLog }));
  const deps: AppDeps = {
    gate: new UserGate(db),
    throttle: new LoginThrottle(),
    collabHooks: noopCollabHooks,
    limiters: freshLimiters(),
    uploadsDir: freshUploadsDir(),
    ai: createAiRuntime(),
    ...rest,
    config,
    db,
    siteLimits,
  };
  const app = buildApp(deps, { logger: false, ...options });
  // Return deps.uploadsDir (not the default): if the caller replaced it via overrides, the returned value must match what the app really uses.
  return { app, db, uploadsDir: deps.uploadsDir, siteLimits, close };
}

// Collab (Hocuspocus) test harness: the only one for all collab integration tests; others consume this interface instead of rolling their own
// (user creation, login, provider building and teardown live only here).
//
// Unlike `buildTestApp`, collab needs a **real HTTP + WebSocket** server (`app.inject` doesn't listen and offers no upgradable socket), so this always starts
// a real server on an ephemeral port via `app.listen({ port: 0 })`, with cookies and WS on the same origin.

/** Timing out is a connection failure (the test fails), never a silent pass. */
const COLLAB_CONNECT_TIMEOUT_MS = 5_000;

export interface TestClient {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  closes: Array<{ reason: string }>;
  disconnect(): void;
}

export interface HttpSession {
  /** `path` is relative (`/api/...`). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Connects to a note on `/collab`; resolves after the first sync.
   * The token comes from `POST /api/notes/:id/collab-token` (body `{ token, role }`) by default.
   * - `tokenOverride`: skip that endpoint and use the given string (for "reconnect with an old token" tests).
   * - `tokenFn`: replaces the default logic entirely (simulates a failing token endpoint, for "token endpoint 5xx doesn't kill the connection").
   *
   * **A refused connection rejects** (onAuthenticate throws, or timeout without sync) with the refusal reason in the message; the provider is torn down
   * before rejecting so it doesn't keep reconnecting for the rest of the test.
   */
  connect(noteId: string, opts?: { tokenOverride?: string; tokenFn?: () => Promise<string> }): Promise<TestClient>;
}

export interface CollabLogLine {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

/**
 * #269: RequestInit for fetching a collab token, carrying `noteSchemaVersion`. Since the gate went live, a token request without a body gets sv=0 and the
 * handshake is refused as client-outdated (every suite going through this helper would go red). Tests that POST collab-token directly must use it.
 */
export const COLLAB_TOKEN_INIT = { method: "POST", body: JSON.stringify({ noteSchemaVersion: NOTE_SCHEMA_VERSION }) } as const;

export interface CollabTestCtx {
  baseUrl: string;
  app: FastifyInstance;
  collab: CollabServer;
  /** Logs written by CollabServer (the handshake-refusal signal of issue #37 is here); injecting our own logger also stops refusal tests from printing `consoleCollabLogger`'s line to stdout. */
  collabLogs: CollabLogLine[];
  /**
   * Makes every later `gate.check` throw this error, to reproduce the path where onAuthenticate hits an unexpected exception (DB hiccup).
   * `authenticate` uses the same gate, so after breaking it every REST request returns 500; call it as the last step of a test.
   */
  breakGate(err: Error): void;
  /** The same `UserGate` the app uses (after disabling a user, call `invalidate` for it to take effect immediately, like the production disable path). */
  gate: UserGate;
  db: Db;
  siteLimits: SiteLimits;
  uploadsDir: string;
  createUser(opts: { email: string; password: string; isAdmin?: boolean }): Promise<{ id: string }>;
  createNote(ownerId: string, title?: string): Promise<{ id: string }>;
  share(noteId: string, userId: string, role: "editor" | "viewer"): Promise<void>;
  loginAs(email: string, password: string): Promise<HttpSession>;
  /** Idempotent; already registered with onTestFinished. */
  destroy(): Promise<void>;
}

/**
 * App with a real `CollabServer` that actually listens, for collab integration tests.
 *
 * `collabHooks` is the injection seam: the default is `noopCollabHooks` (like `buildTestApp`); revocation tests must pass
 * `collabHooks: (server, log) => createCollabHooks(server, log)` to wire the real implementation (the second argument is this harness's recording logger, so
 * `collabLogs` receives the hooks' signals) - otherwise every shares/disable/DELETE call site is a no-op, revocation never triggers, and the tests are meaninglessly green.
 */
export async function buildCollabTestApp(
  opts: {
    collabHooks?: (server: CollabServer, log: CollabHooksLogger) => CollabHooks;
    /** Replaces only the limiter under test (the rest use the `freshLimiters` defaults); forward the whole object, don't expand it key by key (see `freshLimiters`). */
    limiters?: Partial<Limiters>;
    slugUpdateTestHook?: AppDeps["slugUpdateTestHook"];
    noteCreateHooks?: AppDeps["noteCreateHooks"];
    searchIndexHooks?: AppDeps["searchIndexHooks"];
    knowledgeIndexHooks?: AppDeps["knowledgeIndexHooks"];
    storageLockTimeoutMs?: number;
    editingTestHooks?: AppDeps["editingTestHooks"];
    shownLinks?: AppDeps["shownLinks"];
    mcpTestHooks?: AppDeps["mcpTestHooks"];
    /** #175: group test hook (`"membership-checked"` etc.); MCP `create_note {groupId}` with content needs a collab app to be writable. */
    groupTestHook?: AppDeps["groupTestHook"];
    editingQueueWaitMs?: number;
    presence?: AppDeps["presenceOptions"];
    storeSearchHooks?: CollabDeps["storeSearchHooks"];
    /** #272: auto-version wait override in ms; integration tests mostly pass 0 and then call `collab.versions.scanDue()` directly. */
    versionAutoWaitMs?: number;
    config?: AppConfig;
    reloginReverifyDelayMs?: number;
    lastActiveOptions?: CollabDeps["lastActiveOptions"];
    transferTestHooks?: AppDeps["transferTestHooks"];
    /** Defaults to `false`; pass `{ level, stream }` to capture raw pino output. */
    logger?: BuildAppOptions["logger"];
    /**
     * Shared DB: when given, no `freshDb()` runs (cleanup stays with the `onTestFinished` of the `freshDb()` that created it); each collab server is built separately.
     * Teardown order: `destroy()` the first app before building the second, so two collab servers never hold the same live doc.
     */
    db?: Db;
    /** #398: replaces the shared `testEditingRuntime` (e.g. a small time limit / small queue for the parse pool); the caller `close()`s it. */
    editing?: EditingRuntime;
    /**
     * #397: `editing` follows this app's `siteLimits` changes. Only valid with a self-built runtime: `true` throws when `editing` is omitted or is
     * `testEditingRuntime` (the shared runtime must not be reconfigured by any app).
     */
    editingFollowsSiteLimits?: boolean;
    siteLimits?: SiteLimits;
  } = {}
): Promise<CollabTestCtx> {
  const editing = opts.editing ?? testEditingRuntime;
  if (editing === testEditingRuntime && opts.editingFollowsSiteLimits === true) throw new Error(SHARED_RUNTIME_FOLLOW_ERROR);
  const config = opts.config ?? testConfig;
  const { db } = opts.db ? { db: opts.db } : await freshDb();
  const siteLimits = opts.siteLimits ?? (await SiteLimits.load(db, { limitEnv: config.limitEnv, machine: config.machine, log: silentLog }));
  const gate = new UserGate(db);
  // Test injection seam, see `CollabTestCtx.breakGate`: defined in the harness (not monkey-patched per test) so there is a single definition of how the gate gets broken.
  let gateError: Error | null = null;
  const realCheck = gate.check.bind(gate);
  gate.check = async (userId: string, tv: number, sessionId: string) => {
    if (gateError) throw gateError;
    return realCheck(userId, tv, sessionId);
  };
  const breakGate = (err: Error): void => {
    gateError = err;
  };
  const collabLogs: CollabLogLine[] = [];
  const collabLog = {
    debug: (obj: object, msg: string) => collabLogs.push({ level: "debug", obj: { ...obj }, msg }),
    info: (obj: object, msg: string) => collabLogs.push({ level: "info", obj: { ...obj }, msg }),
    warn: (obj: object, msg: string) => collabLogs.push({ level: "warn", obj: { ...obj }, msg }),
    error: (obj: object, msg: string) => collabLogs.push({ level: "error", obj: { ...obj }, msg }),
  };
  const collab = createCollabServer({ db, config, gate, log: collabLog, storeSearchHooks: opts.storeSearchHooks, versionAutoWaitMs: opts.versionAutoWaitMs, lastActiveOptions: opts.lastActiveOptions });

  const uploadsDir = freshUploadsDir();
  const deps: AppDeps = {
    config,
    db,
    siteLimits,
    gate,
    throttle: new LoginThrottle(),
    collabHooks: opts.collabHooks ? opts.collabHooks(collab, collabLog) : noopCollabHooks,
    collab,
    editing,
    editingFollowsSiteLimits: opts.editingFollowsSiteLimits === true,
    limiters: freshLimiters(opts.limiters),
    editingTestHooks: opts.editingTestHooks,
    shownLinks: opts.shownLinks,
    mcpTestHooks: opts.mcpTestHooks,
    transferTestHooks: opts.transferTestHooks,
    groupTestHook: opts.groupTestHook,
    slugUpdateTestHook: opts.slugUpdateTestHook,
    noteCreateHooks: opts.noteCreateHooks,
    searchIndexHooks: opts.searchIndexHooks,
    knowledgeIndexHooks: opts.knowledgeIndexHooks,
    ...(opts.reloginReverifyDelayMs === undefined ? {} : { reloginReverifyDelayMs: opts.reloginReverifyDelayMs }),
    ...(opts.storageLockTimeoutMs === undefined ? {} : { storageLockTimeoutMs: opts.storageLockTimeoutMs }),
    editingQueueWaitMs: opts.editingQueueWaitMs,
    presenceOptions: opts.presence,
    uploadsDir,
    ai: createAiRuntime(),
  };
  const app = buildApp(deps, { logger: opts.logger ?? false });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("app.listen 後取不到 TCP 位址——共編 harness 需要真的 port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const collabUrl = `ws://127.0.0.1:${address.port}${COLLAB_PATH}`;

  // Track every client: destroy() must tear down all providers first, otherwise they keep trying to reconnect after the server closes and vitest hangs on open handles.
  const clients = new Set<TestClient>();

  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    for (const client of clients) client.disconnect();
    clients.clear();
    await collab.destroy();
    await app.close();
  };

  // Like freshDb(): tear down even if an assertion throws, so the listening socket doesn't leak.
  try {
    onTestFinished(destroy);
  } catch {
  }

  async function createUser(o: { email: string; password: string; isAdmin?: boolean }): Promise<{ id: string }> {
    const [row] = await db
      .insert(users)
      .values({
        email: o.email,
        displayName: o.email.split("@")[0] ?? o.email,
        isAdmin: o.isAdmin ?? false,
        passwordHash: await hashPassword(o.password),
      })
      .returning({ id: users.id });
    return row;
  }

  async function createNote(ownerId: string, title?: string): Promise<{ id: string }> {
    // When no title is passed, leave it out of values so the schema default "Untitled" applies.
    // Deliberately a direct insert, **not** through the `POST /api/notes` creation point (`notes/create.ts`), so with a title the slug always takes the DB default
    // (`untitled-<uuid8>`) and is not derived from the title (#145); tests that need the derived shape must call the API.
    const values = title === undefined ? { ownerId } : { ownerId, title };
    const [row] = await db.insert(notes).values(values).returning({ id: notes.id });
    return row;
  }

  async function share(noteId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
    await db
      .insert(noteShares)
      .values({ noteId, userId, role })
      .onConflictDoUpdate({ target: [noteShares.noteId, noteShares.userId], set: { role } });
  }

  async function loginAs(email: string, password: string): Promise<HttpSession> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error(`登入失敗（${res.status}）：${await res.text()}`);
    }
    // getSetCookie() is the only way to get multiple Set-Cookie headers (headers.get joins them into one string).
    const cookie = res.headers
      .getSetCookie()
      .map(one => one.split(";")[0])
      .join("; ");

    const session: HttpSession = {
      async fetch(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        // Default the content-type only when a body is really sent: Fastify answers 400 (FST_ERR_CTP_EMPTY_JSON_BODY, built-in behaviour, not app.ts's 415 guard) to
        // `Content-Type: application/json` with an empty body, so body-less routes like `POST /api/notes/:id/collab-token` or `DELETE /api/notes/:id/shares/:userId`
        // would be rejected by Fastify's own JSON parser before reaching their handlers.
        if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
        return fetch(`${baseUrl}${path}`, { ...init, headers });
      },

      async connect(noteId, connectOpts = {}): Promise<TestClient> {
        const token =
          connectOpts.tokenFn ??
          (connectOpts.tokenOverride !== undefined
            ? connectOpts.tokenOverride
            : async (): Promise<string> => {
                const tokenRes = await session.fetch(`/api/notes/${noteId}/collab-token`, COLLAB_TOKEN_INIT);
                if (!tokenRes.ok) {
                  throw new Error(`取得 collab token 失敗（${tokenRes.status}）：${await tokenRes.text()}`);
                }
                const body = (await tokenRes.json()) as { token: string; role: Role };
                return body.token;
              });

        const doc = new Y.Doc();
        const closes: Array<{ reason: string }> = [];

        // One socket per client (not one multiplexed socket) so socketId maps one-to-one to clients and the connectionsOf/connectionsOfNote count assertions
        // match the intuitive "how many clients are online".
        const socket = new HocuspocusProviderWebsocket({ url: collabUrl, WebSocketPolyfill: WsWebSocket });
        const provider = new HocuspocusProvider({
          websocketProvider: socket,
          name: noteId,
          document: doc,
          token,
          // onClose receives two kinds of events: the application-level CLOSE message sent by the server's `handle.close(reason)` (carrying our reason) and the underlying
          // socket really closing. Only the former is recorded: a socket-level close reason is always an empty string (the one exception, the "server shutdown"
          // sent by the harness's own destroy(), comes after the assertions).
          onClose: ({ event }) => {
            if (event.reason) closes.push({ reason: event.reason });
          },
        });

        const client: TestClient = {
          provider,
          doc,
          closes,
          disconnect(): void {
            clients.delete(client);
            provider.destroy();
            // With an explicit websocketProvider, provider.destroy() doesn't close the socket too; tear it down explicitly or it keeps reconnecting per the reconnect strategy.
            socket.destroy();
          },
        };
        clients.add(client);

        const established = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`共編連線逾時（${COLLAB_CONNECT_TIMEOUT_MS}ms 內未完成 sync）：note=${noteId}`)),
            COLLAB_CONNECT_TIMEOUT_MS
          );
          provider.on("synced", () => {
            clearTimeout(timer);
            resolve();
          });
          provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
            clearTimeout(timer);
            reject(new Error(`共編連線被拒絕（${reason}）：note=${noteId}`));
          });
        });

        // With an explicit `websocketProvider`, HocuspocusProvider doesn't attach itself (the constructor only calls attach when it creates its own socket); without this line
        // the provider never sends the auth message and the connection just sits unsynced. This is the intended v4 multiplexing usage (several providers on one socket).
        provider.attach();

        try {
          await established;
        } catch (error) {
          client.disconnect();
          throw error;
        }

        return client;
      },
    };

    return session;
  }

  return { baseUrl, app, collab, collabLogs, breakGate, gate, db, siteLimits, uploadsDir, createUser, createNote, share, loginAs, destroy };
}

/**
 * Creates a user who **can log in with a password**. The per-file `cookieFor` convention (`signTestSession({ userId, tv: 0 })`) is enough when only a cookie that
 * passes authenticate is needed; this covers the other half: tests that really run `POST /api/auth/login` or `POST /api/auth/password`
 * (e.g. verifying API tokens stay valid after a password change).
 */
export async function insertPasswordUser(
  db: Db,
  over: { password?: string; mustChangePassword?: boolean; email?: string } = {}
): Promise<{ id: string; email: string; password: string }> {
  const password = over.password ?? "correct-horse-battery-staple";
  const email = over.email ?? `u-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      displayName: "Test User",
      passwordHash: await hashPassword(password),
      mustChangePassword: over.mustChangePassword ?? false,
    })
    .returning();
  return { id: user.id, email, password };
}

/**
 * #132: creates a user with a password and signs the session cookie (**header form**, usable directly as `inject({ headers: { cookie } })`).
 * Doesn't run `POST /api/auth/login`, which would get stuck in the forced first-login password change when `mustChangePassword` is set.
 */
export async function createUserAndLogin(
  db: Db,
  over: { mustChangePassword?: boolean } = {}
): Promise<{ userId: string; cookie: string }> {
  const user = await insertPasswordUser(db, { mustChangePassword: over.mustChangePassword ?? false });
  const jwt = await signTestSession({ userId: user.id, tv: 0 });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${jwt}` };
}
