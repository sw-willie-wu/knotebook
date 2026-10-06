import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { siteSettings, userIdentities } from "../src/db/schema.js";
import { testConfig } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, providerRow } from "./helpers/admin-auth.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";

const A = "https://idp-a.example";
const B = "https://idp-b.example";
type Built = Awaited<ReturnType<typeof adminApp>>;

async function holderFor(db: Built["db"]): Promise<Client> {
  const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
  const dsn = new URL(process.env.TEST_DATABASE_URL!);
  dsn.pathname = `/${dbName}`;
  const holder = new Client({ connectionString: dsn.toString() });
  await holder.connect();
  return holder;
}
const patchProvider = (b: Built, id: string, payload: object) =>
  b.app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies: b.cookies, payload });
const off = (b: Built) => b.db.update(siteSettings).set({ passwordLoginEnabled: false });

describe("provider PATCH 的 B19 守衛（#187 §9.2 rev 10、§14.1-24 ④–⑨）", () => {
  it("④DB 關後停用唯一 enabled provider → 409 sso_provider_required、仍啟用", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    const res = await patchProvider(b, p.id, { enabled: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("sso_provider_required");
    expect((await providerRow(b.db, p.id))!.enabled).toBe(true);
  });

  it("⑤DB 關後以 §5.2 改 issuer（隱含停用）唯一 provider → 409，secret／issuer／版本都沒變（整筆回滾）", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A, configVersion: 3 });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    const before = await providerRow(b.db, p.id);
    const res = await patchProvider(b, p.id, { issuerUrl: "https://moved.example" });
    expect(res.json().error.code).toBe("sso_provider_required");
    expect(await providerRow(b.db, p.id)).toEqual(before);
  });

  it("⑥DB 關後停用操作者唯一連到的那個（另有別的 enabled provider）→ 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    const pa = await seedAuthProvider(b.db, { issuerUrl: A });
    await seedAuthProvider(b.db, { issuerUrl: B });
    await b.db.insert(userIdentities).values({ userId: b.admin.id, issuer: A, sub: "a" });
    await off(b);
    expect((await patchProvider(b, pa.id, { enabled: false })).json().error.code).toBe("admin_sso_link_required");
  });

  it("⑦env 強制期間結果相同；⑨DB 開時停用最後一個 provider → 200（rev 9 行為不變）", async () => {
    const forced = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const p = await seedAuthProvider(forced.db, { issuerUrl: A });
    await off(forced);
    expect((await patchProvider(forced, p.id, { enabled: false })).json().error.code).toBe("sso_provider_required");
    const b = await adminApp();
    const q = await seedAuthProvider(b.db, { issuerUrl: A });
    expect((await patchProvider(b, q.id, { enabled: false })).statusCode).toBe(200);
  });

  it("DB 關時不改 enabled 的 PATCH（只改顯示名）不驗守衛 → 200（即使操作者沒有 SSO）：啟用中的、與**本來就停用**的各一次", async () => {
    const b = await adminApp();
    const on = await seedAuthProvider(b.db, { issuerUrl: A });
    const offAlready = await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null });
    await off(b);
    expect((await patchProvider(b, on.id, { displayName: "Renamed" })).statusCode).toBe(200);
    // 本來就停用：寫入後 enabled 仍 false；只有「由 true 變 false」才驗——否則 P2 會擋（操作者沒有 SSO）。
    expect((await patchProvider(b, offAlready.id, { displayName: "Renamed too" })).statusCode).toBe(200);
  });

  it("讀不到 site_settings 列 → PATCH 與 DELETE 都 500＋log.error（§17 第 34 條；gate r1-t1-9 M5）", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    const p = await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    await b.db.delete(siteSettings);
    expect((await patchProvider(b, p.id, { displayName: "x" })).statusCode).toBe(500);
    expect((await b.app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies: b.cookies })).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toHaveLength(2);
  });
});

describe("B27：provider 寫入以 site_settings 列序列化（C25）", () => {
  it("C25(a)：另一連線關閉帳密（持鎖、未提交）→ 停用最後一個 provider 等它提交 → 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = patchProvider(b, p.id, { enabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await providerRow(b.db, p.id))!.enabled).toBe(true);
  });

  it("C25(b)：DB 關；另一連線停用 p1（持鎖、未提交）→ 這邊停用 p2 等它提交 → 409，終態至少一個 enabled", async () => {
    const b = await adminApp();
    const p1 = await seedAuthProvider(b.db, { issuerUrl: A });
    const p2 = await seedAuthProvider(b.db, { issuerUrl: B });
    await b.db.insert(userIdentities).values([{ userId: b.admin.id, issuer: A, sub: "a" }, { userId: b.admin.id, issuer: B, sub: "b" }]);
    await off(b);
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update auth_providers set enabled = false where id = $1", [p1.id]);
      const pending = patchProvider(b, p2.id, { enabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await providerRow(b.db, p2.id))!.enabled).toBe(true);
  });

  it("DELETE 也取 B27 鎖：另一連線持鎖 → DELETE 等它提交 → 204", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      const pending = b.app.inject({ method: "DELETE", url: `/api/admin/auth/providers/${p.id}`, cookies: b.cookies });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      await holder.end();
    }
  });
});
