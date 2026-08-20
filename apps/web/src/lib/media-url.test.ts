import { describe, expect, it } from "vitest";
import { BLOCKED_MEDIA_URL, isAllowedEmbedUrl, isSafeMediaUrl, safeMediaUrl } from "./media-url";

const BASE = "http://localhost:5173/notes/abc";

describe("isAllowedEmbedUrl（輸入端：Embed tab）", () => {
  it("放行完整的 http(s) 網址", () => {
    expect(isAllowedEmbedUrl("https://example.com/a.png")).toBe(true);
    expect(isAllowedEmbedUrl("http://example.com/a.png")).toBe(true);
  });

  it("拒收危險 scheme", () => {
    expect(isAllowedEmbedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedEmbedUrl("JavaScript:alert(1)")).toBe(false);
    expect(isAllowedEmbedUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAllowedEmbedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedEmbedUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("刻意不自動補 scheme：沒帶 scheme 的一律拒收", () => {
    expect(isAllowedEmbedUrl("example.com/a.png")).toBe(false);
    expect(isAllowedEmbedUrl("/api/uploads/u1")).toBe(false);
    expect(isAllowedEmbedUrl("")).toBe(false);
  });
});

describe("isSafeMediaUrl（渲染端）", () => {
  it("放行 http(s) 與**相對**網址——自家上傳的圖片就是 /api/uploads/<id>", () => {
    expect(isSafeMediaUrl("https://example.com/a.png", BASE)).toBe(true);
    expect(isSafeMediaUrl("/api/uploads/u1", BASE)).toBe(true);
    expect(isSafeMediaUrl("../uploads/u1", BASE)).toBe(true);
  });

  it("空字串放行（BlockNote 對「還沒有檔案」的表示法，不是攻擊面）", () => {
    expect(isSafeMediaUrl("", BASE)).toBe(true);
  });

  it("擋掉 Yjs 直寫進來的危險 scheme", () => {
    expect(isSafeMediaUrl("javascript:alert(1)", BASE)).toBe(false);
    expect(isSafeMediaUrl("  javascript:alert(1)", BASE)).toBe(false);
    expect(isSafeMediaUrl("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==", BASE)).toBe(false);
    expect(isSafeMediaUrl("blob:http://localhost:5173/abc", BASE)).toBe(false);
    expect(isSafeMediaUrl("file:///etc/passwd", BASE)).toBe(false);
  });
});

describe("safeMediaUrl", () => {
  it("安全的原樣返回，不安全的換成惰性的 about:blank", () => {
    expect(safeMediaUrl("/api/uploads/u1", BASE)).toBe("/api/uploads/u1");
    expect(safeMediaUrl("https://example.com/a.png", BASE)).toBe("https://example.com/a.png");
    expect(safeMediaUrl("javascript:alert(1)", BASE)).toBe(BLOCKED_MEDIA_URL);
  });
});
