import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { authProviders, userIdentities, users } from "../src/db/schema.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { linkedEnabledProviders, listEnabledProvidersPublic, loadEnabledProvider, loadLegacyProvider, openClientSecret, providerConfiguration, recordResolvedIssuer } from "../src/auth/oidc-providers.js";
import { SecretDecryptError } from "../src/lib/sealed-secret.js";

describe("auth/oidc-providers（#187 §4.1、§6）", () => {
  it("recordResolvedIssuer：版本述詞——舊版本不覆寫新設定；同值不寫；NULL → 寫", async () => {
    const { db } = await buildTestApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/" });
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://gitlab.example")).toBe(true);
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://gitlab.example")).toBe(false);
    await db.update(authProviders).set({ configVersion: 2, resolvedIssuer: null }).where(eq(authProviders.id, p.id));
    expect(await recordResolvedIssuer(db, { id: p.id, configVersion: 1 }, "https://stale.example")).toBe(false);
    const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, p.id));
    expect(row!.r).toBeNull();
  });

  it("providerConfiguration：尾斜線形——provider 填 https://gitlab.example/、IdP 回無斜線 → 成功並寫 resolved_issuer＝無斜線（r1-I1）；大寫 host 同", async () => {
    for (const [issuerUrl, idpIssuer] of [["https://gitlab.example/", "https://gitlab.example"], ["https://GitLab.Example", "https://gitlab.example"]] as const) {
      const { db } = await buildTestApp();
      const idp = createFakeIdp(idpIssuer);
      const registry = createOidcRuntimeRegistry({ fetch: idp.fetch });
      const p = await seedAuthProvider(db, { issuerUrl });
      const conf = await providerConfiguration({ db, registry, appSecret: testConfig.appSecret }, p);
      expect(conf.serverMetadata().issuer).toBe(idpIssuer);
      const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, p.id));
      expect(row!.r).toBe(idpIssuer);
    }
  });

  it("openClientSecret：AAD 綁 provider id——把 A 的密文搬到 B 解不開；secret NULL → SecretDecryptError", async () => {
    const { db } = await buildTestApp();
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example", clientSecret: "secret-a" });
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", clientSecret: null, enabled: false });
    expect(openClientSecret(testConfig.appSecret, a)).toBe("secret-a");
    expect(() => openClientSecret(testConfig.appSecret, { id: b.id, clientSecretEncrypted: a.clientSecretEncrypted })).toThrow(SecretDecryptError);
    expect(() => openClientSecret(testConfig.appSecret, b)).toThrow(SecretDecryptError);
  });

  it("查詢：loadEnabledProvider 不回停用的；loadLegacyProvider 只回啟用中的 legacy；listEnabledProvidersPublic 只列啟用、依 sort_order 排、只有 id 與 displayName", async () => {
    const { db } = await buildTestApp();
    const legacy = await seedAuthProvider(db, { issuerUrl: "https://l.example", legacyCallback: true, displayName: "Legacy", sortOrder: 5 });
    const g = await seedAuthProvider(db, { issuerUrl: "https://g.example", displayName: "G", sortOrder: 1 });
    const off = await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false });
    expect((await loadEnabledProvider(db, g.id))?.id).toBe(g.id);
    expect(await loadEnabledProvider(db, off.id)).toBeNull();
    expect((await loadLegacyProvider(db))?.id).toBe(legacy.id);
    expect(await listEnabledProvidersPublic(db)).toEqual([{ id: g.id, displayName: "G" }, { id: legacy.id, displayName: "Legacy" }]);
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, legacy.id));
    expect(await loadLegacyProvider(db)).toBeNull();
  });

  it("linkedEnabledProviders：用 effective issuer＝coalesce(resolved_issuer, issuer_url) 對身分；停用的不列", async () => {
    const { db } = await buildTestApp();
    const [u] = await db.insert(users).values({ email: "u@x", displayName: "U" }).returning();
    const slash = await seedAuthProvider(db, { issuerUrl: "https://gitlab.example/", resolvedIssuer: "https://gitlab.example", displayName: "GitLab" });
    await seedAuthProvider(db, { issuerUrl: "https://other.example", displayName: "Other" });
    const off = await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false });
    await db.insert(userIdentities).values([
      { userId: u!.id, issuer: "https://gitlab.example", sub: "1" },
      { userId: u!.id, issuer: "https://off.example", sub: "2" },
    ]);
    expect(await linkedEnabledProviders(db, u!.id)).toEqual([{ id: slash.id, displayName: "GitLab" }]);
    // resolved_issuer 為 NULL 時退回 issuer_url 字面：帶尾斜線的字面對不上無斜線的身分（spec §4.1「NULL 的影響」）。
    await db.update(authProviders).set({ resolvedIssuer: null }).where(eq(authProviders.id, slash.id));
    expect(await linkedEnabledProviders(db, u!.id)).toEqual([]);
    expect(off.enabled).toBe(false);
  });
});
