import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { asc, sql } from "drizzle-orm";
import type { AdminAuthProviderDto, AuthProviderTemplate } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { authProviders } from "../db/schema.js";
import { createProviderSchema, sendInvalidBody } from "../auth/admin-provider-input.js";
import { oidcRedirectUri, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { sealClientSecret } from "../auth/oidc-providers.js";
import { adminProviderColumns, type AdminProviderRow } from "../auth/tx/admin-auth-providers.js";

export interface AdminAuthRouteDeps {
  db: Db;
  config: AppConfig;
  /** PATCH／DELETE 後 `invalidate`（§9.2）；test／discover 用 `probe`（不經快取）。與登入路由同一個 per-app 實例。 */
  registry: OidcRuntimeRegistry;
}

const INSECURE_ISSUER_LOG = "登入服務的 issuer 是明文 http（§5.3）";

function toAdminProviderDto(row: AdminProviderRow, config: AppConfig): AdminAuthProviderDto {
  return {
    id: row.id,
    template: row.template as AuthProviderTemplate,
    displayName: row.displayName,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    hasSecret: row.hasSecret,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    legacyCallback: row.legacyCallback,
    callbackUrl: oidcRedirectUri(config, row),
    // CHECK 保證 scheme 是小寫 http:// 或 https://（0014 `auth_providers_issuer_url_chk`）。
    insecureIssuer: row.issuerUrl.startsWith("http://"),
    issuerResolved: row.issuerResolved,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * #187 PR2：站台管理的登入服務 API（spec §9.2；`/api/admin/auth/settings` 是 PR3）。全部 `requireAdmin`；HTTP 層訊息中文。
 * 停用、刪除都不撤 session（Q5）。
 */
export function adminAuthRoutes(deps: AdminAuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/auth/providers", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db
        .select(adminProviderColumns())
        .from(authProviders)
        .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
      return { providers: rows.map(row => toAdminProviderDto(row, deps.config)) };
    });

    app.post("/api/admin/auth/providers", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createProviderSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const { template, displayName, issuerUrl, clientId, clientSecret } = parsed.data;
      // id 先產：密文的 AAD 綁 providerId（§5.1），加密當下就要知道 id。建立時一律停用（§9.2）——要先測試再啟用。
      const id = randomUUID();
      const clientSecretEncrypted = clientSecret !== undefined ? sealClientSecret(deps.config.appSecret, id, clientSecret) : null;
      const [row] = await deps.db
        .insert(authProviders)
        .values({
          id,
          template,
          displayName,
          issuerUrl,
          clientId,
          clientSecretEncrypted,
          enabled: false,
          // 新服務排最後（併發建立時可能同值——再以 createdAt、id 排，無害）。上限 100000＝PATCH 的 `sortOrder` 上限（gate r1-t1-7 M1：
          // 否則最大值已是 100000 時新列得 100001，之後編輯表單每次帶 sortOrder 都被 400）。
          sortOrder: sql`(select least(coalesce(max(${authProviders.sortOrder}), -1) + 1, 100000) from ${authProviders})`,
        })
        .returning(adminProviderColumns());
      if (row!.issuerUrl.startsWith("http://")) request.log.warn({ providerId: id }, INSECURE_ISSUER_LOG);
      return reply.code(201).send(toAdminProviderDto(row!, deps.config));
    });
  };
}
