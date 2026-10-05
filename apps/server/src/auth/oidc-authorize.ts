import type { FastifyReply } from "fastify";
import * as client from "openid-client";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import { oidcRedirectUri } from "./oidc-client.js";
import type { OidcProviderRow } from "./oidc-providers.js";
import { OIDC_STATE_COOKIE_PATH, OIDC_STATE_TTL_SECONDS, sealOidcState, type OidcStateIntent } from "./oidc-state.js";

/**
 * login 與 SSO 證明起點共用：產 state／nonce／PKCE、封 state cookie（綁 providerId＋configVersion＋intent）、組 authorization URL。
 * scope 逐字 "openid email profile"（漏了 email／name claim 全缺，Plan 5 四輪 gate MAJOR-1）。`buildAuthorizationUrl` 在 metadata
 * 缺 endpoint 時會 throw——呼叫端一律 catch。
 */
export async function startAuthorization(
  config: Pick<AppConfig, "appSecret" | "publicUrl">,
  provider: Pick<OidcProviderRow, "id" | "legacyCallback" | "configVersion">,
  configuration: client.Configuration,
  intent: OidcStateIntent,
): Promise<{ sealedState: string; url: URL }> {
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const sealedState = sealOidcState(config.appSecret, {
    state, nonce, codeVerifier,
    exp: Math.floor(Date.now() / 1000) + OIDC_STATE_TTL_SECONDS,
    providerId: provider.id,
    configVersion: provider.configVersion,
    ...intent,
  });
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: oidcRedirectUri(config, provider),
    scope: "openid email profile",
    state, nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { sealedState, url };
}

export function setOidcStateCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">, sealed: string): void {
  reply.setCookie(OIDC_STATE_COOKIE, sealed, {
    httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: OIDC_STATE_COOKIE_PATH, maxAge: OIDC_STATE_TTL_SECONDS,
  });
}

/** 必須帶與 setCookie 相同的 path／sameSite／secure。 */
export function clearOidcStateCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">): void {
  reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_STATE_COOKIE_PATH, sameSite: "lax", secure: config.cookieSecure });
}
