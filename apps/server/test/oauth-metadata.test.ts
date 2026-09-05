/**
 * #132 Task 2：兩個 RFC 形 prefix plugin 的骨架與元資料端點（§5.0／§5.1）。
 *
 * 這一族守的是：①元資料由 `PUBLIC_URL` origin 派生、不宣告 CIMD（D5）；②`/oauth` 與
 * `/.well-known` 兩個前綴下的錯誤 body 是 RFC 形（全站唯一例外），連 404／415 都是；
 * ③根形 PRM 與未知 well-known 路徑即使帶 `Accept: text/html` 也不回 index.html。
 */
import { describe, expect, it } from "vitest";
import { buildTestApp, testConfig } from "./helpers.js";

describe("OAuth 元資料端點（§5.1）", () => {
  it("PRM：resource 與 authorization_servers 由 PUBLIC_URL origin 派生", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/api/mcp" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=3600");
      const body = res.json();
      // 絕對值：自我參照的斷言擋不住 `.href` 突變（尾斜線會一路傳遞而處處自洽）
      expect(body.resource).toBe(`${testConfig.publicUrl.origin}/api/mcp`);
      expect(body.authorization_servers).toEqual([testConfig.publicUrl.origin]);
      expect(body.scopes_supported).toEqual(["notes:read", "notes:write"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      expect(body.resource_name).toBe("Knotebook");
    } finally {
      await close();
    }
  });

  it("AS metadata：端點齊全且不宣告 CIMD（D5）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(res.headers["cache-control"]).toBe("public, max-age=3600");
      // 絕對值，理由同 PRM 案
      expect(body.issuer).toBe(testConfig.publicUrl.origin);
      expect(body.scopes_supported).toEqual(["notes:read", "notes:write"]);
      expect(body.authorization_endpoint).toBe(`${body.issuer}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${body.issuer}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${body.issuer}/oauth/register`);
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.authorization_response_iss_parameter_supported).toBe(true);
      // D5：不宣告 CIMD，client 才會退回 registration_endpoint
      expect(body).not.toHaveProperty("client_id_metadata_document_supported");
    } finally {
      await close();
    }
  });

  // §5.1：根形 PRM 與任何未註冊的 /.well-known 路徑都不得回 index.html
  it("根形 PRM 與未知 well-known 路徑回 RFC 形 404，即使 Accept: text/html", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/bogus"]) {
        const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
        expect(res.statusCode, url).toBe(404);
        expect(res.json(), url).toEqual({ error: "invalid_request", error_description: expect.any(String) });
        expect(res.headers["cache-control"], url).toBe("no-store");
        expect(res.headers.pragma, url).toBe("no-cache");
      }
    } finally {
      await close();
    }
  });

  it("/oauth 前綴下未匹配的路徑回 RFC 形 404，裸路徑亦然", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/oauth/bogus", "/oauth"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json().error, url).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // §5.0：全域守衛對 /oauth 前綴的 415 也要走 RFC 形（含裸路徑，round 4 實測）
  it("/oauth 前綴送 form body 且非豁免路由 → 415 RFC 形", async () => {
    const { app, close } = await buildTestApp();
    try {
      for (const url of ["/oauth/bogus", "/oauth"]) {
        const res = await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "a=1",
        });
        expect(res.statusCode, url).toBe(415);
        expect(res.json().error, url).toBe("invalid_request");
      }
    } finally {
      await close();
    }
  });

  // 反向鑑別：守衛不是「OAuth 前綴一律 415」——正確的 JSON 要過得去（過了才 404）。
  // 少了這一案，把判斷改成恆真仍然全綠。
  it("/oauth 前綴送正確的 JSON → 過得了守衛（落 404 而不是 415）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauth/bogus",
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  // segment 邊界的接線守衛：/oauthx 不是 OAuth 前綴，該走站內形。GET 進不了
  // CHANGE_METHODS 守衛，所以這一案必須是帶 body 的 POST。
  it("POST /oauthx 送 form body → 站內 415 形（守衛用 segment 邊界，不是裸 startsWith）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/oauthx",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
    } finally {
      await close();
    }
  });

  it("站內路由送 form body 仍是我們自己的 415 形", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "a=1",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
    } finally {
      await close();
    }
  });
});
