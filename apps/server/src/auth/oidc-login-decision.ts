import type { AuthProviderPublicDto } from "@knotebook/shared";

// #187 §7.4：SSO 登入的純決策（取代 Plan 5 的 `auth/oidc-decision.ts`）。不碰 DB；執行層是 `auth/tx/oidc-login.ts`。
// B3：IdP 的「email 已驗證」旗標不參與任何判斷，claims 型別上就沒有這個欄位（認人只靠 (issuer, sub)、接既有帳號要證明本人）。
// ⚠ 本檔註解不得出現那個 claim 的字面名稱：spec §14.1 第 20 條要求 apps/server/src 零命中（含註解）。
// B14：證明本人之前不判停用、不判 B2——兩者延到 `auth/tx/link-identity.ts` 的鎖內。B15：login 不帶任何清旗標的訊號。

/** `email` 已過 `normalizeEmail`（callback 進門）。`preferredUsername` 只當建帳當下的 handle 候選（#122）。 */
export interface OidcClaims {
  issuer: string;
  sub: string;
  email: string | null;
  name: string | null;
  preferredUsername: string | null;
}

/** 執行層查出的候選帳號。`linkedProviders`＝本帳號已連結、且 provider 啟用中者（只對「email 恰一列」那列計算，其餘給 []）。 */
export interface OidcCandidateRow {
  id: string;
  disabledAt: Date | null;
  hasPassword: boolean;
  linkedProviders: AuthProviderPublicDto[];
}

export interface ProofMethods {
  password: boolean;
  providers: AuthProviderPublicDto[];
}

export type OidcRejectCode = "account_disabled" | "oidc_email_missing" | "oidc_conflict" | "oidc_link_no_proof_method" | "registration_disabled";

export type OidcDecision =
  | { kind: "login"; userId: string }
  | { kind: "create"; email: string; displayName: string; preferredUsername: string | null }
  | { kind: "confirm_link"; userId: string; methods: ProofMethods }
  | { kind: "reject"; code: OidcRejectCode };

/**
 * 1. 身分命中 → 停用 ? account_disabled : login（已連結的身分不看註冊開關，W21）。
 * 2. email 為 null → oidc_email_missing（建帳與比對都需要 email）。
 * 3. lower(email) 多列（大小寫重複的舊列）→ oidc_conflict（不猜）。
 * 4. 恰一列 → methods（password＝有密碼；providers＝已連結且啟用中）；兩者皆空 → oidc_link_no_proof_method；否則 confirm_link
 *    （不看註冊開關：沒有建新帳號）。**不判停用、不判 B2**（B14）。
 * 5. 無列 → 註冊關閉 ? registration_disabled : create。
 */
export function decideOidcLogin(
  claims: OidcClaims,
  byIdentityUser: OidcCandidateRow | null,
  byEmailUsers: OidcCandidateRow[],
  registrationEnabled: boolean,
): OidcDecision {
  if (byIdentityUser !== null) {
    return byIdentityUser.disabledAt !== null ? { kind: "reject", code: "account_disabled" } : { kind: "login", userId: byIdentityUser.id };
  }
  if (claims.email === null) return { kind: "reject", code: "oidc_email_missing" };
  if (byEmailUsers.length > 1) return { kind: "reject", code: "oidc_conflict" };
  const existing = byEmailUsers[0];
  if (existing !== undefined) {
    const methods: ProofMethods = { password: existing.hasPassword, providers: existing.linkedProviders };
    if (!methods.password && methods.providers.length === 0) return { kind: "reject", code: "oidc_link_no_proof_method" };
    return { kind: "confirm_link", userId: existing.id, methods };
  }
  if (!registrationEnabled) return { kind: "reject", code: "registration_disabled" };
  // `||`：IdP 可能回 `name: ""`（沿用 Plan 5 的理由——空字串顯示名沒有補救路徑）。
  const displayName = claims.name || claims.email.split("@")[0] || claims.email;
  return { kind: "create", email: claims.email, displayName, preferredUsername: claims.preferredUsername };
}
