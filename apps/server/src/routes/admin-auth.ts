import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { MAX_PROVIDER_ICON_BYTES, resolveProviderIcon, type AdminAuthProbeResultDto, type AdminAuthProviderDto, type AdminAuthSettingsDto, type AuthProviderTemplate, type ProviderIconKind } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { authProviders, siteSettings } from "../db/schema.js";
import { checkViolationConstraint } from "../db/pg-errors.js";
import { drainWithCap } from "../http/drain.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { SecretDecryptError } from "../lib/sealed-secret.js";
import { safeTarget } from "../lib/safe-target.js";
import { UUID_RE } from "../notes/service.js";
import { detectRasterImageMimeType } from "../uploads/magic-bytes.js";
import { createProviderSchema, discoverSchema, patchProviderSchema, sendInvalidBody } from "../auth/admin-provider-input.js";
import { OidcUnavailableError, oidcRedirectUri, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { openClientSecret, probeWarnings, recordResolvedIssuer, sealClientSecret } from "../auth/oidc-providers.js";
import { providerImpact } from "../auth/provider-impact.js";
import { PASSWORD_LOGIN_SETTINGS_MISSING_LOG } from "../auth/password-login.js";
import { passwordLoginImpact } from "../auth/sign-in-methods.js";
import { updateSiteSettingsInTx, type UpdateSiteSettingsResult } from "../auth/tx/admin-site-settings.js";
import {
  adminProviderColumns,
  type AdminProviderRow,
  deleteAuthProviderInTx,
  updateAuthProviderInTx,
  type UpdateAuthProviderResult,
} from "../auth/tx/admin-auth-providers.js";

export interface AdminAuthRouteDeps {
  db: Db;
  config: AppConfig;
  registry: OidcRuntimeRegistry;
}

const INSECURE_ISSUER_LOG = "登入服務的 issuer 是明文 http";
const ISSUER_AUDIT_LOG = "登入服務的 issuer 被寫入";
const NOT_FOUND_MESSAGE = "No sign-in service with that id.";
const DISCOVERY_FAILED_MESSAGE = "Couldn't read a usable OIDC configuration from this issuer.";
const ICON_TOO_LARGE_MESSAGE = "The image can be at most 256 KB.";
const ICON_TYPE_MESSAGE = "Only PNG, JPEG and WebP images are accepted.";

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
    autoCreateEnabled: row.autoCreateEnabled,
    sortOrder: row.sortOrder,
    legacyCallback: row.legacyCallback,
    callbackUrl: oidcRedirectUri(config, row),
    // Relies on CHECK auth_providers_issuer_url_chk keeping the scheme lowercase.
    insecureIssuer: row.issuerUrl.startsWith("http://"),
    issuerResolved: row.issuerResolved,
    createdAt: row.createdAt.toISOString(),
    iconKind: row.iconKind as ProviderIconKind,
    icon: resolveProviderIcon(row),
  };
}

