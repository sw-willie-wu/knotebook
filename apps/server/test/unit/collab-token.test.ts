import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeJwt } from "jose";
import { signCollabToken, verifyCollabToken } from "../../src/collab/token.js";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";

const secret = "a".repeat(64);

describe("collab token jwt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("簽驗往返：noteId/role/tv 正確", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "editor", tv: 3 });
    const result = await verifyCollabToken(secret, token);
    expect(result).toEqual({ noteId: "note-1", userId: "user-1", role: "editor", tv: 3 });
  });

  it("role:'none' 可簽可驗（§11.5-1：無權限使用者也拿得到合法 token）", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "none", tv: 0 });
    const result = await verifyCollabToken(secret, token);
    expect(result).toEqual({ noteId: "note-1", userId: "user-1", role: "none", tv: 0 });
  });

  it("claims 含 tv（JWT payload 層級可驗到）", async () => {
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "viewer", tv: 7 });
    const payload = decodeJwt(token);
    expect(payload.tv).toBe(7);
  });

  it("篡改 token → null", async () => {
    // 改 payload 首字元（而非簽章末字元——base64url 末字元只有部分位元有效，flip
    // 有極小機率不改變解碼後的位元組，造成假綠）。
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "owner", tv: 1 });
    const [header, payload, signature] = token.split(".");
    const flippedFirstChar = payload[0] === "a" ? "b" : "a";
    const tampered = `${header}.${flippedFirstChar + payload.slice(1)}.${signature}`;
    expect(await verifyCollabToken(secret, tampered)).toBeNull();
  });

  it("亂字串 → null", async () => {
    expect(await verifyCollabToken(secret, "not-a-jwt-at-all")).toBeNull();
    expect(await verifyCollabToken(secret, "")).toBeNull();
  });

  it("過期 token → null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signCollabToken(secret, { noteId: "note-1", userId: "user-1", role: "editor", tv: 1 });
    // 120s TTL（COLLAB_TOKEN_TTL_SECONDS），推進 121s
    vi.setSystemTime(new Date("2026-01-01T00:02:01Z"));
    expect(await verifyCollabToken(secret, token)).toBeNull();
  });

  it(":session 鍵簽的用 :collab 驗必 null（兩把鍵不得互驗，見 auth/session.ts 的 sessionKey）", async () => {
    // 直接重現 sessionKey 的衍生方式（sha256(secret + ":session")）簽一個 token，
    // 確認用 collab 這邊的 verifyCollabToken（sha256(secret + ":collab")）驗不過。
    const { SignJWT } = await import("jose");
    const { createHash } = await import("node:crypto");
    const sessionKey = createHash("sha256").update(`${secret}:session`).digest();
    const token = await new SignJWT({ noteId: "note-1", role: "editor", tv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("120s")
      .sign(sessionKey);
    expect(await verifyCollabToken(secret, token)).toBeNull();
  });
});

describe("FixedWindowLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("60 次放行，第 61 次擋", () => {
    const limiter = new FixedWindowLimiter({ limit: 60, windowMs: 60_000 });
    for (let i = 0; i < 60; i++) {
      expect(limiter.consume("user-1")).toBe(true);
    }
    expect(limiter.consume("user-1")).toBe(false);
  });

  it("超限後每次呼叫仍計數（非失敗才計）：視窗內持續呼叫仍持續回 false", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
    expect(limiter.consume("k")).toBe(false);
  });

  it("視窗滾動：超限後推進超過 windowMs，計數歸零重新放行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000 });
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);

    vi.setSystemTime(1_000);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(true);
    expect(limiter.consume("k")).toBe(false);
  });

  it("consumeMany（#175 T4）：額度夠就一次扣 n；不夠回 false 且一個都不扣；n <= 0 恆放行不計數", () => {
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.consumeMany("k", 0)).toBe(true);
    expect(limiter.isBlocked("k")).toBe(false);
    expect(limiter.consumeMany("k", 3)).toBe(true);
    expect(limiter.consumeMany("k", 3)).toBe(false); // 3 + 3 > 5：拒絕、計數仍是 3
    expect(limiter.consumeMany("k", 2)).toBe(true); // 3 + 2 = 5：放行（上一發沒被記帳的證據）
    expect(limiter.consume("k")).toBe(false);
  });

  it("consumeMany n > limit（T4 review r2 I-1）：夾到整窗額度——只在空窗放行並扣滿；同窗再發拒絕且不扣；下一窗再放行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 1_000 });
    expect(limiter.consumeMany("k", 7)).toBe(true); // 新窗：放行（不夾的話 0 + 7 > 5，任何視窗都拒）
    expect(limiter.isBlocked("k")).toBe(true); // 扣滿整窗
    expect(limiter.consumeMany("k", 7)).toBe(false); // 同窗再發：拒絕
    expect(limiter.consume("k")).toBe(false); // 一般上傳也被擋到窗尾

    vi.setSystemTime(1_000);
    expect(limiter.consumeMany("k", 1)).toBe(true); // 新窗開出
    expect(limiter.consumeMany("k", 7)).toBe(false); // 非空窗（count 1）：夾後要 5，1 + 5 > 5 → 拒絕、不扣
    expect(limiter.consumeMany("k", 4)).toBe(true); // 1 + 4 = 5：放行（上一發沒被記帳的證據）
    expect(limiter.consume("k")).toBe(false);
  });

  it("不同 key 各自獨立計數", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("b")).toBe(false);
  });

  it("maxKeys 淘汰最舊的 key（插入序）", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    expect(limiter.consume("k1")).toBe(true); // 插入 k1 → {k1}
    expect(limiter.consume("k2")).toBe(true); // 插入 k2 → {k1,k2}（已滿）
    expect(limiter.consume("k3")).toBe(true); // 淘汰最舊 k1，插入 k3 → {k2,k3}

    // k1 已被淘汰——視為全新 key，重新放行一次（若沒被淘汰，會因已用滿 limit=1 而擋）；
    // 這次插入又會淘汰目前最舊的 k2 → {k3,k1}。
    expect(limiter.consume("k1")).toBe(true);

    // k3 從未被淘汰過（自始至終都在 map 內），維持它原本「已達上限」的計數狀態不受影響。
    expect(limiter.consume("k3")).toBe(false);
  });
});
