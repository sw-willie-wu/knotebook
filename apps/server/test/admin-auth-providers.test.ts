import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authProviders } from "../src/db/schema.js";
import { openClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const NUL = String.fromCodePoint(0);
/** 落單的高位代理（U+D800）：JSON 序列化成 `\ud800`，server 端 parse 回來仍是落單代理。 */
const LONE = String.fromCharCode(0xd800);
const base = { template: "oidc", displayName: "Corp SSO", issuerUrl: "https://idp.example.com", clientId: "knotebook" } as const;

describe("GET／POST /api/admin/auth/providers（#187 §9.2）", () => {
  it("兩個端點都只給站台管理員（非管理員 403、未登入 401）", async () => {
    const { app, db } = await adminApp();
    await expectAdminOnly(app, db, "GET", "/api/admin/auth/providers");
    await expectAdminOnly(app, db, "POST", "/api/admin/auth/providers", base);
  });

  it("POST 建立：201、一律停用、hasSecret、callbackUrl 是 <PUBLIC_URL>/api/auth/oidc/callback/<id>；回應不含 secret 任何形；DB 密文以 AAD 綁 id 解得開", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, clientSecret: "s3cret-value", template: "gitlab" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ template: "gitlab", displayName: "Corp SSO", issuerUrl: "https://idp.example.com", clientId: "knotebook", hasSecret: true, enabled: false, legacyCallback: false, insecureIssuer: false, issuerResolved: false });
    expect(body.callbackUrl).toBe(`http://localhost:3000/api/auth/oidc/callback/${body.id}`);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    for (const forbidden of ["s3cret-value", "clientSecretEncrypted", "client_secret", "\"ct\"", "\"iv\"", "\"tag\"", "keyId"]) {
      expect(res.body, forbidden).not.toContain(forbidden);
    }
    const row = await providerRow(db, body.id);
    expect(row!.enabled).toBe(false);
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("s3cret-value");
  });

  it("POST 不帶 clientSecret → hasSecret false、DB 密文 NULL", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.statusCode).toBe(201);
    expect(res.json().hasSecret).toBe(false);
    expect((await providerRow(db, res.json().id))!.clientSecretEncrypted).toBeNull();
  });

  it("POST 的 sortOrder 接在現有最大值之後（新服務排最後）", async () => {
    const { app, db, cookies } = await adminApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", sortOrder: 7 });
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.json().sortOrder).toBe(8);
  });

  it("POST 的 sortOrder 封頂 100000（＝PATCH 上限；之後編輯表單帶回原值仍合法，gate r1-t1-7 M1）", async () => {
    const { app, db, cookies } = await adminApp();
    await seedAuthProvider(db, { issuerUrl: "https://a.example", sortOrder: 100_000 });
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: base });
    expect(res.json().sortOrder).toBe(100_000);
  });

  it("GET 列表：排序（sortOrder → createdAt → id）、legacy 的 callbackUrl 是舊路徑、http issuer 標 insecure、resolved 標 issuerResolved；不含 secret", async () => {
    const { app, db, cookies } = await adminApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: "http://idp.lan", legacyCallback: true, sortOrder: 1, clientSecret: "legacy-secret" });
    const first = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/", resolvedIssuer: "https://gitlab.example", sortOrder: 0, displayName: "<b>Corp</b> & Co" });
    const res = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    expect(res.statusCode).toBe(200);
    const list = res.json().providers as Array<Record<string, unknown>>;
    expect(list.map(p => p.id)).toEqual([first.id, legacy.id]);
    expect(list[0]).toMatchObject({ displayName: "<b>Corp</b> & Co", issuerResolved: true, insecureIssuer: false, callbackUrl: `http://localhost:3000/api/auth/oidc/callback/${first.id}` });
    expect(list[1]).toMatchObject({ legacyCallback: true, insecureIssuer: true, issuerResolved: false, hasSecret: true, callbackUrl: "http://localhost:3000/api/auth/oidc/callback" });
    expect(res.body).not.toContain("legacy-secret");
    expect(res.body).not.toContain("clientSecretEncrypted");
  });

  it("POST http issuer → 201，並記一行 warn（§5.3：儲存時 log warn）", async () => {
    const logs = captureLogs();
    const { app, cookies } = await adminApp({}, logs.options);
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, issuerUrl: "http://idp.lan" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().insecureIssuer).toBe(true);
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 是明文 http（§5.3）");
    expect(line).toBeDefined();
    expect(line!.level).toBe("warn");
    expect(line!.obj).toMatchObject({ providerId: res.json().id });
  });

  // RF1：與 0014 的 CHECK 逐條對齊——zod 放行、CHECK 拒絕的形會變成 500。
  it.each([
    ["大寫 scheme（CHECK 大小寫敏感）", { issuerUrl: "HTTPS://idp.example.com" }, "issuer 網址必須以小寫 http:// 或 https:// 開頭"],
    ["issuer 513 字", { issuerUrl: `https://idp.example.com/${"a".repeat(489)}` }, "issuer 網址不得超過 512 個字元"],
    ["issuer 不是網址", { issuerUrl: "https://" }, "issuer 不是合法網址"],
    ["issuer 格式錯又帶帳密（refine 不得 throw 成 500）", { issuerUrl: "https://user:pass@ho st/v1" }, "issuer 不是合法網址"],
    ["issuer 帶帳密 user:pass@", { issuerUrl: "https://user:pass@idp.example.com" }, "issuer 網址不能包含帳號密碼"],
    ["issuer 只帶 user@", { issuerUrl: "https://user@idp.example.com" }, "issuer 網址不能包含帳號密碼"],
    ["顯示名 41 個 code point（emoji，UTF-16 長度 82）", { displayName: "😀".repeat(41) }, "顯示名稱須為 1 到 40 個字"],
    ["顯示名只有空白", { displayName: "   " }, "顯示名稱須為 1 到 40 個字"],
    ["顯示名含 NUL", { displayName: `a${NUL}b` }, "含有無法儲存的字元"],
    ["client id 513 字", { clientId: "c".repeat(513) }, "client ID 須為 1 到 512 個字"],
    ["clientSecret 空字串", { clientSecret: "" }, "client secret 不得為空"],
    ["clientSecret 只有空白", { clientSecret: "   " }, "client secret 不得為空"],
    // Task 3 審查 minor（Task 4 補）：secret 上限、三個字串欄的 NUL／落單代理。
    ["clientSecret 4097 字", { clientSecret: "s".repeat(4097) }, "client secret 不得超過 4096 個字元"],
    ["clientSecret 含 NUL", { clientSecret: `s${NUL}s` }, "client secret 含有無法儲存的字元"],
    ["clientSecret 含落單代理", { clientSecret: `s${LONE}s` }, "client secret 含有無法儲存的字元"],
    ["client id 含 NUL", { clientId: `c${NUL}c` }, "client ID 含有無法儲存的字元"],
    ["client id 含落單代理", { clientId: `c${LONE}c` }, "client ID 含有無法儲存的字元"],
    ["issuer 含 NUL", { issuerUrl: `https://idp.example.com/${NUL}` }, "issuer 網址含有無法儲存的字元"],
    ["issuer 含落單代理", { issuerUrl: `https://idp.example.com/${LONE}` }, "issuer 網址含有無法儲存的字元"],
    ["不認得的範本", { template: "github" }, "請求格式錯誤"],
    ["多一個欄位（strict）", { enabled: true }, "請求格式錯誤"],
  ])("RF1 POST 不合法輸入 → 400 invalid_body＋中文訊息、DB 沒有新列：%s", async (_name, patch, message) => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, ...patch } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "invalid_body", message: expect.stringContaining(message) } });
    expect(await db.select().from(authProviders)).toHaveLength(0);
  });

  it("RF1 前後空白會被修掉後存（顯示名、issuer、client id）", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, displayName: "  Corp  ", issuerUrl: " https://idp.example.com ", clientId: " knotebook " } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ displayName: "Corp", issuerUrl: "https://idp.example.com", clientId: "knotebook" });
  });

  it("clientSecret 前後的空白原樣存（不 trim；解開與送出的值相同）", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, clientSecret: "  padded secret \t" } });
    expect(res.statusCode).toBe(201);
    const row = await providerRow(db, res.json().id);
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("  padded secret \t");
  });

  it("40 個 emoji 的顯示名可以存（code point 計數，與 CHECK 的 char_length 一致）", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, displayName: "😀".repeat(40) } });
    expect(res.statusCode).toBe(201);
  });

  it("POST 的 id 由 server 產（body 帶 id 會被 strict 拒）", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { ...base, id: randomUUID() } });
    expect(res.statusCode).toBe(400);
  });
});
