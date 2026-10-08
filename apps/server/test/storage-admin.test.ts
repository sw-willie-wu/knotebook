/**
 * 方案管理、預設、站台群組列表、用量檢視（spec 2026-10-08 §7；§11.1 S10、S11（預設）、S12（群組與檢視）；Review Focus RF3、RF4）。
 */
import { describe, expect, it } from "vitest";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { siteSettings } from "../src/db/schema.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { basicPlanId, giveUserQuota, seedAttachment, seedPlan, setGroupPlan, setUserPlan, upload } from "./storage-helpers.js";

type B = Awaited<ReturnType<typeof adminApp>>;
const req = (b: B, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  b.app.inject({ method, url, cookies: b.cookies, ...(payload ? { payload } : {}) });
const NUL = String.fromCodePoint(0);

describe("GET／POST／PATCH／DELETE /api/admin/storage-plans（S10）", () => {
  it("只限站台 admin（四支＋defaults）", async () => {
    const b = await adminApp();
    const id = await basicPlanId(b.db);
    await expectAdminOnly(b.app, b.db, "GET", "/api/admin/storage-plans");
    await expectAdminOnly(b.app, b.db, "POST", "/api/admin/storage-plans", { name: "X", quotaBytes: 1 });
    await expectAdminOnly(b.app, b.db, "PATCH", `/api/admin/storage-plans/${id}`, { name: "Y" });
    await expectAdminOnly(b.app, b.db, "DELETE", `/api/admin/storage-plans/${id}`);
    await expectAdminOnly(b.app, b.db, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: id });
  });

  it("GET：依 lower(name), id；Basic 帶 userCount／groupCount／isDefault 兩旗標；數字 typeof number；時間 ISO", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    await seedPlan(b.db, "alpha", 5);
    await seedPlan(b.db, "Zeta", null);
    const u = await seedUser(b.db);
    await seedGroup(b.db, "G", [{ userId: u.id, role: "admin" }]);
    const res = await req(b, "GET", "/api/admin/storage-plans");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plans.map((p: { name: string }) => p.name)).toEqual(["alpha", "Basic", "Zeta"]);
    const bp = body.plans.find((p: { id: string }) => p.id === basic);
    expect(bp).toMatchObject({ quotaBytes: 2147483648, userCount: 2, groupCount: 1, overQuotaCount: 0, isDefaultForUsers: true, isDefaultForGroups: true });
    for (const k of ["quotaBytes", "userCount", "groupCount", "overQuotaCount"]) expect(typeof bp[k], k).toBe("number");
    expect(new Date(bp.createdAt).toISOString()).toBe(bp.createdAt);
    expect(body.defaults).toEqual({ userPlanId: basic, groupPlanId: basic });
  });

  it("POST：201 DTO；名稱 trim；同名（大小寫不同）→ 409 storage_plan_name_taken；quotaBytes 邊界", async () => {
    const b = await adminApp();
    const ok = await req(b, "POST", "/api/admin/storage-plans", { name: "  Team  ", quotaBytes: 1125899906842624 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: "Team", quotaBytes: 1125899906842624, userCount: 0, groupCount: 0, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false });
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "team", quotaBytes: 1 })).json().error.code).toBe("storage_plan_name_taken");
    for (const q of [-1, 1.5, 1125899906842625, "1", undefined]) {
      const r = await req(b, "POST", "/api/admin/storage-plans", { name: `q${String(q)}`, ...(q === undefined ? {} : { quotaBytes: q }) });
      expect(r.statusCode, String(q)).toBe(400);
      expect(r.json().error, String(q)).toEqual({ code: "invalid_body", message: "請求格式錯誤" });
    }
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "zero", quotaBytes: 0 })).statusCode).toBe(201);
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "unl", quotaBytes: null })).json()).toMatchObject({ quotaBytes: null });
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "x", quotaBytes: 1, extra: 1 })).statusCode).toBe(400);
  });

  it("RF3：名稱邊界——全形空白 trim、40 個 astral 字元放行、41 個拒、空白名、NUL、落單代理 → 400 invalid_name（不是 500）", async () => {
    const b = await adminApp();
    const emoji = "😀";
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: `\u3000${emoji.repeat(40)}\u3000`, quotaBytes: 1 })).statusCode).toBe(201);
    for (const name of [emoji.repeat(41), "   ", "\u3000", `a${NUL}b`, "a\uD800b", "x".repeat(41)]) {
      const r = await req(b, "POST", "/api/admin/storage-plans", { name, quotaBytes: 1 });
      expect(r.statusCode, JSON.stringify(name)).toBe(400);
      expect(r.json().error, JSON.stringify(name)).toEqual({ code: "invalid_name", message: "方案名稱須為 1–40 個字元" });
    }
  });

  it("PATCH：改名改配額（Basic 也可）、updatedAt 前進；{} → 400；不存在／非 UUID → 404；同名 → 409；調低低於用量 → 200 無刪除、之後新增 409；調高 → 立即可新增", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    // 先把 updated_at 撥回一天前：同一毫秒內的兩次 now() 在 ISO 字串上可能相等，直接比會是時序假綠／假紅。
    await b.db.$client.query("update storage_plans set updated_at = now() - interval '1 day' where id = $1", [basic]);
    const before = (await req(b, "GET", "/api/admin/storage-plans")).json().plans.find((p: { id: string }) => p.id === basic);
    const r1 = await req(b, "PATCH", `/api/admin/storage-plans/${basic}`, { name: "Starter", quotaBytes: 4096 });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ id: basic, name: "Starter", quotaBytes: 4096 });
    expect(Date.parse(r1.json().updatedAt) - Date.parse(before.updatedAt)).toBeGreaterThan(12 * 3600 * 1000);
    expect((await req(b, "PATCH", `/api/admin/storage-plans/${basic}`, {})).statusCode).toBe(400);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await req(b, "PATCH", `/api/admin/storage-plans/${id}`, { name: "Q" })).json().error.code, id).toBe("storage_plan_not_found");
    }
    await seedPlan(b.db, "Other", 1);
    expect((await req(b, "PATCH", `/api/admin/storage-plans/${basic}`, { name: "OTHER" })).json().error.code).toBe("storage_plan_name_taken");

    const u = await seedUser(b.db);
    const p = await giveUserQuota(b.db, u.id, 1000);
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 800);
    expect((await req(b, "PATCH", `/api/admin/storage-plans/${p}`, { quotaBytes: 100 })).statusCode).toBe(200);
    expect((await b.db.$client.query("select count(*)::int n from uploads")).rows[0].n).toBe(1);
    expect((await upload(b.app, n.id, u.id, 8)).statusCode).toBe(409);
    const list = (await req(b, "GET", "/api/admin/storage-plans")).json();
    expect(list.plans.find((x: { id: string }) => x.id === p).overQuotaCount).toBe(1);
    // overQuotaCount 是「used > quota」：恰好等於上限的空間不算（M5 的鑑別案）。
    const atLimit = await seedUser(b.db);
    const pe = await giveUserQuota(b.db, atLimit.id, 500);
    const en = await seedNote(b.db, { ownerId: atLimit.id });
    await seedAttachment(b.db, b.uploadsDir, en.id, atLimit.id, 500);
    expect((await req(b, "GET", "/api/admin/storage-plans")).json().plans.find((x: { id: string }) => x.id === pe).overQuotaCount).toBe(0);
    expect((await req(b, "PATCH", `/api/admin/storage-plans/${p}`, { quotaBytes: 900 })).statusCode).toBe(200);
    expect((await upload(b.app, n.id, u.id, 100)).statusCode).toBe(201);
  });

  it("DELETE：未使用 → 204；使用中 → storage_plan_in_use；預設 → storage_plan_is_default；既是預設又使用中（Basic）→ storage_plan_is_default；不存在／非 UUID → 404", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    const free = await seedPlan(b.db, "Free", 1);
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${free}`)).statusCode).toBe(204);
    const used = await seedPlan(b.db, "Used", 1);
    await setUserPlan(b.db, b.admin.id, used);
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${used}`)).json().error.code).toBe("storage_plan_in_use");
    const def = await seedPlan(b.db, "Def", 1);
    await b.db.update(siteSettings).set({ defaultGroupStoragePlanId: def });
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${def}`)).json().error.code).toBe("storage_plan_is_default");
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${basic}`)).json().error.code).toBe("storage_plan_is_default");
    for (const id of [free, "nope"]) expect((await req(b, "DELETE", `/api/admin/storage-plans/${id}`)).json().error.code, id).toBe("storage_plan_not_found");
  });

  it("DELETE：既是預設又使用中 → storage_plan_is_default 不依賴 FK 觸發器的先後（site_settings 的 FK 重建到 users／groups 的之後也一樣）", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    // PG 的 RI 觸發器依觸發器名（RI_ConstraintTrigger_a_<oid>）排序觸發；migration 建出的庫裡 site_settings 兩條 FK 的 OID 較小、
    // 先觸發（2026-10-08 實測 pg_trigger），所以光靠 FK 映射也會回 is_default。把它們重建（拿到更大的 OID）讓 users_storage_plan_fk
    // 先觸發——這時只有 DELETE 的 `not in (預設)` 條件能讓結果仍是 is_default。
    await b.db.$client.query(`alter table site_settings
      drop constraint site_settings_default_user_plan_fk, drop constraint site_settings_default_group_plan_fk,
      add constraint site_settings_default_user_plan_fk foreign key (default_user_storage_plan_id) references storage_plans(id) on delete restrict,
      add constraint site_settings_default_group_plan_fk foreign key (default_group_storage_plan_id) references storage_plans(id) on delete restrict`);
    const order = await b.db.$client.query<{ conname: string }>(`select c.conname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
      where t.tgrelid = 'storage_plans'::regclass and t.tgname like 'RI_ConstraintTrigger_a_%' order by t.tgname limit 1`);
    expect(order.rows[0]!.conname).toBe("users_storage_plan_fk");
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${basic}`)).json().error.code).toBe("storage_plan_is_default");
  });
});

describe("PATCH /api/admin/storage-plans/defaults（S10、S11）", () => {
  it("不被 /:id 吃掉；改使用者預設 → 之後的直插使用者是新預設、既有不變；群組同；不存在／非 UUID 的 planId → 404；{} → 400", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    const p = await seedPlan(b.db, "P", null);
    const r = await req(b, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: p.toUpperCase() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ userPlanId: p, groupPlanId: basic });
    const nu = await seedUser(b.db);
    expect((await b.db.$client.query("select storage_plan_id from users where id = $1", [nu.id])).rows[0].storage_plan_id).toBe(p);
    expect((await b.db.$client.query("select storage_plan_id from users where id = $1", [b.admin.id])).rows[0].storage_plan_id).toBe(basic);
    expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", { groupPlanId: p })).json()).toEqual({ userPlanId: p, groupPlanId: p });
    const g = await seedGroup(b.db, "G", []);
    expect((await b.db.$client.query("select storage_plan_id from groups where id = $1", [g.id])).rows[0].storage_plan_id).toBe(p);
    // 真路由也吃到新群組預設（S11「群組同」）
    const viaRoute = await b.app.inject({ method: "POST", url: "/api/groups", cookies: b.cookies, payload: { name: "Routed" } });
    expect(viaRoute.statusCode).toBe(201);
    expect((await b.db.$client.query("select storage_plan_id from groups where id = $1", [viaRoute.json().id])).rows[0].storage_plan_id).toBe(p);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: id })).json().error.code, id).toBe("storage_plan_not_found");
    }
    expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", {})).statusCode).toBe(400);
  });

  it("site_settings 沒有列 → PATCH defaults 與 GET 列表都 500＋log.error(SITE_SETTINGS_MISSING_MESSAGE)", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: await basicPlanId(b.db) })).statusCode).toBe(500);
    expect((await req(b, "GET", "/api/admin/storage-plans")).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toHaveLength(2);
  });
});

describe("站台管理的群組（S12）", () => {
  it("GET /api/admin/groups：依 lower(name), id；memberCount、storage 四欄（typeof number）；只限站台 admin", async () => {
    const b = await adminApp();
    await expectAdminOnly(b.app, b.db, "GET", "/api/admin/groups");
    const u = await seedUser(b.db);
    const g1 = await seedGroup(b.db, "beta", [{ userId: u.id, role: "admin" }, { userId: b.admin.id, role: "member" }]);
    await seedGroup(b.db, "Alpha", []);
    const n = await seedNote(b.db, { groupId: g1.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 321);
    const res = await req(b, "GET", "/api/admin/groups");
    expect(res.json().map((g: { name: string }) => g.name)).toEqual(["Alpha", "beta"]);
    const row = res.json()[1];
    expect(row).toMatchObject({ id: g1.id, name: "beta", memberCount: 2, storage: { planId: await basicPlanId(b.db), planName: "Basic", usedBytes: 321, quotaBytes: 2147483648 } });
    expect(typeof row.storage.usedBytes).toBe("number");
  });

  it("PATCH /api/admin/groups/:id/storage-plan：200 AdminGroupDto；群組不存在／非 UUID → 404 group_not_found；方案不存在／非 UUID → 404 storage_plan_not_found；大寫 UUID 可", async () => {
    const b = await adminApp();
    const g = await seedGroup(b.db, "G", []);
    const p = await seedPlan(b.db, "P", 7);
    const ok = await req(b, "PATCH", `/api/admin/groups/${g.id.toUpperCase()}/storage-plan`, { planId: p.toUpperCase() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: g.id, storage: { planId: p, planName: "P", quotaBytes: 7, usedBytes: 0 } });
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await req(b, "PATCH", `/api/admin/groups/${id}/storage-plan`, { planId: p })).json().error.code, id).toBe("group_not_found");
      expect((await req(b, "PATCH", `/api/admin/groups/${g.id}/storage-plan`, { planId: id })).json().error.code, id).toBe("storage_plan_not_found");
    }
    await expectAdminOnly(b.app, b.db, "PATCH", `/api/admin/groups/${g.id}/storage-plan`, { planId: p });
  });
});

describe("用量檢視（S12）", () => {
  it("GET /api/storage：只回自己；未登入 401", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const pid = await seedPlan(b.db, "Mine", 999);
    await setUserPlan(b.db, u.id, pid);
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 12);
    const r = await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) });
    expect(r.json()).toEqual({ usedBytes: 12, quotaBytes: 999, planName: "Mine" });
    expect((await b.app.inject({ method: "GET", url: "/api/storage" })).statusCode).toBe(401);
  });

  it("GET /api/groups/:id/storage：manageGroup 200；一般成員 403；非成員 404；非成員站台 admin 200；非 UUID 404", async () => {
    const b = await adminApp();
    const [gAdmin, gMember, outsider] = await Promise.all([seedUser(b.db), seedUser(b.db), seedUser(b.db)]);
    const g = await seedGroup(b.db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    const pid = await seedPlan(b.db, "GP", null);
    await setGroupPlan(b.db, g.id, pid);
    const get = async (userId: string, id = g.id) => b.app.inject({ method: "GET", url: `/api/groups/${id}/storage`, cookies: await cookieOf(userId) });
    expect((await get(gAdmin.id)).json()).toEqual({ usedBytes: 0, quotaBytes: null, planName: "GP" });
    expect((await get(gMember.id)).statusCode).toBe(403);
    expect((await get(outsider.id)).statusCode).toBe(404);
    expect((await get(b.admin.id)).statusCode).toBe(200);
    expect((await get(gAdmin.id, "nope")).statusCode).toBe(404);
  });
});
