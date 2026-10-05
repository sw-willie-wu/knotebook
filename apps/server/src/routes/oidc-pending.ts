import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { normalizeEmail, safeNextPath, type OidcRedirectDto, type PendingLinkConfirmDto, type PendingLinkDto, type UserDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { authProviders, users } from "../db/schema.js";
import { sendError, sendLoginThrottled } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { DUMMY_HASH, HashBusyError, verifyPassword } from "../auth/password.js";
import type { LoginThrottle } from "../auth/rate-limit.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { linkedEnabledProvidersWithIssuer, loadEnabledProvider, providerConfiguration } from "../auth/oidc-providers.js";
import { setOidcStateCookie, startAuthorization } from "../auth/oidc-authorize.js";
import { UUID_RE } from "../notes/service.js";
import { excludeSameIssuerProviders } from "../auth/issuer.js";
import { clearPendingCookie, readPendingLink } from "../auth/oidc-pending.js";
import type { OidcTestHook } from "../auth/oidc-test-hook.js";
import { LINK_EXPIRED_MESSAGE, linkPendingIdentityInTx, type LinkedUser } from "../auth/tx/link-identity.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

const NO_PENDING_MESSAGE = "沒有待連結的登入，請重新登入";
const NO_PROOF_MESSAGE = "這個 email 已有帳號，但它目前沒有可用來證明本人的登入方式（沒有密碼，連結的登入服務也已停用）。請聯絡站長。";

const confirmBodySchema = z.object({ password: z.string(), pendingId: z.string() }).strict();
const proveBodySchema = z.object({ pendingId: z.string() }).strict();

export interface OidcPendingRouteDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  throttle: LoginThrottle;
  /** SSO 證明起點（§7.5.3）取 discovery 結果用。 */
  registry: OidcRuntimeRegistry;
  limiters: { oidcLogin: FixedWindowLimiter };
  /** 測試縫：只經 `AppDeps.oidcTestHook` 注入（production 的 index.ts 不傳），見 `app.ts`。 */
  oidcTestHook?: OidcTestHook;
}

function toUserDto(u: LinkedUser): UserDto {
  return { id: u.id, email: u.email, handle: u.handle, displayName: u.displayName, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword, hasPassword: u.hasPassword };
}

/**
 * #187 §7.5：「這個 email 已有帳號，要連結嗎？」。只認 pending-link cookie（與目前 session 無關——已登入他人的瀏覽器完成連結，
 * 簽出的 session 取代舊的，§9.4）。confirm 的順序刻意與登入相同：**先驗密碼、再判停用**（B14／r2-M7），且停用、B2 都只在鎖內判。
 */
