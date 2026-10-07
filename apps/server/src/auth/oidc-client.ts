// OIDC client 封裝（openid-client v6）——per-app-instance（嚴禁 module 單例：AppDeps.limiters
// 同款理由，§14.3）。唯一職責＝lazy discovery + 三態快取；不碰 authorization
// URL 組裝（auth/oidc-authorize.ts）、不碰 token/userinfo 交換（Task 9 callback route 的職責）。

import * as client from "openid-client";
import type { AppConfig } from "../config.js";
import { fetchErrorSummary, type FetchErrorSummary } from "../lib/fetch-error-summary.js";
import { safeTarget } from "../lib/safe-target.js";

/**
 * discovery 失敗（網路/協定錯誤）或成功但不可用（缺 `jwks_uri`／無非對稱簽章演算法）
 * 一律以此類型 throw——呼叫端（`routes/oidc.ts`）一律 catch 這個型別轉 302
 * `oidc_unavailable`，不需要分辨底層原因。
 */
export class OidcUnavailableError extends Error {
  /**
   * ⚠ message 不得含原始 issuer 網址（可能帶 `user:pass@`；只用 `safeTarget`）、也不得串底層錯誤的 message（fetch 對帶憑證的
   * 網址丟的 TypeError message 就是完整網址）。底層錯誤只以 `fetchErrorSummary`（name／code）留在 `underlying`。
   * 例外：registry 的 loadSecret 包裝（「OIDC client secret 無法取得」那句）串的是 `SecretDecryptError` 的 message——那是
   * `lib/sealed-secret.ts` 的固定文案（格式不認得、指紋不符、驗證失敗），不含秘密也不含網址。
   */
  constructor(
    message: string,
    readonly underlying?: FetchErrorSummary
  ) {
    super(message);
    this.name = "OidcUnavailableError";
  }
}

/**
 * OIDC 失敗路徑 log 用的欄位：**不記整個 err**（pino 會連 message、stack、cause 一起寫）。`OidcUnavailableError` 的 message
 * 已去敏（見上），記成 `reason`，並附底層錯誤的摘要；其他錯誤（組 authorization URL 失敗、DB 錯誤…）只記 `fetchErrorSummary`。
 */
export function oidcErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof OidcUnavailableError) {
    return { errName: err.name, reason: err.message, ...(err.underlying !== undefined ? { underlying: err.underlying } : {}) };
  }
  return { ...fetchErrorSummary(err) };
}

/** #187：runtime 需要的三件組（registry 從 DB provider 列組出；單元測試直接傳）。 */
export interface OidcClientSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

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
 * discovery 結果的可用性檢查（§14.3「成功但不可用」＋r3-M3 的 issuer 長度）。runtime（登入路徑）與 `probeOidcIssuer`
 * （管理頁的測試連線／先試探）**共用這一個函式**——兩條路徑的判準不得分歧，否則管理頁說「連線成功」、登入卻 `oidc_unavailable`。
 */
function assertUsableMetadata(metadata: client.ServerMetadata, issuerUrl: string): void {
  if (!metadata.jwks_uri || !hasAsymmetricSigningAlg(metadata.id_token_signing_alg_values_supported)) {
    throw new OidcUnavailableError(`OIDC issuer metadata 不可用（issuer=${safeTarget(issuerUrl)}）：缺 jwks_uri 或無非對稱簽章演算法`);
  }
  if (metadata.issuer.length > MAX_ISSUER_LENGTH) {
    // r3-M3：identity 存的 issuer 與 pending cookie 的大小上界都靠這個上限；`auth_providers` 的 CHECK 只管管理員輸入的字面。
    throw new OidcUnavailableError(`OIDC issuer 過長（${metadata.issuer.length} > ${MAX_ISSUER_LENGTH}）`);
  }
}

