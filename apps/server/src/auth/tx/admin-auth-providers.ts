import { sql } from "drizzle-orm";
import { authProviders } from "../../db/schema.js";

// #187 PR2：站台管理對 `auth_providers` 的交易本體（S14：只收 tx、只做 DB）。列表、POST 的 RETURNING 與本檔的 UPDATE
// RETURNING 共用 `adminProviderColumns()`——`hasSecret` 由 SQL 端 `is not null` 算，**從不** SELECT 密文本體（INV-5；
// 比照 `routes/admin-ai.ts` 的 `providerListColumns`）。

export interface AdminProviderRow {
  id: string;
  template: string;
  displayName: string;
  issuerUrl: string;
  clientId: string;
  enabled: boolean;
  sortOrder: number;
  legacyCallback: boolean;
  configVersion: number;
  createdAt: Date;
  hasSecret: boolean;
  issuerResolved: boolean;
}

/** 每次現造（drizzle 的 `sql` 片段與 select 形不重用）。`createdAt` 必須是欄位本身——raw `sql` 選時間戳回字串。 */
export function adminProviderColumns() {
  return {
    id: authProviders.id,
    template: authProviders.template,
    displayName: authProviders.displayName,
    issuerUrl: authProviders.issuerUrl,
    clientId: authProviders.clientId,
    enabled: authProviders.enabled,
    sortOrder: authProviders.sortOrder,
    legacyCallback: authProviders.legacyCallback,
    configVersion: authProviders.configVersion,
    createdAt: authProviders.createdAt,
    hasSecret: sql<boolean>`${authProviders.clientSecretEncrypted} is not null`,
    issuerResolved: sql<boolean>`${authProviders.resolvedIssuer} is not null`,
  };
}
