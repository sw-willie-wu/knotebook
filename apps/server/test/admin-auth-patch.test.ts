import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import { authProviders } from "../src/db/schema.js";
import { createOidcRuntimeRegistry, type OidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { openClientSecret, sealClientSecret } from "../src/auth/oidc-providers.js";
import { testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";

const ISS = "https://idp.example.com";
const NUL = String.fromCodePoint(0);

/** 一個啟用中、有 secret、resolved_issuer 已寫、版本 3 的 provider——§5.2 各案的起點。 */
async function seedLive(db: Parameters<typeof seedAuthProvider>[0]) {
  return seedAuthProvider(db, { issuerUrl: ISS, resolvedIssuer: ISS, clientId: "client-a", clientSecret: "secret-a", enabled: true, configVersion: 3 });
}

function patch(app: Awaited<ReturnType<typeof adminApp>>["app"], cookies: Record<string, string>, id: string, payload: object) {
  return app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies, payload });
}

describe("PATCH /api/admin/auth/providers/:id（#187 §5.2）", () => {
  it("只給站台管理員", async () => {
    const { app, db } = await adminApp();
    const p = await seedLive(db);
    await expectAdminOnly(app, db, "PATCH", `/api/admin/auth/providers/${p.id}`, { displayName: "x" });
  });

  it("§5.2 (a) 改 issuer（沒帶 secret）→ secret、resolved_issuer 清空、停用、版本 +1；回應 enabled=false、hasSecret=false", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://other.example.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ issuerUrl: "https://other.example.com", enabled: false, hasSecret: false, issuerResolved: false });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ clientSecretEncrypted: null, resolvedIssuer: null, enabled: false, configVersion: 4 });
  });

  it("§5.2 issuer 送同一個值（編輯表單每次都帶）→ 不清、不停用、版本不變（RF5 的 server 半）", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: ISS, displayName: "Renamed" });
    expect(res.statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ displayName: "Renamed", resolvedIssuer: ISS, enabled: true, configVersion: 3 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("§5.2 (b) 改 issuer＋同時帶新 secret → secret 是新值、resolved 清空、強制停用、版本 +1（r2-M3）", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://other.example.com", clientSecret: "secret-b", enabled: true });
    expect(res.statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ resolvedIssuer: null, enabled: false, configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-b");
  });

  it("§5.2 (b) 只帶 secret → 覆寫、版本 +1、啟用狀態與 resolved_issuer 不變", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    expect((await patch(app, cookies, p.id, { clientSecret: "secret-c" })).statusCode).toBe(200);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ enabled: true, resolvedIssuer: ISS, configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-c");
  });

  it("§5.2 只改 client_id → 新值、版本 +1；再送一次同值 → 版本不變；secret 都不清（r3-M2）", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { clientId: "client-b" });
    expect(await providerRow(db, p.id)).toMatchObject({ clientId: "client-b", configVersion: 4, enabled: true });
    await patch(app, cookies, p.id, { clientId: "client-b" });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ clientId: "client-b", configVersion: 4 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("§5.2 只改顯示名／排序／啟用 → 版本不變；PATCH 不帶 issuerUrl → 不清 secret、不停用", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { displayName: "Name 2", sortOrder: 5 });
    await patch(app, cookies, p.id, { enabled: false });
    await patch(app, cookies, p.id, { enabled: true });
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ displayName: "Name 2", sortOrder: 5, enabled: true, resolvedIssuer: ISS, configVersion: 3 });
    expect(openClientSecret(testConfig.appSecret, row!)).toBe("secret-a");
  });

  it("啟用沒有 secret 的 provider → 409 provider_secret_missing（DB CHECK，INV-1），列不變", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: ISS, clientSecret: null, enabled: false });
    const res = await patch(app, cookies, p.id, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("provider_secret_missing");
    expect((await providerRow(db, p.id))!.enabled).toBe(false);
  });

  it("clientSecret 空字串 → 400；空 body → 400；不存在的 uuid／非 uuid → 404 not_found", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    expect((await patch(app, cookies, p.id, { clientSecret: "" })).statusCode).toBe(400);
    expect((await patch(app, cookies, p.id, {})).statusCode).toBe(400);
    const missing = await patch(app, cookies, "00000000-0000-4000-8000-000000000000", { displayName: "x" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "找不到此登入服務" } });
    expect((await patch(app, cookies, "not-a-uuid", { displayName: "x" })).statusCode).toBe(404);
    expect(await providerRow(db, p.id)).toMatchObject({ configVersion: 3 });
  });

  it("RF1p PATCH 不合法輸入 → 400、列不變：大寫 scheme、NUL 顯示名、41 字顯示名", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedLive(db);
    for (const payload of [{ issuerUrl: "HTTPS://idp.example.com" }, { displayName: `a${NUL}` }, { displayName: "x".repeat(41) }]) {
      expect((await patch(app, cookies, p.id, payload)).statusCode).toBe(400);
    }
    expect(await providerRow(db, p.id)).toMatchObject({ issuerUrl: ISS, displayName: "SSO", configVersion: 3 });
  });

  it("RF4 大寫 uuid 路徑 → 與小寫同義；registry.invalidate 收到小寫 id（每次成功的 PATCH 都叫）", async () => {
    const invalidated: string[] = [];
    const inner = createOidcRuntimeRegistry();
    const registry: OidcRuntimeRegistry = { get: inner.get, probe: inner.probe, invalidate: id => { invalidated.push(id); inner.invalidate(id); } };
    const { app, db, cookies } = await adminApp({ oidcRegistry: registry });
    const p = await seedLive(db);
    const res = await patch(app, cookies, p.id.toUpperCase(), { displayName: "Upper" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(p.id);
    expect(invalidated).toEqual([p.id]);
    await patch(app, cookies, p.id, { enabled: true, clientId: "x" });
    expect(invalidated).toEqual([p.id, p.id]);
    await patch(app, cookies, p.id, { clientSecret: "" }); // 400：不 invalidate
    expect(invalidated).toHaveLength(2);
  });

  it("稽核 log：帶 issuerUrl 就記一行（值相同也記）；只記 origin+pathname；hasSecretAfter／enabledAfter 取 DB 回傳值", async () => {
    const logs = captureLogs();
    const { app, db, cookies, admin } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { issuerUrl: "https://user:pass@evil.example.com/realm?k=secret" });
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 被寫入");
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({ providerId: p.id, userId: admin.id, from: "https://idp.example.com/", to: "https://evil.example.com/realm", hasSecretAfter: false, enabledAfter: false });
    // 只記 origin+pathname：userinfo（user:pass@）與 query（?k=…）都不得出現在 from／to（gate r1-t1-7 M8：比對值本身，不比欄名）。
    for (const field of [line!.obj.from, line!.obj.to]) expect(String(field)).not.toMatch(/[?@]|pass/);
    logs.lines.length = 0;
    await patch(app, cookies, p.id, { issuerUrl: "https://user:pass@evil.example.com/realm?k=secret" });
    expect(logs.lines.filter(l => l.msg === "登入服務的 issuer 被寫入")).toHaveLength(1);
    logs.lines.length = 0;
    await patch(app, cookies, p.id, { displayName: "no issuer" });
    expect(logs.lines.filter(l => l.msg === "登入服務的 issuer 被寫入")).toHaveLength(0);
  });

  it("改成 http issuer → 另記一行 warn（§5.3）", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedLive(db);
    await patch(app, cookies, p.id, { issuerUrl: "http://idp.lan" });
    const line = logs.lines.find(l => l.msg === "登入服務的 issuer 是明文 http（§5.3）");
    expect(line?.level).toBe("warn");
  });

  it("C8 TOCTOU：攻擊者的 no-op PATCH（issuer 不變）排在受害者「改回正確 issuer＋重輸 secret」之後，也偷不到那把 secret", async () => {
    // 同 test/admin-ai.test.ts:353 的作法：另一條連線持行鎖把順序釘死，不賭機率。
    const { app, db, cookies } = await adminApp();
    const EVIL = "https://evil.example.com";
    const GOOD = "https://idp.example.com";
    const p = await seedAuthProvider(db, { issuerUrl: EVIL, clientSecret: null, enabled: false });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from auth_providers where id = $1 for update", [p.id]);
      const attacker = patch(app, cookies, p.id, { issuerUrl: EVIL });
      expect(await waitForBlockedOrSettled(db.$client, attacker)).toBe("blocked");
      await holder.query("update auth_providers set issuer_url = $1, client_secret_encrypted = $2::jsonb where id = $3", [
        GOOD,
        JSON.stringify(sealClientSecret(testConfig.appSecret, p.id, "victim-secret")),
        p.id,
      ]);
      await holder.query("commit");
      expect((await attacker).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    const row = await providerRow(db, p.id);
    expect(row!.issuerUrl).toBe(EVIL);
    expect(row!.clientSecretEncrypted).toBeNull();
    expect(row!.enabled).toBe(false);
  });

  it("RF3／C5：在飛的登入——只改顯示名 → 回來照常登入；改 client id → 回來 oidc_unavailable", async () => {
    for (const [change, expectedLocation] of [[{ displayName: "Renamed mid-flight" }, "/"], [{ clientId: "client-b" }, "/login?error=oidc_unavailable"]] as const) {
      const { app, db, idp, provider } = await buildOidcApp({ providers: [{ key: "a", issuerUrl: ISS }] });
      const admin = await seedUser(db, { isAdmin: true });
      const p = provider("a");
      idp("a").setNextLogin({ sub: `rf3-${Math.random()}`, email: `rf3-${Math.random()}@example.com`, name: "RF3" });
      const loginRes = await app.inject({ method: "GET", url: `/api/auth/oidc/login/${p.id}` });
      expect(loginRes.statusCode).toBe(302);
      const { code, state } = idp("a").authorize(loginRes.headers.location as string);
      const stateCookie = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
      expect((await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${p.id}`, cookies: await cookieOf(admin.id), payload: change })).statusCode).toBe(200);
      const callback = await app.inject({
        method: "GET",
        url: `/api/auth/oidc/callback/${p.id}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        cookies: { [OIDC_STATE_COOKIE]: stateCookie },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe(expectedLocation);
      const [row] = await db.select({ v: authProviders.configVersion }).from(authProviders).where(eq(authProviders.id, p.id));
      expect(row!.v).toBe("clientId" in change ? 2 : 1);
    }
  });
});

// 總管裁定（Task 3 審查 m1）：寫密文欄的那一句若遇非預期 DB 錯誤，全域 error handler 記整個 err——drizzle 0.44 的
// `DrizzleQueryError` 把 params（含 jsonb 的 ct／iv／tag）串進 message 也掛成屬性。用真的 trigger 讓 INSERT／UPDATE 失敗
// （SQLSTATE P0001，不是任何已知的 CHECK／唯一鍵），走真實的 drizzle 錯誤形，不靠假物件。
describe("寫 client secret 時遇非預期 DB 錯誤：回 500、log 不帶密文", () => {
  /** pino JSON 行裡 jsonb 的鍵會以 `\"ct\"` 形出現在 message 字串裡、以 `"ct"` 形出現在物件裡——兩形都抓。 */
  const SEALED_KEY = /\\*"(?:ct|iv|tag|keyId)\\*"/;

  async function failProviderWrites(db: Parameters<typeof seedAuthProvider>[0]) {
    await db.execute(sql.raw("create function kb_test_fail_provider_write() returns trigger language plpgsql as $$ begin raise exception 'forced test failure'; end $$"));
    await db.execute(sql.raw("create trigger kb_test_fail_provider_write before insert or update on auth_providers for each row execute function kb_test_fail_provider_write()"));
  }

  it.each(["POST", "PATCH"] as const)("%s：500 internal；log 全文不含 ct／iv／tag／keyId、不含 params；記 {code, constraint}", async method => {
    const out: string[] = [];
    const { app, db, cookies } = await adminApp({}, { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } });
    const p = await seedLive(db);
    await failProviderWrites(db);

    // 前提（不然這案量不到東西）：同一形錯誤原樣丟出時，訊息確實帶密文，且 SEALED_KEY 抓得到它在 JSON log 裡的形。
    const premise = await db
      .update(authProviders)
      .set({ clientSecretEncrypted: sealClientSecret(testConfig.appSecret, p.id, "premise") })
      .where(eq(authProviders.id, p.id))
      .catch((err: unknown) => err);
    expect(premise).toBeInstanceOf(DrizzleQueryError);
    expect((premise as Error).message).toContain('"ct"');
    expect(JSON.stringify({ msg: (premise as Error).message })).toMatch(SEALED_KEY);

    const res =
      method === "PATCH"
        ? await patch(app, cookies, p.id, { clientSecret: "leak-me-not" })
        : await app.inject({ method: "POST", url: "/api/admin/auth/providers", cookies, payload: { template: "oidc", displayName: "X", issuerUrl: ISS, clientId: "c", clientSecret: "leak-me-not" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "伺服器內部錯誤" } });

    const text = out.join("");
    expect(text).toContain('"code":"P0001"');
    expect(text).toContain("unhandled error");
    expect(text).not.toMatch(SEALED_KEY);
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("params");
    expect(text).not.toContain("leak-me-not");
  });
});
