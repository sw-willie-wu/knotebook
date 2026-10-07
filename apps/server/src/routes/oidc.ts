import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as client from "openid-client";
import { normalizeEmail, OIDC_STATE_COOKIE, safeNextPath } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { UUID_RE } from "../notes/service.js";
import { unsealOidcState } from "../auth/oidc-state.js";
import { clearOidcStateCookie, setOidcStateCookie, startAuthorization } from "../auth/oidc-authorize.js";
import { OidcUnavailableError, oidcErrorLogFields, oidcRedirectUri, type OidcRuntimeRegistry } from "../auth/oidc-client.js";
import { loadEnabledProvider, loadLegacyProvider, providerConfiguration, type OidcProviderRow } from "../auth/oidc-providers.js";
import type { OidcClaims } from "../auth/oidc-login-decision.js";
import { resolveOidcLoginInTx, type ResolveOidcLoginResult } from "../auth/tx/oidc-login.js";
import { clearPendingCookie, newPendingId, OIDC_PENDING_TTL_SECONDS, readPendingLink, sealPendingLinkWithinLimit, setPendingCookie } from "../auth/oidc-pending.js";
import { linkIdentityToUserInTx, linkPendingIdentityInTx, type LinkedUser } from "../auth/tx/link-identity.js";
import { TxAbort } from "../http/tx-abort.js";
import type { OidcTestHook } from "../auth/oidc-test-hook.js";
import { resolveSessionUser, signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

/** r3-M3：IdP claim 的長度上限——pending cookie 的大小上界靠它（§7.5.1）。 */
export const MAX_EMAIL_CLAIM_LENGTH = 254;
export const MAX_SUB_CLAIM_LENGTH = 255;

export interface OidcRouteDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  registry: OidcRuntimeRegistry;
  /** login 與 callback 各自一個 bucket（issue #16）；SSO 證明起點吃 oidcLogin（§7.5.3）。 */
  limiters: { oidcLogin: FixedWindowLimiter; oidcCallback: FixedWindowLimiter };
  oidcTestHook?: OidcTestHook;
}

/** legacy＝env 匯入的那一個（舊網址，B13）；id＝路徑參數原字串（未驗）。 */
type ProviderRef = { kind: "legacy" } | { kind: "id"; raw: string };

/** 空字串 claim 視為缺欄位（Plan 5 審查 MINOR-4：否則會建出 email="" 的帳號）。 */
function nonEmptyClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * `GET /api/auth/oidc/login[/:providerId]`＋`GET /api/auth/oidc/callback[/:providerId]`（#187 §7.1–§7.4）。
 * 全程 302、不回 JSON：呼叫者是瀏覽器頂層導航。在 state cookie 解開之前的失敗落 `/login?error=<code>`（不帶 next）；解開之後
 * 的失敗經 `failLocation`：登入途中落登入頁並帶上 cookie 裡的 next（#131），SSO 證明途中（`intent: "prove"`，§7.5.3）
 * 落 `/link-account?error=`。callback 遇到「email 已有帳號」（confirm_link）→ 封 pending-link
 * cookie、302 `/link-account`（§7.5）。
 */
