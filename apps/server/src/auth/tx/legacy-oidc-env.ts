import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { authProviders, siteSettings, userIdentities } from "../../db/schema.js";
import { sealClientSecret } from "../oidc-providers.js";
// URL 正規化精確相等（discovery 比的就是 `new URL(x).href`，spec §2.2）；推定用精確、不用 B14 排除的寬鬆形——見 `auth/issuer.ts`。
import { sameIssuer } from "../issuer.js";

export interface LegacyOidcEnv {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export type LegacyImportOutcome =
  | { kind: "imported"; providerId: string; resolvedIssuer: string | null; insecure: boolean }
  | { kind: "already_handled" }
  | { kind: "providers_exist" }
  | { kind: "nothing_to_import" };

/**
 * #187 §10.2：env 舊三變數的一次性匯入。`site_settings FOR UPDATE` 序列化並發啟動（C4）；讀不到列 → throw（啟動失敗，§4.3）。
 * 不論有沒有匯入都設 `legacy_oidc_env_handled_at`——「首次」＝新版第一次啟動，之後補設 env 或刪光 provider 都不會再匯入。
 * 不跑 discovery；`resolved_issuer` 由既有 identity 推定：與 env issuer「URL 正規化相等」的 distinct issuer **恰一個**才填。
 * `providerId` 由外殼先產（client secret 的 AAD 綁它）。
 */
export async function importLegacyOidcEnvInTx(
  tx: Tx,
  input: { env: LegacyOidcEnv | undefined; appSecret: string; providerId: string },
): Promise<LegacyImportOutcome> {
  const locked = await tx
    .select({ handledAt: siteSettings.legacyOidcEnvHandledAt })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("update");
  if (locked.length !== 1) throw new Error("site_settings 讀不到列（INV-6 被破壞）：無法判斷 OIDC_* 是否已匯入，拒絕啟動");
  if (locked[0]!.handledAt !== null) return { kind: "already_handled" };

  let outcome: LegacyImportOutcome = { kind: "nothing_to_import" };
  if (input.env !== undefined) {
    const existing = await tx.select({ id: authProviders.id }).from(authProviders).limit(1);
    if (existing.length > 0) {
      outcome = { kind: "providers_exist" };
    } else {
      const env = input.env;
      const candidates = await tx.selectDistinct({ issuer: userIdentities.issuer }).from(userIdentities);
      const matches = candidates.map(c => c.issuer).filter(issuer => sameIssuer(issuer, env.issuerUrl));
      const resolvedIssuer = matches.length === 1 ? matches[0]! : null;
      await tx.insert(authProviders).values({
        id: input.providerId,
        template: "oidc",
        displayName: "SSO",
        issuerUrl: env.issuerUrl,
        resolvedIssuer,
        clientId: env.clientId,
        clientSecretEncrypted: sealClientSecret(input.appSecret, input.providerId, env.clientSecret),
        enabled: true,
        legacyCallback: true,
      });
      outcome = { kind: "imported", providerId: input.providerId, resolvedIssuer, insecure: /^http:\/\//.test(env.issuerUrl) };
    }
  }
  await tx.update(siteSettings).set({ legacyOidcEnvHandledAt: sql`now()`, updatedAt: sql`now()` }).where(eq(siteSettings.singleton, true));
  return outcome;
}
