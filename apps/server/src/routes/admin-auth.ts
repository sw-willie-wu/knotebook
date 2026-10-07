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
import { detectImageMimeType } from "../uploads/magic-bytes.js";
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
  /** PATCH／DELETE 後 `invalidate`（§9.2）；test／discover 用 `probe`（不經快取）。與登入路由同一個 per-app 實例。 */
  registry: OidcRuntimeRegistry;
}

const INSECURE_ISSUER_LOG = "登入服務的 issuer 是明文 http（§5.3）";
const ISSUER_AUDIT_LOG = "登入服務的 issuer 被寫入";
const NOT_FOUND_MESSAGE = "找不到此登入服務";
const DISCOVERY_FAILED_MESSAGE = "無法從這個 issuer 讀到可用的 OIDC 設定";
const ICON_TOO_LARGE_MESSAGE = "圖檔不得超過 256 KB";
const ICON_TYPE_MESSAGE = "只接受 PNG、JPEG、WebP";

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
    // CHECK `auth_providers_icon_kind_chk` 保證值域（比照上面 template 的轉型）。
    iconKind: row.iconKind as ProviderIconKind,
    icon: resolveProviderIcon(row),
  };
}

/**
 * #187 PR2：站台管理的登入服務 API（spec §9.2）；PR3 加 `/api/admin/auth/settings`（§9.5）。全部 `requireAdmin`；HTTP 層訊息中文。
 * 停用、刪除都不撤 session（Q5）。
 */
