import { describe, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import type { BuildAppOptions } from "../src/app.js";
import { authProviders } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { sealClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";

/** registry 的 fetch 包一層記錄器：每個出站請求的 URL、headers、body 都記下來（「不送 secret」的直接守衛，gate r1-t1-7 I1）。 */
async function probeApp(idpIssuer: string, options: BuildAppOptions = {}) {
  const idp = createFakeIdp(idpIssuer);
  const requests: Array<{ url: string; headers: string; body: string }> = [];
  const fetch: CustomFetch = async (url, init) => {
    requests.push({ url: String(url), headers: JSON.stringify(init.headers ?? {}), body: init.body == null ? "" : String(init.body) });
    return idp.fetch(url, init);
  };
  const built = await adminApp({ oidcRegistry: createOidcRuntimeRegistry({ fetch }) }, options);
  return { ...built, idp, requests };
}

describe("POST /api/admin/auth/providers/:id/test（#187 §9.2）", () => {
  it("只給站台管理員", async () => {
    const { app, db } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    await expectAdminOnly(app, db, "POST", `/api/admin/auth/providers/${p.id}/test`);
  });

  it("成功：回 IdP 的 issuer、無 warning；每次都重新 discovery（不經快取）；出站請求只有 discovery、任何 URL／header／body 都不含 secret；寫 resolved_issuer", async () => {
    const { app, db, cookies, idp, requests } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: "test-secret" });
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ issuer: ISS, warnings: [] });
    }
    // 走 registry.get（快取）的話第二次不會 discovery → 1。
    expect(idp.counts).toEqual({ discovery: 2, token: 0, userinfo: 0 });
    expect(requests.map(req => new URL(req.url).pathname)).toEqual(["/.well-known/openid-configuration", "/.well-known/openid-configuration"]);
    for (const req of requests) expect(`${req.url} ${req.headers} ${req.body}`).not.toContain("test-secret");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBe(ISS);
  });

  it("§14.1-12 尾斜線形：provider 填 https://gitlab.example/、IdP 回無斜線 → 成功、resolved_issuer＝無斜線；列表 issuerResolved 轉 true", async () => {
    const { app, db, cookies } = await probeApp("https://gitlab.example");
    const p = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/" });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.json().issuer).toBe("https://gitlab.example");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBe("https://gitlab.example");
    const list = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    expect(list.json().providers[0].issuerResolved).toBe(true);
  });

  it("三種 warning：http issuer → insecure_issuer；metadata 沒宣告 client_secret_post → client_secret_post_not_advertised；secret 解不開 → secret_undecryptable（仍 200）", async () => {
    const { app, db, cookies, idp } = await probeApp("http://idp.lan");
    idp.omitFromMetadata(["token_endpoint_auth_methods_supported"]);
    const p = await seedAuthProvider(db, { issuerUrl: "http://idp.lan", clientSecret: null, enabled: false });
    // 封給「別的 id」的密文：格式合法、AAD 不符 → 解不開（§5.1）。
    await db.update(authProviders).set({ clientSecretEncrypted: sealClientSecret(testConfig.appSecret, "00000000-0000-4000-8000-000000000000", "x") });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(["insecure_issuer", "client_secret_post_not_advertised", "secret_undecryptable"]);
  });

  it("沒有 secret → 沒有 secret_undecryptable（沒有東西可解）", async () => {
    const { app, db, cookies } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: null, enabled: false });
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.json().warnings).toEqual([]);
  });

  it("discovery 失敗 → 502 oidc_discovery_failed、resolved_issuer 不寫；warn log 只帶 {providerId, issuer}，不帶錯誤訊息", async () => {
    const logs = captureLogs();
    const { app, db, cookies, idp } = await probeApp(ISS, logs.options);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    // 前提：同一形失敗的錯誤訊息長什麼樣（下面斷言 log 不含它；訊息為空就量不到東西）。
    idp.failNext("discovery");
    const errMessage = await createOidcRuntimeRegistry({ fetch: idp.fetch })
      .probe(ISS)
      .then(
        () => "",
        (err: unknown) => (err instanceof Error ? err.message : ""),
      );
    expect(errMessage).not.toBe("");

    idp.failNext("discovery");
    const res = await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id}/test`, cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("oidc_discovery_failed");
    expect((await providerRow(db, p.id))!.resolvedIssuer).toBeNull();
    const line = logs.lines.find(l => l.msg === "登入服務測試連線失敗");
    expect(line!.level).toBe("warn");
    expect(line!.obj).toEqual({ providerId: p.id, issuer: "https://idp.example.com/" });
    // 排除 fastify 生命週期行：理由同下方 /discover 失敗案。
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain(errMessage);
  });

  it("RF4t 大寫 uuid 路徑同義；不存在 → 404 not_found", async () => {
    const { app, db, cookies } = await probeApp(ISS);
    const p = await seedAuthProvider(db, { issuerUrl: ISS });
    expect((await app.inject({ method: "POST", url: `/api/admin/auth/providers/${p.id.toUpperCase()}/test`, cookies })).statusCode).toBe(200);
    const missing = await app.inject({ method: "POST", url: "/api/admin/auth/providers/00000000-0000-4000-8000-000000000000/test", cookies });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });
});

describe("POST /api/admin/auth/discover（#187 §9.2：儲存前試探）", () => {
  it("只給站台管理員", async () => {
    const { app, db } = await probeApp(ISS);
    await expectAdminOnly(app, db, "POST", "/api/admin/auth/discover", { issuerUrl: ISS });
  });

  it("成功回 issuer＋warning；不建任何列", async () => {
    const { app, db, cookies, idp } = await probeApp("http://idp.lan");
    idp.omitFromMetadata(["token_endpoint_auth_methods_supported"]);
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl: "http://idp.lan" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issuer: "http://idp.lan", warnings: ["insecure_issuer", "client_secret_post_not_advertised"] });
    expect(await db.select().from(authProviders)).toHaveLength(0);
  });

  it("discovery 失敗 → 502；warn log 只帶 origin+pathname，不帶 userinfo 與錯誤訊息（gate r1-t1-7 M5）", async () => {
    const logs = captureLogs();
    const { app, cookies, idp } = await probeApp(ISS, logs.options);
    idp.failNext("discovery");
    // issuer 帶 user:pass@ 現在在入口就 400（見下一條）；這裡改帶 query，仍驗 log 只留 origin+pathname。
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl: "https://idp.example.com?k=query-secret-marker" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("oidc_discovery_failed");
    const line = logs.lines.find(l => l.msg === "登入服務先試探失敗");
    expect(line!.obj).toEqual({ issuer: "https://idp.example.com/" });
    // fastify 生命週期行（incoming request／request completed）在 logMethod hook 看到的是序列化前的原始 req／res 物件（含 light-my-request 的 payload）；
    // 實際輸出經 `serializers.req`（app.ts `withTokenRedaction`）只剩 method／url／host／remote，不含 body——排除這兩種行。
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain("query-secret-marker");
  });

  it("issuer 帶帳密 → 400 invalid_body、不打 IdP；log 不含密碼（原 userinfo 斷言移到這裡）", async () => {
    const logs = captureLogs();
    const { app, cookies, idp } = await probeApp(ISS, logs.options);
    for (const issuerUrl of ["https://user:pass@idp.example.com", "https://user@idp.example.com"]) {
      const res = await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(idp.counts.discovery).toBe(0);
    expect(JSON.stringify(logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed"))).not.toContain("pass@");
  });

  it("RF1d 不合法 issuer（大寫 scheme、NUL）→ 400、不打 IdP", async () => {
    const { app, cookies, idp } = await probeApp(ISS);
    for (const issuerUrl of ["HTTPS://idp.example.com", `https://idp.example.com/${String.fromCodePoint(0)}`]) {
      expect((await app.inject({ method: "POST", url: "/api/admin/auth/discover", cookies, payload: { issuerUrl } })).statusCode).toBe(400);
    }
    expect(idp.counts.discovery).toBe(0);
  });
});
