import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  registerSpaFallback,
  staticCacheControl,
} from "../../src/http/spa.js";

// registerSpaFallback 只需要一個 Fastify 實例與 dist 目錄，不碰資料庫，所以可以在單元測試裡直接掛。
describe("SPA 與靜態檔的 Cache-Control", () => {
  let webDist: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    webDist = mkdtempSync(path.join(tmpdir(), "knotebook-spa-cache-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>knotebook spa</title>");
    mkdirSync(path.join(webDist, "assets"));
    writeFileSync(path.join(webDist, "assets", "index-abc123.js"), "console.log('app');");
    writeFileSync(path.join(webDist, "assets", "index-abc123.css"), "body{}");
    writeFileSync(path.join(webDist, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(webDist, "manifest.webmanifest"), '{"name":"Knotebook"}');
    writeFileSync(path.join(webDist, "icon-192.png"), "png");
    app = Fastify({ logger: false });
    registerSpaFallback(app, webDist);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it("staticCacheControl：assets/ 底下長快取，dist 根目錄 no-cache", () => {
    expect(staticCacheControl(webDist, path.join(webDist, "assets", "index-abc123.js"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl(webDist, path.join(webDist, "assets", "fonts", "a.woff2"))).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl(webDist, path.join(webDist, "manifest.webmanifest"))).toBe(REVALIDATE_CACHE_CONTROL);
    // 名字以 assets 開頭但不在 assets/ 目錄裡的檔案不算
    expect(staticCacheControl(webDist, path.join(webDist, "assets-list.json"))).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("兩個常數的值", () => {
    expect(IMMUTABLE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(REVALIDATE_CACHE_CONTROL).toBe("no-cache");
  });

  for (const url of ["/assets/index-abc123.js", "/assets/index-abc123.css"]) {
    it(`GET ${url} → 一年且 immutable`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
    });
  }

  for (const url of ["/manifest.webmanifest", "/icon-192.png", "/favicon.svg"]) {
    it(`GET ${url} → no-cache`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
    });
  }

  it("HEAD 與 GET 帶同一個值", async () => {
    const res = await app.inject({ method: "HEAD", url: "/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  for (const url of ["/", "/notes/abc", "/p/some-token"]) {
    it(`GET ${url}（text/html，回 index.html）→ no-cache`, async () => {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("knotebook spa");
      expect(res.headers["cache-control"]).toBe(REVALIDATE_CACHE_CONTROL);
    });
  }

  it("缺檔的 /assets/* 仍是 JSON 404，不帶長快取", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).not.toBe(IMMUTABLE_CACHE_CONTROL);
  });
});