export function adminAuthRoutes(deps: AdminAuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const settingsBodySchema = z
      .object({ registrationEnabled: z.boolean().optional(), passwordLoginEnabled: z.boolean().optional() })
      .strict()
      .refine(body => Object.keys(body).length > 0, "請求格式錯誤：至少需要一個欄位");

    /** GET 與 PATCH 回同一形。讀不到列：註冊視同關、帳密視同開（§4.3 兩條）＋log.error；GET 不回 500（PATCH 會）。 */
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
          // §4.3：讀不到列（只可能是手改 DB）→ 500＋log.error。
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        throw err;
      }
      // §9.5 第 4 步：有變才記（舊值是 B27 鎖下讀的，並發不會讓它沉默）。
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
      const patchInput = { id, actorUserId: request.user!.id, ...fields, ...(newSecretSealed !== undefined ? { newSecretSealed } : {}) };

      let result: UpdateAuthProviderResult;
      try {
        result = await deps.db.transaction(tx => updateAuthProviderInTx(tx, patchInput));
      } catch (err) {
        if (err instanceof TxAbort) {
          // B27 鎖讀不到 site_settings 列（§17 第 34 條）→ 500＋log.error（§4.3）。
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
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
        // `hasSecretAfter`／`enabledAfter` 取 DB 回傳值；`from` 是 B27 鎖之後的讀——改 issuer 的寫入（provider PATCH）都排在那把鎖後，是當下的值。
        request.log.info(
          { providerId: id, userId: request.user!.id, from: safeTarget(previousIssuerUrl), to: safeTarget(row.issuerUrl), hasSecretAfter: row.hasSecret, enabledAfter: row.enabled },
          ISSUER_AUDIT_LOG,
        );
        if (row.issuerUrl.startsWith("http://")) request.log.warn({ providerId: id }, INSECURE_ISSUER_LOG);
      }
      return reply.send(toAdminProviderDto(row, deps.config));
    });

    /**
     * 登入服務圖示上傳（spec 2026-10-07-provider-icon §4.2）。CSRF：`app.ts` 的 `MULTIPART_EXEMPT_ROUTES`（essence＋Origin）。
     * 處理形比照 `routes/uploads.ts:75-150`：迴圈跑完全部 parts、只取第一個 file part、其餘 resume；每個早退都 drain。
     * 單句 UPDATE、不開交易、不取 B27（D10／Q2：圖示不影響登入判斷）；不 `registry.invalidate`（圖示不影響 OIDC runtime）。
     */
    async function requireAdminDrained(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await app.requireAdmin(request, reply);
      // 尚未進 multipart 解析的早退一律 drain（同 routes/uploads.ts 的 authAndAuthorize）。
      if (reply.sent) drainWithCap(request);
    }

    app.put("/api/admin/auth/providers/:id/icon", { preHandler: requireAdminDrained }, async (request, reply) => {
      const id = providerIdParam(request);
      if (id === null) {
        drainWithCap(request);
        return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);
      }
      let fileBuf: Buffer | undefined;
      let truncated = false;
      try {
        // 每次呼叫覆寫 fileSize（與註冊選項 deepmerge；throwFileSizeLimit 沿用 false）→ 超過只設 `.truncated`、不丟例外（spec §2.3-2）。
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
        return sendError(reply, 400, "invalid_body", "上傳格式錯誤");
      }
      if (fileBuf === undefined) {
        drainWithCap(request);
        return sendError(reply, 400, "invalid_body", "缺少上傳檔案");
      }
      if (truncated) {
        drainWithCap(request);
        return sendError(reply, 413, "file_too_large", ICON_TOO_LARGE_MESSAGE);
      }
      // 只信檔頭（uploads/magic-bytes.ts:1-6）；偵測器認得 GIF，本端點不收（spec §2.3-4）。
      const mime = detectImageMimeType(fileBuf);
      if (mime === null || mime === "image/gif") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", ICON_TYPE_MESSAGE);
      }
      const [row] = await deps.db
        .update(authProviders)
        .set({ iconKind: "upload", iconData: fileBuf, iconMime: mime, iconVersion: sql`${authProviders.iconVersion} + 1`, updatedAt: sql`now()` })
        .where(eq(authProviders.id, id))
        .returning(adminProviderColumns())
        // params 帶整個圖檔：非預期的 DB 錯誤不得原樣進 log（同 POST／PATCH 的 redact）。
        .catch((err: unknown) => {
          throw redactDbError(request.log, err, "上傳登入服務圖示");
        });
      // 讀不到＝不存在或剛被刪（spec §7.2 PUT ∥ DELETE）。
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
          // B27 鎖讀不到 site_settings 列（§17 第 34 條）→ 500＋log.error（§4.3）。
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        // 與 PATCH 一致：非預期的 DB 錯誤一律遮蔽後再丟（這一句不帶密文參數，但刪的是含密文欄的列——不讓錯誤本體進 log）。
        throw redactDbError(request.log, err, "刪除登入服務");
      }
      // 提交之後才失效快取（409／404 不動）。
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
      // 這裡刻意 SELECT 密文本體——只為了判斷「解得開嗎」（warning），內容不進任何回應、不送任何地方（§5.2）。
      const [row] = await deps.db
        .select({ id: authProviders.id, issuerUrl: authProviders.issuerUrl, configVersion: authProviders.configVersion, clientSecretEncrypted: authProviders.clientSecretEncrypted })
        .from(authProviders)
        .where(eq(authProviders.id, id))
        .limit(1);
      if (!row) return sendError(reply, 404, "not_found", NOT_FOUND_MESSAGE);

      let metadata: Awaited<ReturnType<OidcRuntimeRegistry["probe"]>>;
      try {
        metadata = await deps.registry.probe(row.issuerUrl);
      } catch (err) {
        if (!(err instanceof OidcUnavailableError)) throw err;
        // 不帶 err：OidcUnavailableError 的 message 現已去敏（issuer 只用 safeTarget、不串底層 message），仍不記 err 以免日後
        // 回歸時原始 issuer 網址（可能有 user:pass@）又跟著進 log——只記 safeTarget（gate r1-t1-7 M5）。
        request.log.warn({ providerId: id, issuer: safeTarget(row.issuerUrl) }, "登入服務測試連線失敗");
        return sendError(reply, 502, "oidc_discovery_failed", DISCOVERY_FAILED_MESSAGE);
      }
      const warnings = probeWarnings(row.issuerUrl, metadata);
      if (row.clientSecretEncrypted !== null) {
        try {
          openClientSecret(deps.config.appSecret, row);
        } catch (err) {
          if (!(err instanceof SecretDecryptError)) throw err;
          warnings.push("secret_undecryptable");
        }
      }
      // §4.1：成功時以版本述詞寫 resolved_issuer（讀列時的版本；期間被改過就不寫——舊設定的結果不得蓋掉新設定）。不在交易內。
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
