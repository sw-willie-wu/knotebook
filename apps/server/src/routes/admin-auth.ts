import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { asc, sql } from "drizzle-orm";
import type { AdminAuthProviderDto, AuthProviderTemplate } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { authProviders } from "../db/schema.js";
import { checkViolationConstraint } from "../db/pg-errors.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { safeTarget } from "../lib/safe-target.js";
import { UUID_RE } from "../notes/service.js";
import { createProviderSchema, patchProviderSchema, sendInvalidBody } from "../auth/admin-provider-input.js";
import { oidcRedirectUri, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { sealClientSecret } from "../auth/oidc-providers.js";
import { adminProviderColumns, type AdminProviderRow, updateAuthProviderInTx, type UpdateAuthProviderResult } from "../auth/tx/admin-auth-providers.js";

export interface AdminAuthRouteDeps {
  db: Db;
  config: AppConfig;
  /** PATCH／DELETE 後 `invalidate`（§9.2）；test／discover 用 `probe`（不經快取）。與登入路由同一個 per-app 實例。 */
  registry: OidcRuntimeRegistry;
}

const INSECURE_ISSUER_LOG = "登入服務的 issuer 是明文 http（§5.3）";
const ISSUER_AUDIT_LOG = "登入服務的 issuer 被寫入";
const NOT_FOUND_MESSAGE = "找不到此登入服務";

/** 路徑參數：過 UUID_RE 再轉小寫（RF4）；不合法回 null（呼叫端 404）。 */
function providerIdParam(request: FastifyRequest): string | null {
  const raw = (request.params as { id: string }).id;
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

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
        .returning(adminProviderColumns())
        // 這一句寫密文欄：非預期的 DB 錯誤不得原樣進 log（DrizzleQueryError 的 message 帶 params；Task 3 審查 m1）。
        .catch((err: unknown) => {
          throw redactDbError(request.log, err, "建立登入服務");
        });
      if (row!.issuerUrl.startsWith("http://")) request.log.warn({ providerId: id }, INSECURE_ISSUER_LOG);
      return reply.code(201).send(toAdminProviderDto(row!, deps.config));
    });

    app.patch("/api/admin/auth/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      const parsed = patchProviderSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const { clientSecret, ...fields } = parsed.data;
      // 交易外封章（S14：交易內只做 DB）。AAD 綁 id——封給這一列的密文搬到別列解不開（§5.1）。
      const newSecretSealed = clientSecret !== undefined ? sealClientSecret(deps.config.appSecret, id, clientSecret) : undefined;
      const patchInput = { id, ...fields, ...(newSecretSealed !== undefined ? { newSecretSealed } : {}) };

      let result: UpdateAuthProviderResult;
      try {
        result = await deps.db.transaction(tx => updateAuthProviderInTx(tx, patchInput));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        if (checkViolationConstraint(err) === "auth_providers_enabled_secret_chk") {
          return sendError(reply, 409, "provider_secret_missing", "這個登入服務沒有 client secret，不能啟用");
        }
        // 非預期錯誤不得原樣進 log：這一句可能寫密文欄（DrizzleQueryError 的 message 帶 params）。
        throw redactDbError(request.log, err, "修改登入服務");
      }
      // 提交之後才失效快取（失敗不動）。版本有變時 registry 本來就會自癒（§6），這一行讓「只改 secret 以外」的情形也不留舊 runtime。
      deps.registry.invalidate(id);

      const { row, previousIssuerUrl } = result;
      if (fields.issuerUrl !== undefined) {
        // §5.2：帶了 issuerUrl 就記一行（值相同也記——條件式記錄在並發下會整個沉默，見 [[ai-provider-key-exfil]] 第 3 條）。
        // `hasSecretAfter`／`enabledAfter` 取 DB 回傳值；`from` 是交易內的一般讀，並發下可能落後。
        request.log.info(
          { providerId: id, userId: request.user!.id, from: safeTarget(previousIssuerUrl), to: safeTarget(row.issuerUrl), hasSecretAfter: row.hasSecret, enabledAfter: row.enabled },
          ISSUER_AUDIT_LOG,
        );
        if (row.issuerUrl.startsWith("http://")) request.log.warn({ providerId: id }, INSECURE_ISSUER_LOG);
      }
      return reply.send(toAdminProviderDto(row, deps.config));
    });
  };
}
