import { describe, expect, it } from "vitest";
import type { StorageByKind } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import type { Db } from "../src/db/index.js";
import { siteSettings, uploads } from "../src/db/schema.js";
import { readSpaceUsage, readSpaceUsageByKind } from "../src/storage/usage.js";
import { adminApp, captureLogs, expectAdminOnly } from "./helpers/admin-auth.js";
import { cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, setMemberRole } from "./group-helpers.js";
import { basicPlanId, giveUserQuota, seedAttachment, seedPlan, setGroupPlan, setUserPlan, upload } from "./storage-helpers.js";

type B = Awaited<ReturnType<typeof adminApp>>;
const req = (b: B, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  b.app.inject({ method, url, cookies: b.cookies, ...(payload ? { payload } : {}) });
const NUL = String.fromCodePoint(0);

/**
 * Inserts an uploads row directly (#247: the upload endpoint accepts only four image kinds; other kinds can only be made this way).
 * No disk file: GET usage does not read files. `chargedToId` defaults to `uploaderId`, as the real upload path writes it; pass it
 * explicitly to make charged != uploader.
 */
async function seedUploadRow(
  db: Db, noteId: string, uploaderId: string | null, mime: string, size: number, chargedToId: string | null = uploaderId,
): Promise<void> {
  await db.insert(uploads).values({ noteId, uploaderId, chargedToId, mime, size });
}
const ZERO: StorageByKind = { image: 0, audio: 0, video: 0, document: 0, other: 0 };

describe("GET/POST/PATCH/DELETE /api/admin/storage-plans", () => {
  it("site admin only (four endpoints plus defaults)", async () => {
    const b = await adminApp();
    const id = await basicPlanId(b.db);
    await expectAdminOnly(b.app, b.db, "GET", "/api/admin/storage-plans");
    await expectAdminOnly(b.app, b.db, "POST", "/api/admin/storage-plans", { name: "X", quotaBytes: 1 });
    await expectAdminOnly(b.app, b.db, "PATCH", `/api/admin/storage-plans/${id}`, { name: "Y" });
    await expectAdminOnly(b.app, b.db, "DELETE", `/api/admin/storage-plans/${id}`);
    await expectAdminOnly(b.app, b.db, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: id });
  });

  it("GET: ordered by lower(name), id; Basic has userCount/groupCount and two isDefault flags; numbers are typeof number; times are ISO", async () => {
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

  it("POST: 201 DTO; name trimmed; same name in a different case -> 409 storage_plan_name_taken; quotaBytes boundaries", async () => {
    const b = await adminApp();
    const ok = await req(b, "POST", "/api/admin/storage-plans", { name: "  Team  ", quotaBytes: 1125899906842624 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: "Team", quotaBytes: 1125899906842624, userCount: 0, groupCount: 0, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false });
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "team", quotaBytes: 1 })).json().error.code).toBe("storage_plan_name_taken");
    for (const q of [-1, 1.5, 1125899906842625, "1", undefined]) {
      const r = await req(b, "POST", "/api/admin/storage-plans", { name: `q${String(q)}`, ...(q === undefined ? {} : { quotaBytes: q }) });
      expect(r.statusCode, String(q)).toBe(400);
      expect(r.json().error, String(q)).toEqual({ code: "invalid_body", message: "Invalid request body." });
    }
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "zero", quotaBytes: 0 })).statusCode).toBe(201);
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "unl", quotaBytes: null })).json()).toMatchObject({ quotaBytes: null });
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: "x", quotaBytes: 1, extra: 1 })).statusCode).toBe(400);
  });

  it("name boundaries: full-width space trimmed, 40 astral characters allowed, 41 rejected, blank name, NUL, lone surrogate -> 400 invalid_name (not 500)", async () => {
    const b = await adminApp();
    const emoji = "😀";
    expect((await req(b, "POST", "/api/admin/storage-plans", { name: `\u3000${emoji.repeat(40)}\u3000`, quotaBytes: 1 })).statusCode).toBe(201);
    for (const name of [emoji.repeat(41), "   ", "\u3000", `a${NUL}b`, "a\uD800b", "x".repeat(41)]) {
      const r = await req(b, "POST", "/api/admin/storage-plans", { name, quotaBytes: 1 });
      expect(r.statusCode, JSON.stringify(name)).toBe(400);
      expect(r.json().error, JSON.stringify(name)).toEqual({ code: "invalid_name", message: "Plan names must be 1 to 40 characters." });
    }
  });

  it("PATCH: rename and change quota (Basic too), updatedAt advances; {} -> 400; missing/non-UUID -> 404; same name -> 409; lowering below usage -> 200 with no deletion, later additions 409; raising -> additions work at once", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    // Move updated_at back a day first: two now() calls in the same millisecond can be equal as ISO strings, so comparing directly is a timing false green/red.
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
    // overQuotaCount is "used > quota": a space exactly at the limit does not count (discriminating case).
    const atLimit = await seedUser(b.db);
    const pe = await giveUserQuota(b.db, atLimit.id, 500);
    const en = await seedNote(b.db, { ownerId: atLimit.id });
    await seedAttachment(b.db, b.uploadsDir, en.id, atLimit.id, 500);
    expect((await req(b, "GET", "/api/admin/storage-plans")).json().plans.find((x: { id: string }) => x.id === pe).overQuotaCount).toBe(0);
    expect((await req(b, "PATCH", `/api/admin/storage-plans/${p}`, { quotaBytes: 900 })).statusCode).toBe(200);
    expect((await upload(b.app, n.id, u.id, 100)).statusCode).toBe(201);
  });

  it("DELETE: unused -> 204; in use -> storage_plan_in_use; default -> storage_plan_is_default; both default and in use (Basic) -> storage_plan_is_default; missing/non-UUID -> 404", async () => {
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

  it("DELETE: both default and in use -> storage_plan_is_default without relying on the site_settings FKs (same with those two FKs removed)", async () => {
    const b = await adminApp();
    const basic = await basicPlanId(b.db);
    // With the two site_settings FKs present, the FK mapping alone might also return is_default (depends on the RI trigger firing
    // order). With them dropped, the only FKs a Basic delete can hit are users'/groups' (-> in_use), so is_default can come only from
    // DELETE's `not in (default)` condition. Not recreated: after recreation the order depends on OID, outside this case's control.
    await b.db.$client.query(`alter table site_settings
      drop constraint site_settings_default_user_plan_fk, drop constraint site_settings_default_group_plan_fk`);
    const left = await b.db.$client.query<{ conname: string }>(`select c.conname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
      where t.tgrelid = 'storage_plans'::regclass and t.tgname like 'RI_ConstraintTrigger_a_%' order by c.conname`);
    expect([...new Set(left.rows.map(r => r.conname))]).toEqual(["groups_storage_plan_fk", "users_storage_plan_fk"]);
    expect((await req(b, "DELETE", `/api/admin/storage-plans/${basic}`)).json().error.code).toBe("storage_plan_is_default");
  });

  it("DELETE concurrent with changing the default: the site_settings FK blocks (23503) -> storage_plan_is_default; a 23503 with another name is still 500 (error built with a trigger)", async () => {
    const b = await adminApp();
    // A real race would need the default change to commit right after DELETE's subquery snapshot, and that timing is uncontrollable; a BEFORE DELETE trigger throws a 23503 with a constraint name instead, testing the catch's branching directly.
    const raise = (constraint: string) => b.db.$client.query(`
      create or replace function raise_plan_delete_fk() returns trigger language plpgsql as $$
      begin raise exception using errcode = '23503', constraint = '${constraint}', message = 'constructed'; end $$;`);
    await raise("site_settings_default_user_plan_fk");
    await b.db.$client.query("create trigger t_plan_delete_fk before delete on storage_plans for each row execute function raise_plan_delete_fk()");
    const del = async () => req(b, "DELETE", `/api/admin/storage-plans/${await seedPlan(b.db, `F-${Math.random().toString(36).slice(2, 8)}`, 1)}`);
    expect((await del()).json()).toEqual({ error: { code: "storage_plan_is_default", message: "This is the default plan. Make another plan the default first." } });
    await raise("site_settings_default_group_plan_fk");
    expect((await del()).json().error.code).toBe("storage_plan_is_default");
    await raise("something_else_fk");
    expect((await del()).statusCode).toBe(500);
  });
});

