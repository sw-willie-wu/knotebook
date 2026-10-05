import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { handles, siteSettings, userIdentities, users } from "../../db/schema.js";
import { deriveHandle } from "../handle.js";
import { linkedEnabledProviders } from "../oidc-providers.js";
import { decideOidcLogin, type OidcCandidateRow, type OidcClaims, type OidcRejectCode } from "../oidc-login-decision.js";

export type OidcLoginOutcome =
  | { kind: "login"; userId: string; tokenVersion: number }
  | { kind: "created"; userId: string; tokenVersion: number }
  | { kind: "confirm_link"; userId: string; email: string }
  | { kind: "reject"; code: OidcRejectCode };

export interface ResolveOidcLoginResult {
  outcome: OidcLoginOutcome;
  /** site_settings 讀不到列（INV-6 被破壞）：視同註冊關閉；呼叫端 log.error（§4.3）。 */
  settingsMissing: boolean;
}

/**
 * #187 交易表 A1（§7.4 執行層）。讀開關用 `FOR SHARE`（與關閉開關的 UPDATE、PR3 的註冊序列化，C9／C17）。
 * login 分支只 `UPDATE user_identities.last_login_at`、**不碰 users**（B15；因此與 A2 的「先 users 後 identity」無循環等待，C24）；
 * 並發解除連結讓它影響 0 列時照樣算 login（r3-N10）。create 分支 registry-first（handles → users → user_identities），
 * **不寫 users.oidc_***（舊欄只剩 §10.3 補登讀）。撞唯一鍵的錯誤原樣拋出，整 tx 重投由路由負責（C1）。
 */
export async function resolveOidcLoginInTx(tx: Tx, input: { claims: OidcClaims }): Promise<ResolveOidcLoginResult> {
  const { claims } = input;
  const settings = await tx
    .select({ registrationEnabled: siteSettings.registrationEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  const settingsMissing = settings.length !== 1;
  const registrationEnabled = settings[0]?.registrationEnabled ?? false;

  const [hit] = await tx
    .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash, tokenVersion: users.tokenVersion })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.issuer, claims.issuer), eq(userIdentities.sub, claims.sub)))
    .limit(1);
  const byIdentityUser: OidcCandidateRow | null =
    hit === undefined ? null : { id: hit.id, disabledAt: hit.disabledAt, hasPassword: hit.passwordHash !== null, linkedProviders: [] };

  const emailRows =
    hit === undefined && claims.email !== null
      ? await tx
          .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash })
          .from(users)
          .where(sql`lower(${users.email}) = ${claims.email}`)
          .orderBy(asc(users.createdAt), asc(users.id))
      : [];
  const byEmailUsers: OidcCandidateRow[] = [];
  for (const row of emailRows) {
    byEmailUsers.push({
      id: row.id,
      disabledAt: row.disabledAt,
      hasPassword: row.passwordHash !== null,
      linkedProviders: emailRows.length === 1 ? await linkedEnabledProviders(tx, row.id) : [],
    });
  }

  const decision = decideOidcLogin(claims, byIdentityUser, byEmailUsers, registrationEnabled);
  switch (decision.kind) {
    case "reject":
      return { outcome: { kind: "reject", code: decision.code }, settingsMissing };
    case "confirm_link":
      // email 恰等於 lower(users.email)（第 3 步的比對條件）；封進 pending cookie，§7.5 鎖內再比一次。
      return { outcome: { kind: "confirm_link", userId: decision.userId, email: claims.email! }, settingsMissing };
    case "login":
      await tx
        .update(userIdentities)
        .set({ lastLoginAt: sql`now()` })
        .where(and(eq(userIdentities.issuer, claims.issuer), eq(userIdentities.sub, claims.sub)));
      return { outcome: { kind: "login", userId: decision.userId, tokenVersion: hit!.tokenVersion }, settingsMissing };
    case "create": {
      const userId = randomUUID();
      const handle = await deriveHandle(tx, [decision.preferredUsername, decision.email.split("@")[0]], userId);
      await tx.insert(handles).values({ handle, userId, state: "live" });
      const [created] = await tx
        .insert(users)
        .values({ id: userId, email: decision.email, displayName: decision.displayName, passwordHash: null, mustChangePassword: false, handle })
        .returning({ tokenVersion: users.tokenVersion });
      await tx.insert(userIdentities).values({ userId, issuer: claims.issuer, sub: claims.sub, lastLoginAt: sql`now()` });
      return { outcome: { kind: "created", userId, tokenVersion: created!.tokenVersion }, settingsMissing };
    }
  }
}
