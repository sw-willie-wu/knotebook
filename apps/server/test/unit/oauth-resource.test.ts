/**
 * #132：canonical resource identifier（D11）的比對判準。authorize 的 T2 與
 * `/oauth/token` 的兩個 grant 分支共用這一支，所以它的邊界要逐格釘住。
 */
import { describe, expect, it } from "vitest";
import { canonicalResource, isCanonicalResource } from "../../src/oauth/resource.js";

const ISSUER = "http://host";

describe("canonicalResource", () => {
  it("是 issuer 加上 /api/mcp，無尾斜線", () => {
    expect(canonicalResource("http://host:8006")).toBe("http://host:8006/api/mcp");
  });
});

describe("isCanonicalResource", () => {
  it("接受逐字相等的形", () => {
    expect(isCanonicalResource("http://host/api/mcp", ISSUER)).toBe(true);
  });

  // scheme 與 host 由 new URL 正規化成小寫，所以大小寫不同的 origin 仍成立
  it("接受大小寫不同的 scheme 與 host", () => {
    expect(isCanonicalResource("HTTP://HOST/api/mcp", ISSUER)).toBe(true);
  });

  it("接受顯式的預設 port", () => {
    expect(isCanonicalResource("http://host:80/api/mcp", ISSUER)).toBe(true);
  });

  it("path 大小寫敏感", () => {
    expect(isCanonicalResource("http://host/API/MCP", ISSUER)).toBe(false);
  });

  it("拒絕尾斜線", () => {
    expect(isCanonicalResource("http://host/api/mcp/", ISSUER)).toBe(false);
  });

  it("拒絕帶 query 或 fragment", () => {
    expect(isCanonicalResource("http://host/api/mcp?x=1", ISSUER)).toBe(false);
    expect(isCanonicalResource("http://host/api/mcp#f", ISSUER)).toBe(false);
  });

  // 空的 `?` 是 search==="" 但 href 保留尾端問號——釘死「比 origin+pathname、不比 href」
  // 這個設計選擇（改用 href 的話這一案會紅）。
  it("接受尾端只有一個空 query 分隔符的形", () => {
    expect(isCanonicalResource("http://host/api/mcp?", ISSUER)).toBe(true);
  });

  it("拒絕不同 host、不同 port 與非 URL", () => {
    expect(isCanonicalResource("http://other/api/mcp", ISSUER)).toBe(false);
    expect(isCanonicalResource("http://host:8006/api/mcp", ISSUER)).toBe(false);
    expect(isCanonicalResource("not a url", ISSUER)).toBe(false);
  });

  it("缺席（undefined）為 false", () => {
    expect(isCanonicalResource(undefined, ISSUER)).toBe(false);
  });
});
