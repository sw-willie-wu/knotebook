import { createHash, randomBytes } from "node:crypto";
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
import type { Role } from "@knotebook/shared";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp, type AppDeps, type BuildAppOptions } from "../src/app.js";
import { UserGate } from "../src/auth/session.js";
import { LoginThrottle } from "../src/auth/rate-limit.js";
import { AI_LIMIT, BEARER_MISS_LIMIT, COLLAB_TOKEN_LIMIT, FixedWindowLimiter, OIDC_LIMIT, PAT_CREATE_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT, PUBLIC_UPLOAD_LIMIT, SLUG_PATCH_LIMIT, TOKEN_READ_LIMIT, TOKEN_WRITE_LIMIT, UPLOAD_LIMIT } from "../src/http/rate-limit.js";
import { hashPassword } from "../src/auth/password.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import type { CollabHooksLogger } from "../src/collab/hooks-impl.js";
import { COLLAB_PATH, createCollabServer, type CollabServer } from "../src/collab/server.js";
import { notes, noteShares, users } from "../src/db/schema.js";
import { createAiRuntime } from "../src/ai/runtime.js";

export interface FreshDb {
  db: Db;
  pool: Pool;
  /** 手動關閉 pool（非測試情境用）。在 test 內呼叫 freshDb() 不必自己叫這個——已用 onTestFinished 自動掛好。 */
  close: () => Promise<void>;
}

/**
 * 建一個全新的 database（隨機名），**不跑任何 migration**（#122 §7-H harness 的入口：
 * migration 資料案例需要「先建到第 N 支的 schema、塞舊資料、再跑目標 migration」，
 * `freshDb()` 無條件跑完全部做不到）。一般測試請用 `freshDb()`。
 *
 * 刻意不用「DROP SCHEMA public CASCADE; CREATE SCHEMA public」——drizzle 的 migration
 * journal 存在 `drizzle` schema，砍掉 public 後 drizzle 仍以為所有 migration 都跑過，
 * 第二次 migrate 會靜默跳過建表（journal 與實際表結構不同步）。用隨機名 CREATE DATABASE
 * 保證每個測試都是全新、乾淨、journal 與表結構一致的資料庫。
 *
 * Teardown 契約：在 vitest test 內呼叫時，用 `onTestFinished` 自動清理——先關掉 pool、
 * 再 DROP 掉這個資料庫（見下方 `close`），即使斷言失敗（test 拋出）也會執行，不會洩漏
 * 連線或殘留資料庫。同時回傳 `close()` 供非 test context（例如手動除錯腳本）自行呼叫。
 * 兩者皆冪等（多次呼叫安全）。
 */
