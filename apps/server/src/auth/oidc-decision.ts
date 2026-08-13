// OIDC 帳號解析的純決策函式（spec §14.3 兩段式的第一段）——不碰 DB，執行層（Task 9
// callback route）負責先查出 byOidcUser/byEmailUsers 候選列，再把三個純資料丟進來換一個
// OidcDecision，依決策結果做寫入與簽 session。disabled 檢查在所有三個可登入出口（分支 1 的
// login、分支 3 的 boundToSame login、分支 3 的 link）內都判掉，執行層不再需要補查。

/** claims.email 必須已過 normalizeEmail（callback 進門正規化——§14.3 讀取端 ③）。 */
export interface OidcClaims {
  issuer: string;
  sub: string;
  email: string | null;
  emailVerified: boolean | null; // 缺欄位＝null
  name: string | null;
}

/** 執行層以 lower() 查出的候選列；欄位集合＝§14.3 明訂的 UserRow 最小集。 */
export interface OidcUserRow {
  id: string;
  email: string;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  oidcIssuer: string | null;
  oidcSub: string | null;
}

export type OidcDecision =
  | { kind: "login"; userId: string; clearMustChange: boolean } // (issuer,sub) 命中
  | { kind: "link"; userId: string; clearMustChange: boolean } // email 命中，寫 oidc 欄後登入
  | { kind: "create"; email: string; displayName: string } // 自動建帳
  | {
      kind: "reject";
      code: "account_disabled" | "oidc_conflict" | "oidc_email_unverified" | "oidc_email_missing";
      conflictReason?: "multi_email_match" | "bound_to_other_identity"; // reason＝oidc_conflict 兩義 log 區分承載（§14.3）
    };

/**
 * 決策順序（§14.3 逐字落地，見 task-7-brief.md）：
 * 1. `byOidcUser` 非 null → disabled 檢查 → login（優先於 `byEmailUsers`——即使
 *    `byEmailUsers` 有多列甚至觸發分支 2 的條件，(issuer,sub) 命中一律先判）。
 * 2. `byEmailUsers.length > 1` → conflict（multi_email_match，lower() 多列不猜）。
 * 3. `byEmailUsers.length === 1` → disabled 檢查 → 已綁相同 identity 檢查（冪等重入防禦，
 *    等價 login；此分支刻意繞過 emailVerified 閘門——已經是同一個 (issuer,sub) 在登入，
 *    不該因為這次 IdP 回傳 email_verified=false 就擋下）→ 已綁其他 identity 檢查
 *    （`boundToOther` 只判 `oidcIssuer !== null`，是簡化式：能執行到這一行代表上一步的
 *    boundToSame 已經排除「相同」的情況，順序依賴，不可對調）→ verified 檢查 → link。
 * 4. `byEmailUsers` 空 → email 缺檢查 → verified 檢查（建帳同一閘門，§14.3 MAJOR-5）→ create。
 */
export function decideOidcLogin(
  claims: OidcClaims,
  byOidcUser: OidcUserRow | null,
  byEmailUsers: OidcUserRow[],
): OidcDecision {
  if (byOidcUser !== null) {
    if (byOidcUser.disabledAt !== null) {
      return { kind: "reject", code: "account_disabled" };
    }
    return { kind: "login", userId: byOidcUser.id, clearMustChange: byOidcUser.mustChangePassword };
  }

  if (byEmailUsers.length > 1) {
    return { kind: "reject", code: "oidc_conflict", conflictReason: "multi_email_match" };
  }

  if (byEmailUsers.length === 1) {
    const row = byEmailUsers[0];
    if (row.disabledAt !== null) {
      return { kind: "reject", code: "account_disabled" };
    }

    const boundToSame = row.oidcIssuer !== null && row.oidcIssuer === claims.issuer && row.oidcSub === claims.sub;
    if (boundToSame) {
      return { kind: "login", userId: row.id, clearMustChange: row.mustChangePassword };
    }

    const boundToOther = row.oidcIssuer !== null;
    if (boundToOther) {
      return { kind: "reject", code: "oidc_conflict", conflictReason: "bound_to_other_identity" };
    }

    if (claims.emailVerified === true) {
      return { kind: "link", userId: row.id, clearMustChange: row.mustChangePassword };
    }
    return { kind: "reject", code: "oidc_email_unverified" };
  }

  if (claims.email === null) {
    return { kind: "reject", code: "oidc_email_missing" };
  }
  if (claims.emailVerified !== true) {
    return { kind: "reject", code: "oidc_email_unverified" };
  }
  // `||`（非 `??`）：與 env bootstrap 同慣例（bootstrap.ts 的 `email.split("@")[0] || email`）
  // ——IdP 可能回傳 `name: ""`（空字串，非缺欄位），`??` 只擋 null/undefined 會讓空字串
  // displayName 直接落地且 v0.1 無補救路徑，故用 `||` 把空字串也視為「缺」一併回退。
  // 尾巴 `|| claims.email`：`split("@")[0]` 理論上不會是空字串（email 已過 normalizeEmail
  // 保證含 "@"），留著當 local-part 意外為空字串時的最後防線。
  const displayName = claims.name || claims.email.split("@")[0] || claims.email;
  return { kind: "create", email: claims.email, displayName };
}
