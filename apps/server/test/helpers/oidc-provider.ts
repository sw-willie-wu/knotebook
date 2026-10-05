import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../src/db/index.js";
import { authProviders, userIdentities } from "../../src/db/schema.js";
import { sealClientSecret, type OidcProviderRow } from "../../src/auth/oidc-providers.js";
import { testConfig } from "../helpers.js";

export interface SeedProviderOpts {
  issuerUrl: string;
  id?: string;
  template?: "gitlab" | "google" | "oidc";
  displayName?: string;
  clientId?: string;
  /** null＝不存 secret（此時 `enabled` 必須為 false，否則 CHECK 擋）。 */
  clientSecret?: string | null;
  enabled?: boolean;
  legacyCallback?: boolean;
  sortOrder?: number;
  resolvedIssuer?: string | null;
  configVersion?: number;
}

/** 直接寫 `auth_providers`（PR2 才有管理 API）。secret 以 `testConfig.appSecret` 封——`buildTestApp` 預設 config 同一把。 */
export async function seedAuthProvider(db: Db, opts: SeedProviderOpts): Promise<OidcProviderRow> {
  const id = opts.id ?? randomUUID();
  const secret = opts.clientSecret === undefined ? "test-secret" : opts.clientSecret;
  const [row] = await db
    .insert(authProviders)
    .values({
      id,
      template: opts.template ?? "oidc",
      displayName: opts.displayName ?? "SSO",
      issuerUrl: opts.issuerUrl,
      resolvedIssuer: opts.resolvedIssuer ?? null,
      clientId: opts.clientId ?? "test-client",
      clientSecretEncrypted: secret === null ? null : sealClientSecret(testConfig.appSecret, id, secret),
      enabled: opts.enabled ?? true,
      legacyCallback: opts.legacyCallback ?? false,
      sortOrder: opts.sortOrder ?? 0,
      configVersion: opts.configVersion ?? 1,
    })
    .returning();
  return {
    id: row!.id,
    displayName: row!.displayName,
    issuerUrl: row!.issuerUrl,
    resolvedIssuer: row!.resolvedIssuer,
    clientId: row!.clientId,
    clientSecretEncrypted: row!.clientSecretEncrypted,
    enabled: row!.enabled,
    legacyCallback: row!.legacyCallback,
    configVersion: row!.configVersion,
  };
}

export async function identitiesOf(db: Db, userId: string): Promise<Array<{ issuer: string; sub: string }>> {
  return db
    .select({ issuer: userIdentities.issuer, sub: userIdentities.sub })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.issuer), asc(userIdentities.sub));
}
