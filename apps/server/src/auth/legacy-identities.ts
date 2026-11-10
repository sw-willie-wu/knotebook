import { sql } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/index.js";

/**
 * #187 §10.3：舊欄冪等補登。回滾到 v0.5 或滾動部署時舊碼會寫 `users.oidc_*`（含 verified-email 自動合併與建帳）；0014 不會重跑，
 * 所以每次開機收斂一次。不鎖 users（C16）；事後回查「舊欄指向的身分屬別人」→ warn、不改資料（也可能產生違反 B2 的列，r2-N4）。
 * PR3 的解除連結會同交易清掉吻合的舊欄，所以補登不會讓已解除的身分復活（§8.2）。
 */
export async function backfillLegacyOidcIdentities(db: Db, logger: pino.Logger): Promise<{ inserted: number; conflicts: number }> {
  const inserted = await db.execute(sql`
    insert into user_identities (user_id, issuer, sub)
      select id, oidc_issuer, oidc_sub from users where oidc_issuer is not null and oidc_sub is not null
    on conflict (issuer, sub) do nothing`);
  const conflicts = await db.execute<{ user_id: string; owner_id: string }>(sql`
    select u.id as user_id, i.user_id as owner_id from users u
      join user_identities i on i.issuer = u.oidc_issuer and i.sub = u.oidc_sub
     where i.user_id <> u.id`);
  for (const row of conflicts.rows) {
    logger.warn({ userId: row.user_id, ownerId: row.owner_id }, "legacy users.oidc_issuer/oidc_sub points at an identity that belongs to another account; left unchanged");
  }
  return { inserted: inserted.rowCount ?? 0, conflicts: conflicts.rows.length };
}