/** http issuer（trusted-LAN）要明傳 `allowInsecureRequests`（§14.3 MAJOR-1）；測試注入 fetch。runtime 與 probe 共用。 */
function discoveryOptionsFor(issuerUrl: URL, fetch: client.CustomFetch | undefined): client.DiscoveryRequestOptions {
  const execute: Array<(config: client.Configuration) => void> = [];
  if (issuerUrl.protocol === "http:") execute.push(client.allowInsecureRequests);
  const options: client.DiscoveryRequestOptions = { execute };
  if (fetch) options[client.customFetch] = fetch;
  return options;
}

/**
 * per-instance runtime 工廠。`oidc` 是一個 provider 的連線設定（`OidcClientSettings`；#187 起由 registry 從
 * `auth_providers` 列組出）；`opts.fetch` 是測試專用的 `client.CustomFetch` 注入縫（in-process mock IdP，
 * 見 `test/helpers/fake-idp.ts`），production（`index.ts`／`app.ts` 的 fallback）不傳。
 */
export function createOidcRuntime(oidc: OidcClientSettings, opts: OidcRuntimeOptions = {}): OidcRuntime {
  let cached: client.Configuration | undefined;
  let inflight: Promise<client.Configuration> | undefined;

  async function runDiscovery(): Promise<client.Configuration> {
    const issuerUrl = new URL(oidc.issuerUrl);

    // v6 預設 tlsOnly：issuer 為 http: 時（trusted-LAN 內網自架 IdP 拓撲，同
    // `config.ts` 的 insecureHttpWarning 精神）discovery 本身與後續請求都必須明傳
    // `allowInsecureRequests`，否則直接 throw（§14.3 MAJOR-1）；共用 `discoveryOptionsFor`。
    const discoveryOptions = discoveryOptionsFor(issuerUrl, opts.fetch);

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
      throw new OidcUnavailableError(`OIDC discovery 失敗（issuer=${safeTarget(oidc.issuerUrl)}）`, fetchErrorSummary(err));
    }

    // discovery 呼叫本身已透過 discoveryOptions 傳入同一個 fetch；這裡再顯式設一次
    // `configuration[client.customFetch]`，確保這個 Configuration 之後的所有個別請求
    // （token/userinfo/jwks，Task 9 消費）也走同一個 mock（§14.3 逐字：discovery 呼叫
    // 本身亦需傳同一 fetch）。
    if (opts.fetch) configuration[client.customFetch] = opts.fetch;

    assertUsableMetadata(configuration.serverMetadata(), oidc.issuerUrl);

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

/**
 * #187 PR2 §9.2：管理頁的「測試連線」與「先試探」——**只做 discovery**：client 認證用 `client.None()`、不解也不送 client
 * secret（spec §5.2「測試連線只做 discovery、不送 secret」）、不打 token endpoint、不經 registry 的快取（§6「/test 不經
 * registry、不寫快取」）。可用性判準與登入路徑共用 `assertUsableMetadata`。失敗一律 `OidcUnavailableError`。
 * ⚠ 驗不到 client id／secret 對不對（IdP 只有在真的換 token 時才會說）——文案要寫明（spec §9.2）。
 */
export async function probeOidcIssuer(issuerUrl: string, opts: OidcRuntimeOptions = {}): Promise<client.ServerMetadata> {
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    // 解析不了就沒有 safeTarget 可用——原字串可能帶憑證，乾脆不記。
    throw new OidcUnavailableError("OIDC issuer 不是合法網址");
  }
  let configuration: client.Configuration;
  try {
    configuration = await client.discovery(url, PROBE_CLIENT_ID, undefined, client.None(), discoveryOptionsFor(url, opts.fetch));
  } catch (err) {
    throw new OidcUnavailableError(`OIDC discovery 失敗（issuer=${safeTarget(issuerUrl)}）`, fetchErrorSummary(err));
  }
  const metadata = configuration.serverMetadata();
  assertUsableMetadata(metadata, issuerUrl);
  return metadata;
}

/** discovery API 要一個 client id 參數；試探不代表任何 client，用固定字面（不會送到 token endpoint——根本不打）。 */
const PROBE_CLIENT_ID = "knotebook-discovery-probe";