export function oidcPendingRoutes(deps: OidcPendingRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /** 帳號仍在、email 未改（lower 比對）——不判停用（B14）。 */
    async function loadTarget(userId: string): Promise<{ passwordHash: string | null; emailLower: string } | null> {
      const [row] = await deps.db
        .select({ passwordHash: users.passwordHash, emailLower: sql<string>`lower(${users.email})` })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ?? null;
    }

    app.get("/api/auth/oidc/pending", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const target = await loadTarget(pending.userId);
      if (target === null || target.emailLower !== pending.email) {
        clearPendingCookie(reply, deps.config);
        return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      }
      // methods 每次重算：provider 可能剛被停用（§7.5.2 第 2 步）。B14（Task 6 裁定 A）：排除與待連結身分同 issuer 者——
      // 與 callback 的決策同一個函式（`auth/issuer.ts`），否則頁面會在證明前透露「這帳號已連過這個 IdP」。
      const providers = excludeSameIssuerProviders(await linkedEnabledProvidersWithIssuer(deps.db, pending.userId), pending.issuer);
      const methods = { password: target.passwordHash !== null, providers };
      if (!methods.password && providers.length === 0) return sendError(reply, 409, "oidc_link_no_proof_method", NO_PROOF_MESSAGE);
      const [provider] = await deps.db.select({ displayName: authProviders.displayName }).from(authProviders).where(eq(authProviders.id, pending.providerId)).limit(1);
      const dto: PendingLinkDto = { pendingId: pending.pendingId, email: pending.email, providerDisplayName: provider?.displayName ?? null, methods };
      return reply.send(dto);
    });

    app.post("/api/auth/oidc/pending/confirm", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const parsed = confirmBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      // 1. C18：另一分頁覆蓋了 pending。
      if (parsed.data.pendingId !== pending.pendingId) return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      // 2. 單一漏斗：checkAllowed／recordFailure／recordSuccess 三處同一個值（r2-N9；與 /api/auth/login 共用帳號軌與 IP 軌）。
      const throttleKey = normalizeEmail(pending.email);
      const allowed = deps.throttle.checkAllowed(throttleKey, request.ip);
      if (!allowed.allowed) return sendLoginThrottled(reply, allowed.retryAfterMs!);
      // 3. 帳號不在或 email 已改 → 清 cookie。停用不在這裡判。
      const target = await loadTarget(pending.userId);
      if (target === null || target.emailLower !== pending.email) {
        clearPendingCookie(reply, deps.config);
        return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      }
      // 4. 交易外驗密碼（S14）；無 hash 時對 DUMMY_HASH 等時化並視為失敗。
      let verified: boolean;
      try {
        if (target.passwordHash !== null) {
          verified = await verifyPassword(target.passwordHash, parsed.data.password);
        } else {
          await verifyPassword(DUMMY_HASH, parsed.data.password);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        throw err;
      }
      if (!verified) {
        deps.throttle.recordFailure(throttleKey, request.ip);
        return sendError(reply, 401, "invalid_credentials", "帳號或密碼錯誤");
      }
      await deps.oidcTestHook?.("pending-confirm-verified", { userId: pending.userId });

      // 5–6. §7.5.4 鎖內重驗與寫入（hash 仍是驗過的那個、停用、B2、INSERT）。
      const linkInput = {
        targetUserId: pending.userId,
        pendingEmail: pending.email,
        issuer: pending.issuer,
        sub: pending.sub,
        proof: { kind: "password" as const, passwordHash: target.passwordHash! },
      };
      let linked: LinkedUser;
      try {
        linked = await deps.db.transaction(tx => linkPendingIdentityInTx(tx, linkInput, deps.oidcTestHook));
      } catch (err) {
        if (!(err instanceof TxAbort)) throw err;
        if (err.errCode === "oidc_link_expired") clearPendingCookie(reply, deps.config);
        // 交易內的任何拒絕（hash 已變 401、停用 403、帳號已不在或 email 已改 409、B2／identity_taken 409）都不 recordSuccess、
        // 也不 recordFailure（r3-N4）——只有交易成功才 recordSuccess。
        return sendError(reply, err.status, err.errCode, err.message);
      }
      deps.throttle.recordSuccess(throttleKey, request.ip);
      clearPendingCookie(reply, deps.config);
      deps.gate.invalidate(linked.id);
      const token = await signSession(deps.config.appSecret, { userId: linked.id, tv: linked.tokenVersion });
      setSessionCookie(reply, deps.config, token);
      // next 由 server 從 pending 解出、再過 safeNextPath；web 只用這個值（r2-M2）。
      const next = (pending.next !== undefined ? safeNextPath(pending.next) : null) ?? "/";
      const body: PendingLinkConfirmDto = { user: toUserDto(linked), next };
      return reply.send(body);
    });

    // §7.5.3 起點：要求 JSON body（B7：跨站表單送不進來——CSRF hook 只擋「帶 body 且非 JSON」）。
    app.post<{ Params: { providerId: string } }>("/api/auth/oidc/pending/prove/:providerId", async (request, reply) => {
      const pending = readPendingLink(request, deps.config.appSecret);
      if (pending === null) return sendError(reply, 401, "unauthorized", NO_PENDING_MESSAGE);
      const parsed = proveBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      if (parsed.data.pendingId !== pending.pendingId) return sendError(reply, 409, "oidc_link_expired", LINK_EXPIRED_MESSAGE);
      if (!deps.limiters.oidcLogin.consume(request.ip)) return sendError(reply, 429, "too_many_requests", "請求太頻繁，請稍後再試");
      const raw = request.params.providerId;
      const providerId = UUID_RE.test(raw) ? raw.toLowerCase() : null;
      // 必須在**當下重算**的 methods.providers 裡（啟用中、本帳號有 issuer＝其 effective issuer 的身分，且 B14 排除與待連結身分
      // 同 issuer 者——與 GET pending、決策同一個 `excludeSameIssuerProviders`）；不區分原因。
      const usable = excludeSameIssuerProviders(await linkedEnabledProvidersWithIssuer(deps.db, pending.userId), pending.issuer);
      const provider = providerId !== null && usable.some(p => p.id === providerId) ? await loadEnabledProvider(deps.db, providerId) : null;
      if (provider === null) return sendError(reply, 404, "provider_not_found", "找不到這個登入服務，或它目前未啟用");
      let url: URL;
      try {
        const configuration = await providerConfiguration({ db: deps.db, registry: deps.registry, appSecret: deps.config.appSecret, log: request.log }, provider);
        const started = await startAuthorization(deps.config, provider, configuration, { intent: "prove", pendingId: pending.pendingId, proveUserId: pending.userId });
        setOidcStateCookie(reply, deps.config, started.sealedState);
        url = started.url;
      } catch (err) {
        request.log.warn({ err, providerId: provider.id }, "SSO 證明起點：discovery 不可用");
        return sendError(reply, 503, "oidc_unavailable", "登入服務目前無法使用，請稍後再試");
      }
      const body: OidcRedirectDto = { url: url.href };
      return reply.send(body);
    });

    // 無 body：CSRF hook 放行（§2.4）；被跨站觸發的後果只是要重按一次 SSO（B7，§17 第 21 條）。
    app.post("/api/auth/oidc/pending/cancel", async (_request, reply) => {
      clearPendingCookie(reply, deps.config);
      return reply.code(204).send();
    });
  };
}