export function oidcRoutes(deps: OidcRouteDeps) {
  const configDeps = { db: deps.db, registry: deps.registry, appSecret: deps.config.appSecret };

  async function loadProvider(ref: ProviderRef): Promise<OidcProviderRow | null> {
    return ref.kind === "legacy" ? loadLegacyProvider(deps.db) : loadEnabledProvider(deps.db, ref.raw.toLowerCase());
  }

  async function startLogin(request: FastifyRequest, reply: FastifyReply, ref: ProviderRef): Promise<FastifyReply> {
    // §7.2：四個（＋非 uuid 一個）早退出口都不帶 next（設定錯誤路徑，使用者從 client 重新發起即可——#131 spec round 10）。
    if (ref.kind === "id" && !UUID_RE.test(ref.raw)) return reply.redirect("/login?error=oidc_unavailable");
    // 限流放在 DB 讀取之前（r1-N2）。
    if (!deps.limiters.oidcLogin.consume(request.ip)) return reply.redirect("/login?error=too_many_requests");
    try {
      const provider = await loadProvider(ref);
      if (provider === null) return reply.redirect("/login?error=oidc_unavailable");
      let configuration: client.Configuration;
      try {
        configuration = await providerConfiguration({ ...configDeps, log: request.log }, provider);
      } catch (err) {
        request.log.warn({ ...oidcErrorLogFields(err), providerId: provider.id }, "OIDC discovery 不可用，導回登入頁");
        return reply.redirect("/login?error=oidc_unavailable");
      }
      const rawNext = (request.query as Record<string, unknown>).next;
      const requestedNext = safeNextPath(typeof rawNext === "string" ? rawNext : null);
      const { sealedState, url } = await startAuthorization(deps.config, provider, configuration, {
        intent: "login",
        ...(requestedNext !== null ? { next: requestedNext } : {}),
      });
      setOidcStateCookie(reply, deps.config, sealedState);
      return reply.redirect(url.href);
    } catch (err) {
      // 組 authorization URL 失敗（metadata 缺 endpoint）、DB 錯誤：維持「一律 302」不變量。
      request.log.warn(oidcErrorLogFields(err), "OIDC login 失敗，導回登入頁");
      return reply.redirect("/login?error=oidc_unavailable");
    }
  }

  async function handleCallback(request: FastifyRequest, reply: FastifyReply, ref: ProviderRef): Promise<FastifyReply> {
    if (ref.kind === "id" && !UUID_RE.test(ref.raw)) return reply.redirect("/login?error=oidc_unavailable");
    // callback 計在自己的 bucket（issue #16）：state cookie 是無狀態封章，不計數的話這裡是對 IdP token endpoint 的放大器。
    if (!deps.limiters.oidcCallback.consume(request.ip)) return reply.redirect("/login?error=too_many_requests");

    let nextPath: string | null = null;
    const loginErrorLocation = (code: string): string =>
      nextPath === null ? `/login?error=${code}` : `/login?error=${code}&next=${encodeURIComponent(nextPath)}`;
    let intent: "login" | "prove" | "link" | null = null;
    // §7.3：cookie 解開之後，SSO 證明途中的失敗回連結頁（同一顆 pending 還能改用密碼或換 provider）；設定頁手動連結的回設定頁（§8.1）；
    // 登入途中的回登入頁（帶 next）。
    const failLocation = (code: string): string =>
      intent === "prove" ? `/link-account?error=${code}` : intent === "link" ? `/settings/account?link_error=${code}` : loginErrorLocation(code);

    try {
      // §7.3 第 2 步：provider 不存在或停用 → oidc_unavailable（cookie 解開之前，不帶 next；C6、C19）。
      const provider = await loadProvider(ref);
      if (provider === null) return reply.redirect(loginErrorLocation("oidc_unavailable"));

      // 第 3 步：讀並即刻清 state cookie（成敗皆清）。
      const sealedCookie = request.cookies[OIDC_STATE_COOKIE];
      clearOidcStateCookie(reply, deps.config);
      if (sealedCookie === undefined) return reply.redirect(loginErrorLocation("oidc_state_mismatch"));
      const payload = unsealOidcState(deps.config.appSecret, sealedCookie, Math.floor(Date.now() / 1000));
      if (payload === null) return reply.redirect(loginErrorLocation("oidc_state_mismatch"));
      intent = payload.intent;
      // 封章保證「這是我們封的」，不保證「現在仍然安全」——再驗一次（#131 §5.3.3）。prove 形沒有 next（留在 pending cookie）。
      nextPath = payload.intent === "login" && payload.next !== undefined ? safeNextPath(payload.next) : null;

      // 第 4 步：cookie 是哪個 provider 發的；設定在登入途中變了（C5）就乾淨失敗。
      if (payload.providerId !== provider.id) return reply.redirect(failLocation("oidc_state_mismatch"));
      if (payload.configVersion !== provider.configVersion) return reply.redirect(failLocation("oidc_unavailable"));
      const query = request.query as Record<string, unknown>;
      if (typeof query.state !== "string" || query.state !== payload.state) return reply.redirect(failLocation("oidc_state_mismatch"));

      let configuration: client.Configuration;
      try {
        configuration = await providerConfiguration({ ...configDeps, log: request.log }, provider);
      } catch (err) {
        if (!(err instanceof OidcUnavailableError)) throw err;
        request.log.warn({ ...oidcErrorLogFields(err), providerId: provider.id }, "OIDC discovery 不可用，導回登入頁");
        return reply.redirect(failLocation("oidc_unavailable"));
      }

      // 第 5 步：code 交換。currentUrl 以唯一 helper 為底（不用 request.host——反代終止 TLS 會漂），只換上這次的 query。
      const currentUrl = new URL(oidcRedirectUri(deps.config, provider));
      const rawUrl = request.raw.url ?? "";
      const queryIndex = rawUrl.indexOf("?");
      currentUrl.search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
      try {
        tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
          expectedState: payload.state,
          expectedNonce: payload.nonce,
          pkceCodeVerifier: payload.codeVerifier,
        });
      } catch (err) {
        request.log.warn({ err }, "OIDC code 交換失敗");
        return reply.redirect(failLocation("oidc_exchange_failed"));
      }
      const idTokenClaims = tokens.claims();
      if (idTokenClaims === undefined) {
        request.log.warn("OIDC token 交換成功但缺 id_token claims");
        return reply.redirect(failLocation("oidc_exchange_failed"));
      }

      const metadata = configuration.serverMetadata();
      const sub = idTokenClaims.sub;
      let email = nonEmptyClaim(idTokenClaims.email);
      const name = typeof idTokenClaims.name === "string" ? idTokenClaims.name : null;
      let preferredUsername = nonEmptyClaim(idTokenClaims.preferred_username);
      // B3／r2-M4：只在 ID token 缺 email 時補打 userinfo；IdP 的「email 已驗證」旗標一律不讀。
      if (email === null && metadata.userinfo_endpoint !== undefined) {
        let userinfo: Awaited<ReturnType<typeof client.fetchUserInfo>>;
        try {
          userinfo = await client.fetchUserInfo(configuration, tokens.access_token, sub);
        } catch (err) {
          request.log.warn({ err }, "OIDC userinfo 取得失敗");
          return reply.redirect(failLocation("oidc_exchange_failed"));
        }
        email = nonEmptyClaim(userinfo.email);
        if (preferredUsername === null) preferredUsername = nonEmptyClaim(userinfo.preferred_username);
      }
      const normalizedEmail = email !== null ? normalizeEmail(email) : null;
      if ((normalizedEmail !== null && normalizedEmail.length > MAX_EMAIL_CLAIM_LENGTH) || sub.length > MAX_SUB_CLAIM_LENGTH) {
        request.log.warn({ emailLength: normalizedEmail?.length ?? 0, subLength: sub.length }, "OIDC claim 過長，拒收（r3-M3）");
        return reply.redirect(failLocation("oidc_claim_too_long"));
      }
      // issuer 單一真相：serverMetadata().issuer（＝ID token iss）——不是管理員填的字面（§2.2）。
      const claims: OidcClaims = { issuer: metadata.issuer, sub, email: normalizedEmail, name, preferredUsername };

      if (payload.intent === "link") {
        // §8.1 第 1 步：驗目前 session（authenticate 的核心，不掛 preHandler 以維持一律 302）。不在、失效、停用、或不是發起者 → mismatch。
        const session = await resolveSessionUser(request.cookies, deps.config.appSecret, deps.gate);
        if (session === null || session.user.id !== payload.linkUserId) return reply.redirect(failLocation("oidc_link_session_mismatch"));
        const linkInput = { userId: payload.linkUserId, issuer: claims.issuer, sub: claims.sub };
        try {
          await deps.db.transaction(tx => linkIdentityToUserInTx(tx, linkInput));
        } catch (err) {
          if (!(err instanceof TxAbort)) throw err;
          return reply.redirect(failLocation(err.errCode));
        }
        return reply.redirect(`/settings/account?linked=${provider.id}`);
      }

      if (payload.intent === "prove") {
        // §7.5.3 callback：新身分取自 pending，第二段往返只用來證明本人（claims.issuer／sub＝證明身分）。
        const pending = readPendingLink(request, deps.config.appSecret);
        if (pending === null) {
          clearPendingCookie(reply, deps.config);
          return reply.redirect(failLocation("oidc_link_expired"));
        }
        // pendingId／userId 不符＝另一分頁覆蓋了 pending（C18）：新 pending 屬於那個分頁，不清（與 confirm 路由一致，M1）。
        if (pending.pendingId !== payload.pendingId || pending.userId !== payload.proveUserId) {
          return reply.redirect(failLocation("oidc_link_expired"));
        }
        const proveInput = {
          targetUserId: pending.userId,
          pendingEmail: pending.email,
          issuer: pending.issuer,
          sub: pending.sub,
          proof: { kind: "sso" as const, issuer: claims.issuer, sub: claims.sub },
        };
        let linked: LinkedUser;
        try {
          linked = await deps.db.transaction(tx => linkPendingIdentityInTx(tx, proveInput, deps.oidcTestHook));
        } catch (err) {
          if (!(err instanceof TxAbort)) throw err;
          // 證明失敗不清 pending（還能改用密碼或換 provider）；只有 oidc_link_expired 清。
          if (err.errCode === "oidc_link_expired") clearPendingCookie(reply, deps.config);
          return reply.redirect(failLocation(err.errCode));
        }
        clearPendingCookie(reply, deps.config);
        deps.gate.invalidate(linked.id);
        const proveToken = await signSession(deps.config.appSecret, { userId: linked.id, tv: linked.tokenVersion });
        setSessionCookie(reply, deps.config, proveToken);
        return reply.redirect((pending.next !== undefined ? safeNextPath(pending.next) : null) ?? "/");
      }

      // §7.4 執行層。撞唯一鍵 → 整 tx 重投恰一次（C1：對方已 commit，重查會命中）。
      const loginInput = { claims };
      const runLogin = () => deps.db.transaction(tx => resolveOidcLoginInTx(tx, loginInput, deps.oidcTestHook));
      let resolved: ResolveOidcLoginResult;
      try {
        resolved = await runLogin();
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        try {
          resolved = await runLogin();
        } catch (err2) {
          request.log.warn({ err: err2 }, "OIDC 帳號解析 race 重查後仍失敗");
          return reply.redirect(failLocation("oidc_exchange_failed"));
        }
      }
      if (resolved.settingsMissing) request.log.error("site_settings 讀不到列：註冊視同關閉（#187 §4.3）");

      const outcome = resolved.outcome;
      if (outcome.kind === "reject") {
        if (outcome.code === "oidc_conflict") request.log.warn("OIDC 帳號衝突：lower(email) 命中多列");
        return reply.redirect(failLocation(outcome.code));
      }
      if (outcome.kind === "confirm_link") {
        const sealed = sealPendingLinkWithinLimit(deps.config.appSecret, {
          pendingId: newPendingId(),
          issuer: claims.issuer,
          sub: claims.sub,
          providerId: provider.id,
          userId: outcome.userId,
          email: outcome.email,
          exp: Math.floor(Date.now() / 1000) + OIDC_PENDING_TTL_SECONDS,
          ...(nextPath !== null ? { next: nextPath } : {}),
        });
        if (sealed === null) {
          // 防禦縱深：claim 已有上限，結構上到不了（plan 複驗第 21 條）。
          request.log.warn("pending-link cookie 封章後仍超過上限，不封章");
          return reply.redirect(failLocation("oidc_claim_too_long"));
        }
        setPendingCookie(reply, deps.config, sealed.sealed);
        return reply.redirect("/link-account");
      }
      // created 寫了 users（新列）：invalidate 讓 gate 不吐舊快取；login 不寫 users（B15），不需要。
      if (outcome.kind === "created") deps.gate.invalidate(outcome.userId);
      const token = await signSession(deps.config.appSecret, { userId: outcome.userId, tv: outcome.tokenVersion });
      setSessionCookie(reply, deps.config, token);
      return reply.redirect(nextPath ?? "/");
    } catch (err) {
      request.log.error({ err }, "OIDC callback 發生未預期錯誤");
      return reply.redirect(failLocation("oidc_exchange_failed"));
    }
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/oidc/login", (request, reply) => startLogin(request, reply, { kind: "legacy" }));
    app.get<{ Params: { providerId: string } }>("/api/auth/oidc/login/:providerId", (request, reply) =>
      startLogin(request, reply, { kind: "id", raw: request.params.providerId }),
    );
    app.get("/api/auth/oidc/callback", (request, reply) => handleCallback(request, reply, { kind: "legacy" }));
    app.get<{ Params: { providerId: string } }>("/api/auth/oidc/callback/:providerId", (request, reply) =>
      handleCallback(request, reply, { kind: "id", raw: request.params.providerId }),
    );
  };
}