describe("PATCH /api/admin/storage-plans/defaults", () => {
  it("not swallowed by /:id; changing the user default -> later directly inserted users get the new default, existing unchanged; same for groups; missing/non-UUID planId -> 404; {} -> 400", async () => {
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
    const viaRoute = await b.app.inject({ method: "POST", url: "/api/groups", cookies: b.cookies, payload: { name: "Routed" } });
    expect(viaRoute.statusCode).toBe(201);
    expect((await b.db.$client.query("select storage_plan_id from groups where id = $1", [viaRoute.json().id])).rows[0].storage_plan_id).toBe(p);
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: id })).json().error.code, id).toBe("storage_plan_not_found");
    }
    expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", {})).statusCode).toBe(400);
  });

  it("site_settings has no row -> PATCH defaults and GET list both 500 plus log.error(SITE_SETTINGS_MISSING_MESSAGE)", async () => {
    const logs = captureLogs();
    const b = await adminApp({}, logs.options);
    await b.db.delete(siteSettings);
    expect((await req(b, "PATCH", "/api/admin/storage-plans/defaults", { userPlanId: await basicPlanId(b.db) })).statusCode).toBe(500);
    expect((await req(b, "GET", "/api/admin/storage-plans")).statusCode).toBe(500);
    expect(logs.lines.filter(l => l.level === "error" && l.msg === SITE_SETTINGS_MISSING_MESSAGE)).toHaveLength(2);
  });
});

