import { and, asc, eq, sql } from "drizzle-orm";
import type * as client from "openid-client";
import type { AuthProviderPublicDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders, userIdentities } from "../db/schema.js";
import { openSecret, sealSecret, type EncryptedSecret } from "../lib/sealed-secret.js";
import type { OidcRuntimeRegistry } from "./oidc-client.js";

// #187：provider 列的讀取與 identity ↔ provider 對照。**所有對照一律用 effective issuer**
// ＝`coalesce(resolved_issuer, issuer_url)`（spec §4.1 r1-I1；§18 排他句「plan 以 grep `issuer_url =` 複驗」）。

export const OIDC_CLIENT_SECRET_NAMESPACE = "oidc-client-secret";

export function clientSecretAad(providerId: string): string {
  return `oidc-client-secret:v1:${providerId}`;
}

export function sealClientSecret(appSecret: string, providerId: string, plaintext: string): EncryptedSecret {
  return sealSecret(appSecret, OIDC_CLIENT_SECRET_NAMESPACE, plaintext, clientSecretAad(providerId));
}

export function openClientSecret(appSecret: string, provider: { id: string; clientSecretEncrypted: unknown }): string {
  return openSecret(appSecret, OIDC_CLIENT_SECRET_NAMESPACE, provider.clientSecretEncrypted, clientSecretAad(provider.id));
}

export interface OidcProviderRow {
  id: string;
  displayName: string;
  issuerUrl: string;
  resolvedIssuer: string | null;
  clientId: string;
  clientSecretEncrypted: EncryptedSecret | null;
  enabled: boolean;
  legacyCallback: boolean;
  configVersion: number;
}

/** 每次現造（drizzle select builder 單次使用）。 */
function providerColumns() {
  return {
    id: authProviders.id,
    displayName: authProviders.displayName,
    issuerUrl: authProviders.issuerUrl,
    resolvedIssuer: authProviders.resolvedIssuer,
    clientId: authProviders.clientId,
    clientSecretEncrypted: authProviders.clientSecretEncrypted,
    enabled: authProviders.enabled,
    legacyCallback: authProviders.legacyCallback,
    configVersion: authProviders.configVersion,
  };
}

/** `id` 必須已過 UUID_RE 並轉小寫（呼叫端負責）。 */
export async function loadEnabledProvider(db: DbOrTx, id: string): Promise<OidcProviderRow | null> {
  const [row] = await db.select(providerColumns()).from(authProviders).where(and(eq(authProviders.id, id), eq(authProviders.enabled, true))).limit(1);
  return row ?? null;
}

/** 舊路由（`/api/auth/oidc/login`、`/callback`，B13）對應的那一個 provider。 */
export async function loadLegacyProvider(db: DbOrTx): Promise<OidcProviderRow | null> {
  const [row] = await db
    .select(providerColumns())
    .from(authProviders)
    .where(and(eq(authProviders.legacyCallback, true), eq(authProviders.enabled, true)))
    .limit(1);
  return row ?? null;
}

export async function listEnabledProvidersPublic(db: DbOrTx): Promise<AuthProviderPublicDto[]> {
  return db
    .select({ id: authProviders.id, displayName: authProviders.displayName })
    .from(authProviders)
    .where(eq(authProviders.enabled, true))
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
}

/**
 * 本帳號「可用來證明本人」的 provider（§7.4 第 4 步 methods.providers、§7.5.2、§7.5.3 第 2 步）：啟用中，且本帳號有一個
 * identity 的 issuer 等於它的 effective issuer。收 `DbOrTx`：決策交易內以 tx 呼叫（S14：tx 內不得回頭用 pool）。
 */
export async function linkedEnabledProviders(q: DbOrTx, userId: string): Promise<AuthProviderPublicDto[]> {
  return q
    .select({ id: authProviders.id, displayName: authProviders.displayName })
    .from(authProviders)
    .where(
      and(
        eq(authProviders.enabled, true),
        sql`exists (select 1 from ${userIdentities} where ${userIdentities.userId} = ${userId} and ${userIdentities.issuer} = coalesce(${authProviders.resolvedIssuer}, ${authProviders.issuerUrl}))`,
      ),
    )
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
}

/**
 * spec §4.1：`resolved_issuer` 的寫入一律帶版本述詞、不在任何交易內（S14）。舊版本的 discovery 結果不得蓋掉新設定（PR2 改
 * issuer 會清 resolved_issuer 並 +1 版本）；值相同不寫（`IS DISTINCT FROM`）。回「真的寫了一列」。
 */
export async function recordResolvedIssuer(db: Db, provider: { id: string; configVersion: number }, issuer: string): Promise<boolean> {
  const rows = await db
    .update(authProviders)
    .set({ resolvedIssuer: issuer })
    .where(
      and(
        eq(authProviders.id, provider.id),
        eq(authProviders.configVersion, provider.configVersion),
        sql`${authProviders.resolvedIssuer} is distinct from ${issuer}`,
      ),
    )
    .returning({ id: authProviders.id });
  return rows.length === 1;
}

/**
 * login／callback／SSO 證明起點共用：從 registry 取 discovery 結果（secret 只在建 runtime 時解），discovery 回報的 issuer
 * 與列上 `resolved_issuer` 不同就以版本述詞寫回（spec §6「第一次 discovery 成功後以版本述詞寫 resolved_issuer」——
 * registry 不碰 DB，由這裡寫；見 plan「spec 疑點」第 7 條）。失敗一律 `OidcUnavailableError`（registry 已包）。
 */
export async function providerConfiguration(
  deps: { db: Db; registry: OidcRuntimeRegistry; appSecret: string },
  provider: OidcProviderRow,
): Promise<client.Configuration> {
  const configuration = await deps.registry.get(
    { id: provider.id, issuerUrl: provider.issuerUrl, clientId: provider.clientId, configVersion: provider.configVersion },
    async () => openClientSecret(deps.appSecret, provider),
  );
  const issuer = configuration.serverMetadata().issuer;
  if (provider.resolvedIssuer !== issuer) await recordResolvedIssuer(deps.db, provider, issuer);
  return configuration;
}
