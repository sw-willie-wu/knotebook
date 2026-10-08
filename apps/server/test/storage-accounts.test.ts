/**
 * 使用者與群組的方案指派、四條建帳路徑的預設、site_settings 缺列的契約變更、建帳／建群組撞已刪預設的映射
 * （spec 2026-10-08 §4.2、§7.2、§10；§11.1 S11、S12（使用者）、S13、S14（構造錯誤））。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { resolveOidcLoginInTx } from "../src/auth/tx/oidc-login.js";
import { siteSettings, users } from "../src/db/schema.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { basicPlanId, seedAttachment, seedPlan } from "./storage-helpers.js";

const PW = "correct-horse-battery-staple";
type B = Awaited<ReturnType<typeof adminApp>>;
const createUser = (b: B, email: string) =>
  b.app.inject({ method: "POST", url: "/api/admin/users", cookies: b.cookies, payload: { email, password: PW, displayName: "N" } });
const planOfUser = async (db: B["db"], id: string) => (await db.select({ p: users.storagePlanId }).from(users).where(eq(users.id, id)))[0]!.p;
/** 收到的 log 整串序列化（Error 的 message／stack／cause 不可列舉，手動攤開——drizzle 把 params 串進 message）。 */
const logText = (lines: Array<{ msg?: string; obj: Record<string, unknown> }>) =>
  JSON.stringify(lines, (_k, v: unknown) => (v instanceof Error ? { ...v, message: v.message, stack: v.stack, cause: v.cause } : v));

describe("AdminUserDto.storage 與指派（S12、S13）", () => {
  it("GET /api/admin/users 每列帶 storage 四欄（typeof number）；停權使用者照常顯示用量", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db, { disabled: true });
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 4321);
    const res = await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies });
    const row = res.json().find((r: { id: string }) => r.id === u.id);
    expect(row.storage).toEqual({ planId: await basicPlanId(b.db), planName: "Basic", usedBytes: 4321, quotaBytes: 2147483648 });
    expect(typeof row.storage.usedBytes).toBe("number");
    expect(row.disabledAt).not.toBeNull();
  });

  it("POST /api/admin/users 201 帶 storage（新預設、用量 0）", async () => {
    const b = await adminApp();
    const p = await seedPlan(b.db, "NewDefault", 77);
    await b.db.update(siteSettings).set({ defaultUserStoragePlanId: p });
    const res = await createUser(b, "fresh@example.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().storage).toEqual({ planId: p, planName: "NewDefault", usedBytes: 0, quotaBytes: 77 });
  });

  it("PATCH /api/admin/users/:id/storage-plan：200 AdminUserDto；停權者可改（S13）；使用者不存在／非 UUID → 404 user_not_found；方案不存在／非 UUID → 404 storage_plan_not_found；大寫 UUID 可；只限站台 admin", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db, { disabled: true });
    const p = await seedPlan(b.db, "P", null);
    const url = (id: string) => `/api/admin/users/${id}/storage-plan`;
    const ok = await b.app.inject({ method: "PATCH", url: url(u.id.toUpperCase()), cookies: b.cookies, payload: { planId: p.toUpperCase() } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: u.id, storage: { planId: p, planName: "P", quotaBytes: null, usedBytes: 0 } });
    expect(await planOfUser(b.db, u.id)).toBe(p);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await b.app.inject({ method: "PATCH", url: url(id), cookies: b.cookies, payload: { planId: p } })).json().error.code, id).toBe("user_not_found");
      expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: { planId: id } })).json().error.code, id).toBe("storage_plan_not_found");
    }
    expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: {} })).statusCode).toBe(400);
    // strict：不能順手帶每人自己的數字
    expect((await b.app.inject({ method: "PATCH", url: url(u.id), cookies: b.cookies, payload: { planId: p, quotaBytes: 1 } })).statusCode).toBe(400);
    await expectAdminOnly(b.app, b.db, "PATCH", url(u.id), { planId: p });
  });
});

