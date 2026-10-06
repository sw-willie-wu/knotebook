import { sql } from "drizzle-orm";
import type { AdminAuthProviderImpactDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";

/**
 * #187 §9.3：停用一個登入服務前的受影響人數（快照）。identity ↔ provider 一律以 effective issuer
 * ＝`coalesce(resolved_issuer, issuer_url)` **精確相等**對照（§4.1；與 `linkedEnabledProvidersWithIssuer` 同一形）——
 * `resolved_issuer` 為 NULL 時可能對不上（尾斜線形），回應帶 `issuerResolved` 讓頁面說明「人數可能不準」。
 *
 * - linkedUsers：有 identity 對到本服務、且未停用的帳號（同一帳號只算一次）。
 * - lockedOutUsers：其中**無密碼**、且沒有任何 identity 對到「**其他**啟用中服務」（`p2.id <> 本服務`）的帳號。
 *   ⚠ 「其他服務」以 provider 計、不以 identity 計：兩個服務指向同一個 issuer 時，同一個 identity 也能經另一個登入（RF2；
 *   spec §9.3 寫「其他 identity」，見 plan spec 疑點 1）。
 * W24 預留（PR3）：「無密碼」這一個述詞（`l.password_hash is null`）會改成「無密碼或帳密登入開關的 DB 值為關」（本檔刻意不寫欄名字面——Task 12 grep 終檢第 1 條），
 * 並加 `actingAdminLockedOut`——公式只在這裡。
 */
export async function providerImpact(db: Db, providerId: string): Promise<AdminAuthProviderImpactDto | null> {
  const result = await db.execute<{ linked: number; locked: number; resolved: boolean | null }>(sql`
    with p as (
      select coalesce(resolved_issuer, issuer_url) as eff, resolved_issuer is not null as resolved
      from auth_providers where id = ${providerId}
    ),
    linked as (
      select distinct u.id, u.password_hash
      from p
      join user_identities i on i.issuer = p.eff
      join users u on u.id = i.user_id
      where u.disabled_at is null
    )
    select
      (select count(*)::int from linked) as linked,
      (select count(*)::int from linked l
         where l.password_hash is null
           and not exists (
             select 1 from user_identities i2
             join auth_providers p2 on i2.issuer = coalesce(p2.resolved_issuer, p2.issuer_url)
             where i2.user_id = l.id and p2.enabled and p2.id <> ${providerId}
           )) as locked,
      (select resolved from p) as resolved
  `);
  const row = result.rows[0];
  if (!row || row.resolved === null) return null;
  return { linkedUsers: row.linked, lockedOutUsers: row.locked, issuerResolved: row.resolved };
}
