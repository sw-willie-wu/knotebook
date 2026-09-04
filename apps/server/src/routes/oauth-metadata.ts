import type { FastifyInstance } from "fastify";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { canonicalResource } from "../oauth/resource.js";
import { registerRfcErrorHandlers } from "./oauth.js";

/**
 * `/.well-known` 前綴 plugin（§5.1）。兩條無認證 GET，快取 1 小時。
 *
 * **不提供根形 PRM**：RFC 9728 §3.3 要求 `resource` 等於「插入 well-known 後綴以組出
 * 該 URL 的 resource identifier」，根形即 origin，與 D11 的 `/api/mcp` 衝突。
 */
export function oauthMetadataRoutes(deps: { config: AppConfig }) {
  return async function register(app: FastifyInstance): Promise<void> {
    registerRfcErrorHandlers(app);
    const issuer = publicUrlIssuer(deps.config.publicUrl);

    app.get("/oauth-protected-resource/api/mcp", async (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send({
        resource: canonicalResource(issuer),
        authorization_servers: [issuer],
        scopes_supported: ["notes:read", "notes:write"],
        bearer_methods_supported: ["header"],
        resource_name: "Knotebook",
      })
    );

    app.get("/oauth-authorization-server", async (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["notes:read", "notes:write"],
        authorization_response_iss_parameter_supported: true,
      })
    );
  };
}
