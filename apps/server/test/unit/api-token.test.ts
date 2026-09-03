/**
 * #130 Task 4：API token 的明文格式（`auth/api-token.ts`）與 `WWW-Authenticate`
 * 的組字（`auth/challenge.ts`）。兩者都是純函式，無 DB、無 fastify。
 *
 * 這一族的守衛重點有兩個：①`knbr_` 不是 `knb_` 的延長，所以把 refresh token 當
 * Bearer 送會落在「前綴不合」的 401 而不進 DB 查表——那是靠字元恰好不同成立的；
 * ②`Authorization` 的三態解析，因為 RFC 6750 對「非 Bearer scheme」與「Bearer 但
 * token 壞掉」要求不同的 challenge 形狀。
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  isAccessTokenShape,
  parseAuthorizationHeader,
} from "../../src/auth/api-token.js";
import { buildBearerChallenge } from "../../src/auth/challenge.js";

describe("token 明文格式", () => {
  it("access 是 knb_ + 43 字元 base64url（共 47），每次都不同", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(47);
    expect(a).not.toBe(b);
  });

  it("refresh 是 knbr_ + 43 字元（共 48）", () => {
    expect(generateRefreshToken()).toMatch(/^knbr_[A-Za-z0-9_-]{43}$/);
    expect(generateRefreshToken()).toHaveLength(48);
  });

  it("refresh token 不是合法的 access token 形狀（第 4 字元 r vs _）", () => {
    // 這條守衛靠「兩個前綴恰好不互為前綴」成立——改前綴前先看這裡。把 refresh
    // token 當 Bearer 送必須落在「前綴不合」那條 401，而不是進 DB 查表。
    expect(REFRESH_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateRefreshToken())).toBe(false);
    expect(isAccessTokenShape(generateAccessToken())).toBe(true);
  });

  it("前綴要在開頭，不是「含有」——Xknb_… 不算 access token 形狀", () => {
    // 上一條只餵 generateRefreshToken()，而 knbr_ 後面碰巧出現 "knb_" 的機率約
    // 2×10⁻⁶＝那條守衛對 startsWith→includes 這個改法永遠不會紅。前綴閘的整個
    // 價值在於「不合就直接 401、不查 DB」，放寬成 includes 會讓垃圾輸入每發都做
    // 一次 access_token_hash 的索引查找。
    expect(isAccessTokenShape("Xknb_abc")).toBe(false);
  });

  it("hashToken 是 sha256 hex、決定性、不同輸入不同輸出", () => {
    expect(hashToken("knb_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("knb_x")).toBe(hashToken("knb_x"));
    expect(hashToken("knb_x")).not.toBe(hashToken("knb_y"));
  });

  it("hashToken 是真的 sha256，不是自製的雜湊", () => {
    // 對照 Node 的已知值：實作若換成別的摘要（或加了鹽），這裡會紅。
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseAuthorizationHeader", () => {
  it("沒有 header → none（呼叫端回退 cookie session）", () => {
    expect(parseAuthorizationHeader(undefined)).toEqual({ kind: "none" });
  });

  it("Bearer（scheme 大小寫不敏感）→ 取出 token", () => {
    expect(parseAuthorizationHeader("Bearer knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("bearer knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("BEARER knb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
    expect(parseAuthorizationHeader("  Bearer   knb_abc  ")).toEqual({ kind: "bearer", token: "knb_abc" });
  });

  it("非 Bearer scheme／空值／只有 scheme → other-scheme（challenge 不帶 error）", () => {
    // RFC 6750 §3：unsupported authentication method 時 SHOULD NOT 帶 error code，
    // 與「Bearer 但 token 壞掉」（§3.1 要 invalid_token）是不同的形狀，故三態分開。
    expect(parseAuthorizationHeader("Basic dXNlcjpwdw==")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("   ")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer   ")).toEqual({ kind: "other-scheme" });
  });

  it("token 內不得含空白——`Bearer a b` 是畸形，不是「token 是 a b」", () => {
    expect(parseAuthorizationHeader("Bearer knb_a knb_b")).toEqual({ kind: "other-scheme" });
  });

  it("scheme 與 token 之間只能是 SP／HTAB，不吃 NBSP", () => {
    // RFC 7235 的 credentials 規則只允許 SP/HTAB。分隔符若寫成 `\s+`，JS 的 `\s`
    // 含 U+00A0——而 Node 以 latin1 解 header value，0xA0 這個位元組真的會變成
    // U+00A0——於是畸形 header 會被當成合法 Bearer。守的是分隔符那半（`\S+`
    // 那半由上一條守）。
    expect(parseAuthorizationHeader("Bearer\u00a0knb_abc")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearer\tknb_abc")).toEqual({ kind: "bearer", token: "knb_abc" });
  });

  it("不是 Bearer 的相似前綴不得誤判（BearerToken／Bearerx）", () => {
    expect(parseAuthorizationHeader("BearerToken knb_abc")).toEqual({ kind: "other-scheme" });
    expect(parseAuthorizationHeader("Bearerknb_abc")).toEqual({ kind: "other-scheme" });
  });
});

describe("buildBearerChallenge", () => {
  const issuer = "http://192.168.3.22:8006";
  const prm = `resource_metadata="${issuer}/.well-known/oauth-protected-resource/api/mcp"`;

  it("無憑證形：帶 scope 與 resource_metadata、不帶 error", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read" });
    expect(value.startsWith("Bearer ")).toBe(true);
    expect(value).toContain(`scope="notes:read"`);
    expect(value).toContain(prm);
    expect(value).not.toContain("error=");
  });

  it("token 壞掉形：帶 error=invalid_token", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read notes:write", error: "invalid_token" });
    expect(value).toContain(`error="invalid_token"`);
    expect(value).toContain(`scope="notes:read notes:write"`);
    expect(value).toContain(prm);
  });

  it("scope 不足形：帶 error=insufficient_scope", () => {
    expect(buildBearerChallenge({ issuer, scope: "notes:write", error: "insufficient_scope" })).toContain(
      `error="insufficient_scope"`
    );
  });

  it("resource_metadata 一律指向 /api/mcp，與請求的路由無關", () => {
    // 對 RFC 9728 §3.3 第二段的**刻意偏離**（見 challenge.ts 的 JSDoc）。不要改成
    // 「只有 /api/mcp 才帶」——那會讓 #106 之後的新端點 401 沒有任何發現資訊。
    expect(buildBearerChallenge({ issuer, scope: "notes:read" })).toContain("/api/mcp");
  });

  it("issuer 原樣帶入，不自己補尾斜線（否則會組出 …//.well-known/…）", () => {
    expect(buildBearerChallenge({ issuer: "https://notes.example.com", scope: "notes:read" })).toContain(
      `resource_metadata="https://notes.example.com/.well-known/oauth-protected-resource/api/mcp"`
    );
  });

  it("auth-param 以逗號分隔（RFC 7235 的 #rule），且每個值都有引號", () => {
    const value = buildBearerChallenge({ issuer, scope: "notes:read", error: "invalid_token" });
    // 這條擋的是「把三個參數用空白串起來」那種組法——語法上不合，client 解析會壞。
    expect(value.split(", ")).toHaveLength(3);
    for (const param of value.replace(/^Bearer /, "").split(", ")) expect(param).toMatch(/^[a-z_]+="[^"]*"$/);
  });
});
