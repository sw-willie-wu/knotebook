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
const run = (db: Db, c: OidcClaims) => db.transaction(tx => resolveOidcLoginInTx(tx, { claims: c }));

async function seedUser(db: Db, over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values({ email: "u@example.com", displayName: "Existing", passwordHash: "h", ...over }).returning();
  return u!;
}

describe("resolveOidcLoginInTx（#187 §7.4 執行層）", () => {
  it("身分命中 → login：只寫 last_login_at；users 列逐欄不變（含 must_change_password=true，B15）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { mustChangePassword: true });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    const before = await db.select().from(users).where(eq(users.id, u.id));
    const r = await run(db, claims());
    expect(r).toEqual({ outcome: { kind: "login", userId: u.id, tokenVersion: u.tokenVersion }, settingsMissing: false });
    expect(await db.select().from(users).where(eq(users.id, u.id))).toEqual(before);
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).not.toBeNull();
  });

  it("身分命中但停用 → reject account_disabled、不寫 last_login_at", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { disabledAt: new Date() });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    expect((await run(db, claims())).outcome).toEqual({ kind: "reject", code: "account_disabled" });
    const [i] = await db.select().from(userIdentities).where(eq(userIdentities.userId, u.id));
    expect(i!.lastLoginAt).toBeNull();
  });

  it("新 email、註冊開啟 → created：registry-first、無密碼、must_change_password=false、**不寫舊欄**、identity 帶 last_login_at", async () => {
    const { db } = await buildTestApp();
    const r = await run(db, claims({ email: "new@example.com", preferredUsername: "Cool.Person" }));
    expect(r.outcome.kind).toBe("created");
    const id = (r.outcome as { userId: string }).userId;
    const [u] = await db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ email: "new@example.com", displayName: "U", passwordHash: null, mustChangePassword: false, handle: "cool-person", oidcIssuer: null, oidcSub: null });
    expect(await identitiesOf(db, id)).toEqual([{ issuer: ISS, sub: "s1" }]);
    const [h] = await db.select().from(handles).where(eq(handles.handle, "cool-person"));
    expect(h).toMatchObject({ userId: id, state: "live" });
  });

  it("新 email、註冊關閉 → registration_disabled、零寫入（W21）；site_settings 沒有列 → 同（視同關閉）＋settingsMissing", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ registrationEnabled: false });
    expect(await run(db, claims({ email: "new@example.com" }))).toEqual({ outcome: { kind: "reject", code: "registration_disabled" }, settingsMissing: false });
    await db.delete(siteSettings);
    expect(await run(db, claims({ email: "new@example.com" }))).toEqual({ outcome: { kind: "reject", code: "registration_disabled" }, settingsMissing: true });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("註冊關閉時：已連結身分照常 login、email 有帳號照常 confirm_link（W21 只管建帳）", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ registrationEnabled: false });
    const u = await seedUser(db);
    expect((await run(db, claims({ sub: "other" }))).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "s1" });
    expect((await run(db, claims())).outcome.kind).toBe("login");
  });

  it("email 已有帳號（大小寫混合舊列也算）→ confirm_link，零寫入；B14：停用或已有同 issuer 身分的帳號也是 confirm_link", async () => {
    for (const over of [{ email: "U@Example.com" }, { disabledAt: new Date() }]) {
      const { db } = await buildTestApp();
      const u = await seedUser(db, over);
      expect((await run(db, claims())).outcome).toEqual({ kind: "confirm_link", userId: u.id, email: "u@example.com" });
      expect(await identitiesOf(db, u.id)).toEqual([]);
    }
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    await db.insert(userIdentities).values({ userId: u.id, issuer: ISS, sub: "older-sub" });
    expect((await run(db, claims())).outcome.kind).toBe("confirm_link");
    expect(await identitiesOf(db, u.id)).toEqual([{ issuer: ISS, sub: "older-sub" }]);
  });

  it("純 SSO 帳號：連結的 provider 啟用中 → confirm_link；provider 停用 → oidc_link_no_proof_method", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db, { passwordHash: null });
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    await db.insert(userIdentities).values({ userId: u.id, issuer: "https://a.example", sub: "x" });
    expect((await run(db, claims())).outcome.kind).toBe("confirm_link");
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, a.id));
    expect((await run(db, claims())).outcome).toEqual({ kind: "reject", code: "oidc_link_no_proof_method" });
  });

  it("lower(email) 多列 → oidc_conflict；email 缺 → oidc_email_missing", async () => {
    const { db } = await buildTestApp();
    await seedUser(db, { email: "u@example.com" });
    await seedUser(db, { email: "U@EXAMPLE.com" });
    expect((await run(db, claims())).outcome).toEqual({ kind: "reject", code: "oidc_conflict" });
    expect((await run(db, claims({ email: null, sub: "zz" }))).outcome).toEqual({ kind: "reject", code: "oidc_email_missing" });
  });

  it("C17：關閉註冊的交易未 commit 時，首登交易卡在 site_settings FOR SHARE；commit 後得 registration_disabled", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const closer = await pool.connect();
    try {
      await closer.query("begin");
      await closer.query("update site_settings set registration_enabled = false");
      const login = run(db, claims({ email: "new@example.com" }));
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