export function adminAuthRoutes(deps: AdminAuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const settingsBodySchema = z
      .object({ registrationEnabled: z.boolean().optional(), passwordLoginEnabled: z.boolean().optional() })
      .strict()
      .refine(body => Object.keys(body).length > 0, "Invalid request body: send at least one field.");

    async function settingsDto(request: FastifyRequest): Promise<AdminAuthSettingsDto> {
      const [row] = await deps.db
        .select({ registrationEnabled: siteSettings.registrationEnabled, passwordLoginEnabled: siteSettings.passwordLoginEnabled })
        .from(siteSettings)
        .where(eq(siteSettings.singleton, true))
        .limit(1);
      if (row === undefined) request.log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
      return {
        registrationEnabled: row?.registrationEnabled ?? false,
        passwordLoginEnabled: row?.passwordLoginEnabled ?? true,
        passwordLoginForced: deps.config.passwordLoginForceEnable,
        passwordLoginImpact: await passwordLoginImpact(deps.db, request.user!.id),
      };
    }

    app.get("/api/admin/auth/settings", { preHandler: app.requireAdmin }, async request => settingsDto(request));

    app.patch("/api/admin/auth/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = settingsBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const input = { actorUserId: request.user!.id, ...parsed.data };
      let result: UpdateSiteSettingsResult;
      try {
        result = await deps.db.transaction(tx => updateSiteSettingsInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) {
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        throw err;
      }
      // The old value is read under the site-settings row lock, so concurrency can't silence this.
      if (result.previousPasswordLoginEnabled !== result.passwordLoginEnabled) {
        request.log.info(
          { userId: request.user!.id, passwordLoginEnabled: result.passwordLoginEnabled, passwordLoginForced: deps.config.passwordLoginForceEnable },
          "帳密登入開關被變更",
        );
      }
      return reply.send(await settingsDto(request));
    });

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
      // Id first: the ciphertext AAD binds providerId. Created disabled so it is tested before use.
      const id = randomUUID();
      const clientSecretEncrypted = clientSecret !== undefined ? sealClientSecret(deps.config.appSecret, id, clientSecret) : null;
      const [row] = await deps.db
        .insert(authProviders)
        .values({
          id,
          template,
          displayName,
          issuerUrl,
          clientId: clientId ?? null,
          clientSecretEncrypted,
          enabled: false,
          // Spelled out so it doesn't rely on the DB default.
          autoCreateEnabled: false,
          // New providers sort last (concurrent creates may tie; the list then orders by createdAt, id, harmless). Cap equals the PATCH `sortOrder` limit;
          // otherwise a max of 100000 would produce 100001 and every later edit would 400.
          sortOrder: sql`(select least(coalesce(max(${authProviders.sortOrder}), -1) + 1, 100000) from ${authProviders})`,
        })
        .returning(adminProviderColumns())
        // Writes the ciphertext column; DrizzleQueryError messages carry params, so redact.
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
      // Sealed outside the transaction (the transaction does DB work only); AAD binds id, so ciphertext moved to another row can't be decrypted.
      const newSecretSealed = clientSecret !== undefined ? sealClientSecret(deps.config.appSecret, id, clientSecret) : undefined;
      const patchInput = { id, actorUserId: request.user!.id, ...fields, ...(newSecretSealed !== undefined ? { newSecretSealed } : {}) };

      let result: UpdateAuthProviderResult;
      try {
        result = await deps.db.transaction(tx => updateAuthProviderInTx(tx, patchInput));
      } catch (err) {
        if (err instanceof TxAbort) {
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        if (checkViolationConstraint(err) === "auth_providers_enabled_secret_chk") {
          return sendError(reply, 409, "provider_secret_missing", "This sign-in service has no client secret, so it can't be enabled.");
        }
        if (checkViolationConstraint(err) === "auth_providers_enabled_client_id_chk") {
          return sendError(reply, 409, "provider_client_id_missing", "This sign-in service has no client ID, so it can't be enabled.");
        }
        throw redactDbError(request.log, err, "修改登入服務");
      }
      // After commit only: the registry's version self-heal misses edits that don't touch the secret.
      deps.registry.invalidate(id);

      const { row, previousIssuerUrl, previousAutoCreateEnabled } = result;
      // The previous value is read under the site-settings row lock, so concurrency can't silence this.
      if (row.autoCreateEnabled !== previousAutoCreateEnabled) {
        request.log.info({ providerId: id, userId: request.user!.id, autoCreateEnabled: row.autoCreateEnabled }, "登入服務的自動建帳開關被變更");
      }
      if (fields.issuerUrl !== undefined) {
        // Logged even when the value is equal: conditional logging goes silent under concurrency. `from` is read after the site-settings lock, which all issuer-changing writes queue behind;
        // hasSecretAfter/enabledAfter are DB-returned values; autoCreateEnabledAfter guarantees a record when the issuer changes and auto-create is kept.
        request.log.info(
          {
            providerId: id, userId: request.user!.id, from: safeTarget(previousIssuerUrl), to: safeTarget(row.issuerUrl), hasSecretAfter: row.hasSecret, enabledAfter: row.enabled,
            autoCreateEnabledAfter: row.autoCreateEnabled,
          },
          ISSUER_AUDIT_LOG,
        );
        if (row.issuerUrl.startsWith("http://")) request.log.warn({ providerId: id }, INSECURE_ISSUER_LOG);
      }
      return reply.send(toAdminProviderDto(row, deps.config));
    });

    async function requireAdminDrained(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await app.requireAdmin(request, reply);
      if (reply.sent) drainWithCap(request);
    }

    /**
     * CSRF: MULTIPART_EXEMPT_ROUTES in app.ts. Single UPDATE, no transaction, takes only the first file part. No site-settings lock and no
     * registry.invalidate: the icon affects neither login decisions nor the OIDC runtime.
     */
    app.put("/api/admin/auth/providers/:id/icon", { preHandler: requireAdminDrained }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) {
        drainWithCap(request);
        return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      }
      let fileBuf: Buffer | undefined;
      let truncated = false;
      try {
        // fileSize overrides the registered option per call; over the limit only sets `.truncated` (no throw).
        // Run the loop to the end (no break) and resume extra file parts: that is what drains the body (see routes/uploads.ts).
        for await (const part of request.parts({ limits: { fileSize: MAX_PROVIDER_ICON_BYTES } })) {
          if (part.type !== "file") continue;
          if (fileBuf === undefined) {
            fileBuf = await part.toBuffer();
            truncated = part.file.truncated;
          } else {
            part.file.resume();
          }
        }
      } catch (err) {
        drainWithCap(request);
        request.log.warn({ err }, "multipart 解析失敗");
        return sendError(reply, 400, "invalid_body", "The upload isn't valid multipart/form-data.");
      }
      if (fileBuf === undefined) {
        drainWithCap(request);
        return sendError(reply, 400, "invalid_body", "The upload has no file.");
      }
      if (truncated) {
        drainWithCap(request);
        return sendError(reply, 413, "file_too_large", ICON_TOO_LARGE_MESSAGE);
      }
      const mime = detectRasterImageMimeType(fileBuf);
      if (mime === null || mime === "image/gif") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", ICON_TYPE_MESSAGE);
      }
      const [row] = await deps.db
        .update(authProviders)
        .set({ iconKind: "upload", iconData: fileBuf, iconMime: mime, iconVersion: sql`${authProviders.iconVersion} + 1`, updatedAt: sql`now()` })
        .where(eq(authProviders.id, id))
        .returning(adminProviderColumns())
        .catch((err: unknown) => {
          throw redactDbError(request.log, err, "上傳登入服務圖示");
        });
      if (!row) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      return reply.send(toAdminProviderDto(row, deps.config));
    });

    app.delete("/api/admin/auth/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      const deleteInput = { id };
      try {
        await deps.db.transaction(tx => deleteAuthProviderInTx(tx, deleteInput));
      } catch (err) {
        if (err instanceof TxAbort) {
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        throw redactDbError(request.log, err, "刪除登入服務");
      }
      deps.registry.invalidate(id);
      return reply.code(204).send();
    });

    app.get("/api/admin/auth/providers/:id/impact", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      const result = await providerImpact(deps.db, id, request.user!.id);
      if (result === null) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      return reply.send(result);
    });

    app.post("/api/admin/auth/providers/:id/test", { preHandler: app.requireAdmin }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      // Selects the ciphertext only to check that it decrypts (a warning); never returned.
      const [row] = await deps.db
        .select({
          id: authProviders.id,
          issuerUrl: authProviders.issuerUrl,
          clientId: authProviders.clientId,
          configVersion: authProviders.configVersion,
          clientSecretEncrypted: authProviders.clientSecretEncrypted,
        })
        .from(authProviders)
        .where(eq(authProviders.id, id))
        .limit(1);
      if (!row) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);

      let metadata: Awaited<ReturnType<OidcRuntimeRegistry["probe"]>>;
      try {
        metadata = await deps.registry.probe(row.issuerUrl);
      } catch (err) {
        if (!(err instanceof OidcUnavailableError)) throw err;
        // err is not logged: a future regression could put the raw issuer URL (maybe with user:pass@) in the log.
        request.log.warn({ providerId: id, issuer: safeTarget(row.issuerUrl) }, "登入服務測試連線失敗");
        return sendError(reply, 502, "oidc_discovery_failed", DISCOVERY_FAILED_MESSAGE);
      }
      const warnings = probeWarnings(row.issuerUrl, metadata);
      if (row.clientId === null) warnings.push("client_id_missing");
      if (row.clientSecretEncrypted !== null) {
        try {
          openClientSecret(deps.config.appSecret, row);
        } catch (err) {
          if (!(err instanceof SecretDecryptError)) throw err;
          warnings.push("secret_undecryptable");
        }
      }
      // Version predicate: a result for an old config must not overwrite a newer one.
      await recordResolvedIssuer(deps.db, row, metadata.issuer);
      const body: AdminAuthProbeResultDto = { issuer: metadata.issuer, warnings };
      return reply.send(body);
    });

    app.post("/api/admin/auth/discover", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = discoverSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      let metadata: Awaited<ReturnType<OidcRuntimeRegistry["probe"]>>;
      try {
        metadata = await deps.registry.probe(parsed.data.issuerUrl);
      } catch (err) {
        if (!(err instanceof OidcUnavailableError)) throw err;
        request.log.warn({ issuer: safeTarget(parsed.data.issuerUrl) }, "登入服務先試探失敗");
        return sendError(reply, 502, "oidc_discovery_failed", DISCOVERY_FAILED_MESSAGE);
      }
      const body: AdminAuthProbeResultDto = { issuer: metadata.issuer, warnings: probeWarnings(parsed.data.issuerUrl, metadata) };
      return reply.send(body);
    });
  };
}
