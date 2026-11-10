/** #397 S6：`GET／PATCH /api/admin/limits`（spec §8、§11）。 */
import { describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { SITE_LIMIT_KEYS, SITE_LIMITS, siteLimitStep, type SiteLimitKey, type SiteLimitsDto } from "@knotebook/shared";
import { siteLimitChanges, siteLimits } from "../src/db/schema.js";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { adminApp, expectAdminOnly } from "./helpers/admin-auth.js";

type Built = Awaited<ReturnType<typeof adminApp>>;
const URL_ = "/api/admin/limits";
const get = (b: Built) => b.app.inject({ method: "GET", url: URL_, cookies: b.cookies });
const patch = (b: Built, payload: unknown) => b.app.inject({ method: "PATCH", url: URL_, cookies: b.cookies, payload: payload as object });
const counts = async (b: Built) => ({
  limits: (await b.db.select().from(siteLimits)).length,
  changes: (await b.db.select().from(siteLimitChanges)).length,
});
const item = (dto: SiteLimitsDto, key: SiteLimitKey) => dto.items.find(i => i.key === key)!;

describe("權限", () => {
  it("未登入 401、一般使用者 403、admin 200", async () => {
    const b = await adminApp();
    await expectAdminOnly(b.app, b.db, "GET", URL_);
    await expectAdminOnly(b.app, b.db, "PATCH", URL_, { set: { rateEdit: 10 } });
    expect((await get(b)).statusCode).toBe(200);
    expect((await patch(b, { set: { rateEdit: 10 } })).statusCode).toBe(200);
  });

  it("一般使用者 403 的 code 是 forbidden", async () => {
    const b = await adminApp();
    const plain = await seedUser(b.db);
    const res = await b.app.inject({ method: "GET", url: URL_, cookies: await cookieOf(plain.id) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    const resPatch = await b.app.inject({ method: "PATCH", url: URL_, cookies: await cookieOf(plain.id), payload: { set: { rateEdit: 10 } } });
    expect(resPatch.statusCode).toBe(403);
    expect(resPatch.json().error.code).toBe("forbidden");
  });
});

describe("超出範圍", () => {
  const cases: Array<[SiteLimitKey, string]> = [
    ["uploadMaxBytes", "bytes"],
    ["parseTimeoutMs", "ms"],
    ["rateEdit", "count"],
    ["sessionTtlSeconds", "seconds"],
  ];
  it.each(cases)("%s（%s）：min−step、max+step → 400；min、max → 200", async key => {
    const b = await adminApp();
    const { min, max } = SITE_LIMITS[key];
    const step = siteLimitStep(key);
    for (const bad of [min - step, max + step]) {
      const res = await patch(b, { set: { [key]: bad } });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
      expect(res.json().error.message).toContain("must be a whole number from");
      expect(await counts(b)).toEqual({ limits: 0, changes: 0 });
    }
    for (const ok of [min, max]) {
      const res = await patch(b, { set: { [key]: ok } });
      expect(res.statusCode, res.body).toBe(200);
      expect(item(res.json(), key).stored).toBe(ok);
    }
  });
});

describe("形狀", () => {
  it.each([
    ["未知 key", { set: { bogusKey: 1 } }],
    ["1.5", { set: { rateEdit: 1.5 } }],
    ['"3"', { set: { rateEdit: "3" } }],
    ["{ set: {} }", { set: {} }],
    ["外層多一個鍵", { set: { rateEdit: 10 }, extra: 1 }],
    ["set 不是物件", { set: 5 }],
    ["缺 set", {}],
  ])("%s → 400 invalid_body、訊息固定", async (_n, body) => {
    const b = await adminApp();
    const res = await patch(b, body);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect(res.json().error.message).toBe("Invalid request body.");
    expect(await counts(b)).toEqual({ limits: 0, changes: 0 });
  });
});

describe("沒對齊", () => {
  it.each([
    [{ noteMaxBytes: 1_048_577 }, "noteMaxBytes must be a multiple of 1048576."],
    [{ parseTimeoutMs: 4_500 }, "parseTimeoutMs must be a multiple of 1000."],
    [{ sessionTtlSeconds: 3_601 }, "sessionTtlSeconds must be a multiple of 3600."],
  ])("%j → 400 %s", async (set, message) => {
    const b = await adminApp();
    const res = await patch(b, { set });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toEqual({ code: "invalid_body", message });
    expect(await counts(b)).toEqual({ limits: 0, changes: 0 });
  });
});

describe("全有或全無", () => {
  it("{ rateEdit: 10, rateSearch: 1 } → 400、rateEdit 沒寫", async () => {
    const b = await adminApp();
    const res = await patch(b, { set: { rateEdit: 10, rateSearch: 1 } });
    expect(res.statusCode, res.body).toBe(400);
    expect(await counts(b)).toEqual({ limits: 0, changes: 0 });
    expect(item((await get(b)).json(), "rateEdit").stored).toBeNull();
  });
});

const LOCK_MSG = "noteMaxBytes is set by the server's environment variable NOTE_MAX_BYTES. Change it there and restart the server.";
const envConfig = { ...testConfig, limitEnv: { noteMaxBytes: 2_097_152 } };

describe("env 鎖定", () => {
  it("GET 顯示鎖定；PATCH 設值或 null → 409；同請求其他項也沒寫", async () => {
    const b = await adminApp({ config: envConfig });
    const it0 = item((await get(b)).json(), "noteMaxBytes");
    expect(it0).toMatchObject({ locked: true, source: "env", value: 2_097_152 });
    for (const v of [1_048_576, null]) {
      const res = await patch(b, { set: { noteMaxBytes: v } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toEqual({ code: "limit_locked_by_env", message: LOCK_MSG });
    }
    const res = await patch(b, { set: { noteMaxBytes: 1_048_576, rateEdit: 10 } });
    expect(res.statusCode).toBe(409);
    expect(await counts(b)).toEqual({ limits: 0, changes: 0 });
  });

  it("env 與存的列並存：GET 回 env 值＋stored；PATCH null → 409；列仍在", async () => {
    const first = await buildTestApp();
    await first.db.insert(siteLimits).values({ key: "noteMaxBytes", value: 1_048_576 });
    const built = await buildTestApp({ config: envConfig, db: first.db });
    const admin = await seedUser(first.db, { isAdmin: true });
    const b = { ...built, admin, cookies: await cookieOf(admin.id) } as Built;
    expect(item((await get(b)).json(), "noteMaxBytes")).toMatchObject({ value: 2_097_152, locked: true, source: "env", stored: 1_048_576 });
    const res = await patch(b, { set: { noteMaxBytes: null } });
    expect(res.statusCode, res.body).toBe(409);
    expect((await b.db.select().from(siteLimits)).map(r => r.key)).toEqual(["noteMaxBytes"]);
  });
});

describe("GET changes", () => {
  it("PATCH 51 次後 GET 只回 50 筆、倒序、actor 是 admin", async () => {
    const b = await adminApp();
    for (let i = 0; i < 51; i++) {
      const res = await patch(b, { set: { rateEdit: 3 + (i % 28) } });
      expect(res.statusCode, res.body).toBe(200);
    }
    const dto: SiteLimitsDto = (await get(b)).json();
    expect(dto.changes).toHaveLength(50);
    const times = dto.changes.map(c => Date.parse(c.changedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(dto.changes[0]!.actor?.email).toBe(b.admin.email);
    expect(dto.changes[0]).toMatchObject({ key: "rateEdit", newValue: 3 + (50 % 28) });
    expect(Number.isNaN(Date.parse(dto.changes[0]!.changedAt))).toBe(false);
    expect(dto.items.map(i => i.key)).toEqual([...SITE_LIMIT_KEYS]);
    expect(dto.machine.cpus).toBeGreaterThan(0);
  });

  it("PATCH 成功回同形（含 changes）", async () => {
    const b = await adminApp();
    const dto: SiteLimitsDto = (await patch(b, { set: { rateEdit: 7 } })).json();
    expect(item(dto, "rateEdit")).toMatchObject({ value: 7, source: "admin", stored: 7 });
    expect(dto.changes).toHaveLength(1);
    expect(dto.changes[0]).toMatchObject({ key: "rateEdit", oldValue: null, newValue: 7, oldEffective: 30, newEffective: 7 });
  });

  it("帳號不存在的 actor 回 null", async () => {
    const b = await adminApp();
    await patch(b, { set: { rateEdit: 7 } });
    const other = await seedUser(b.db, { isAdmin: true });
    await b.db.insert(siteLimitChanges).values({ key: "rateEdit", oldValue: 7, newValue: 8, oldEffective: 7, newEffective: 8, actorUserId: other.id });
    await b.db.$client.query(`delete from users where id = $1`, [other.id]);
    const dto: SiteLimitsDto = (await get(b)).json();
    expect(dto.changes.some(c => c.actor === null)).toBe(true);
  });
});

describe("同一時間的紀錄依 id 倒序", () => {
  it("兩列 changed_at 相同 → id desc", async () => {
    const b = await adminApp();
    const at = new Date("2026-01-01T00:00:00.000Z");
    const mk = (key: string) => ({ key, oldValue: null, newValue: 1, oldEffective: 0, newEffective: 1, actorUserId: b.admin.id, changedAt: at });
    await b.db.insert(siteLimitChanges).values([mk("tieA"), mk("tieB")]);
    const rows = await b.db.select().from(siteLimitChanges);
    const expected = rows.map(r => r.id).sort().reverse();
    const dto: SiteLimitsDto = (await get(b)).json();
    expect(dto.changes.map(c => c.id)).toEqual(expected);
  });
});

describe("未知 key 的紀錄照回", () => {
  it("bogusKey 的紀錄不被濾掉、不 500", async () => {
    const b = await adminApp();
    await b.db.insert(siteLimitChanges).values({ key: "bogusKey", oldValue: null, newValue: 1, oldEffective: 0, newEffective: 1, actorUserId: b.admin.id });
    const res = await get(b);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await b.db.select().from(siteLimitChanges).orderBy(desc(siteLimitChanges.changedAt));
    const found = (res.json() as SiteLimitsDto).changes.find(c => c.key === "bogusKey")!;
    expect(found).toMatchObject({ id: row!.id, oldValue: null, newValue: 1, oldEffective: 0, newEffective: 1 });
    expect(found.actor?.id).toBe(b.admin.id);
  });
});
