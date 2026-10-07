import { describe, expect, it } from "vitest";
import { decideOidcLogin, type OidcCandidateRow, type OidcClaims } from "../../src/auth/oidc-login-decision.js";

const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({
  issuer: "https://idp.example", sub: "s1", email: "u@example.com", name: "U Name", preferredUsername: null, ...over,
});
const row = (over: Partial<OidcCandidateRow> = {}): OidcCandidateRow => ({
  id: "u1", disabledAt: null, hasPassword: true, linkedProviders: [], ...over,
});
const P = { id: "p1", displayName: "GitLab", icon: null, effectiveIssuer: "https://gitlab.example" };
const PDto = { id: "p1", displayName: "GitLab", icon: null };
/** 與 claims() 的 issuer 同一個 IdP 的 provider（本次登入必經它進來）。 */
const SELF = (effectiveIssuer = "https://idp.example") => ({ id: "self", displayName: "IdP", icon: null, effectiveIssuer });

describe("decideOidcLogin（#187 §7.4）", () => {
  it("1. 身分命中 → login（不看註冊開關，W21；不看 email 列）", () => {
    expect(decideOidcLogin(claims(), row(), [row({ id: "x" }), row({ id: "y" })], false)).toEqual({ kind: "login", userId: "u1" });
  });
  it("1. 身分命中但停用 → account_disabled", () => {
    expect(decideOidcLogin(claims(), row({ disabledAt: new Date() }), [], true)).toEqual({ kind: "reject", code: "account_disabled" });
  });
  it("2. 未命中且 email 為 null → oidc_email_missing（不論開關、不論 email 列）", () => {
    expect(decideOidcLogin(claims({ email: null }), null, [], true)).toEqual({ kind: "reject", code: "oidc_email_missing" });
  });
  it("3. lower(email) 多列 → oidc_conflict（不猜）", () => {
    expect(decideOidcLogin(claims(), null, [row({ id: "a" }), row({ id: "b" })], true)).toEqual({ kind: "reject", code: "oidc_conflict" });
  });
  it("4. 恰一列、有密碼 → confirm_link，methods.password=true", () => {
    expect(decideOidcLogin(claims(), null, [row()], true)).toEqual({ kind: "confirm_link", userId: "u1", methods: { password: true, providers: [] } });
  });
  it("4. 恰一列、純 SSO、已連結的 provider 啟用中 → confirm_link，methods 只有 providers", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [P] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: false, providers: [PDto] },
    });
  });
  it("4. B14：與本次登入同 issuer 的已連結 provider 不列入 methods（列了就在證明前洩漏「已連過這個 IdP」）", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF(), P] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: false, providers: [PDto] },
    });
    expect(decideOidcLogin(claims(), null, [row({ linkedProviders: [SELF()] })], true)).toEqual({
      kind: "confirm_link", userId: "u1", methods: { password: true, providers: [] },
    });
  });
  it("4.1 B14：只連過同 issuer、無密碼 → oidc_link_no_proof_method；尾斜線形也算同 issuer（兩個方向）", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF()] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false, linkedProviders: [SELF("https://idp.example/")] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims({ issuer: "https://idp.example/" }), null, [row({ hasPassword: false, linkedProviders: [SELF()] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(decideOidcLogin(claims({ issuer: "https://idp.example/realms/x" }), null, [row({ hasPassword: false, linkedProviders: [SELF("https://idp.example/realms/x/")] })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });
  it("4.1 兩者皆空 → oidc_link_no_proof_method", () => {
    expect(decideOidcLogin(claims(), null, [row({ hasPassword: false })], true)).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });
  it("4. B14：停用帳號在證明前仍回 confirm_link（不洩漏停用）", () => {
    expect(decideOidcLogin(claims(), null, [row({ disabledAt: new Date() })], true).kind).toBe("confirm_link");
  });
  it("4.2 confirm_link 不看註冊開關（W21：沒有建新帳號）", () => {
    expect(decideOidcLogin(claims(), null, [row()], false).kind).toBe("confirm_link");
  });
  it("5. 無列、註冊關閉 → registration_disabled", () => {
    expect(decideOidcLogin(claims(), null, [], false)).toEqual({ kind: "reject", code: "registration_disabled" });
  });
  it("5. 無列、註冊開啟 → create；displayName 取 name、空字串退 email local-part", () => {
    expect(decideOidcLogin(claims({ preferredUsername: "Cool" }), null, [], true)).toEqual({
      kind: "create", email: "u@example.com", displayName: "U Name", preferredUsername: "Cool",
    });
    expect(decideOidcLogin(claims({ name: "" }), null, [], true)).toMatchObject({ kind: "create", displayName: "u" });
    expect(decideOidcLogin(claims({ name: null }), null, [], true)).toMatchObject({ kind: "create", displayName: "u" });
  });
});
