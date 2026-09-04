import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

// spec §11.5 逐字契約，見 task-9-brief.md：
//   - fallback 僅 GET/HEAD；以 pathname（去 query）判定
//   - 排除前綴為 segment 邊界：/api、/collab、/healthz、/assets，#131 起再加 /oauth 與
//     /.well-known（`/x` 本身或 `/x/...`；`/collaborators` 不受 `/collab` 牽連）
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

  // #131：/oauth 與 /.well-known 進排除清單——#132 會把 OAuth 端點掛在那裡，它們的
  // 404 是 RFC 形 JSON 而不是 SPA 頁。接下來四案裡，**後**兩條 200 的正對照不是湊數：
  // fallback 整段包在 `webDist !== undefined` 內，漏傳第二參數的話**前**兩條 404 什麼
  // 都不驗（同檔尾端「不傳 webDist → 仍是 JSON 404」那案正是這個形）。
  it("#131：GET /oauth/token + text/html → JSON 404", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/oauth/token", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("#131：GET /.well-known/oauth-authorization-server + text/html → JSON 404", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("#131 正對照：GET /oauthx + text/html → index.html（segment 邊界）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/oauthx", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("#131 正對照：GET /.well-knownx + text/html → index.html", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/.well-knownx", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  it("GET /nope?foo=bar + text/html → index.html（query string 不影響 fallback 命中）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/nope?foo=bar", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
  });

  // issue #101：CSP 掛在**這條路徑**（手動回 index.html 的地方）——CSP 只對 HTML 文件
  // 有意義。政策內容本身由 `test/unit/security-headers.test.ts` 逐條釘住，這裡守的是
  // 「有沒有真的掛上去」與「hash 是不是從**這次送出的這份 body** 算的」。
  it("index.html 回應帶 CSP，且 script-src 的 hash 就是這份 body 裡那段 inline script 的 sha256", async () => {
    const inline = 'document.documentElement.classList.add("dark");';
    const dist = mkdtempSync(path.join(tmpdir(), "knotebook-csp-"));
    writeFileSync(
      path.join(dist, "index.html"),
      `<!doctype html><head><script>${inline}</script></head><body></body>`,
    );
    try {
      const { app } = await buildTestApp({}, { webDist: dist });
      const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });

      expect(res.statusCode).toBe(200);
      const csp = res.headers["content-security-policy"];
      expect(csp, "index.html 回應沒有 CSP").toBeTypeOf("string");
      // oracle 獨立於實作：直接對送出的 body 裡的 script 內文算一次 sha256。
      const served = /<script>([\s\S]*?)<\/script>/.exec(res.body)![1]!;
      const hash = createHash("sha256").update(served, "utf8").digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  // ⚠ gate 審查抓到的 Critical：`@fastify/static` 的 `wildcard:false` 仍會為 root 下
  // **實際存在的每個檔案**各註冊一條路由，而 `index.html` 就是其中之一——於是
  // `GET /index.html` 會由 static 送出同一份 SPA（App.tsx 的 `/*` route 讓它渲染
  // 首頁、session cookie 是 lax 照送＝已登入），卻**一個安全標頭都沒有**。
  // 政策整份被 11 個字元繞過。這條釘住那個入口也走掛標頭的路徑。
  it("GET /index.html 也要有 CSP——static 不得把 index.html 直接送出去（繞過整份政策）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/index.html", headers: { accept: "text/html" } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("knotebook spa");
    expect(res.headers["content-security-policy"], "/index.html 沒有 CSP＝整份政策可被繞過").toBeTypeOf(
      "string",
    );
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("JSON 404 不掛 CSP（那條路徑不是 HTML 文件）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  // gate 審查（m1）：CSP 只對 HTML 有意義，但 `nosniff` 是逐回應的便宜標頭，JSON 與
  // 靜態 JS 也該有——所以它掛在全域 onSend，不是只掛在 SPA 那條路徑上。
  it("nosniff 掛在**每個**回應上（JSON 與靜態資產也算），不只 HTML", async () => {
    const { app } = await buildTestApp({}, { webDist });

    const json = await app.inject({ method: "GET", url: "/api/nope" });
    expect(json.headers["x-content-type-options"], "JSON 回應缺 nosniff").toBe("nosniff");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["x-content-type-options"], "靜態資產缺 nosniff").toBe("nosniff");
  });

  it("#72：/p/ 前綴的 HTML fallback 帶 X-Robots-Tag: noindex（token 連結不進搜尋引擎）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    const res = await app.inject({ method: "GET", url: "/p/whatever-token", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });

  it("#72：/p 本身、//p/、/P/ 變體同樣 noindex（判定與 log 遮罩共用正規化——只修一邊的洩漏形審查實測過）", async () => {
    const { app } = await buildTestApp({}, { webDist });
    for (const url of ["/p", "//p/some-token", "/P/some-token"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["x-robots-tag"], url).toBe("noindex");
    }
  });

  it("#72 反向：其他路徑的 HTML fallback **不得**帶 X-Robots-Tag——條件標頭掛錯層＝整站 noindex", async () => {
    const { app } = await buildTestApp({}, { webDist });
    for (const url of ["/", "/nope", "/notes/some-ref", "/pnot-a-prefix"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["x-robots-tag"], url).toBeUndefined();
    }
  });
  it("不傳 webDist → GET /nope 仍是既有 JSON 404（既有行為不受影響）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/nope", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