describe("四條建帳路徑都吃到「當下的」使用者預設；既有不變（S11）", () => {
  it("admin POST、register、OIDC 自動建帳、bootstrap", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    const p = await seedPlan(b.db, "P", 5);
    await b.db.update(siteSettings).set({ defaultUserStoragePlanId: p });

    const viaAdmin = (await createUser(b, "a1@example.com")).json().id as string;
    const reg = await b.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "r1@example.com", password: PW, displayName: "R" } });
    expect(reg.statusCode).toBe(201);
    await b.db.transaction(tx => resolveOidcLoginInTx(tx, { claims: { issuer: "https://idp.example", sub: "s-1", email: "o1@example.com", name: "O", preferredUsername: null } }));
    const [oidcUser] = await b.db.select({ id: users.id }).from(users).where(eq(users.email, "o1@example.com"));
    expect(oidcUser, "OIDC 自動建帳應建出帳號（註冊預設開）").toBeDefined();
    for (const id of [viaAdmin, reg.json().id as string, oidcUser!.id]) expect(await planOfUser(b.db, id)).toBe(p);
    expect(await planOfUser(b.db, b.admin.id)).toBe(basic);

    const fresh = await freshDb();
    const fp = await seedPlan(fresh.db, "FP", 9);
    await fresh.db.update(siteSettings).set({ defaultUserStoragePlanId: fp });
    await initializeInstance(fresh.db, { email: "boot@example.com", password: PW });
    const [boot] = await fresh.db.select({ p: users.storagePlanId }).from(users).where(eq(users.email, "boot@example.com"));
    expect(boot!.p).toBe(fp);
  });
});

describe("site_settings 沒有列（§4.2 契約變更）", () => {
  it("admin POST 建帳 → 500 且 log.error 含 SITE_SETTINGS_MISSING_MESSAGE、log 不帶密碼雜湊、不留帳號與 handle 列；POST /api/groups → 500＋同一句 log、不留群組", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    const before = (await b.db.$client.query("select (select count(*)::int from users) u, (select count(*)::int from handles) h, (select count(*)::int from groups) g")).rows[0];
    const missing = () => logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE).length;
    const r = await createUser(b, "x@example.com");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: "internal", message: "伺服器內部錯誤" } });
    expect(missing()).toBe(1);
    expect(logText(logs.lines).includes("$argon2"), "log 帶了密碼雜湊").toBe(false);
    expect((await b.app.inject({ method: "POST", url: "/api/groups", cookies: b.cookies, payload: { name: "G" } })).statusCode).toBe(500);
    expect(missing()).toBe(2);
    const after = (await b.db.$client.query("select (select count(*)::int from users) u, (select count(*)::int from handles) h, (select count(*)::int from groups) g")).rows[0];
    expect(after).toEqual(before);
  });

  it("bootstrap 首次啟動 → 拋出 23502（column storage_plan_id）、不留帳號列", async () => {
    const fresh = await freshDb();
    await fresh.db.delete(siteSettings);
    // 不用 toThrow(/storage_plan_id/)：DrizzleQueryError 的訊息本來就含整句 INSERT 的欄名清單，任何失敗都會命中。
    const err = await initializeInstance(fresh.db, { email: "boot@example.com", password: PW }).catch(e => e);
    expect(err?.cause ?? err).toMatchObject({ code: "23502", column: "storage_plan_id" });
    expect(await fresh.db.select().from(users)).toEqual([]);
  });
});

describe("建帳／建群組撞已刪的預設方案 → 409 server_busy（§10 m9；以 trigger 構造的 23503）", () => {
  it("admin POST：users_storage_plan_fk → 409 server_busy；其他名字的 23503 照舊 500、log 只記遮蔽後的摘要（不帶密碼雜湊）", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.$client.query(`
      create function pg_temp_raise_users_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'users_storage_plan_fk', message = 'constructed'; end $$;
      create trigger t_users_fk before insert on users for each row execute function pg_temp_raise_users_fk();`);
    const r = await createUser(b, "y@example.com");
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: "server_busy", message: "伺服器忙碌，請稍後再試" } });
    await b.db.$client.query(`
      create or replace function pg_temp_raise_users_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'something_else_fk', message = 'constructed'; end $$;`);
    expect((await createUser(b, "z@example.com")).statusCode).toBe(500);
    expect(logs.lines.some(l => l.level === "error" && l.obj.code === "23503" && l.obj.constraint === "something_else_fk" && l.obj.context === "建立使用者")).toBe(true);
    expect(logText(logs.lines).includes("$argon2"), "log 帶了密碼雜湊").toBe(false);
  });

  it("POST /api/groups：groups_storage_plan_fk → 409 server_busy、不留群組", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await db.$client.query(`
      create function pg_temp_raise_groups_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = 'groups_storage_plan_fk', message = 'constructed'; end $$;
      create trigger t_groups_fk before insert on groups for each row execute function pg_temp_raise_groups_fk();`);
    const r = await app.inject({ method: "POST", url: "/api/groups", cookies: await cookieOf(u.id), payload: { name: "G" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("server_busy");
    expect((await db.$client.query("select count(*)::int n from groups")).rows[0].n).toBe(0);
  });
});
