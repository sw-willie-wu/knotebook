import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { SESSION_COOKIE, type ErrorCode } from "@knotebook/shared";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { verifySession, type GateUser, type UserGate } from "./auth/session.js";
import type { LoginThrottle } from "./auth/rate-limit.js";
import type { CollabHooks } from "./collab/hooks.js";
import type { CollabServer } from "./collab/server.js";
import type { SetupState } from "./auth/setup.js";
import { setupRoutes } from "./routes/setup.js";
import { authRoutes } from "./routes/auth.js";
import { notesRoutes } from "./routes/notes.js";
import type { WriteNoteLinksHooks } from "./notes/links.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { sendError } from "./http/errors.js";
import { COLLAB_TOKEN_LIMIT, FixedWindowLimiter, SLUG_PATCH_LIMIT } from "./http/rate-limit.js";
import { registerSpaFallback } from "./http/spa.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    user?: GateUser;
    /**
     * `authenticate` 通過時一併記下當次 session JWT 的 `tv`（與 `request.user` 同時
     * 設定，見下方 decorator）——`POST /api/notes/:id/collab-token`（Task 4）簽發
     * collab token 時需要它塞進 `CollabTokenClaims.tv`，但 `GateUser`（`gate.check`
     * 的回傳形狀）本身不帶 tv，故另開這個欄位，不擴充 `GateUser` 型別本身。
     */
    sessionTv?: number;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
  /**
   * 即時協作（Hocuspocus）server。**選配**：不傳就不掛 `/collab`，一般 REST 測試
   * （`buildTestApp`）與只跑 REST 的情境完全不受影響；傳入時 `buildApp` 會把它的
   * WebSocket upgrade handler 掛上本 app 的底層 http server。
   */
  collab?: CollabServer;
  setupState: SetupState;
  /**
   * per-user 固定視窗節流器（Task 4：collab-token；Task 8：slug PATCH）。**選配**：
   * `index.ts` 的 `AppDeps` 物件字面值不在 Task 4 的 Files 內，必填會讓 Task 4–6 之間
   * `pnpm -r build` 全紅（vitest 不做型檢，會綠色假象）。未傳時 `buildApp` 內建生產
   * 預設（見 `COLLAB_TOKEN_LIMIT`/`SLUG_PATCH_LIMIT`，`http/rate-limit.ts`）。
   *
   * `buildTestApp`/`buildCollabTestApp`（`test/helpers.ts`）每次呼叫一律注入**全新
   * 實例**——嚴禁 module 單例，否則不同測試檔案共享同一份計數會互相汙染。
   */
  limiters?: { collabToken: FixedWindowLimiter; slugPatch: FixedWindowLimiter };
  /**
   * Task 5：`POST /api/notes/:id/links` 寫入函式（`notes/links.ts` 的 `writeNoteLinks`）的
   * 測試注入縫，透傳進 `NotesRouteDeps`。**選配**：production／未覆寫時整段為
   * `undefined`，`writeNoteLinks` 的 `hooks` 參數預設 `{}`，等同 no-op。整合測試唯一的
   * 注入面是 `buildTestApp({ linkSyncTestHooks })`——route deps 本身不對外暴露，不開這個
   * `AppDeps` 欄位測試就碰不到 `beforeLinkWrite`（見 links.ts 的 FK race 測試注入縫說明）。
   */
  linkSyncTestHooks?: WriteNoteLinksHooks;
}