describe("site admin groups", () => {
  it("GET /api/admin/groups: ordered by lower(name), id; memberCount and four storage fields (typeof number); site admin only", async () => {
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
    expect(row).toMatchObject({ id: g1.id, name: "beta", memberCount: 2, storage: { planId: await basicPlanId(b.db), planName: "Basic", usedBytes: 321, quotaBytes: 2147483648, contentBytes: 0 } });
    expect(typeof row.storage.usedBytes).toBe("number");
    expect(typeof row.storage.contentBytes).toBe("number");
  });

  it("PATCH /api/admin/groups/:id/storage-plan: 200 AdminGroupDto; group missing/non-UUID -> 404 group_not_found; plan missing/non-UUID -> 404 storage_plan_not_found; uppercase UUID works", async () => {
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

describe("usage view", () => {
  it("GET /api/storage: returns only your own; unauthenticated 401", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const pid = await seedPlan(b.db, "Mine", 999);
    await setUserPlan(b.db, u.id, pid);
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, u.id, 12);
    const r = await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) });
    expect(r.json()).toEqual({ usedBytes: 12, quotaBytes: 999, planName: "Mine", byKind: { ...ZERO, image: 12 }, content: { noteBytes: 0, historyBytes: 0 } });
    expect((await b.app.inject({ method: "GET", url: "/api/storage" })).statusCode).toBe(401);
  });

  it("GET /api/groups/:id/storage (#247 relaxed): any member 200 (including a custom role with all six flags off); non-member/non-UUID/missing 404 byte-for-byte identical; non-member site admin 200; never 403", async () => {
    const b = await adminApp();
    const [gAdmin, gMember, plain, outsider] = await Promise.all([seedUser(b.db), seedUser(b.db), seedUser(b.db), seedUser(b.db)]);
    const g = await seedGroup(b.db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }, { userId: plain.id, role: "member" }]);
    const bare = await seedRole(b.db, g.id, "Bare", { canRead: true });
    await setMemberRole(b.db, g.id, plain.id, bare);
    const pid = await seedPlan(b.db, "GP", null);
    await setGroupPlan(b.db, g.id, pid);
    const get = async (userId: string, id = g.id) => b.app.inject({ method: "GET", url: `/api/groups/${id}/storage`, cookies: await cookieOf(userId) });
    const expected = { usedBytes: 0, quotaBytes: null, planName: "GP", byKind: ZERO, byMember: [], content: { noteBytes: 0, historyBytes: 0 } };
    expect((await get(gMember.id)).json()).toEqual(expected);
    expect((await get(plain.id)).json()).toEqual(expected);
    expect((await get(gAdmin.id)).json()).toEqual(expected);
    expect((await get(b.admin.id)).statusCode).toBe(200);
    const bodies = [await get(outsider.id), await get(gAdmin.id, "nope"), await get(gAdmin.id, "00000000-0000-4000-8000-000000000000")];
    for (const r of bodies) expect(r.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual({ error: { code: "not_found", message: "No group with that id." } });
  });

  it("GET /api/groups/:id/storage: group authorization matrix (anon 401 / nonMember 404 / member 200 / admin 200 / siteAdmin 200 / badId 404 / missing 404)", async () => {
    const b = await adminApp();
    await runGroupAuthMatrix(b.app, b.db, {
      method: "GET",
      url: id => `/api/groups/${id}/storage`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });
});

