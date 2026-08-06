import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

// spec §11.5 逐字契約，見 task-9-brief.md：
//   - fallback 僅 GET/HEAD；以 pathname（去 query）判定
//   - 排除前綴為 segment 邊界：/api、/collab、/healthz、/assets（`/x` 本身或 `/x/...`；
//     `/collaborators` 不受 `/collab` 牽連）
//   - Accept 子字串含 text/html 才算（`*/*` 不算）
//   - /assets/* 缺檔 → 404（webDist 不存在或未傳 → 全 JSON 404，既有行為）
describe("SPA fallback（spec §11.5）", () => {
  let webDist: string;

  beforeAll(() => {
    webDist = mkdtempSync(path.join(tmpdir(), "knotebook-spa-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>knotebook spa</title>");
    mkdirSync(path.join(webDist, "assets"));
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');");
  });

  afterAll(() => {
    rmSync(webDist, { recursive: true, force: true });
  });

  // 真實瀏覽器常見的 Accept header（Chrome/Firefox 導覽請求），子字串含 text/html。
  const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

  it("GET /nope + Accept: text/html → index.html 200", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("knotebook spa");
  });

  it("真實瀏覽器 Accept 字串（含 text/html 子字串）→ index.html", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: BROWSER_ACCEPT } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("Accept: */* → JSON 404（*/* 不算 text/html 子字串）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "*/*" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("無 Accept header（curl/fetch/app.inject 預設）→ JSON 404", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("POST /nope（即使 Accept: text/html）→ 既有 JSON 404（fallback 僅 GET/HEAD）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "POST", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /assets/missing.js → 404（/assets 排除 SPA fallback，JSON body 皆可，狀態碼是重點）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
  });

  it("GET /assets/app.js → 200 且內容正確（走 @fastify/static，不經 fallback）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log('app');");
  });

  it("GET /collaborators + text/html → index.html（segment 邊界證明：不受 /collab 排除牽連）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/collaborators", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("GET /api/nope + text/html → JSON 404（/api 排除 SPA fallback）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /api/nope?x=1 + text/html → JSON 404（判定用 pathname，query string 不影響排除前綴比對）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope?x=1", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("GET /nope?foo=bar + text/html → index.html（query string 不影響 fallback 命中）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope?foo=bar", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("不傳 webDist → GET /nope 仍是既有 JSON 404（既有行為不受影響）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
