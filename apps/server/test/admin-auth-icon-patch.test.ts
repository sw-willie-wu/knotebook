import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { authProviders } from "../src/db/schema.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, expectAdminOnly, providerRow } from "./helpers/admin-auth.js";
import { expectNoIconBytes, pngBytes } from "./helpers/provider-icon.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const patch = (app: FastifyInstance, cookies: Record<string, string>, id: string, payload: object) =>
  app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${id}`, cookies, payload });

/** 已上傳狀態的 fixture（直寫 DB——PUT 在 Task 5；本 fixture 不是被測方）。 */
async function seedUploaded(db: Db, template: "gitlab" | "google" | "oidc" = "oidc") {
  const p = await seedAuthProvider(db, { issuerUrl: `https://icon-${template}.example`, template, enabled: true });
  await db.update(authProviders).set({ iconKind: "upload", iconData: pngBytes(), iconMime: "image/png", iconVersion: 3 }).where(eq(authProviders.id, p.id));
  return p;
}

describe("PATCH /api/admin/auth/providers/:id 的 iconKind（spec §4.3、§8.1 S1／S5）", () => {
  it("S1：非管理員（真 session）403、未登入 401、管理員的有效 PAT 401；DB 不變", async () => {
    const { app, db, admin } = await adminApp();
    const p = await seedUploaded(db);
    const before = await providerRow(db, p.id);
    await expectAdminOnly(app, db, "PATCH", `/api/admin/auth/providers/${p.id}`, { iconKind: "gitlab" });
    const { token } = await seedTokenForUser(db, admin.id);
    const viaPat = await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${p.id}`, headers: bearer(token), payload: { iconKind: "gitlab" } });
    expect(viaPat.statusCode).toBe(401);
    expect(await providerRow(db, p.id)).toEqual(before);
  });

  it("S5：上傳後 PATCH {iconKind:'gitlab'} → data／mime 清空、icon_version 不變、config_version 不變、enabled 不變；回應帶換算後的 icon、不含圖檔位元組", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedUploaded(db);
    // updated_at 先寫成過去時刻：PATCH 沒更新它就抓得到（同一交易內 now() 與 seed 時刻太近，>= 斷言抓不到）。
    await db.update(authProviders).set({ updatedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(authProviders.id, p.id));
    const before = await providerRow(db, p.id);
    const res = await patch(app, cookies, p.id, { iconKind: "gitlab" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: p.id, iconKind: "gitlab", icon: { type: "builtin", name: "gitlab" }, enabled: true });
    expectNoIconBytes(res.body);
    const after = await providerRow(db, p.id);
    expect(after).toMatchObject({ iconKind: "gitlab", iconData: null, iconMime: null, iconVersion: 3, configVersion: before!.configVersion, enabled: true });
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("S5：iconKind 與 clientSecret 一起送 → 圖清掉、icon null、secret 已更新、config_version +1", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedUploaded(db);
    const before = await providerRow(db, p.id);
    const res = await patch(app, cookies, p.id, { clientSecret: "secret-new", iconKind: "none" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ iconKind: "none", icon: null, hasSecret: true });
    expectNoIconBytes(res.body);
    const after = await providerRow(db, p.id);
    expect(after).toMatchObject({ iconKind: "none", iconData: null, iconMime: null, iconVersion: 3, configVersion: before!.configVersion + 1 });
    expect(after!.clientSecretEncrypted).not.toBeNull();
    expect(after!.clientSecretEncrypted).not.toEqual(before!.clientSecretEncrypted);
  });

  it("S5：iconKind 與改 issuer 一起送 → 清圖＋清 secret＋自動停用", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedUploaded(db);
    const before = await providerRow(db, p.id);
    const res = await patch(app, cookies, p.id, { issuerUrl: "https://other-issuer.example", iconKind: "gitlab" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ iconKind: "gitlab", icon: { type: "builtin", name: "gitlab" }, enabled: false, hasSecret: false });
    const after = await providerRow(db, p.id);
    expect(after).toMatchObject({ iconKind: "gitlab", iconData: null, iconMime: null, clientSecretEncrypted: null, resolvedIssuer: null, enabled: false, configVersion: before!.configVersion + 1 });
  });

  it("S5：template／google／none 各自生效（none → icon null）；只帶 iconKind 合法", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://g.example", template: "google" });
    for (const [kind, icon] of [["none", null], ["gitlab", { type: "builtin", name: "gitlab" }], ["template", { type: "builtin", name: "google" }]] as const) {
      const res = await patch(app, cookies, p.id, { iconKind: kind });
      expect(res.statusCode, kind).toBe(200);
      expect(res.json(), kind).toMatchObject({ iconKind: kind, icon });
      expect((await providerRow(db, p.id))!.iconKind, kind).toBe(kind);
    }
  });

  it("S5：iconKind 'upload'／未知值／null → 400 invalid_body「請求格式錯誤」；DB 不變", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedUploaded(db);
    const before = await providerRow(db, p.id);
    for (const iconKind of ["upload", "svg", null, 1]) {
      const res = await patch(app, cookies, p.id, { iconKind });
      expect(res.statusCode, String(iconKind)).toBe(400);
      expect(res.json().error, String(iconKind)).toEqual({ code: "invalid_body", message: "請求格式錯誤" });
    }
    expect(await providerRow(db, p.id)).toEqual(before);
  });

  it("RF1：已上傳的服務送不帶 iconKind 的 PATCH（改顯示名、排序、停用）→ 圖示原封不動（kind／data／mime／version）", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedUploaded(db);
    for (const body of [{ displayName: "Renamed" }, { sortOrder: 9 }, { enabled: false }]) {
      const res = await patch(app, cookies, p.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(res.json().icon, JSON.stringify(body)).toEqual({ type: "upload", url: `/api/auth/providers/${p.id}/icon?v=3` });
      const row = await providerRow(db, p.id);
      expect(row, JSON.stringify(body)).toMatchObject({ iconKind: "upload", iconMime: "image/png", iconVersion: 3 });
      expect(Buffer.compare(row!.iconData!, pngBytes()), JSON.stringify(body)).toBe(0);
    }
  });

  it("Q2：只帶 iconKind 的 PATCH 也排在 B27 站台設定鎖之後（holder 扮演另一個站台設定寫入者；被測 PATCH 真的在跑）", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://lock.example" });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from site_settings where singleton for no key update");
      const inFlight = patch(app, cookies, p.id, { iconKind: "none" });
      expect(await waitForBlockedOrSettled(db.$client, inFlight)).toBe("blocked");
      expect((await providerRow(db, p.id))!.iconKind).toBe("template");
      await holder.query("commit");
      expect((await inFlight).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    expect((await providerRow(db, p.id))!.iconKind).toBe("none");
  });
});
