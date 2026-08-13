import { describe, it, expect } from "vitest";
import {
  OIDC_STATE_TTL_SECONDS,
  OIDC_STATE_COOKIE_PATH,
  sealOidcState,
  unsealOidcState,
  type OidcStatePayload,
} from "../../src/auth/oidc-state.js";

const secret = "a".repeat(64);

function payload(overrides: Partial<OidcStatePayload> = {}): OidcStatePayload {
  return {
    state: "state-abc",
    nonce: "nonce-xyz",
    codeVerifier: "verifier-123",
    exp: 1_000_000 + OIDC_STATE_TTL_SECONDS,
    ...overrides,
  };
}

describe("auth/oidc-state：OIDC state cookie 的 seal/unseal（AES-256-GCM，server 端 exp 驗證）", () => {
  it("OIDC_STATE_TTL_SECONDS 為 600（10 分鐘）", () => {
    expect(OIDC_STATE_TTL_SECONDS).toBe(600);
  });

  it("OIDC_STATE_COOKIE_PATH 為 /api/auth/oidc", () => {
    expect(OIDC_STATE_COOKIE_PATH).toBe("/api/auth/oidc");
  });

  it("往返相等（seal→unseal 同 payload）", () => {
    const p = payload();
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toEqual(p);
  });

  it("exp 明確早於 now（payload.exp < now）→ 回 null", () => {
    const p = payload({ exp: 1_000_000 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_601)).toBeNull();
  });

  it("exp 恰好等於 now（<= 邊界）→ 視為已逾期，回 null", () => {
    const p = payload({ exp: 1_000_000 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_000)).toBeNull();
  });

  it("exp 未到（now 小於 exp）→ 正常回 payload", () => {
    const p = payload({ exp: 1_000_100 });
    const sealed = sealOidcState(secret, p);
    expect(unsealOidcState(secret, sealed, 1_000_099)).toEqual(p);
  });

  it("竄改密文（翻 ct 一個 bit）→ 回 null", () => {
    const sealed = sealOidcState(secret, payload());
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const ctBytes = Buffer.from(ctPart ?? "", "base64url");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0xff;
    const tampered = `${ivPart}.${ctBytes.toString("base64url")}.${tagPart}`;
    expect(unsealOidcState(secret, tampered, 1_000_000)).toBeNull();
  });

  it("竄改 tag（換 tag）→ 回 null", () => {
    const sealed = sealOidcState(secret, payload());
    const [ivPart, ctPart, tagPart] = sealed.split(".");
    const tagBytes = Buffer.from(tagPart ?? "", "base64url");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    const tampered = `${ivPart}.${ctPart}.${tagBytes.toString("base64url")}`;
    expect(unsealOidcState(secret, tampered, 1_000_000)).toBeNull();
  });

  it("亂字串（格式完全不對）→ 回 null，不 throw", () => {
    expect(unsealOidcState(secret, "not-a-sealed-value", 1_000_000)).toBeNull();
  });

  it("空字串 → 回 null，不 throw", () => {
    expect(unsealOidcState(secret, "", 1_000_000)).toBeNull();
  });

  it("不同 appSecret unseal → 回 null", () => {
    const sealed = sealOidcState(secret, payload());
    expect(unsealOidcState("b".repeat(64), sealed, 1_000_000)).toBeNull();
  });

  it("iv 每次不同（不重用 nonce）", () => {
    const a = sealOidcState(secret, payload());
    const b = sealOidcState(secret, payload());
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);
  });
});
