/** #181：`/api/admin/trash/settings`。 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { siteSettings } from "../src/db/schema.js";
import { SITE_SETTINGS_MISSING_MESSAGE, TRASH_RETENTION_RANGE_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";

type Built = Awaited<ReturnType<typeof adminApp>>;
const URL_ = "/api/admin/trash/settings";
const get = (b: Built) => b.app.inject({ method: "GET", url: URL_, cookies: b.cookies });
const patch = (b: Built, payload: unknown) => b.app.inject({ method: "PATCH", url: URL_, cookies: b.cookies, payload: payload as object });
const dbRow = async (b: Built) => (await b.db.select().from(siteSettings))[0]!;

describe("AS1 讀與改", () => {
  it("預設 7；改 30、null、1、3650 都照存", async () => {
    const b = await adminApp();
    expect((await get(b)).json()).toEqual({ retentionDays: 7 });
    for (const v of [30, null, 1, 3650]) {
      const res = await patch(b, { retentionDays: v });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ retentionDays: v });
      expect((await dbRow(b)).trashRetentionDays).toBe(v);
      expect((await get(b)).json()).toEqual({ retentionDays: v });
    }
  });
});

describe("AS2 權限與輸入驗證", () => {
  it("非管理員 403、未登入 401（GET 與 PATCH）", async () => {
    const b = await adminApp();
    await expectAdminOnly(b.app, b.db, "GET", URL_);
    await expectAdminOnly(b.app, b.db, "PATCH", URL_, { retentionDays: 5 });
  });

  it.each([
    ["0", { retentionDays: 0 }],
    ["3651", { retentionDays: 3651 }],
    ["1.5", { retentionDays: 1.5 }],
    ['"7"', { retentionDays: "7" }],
    ["缺鍵", {}],
    ["多餘鍵", { retentionDays: 7, x: 1 }],
  ])("%s → 400 invalid_body、DB 不變", async (_n, body) => {
    const b = await adminApp();
    await patch(b, { retentionDays: 9 });
    const res = await patch(b, body);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect((await dbRow(b)).trashRetentionDays).toBe(9);
  });

  it.each([0, 3651])("%i 的 message 是範圍句", async n => {
    const b = await adminApp();
    const res = await patch(b, { retentionDays: n });
    expect(res.json().error.message).toBe(TRASH_RETENTION_RANGE_MESSAGE);
  });
});

describe("AS3 旁觀欄", () => {
  it("PATCH 後其他設定欄不變、updated_at 變大", async () => {
    const b = await adminApp();
    await b.db.execute(sql`update site_settings set updated_at = now() - interval '1 hour'`);
    const before = await dbRow(b);
    const res = await patch(b, { retentionDays: 14 });
    expect(res.statusCode, res.body).toBe(200);
    const after = await dbRow(b);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const strip = ({ trashRetentionDays: _t, updatedAt: _u, ...rest }: typeof before) => rest;
    expect(strip(after)).toEqual(strip(before));
    expect(after.trashRetentionDays).toBe(14);
  });
});

describe("AS4 讀不到 site_settings 列", () => {
  it("GET → 500 internal，log { table: \"site_settings\" }", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.$client.query(`delete from site_settings`);
    const res = await get(b);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });
    expect(logs.lines.find(l => l.msg === SITE_SETTINGS_MISSING_MESSAGE)?.obj).toEqual({ table: "site_settings" });
  });
});
