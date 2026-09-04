import { randomBytes } from "node:crypto";
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.js";
import type { AppConfig } from "../config.js";
import { oauthClients } from "../db/schema.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { sendOauthError } from "../http/oauth-errors.js";
import { isLoopbackRedirectUri } from "../oauth/redirect.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { DEFAULT_CLIENT_NAME, hasUnsafeClientNameChar } from "../oauth/client-name.js";

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
 * 只挑我們認得的欄位（zod 預設 strip 其餘）——RFC 7591 允許 AS 忽略不支援的 metadata，
 * 回應也不回聲，client 依回應為準。
 */
const registerBodySchema = z.object({
  // trim 比照 `routes/api-tokens.ts` 的 name：全空白的名稱同樣是同意頁的視覺洞
  client_name: z.string().trim().min(1).max(64).optional(),
  redirect_uris: z.array(z.string().max(512)).min(1).max(8),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  application_type: z.string().optional(),
});

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/**
 * `/oauth` 前綴 plugin（§5.2–§5.4）。RFC 形錯誤 body 是全站唯一例外，理由與錯誤映射
 * 見 `http/oauth-errors.ts`（docs/api.md 的對應說明在文件那一棒補）。
 */
export function oauthRoutes(deps: OauthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    registerRfcErrorHandlers(app);

    app.post("/register", async (request, reply) => {
      if (!deps.limiters.dcr.consume(request.ip)) {
        return sendOauthError(reply, 429, "invalid_request", "註冊次數過多，請稍後再試");
      }

      const parsed = registerBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const aboutRedirect = parsed.error.issues.some(issue => issue.path[0] === "redirect_uris");
        return sendOauthError(
          reply,
          400,
          aboutRedirect ? "invalid_redirect_uri" : "invalid_client_metadata",
          aboutRedirect ? "redirect_uris 格式不正確" : "client metadata 格式不正確"
        );
      }
      const body = parsed.data;

      // D10：無認證的 DCR 若收遠端 redirect，任何人都能註冊好聽的名字做一鍵釣魚。
      if (!body.redirect_uris.every(isLoopbackRedirectUri)) {
        return sendOauthError(
          reply,
          400,
          "invalid_redirect_uri",
          "redirect_uri 必須是 loopback 位址，且不含 query、fragment 或帳密"
        );
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        return sendOauthError(reply, 400, "invalid_client_metadata", "只支援 token_endpoint_auth_method=none");
      }
      if (
        body.grant_types !== undefined &&
        !body.grant_types.every(grant => (SUPPORTED_GRANT_TYPES as readonly string[]).includes(grant))
      ) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "不支援的 grant_types");
      }
      if (body.response_types !== undefined && (body.response_types.length !== 1 || body.response_types[0] !== "code")) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "只支援 response_types=[code]");
      }
      const clientName = body.client_name ?? DEFAULT_CLIENT_NAME;
      if (hasUnsafeClientNameChar(clientName)) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "client_name 含不允許的控制字元");
      }

      await runOauthCleanup(deps.db);

      const clientId = randomBytes(16).toString("base64url");
      const [row] = await deps.db
        .insert(oauthClients)
        .values({ clientId, clientName, redirectUris: body.redirect_uris })
        .returning();

      return reply.code(201).header("cache-control", "no-store").header("pragma", "no-cache").send({
        client_id: row!.clientId,
        client_name: row!.clientName,
        redirect_uris: row!.redirectUris,
        grant_types: [...SUPPORTED_GRANT_TYPES],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
      });
    });
  };
}
