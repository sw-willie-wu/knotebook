import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { OidcRedirectDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { userIdentities } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { UUID_RE } from "../notes/service.js";
import type { OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { loadEnabledProvider, providerConfiguration } from "../auth/oidc-providers.js";
import { setOidcStateCookie, startAuthorization } from "../auth/oidc-authorize.js";

export interface OidcLinkRouteDeps {
  db: Db;
  config: AppConfig;
  registry: OidcRuntimeRegistry;
  limiters: { oidcLogin: FixedWindowLimiter };
}

/** B7：一律要求 JSON body（`{}`，strict）——CSRF hook 只擋「帶 body 且非 JSON」，無 body 的 POST 會被放行，所以這裡要 body。 */
const linkBodySchema = z.object({}).strict();

/**
 * #187 §7.6：設定頁的手動連結起點。session-only（`app.authenticate` 只認 cookie；Bearer → 401）。回 `{url}`，前端
 * `location.assign`——不開「有副作用的 GET」。callback 在 `routes/oidc.ts` 的 `intent: "link"` 分支。
 */
export function oidcLinkRoutes(deps: OidcLinkRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post<{ Params: { providerId: string } }>("/api/auth/oidc/link/:providerId", { preHandler: app.authenticate }, async (request, reply) => {
      if (!linkBodySchema.safeParse(request.body).success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      // 臨時密碼還沒換掉的帳號不准連（比照建 PAT：擋在限流之前，被擋的請求不吃額度）。
      if (request.user!.mustChangePassword) return sendError(reply, 403, "forbidden", "請先修改密碼");
      if (!deps.limiters.oidcLogin.consume(request.ip)) return sendError(reply, 429, "too_many_requests", "請求太頻繁，請稍後再試");
      const raw = request.params.providerId;
      const provider = UUID_RE.test(raw) ? await loadEnabledProvider(deps.db, raw.toLowerCase()) : null;
      if (provider === null) return sendError(reply, 404, "provider_not_found", "找不到這個登入服務，或它目前未啟用");
      // 預檢（權威判斷在 callback 的鎖內）：本人已有 issuer＝其 effective issuer 的身分。
      const effectiveIssuer = provider.resolvedIssuer ?? provider.issuerUrl;
      const [existing] = await deps.db
        .select({ id: userIdentities.id })
        .from(userIdentities)
        .where(and(eq(userIdentities.userId, request.user!.id), eq(userIdentities.issuer, effectiveIssuer)))
        .limit(1);
      if (existing !== undefined) return sendError(reply, 409, "identity_already_linked", "你已經連結過這個登入服務");
      let url: URL;
      try {
        const configuration = await providerConfiguration({ db: deps.db, registry: deps.registry, appSecret: deps.config.appSecret, log: request.log }, provider);
        const started = await startAuthorization(deps.config, provider, configuration, { intent: "link", linkUserId: request.user!.id });
        setOidcStateCookie(reply, deps.config, started.sealedState);
        url = started.url;
      } catch (err) {
        request.log.warn({ err, providerId: provider.id }, "手動連結起點：discovery 不可用");
        return sendError(reply, 503, "oidc_unavailable", "登入服務目前無法使用，請稍後再試");
      }
      const body: OidcRedirectDto = { url: url.href };
      return reply.send(body);
    });
  };
}
