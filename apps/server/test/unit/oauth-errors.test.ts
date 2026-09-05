/**
 * #132：全域 content-type 守衛用來判定「這一發是不是 RFC 形前綴」的兩個純值。
 * 放單元層（不碰 DB）——這樣 Windows 本機不必起 docker 也守得住。
 */
import { describe, expect, it } from "vitest";
import { FORM_EXEMPT_ROUTES, isOauthScopedPath } from "../../src/http/oauth-errors.js";

describe("isOauthScopedPath", () => {
  it("兩個前綴本身與其子路徑都算", () => {
    expect(isOauthScopedPath("/oauth")).toBe(true);
    expect(isOauthScopedPath("/oauth/token")).toBe(true);
    expect(isOauthScopedPath("/.well-known")).toBe(true);
    expect(isOauthScopedPath("/.well-known/oauth-authorization-server")).toBe(true);
  });

  // segment 邊界：裸 startsWith 會把 /oauthx 也算進來，那是一條普通的 SPA 路徑
  it("segment 邊界：只是前綴開頭的路徑不算", () => {
    expect(isOauthScopedPath("/oauthx")).toBe(false);
    expect(isOauthScopedPath("/oauthx/token")).toBe(false);
    expect(isOauthScopedPath("/.well-knownx")).toBe(false);
  });

  it("不相干的路徑不算", () => {
    expect(isOauthScopedPath("/")).toBe(false);
    expect(isOauthScopedPath("/api/notes")).toBe(false);
  });
});

describe("FORM_EXEMPT_ROUTES", () => {
  // `routeOptions.url` 在 prefix plugin 內回**含 prefix** 的完整路徑。寫成不含
  // prefix 的 `/token`，Task 7 的 form 端點會永遠吃 415。
  it("鍵是含 prefix 的完整路徑", () => {
    expect(FORM_EXEMPT_ROUTES.has("POST /oauth/token")).toBe(true);
    expect(FORM_EXEMPT_ROUTES.has("POST /token")).toBe(false);
  });
});
