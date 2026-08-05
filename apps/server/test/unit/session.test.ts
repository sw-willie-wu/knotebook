import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeJwt } from "jose";
import { signSession, verifySession } from "../../src/auth/session.js";

const secret = "a".repeat(64);

describe("session jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("簽驗往返：sub/tv 正確", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5 });
    const result = await verifySession(secret, token);
    expect(result).toEqual({ userId: "user-123", tv: 5 });
  });

  it("篡改 token → null", async () => {
    // 改 payload 段（而非簽章末字元——base64url 末字元只有部分位元有效，flip 有極小
    // 機率不改變解碼後的位元組，造成假綠）。改 payload 首字元必定改變解碼結果，
    // 且簽章仍是對「原始 payload」算的，驗證必然失敗。
    const token = await signSession(secret, { userId: "user-123", tv: 5 });
    const [header, payload, signature] = token.split(".");
    const flippedFirstChar = payload[0] === "a" ? "b" : "a";
    const tamperedPayload = flippedFirstChar + payload.slice(1);
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(await verifySession(secret, tampered)).toBeNull();
  });

  it("亂字串 → null", async () => {
    expect(await verifySession(secret, "not-a-jwt-at-all")).toBeNull();
    expect(await verifySession(secret, "")).toBeNull();
  });

  it("錯誤 secret 簽的 token → null", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5 });
    expect(await verifySession("b".repeat(64), token)).toBeNull();
  });

  it("過期 token → null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signSession(secret, { userId: "user-123", tv: 1 });
    // 7 天 exp，推進 8 天
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    expect(await verifySession(secret, token)).toBeNull();
  });

  it("exp 恰為簽發時間 + 7 天", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5 });
    const payload = decodeJwt(token);
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect(payload.exp! - payload.iat!).toBe(7 * 24 * 60 * 60);
  });
});