describe("#247: byKind and byMember", () => {
  it("GET /api/storage: each classification rule lands on the right kind, unknown mime -> other, attachments in others' notes are not counted; byKind sums to usedBytes", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const other = await seedUser(b.db);
    const n = await seedNote(b.db, { ownerId: u.id });
    const theirs = await seedNote(b.db, { ownerId: other.id });
    const rows: Array<[string, number]> = [
      ["image/png", 10], ["image/webp", 5], ["audio/mpeg", 20], ["video/mp4", 30],
      ["application/pdf", 40], ["text/plain", 1], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", 2],
      ["application/msword", 4], ["application/vnd.ms-excel", 8], ["application/vnd.ms-powerpoint", 16], ["application/rtf", 32],
      ["application/zip", 100],
    ];
    for (const [mime, size] of rows) await seedUploadRow(b.db, n.id, u.id, mime, size);
    await seedUploadRow(b.db, theirs.id, other.id, "image/png", 1000);
    const body = (await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) })).json();
    expect(body.byKind).toEqual({ image: 15, audio: 20, video: 30, document: 103, other: 100 });
    expect(body.usedBytes).toBe(268);
    const sum = Object.values(body.byKind as StorageByKind).reduce((a, x) => a + x, 0);
    expect(sum).toBe(body.usedBytes);
  });

  it("GET /api/storage: no uploads -> the five byKind keys are always present and all 0", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    expect((await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) })).json().byKind).toEqual(ZERO);
  });

  it("GET /api/groups/:id/storage: byMember groups by charged member (seed charged = uploader; includes non-members), a null charged member becomes one row, 0 bytes not listed, bytes descending; byKind counts only group notes", async () => {
    const b = await adminApp();
    const alice = await seedUser(b.db, { displayName: "Alice" });
    const bob = await seedUser(b.db, { displayName: "Bob" });
    const zero = await seedUser(b.db, { displayName: "Zero" });
    const leaver = await seedUser(b.db, { displayName: "Leaver" });
    const g = await seedGroup(b.db, "G", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }, { userId: zero.id, role: "member" }]);
    const gn = await seedNote(b.db, { groupId: g.id });
    const personal = await seedNote(b.db, { ownerId: alice.id });
    await seedUploadRow(b.db, gn.id, alice.id, "image/png", 100);
    await seedUploadRow(b.db, gn.id, alice.id, "application/pdf", 50);
    await seedUploadRow(b.db, gn.id, bob.id, "image/jpeg", 300);
    await seedUploadRow(b.db, gn.id, zero.id, "image/png", 0);
    await seedUploadRow(b.db, gn.id, leaver.id, "video/mp4", 60); // leaver is not (or no longer) a member: still listed
    await seedUploadRow(b.db, gn.id, null, "audio/ogg", 30);
    await seedUploadRow(b.db, gn.id, null, "application/zip", 40);
    await seedUploadRow(b.db, personal.id, alice.id, "image/png", 9999); // personal note: not counted into the group
    const body = (await b.app.inject({ method: "GET", url: `/api/groups/${g.id}/storage`, cookies: await cookieOf(bob.id) })).json();
    expect(body.byMember).toEqual([
      { userId: bob.id, handle: bob.handle, displayName: "Bob", bytes: 300 },
      { userId: alice.id, handle: alice.handle, displayName: "Alice", bytes: 150 },
      { userId: null, handle: null, displayName: null, bytes: 70 },
      { userId: leaver.id, handle: leaver.handle, displayName: "Leaver", bytes: 60 },
    ]);
    expect(body.byKind).toEqual({ image: 400, audio: 30, video: 60, document: 50, other: 40 });
    expect(body.usedBytes).toBe(580);
  });

  it("byMember ordering: same bytes by userId ascending, the null row last among the same bytes", async () => {
    const b = await adminApp();
    const [x, y] = await Promise.all([seedUser(b.db), seedUser(b.db)]);
    const g = await seedGroup(b.db, "G", [{ userId: x.id, role: "admin" }, { userId: y.id, role: "member" }]);
    const gn = await seedNote(b.db, { groupId: g.id });
    for (const who of [x.id, y.id, null]) await seedUploadRow(b.db, gn.id, who, "image/png", 7);
    const body = (await b.app.inject({ method: "GET", url: `/api/groups/${g.id}/storage`, cookies: await cookieOf(x.id) })).json();
    expect(body.byMember.map((r: { userId: string | null }) => r.userId)).toEqual([[x.id, y.id].sort()[0], [x.id, y.id].sort()[1], null]);
  });

  it("byMember groups by the charged member (charged_to_id): userId/handle/displayName are the charged member's; charged NULL with the uploader still present -> anonymous row, not falling back to the uploader", async () => {
    const b = await adminApp();
    const occ = await seedUser(b.db, { displayName: "Occupant" });
    const up = await seedUser(b.db, { displayName: "Uploader" });
    const g = await seedGroup(b.db, "G", [{ userId: occ.id, role: "admin" }]);
    const gn = await seedNote(b.db, { groupId: g.id });
    await seedUploadRow(b.db, gn.id, up.id, "image/png", 100, occ.id); // uploader up, charged occ
    await seedUploadRow(b.db, gn.id, occ.id, "image/png", 5, up.id); // reverse: uploader occ, charged up
    await seedUploadRow(b.db, gn.id, up.id, "image/png", 5, null); // charged deleted (NULL), uploader still present
    const body = (await b.app.inject({ method: "GET", url: `/api/groups/${g.id}/storage`, cookies: await cookieOf(occ.id) })).json();
    expect(body.byMember).toEqual([
      { userId: occ.id, handle: occ.handle, displayName: "Occupant", bytes: 100 },
      { userId: up.id, handle: up.handle, displayName: "Uploader", bytes: 5 },
      { userId: null, handle: null, displayName: null, bytes: 5 },
    ]);
  });
});

describe("a single upload row above 2^31 bytes", () => {
  it("is reported exactly by the usage readers and counted as over quota", async () => {
    const b = await adminApp();
    const u = await seedUser(b.db);
    const plan = await giveUserQuota(b.db, u.id, 2_000_000_000);
    const n = await seedNote(b.db, { ownerId: u.id });
    await seedUploadRow(b.db, n.id, u.id, "video/mp4", 3_000_000_000);
    expect(await readSpaceUsage(b.db, { kind: "user", id: u.id })).toMatchObject({ usedBytes: 3_000_000_000, quotaBytes: 2_000_000_000 });
    expect(await readSpaceUsageByKind(b.db, { kind: "user", id: u.id })).toEqual({ ...ZERO, video: 3_000_000_000 });
    const list = (await req(b, "GET", "/api/admin/storage-plans")).json();
    expect(list.plans.find((x: { id: string }) => x.id === plan).overQuotaCount).toBe(1);
  });
});
