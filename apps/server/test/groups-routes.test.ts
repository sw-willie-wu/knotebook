import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { GroupDto, GroupMemberDto, GroupRoleDto } from "@knotebook/shared";
import { groupMembers, groupRoles, groups } from "../src/db/schema.js";
import { groupNoteIdsQuery, listMyGroupsQuery } from "../src/groups/queries.js";
import { buildTestApp } from "./helpers.js";
import {
  PLANNER_GROUP_OF_USER1, cookieOf, planOf, runGroupAuthMatrix, seedGroup, seedPlannerData, seedRole, seedUser, setMemberRole,
  spyCollabHooks,
} from "./group-helpers.js";

const NUL = String.fromCharCode(0);

const ADMIN_PERMISSIONS = {
  read: true, create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true,
} as const;
const MEMBER_PERMISSIONS = {
  read: true, create: true, edit: true, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false,
} as const;

describe("#103／#175 POST／GET /api/groups", () => {
  it("POST：201 GroupDto（myRole＝內建管理員物件、兩個 canManage* 為真、名稱 trim）；同交易建兩個內建角色、建立者掛 admin（S2）；created_by=我；未登入 401", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const res = await app.inject({ method: "POST", url: "/api/groups", cookies: await cookieOf(me.id), payload: { name: "  Design  " } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as GroupDto;
    expect(Object.keys(body).sort()).toEqual(["canManageGroup", "canManageMembers", "createdAt", "id", "myRole", "name"]);
    expect(body).toMatchObject({ name: "Design", canManageMembers: true, canManageGroup: true });
    expect(body.myRole).toEqual({ id: expect.any(String), builtin: "admin", name: null, memberCount: 1, permissions: ADMIN_PERMISSIONS });

    const roles = await db
      .select({
        id: groupRoles.id, builtin: groupRoles.builtin, name: groupRoles.name,
        canRead: groupRoles.canRead, canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit, canDelete: groupRoles.canDelete,
        canManagePublicLink: groupRoles.canManagePublicLink, canManageMembers: groupRoles.canManageMembers, canManageGroup: groupRoles.canManageGroup,
      })
      .from(groupRoles)
      .where(eq(groupRoles.groupId, body.id))
      .orderBy(asc(groupRoles.builtin));
    expect(roles.map(({ id: _id, ...rest }) => rest)).toEqual([
      { builtin: "admin", name: null, canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true },
      { builtin: "member", name: null, canRead: true, canCreate: true, canEdit: true, canDelete: false, canManagePublicLink: false, canManageMembers: false, canManageGroup: false },
    ]);
    const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, body.id));
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: me.id, roleId: roles[0]!.id });
    expect(body.myRole!.id).toBe(roles[0]!.id);
    const [g] = await db.select().from(groups).where(eq(groups.id, body.id));
    expect(g!.createdBy).toBe(me.id);
    expect((await app.inject({ method: "POST", url: "/api/groups", payload: { name: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/groups" })).statusCode).toBe(401);
  });

  it("RF1：名稱邊界——NUL／落單代理／全空白／81 字元 → 400 invalid_name（不是 500）；80 個 emoji 接受；型別錯／多欄 → 400 invalid_body", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const cookies = await cookieOf(me.id);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/groups", cookies, payload: payload as Record<string, unknown> });
    for (const name of [`a${NUL}b`, "\uD800", "   ", "", "x".repeat(81), "\u{1F600}".repeat(81)]) {
      const res = await post({ name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json().error.code).toBe("invalid_name");
    }
    const emoji = await post({ name: "\u{1F600}".repeat(80) });
    expect(emoji.statusCode).toBe(201);
    expect(emoji.json().name).toBe("\u{1F600}".repeat(80));
    for (const payload of [{}, { name: 5 }, { name: "ok", extra: 1 }]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
  });

  it("GET /api/groups：只列我所屬的、依 name 再依 id；myRole 物件形（memberCount＝掛該角色的人數）；站台 admin 的 canManage* 恆真、也看不到非所屬群組", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db, { isAdmin: true });
    const other = await seedUser(db);
    const plain = await seedUser(db);
    const same1 = await seedGroup(db, "Same", [{ userId: me.id, role: "member" }, { userId: other.id, role: "admin" }, { userId: plain.id, role: "member" }]);
    const same2 = await seedGroup(db, "Same", [{ userId: me.id, role: "admin" }]);
    const alpha = await seedGroup(db, "Alpha", [{ userId: me.id, role: "admin" }]);
    await seedGroup(db, "Aardvark", [{ userId: other.id, role: "admin" }]);

    const res = await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(me.id) });
    expect(res.statusCode).toBe(200);
    const list = res.json() as GroupDto[];
    const sameIds = [same1.id, same2.id].sort();
    expect(list.map(g => g.id)).toEqual([alpha.id, ...sameIds]);
    const s1 = list.find(g => g.id === same1.id)!;
    expect(s1.myRole).toEqual({ id: same1.memberRoleId, builtin: "member", name: null, memberCount: 2, permissions: MEMBER_PERMISSIONS });
    // 站台 admin（§5.5）：角色是一般成員，兩個 canManage* 仍為真。
    expect(s1).toMatchObject({ canManageMembers: true, canManageGroup: true });
    expect(list.find(g => g.id === same2.id)!.myRole).toMatchObject({ id: same2.adminRoleId, builtin: "admin", memberCount: 1 });

    // 一般使用者：一般成員角色 → 兩個 canManage* 為假。
    const plainList = (await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(plain.id) })).json() as GroupDto[];
    expect(plainList).toHaveLength(1);
    expect(plainList[0]).toMatchObject({ id: same1.id, canManageMembers: false, canManageGroup: false });
    expect(plainList[0]!.myRole!.permissions.manageGroup).toBe(false);
  });
});

