import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { AdminAuthSettingsDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { authProviders } from "../db/schema.js";

// #187 PR3：「這個帳號還能怎麼登入」的判斷，INV-7（§8.2 解除、§8.3 unlinkable，B24）、B19 P2 與 §9.5 actingAdminHasSso 共用。
// identity ↔ provider 一律以 effective issuer＝coalesce(resolved_issuer, issuer_url) **精確相等**（§4.1；寬鬆的 issuerKey
// 只用在 B14 排除，見 auth/issuer.ts）。密碼算不算數看 **DB 值**、不看 env（B24）——env 救援期間做出的狀態，拿掉 env 之後仍成立。

export interface EnabledProviderIssuer {
  id: string;
  displayName: string;
  template: string;
  effectiveIssuer: string;
}

/** 啟用中的 provider 與其 effective issuer（排序同登入頁）。收 `DbOrTx`：解除連結交易內以 tx 呼叫（S14）。 */
export async function enabledProvidersWithIssuer(q: DbOrTx): Promise<EnabledProviderIssuer[]> {
  return q
    .select({
      id: authProviders.id,
      displayName: authProviders.displayName,
      template: authProviders.template,
      effectiveIssuer: sql<string>`coalesce(${authProviders.resolvedIssuer}, ${authProviders.issuerUrl})`,
    })
    .from(authProviders)
    .where(eq(authProviders.enabled, true))
    .orderBy(asc(authProviders.sortOrder), asc(authProviders.createdAt), asc(authProviders.id));
}

/** 本帳號身分中「可用」者（issuer 等於某個啟用中 provider 的 effective issuer）。 */
export function usableIdentityIds(
  identities: ReadonlyArray<{ id: string; issuer: string }>,
  enabled: ReadonlyArray<{ effectiveIssuer: string }>,
): Set<string> {
  const issuers = new Set(enabled.map(p => p.effectiveIssuer));
  return new Set(identities.filter(i => issuers.has(i.issuer)).map(i => i.id));
}

/** INV-7：解除 `identityId` 之後，帳號仍有密碼（且 DB 值為真），或仍有另一個可用身分。 */
export function canUnlinkIdentity(
  identityId: string,
  s: { hasPassword: boolean; passwordLoginDbValue: boolean; usableIdentityIds: ReadonlySet<string> },
): boolean {
  if (s.hasPassword && s.passwordLoginDbValue) return true;
  for (const id of s.usableIdentityIds) if (id !== identityId) return true;
  return false;
}

/**
 * 「本人有一個 identity 對到某個啟用中 provider 的 effective issuer」的 SQL 述詞——B19 P2／§9.5 `actingAdminHasSso`
 * （`hasUsableSso`）與 §9.3 `actingAdminLockedOut`（`provider-impact.ts`，排除本服務）共用這一份，不另寫。
 * `exceptProviderId` 給值時，不計該 provider（以 provider 計、不以 issuer 計：同 issuer 的另一個服務仍算）。
 */
export function usableSsoExists(userId: string, exceptProviderId?: string): SQL {
  const except = exceptProviderId === undefined ? sql`` : sql` and p.id <> ${exceptProviderId}`;
  return sql`exists (
      select 1 from user_identities i
      join auth_providers p on i.issuer = coalesce(p.resolved_issuer, p.issuer_url)
      where i.user_id = ${userId} and p.enabled${except}
    )`;
}

/** B19 P2／§9.5 actingAdminHasSso：本人有一個 identity 對到某個啟用中 provider 的 effective issuer。 */
export async function hasUsableSso(q: DbOrTx, userId: string): Promise<boolean> {
  const result = await q.execute<{ ok: boolean }>(sql`select ${usableSsoExists(userId)} as ok`);
  return result.rows[0]!.ok;
}

/** §9.5 `passwordLoginImpact`（快照；權威判斷在 PATCH）。`actingAdminHasSso` 與 B19 P2 同一個函式（§14.1-28）。 */
export async function passwordLoginImpact(db: Db, actorUserId: string): Promise<AdminAuthSettingsDto["passwordLoginImpact"]> {
  const result = await db.execute<{ without_sso: number; enabled: number }>(sql`
    select
      (select count(*)::int from users u
        where u.disabled_at is null
          and not exists (
            select 1 from user_identities i
            join auth_providers p on i.issuer = coalesce(p.resolved_issuer, p.issuer_url)
            where i.user_id = u.id and p.enabled
          )) as without_sso,
      (select count(*)::int from auth_providers where enabled) as enabled`);
  const row = result.rows[0]!;
  return { usersWithoutSso: row.without_sso, actingAdminHasSso: await hasUsableSso(db, actorUserId), enabledProviders: row.enabled };
}
