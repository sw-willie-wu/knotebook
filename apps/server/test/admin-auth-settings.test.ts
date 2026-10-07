import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { siteSettings, userIdentities, users } from "../src/db/schema.js";
import { insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
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
const get = (b: Built) => b.app.inject({ method: "GET", url: "/api/admin/auth/settings", cookies: b.cookies });
const patch = (b: Built, payload: object, cookies = b.cookies) => b.app.inject({ method: "PATCH", url: "/api/admin/auth/settings", cookies, payload });
const dbSettings = async (b: Built) => (await b.db.select().from(siteSettings))[0]!;
async function identity(db: Built["db"], userId: string, issuer: string, sub: string): Promise<string> {
  const [row] = await db.insert(userIdentities).values({ userId, issuer, sub }).returning({ id: userIdentities.id });
  return row!.id;
}
const patchProvider = (b: Built, id: string, payload: object) =>
  b.app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies: b.cookies, payload });

/** 等到這個測試 DB 上至少 `n` 條連線在等鎖（`waitForBlockedOrSettled` 只認 ≥1；兩條真請求都要卡住時用這個）。 */
async function waitForLockWaiters(pool: Built["db"]["$client"], n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等不到 ${n} 條等鎖連線（${timeoutMs}ms）`);
}

/**
 * 兩邊都是真路由的交錯：holder 只持 `auth_providers` 的 ACCESS EXCLUSIVE 表鎖（任何讀它的語句都會卡住），讓 `first` 在
 * 交易中途（已取得它的站台設定列鎖／FOR SHARE 之後、讀 `auth_providers` 時）停住；再送 `second`，等它也卡住（卡在 `first`
 * 持有的列鎖上）；放掉表鎖後 `first` 先提交、`second` 接著跑。holder 不模擬任何一方的寫入。
 */
async function interleave<T, U>(b: Built, first: () => Promise<T>, second: () => Promise<U>): Promise<[T, U]> {
  const holder = await holderFor(b.db);
  try {
    await holder.query("begin");
    await holder.query("lock table auth_providers in access exclusive mode");
    const p1 = first();
    expect(await waitForBlockedOrSettled(b.db.$client, p1)).toBe("blocked");
    const p2 = second();
    await waitForLockWaiters(b.db.$client, 2);
    await holder.query("commit");
    return [await p1, await p2];
  } finally {
    await holder.end();
  }
}

describe("GET /api/admin/auth/settings（#187 §9.5）", () => {
  it("只給站台管理員（GET 與 PATCH）", async () => {
    const b = await adminApp();
    await expectAdminOnly(b.app, b.db, "GET", "/api/admin/auth/settings");
    await expectAdminOnly(b.app, b.db, "PATCH", "/api/admin/auth/settings", { registrationEnabled: true });
  });

  it("預設形：DB 值、passwordLoginForced 分開；impact 三欄", async () => {
    const b = await adminApp();
    expect((await get(b)).json()).toEqual({
      registrationEnabled: true,
      passwordLoginEnabled: true,
      passwordLoginForced: false,
      passwordLoginImpact: { usersWithoutSso: 1, actingAdminHasSso: false, enabledProviders: 0 },
    });
    const forced = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await forced.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await get(forced)).json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginForced: true });
  });

  it("§14.1-28 usersWithoutSso：有身分但其 provider 停用 → 計入；無斜線身分＋尾斜線 provider 且 resolved_issuer 已寫 → 不計；停用帳號不計", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await seedAuthProvider(b.db, { issuerUrl: "https://off.example", enabled: false, clientSecret: null });
    const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
    await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
    const linkedOff = await seedUser(b.db);
    await identity(b.db, linkedOff.id, "https://off.example", "x");
    const linkedSlash = await seedUser(b.db);
    await identity(b.db, linkedSlash.id, B, "y");
    await seedUser(b.db, { disabled: true });
    // admin（無身分）＋ linkedOff ＝ 2；linkedSlash 不計；disabled 不計
    expect((await get(b)).json().passwordLoginImpact).toEqual({ usersWithoutSso: 2, actingAdminHasSso: false, enabledProviders: 2 });
  });

  it("讀不到 site_settings 列 → registration false、passwordLogin true＋error log（不回 500）", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
    expect(logs.lines.some(l => l.level === "error" && l.msg?.includes("site_settings"))).toBe(true);
  });
});

describe("PATCH /api/admin/auth/settings（#187 §9.5、B19、§14.1-24）", () => {
  it("body：{} → 400；多欄 → 400；非 boolean → 400", async () => {
    const b = await adminApp();
    for (const body of [{}, { registrationEnabled: true, x: 1 }, { passwordLoginEnabled: "false" }]) {
      expect((await patch(b, body)).json().error.code).toBe("invalid_body");
    }
  });

  it("只改 registrationEnabled → 200、回 GET 同形；不驗 B19（⑩：DB 已關、管理員無 SSO 也 200，DB 值仍關）", async () => {
    const b = await adminApp();
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    const res = await patch(b, { registrationEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: false, passwordLoginForced: false });
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: false });
  });

  it("①零個啟用 provider → 409 sso_provider_required、DB 不變", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A, enabled: false, clientSecret: null });
    const res = await patch(b, { passwordLoginEnabled: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("②操作者無可用身分（無身分／身分的 provider 停用）→ 409 admin_sso_link_required；③兩者皆滿足 → 200", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
    await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null });
    await identity(b.db, b.admin.id, B, "admin-b");
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
    await identity(b.db, b.admin.id, A, "admin-a");
    const ok = await patch(b, { passwordLoginEnabled: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginImpact: { actingAdminHasSso: true, enabledProviders: 1 } });
  });

  it("⑦env 強制期間結果相同（以 DB 值判）；⑧開啟永遠 200（零 provider 也行）", async () => {
    const b = await adminApp({ config: { ...testConfig, passwordLoginForceEnable: true } });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("sso_provider_required");
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await patch(b, { passwordLoginEnabled: true })).statusCode).toBe(200);
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("⑪DB 已關、管理員無 SSO、冪等重送 false → 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    expect((await patch(b, { passwordLoginEnabled: false })).json().error.code).toBe("admin_sso_link_required");
  });

  it("RF3：一次改兩個、帳密那半被擋 → 409，註冊開關也不變（整筆回滾）", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const res = await patch(b, { registrationEnabled: false, passwordLoginEnabled: false });
    expect(res.json().error.code).toBe("admin_sso_link_required");
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: true, passwordLoginEnabled: true });
  });

  it("RF2／B25：以密碼 session 關閉後，同一個 session 仍有效、可再開回；開回後密碼登入成功", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const pw = await insertPasswordUser(b.db, { password: "correct-horse-battery-staple" });
    await b.db.update(users).set({ isAdmin: true }).where(sql`id = ${pw.id}`);
    await identity(b.db, pw.id, A, "pw-a");
    const login = await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } });
    const cookies = { [SESSION_COOKIE]: login.cookies.find(c => c.name === SESSION_COOKIE)!.value };
    expect((await patch(b, { passwordLoginEnabled: false }, cookies)).statusCode).toBe(200);
    expect((await b.app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect((await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } })).statusCode).toBe(403);
    expect((await patch(b, { passwordLoginEnabled: true }, cookies)).statusCode).toBe(200);
    expect((await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: pw.email, password: pw.password } })).statusCode).toBe(200);
  });

  it("稽核 log：passwordLoginEnabled 有變才記一行（操作者、新值、passwordLoginForced）；沒變不記", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    await patch(b, { passwordLoginEnabled: true });
    expect(logs.lines.filter(l => l.msg === "帳密登入開關被變更")).toEqual([]);
    await patch(b, { passwordLoginEnabled: false });
    const lines = logs.lines.filter(l => l.msg === "帳密登入開關被變更");
    expect(lines.map(l => l.obj)).toEqual([expect.objectContaining({ userId: b.admin.id, passwordLoginEnabled: false, passwordLoginForced: false })]);
  });

  it("讀不到 site_settings 列 → 500＋log.error（§4.3；gate r1-t1-9 M5）", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    expect((await patch(b, { registrationEnabled: true })).statusCode).toBe(500);
    expect(logs.lines.some(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toBe(true);
  });

  it("P2 以 effective issuer 比：身分＝resolved_issuer、provider 的 issuer_url 帶尾斜線 → 關閉 200、actingAdminHasSso true（絕對值，不只是逐格一致）", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
    await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
    await identity(b.db, b.admin.id, B, "x");
    const res = await patch(b, { passwordLoginEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ passwordLoginEnabled: false, passwordLoginImpact: { actingAdminHasSso: true, usersWithoutSso: 0 } });
  });

  it("§14.1-28：actingAdminHasSso=false ⇔ 關閉 PATCH 回 admin_sso_link_required（同一個函式，逐格一致）", async () => {
    const cells: Array<[string, (b: Built) => Promise<void>]> = [
      ["無身分", async () => {}],
      ["身分的 provider 停用", async b => { await seedAuthProvider(b.db, { issuerUrl: B, enabled: false, clientSecret: null }); await identity(b.db, b.admin.id, B, "x"); }],
      ["精確相等", async b => { await identity(b.db, b.admin.id, A, "x"); }],
      ["尾斜線＋resolved 已寫", async b => {
        const p = await seedAuthProvider(b.db, { issuerUrl: `${B}/` });
        await b.db.execute(sql`update auth_providers set resolved_issuer = ${B} where id = ${p.id}`);
        await identity(b.db, b.admin.id, B, "x");
      }],
      ["尾斜線＋resolved 未寫（C31：只會誤擋）", async b => { await seedAuthProvider(b.db, { issuerUrl: `${B}/` }); await identity(b.db, b.admin.id, B, "x"); }],
    ];
    for (const [name, arrange] of cells) {
      const b = await adminApp();
      await seedAuthProvider(b.db, { issuerUrl: A });
      await arrange(b);
      const hasSso = (await get(b)).json().passwordLoginImpact.actingAdminHasSso as boolean;
      const res = await patch(b, { passwordLoginEnabled: false });
      expect(res.statusCode === 409 && res.json().error.code === "admin_sso_link_required", name).toBe(!hasSso);
    }
  });
});

describe("並發（#187 C25、C28；B27）", () => {
  it("P4 lost update（gate r1-t1-9 I1）：另一連線持鎖把 registration_enabled 改 false（未提交）→ 這邊只改 passwordLoginEnabled:true 等它提交 → registration 仍 false", async () => {
    const b = await adminApp();
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set registration_enabled = false");
      const pending = patch(b, { passwordLoginEnabled: true });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
  });

  it("C25(c)：另一連線停用最後一個 provider（持 B27 鎖、未提交）→ 關閉帳密等它提交 → 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update auth_providers set enabled = false where id = $1", [p.id]);
      const pending = patch(b, { passwordLoginEnabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("sso_provider_required");
    } finally {
      await holder.end();
    }
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("C28(i)：關閉先拿到鎖（未提交）→ 解除「有密碼＋最後一個身分」等它提交 → 讀到關 → 409 last_login_method", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const u = await insertPasswordUser(b.db);
    const idA = await identity(b.db, u.id, A, "ua");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      await holder.query("update site_settings set password_login_enabled = false");
      const pending = b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idA}`, cookies: await cookieOf(u.id) });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("last_login_method");
    } finally {
      await holder.end();
    }
  });

  it("C28(ii)：解除先拿到 FOR SHARE（未提交、已刪管理員唯一身分）→ 關閉等它提交 → P2 看得到身分已刪 → 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    const idA = await identity(b.db, b.admin.id, A, "admin-a");
    const holder = await holderFor(b.db);
    try {
      await holder.query("begin");
      await holder.query("select 1 from users where id = $1 for no key update", [b.admin.id]);
      await holder.query("select password_login_enabled from site_settings where singleton for share");
      await holder.query("delete from user_identities where id = $1", [idA]);
      const pending = patch(b, { passwordLoginEnabled: false });
      expect(await waitForBlockedOrSettled(b.db.$client, pending)).toBe("blocked");
      await holder.query("commit");
      expect((await pending).json().error.code).toBe("admin_sso_link_required");
    } finally {
      await holder.end();
    }
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });
});

