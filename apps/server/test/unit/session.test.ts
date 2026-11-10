import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import type { FastifyReply } from "fastify";
import { SITE_LIMITS } from "@knotebook/shared";
import type { AppConfig } from "../../src/config.js";
import { setSessionCookie } from "../../src/auth/cookies.js";
import { signSession, verifySession } from "../../src/auth/session.js";
import { newSessionValues } from "../../src/auth/tx/sessions.js";

const secret = "a".repeat(64);
const sid = "0f3c2a4e-1b2d-4c5e-8f60-7a8b9c0d1e2f";
const TTL = SITE_LIMITS.sessionTtlSeconds.default;

describe("session jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("簽驗往返：sub/tv/sid 正確", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
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
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
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
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    expect(await verifySession("b".repeat(64), token)).toBeNull();
  });

  it("過期 token → null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signSession(secret, { userId: "user-123", tv: 1, sid }, TTL);
    // 7 天 exp，推進 8 天
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    expect(await verifySession(secret, token)).toBeNull();
  });

  it("預設有效期：exp 恰為簽發時間 + 7 天", async () => {
    const token = await signSession(secret, { userId: "user-123", tv: 5, sid }, TTL);
    const payload = decodeJwt(token);
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect(payload.exp! - payload.iat!).toBe(7 * 24 * 60 * 60);
  });

  it("#397：signSession 的 exp − iat 等於傳入的 ttl", async () => {
    const payload = decodeJwt(await signSession(secret, { userId: "user-123", tv: 5, sid }, 3600));
    expect(payload.exp! - payload.iat!).toBe(3600);
  });
});

describe("#397：session 列與 cookie 的有效期跟著傳入的 ttl", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("newSessionValues(\"u\", 3600).expiresAt 是 now + 3600 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const values = newSessionValues("u", 3600);
    expect(values).toEqual({ userId: "u", expiresAt: new Date("2026-01-01T01:00:00Z") });
  });

  it("setSessionCookie 的 maxAge 等於傳入的 ttl", () => {
    const setCookie = vi.fn();
    const reply = { setCookie } as unknown as FastifyReply;
    setSessionCookie(reply, { cookieSecure: false } as AppConfig, "jwt-value", 3600);
    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(setCookie.mock.calls[0]![2]).toMatchObject({ maxAge: 3600 });
  });
});