export async function freshEmptyDb(): Promise<FreshDb> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL 未設定——確認 vitest globalSetup（test/global-setup.ts）有跑過");

  const dbName = `test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: baseUrl });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
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
    // 建了就要收：不 DROP 的話，單一 run 內 400+ 條測試會在同一顆容器裡單調累積出
    // 數百個 test_<random> 資料庫，最終在 CREATE DATABASE 那一行撞牆（issue #51，
    // 2026-08-21 實際踩到整份整合測試一次全紅、重跑全綠）。先 pool.end() 收掉自己的
    // 連線，再另開一條到 base（不能在自己身上 DROP）把它刪掉。
    // - `pool.end()` 放進 try/finally 的 try：即使它拋，DROP 仍會執行（否則那個 db 永久洩漏）；
    // - WITH (FORCE)（PG 13+）踢掉殘留連線，免得某條測試沒關乾淨就 DROP 失敗；
    // - DROP 失敗一律只記錄不拋——清理不該把一條原本綠的測試弄紅。
    //
    // ⚠ close 一開始就給 pool 掛 error 吞噬：WITH (FORCE) 會對「`pool.end()` 已 resolve
    // 但 socket 還沒完全關」的殘留連線發 FATAL 57P01（terminating connection due to
    // administrator command），那個 client 的 error 會 bubble 到 pool——pool 沒有
    // error listener 的話就是 process 級 uncaught，vitest 記一筆 unhandled error 把
    // **全綠的 run 判紅**（CI 實測命中一次；本機三跑未中，是時序窗）。close 開始後的
    // pool error 實務上都是清理自身的預期 fallout，吞掉；測試進行中的 pool error 不受
    // 影響（這個 listener 到 close 才掛上）。helpers.test.ts 有一條測試釘住這行——
    // 拿掉它整份套件照樣綠（時序窗），只有那條會紅。
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

  // onTestFinished 只能在 vitest test 執行context 內呼叫（否則 throw）；freshDb() 也可能被
  // 手動情境（例如除錯用的一次性腳本）呼叫，此時就退回「呼叫方自己叫 close()」。
  try {
    onTestFinished(close);
  } catch {
    // 不在 test context 內——呼叫方需自行呼叫回傳的 close()。
  }

  return { db, pool, close };
}

/** 建一個全新的 database（隨機名）並跑完整 migration——一般整合測試的標準入口。
 * 行為與 teardown 契約（onTestFinished 自動清理、DROP DATABASE 的理由、issue #51）
 * 見 {@link freshEmptyDb}——本函式只是它＋`runMigrations` 的組合。 */
export async function freshDb(): Promise<FreshDb> {
  const fresh = await freshEmptyDb();
  await runMigrations(fresh.db);
  return fresh;
}

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** 讀 drizzle journal（依序）。migration 測試共用。 */
export function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/** tag 尋址：以 migration 名取 idx——位置索引（`entries.length - 2` 類）在每次新增
 * migration 後語意都會漂移（一半測試變紅、另一半**靜默恆真**），tag 釘死永久穩定。 */
export function idxOfTag(tag: string): number {
  const entry = journalEntries().find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`journal 裡沒有 tag=${tag}`);
  return entry.idx;
}

/**
 * #122 §7-H harness：以 committed SQL 檔把 migration 逐支重放到 journal `idx <= upToIdx`
 * 為止（`--> statement-breakpoint` 切分——與 drizzle migrator 同一套、不 parse SQL，
 * DO `$$` 塊安全），**全部語句包在單一 transaction** 內執行並寫 `drizzle.__drizzle_migrations`
 * 記帳。之後對同一顆 DB 呼叫既有 `runMigrations` 就只會跑剩餘 pending——migration
 * 資料案例的目標支由它執行（drizzle 天然把 pending 包成單一 tx，`CONCURRENTLY` 自然紅）。
 *
 * ⚠ 記帳形承重（plan gate M1，對 drizzle-orm 0.44.7 pg-core/dialect.js 核實）：drizzle 的
 * 跳過判準只看「`order by created_at desc limit 1` 那一列的 created_at < folderMillis」——
 * **`created_at` 必須寫 journal entry 的 `when`**。寫 `Date.now()` 的失效模式是**靜默**：
 * Date.now() 比所有 journal when 都大，之後每一支 pending migration 都被跳過、不炸不紅
 * ——守住這行的是 migration-harness.test.ts 的「applyThrough(N-1) 之後 runMigrations
 * 真的把剩餘 pending 跑完」記帳筆數黑箱案（突變審查實證：只有它殺得掉這刀）。`hash`
 * ＝整份 .sql 檔文字的 sha256 hex（NOT NULL 必填，但不參與跳過判準）。
 *
 * ⚠ 執行協定比 drizzle 寬鬆一格：這裡逐段走 pg 的 simple protocol（一段可含多語句），
 * drizzle 走 extended protocol（一段一語句）——「harness 綠」不保證「drizzle 綠」，
 * 但每支 migration 最終都會被 freshDb/runMigrations 走過 drizzle 那條路，缺口有蓋。
 */
export async function applyMigrationsThrough(pool: Pool, upToIdx: number): Promise<void> {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  // upToIdx 必須精確存在（讀碼審查 minor）：超出範圍若靜默全跑，「舊 schema fixture」
  // 會被建在新 schema 上、資料案例整組錯位——fail loud。
  if (!journal.entries.some((entry) => entry.idx === upToIdx)) {
    const available = journal.entries.map((entry) => entry.idx).join(", ");
    throw new Error(`applyMigrationsThrough: upToIdx=${upToIdx} 不存在於 journal（可用：${available}）`);
  }
  const entries = journal.entries.filter((entry) => entry.idx <= upToIdx);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 記帳表形狀照抄 drizzle migrator（schema 名/欄位名/型別都承重——差一點 runMigrations 就讀不到）
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
 * 建一個全新的 uploads 測試目錄（per-test 唯一、真實存在——`AppDeps.uploadsDir` 是
 * 必填欄位，`buildApp` 啟動時會對它做真實的可寫性探測（見 `app.ts` 的
 * `assertUploadsDirWritable`），只給路徑字串不建目錄的話，每一支整合測試都會在
 * `buildApp()` 那一步就同步 throw、當場全紅）。
 *
 * Teardown 契約比照 `freshDb()`：在 vitest test 內呼叫時用 `onTestFinished`
 * 自動遞迴刪除；不在 test context 內呼叫（理論上不會發生，本檔內部呼叫點皆在
 * `buildTestApp`/`buildCollabTestApp` 內，一律是 test 執行中）則靜默略過，
 * 呼叫方需自行清理。
 */
export function freshUploadsDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-"));
  try {
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  } catch {
    // 不在 test context 內——呼叫方需自行清理。
  }
  return dir;
}

// buildTestApp 用的固定測試設定：databaseUrl 只是通過 loadConfig 的格式驗證，實際的
// db 連線一律走 freshDb()（每個測試獨立、全新的資料庫），與這裡的 DATABASE_URL 無關。
// 匯出供需要簽發「真的能通過 buildTestApp() 那個 app 驗證」的 session cookie 的測試
// （例如 app.test.ts 的認證鏈測試）取用同一把 appSecret。
export const testConfig: AppConfig = loadConfig({
  DATABASE_URL: "postgres://u:p@localhost:5432/test",
  APP_SECRET: "a".repeat(64),
  PUBLIC_URL: "http://localhost:3000",
});

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  /** 實際掛進 app 的 uploadsDir（Task 10b）——測試用它直接檢查磁碟狀態（例如 413 不落檔、GET 磁碟無檔 404 的 fixture）。 */
  uploadsDir: string;
  /** 手動關閉底層 pool（非測試情境用）。在 test 內呼叫 buildTestApp() 不必自己叫這個——已用 onTestFinished 自動掛好（見 freshDb）。 */
  close: () => Promise<void>;
}

/**
 * 掛幾條只給測試用的探針路由，供需要驗證 `authenticate`/`requireAdmin` decorator
 * 實際生效（例如登入後憑 session cookie 通過）的整合測試共用——不屬於任何 production
 * 路由模組。`/__test/protected` 回傳 `request.user`；供各整合測試驗證登入簽發的
 * session cookie 真的能通過 `authenticate`。
 */
export function withTestRoutes(app: FastifyInstance): FastifyInstance {
  app.get("/__test/protected", { preHandler: app.authenticate }, async req => req.user);
  app.get("/__test/admin", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  app.get("/__test/throw", async () => {
    throw new Error("boom");
  });
  app.post("/__test/echo", async req => req.body);
  return app;
}

// AppDeps.limiters 的測試預設：**每次呼叫都建全新實例**（`FixedWindowLimiter` 內部狀態
// 是 in-memory Map，若在此改成 module-level 常數並跨測試共用，不同測試檔案／不同
// buildTestApp() 呼叫之間的請求計數會互相汙染——例如本檔 Task 4 的「61 次觸發 429」
// 測試會被同一份 map 上其他測試先前已消耗掉的計數影響，導致隨執行順序隨機紅綠。
// 數值沿用 `buildApp` 未收到 overrides 時的生產預設（見 `http/rate-limit.ts` 匯出的
// `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT`），讓測試環境的節流行為與生產一致。
//
// `overrides` 讓單一測試只換掉它要驗的那一顆桶（例如
// `{ bearerMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }`），不必手打
// 全部鍵——鍵數會隨 #132 再長，逐檔複製全鍵字面值就是下一次改桶時的多處漏改。
//
// ⚠ 呼叫端要傳「自己也是選配的」桶時**直接轉傳整包 overrides**，不要逐鍵展開成
// `{ publicMiss: overrides.publicMiss, … }`：沒被指定的鍵會拿到 explicit `undefined`
// 蓋掉這裡的預設值（tsconfig 沒開 `exactOptionalPropertyTypes`，TS 不擋），執行時是
// `undefined.consume`。
export function freshLimiters(
  overrides: Partial<NonNullable<AppDeps["limiters"]>> = {}
): NonNullable<AppDeps["limiters"]> {
  return {
    collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
    slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
    upload: new FixedWindowLimiter(UPLOAD_LIMIT),
    ai: new FixedWindowLimiter(AI_LIMIT),
    oidcLogin: new FixedWindowLimiter(OIDC_LIMIT),
    oidcCallback: new FixedWindowLimiter(OIDC_LIMIT),
    publicLink: new FixedWindowLimiter(PUBLIC_LINK_LIMIT),
    publicMiss: new FixedWindowLimiter(PUBLIC_MISS_LIMIT),
    publicNote: new FixedWindowLimiter(PUBLIC_NOTE_LIMIT),
    publicUpload: new FixedWindowLimiter(PUBLIC_UPLOAD_LIMIT),
    tokenRead: new FixedWindowLimiter(TOKEN_READ_LIMIT),
    tokenWrite: new FixedWindowLimiter(TOKEN_WRITE_LIMIT),
    bearerMiss: new FixedWindowLimiter(BEARER_MISS_LIMIT),
    patCreate: new FixedWindowLimiter(PAT_CREATE_LIMIT),
    ...overrides,
  };
}

/**
 * 建一個掛好預設 deps（freshDb + 真 UserGate/LoginThrottle + noop collab hooks）的
 * FastifyInstance，供整合測試使用。任何 deps 都可用 `overrides` 覆寫。
 *
 * **不呼叫 `initializeInstance`**（§14.2）——app 建構不需要初始化判斷，fail-fast 只在
 * `index.ts` 呼叫（production 啟動路徑）。整合測試一律直接 `db.insert(users)` 建帳
 * （既有慣例，見 `buildCollabTestApp` 的 `createUser`）。
 *
 * logger 預設關閉（測試輸出降噪），可用 `options.logger` 覆寫回開（例如要除錯某個
 * 測試的實際請求日誌時）。
 */
export async function buildTestApp(overrides: Partial<AppDeps> = {}, options: BuildAppOptions = {}): Promise<TestApp> {
  const { db, close } = await freshDb();
  const deps: AppDeps = {
    config: testConfig,
    db,
    gate: new UserGate(db),
    throttle: new LoginThrottle(),
    collabHooks: noopCollabHooks,
    limiters: freshLimiters(),
    uploadsDir: freshUploadsDir(),
    ai: createAiRuntime(),
    ...overrides,
  };
  const app = buildApp(deps, { logger: false, ...options });
  // 回傳 deps.db／deps.uploadsDir（而非上面本地變數）——若呼叫方透過 overrides
  // 換掉了它們，回傳值必須與 app 實際在用的一致，否則呼叫方用回傳值操作會跟 app
  // 內部狀態不同步。
  return { app, db: deps.db, uploadsDir: deps.uploadsDir, close };
}

// ───────────────────────────── 共編（Hocuspocus）測試 harness ─────────────────────────────
//
// 所有共編整合測試唯一的 harness。Task 5/6/7 一律「消費」以下這組介面，不得各自
// 再 roll 一套（造使用者、登入、建 provider、拆除的細節只在這裡有一份）。
//
// 與 `buildTestApp` 的差異：共編需要**真的 HTTP + WebSocket**（`app.inject` 不會真的
// listen，也沒有可 upgrade 的 socket），所以這裡一律 `app.listen({ port: 0 })` 起一個
// ephemeral port 的真 server，cookie 與 WS 同源。

/** 等待 provider 連上並完成首次 sync 的上限。逾時視為連線失敗（測試失敗，不靜默）。 */
const COLLAB_CONNECT_TIMEOUT_MS = 5_000;

export interface TestClient {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  /** 收到的應用層 CLOSE 事件記錄（server 端 `handle.close(reason)` 送出的 reason）。 */
  closes: Array<{ reason: string }>;
  /** 斷開這個 client（provider + 底層 socket 一起拆），server 端隨即走 onDisconnect。 */
  disconnect(): void;
}

export interface HttpSession {
  /** 自帶 cookie 與 `application/json` content-type 的 fetch（path 為 `/api/...`）。 */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * 連上 `/collab` 的某份 note，resolve 時已完成首次 sync。
   *
   * 預設的取 token 邏輯是 `POST /api/notes/:id/collab-token`（Task 4 契約，回應 body
   * `{ token, role }`）。
   * - `tokenOverride`：跳過該 endpoint 直接用指定字串當 token。Task 1 的 spike 必用
   *   （endpoint 尚不存在），N2 的「舊 token 重連」測試亦用它。
   * - `tokenFn`：完全取代預設邏輯（Task 6 的「token endpoint 5xx 不誤殺」以此模擬失敗）。
   *
   * **拒連即 reject**（onAuthenticate throw、或逾時未 sync），錯誤訊息含被拒原因；
   * reject 前會把 provider 拆掉，不會在測試剩餘時間裡持續重連。
   */
  connect(noteId: string, opts?: { tokenOverride?: string; tokenFn?: () => Promise<string> }): Promise<TestClient>;
}

/** `buildCollabTestApp` 收下來的一行 CollabServer 日誌。 */
export interface CollabLogLine {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

export interface CollabTestCtx {
  /** `http://127.0.0.1:<ephemeral port>` */
  baseUrl: string;
  app: FastifyInstance;
  collab: CollabServer;
  /**
   * CollabServer 寫出的日誌（issue #37 的握手拒絕訊號即在此）。注入自己的 logger 也順便
   * 讓拒連測試不再往 stdout 噴 `consoleCollabLogger` 的那一行。
   */
  collabLogs: CollabLogLine[];
  /**
   * 讓之後每一次 `gate.check` 都丟出這個錯——用來重現「onAuthenticate 撞到未預期例外」
   * （DB 抖動）那條路徑。⚠ `authenticate` 也走同一個 gate，破壞之後所有 REST 請求都會 500，
   * 所以一律在測試的最後一步才呼叫。
   */
  breakGate(err: Error): void;
  db: Db;
  createUser(opts: { email: string; password: string; isAdmin?: boolean }): Promise<{ id: string }>;
  createNote(ownerId: string, title?: string): Promise<{ id: string }>;
  share(noteId: string, userId: string, role: "editor" | "viewer"): Promise<void>;
  loginAs(email: string, password: string): Promise<HttpSession>;
  /** provider 全斷 → `collab.destroy()` → `app.close()`。冪等；已用 onTestFinished 自動掛好。 */
  destroy(): Promise<void>;
}