describe("並發：兩邊都是真路由（C25、C28、P4；holder 只持表鎖、不模擬任何一方）", () => {
  it("C25(a) 真形：settings PATCH 關閉先拿到 B27 鎖 → provider PATCH 停用最後一個 provider 等它提交 → 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [close, disable] = await interleave(b, () => patch(b, { passwordLoginEnabled: false }), () => patchProvider(b, p.id, { enabled: false }));
    expect(close.statusCode).toBe(200);
    expect(disable.statusCode).toBe(409);
    expect(disable.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(false);
    expect((await b.db.execute<{ n: number }>(sql`select count(*)::int as n from auth_providers where enabled`)).rows[0]!.n).toBe(1);
  });

  it("C25(b) 真形：DB 關；provider PATCH 停用 p1 先拿到鎖 → 另一個停用 p2 等它提交 → 409，終態 p2 仍啟用", async () => {
    const b = await adminApp();
    const p1 = await seedAuthProvider(b.db, { issuerUrl: A });
    const p2 = await seedAuthProvider(b.db, { issuerUrl: B });
    await identity(b.db, b.admin.id, A, "a");
    await identity(b.db, b.admin.id, B, "b");
    await b.db.update(siteSettings).set({ passwordLoginEnabled: false });
    const [r1, r2] = await interleave(b, () => patchProvider(b, p1.id, { enabled: false }), () => patchProvider(b, p2.id, { enabled: false }));
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("sso_provider_required");
    const enabled = (await b.db.execute<{ id: string }>(sql`select id from auth_providers where enabled`)).rows.map(r => r.id);
    expect(enabled).toEqual([p2.id]);
  });

  it("C25(c) 真形：provider PATCH 停用最後一個先拿到鎖（DB 開、不驗）→ settings PATCH 關閉等它提交 → 409 sso_provider_required", async () => {
    const b = await adminApp();
    const p = await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [disable, close] = await interleave(b, () => patchProvider(b, p.id, { enabled: false }), () => patch(b, { passwordLoginEnabled: false }));
    expect(disable.statusCode).toBe(200);
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("sso_provider_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });

  it("P4 lost update 真形：settings PATCH（關註冊＋關帳密）先拿到鎖 → 另一個只開帳密等它提交 → 註冊仍關、帳密開", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "a");
    const [r1, r2] = await interleave(
      b,
      () => patch(b, { registrationEnabled: false, passwordLoginEnabled: false }),
      () => patch(b, { passwordLoginEnabled: true }),
    );
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(await dbSettings(b)).toMatchObject({ registrationEnabled: false, passwordLoginEnabled: true });
  });

  it("C28(i) 真形：settings PATCH 關閉先拿到鎖 → 解除「有密碼＋最後一個身分」等它提交 → 讀到關 → 409 last_login_method", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await identity(b.db, b.admin.id, A, "admin-a");
    const u = await insertPasswordUser(b.db);
    const idU = await identity(b.db, u.id, A, "ua");
    const uCookies = await cookieOf(u.id);
    const [close, unlink] = await interleave(
      b,
      () => patch(b, { passwordLoginEnabled: false }),
      () => b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idU}`, cookies: uCookies }),
    );
    expect(close.statusCode).toBe(200);
    expect(unlink.statusCode).toBe(409);
    expect(unlink.json().error.code).toBe("last_login_method");
  });

  it("C28(ii) 真形：解除（管理員有密碼、刪唯一身分）先拿到 FOR SHARE → settings PATCH 關閉等它提交 → 409 admin_sso_link_required", async () => {
    const b = await adminApp();
    await seedAuthProvider(b.db, { issuerUrl: A });
    await b.db.update(users).set({ passwordHash: "not-a-real-hash" }).where(sql`id = ${b.admin.id}`);
    const idA = await identity(b.db, b.admin.id, A, "admin-a");
    const [unlink, close] = await interleave(
      b,
      () => b.app.inject({ method: "DELETE", url: `/api/auth/identities/${idA}`, cookies: b.cookies }),
      () => patch(b, { passwordLoginEnabled: false }),
    );
    expect(unlink.statusCode).toBe(204);
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("admin_sso_link_required");
    expect((await dbSettings(b)).passwordLoginEnabled).toBe(true);
  });
});