/**
 * #187 §7.1：login、callback、SSO 證明起點共用的**唯一** helper（管理頁顯示的 callbackUrl 也由它組，PR2）。legacy provider（env
 * 匯入）沿用舊路徑——IdP 端已註冊的回呼網址不必改；其餘一個 provider 一條。`new URL(絕對路徑, publicUrl)` 會丟掉 PUBLIC_URL 的
 * sub-path（`publicUrlPathWarning` 的提醒）。
 */
export function oidcRedirectUri(config: Pick<AppConfig, "publicUrl">, provider: { id: string; legacyCallback: boolean }): string {
  const path = provider.legacyCallback ? "/api/auth/oidc/callback" : `/api/auth/oidc/callback/${provider.id}`;
  return new URL(path, config.publicUrl).href;
}

/** r3-M3：`user_identities.issuer`／`auth_providers.resolved_issuer` 的上界（與 0014 的 CHECK 同值）。 */
export const MAX_ISSUER_LENGTH = 512;

export interface OidcRuntimeKey {
  id: string;
  issuerUrl: string;
  clientId: string;
  configVersion: number;
}

/**
 * #187 §6：per-app 的 runtime 表（嚴禁 module 單例，同 `createOidcRuntime`）。失效鍵 `(id, configVersion)`——
 * 登入路徑本來就要讀 provider 列，版本順手比對，所以 `invalidate` 漏叫也會自癒；issuer／client id 一併比對是防禦縱深
 * （PR2 的 PATCH 改它們必 +1 版本，§5.2）。`loadSecret` 只在建新 runtime 時呼叫；它失敗（secret 為 NULL、解不開）
 * 一律變成 `OidcUnavailableError`、不快取。`/test` 走 `probe`、不經快取（§6）。
 */
export interface OidcRuntimeRegistry {
  get(key: OidcRuntimeKey, loadSecret: () => Promise<string>): Promise<client.Configuration>;
  invalidate(id: string): void;
  /** #187 PR2：`probeOidcIssuer` 掛上本 registry 的 `opts.fetch`（測試注入縫只有一個）。**不讀不寫快取**——與 `get` 無關。 */
  probe(issuerUrl: string): Promise<client.ServerMetadata>;
}

export function createOidcRuntimeRegistry(opts: OidcRuntimeOptions = {}): OidcRuntimeRegistry {
  interface Entry extends OidcRuntimeKey {
    runtime: Promise<OidcRuntime>;
  }
  const entries = new Map<string, Entry>();
  return {
    async get(key, loadSecret) {
      let entry = entries.get(key.id);
      if (!entry || entry.configVersion !== key.configVersion || entry.issuerUrl !== key.issuerUrl || entry.clientId !== key.clientId) {
        const runtime = (async () => {
          let clientSecret: string;
          try {
            clientSecret = await loadSecret();
          } catch (err) {
            throw new OidcUnavailableError(`OIDC client secret 無法取得（provider=${key.id}）：${err instanceof Error ? err.message : String(err)}`);
          }
          return createOidcRuntime({ issuerUrl: key.issuerUrl, clientId: key.clientId, clientSecret }, opts);
        })();
        const created: Entry = { ...key, runtime };
        entries.set(key.id, created);
        // 失敗不快取：只刪「自己」這一筆（期間若已被新版本取代就不動它）。這個 catch 同時吞掉未處理拒絕——呼叫端另有 await。
        runtime.catch(() => {
          if (entries.get(key.id) === created) entries.delete(key.id);
        });
        entry = created;
      }
      // discovery 失敗由 runtime 自己不快取（下次重試）；這裡不刪 entry，in-flight 去重與既有三態語意不變。
      const runtime = await entry.runtime;
      return runtime.getConfiguration();
    },
    invalidate(id) {
      entries.delete(id);
    },
    probe(issuerUrl) {
      return probeOidcIssuer(issuerUrl, opts);
    },
  };
}