export interface BuildAppOptions {
  /**
   * 覆寫 fastify logger 設定。預設 true——production（`src/index.ts`）需要它印出
   * Task 8 `SetupState.init` 的 Setup token（第三輪審查附錄事項 7）。測試環境
   * （`test/helpers.ts` 的 `buildTestApp`）預設關閉以降低雜訊，可再覆寫回開。
   */
  logger?: boolean;
  /**
   * 前端建置產物目錄的絕對路徑（Task 9，spec §11.5 SPA fallback）。傳入時掛
   * `@fastify/static` 服務 `/assets/*` 等實際存在的檔案，並讓未命中路由的 GET/HEAD
   * （非 `/api`／`/collab`／`/healthz`／`/assets` 前綴、Accept 含 `text/html`）回
   * `index.html`；不傳（或 production `src/index.ts` 啟動檢查發現目錄不存在）時，
   * 未命中路由一律維持既有 JSON 404，行為與加這個 task 之前完全相同。見 `http/spa.ts`。
   */
  webDist?: string;
}

const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// `sendError` 定義於 `./http/errors.js`（不被任何 routes/* 依賴的葉節點模組），
// app.ts 與各路由模組（setup.ts、auth.ts、…）都從那裡 import，不在此重新宣告——
// 避免 app.ts ↔ routes/* 之間的循環 import（前幾輪曾靠「具名 function 宣告會被
// ESM 整個 hoist」規避，現在直接消除循環，不用再依賴那個前提）。

/** 4xx 錯誤碼映射：已知的具體碼優先，其餘 4xx 一律歸類 bad_request（不可吞成 500）。 */
function clientErrorCode(statusCode: number): ErrorCode {
  if (statusCode === 415) return "unsupported_media_type";
  return "bad_request";
}

