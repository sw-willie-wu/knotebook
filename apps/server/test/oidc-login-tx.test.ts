import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { identitiesOf, seedAuthProvider } from "./helpers/oidc-provider.js";
import { authProviders, handles, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { resolveOidcLoginInTx } from "../src/auth/tx/oidc-login.js";
import type { OidcClaims } from "../src/auth/oidc-login-decision.js";
import type { Db } from "../src/db/index.js";

const ISS = "https://idp.example";
const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({ issuer: ISS, sub: "s1", email: "u@example.com", name: "U", preferredUsername: null, ...over });
const run = (db: Db, c: OidcClaims, p: { id: string; configVersion: number }) =>
  db.transaction(tx => resolveOidcLoginInTx(tx, { claims: c, providerId: p.id, configVersion: p.configVersion }));
/** 登入用服務（issuer＝ISS；helper 預設開自動建帳）。 */
const seedRunProvider = (db: Db, over: { autoCreateEnabled?: boolean; configVersion?: number } = {}) =>
  seedAuthProvider(db, { issuerUrl: ISS, displayName: "Run", ...over });

async function seedUser(db: Db, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ email: "u@example.com", displayName: "Existing", passwordHash: "h", ...over }).returning();
  return u!;
}

describe("resolveOidcLoginInTx（#187 §7.4 執行層）", () => {
  it("身分命中 → login：只寫 last_login_at；users 列逐欄不變（含 must_change_password=true，B15）", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db, { mustChangePassword: true });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    const before = await db.select().from(users).where(eq(users.id, u.id));
    const r = await run(db, claims(), p);
    expect(r).toEqual({ outcome: { kind: "login", userId: u.id, tokenVersion: u.tokenVersion }, settingsMissing: false, providerStale: false });
    expect(await db.select().from(users).where(eq(users.id, u.id))).toEqual(before);
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).not.toBeNull();
  });

  it("身分命中但停用 → reject account_disabled、不寫 last_login_at", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db, { disabledAt: new Date() });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "account_disabled" });
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).toBeNull();
  });

  it("新 email、服務開了自動建帳 → created：registry-first、無密碼、must_change_password=false、**不寫舊欄**、identity 帶 last_login_at", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const r = await run(db, claims({ email: "new@example.com", preferredUsername: "Cool.Person" }), p);
    expect(r.outcome.kind).toBe("created");
    const id = (r.outcome as { userId: string }).userId;
    const [u] = await db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ email: "new@example.com", displayName: "U", passwordHash: null, mustChangePassword: false, handle: "cool-person", oidcIssuer: null, oidcSub: null });
    expect(await identitiesOf(db, id)).toEqual([{ issuer: ISS, sub: "s1" }]);
    const [h] = await db.select().from(handles).where(eq(handles.handle, "cool-person"));
    expect(h).toMatchObject({ userId: id, state: "live" });
  });

  it("T1（C-3）服務沒開自動建帳 → registration_disabled、零寫入；與站台開關無關", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { autoCreateEnabled: false });
    expect(await run(db, claims({ email: "new@example.com" }), p)).toEqual({
      outcome: { kind: "reject", code: "registration_disabled" },
      settingsMissing: false,
      providerStale: false,
    });
    expect(await db.select().from(users)).toHaveLength(0);
    // 站台 registration_enabled=false＋服務開 → 照樣建帳。
    const b = await buildTestApp();
    await b.db.update(siteSettings).set({ registrationEnabled: false });
    const q = await seedRunProvider(b.db);
    expect((await run(b.db, claims({ email: "new@example.com" }), q)).outcome.kind).toBe("created");
  });

  it("T2（C-5）site_settings 沒有列 → registration_disabled＋settingsMissing；服務列再刪掉仍是 registration_disabled、providerStale=false", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await db.delete(siteSettings);
    const expected = { outcome: { kind: "reject", code: "registration_disabled" }, settingsMissing: true, providerStale: false };
    // `.resolves`：誤走建帳時（缺列＝沒有預設方案）交易會拋錯，要讓它落成斷言失敗。
    await expect(run(db, claims({ email: "new@example.com" }), p)).resolves.toEqual(expected);
    // providerStale 只在 site_settings 列在時成立。
    await db.delete(authProviders).where(eq(authProviders.id, p.id));
    await expect(run(db, claims({ email: "new@example.com" }), p)).resolves.toEqual(expected);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("T3（C-5）服務開著但列已刪 → oidc_unavailable＋providerStale、零寫入", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await db.delete(authProviders).where(eq(authProviders.id, p.id));
    expect(await run(db, claims({ email: "new@example.com" }), p)).toEqual({
      outcome: { kind: "reject", code: "oidc_unavailable" },
      settingsMissing: false,
      providerStale: true,
    });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("T4（C-5）服務開著但 config_version 已變 → oidc_unavailable＋providerStale、零寫入；版本相符 → created", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { configVersion: 3 });
    expect(await run(db, claims({ email: "new@example.com" }), { id: p.id, configVersion: 2 })).toEqual({
      outcome: { kind: "reject", code: "oidc_unavailable" },
      settingsMissing: false,
      providerStale: true,
    });
    expect(await db.select().from(users)).toHaveLength(0);
    expect((await run(db, claims({ email: "new@example.com" }), p)).outcome.kind).toBe("created");
  });

  it("T5（C-4／C-5）服務沒開自動建帳、或版本已變：已連結身分照常 login、email 有帳號照常 confirm_link（只影響建帳那步）", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db, { autoCreateEnabled: false, configVersion: 2 });
    const cases = [
      { q: { id: p.id, configVersion: 2 }, providerStale: false },
      { q: { id: p.id, configVersion: 1 }, providerStale: true },
    ];
    const u = await seedUser(db);
    for (const { q, providerStale } of cases) {
      expect(await run(db, claims({ sub: "other" }), q)).toEqual({
        outcome: { kind: "confirm_link", userId: u.id, email: "u@example.com" },
        settingsMissing: false,
        providerStale,
      });
    }
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    for (const { q, providerStale } of cases) {
      expect(await run(db, claims(), q)).toEqual({
        outcome: { kind: "login", userId: u.id, tokenVersion: u.tokenVersion },
        settingsMissing: false,
        providerStale,
      });
    }
  });

  it("email 已有帳號（大小寫混合舊列也算）→ confirm_link，零寫入；B14：停用或已有同 issuer 身分的帳號也是 confirm_link", async () => {
    for (const over of [{ email: "U@Example.com" }, { disabledAt: new Date() }]) {
      const { db } = await buildTestApp();
      const p = await seedRunProvider(db);
      const u = await seedUser(db, over);
      expect((await run(db, claims(), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
      expect(await identitiesOf(db, u.id)).toEqual([]);
    }
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db);
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "older-sub" });
    expect((await run(db, claims(), p)).outcome.kind).toBe("confirm_link");
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: ISS, sub: "older-sub" }]);
  });

  // fix round 1（B14 裁定 A）：outcome 不帶 methods，所以這層看得到的是「同 issuer 的 provider 有沒有被算成證明方法」的後果——
  // 無密碼帳號只剩它時是 no_proof_method、還有別的 provider 時是 confirm_link。providers 清單的內容由單元案斷言。
  it("B14：純 SSO 帳號已有 ISS 身分（不同 sub）＋另一個 issuer 的已啟用 provider → confirm_link；ISS 的 provider 不算證明方法", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedAuthProvider(db, { issuerUrl: ISS, displayName: "IdP" });
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", displayName: "B" });
    await db.insert(userIdentities).values([
      { userId: u.id, issuer: ISS, sub: "older-sub" },
      { userId: u.id, issuer: "https://b.example", sub: "bx" },
    ]);
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
    // 停掉 B 之後只剩 ISS：若 ISS 被算進 methods，這裡會是 confirm_link。
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, b.id));
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: "https://b.example", sub: "bx" }, { issuer: ISS, sub: "older-sub" }]);
  });

  it("B14：目標帳號只有 ISS 身分、無密碼（ISS provider 啟用中，resolved_issuer 帶尾斜線形）→ oidc_link_no_proof_method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedAuthProvider(db, { issuerUrl: `${ISS}/`, resolvedIssuer: `${ISS}/`, displayName: "IdP" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: `${ISS}/`, sub: "older-sub" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });

  it("縱深防禦：claims.email 大小寫混合（未正規化）→ 比對到既有小寫帳號 → confirm_link（email 回正規化形），不建帳", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const u = await seedUser(db);
    expect((await run(db, claims({ email: " U@Example.COM " }), p)).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("純 SSO 帳號：連結的 provider 啟用中 → confirm_link；provider 停用 → oidc_link_no_proof_method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const p = await seedRunProvider(db);
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: "https://a.example", sub: "x" });
    expect((await run(db, claims(), p)).outcome.kind).toBe("confirm_link");
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, a.id));
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });

  it("lower(email) 多列 → oidc_conflict；email 缺 → oidc_email_missing", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    await seedUser(db, { email: "u@example.com" });
    await seedUser(db, { email: "U@EXAMPLE.com" });
    expect((await run(db, claims(), p)).outcome).toEqual({ kind: "reject", code: "oidc_conflict" });
    expect((await run(db, claims({ email: null, sub: "zz" }), p)).outcome).toEqual({ kind: "reject", code: "oidc_email_missing" });
  });

  it("C-6：持 B27 鎖把服務開關改成 false 的交易未 commit 時，首登交易卡在 site_settings FOR SHARE；commit 後得 registration_disabled", async () => {
    const { db } = await buildTestApp();
    const p = await seedRunProvider(db);
    const pool = db.$client;
    const closer = await pool.connect();
    try {
      await closer.query("begin");
      await closer.query("select singleton from site_settings for no key update");
      await closer.query("update auth_providers set auto_create_enabled = false where id = $1", [p.id]);
      const login = run(db, claims({ email: "new@example.com" }), p);
      expect(await waitForBlockedOrSettled(pool, login)).toBe("blocked");
      await closer.query("commit");
      expect((await login).outcome).toEqual({ kind: "reject", code: "registration_disabled" });
    } finally {
      await closer.query("rollback").catch(() => undefined);
      closer.release();
    }
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
