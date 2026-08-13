import { describe, it, expect } from "vitest";
import { decideOidcLogin, type OidcClaims, type OidcUserRow } from "../../src/auth/oidc-decision.js";

function claims(overrides: Partial<OidcClaims> = {}): OidcClaims {
  return {
    issuer: "https://idp.example.com",
    sub: "sub-abc",
    email: "user@example.com",
    emailVerified: true,
    name: "User Name",
    ...overrides,
  };
}

function userRow(overrides: Partial<OidcUserRow> = {}): OidcUserRow {
  return {
    id: "user-1",
    email: "user@example.com",
    disabledAt: null,
    mustChangePassword: false,
    oidcIssuer: null,
    oidcSub: null,
    ...overrides,
  };
}

describe("auth/oidc-decision：decideOidcLogin 純決策函式（不碰 DB，§14.3 全分支）", () => {
  describe("分支 1：byOidcUser 非 null（(issuer,sub) 命中）", () => {
    it("正常 → login，clearMustChange 承 mustChangePassword=false", () => {
      const row = userRow({ id: "user-1", mustChangePassword: false });
      expect(decideOidcLogin(claims(), row, [])).toEqual({
        kind: "login",
        userId: "user-1",
        clearMustChange: false,
      });
    });

    it("disabled → reject account_disabled（優先於 login，寫入/簽 session 之前擋下）", () => {
      const row = userRow({ id: "user-1", disabledAt: new Date("2026-01-01T00:00:00Z") });
      expect(decideOidcLogin(claims(), row, [])).toEqual({
        kind: "reject",
        code: "account_disabled",
      });
    });

    it("命中且 mustChangePassword=true → clearMustChange=true", () => {
      const row = userRow({ id: "user-1", mustChangePassword: true });
      expect(decideOidcLogin(claims(), row, [])).toEqual({
        kind: "login",
        userId: "user-1",
        clearMustChange: true,
      });
    });

    it("命中優先於 byEmailUsers（即使 byEmailUsers 有多列也不查、不觸發 conflict）→ login", () => {
      const row = userRow({ id: "user-1", mustChangePassword: false });
      const emailRows = [userRow({ id: "user-2" }), userRow({ id: "user-3" })];
      expect(decideOidcLogin(claims(), row, emailRows)).toEqual({
        kind: "login",
        userId: "user-1",
        clearMustChange: false,
      });
    });
  });

  describe("分支 2：byEmailUsers.length > 1 → conflict（多列不猜）", () => {
    it("多列命中 → reject oidc_conflict，conflictReason=multi_email_match", () => {
      const rows = [userRow({ id: "user-1" }), userRow({ id: "user-2" })];
      expect(decideOidcLogin(claims(), null, rows)).toEqual({
        kind: "reject",
        code: "oidc_conflict",
        conflictReason: "multi_email_match",
      });
    });
  });

  describe("分支 3：byEmailUsers.length === 1（email 連結）", () => {
    it("verified=true → link，clearMustChange 承該列 mustChangePassword", () => {
      const row = userRow({ id: "user-1", mustChangePassword: true });
      expect(decideOidcLogin(claims({ emailVerified: true }), null, [row])).toEqual({
        kind: "link",
        userId: "user-1",
        clearMustChange: true,
      });
    });

    it("verified=false → reject oidc_email_unverified", () => {
      const row = userRow({ id: "user-1" });
      expect(decideOidcLogin(claims({ emailVerified: false }), null, [row])).toEqual({
        kind: "reject",
        code: "oidc_email_unverified",
      });
    });

    it("verified 缺（null）→ reject oidc_email_unverified", () => {
      const row = userRow({ id: "user-1" });
      expect(decideOidcLogin(claims({ emailVerified: null }), null, [row])).toEqual({
        kind: "reject",
        code: "oidc_email_unverified",
      });
    });

    it("disabled → reject account_disabled（優先於 verified 檢查）", () => {
      const row = userRow({ id: "user-1", disabledAt: new Date("2026-01-01T00:00:00Z") });
      expect(decideOidcLogin(claims({ emailVerified: true }), null, [row])).toEqual({
        kind: "reject",
        code: "account_disabled",
      });
    });

    it("已綁其他 (issuer,sub) → reject oidc_conflict，conflictReason=bound_to_other_identity", () => {
      const row = userRow({
        id: "user-1",
        oidcIssuer: "https://other-idp.example.com",
        oidcSub: "other-sub",
      });
      expect(decideOidcLogin(claims({ emailVerified: true }), null, [row])).toEqual({
        kind: "reject",
        code: "oidc_conflict",
        conflictReason: "bound_to_other_identity",
      });
    });

    it("同 issuer、不同 sub（半個相符不算相同 identity）→ reject oidc_conflict/bound_to_other_identity", () => {
      const row = userRow({
        id: "user-1",
        oidcIssuer: "https://idp.example.com",
        oidcSub: "other-sub",
      });
      expect(
        decideOidcLogin(claims({ issuer: "https://idp.example.com", sub: "sub-abc", emailVerified: true }), null, [
          row,
        ]),
      ).toEqual({
        kind: "reject",
        code: "oidc_conflict",
        conflictReason: "bound_to_other_identity",
      });
    });

    it("不同 issuer、同 sub（半個相符不算相同 identity）→ reject oidc_conflict/bound_to_other_identity", () => {
      const row = userRow({
        id: "user-1",
        oidcIssuer: "https://other-idp.example.com",
        oidcSub: "sub-abc",
      });
      expect(
        decideOidcLogin(claims({ issuer: "https://idp.example.com", sub: "sub-abc", emailVerified: true }), null, [
          row,
        ]),
      ).toEqual({
        kind: "reject",
        code: "oidc_conflict",
        conflictReason: "bound_to_other_identity",
      });
    });

    it("已綁相同 identity（byOidcUser=null 但 email row 帶同 (issuer,sub)）→ 視為 login（冪等重入防禦）", () => {
      const row = userRow({
        id: "user-1",
        mustChangePassword: true,
        oidcIssuer: "https://idp.example.com",
        oidcSub: "sub-abc",
      });
      expect(
        decideOidcLogin(claims({ issuer: "https://idp.example.com", sub: "sub-abc" }), null, [row]),
      ).toEqual({
        kind: "login",
        userId: "user-1",
        clearMustChange: true,
      });
    });

    it("已綁相同 identity 但 disabled → reject account_disabled（disabled 檢查優先於 boundToSame login）", () => {
      const row = userRow({
        id: "user-1",
        disabledAt: new Date("2026-01-01T00:00:00Z"),
        oidcIssuer: "https://idp.example.com",
        oidcSub: "sub-abc",
      });
      expect(
        decideOidcLogin(claims({ issuer: "https://idp.example.com", sub: "sub-abc" }), null, [row]),
      ).toEqual({
        kind: "reject",
        code: "account_disabled",
      });
    });

    it("已綁相同 identity＋emailVerified=false → 仍 login（刻意繞過 verified 閘門，同一 identity 重入不該被本次 IdP 回傳的 verified 值擋下）", () => {
      const row = userRow({
        id: "user-1",
        mustChangePassword: false,
        oidcIssuer: "https://idp.example.com",
        oidcSub: "sub-abc",
      });
      expect(
        decideOidcLogin(
          claims({ issuer: "https://idp.example.com", sub: "sub-abc", emailVerified: false }),
          null,
          [row],
        ),
      ).toEqual({
        kind: "login",
        userId: "user-1",
        clearMustChange: false,
      });
    });
  });

  describe("分支 4：byEmailUsers 空（建帳）", () => {
    it("正常（email/verified/name 齊全）→ create", () => {
      expect(
        decideOidcLogin(claims({ email: "new@example.com", emailVerified: true, name: "New User" }), null, []),
      ).toEqual({
        kind: "create",
        email: "new@example.com",
        displayName: "New User",
      });
    });

    it("缺 email（claims.email===null）→ reject oidc_email_missing", () => {
      expect(decideOidcLogin(claims({ email: null }), null, [])).toEqual({
        kind: "reject",
        code: "oidc_email_missing",
      });
    });

    it("unverified（emailVerified !== true）→ reject oidc_email_unverified（建帳同一閘門）", () => {
      expect(decideOidcLogin(claims({ email: "new@example.com", emailVerified: false }), null, [])).toEqual({
        kind: "reject",
        code: "oidc_email_unverified",
      });
    });

    it("unverified 缺（emailVerified===null）→ reject oidc_email_unverified", () => {
      expect(decideOidcLogin(claims({ email: "new@example.com", emailVerified: null }), null, [])).toEqual({
        kind: "reject",
        code: "oidc_email_unverified",
      });
    });

    it("name 缺（null）→ displayName 取 email local-part", () => {
      expect(
        decideOidcLogin(claims({ email: "local-part@example.com", emailVerified: true, name: null }), null, []),
      ).toEqual({
        kind: "create",
        email: "local-part@example.com",
        displayName: "local-part",
      });
    });

    it("name 為空字串（非缺欄位，IdP 可能回傳空字串）→ 用 || 回退，displayName 取 email local-part", () => {
      expect(
        decideOidcLogin(claims({ email: "local-part@example.com", emailVerified: true, name: "" }), null, []),
      ).toEqual({
        kind: "create",
        email: "local-part@example.com",
        displayName: "local-part",
      });
    });
  });
});
