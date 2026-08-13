// OIDC client 封裝（openid-client v6）——per-app-instance（嚴禁 module 單例：AppDeps.limiters
// 同款理由，§14.3）。唯一職責＝lazy discovery + 三態快取；不碰 authorization
// URL 組裝（routes/oidc.ts）、不碰 token/userinfo 交換（Task 9 callback route 的職責）。

import * as client from "openid-client";
import type { AppConfig } from "../config.js";

/**
 * discovery 失敗（網路/協定錯誤）或成功但不可用（缺 `jwks_uri`／無非對稱簽章演算法）
 * 一律以此類型 throw——呼叫端（`routes/oidc.ts`）一律 catch 這個型別轉 302
 * `oidc_unavailable`，不需要分辨底層原因。
 */
export class OidcUnavailableError extends Error {}

export interface OidcRuntimeOptions {
  /** customFetch seam（測試注入 mock IdP）——型別直接用 v6 的 CustomFetch（自訂簽章有
   * strictFunctionTypes 摩擦；plan-gate 一輪 MINOR-8）。 */
  fetch?: client.CustomFetch;
}

export interface OidcRuntime {
  /**
   * lazy discovery 三態（§14.3）：
   * 1. 網路/協定失敗 → 不快取，throw `OidcUnavailableError`（下次呼叫重試）。
   * 2. 成功但不可用（缺 `jwks_uri`／`id_token_signing_alg_values_supported` 無非對稱
   *    演算法）→ 不快取，throw `OidcUnavailableError`（IdP 修好即恢復）。
   * 3. 成功且可用 → 快取至重啟（同一份 `Configuration` 之後每次呼叫直接回傳）。
   *
   * in-flight promise 去重：首波併發共用同一次 discovery；失敗後清除 in-flight 讓下次
   * 呼叫重新觸發（而非卡在已失敗的 promise 上）。
   */
  getConfiguration(): Promise<client.Configuration>;
}

/** ID token 簽章演算法字首——RS/ES/PS 開頭視為非對稱（RSA/ECDSA/RSASSA-PSS 家族）。 */
const ASYMMETRIC_ALG_PREFIXES = ["RS", "ES", "PS"];

/** 缺欄位（`undefined`）視為含 RS256，不擋（§14.3：多數 IdP 省略這個 optional 欄位時
 * 仍支援 RS256，不該因為欄位缺席就整組判定不可用）。 */
function hasAsymmetricSigningAlg(algs: readonly string[] | undefined): boolean {
  if (algs === undefined) return true;
  return algs.some(alg => ASYMMETRIC_ALG_PREFIXES.some(prefix => alg.startsWith(prefix)));
}

/**
 * per-instance runtime 工廠。`oidc` 對應 `AppConfig.oidc`（已由 `config.ts` 保證三件組
 * 全有）；`opts.fetch` 是測試專用的 `client.CustomFetch` 注入縫（in-process mock IdP，
 * 見 `test/helpers/fake-idp.ts`），production（`index.ts`／`app.ts` 的 fallback）不傳。
 */
export function createOidcRuntime(oidc: NonNullable<AppConfig["oidc"]>, opts: OidcRuntimeOptions = {}): OidcRuntime {
  let cached: client.Configuration | undefined;
  let inflight: Promise<client.Configuration> | undefined;

  async function runDiscovery(): Promise<client.Configuration> {
    const issuerUrl = new URL(oidc.issuerUrl);

    // v6 預設 tlsOnly：issuer 為 http: 時（trusted-LAN 內網自架 IdP 拓撲，同
    // `config.ts` 的 insecureHttpWarning 精神）discovery 本身與後續請求都必須明傳
    // `allowInsecureRequests`，否則直接 throw（§14.3 MAJOR-1）。
    const execute: Array<(config: client.Configuration) => void> = [];
    if (issuerUrl.protocol === "http:") execute.push(client.allowInsecureRequests);

    const discoveryOptions: client.DiscoveryRequestOptions = { execute };
    if (opts.fetch) discoveryOptions[client.customFetch] = opts.fetch;

    let configuration: client.Configuration;
    try {
      // client 認證明傳 ClientSecretPost（§14.3）——不依賴 discovery 自動推導
      // token_endpoint_auth_method。
      configuration = await client.discovery(
        issuerUrl,
        oidc.clientId,
        undefined,
        client.ClientSecretPost(oidc.clientSecret),
        discoveryOptions
      );
    } catch (err) {
      throw new OidcUnavailableError(
        `OIDC discovery 失敗（issuer=${oidc.issuerUrl}）：${err instanceof Error ? err.message : String(err)}`
      );
    }

    // discovery 呼叫本身已透過 discoveryOptions 傳入同一個 fetch；這裡再顯式設一次
    // `configuration[client.customFetch]`，確保這個 Configuration 之後的所有個別請求
    // （token/userinfo/jwks，Task 9 消費）也走同一個 mock（§14.3 逐字：discovery 呼叫
    // 本身亦需傳同一 fetch）。
    if (opts.fetch) configuration[client.customFetch] = opts.fetch;

    const metadata = configuration.serverMetadata();
    if (!metadata.jwks_uri || !hasAsymmetricSigningAlg(metadata.id_token_signing_alg_values_supported)) {
      throw new OidcUnavailableError(
        `OIDC issuer metadata 不可用（issuer=${oidc.issuerUrl}）：缺 jwks_uri 或無非對稱簽章演算法`
      );
    }

    // 前置檢查通過才開啟——啟用後每次 id_token 驗證都會強制要求非對稱簽章，缺前置
    // 檢查會讓「開啟後才發現不可用」延後到 callback 路徑才炸開（§14.3 MAJOR-2/二輪 MAJOR-1）。
    client.enableNonRepudiationChecks(configuration);

    return configuration;
  }

  return {
    async getConfiguration(): Promise<client.Configuration> {
      if (cached) return cached;
      if (!inflight) {
        inflight = runDiscovery()
          .then(configuration => {
            cached = configuration;
            return configuration;
          })
          .finally(() => {
            // 成功／失敗皆清除 in-flight：成功後靠 `cached` 短路，不會再走這個
            // promise；失敗後必須清除，否則下次呼叫會直接拿到同一個已 reject 的
            // promise（永遠不重試，即使 IdP 已恢復）。
            inflight = undefined;
          });
      }
      return inflight;
    },
  };
}

/** login 與 callback 共用的單一 helper（§14.3）——避免兩處各自組一次 URL 而漂移不同步。 */
export function oidcRedirectUri(config: AppConfig): string {
  return new URL("/api/auth/oidc/callback", config.publicUrl).href;
}
