import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import { signSession, verifySession } from "../../src/auth/session.js";

const secret = "a".repeat(64);
const sid = "0f3c2a4e-1b2d-4c5e-8f60-7a8b9c0d1e2f";

describe("session jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("簽驗往返：sub/tv/sid 正確", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid });
    const result = await verifySession(secret, token);
    expect(result).toEqual({ userId: "user-123", tv: 5, sid });
  });

  it("#388：沒有 sid 的舊 JWT → null；sid 不是 uuid 形狀 → null；同樣簽法帶合法 sid 就過", async () => {
    const key = createHash("sha256").update(`${secret}:session`).digest();
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("user-123").setIssuedAt().setExpirationTime("7d").sign(key);
    expect(await verifySession(secret, await sign({ tv: 5 }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid: "not-a-uuid" }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid: sid.toUpperCase() }))).toBeNull(); // DB 的 uuid 一律小寫輸出
    expect(await verifySession(secret, await sign({ tv: 5, sid: 42 }))).toBeNull();
    expect(await verifySession(secret, await sign({ tv: 5, sid }))).toEqual({ userId: "user-123", tv: 5, sid });
  });

  it("篡改 token → null", async () => {
    // 改 payload 段（而非簽章末字元——base64url 末字元只有部分位元有效，flip 有極小
    // 機率不改變解碼後的位元組，造成假綠）。改 payload 首字元必定改變解碼結果，
    // 且簽章仍是對「原始 payload」算的，驗證必然失敗。
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid });
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
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid });
    expect(await verifySession("b".repeat(64), token)).toBeNull();
  });

  it("過期 token → null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signSession(secret, { userId: "user-123", tv: 1, sid });
    // 7 天 exp，推進 8 天
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    expect(await verifySession(secret, token)).toBeNull();
  });

  it("exp 恰為簽發時間 + 7 天", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid });
    const payload = decodeJwt(token);
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect(payload.exp! - payload.iat!).toBe(7 * 24 * 60 * 60);
  });
});
