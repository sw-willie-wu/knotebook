import type { FastifyError, FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import type { AppConfig } from "../config.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { sendOauthError } from "../http/oauth-errors.js";

export interface OauthRouteDeps {
  db: Db;
  config: AppConfig;
  limiters: { dcr: FixedWindowLimiter; authorize: FixedWindowLimiter; tokenEndpoint: FixedWindowLimiter };
}

/**
 * 兩個 RFC 形 plugin 共用的 error／notFound handler（§5.0）。
 *
 * ⚠ **只能在帶 prefix 的封裝 plugin 內呼叫**：root 的 `setNotFoundHandler` 由
 * `http/spa.ts` 獨佔，無 prefix 的 plugin 再呼叫一次會開機即崩。
 */
export function registerRfcErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // statusCode 要保留：formbody 的 415 就是 415，不可退化成 500。
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error, authKind: request.authKind }, "oauth endpoint error");
      return sendOauthError(reply, 500, "server_error", "伺服器內部錯誤");
    }
    // §5.0 的映射表只列 415／400／404／405，都歸 invalid_request；今天沒有路由會丟
    // 401／403／429（那些是 handler 直送），有的話這裡要先補碼再改。
    return sendOauthError(reply, status, "invalid_request", error.message || "請求錯誤");
  });

  // RFC 沒有 not_found 碼，用 invalid_request 加說明。
  app.setNotFoundHandler(async (_request, reply) => sendOauthError(reply, 404, "invalid_request", "unknown endpoint"));
}

/**
 * `/oauth` 前綴 plugin（§5.2–§5.4）。RFC 形錯誤 body 是全站唯一例外，理由與錯誤映射
 * 見 `http/oauth-errors.ts`（docs/api.md 的對應說明在文件那一棒補）。
 */
export function oauthRoutes(deps: OauthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    registerRfcErrorHandlers(app);
    void deps; // 路由在後續 task 加入
  };
}
