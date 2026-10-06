import { randomUUID } from "node:crypto";
import { normalizeEmail } from "@knotebook/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { handles, siteSettings, userIdentities, users } from "../../db/schema.js";
import { deriveHandle } from "../handle.js";
import { linkedEnabledProvidersWithIssuer } from "../oidc-providers.js";
import type { OidcTestHook } from "../oidc-test-hook.js";
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
export async function resolveOidcLoginInTx(tx: Tx, input: { claims: OidcClaims }, hook?: OidcTestHook): Promise<ResolveOidcLoginResult> {
  // 縱深防禦（fix round 1 Minor 1）：callback 進門已正規化，這裡再做一次——`users_email_unique` 大小寫敏感，
  // 漏正規化的 email 會讓第 3 步的 lower() 比對落空、走去建一個只差大小寫的重複帳號。
  const claims: OidcClaims = { ...input.claims, email: input.claims.email === null ? null : normalizeEmail(input.claims.email) };
  const settings = await tx
    .select({ registrationEnabled: siteSettings.registrationEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("share");
  const settingsMissing = settings.length !== 1;
  const registrationEnabled = settings[0]?.registrationEnabled ?? false;

  // drizzle select builder 單次使用：每次呼叫現造。
  const identityQuery = async () =>
    (
      await tx
        .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash, tokenVersion: users.tokenVersion })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.issuer, claims.issuer), eq(userIdentities.sub, claims.sub)))
        .limit(1)
    )[0];
  let hit = await identityQuery();

  if (hit === undefined) await hook?.("login-identity-missed", { issuer: claims.issuer, sub: claims.sub });
  const emailRows =
    hit === undefined && claims.email !== null
      ? await tx
          .select({ id: users.id, disabledAt: users.disabledAt, passwordHash: users.passwordHash })
          .from(users)
          .where(sql`lower(${users.email}) = ${claims.email}`)
          .orderBy(asc(users.createdAt), asc(users.id))
      : [];
  // Task 6b（TOCTOU）：READ COMMITTED 每句各取快照。同一 (issuer, sub) 的另一條首次登入（或 §7.5 連結）若在上面兩句之間
  // commit，email 查詢會命中它的帳號、身分查詢卻落空——照舊走第 4 步會對本人回 confirm_link／oidc_link_no_proof_method。
  // email 命中時、決策之前一律重查身分：對方是 create 分支時，看得到它的 users 列就看得到它同一交易寫入的 identity
  // （連結交易則只在它於重查前 commit 時接得到）。命中就當第 1 步的輸入重新餵給決策（停用照判 account_disabled），
  // 不另開 login 捷徑；此時 email 列不再算候選（第 1 步先決）。
  if (emailRows.length > 0) hit = await identityQuery();
  const byIdentityUser: OidcCandidateRow | null =
    hit === undefined ? null : { id: hit.id, disabledAt: hit.disabledAt, hasPassword: hit.passwordHash !== null, linkedProviders: [] };

  const byEmailUsers: OidcCandidateRow[] = [];
  for (const row of hit === undefined ? emailRows : []) {
    byEmailUsers.push({
      id: row.id,
      disabledAt: row.disabledAt,
      hasPassword: row.passwordHash !== null,
      linkedProviders: emailRows.length === 1 ? await linkedEnabledProvidersWithIssuer(tx, row.id) : [],
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
