import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { verifySession, type GateUser, type UserGate } from "./auth/session.js";
import type { LoginThrottle } from "./auth/rate-limit.js";
import type { CollabHooks } from "./collab/hooks.js";
import type { SetupState } from "./auth/setup.js";
import { setupRoutes } from "./routes/setup.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    user?: GateUser;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
  setupState: SetupState;
}

export interface BuildAppOptions {
  /**
   * 覆寫 fastify logger 設定。預設 true——production（`src/index.ts`）需要它印出
   * Task 8 `SetupState.init` 的 Setup token（第三輪審查附錄事項 7）。測試環境
   * （`test/helpers.ts` 的 `buildTestApp`）預設關閉以降低雜訊，可再覆寫回開。
   */
  logger?: boolean;
}

const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// export：唯一定義處，routes/setup.ts（以及後續 Task 9/10/12 的路由）改從這裡 import，
// 不要各自重複宣告同樣的 `{ error: { code, message } }` 包裝。
//
// 這造成 app.ts ↔ routes/setup.ts 的循環 import（app.ts import setupRoutes；
// routes/setup.ts import sendError）——這是安全的：兩邊互相 import 的都是具名
// `function` 宣告（不是 `const`/箭頭函式），ESM 模組連結階段會先把 function
// 宣告整個 hoist 完成，才開始執行任何模組的頂層程式碼，所以無論哪個檔案先被
// import，對方需要的具名函式在那個時間點都已經可用。若之後要把 `sendError`
// 或 `setupRoutes` 改寫成 `const foo = (...) => {...}` 這種形式，這個安全性
// 假設就不成立了（會變成暫時性死區、循環 import 的那一側讀到 undefined）——
// 要嘛維持 function 宣告，要嘛把 `sendError` 抽到一個不被 routes/* 依賴的
// 第三方模組，兩邊都改成從那個模組 import。
export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}

/** 4xx 錯誤碼映射：已知的具體碼優先，其餘 4xx 一律歸類 bad_request（不可吞成 500）。 */
function clientErrorCode(statusCode: number): string {
  if (statusCode === 415) return "unsupported_media_type";
  return "bad_request";
}

/**
 * Fastify app 工廠：掛好 cookie 解析、統一錯誤格式（含 404/415/4xx/500）、認證/授權
 * decorator（`authenticate`/`requireAdmin`）與 `/healthz`。路由本身由後續 task
 * （Task 8/9/10/12）以 `app.register(...)` 掛進來——本 task 只建骨架與接縫。
 */
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });

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

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, "not_found", "找不到此路由");
  });

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
