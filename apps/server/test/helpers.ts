import { randomBytes } from "node:crypto";
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
import { COLLAB_TOKEN_LIMIT, FixedWindowLimiter, SLUG_PATCH_LIMIT } from "../src/http/rate-limit.js";
import { hashPassword } from "../src/auth/password.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import { COLLAB_PATH, createCollabServer, type CollabServer } from "../src/collab/server.js";
import { notes, noteShares, users } from "../src/db/schema.js";
import { SetupState } from "../src/auth/setup.js";

export interface FreshDb {
  db: Db;
  pool: Pool;
  /** 手動關閉 pool（非測試情境用）。在 test 內呼叫 freshDb() 不必自己叫這個——已用 onTestFinished 自動掛好。 */
  close: () => Promise<void>;
}

/**
 * 建一個全新的 database（隨機名）並跑完整 migration。
 *
 * 刻意不用「DROP SCHEMA public CASCADE; CREATE SCHEMA public」——drizzle 的 migration
 * journal 存在 `drizzle` schema，砍掉 public 後 drizzle 仍以為所有 migration 都跑過，
 * 第二次 migrate 會靜默跳過建表（journal 與實際表結構不同步）。用隨機名 CREATE DATABASE
 * 保證每個測試都是全新、乾淨、journal 與表結構一致的資料庫。
 *
 * Teardown 契約：在 vitest test 內呼叫時，用 `onTestFinished` 自動清理 pool——
 * 即使斷言失敗（test 拋出）也會執行，不會洩漏連線。同時回傳 `close()`
 * 供非 test context（例如手動除錯腳本）自行呼叫。兩者皆冪等（多次呼叫安全）。
 */
export async function freshDb(): Promise<FreshDb> {
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
  await runMigrations(db);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await pool.end();
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
  /** 實際掛進 app 的 setupState（預設是真 SetupState.init 的結果）——測試用它讀 `.token`，不必去 parse log。 */
  setupState: SetupState;
  /** 手動關閉底層 pool（非測試情境用）。在 test 內呼叫 buildTestApp() 不必自己叫這個——已用 onTestFinished 自動掛好（見 freshDb）。 */
  close: () => Promise<void>;
}

/**
 * 掛幾條只給測試用的探針路由，供需要驗證 `authenticate`/`requireAdmin` decorator
 * 實際生效（例如登入後憑 session cookie 通過）的整合測試共用——不屬於任何 production
 * 路由模組。`/__test/protected` 回傳 `request.user`；setup.test.ts 用它驗證
 * `POST /api/setup` 簽發的 session cookie 真的能通過 `authenticate`。
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
function freshLimiters(): NonNullable<AppDeps["limiters"]> {
  return {
    collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
    slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
  };
}

// buildTestApp 預設用的 SetupState logger：不印任何東西（測試輸出降噪）。要斷言
// `log.info` 呼叫格式（`Setup token: <64hex>`）的測試，自行呼叫 `SetupState.init(db, spyLogger)`
// 拿到帶 spy 的實例，再透過 `overrides.setupState` 傳入——不透過這個預設值。
const silentSetupLogger = { info: () => {} };

/**
 * 建一個掛好預設 deps（freshDb + 真 UserGate/LoginThrottle + noop collab hooks + 真
 * SetupState）的 FastifyInstance，供整合測試使用。任何 deps 都可用 `overrides` 覆寫。
 *
 * logger 預設關閉（測試輸出降噪），可用 `options.logger` 覆寫回開（例如要除錯某個
 * 測試的實際請求日誌時）。
 */
export async function buildTestApp(overrides: Partial<AppDeps> = {}, options: BuildAppOptions = {}): Promise<TestApp> {
  const { db, close } = await freshDb();
  // 預設 setupState 要對「overrides 換掉的 db」（若有）建立，而非永遠對 freshDb() 的
  // 原始 db 建立——否則兩者不同步時，setupState 查到的 instance_setup 狀態會跟 app
  // 實際在用的 db 對不上。
  const effectiveDb = overrides.db ?? db;
  const deps: AppDeps = {
    config: testConfig,
    db,
    gate: new UserGate(db),
    throttle: new LoginThrottle(),
    collabHooks: noopCollabHooks,
    setupState: await SetupState.init(effectiveDb, silentSetupLogger),
    limiters: freshLimiters(),
    ...overrides,
  };
  const app = buildApp(deps, { logger: false, ...options });
  // 回傳 deps.db／deps.setupState（而非上面本地變數）——若呼叫方透過 overrides 換掉了
  // 它們，回傳值必須與 app 實際在用的一致，否則呼叫方用回傳值操作會跟 app 內部狀態不同步。
  return { app, db: deps.db, setupState: deps.setupState, close };
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

export interface CollabTestCtx {
  /** `http://127.0.0.1:<ephemeral port>` */
  baseUrl: string;
  app: FastifyInstance;
  collab: CollabServer;
  db: Db;
  setupState: SetupState;
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
 * 測試必須傳 `collabHooks: server => createCollabHooks(server)` 接真實作——否則
 * shares/disable/DELETE 那些呼叫點全是 no-op，撤權路徑永遠不會被觸發，測試會綠得毫無意義。
 */
export async function buildCollabTestApp(
  opts: { collabHooks?: (server: CollabServer) => CollabHooks } = {}
): Promise<CollabTestCtx> {
  const { db } = await freshDb();
  const gate = new UserGate(db);
  const collab = createCollabServer({ db, config: testConfig, gate });

  const deps: AppDeps = {
    config: testConfig,
    db,
    gate,
    throttle: new LoginThrottle(),
    collabHooks: opts.collabHooks ? opts.collabHooks(collab) : noopCollabHooks,
    collab,
    setupState: await SetupState.init(db, silentSetupLogger),
    limiters: freshLimiters(),
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
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
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

  return { baseUrl, app, collab, db, setupState: deps.setupState, createUser, createNote, share, loginAs, destroy };
}
