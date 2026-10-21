import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStaleOneTimeTokens, INVITE_TOKEN_KEY, ONE_TIME_TOKEN_PAGES, readSessionToken, RESET_TOKEN_KEY, writeSessionToken } from "./resetTokenStorage";

describe("clearStaleOneTimeTokens（#286；main.tsx 在 render 前呼叫）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(RESET_TOKEN_KEY, "knbp_X");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("表裡有 /reset-password → knotebook:reset-token 這一列", () => {
    expect(ONE_TIME_TOKEN_PAGES).toContainEqual({ path: "/reset-password", key: "knotebook:reset-token" });
  });

  it.each(["/", "/login", "/n/alice/x", "/reset-passwords"])("初始路徑 %s → 刪鍵", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBeNull();
  });

  it.each(["/reset-password", "/reset-password/", "/reset-password//", "/RESET-PASSWORD"])("初始路徑 %s（react-router 一樣渲染重設頁）→ 保留", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBe("knbp_X");
  });

  it("不碰別的鍵", () => {
    sessionStorage.setItem("knotebook:chunk-reload:register", "1");
    clearStaleOneTimeTokens("/");
    expect(sessionStorage.getItem("knotebook:chunk-reload:register")).toBe("1");
  });

  it("sessionStorage 丟例外 → 不拋", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => clearStaleOneTimeTokens("/")).not.toThrow();
  });
});

describe("clearStaleOneTimeTokens：邀請列（#285）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(INVITE_TOKEN_KEY, "knbi_X");
  });
  afterEach(() => sessionStorage.clear());

  it("表裡有 /register → knotebook:invite-token 這一列", () => {
    expect(ONE_TIME_TOKEN_PAGES).toContainEqual({ path: "/register", key: "knotebook:invite-token" });
  });

  it.each(["/", "/login", "/registerx"])("初始路徑 %s → 刪邀請鍵", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
  });

  it.each(["/register", "/register/", "/REGISTER"])("初始路徑 %s → 保留邀請鍵", (pathname) => {
    clearStaleOneTimeTokens(pathname);
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe("knbi_X");
  });

  it("兩鍵互不影響：/reset-password 刪邀請鍵留重設鍵；/register 刪重設鍵留邀請鍵", () => {
    sessionStorage.setItem(RESET_TOKEN_KEY, "knbp_X");
    clearStaleOneTimeTokens("/reset-password");
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBe("knbp_X");
    sessionStorage.setItem(INVITE_TOKEN_KEY, "knbi_X");
    clearStaleOneTimeTokens("/register");
    expect(sessionStorage.getItem(RESET_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe("knbi_X");
  });
});

describe("readSessionToken／writeSessionToken：sessionStorage 不可用時不拋（頁面在 useState 初始化裡讀）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getItem 丟例外 → readSessionToken 回 null", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readSessionToken(RESET_TOKEN_KEY)).toBeNull();
  });

  it("setItem 丟例外 → writeSessionToken 不拋", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeSessionToken(RESET_TOKEN_KEY, "knbp_X")).not.toThrow();
  });
});