/**
 * Fastify app 工廠：掛好 cookie 解析、統一錯誤格式（含 404/415/4xx/500）、認證/授權
 * decorator（`authenticate`/`requireAdmin`）與 `/healthz`。路由本身由後續 task
 * （Task 8/9/10/12）以 `app.register(...)` 掛進來——本 task 只建骨架與接縫。
 */
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  // maxParamLength 預設 100：find-my-way 是量「解碼後」的 UTF-16 code unit 數，跟
  // `titleSlug`／`validateSlug` 量的是 code point 數（60／100）不是同一把尺——
  // astral 字元（例如 𠮷）解碼後是 2 個 UTF-16 unit，60 個 astral 字算下來就破百，
  // 會讓 `canonicalNotePath` 組出的 `<vanity>-<uuid>` ref 在路由層直接被 find-my-way
  // 拒絕（414 URI Too Long，連 handler 都不會被呼叫，見 notes-slug.test.ts 的 astral
  // 標題 regression test 實測）。512 給足與 slug 上限的落差當緩衝，不必跟著 slug 規則
  // 同步微調。必須放進 `routerOptions`，不能當 Fastify 建構子的頂層選項——頂層
  // `maxParamLength` 是 deprecated 寫法（FSTDEP022），fastify@6 會整個移除，屆時會
  // 靜默退回預設值 100，等於這個修正自己失效又不出任何警告；`routerOptions` 這個
  // 寫法才是不會過期、也不會印 deprecation warning 的形式。
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true, routerOptions: { maxParamLength: 512 } });

  // 不用 secret：session 是自帶簽章的 JWT，cookie 本身不需要再簽一次。
  void app.register(fastifyCookie);

  // 全域 onRequest hook：只要有呼叫 setNotFoundHandler，onRequest 就會對「未匹配路由」
  // 也執行（fastify#3120 結論）——不可把這段邏輯改掛進 setNotFoundHandler 的 options，
  // 其只接受 preValidation/preHandler，掛 onRequest 會直接報錯。
  app.addHook("onRequest", async (request, reply) => {
    if (!CHANGE_METHODS.has(request.method)) return;

    // 有 body 的判定：content-length 存在且非 0，或用 chunked transfer-encoding
    // （這種請求沒有 content-length，但仍然帶 body，必須視為「有 body」）。
    // 無 body 的變更請求（例如 POST /logout 不帶 Content-Type/body）則放行——
    // 不能對這類請求一律要求 application/json。
    const transferEncoding = request.headers["transfer-encoding"];
    const contentLength = request.headers["content-length"];
    const hasBody = transferEncoding !== undefined || (contentLength !== undefined && contentLength !== "0");
    if (!hasBody) return;

    // MIME essence 等值比對（忽略 `;charset=...` 等參數）——不可用 substring
    // includes：`text/plain;charset=application/json` 是 CORS-safelisted 的
    // Content-Type，若用 includes 會被誤判為合法 JSON 請求而放行，等於繞過守衛。
    // PLAN3: multipart 豁免時改驗 Origin header（spec §3 CSRF）
    const contentType = request.headers["content-type"];
    const essence = contentType?.split(";")[0]?.trim().toLowerCase();
    if (essence !== "application/json") {
      return sendError(reply, 415, "unsupported_media_type", "此請求需要 application/json");
    }
  });

  // 以下兩個 decorator 都以一般具名函式（而非箭頭函式綁 this）宣告，但內部完全不用
  // `this`——`requireAdmin` 呼叫 `authenticate` 是透過閉包捕捉的外層 `app` 變數，
  // 不依賴 fastify 呼叫時的 this 綁定，故用 `app.authenticate(...)`／
  // `app.requireAdmin(...)`（或當作 preHandler 傳給其他路由）皆可正確運作。
  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await verifySession(deps.config.appSecret, token) : null;
    if (!session) {
      sendError(reply, 401, "unauthorized", "未登入");
      return;
    }
    const result = await deps.gate.check(session.userId, session.tv);
    if (result.status !== "ok") {
      sendError(reply, 401, "unauthorized", "未登入");
      return;
    }
    request.user = result.user;
    request.sessionTv = session.tv;
  });

  app.decorate("requireAdmin", async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.user?.isAdmin) {
      sendError(reply, 403, "forbidden", "需要管理員權限");
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  void app.register(setupRoutes({ db: deps.db, config: deps.config, setupState: deps.setupState }));
  void app.register(
    authRoutes({ db: deps.db, config: deps.config, gate: deps.gate, throttle: deps.throttle, collabHooks: deps.collabHooks })
  );
  // 未收到 AppDeps.limiters 時的生產預設（`buildTestApp`/`buildCollabTestApp` 一律自己
  // 注入全新實例，不會走到這裡；見 AppDeps.limiters 的說明）。
  const limiters =
    deps.limiters ??
    ({
      collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
      slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
    } satisfies NonNullable<AppDeps["limiters"]>);

  void app.register(
    notesRoutes({ db: deps.db, collabHooks: deps.collabHooks, config: deps.config, limiters, linkSyncTestHooks: deps.linkSyncTestHooks })
  );
  void app.register(adminUsersRoutes({ db: deps.db, gate: deps.gate, collabHooks: deps.collabHooks }));

  // 共編的 WebSocket 掛在底層 http server 的 upgrade 事件上，不經 Fastify 路由——
  // 因此與上面的路由註冊順序無關，也不會被 setNotFoundHandler／SPA fallback 攔到。
  deps.collab?.attach(app);

  // 擴充既有的 setNotFoundHandler（不是另開路由）：webDist 未傳時完全等同原本的
  // 純 JSON 404；傳入時額外處理 SPA fallback（見 registerSpaFallback 內的完整說明）。
  registerSpaFallback(app, options.webDist);

  // 4xx 不可吞成 500：fastify 內建錯誤（如壞 JSON body 的 FST_ERR_CTP_INVALID_JSON_BODY）
  // 帶有正確的 statusCode（400），只是訊息格式不是我們的統一格式；這裡沿用該
  // statusCode 並映射成對應的 code。只有 >=500（真正的伺服器端例外）才記錄
  // log.error 並回覆不洩漏細節的 `internal`。
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return sendError(reply, 500, "internal", "伺服器內部錯誤");
    }
    return sendError(reply, status, clientErrorCode(status), error.message || "請求錯誤");
  });

  return app;
}