/**
 * 建一個掛上真 `CollabServer` 並實際 listen 的 app，供共編整合測試使用。
 *
 * `collabHooks` 是注入縫：預設 `noopCollabHooks`（比照 `buildTestApp`），Task 6 的撤權
 * 測試必須傳 `collabHooks: (server, log) => createCollabHooks(server, log)` 接真實作
 * （第二個參數是本 harness 的錄音 logger，`collabLogs` 才收得到 hooks 那邊的訊號）——否則
 * shares/disable/DELETE 那些呼叫點全是 no-op，撤權路徑永遠不會被觸發，測試會綠得毫無意義。
 */
export async function buildCollabTestApp(
  opts: { collabHooks?: (server: CollabServer, log: CollabHooksLogger) => CollabHooks } = {}
): Promise<CollabTestCtx> {
  const { db } = await freshDb();
  const gate = new UserGate(db);
  // 測試注入縫：見 `CollabTestCtx.breakGate`。包在 harness 裡（而不是每個測試各自 monkey-patch）
  // 是為了讓「怎麼弄壞 gate」只有一份定義。
  let gateError: Error | null = null;
  const realCheck = gate.check.bind(gate);
  gate.check = async (userId: string, tv: number) => {
    if (gateError) throw gateError;
    return realCheck(userId, tv);
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
  const collab = createCollabServer({ db, config: testConfig, gate, log: collabLog });

  const deps: AppDeps = {
    config: testConfig,
    db,
    gate,
    throttle: new LoginThrottle(),
    collabHooks: opts.collabHooks ? opts.collabHooks(collab, collabLog) : noopCollabHooks,
    collab,
    limiters: freshLimiters(),
    uploadsDir: freshUploadsDir(),
    ai: createAiRuntime(),
  };
  const app = buildApp(deps, { logger: false });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("app.listen 後取不到 TCP 位址——共編 harness 需要真的 port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const collabUrl = `ws://127.0.0.1:${address.port}${COLLAB_PATH}`;

  // 追蹤所有建出來的 client：destroy() 必須先把 provider 全數拆掉，否則它們會在
  // server 關閉後持續嘗試重連，讓 vitest 卡在「還有未結束的 handle」。
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

  // 比照 freshDb()：即使斷言失敗（test 拋出）也要拆掉，不洩漏 listening socket。
  try {
    onTestFinished(destroy);
  } catch {
    // 不在 test context 內——呼叫方需自行呼叫回傳的 destroy()。
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
    // title 未帶時完全不放進 values，讓 schema 的 default "Untitled" 生效（同 POST /api/notes）。
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
    // getSetCookie() 才拿得到多筆 Set-Cookie（headers.get 會把它們併成一個字串）。
    const cookie = res.headers
      .getSetCookie()
      .map(one => one.split(";")[0])
      .join("; ");

    const session: HttpSession = {
      async fetch(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        // 只在真的帶 body 時預設 content-type：Fastify 對「Content-Type: application/json
        // 但 body 是空字串」的請求會直接回 400（FST_ERR_CTP_EMPTY_JSON_BODY，Fastify 內建
        // 行為，非 app.ts 的 415 守衛）——`POST /api/notes/:id/collab-token`、
        // `DELETE /api/notes/:id/shares/:userId` 這類無 body 的路由若被硬塞這個 header
        // 會在還沒進到 app.ts 的路由處理常式前就被 Fastify 自己的 JSON body parser 擋下。
        if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
        return fetch(`${baseUrl}${path}`, { ...init, headers });
      },

      async connect(noteId, connectOpts = {}): Promise<TestClient> {
        const token =
          connectOpts.tokenFn ??
          (connectOpts.tokenOverride !== undefined
            ? connectOpts.tokenOverride
            : async (): Promise<string> => {
                const tokenRes = await session.fetch(`/api/notes/${noteId}/collab-token`, { method: "POST" });
                if (!tokenRes.ok) {
                  throw new Error(`取得 collab token 失敗（${tokenRes.status}）：${await tokenRes.text()}`);
                }
                const body = (await tokenRes.json()) as { token: string; role: Role };
                return body.token;
              });

        const doc = new Y.Doc();
        const closes: Array<{ reason: string }> = [];

        // 每個 client 一條自己的 socket（而非共用一條做 multiplex）：如此
        // socketId 與 client 一對一，`connectionsOf`／`connectionsOfNote` 的增減斷言
        // 才對得上「幾個 client 在線」這個直覺。
        const socket = new HocuspocusProviderWebsocket({ url: collabUrl, WebSocketPolyfill: WsWebSocket });
        const provider = new HocuspocusProvider({
          websocketProvider: socket,
          name: noteId,
          document: doc,
          token,
          // onClose 同時接到兩種事件：server 端 `handle.close(reason)` 送來的「應用層
          // CLOSE 訊息」（帶我們指定的 reason），以及底層 socket 真的關閉。只記錄前者
          // ——socket 層的關閉 reason 一律是空字串（唯一例外是 harness 自己在 destroy()
          // 送的 "server shutdown"，那已在斷言之後）。
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
            // 明確傳了 websocketProvider 時 provider.destroy() 不會連 socket 一起收，
            // 得自己拆掉，否則它會持續依 reconnect 策略重連。
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

        // ⚠ 明確傳 `websocketProvider` 時 HocuspocusProvider 不會自己 attach（建構子只在
        // 「自己建 socket」的情境呼叫 attach）——少了這行，provider 永遠不會送出 auth
        // 訊息，連線就只是靜靜地卡在未同步狀態。這是 v4 多工（一條 socket 掛多個
        // provider）API 的既定用法。
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

  return { baseUrl, app, collab, collabLogs, breakGate, db, createUser, createNote, share, loginAs, destroy };
}
