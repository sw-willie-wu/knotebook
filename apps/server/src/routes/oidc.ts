import type { FastifyInstance } from "fastify";
import * as client from "openid-client";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import { OIDC_STATE_COOKIE_PATH, OIDC_STATE_TTL_SECONDS, sealOidcState } from "../auth/oidc-state.js";
import { OidcUnavailableError, oidcRedirectUri, type OidcRuntime } from "../auth/oidc-client.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

export interface OidcRouteDeps {
  config: AppConfig;
  /** `buildApp` 的 fallback 已把「`config.oidc` 有值但無 runtime」這個矛盾狀態排除
   * （見 `app.ts` 的 `oidcRuntime` 接線註解）——這裡仍收 `undefined`，是為了讓這條路由
   * 自己也能安全地應對「萬一」，不把兩端點 302 語彙不變量的維持全部押在呼叫端。 */
  runtime: OidcRuntime | undefined;
  limiters: { oidc: FixedWindowLimiter };
}

/**
 * `GET /api/auth/oidc/login`——OIDC authorization request 起點（Task 9 的
 * `GET /api/auth/oidc/callback` 是後半段，本檔目前只有 login 半邊，callback 留白）。
 *
 * 全程回 302（不回 JSON 錯誤）：這條路由的呼叫者是瀏覽器頂層導航（使用者點「用 SSO
 * 登入」按鈕的 `<a href>`），不是 fetch/XHR，回 JSON 4xx/5xx 只會讓瀏覽器顯示裸 JSON，
 * 使用者拿不到任何有意義的回饋——一律導回 `/login?error=<code>`，交給登入頁的 toast
 * 顯示對應 i18n 文案。
 */
export function oidcRoutes(deps: OidcRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/oidc/login", async (request, reply) => {
      if (deps.config.oidc === undefined || deps.runtime === undefined) {
        return reply.redirect("/login?error=oidc_unavailable");
      }

      if (!deps.limiters.oidc.consume(request.ip)) {
        return reply.redirect("/login?error=too_many_requests");
      }

      let configuration: client.Configuration;
      try {
        configuration = await deps.runtime.getConfiguration();
      } catch (err) {
        if (err instanceof OidcUnavailableError) {
          request.log.warn({ err }, "OIDC discovery 不可用，導回登入頁");
          return reply.redirect("/login?error=oidc_unavailable");
        }
        throw err;
      }

      // MINOR-1（審查 fix round 1）：`buildAuthorizationUrl` 在 metadata 缺
      // `authorization_endpoint` 等情況下會 throw——不包 try/catch 會落到全域錯誤 handler
      // 變成 JSON 500，破壞這條路由「一律 302，不回 JSON」的不變量。整段（state/nonce/PKCE
      // 產生、cookie、組 URL）刻意一起包，因為這些步驟本身也不該在中途失敗後留下已
      // `setCookie` 但沒有實際 302 到 IdP 的半殘狀態。
      try {
        const state = client.randomState();
        const nonce = client.randomNonce();
        const codeVerifier = client.randomPKCECodeVerifier();
        const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

        const nowEpochSeconds = Math.floor(Date.now() / 1000);
        const sealed = sealOidcState(deps.config.appSecret, {
          state,
          nonce,
          codeVerifier,
          exp: nowEpochSeconds + OIDC_STATE_TTL_SECONDS,
        });

        // scope 逐字 "openid email profile"（§14.3 authorize 參數契約——漏了會讓真 IdP
        // 全員回 oidc_email_missing，四輪 gate MAJOR-1）。
        const authorizationUrl = client.buildAuthorizationUrl(configuration, {
          redirect_uri: oidcRedirectUri(deps.config),
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        reply.setCookie(OIDC_STATE_COOKIE, sealed, {
          httpOnly: true,
          sameSite: "lax",
          secure: deps.config.cookieSecure,
          path: OIDC_STATE_COOKIE_PATH,
          maxAge: OIDC_STATE_TTL_SECONDS,
        });

        return reply.redirect(authorizationUrl.href);
      } catch (err) {
        // 不含 secret：`err` 是 openid-client 的驗證錯誤（缺 endpoint／參數格式），不含
        // `codeVerifier`/`state`/`nonce` 這類我們自己產生的一次性值（它們只存在於這個
        // function scope，從未被塞進任何 throw 的 err 物件）。
        request.log.warn({ err }, "組裝 OIDC authorization URL 失敗，導回登入頁");
        return reply.redirect("/login?error=oidc_unavailable");
      }
    });
  };
}
