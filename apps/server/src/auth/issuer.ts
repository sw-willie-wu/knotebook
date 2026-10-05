import type { AuthProviderPublicDto } from "@knotebook/shared";

// #187：issuer 字串的兩種比對，**刻意不同、不得互換**：
//
// - `sameIssuer`（`new URL(x).href` 精確相等；解析失敗＝不相等）——用在「推定」：env 匯入時以既有 identity 推 `resolved_issuer`
//   （`auth/tx/legacy-oidc-env.ts`，spec §10.2）。推錯會把別人的身分對到這個 provider，所以寧可推不出來（null）也不寬鬆。
// - `issuerKey`（`href` 再去掉一個結尾 `/`；解析失敗用原字串）——用在 B14 的同 issuer **排除**：決策（§7.4 第 4 步，
//   `oidc-login-decision.ts`）、`GET /api/auth/oidc/pending` 與 SSO 證明起點 `POST …/pending/prove/:providerId`（皆在 `routes/oidc-pending.ts`）一律經
//   `excludeSameIssuerProviders`。寧可多排除，不可漏排——漏排＝在證明本人之前洩漏「這帳號已連過這個 IdP」。
//   用 `sameIssuer` 會漏排 `https://idp.example/realms/x` 與 `…/realms/x/` 這種路徑只差結尾斜線的形（`new URL` 只替空路徑補
//   `/`：裸 origin 兩形 href 相同，帶路徑的兩形不同——node 實跑）。
//
// B2（`auth/tx/link-identity.ts`）兩者都不用：它比的是 `user_identities.issuer` 欄位與 pending 身分的 issuer，兩邊都是
// IdP discovery 回報的 issuer 原字串，SQL `eq` 精確比對（見該檔註解）。

/** URL 正規化精確相等。只用在 `resolved_issuer` 推定。 */
export function sameIssuer(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** 寬鬆比對形（去一個結尾 `/`）。只用在 B14 同 issuer 排除——請呼叫 `excludeSameIssuerProviders`，不要自己比。 */
export function issuerKey(issuer: string): string {
  try {
    return new URL(issuer).href.replace(/\/$/, "");
  } catch {
    return issuer;
  }
}

/**
 * B14（Task 6 裁定 A）：從「本帳號已連結且啟用中的 provider」排除 effective issuer 與待連結身分同 issuer 者，回給使用者看的形。
 * 排除不損功能：用同 issuer 證明，§7.5.4 必然 `identity_already_linked`。決策、pending GET、SSO 證明起點共用這一個函式。
 */
export function excludeSameIssuerProviders(
  providers: ReadonlyArray<AuthProviderPublicDto & { effectiveIssuer: string }>,
  pendingIssuer: string,
): AuthProviderPublicDto[] {
  const key = issuerKey(pendingIssuer);
  return providers.filter(p => issuerKey(p.effectiveIssuer) !== key).map(({ id, displayName }) => ({ id, displayName }));
}