describe("#103／#175 PATCH /api/groups/:id 與 GET …/members", () => {
  it("PATCH 改名的授權矩陣（含站台 admin、非 UUID、不存在；三種 404 逐位元組相同）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: id => `/api/groups/${id}`,
      payload: () => ({ name: "Renamed" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("PATCH：trim 後寫入、回 GroupDto；一般成員即使 body 壞也先拿 403（新訊息）；admin 送壞名稱 → 400 invalid_name、送 {} → 400 invalid_body；非成員站台 admin 的回應 myRole=null、兩個 canManage* 為真", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "Old", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const ok = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " New " } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: g.id, name: "New", canManageMembers: true, canManageGroup: true, myRole: { id: g.adminRoleId, builtin: "admin" } });
    const forbidden = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(member.id), payload: {} });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: { code: "forbidden", message: "你在這個群組的角色不能進行此操作" } });
    const bad = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_name");
    const emptyBody = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: {} });
    expect(emptyBody.statusCode).toBe(400);
    expect(emptyBody.json().error.code).toBe("invalid_body");
    const bySite = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(site.id), payload: { name: "Site" } });
    expect(bySite.statusCode).toBe(200);
    expect(bySite.json()).toMatchObject({ name: "Site", myRole: null, canManageMembers: true, canManageGroup: true });
  });

  it("§5.5（gate r2 M-3）：身為一般成員的站台 admin 可改名與加人（角色旗標 OR 站台 admin，不只看是否成員）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const newcomer = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: site.id, role: "member" }]);
    const cookies = await cookieOf(site.id);
    const rename = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies, payload: { name: "BySite" } });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: "BySite", myRole: { builtin: "member" }, canManageMembers: true, canManageGroup: true });
    const add = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: newcomer.email } });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ userId: newcomer.id, builtin: "member", roleId: g.memberRoleId });
  });

  it("GET …/members 的授權矩陣（成員即可讀）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "GET",
      url: id => `/api/groups/${id}/members`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("GET …/members：內建管理員在前、再依 displayName、再依 userId；每列 { userId, email, displayName, roleId, builtin }（A8）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const zed = await seedUser(db, { displayName: "Zed" });
    const amy1 = await seedUser(db, { displayName: "Amy" });
    const amy2 = await seedUser(db, { displayName: "Amy" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "G", [
      { userId: bob.id, role: "member" },
      { userId: zed.id, role: "admin" },
      { userId: amy2.id, role: "member" },
      { userId: amy1.id, role: "member" },
    ]);
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(bob.id) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as GroupMemberDto[];
    const amys = [amy1.id, amy2.id].sort();
    expect(rows.map(r => r.userId)).toEqual([zed.id, ...amys, bob.id]);
    expect(rows[0]).toEqual({ userId: zed.id, email: zed.email, displayName: "Zed", roleId: g.adminRoleId, builtin: "admin" });
    expect(rows[1]).toEqual({ userId: amys[0], email: expect.any(String), displayName: "Amy", roleId: g.memberRoleId, builtin: "member" });
    expect(Object.keys(rows[3]!).sort()).toEqual(["builtin", "displayName", "email", "roleId", "userId"]);
  });

  it("【驗】§4.1：GET /api/groups 走 group_members_user_idx；「群組內所有筆記」走 notes_group_slug_idx", async () => {
    const { db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const { userId } = await seedPlannerData(db.$client);
    expect(await planOf(db.$client, listMyGroupsQuery(db, userId).toSQL())).toContain("group_members_user_idx");
    expect(await planOf(db.$client, groupNoteIdsQuery(db, PLANNER_GROUP_OF_USER1).toSQL())).toContain("notes_group_slug_idx");
  });
});

describe("#175 GET /api/groups/:id/roles（PR1 唯讀；規格落差 13）", () => {
  it("授權矩陣：成員即可讀、非成員站台 admin 也可讀；非成員／非 UUID／不存在 404 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "GET",
      url: id => `/api/groups/${id}/roles`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("排序：內建管理員、內建一般成員、其餘依名稱（不分大小寫）；memberCount 正確；GroupRoleDto 形", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const m1 = await seedUser(db);
    const m2 = await seedUser(db);
    const reader = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "G", [
      { userId: admin.id, role: "admin" }, { userId: m1.id, role: "member" }, { userId: m2.id, role: "member" }, { userId: reader.id, role: "member" },
    ]);
    const beta = await seedRole(db, g.id, "beta", { canRead: true });
    const alpha = await seedRole(db, g.id, "Alpha", { canRead: true, canManageMembers: true });
    await setMemberRole(db, g.id, reader.id, beta);

    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(m1.id) });
    expect(res.statusCode).toBe(200);
    const roles = res.json() as GroupRoleDto[];
    expect(roles.map(r => r.id)).toEqual([g.adminRoleId, g.memberRoleId, alpha, beta]);
    expect(roles.map(r => [r.builtin, r.name, r.memberCount])).toEqual([["admin", null, 1], ["member", null, 2], [null, "Alpha", 0], [null, "beta", 1]]);
    expect(roles[0]).toEqual({ id: g.adminRoleId, builtin: "admin", name: null, memberCount: 1, permissions: ADMIN_PERMISSIONS });
    expect(roles[2]!.permissions).toEqual({
      read: true, create: false, edit: false, delete: false, managePublicLink: false, manageMembers: true, manageGroup: false,
    });

    const bySite = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(site.id) });
    expect(bySite.statusCode).toBe(200);
    expect(bySite.json()).toEqual(roles);
  });
});
