import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pino from "pino";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { importLegacyOidcEnvInTx, type LegacyImportOutcome } from "./tx/legacy-oidc-env.js";

const IGNORED_MESSAGE = "OIDC_* are ignored; configure SSO in Site admin → Sign-in";

/**
 * #187 §10.2 外殼：`initializeInstance` 之後、listen 之前呼叫（`index.ts`，結構守衛在 `test/unit/config.test.ts`）。
 * 交易本體在 `auth/tx/`（S14）；log 一律在 commit 之後印。
 */
export async function importLegacyOidcEnv(
  db: Db,
  config: Pick<AppConfig, "appSecret" | "legacyOidcEnv" | "legacyOidcEnvProblem">,
  logger: pino.Logger,
): Promise<LegacyImportOutcome> {
  const input = { env: config.legacyOidcEnv, appSecret: config.appSecret, providerId: randomUUID() };
  const outcome = await db.transaction(tx => importLegacyOidcEnvInTx(tx, input));
  const envPresent = config.legacyOidcEnv !== undefined || config.legacyOidcEnvProblem !== undefined;
  if (config.legacyOidcEnvProblem !== undefined) {
    logger.warn({ problem: config.legacyOidcEnvProblem }, "OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET are incomplete or invalid and were not imported; configure SSO in Site admin → Sign-in");
  } else if (outcome.kind === "imported") {
    logger.info({ providerId: outcome.providerId, resolvedIssuer: outcome.resolvedIssuer }, "imported OIDC_* as a sign-in provider (legacy callback URL kept); you can now remove OIDC_* from .env");
    if (outcome.insecure) {
      logger.warn({ issuerUrl: config.legacyOidcEnv!.issuerUrl }, "SECURITY WARNING: the imported OIDC issuer uses plain http — tokens and claims travel in cleartext between this server and the identity provider");
    }
  } else if (envPresent) {
    logger.warn(IGNORED_MESSAGE);
  }
  return outcome;
}

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
