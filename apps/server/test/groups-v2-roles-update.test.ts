/**
 * #175 PR3 Task 3：`PATCH`／`DELETE /api/groups/:id/roles/:roleId`（spec §6 T12／T13、§6.7、§7；閱讀恆真＝spec 疑點 10；
 * 旗標不蘊含＝spec 疑點 11；內建管理員不可改、內建一般成員只准改旗標＝Q10；刪自訂角色持有者改掛內建一般成員＝Q8）。
 * 自訂角色一律以 `POST …/roles` 建，或 `seedRole(…, { canRead: true, … })` 明寫可讀（plan 複驗第 14 條）。
 * 回讀一律走 `GET …/roles`／`GET …/members`；踢線看 spy 的 `onGroupAccessChanged`。
 */
import { describe, expect, it } from "vitest";
import type { GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, setMemberRole, spyCollabHooks, type SeededUser,
} from "./group-helpers.js";

const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
const ALL: GroupRoleFlags = { create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true };
const ADMIN_PERMISSIONS = { read: true, ...ALL };
/** 內建一般成員的預設六旗標（`seedGroup`／0012：新建＋編輯）。 */
const MEMBER_FLAGS: GroupRoleFlags = { ...NONE, create: true, edit: true };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** 管理員 A、成員 B、C（內建一般成員）、兩篇群組筆記＋一篇 A 的個人筆記（不在踢線名單裡）。 */
async function setup() {
  const spy = spyCollabHooks();
  const { app, db } = await buildTestApp({ collabHooks: spy });
  const a = await seedUser(db);
  const b = await seedUser(db);
  const c = await seedUser(db);
  const g = await seedGroup(db, "Roles", [
    { userId: a.id, role: "admin" },
    { userId: b.id, role: "member" },
    { userId: c.id, role: "member" },
  ]);
  const n1 = await seedNote(db, { groupId: g.id });
  const n2 = await seedNote(db, { groupId: g.id });
  await seedNote(db, { ownerId: a.id });
  const groupNotes = sorted([n1.id, n2.id]);
  const adminCookies = await cookieOf(a.id);
  const createRole = async (name: string, permissions: GroupRoleFlags): Promise<GroupRoleDto> => {
    const res = await app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies: adminCookies, payload: { name, permissions } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as GroupRoleDto;
  };
  const patch = async (roleId: string, payload: unknown, cookies = adminCookies) =>
    app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${roleId}`, cookies, payload: payload as Record<string, unknown> });
  const del = async (roleId: string, cookies = adminCookies) =>
    app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${roleId}`, cookies });
  const roles = async (): Promise<GroupRoleDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupRoleDto[];
  };
  const members = async (): Promise<GroupMemberDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupMemberDto[];
  };
  const memberOf = async (u: SeededUser): Promise<GroupMemberDto | undefined> => (await members()).find(m => m.userId === u.id);
  /** 第 `nth` 次（1 起算）`onGroupAccessChanged` 呼叫的（筆記, 使用者），兩邊都排序。 */
  const kickCall = (nth: number): { noteIds: string[]; userIds: string[] } => {
    const call = spy.onGroupAccessChanged.mock.calls[nth - 1];
    expect(call, `第 ${nth} 次 onGroupAccessChanged`).toBeDefined();
    return { noteIds: sorted(call![0]), userIds: sorted(call![1]) };
  };
  return { app, db, spy, a, b, c, g, groupNotes, adminCookies, createRole, patch, del, roles, members, memberOf, kickCall };
}

describe("#175 PR3 PATCH／DELETE …/roles/:roleId：授權", () => {
  it("PATCH 授權矩陣：401／404×3（逐位元組相同）／403／200／站台 admin 200", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: (g, s) => `/api/groups/${g}/roles/${s.customRoleId}`,
      payload: () => ({ name: "Renamed" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("DELETE 授權矩陣：401／404×3（逐位元組相同）／403／204／站台 admin 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: (g, s) => `/api/groups/${g}/roles/${s.customRoleId}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("授權看的是呼叫者的 manageGroup（不是 manageMembers）：只有 manageMembers → PATCH／DELETE 皆 403 且沒寫入；只有 manageGroup → 200／204；403 先於 :roleId 檢查與 body 檢查", async () => {
    const { db, g, b, patch, del, roles, createRole } = await setup();
    const target = await createRole("Target", NONE);
    const doorman = await seedRole(db, g.id, "Doorman", { canRead: true, canManageMembers: true });
    const renamer = await seedRole(db, g.id, "Renamer", { canRead: true, canManageGroup: true });
    const cookies = await cookieOf(b.id);
    await setMemberRole(db, g.id, b.id, doorman);
    for (const res of [
      await patch(target.id, { name: "ByDoorman" }, cookies),
      await del(target.id, cookies),
      await patch("not-a-uuid", {}, cookies),
      await del("not-a-uuid", cookies),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer", "Target"]);
    await setMemberRole(db, g.id, b.id, renamer);
    const renamed = await patch(target.id, { name: "ByRenamer" }, cookies);
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe("ByRenamer");
    expect((await del(target.id, cookies)).statusCode).toBe(204);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer"]);
  });

  it("§5.5：身為內建一般成員的站台 admin → PATCH 200、DELETE 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "SA", [{ userId: owner.id, role: "admin" }, { userId: siteAdmin.id, role: "member" }]);
    const roleId = await seedRole(db, g.id, "Custom", { canRead: true });
    const cookies = await cookieOf(siteAdmin.id);
    const patched = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${roleId}`, cookies, payload: { name: "ByAdmin" } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ id: roleId, builtin: null, name: "ByAdmin" });
    const deleted = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${roleId}`, cookies });
    expect(deleted.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies });
    expect((list.json() as GroupRoleDto[]).map(r => r.builtin)).toEqual(["admin", "member"]);
  });
});

describe("#175 PR3 PATCH …/roles/:roleId（T12）", () => {
  it("改自訂角色：改名＋改旗標一起 → 200、body 為新值；改成 create-only → 200；GET 回讀一致；memberCount＝實際掛的人數", async () => {
    const { db, g, b, c, patch, roles, createRole } = await setup();
    const role = await createRole("Editors", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, role.id);
    await setMemberRole(db, g.id, c.id, role.id);
    const res = await patch(role.id, { name: "  Curators ", permissions: { ...NONE, edit: true, delete: true, managePublicLink: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      id: role.id,
      builtin: null,
      name: "Curators",
      permissions: { read: true, create: false, edit: true, delete: true, managePublicLink: true, manageMembers: false, manageGroup: false },
      memberCount: 2,
    });
    expect((await roles()).find(r => r.id === role.id)).toEqual(res.json());

    const createOnly = await patch(role.id, { permissions: { ...NONE, create: true } });
    expect(createOnly.statusCode, createOnly.body).toBe(200);
    const CREATE_ONLY = { read: true, ...NONE, create: true };
    expect(createOnly.json()).toEqual({ id: role.id, builtin: null, name: "Curators", permissions: CREATE_ONLY, memberCount: 2 });
    expect((await roles()).find(r => r.id === role.id)).toEqual(createOnly.json());
  });

  it("RF1 自撞：Reader 改名 READER → 200（只撞自己）；Writer 改名 reader → 409 role_name_taken 且名稱不變；改名 管理員 → 409", async () => {
    const { patch, roles, createRole } = await setup();
    const reader = await createRole("Reader", NONE);
    const writer = await createRole("Writer", { ...NONE, edit: true });
    const self = await patch(reader.id, { name: "READER" });
    expect(self.statusCode, self.body).toBe(200);
    expect(self.json().name).toBe("READER");
    const TAKEN = { error: { code: "role_name_taken", message: "這個群組已有同名的角色，或該名稱保留給內建角色" } };
    const clash = await patch(writer.id, { name: "reader" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual(TAKEN);
    const reserved = await patch(writer.id, { name: "管理員" });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json()).toEqual(TAKEN);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "READER", "Writer"]);
  });

  it("內建管理員：PATCH 旗標（全開）或名稱 → 皆 409 builtin_role；回讀不變", async () => {
    const { g, patch, roles } = await setup();
    const before = (await roles()).find(r => r.id === g.adminRoleId);
    expect(before).toMatchObject({ builtin: "admin", name: null, permissions: ADMIN_PERMISSIONS });
    for (const payload of [{ permissions: ALL }, { name: "Boss" }, { permissions: NONE }]) {
      const res = await patch(g.adminRoleId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
      expect(res.json()).toEqual({ error: { code: "builtin_role", message: "內建管理員角色不能修改" } });
    }
    expect((await roles()).find(r => r.id === g.adminRoleId)).toEqual(before);
  });

  it("內建一般成員（Q10）：改旗標（拿掉新建）→ 200；改名 → 409 builtin_role；回讀名稱仍 null", async () => {
    const { g, patch, roles } = await setup();
    const res = await patch(g.memberRoleId, { permissions: { ...NONE, edit: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: g.memberRoleId, builtin: "member", name: null, permissions: { read: true, ...NONE, edit: true }, memberCount: 2 });
    for (const payload of [{ name: "Staff" }, { name: "Staff", permissions: MEMBER_FLAGS }]) {
      const renamed = await patch(g.memberRoleId, payload);
      expect(renamed.statusCode, JSON.stringify(payload)).toBe(409);
      expect(renamed.json()).toEqual({ error: { code: "builtin_role", message: "內建一般成員角色不能改名" } });
    }
    expect((await roles()).find(r => r.id === g.memberRoleId)).toEqual(res.json());
  });

  it("錯誤形：:roleId 非 UUID／別群組的角色 → 404 role_not_found；{}、帶 read、多鍵、缺旗標 → 400 invalid_body；name 空 → 400 invalid_name；都沒寫入", async () => {
    const { app, db, a, patch, roles, createRole } = await setup();
    const role = await createRole("Keep", NONE);
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    for (const roleId of ["not-a-uuid", otherRole, other.memberRoleId]) {
      const res = await patch(roleId, { name: "X" });
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "找不到此角色" } });
    }
    // 順序：非 UUID 的 404 先於 body 的 400
    const badBoth = await patch("not-a-uuid", {});
    expect(badBoth.statusCode).toBe(404);
    expect(badBoth.json().error.code).toBe("role_not_found");
    const { manageGroup: _omit, ...missingOne } = NONE;
    for (const payload of [{},{ permissions: { ...NONE, read: true } }, { name: "X", builtin: null }, { permissions: missingOne }, { name: 5 }]) {
      const res = await patch(role.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    const empty = await patch(role.id, { name: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: { code: "invalid_name", message: "角色名稱須為 1–40 個字元" } });
    expect((await roles()).find(r => r.id === role.id)).toEqual(role);
    const elsewhere = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((elsewhere.json() as GroupRoleDto[]).find(r => r.id === otherRole)?.name).toBe("Elsewhere");
  });

  it("錯誤順序：保留名檢查先於查角色——內建一般成員改名 Admin、內建管理員改名 Member、別群組的角色／不存在的 UUID 帶保留名 → 皆 409 role_name_taken；都沒寫入", async () => {
    const { app, db, a, g, patch, roles } = await setup();
    const before = await roles();
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    const TAKEN = { error: { code: "role_name_taken", message: "這個群組已有同名的角色，或該名稱保留給內建角色" } };
    for (const [roleId, name] of [
      [g.memberRoleId, "Admin"],
      [g.adminRoleId, "Member"],
      [otherRole, "admin"],
      ["00000000-0000-4000-8000-000000000000", "一般成員"],
    ] as const) {
      const res = await patch(roleId, { name });
      expect(res.statusCode, `${roleId} ${name}`).toBe(409);
      expect(res.json()).toEqual(TAKEN);
    }
    expect(await roles()).toEqual(before);
    const elsewhere = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((elsewhere.json() as GroupRoleDto[]).find(r => r.id === otherRole)?.name).toBe("Elsewhere");
  });

  it("踢線（§7、§12.1）：只改 delete／managePublicLink／manageMembers／manageGroup、只改名、送同值 → 0 次；edit 關／開 → 各恰 1 次（群組兩篇, [B, C]）；沒有人掛的角色改 edit → 0 次", async () => {
    const { db, g, b, c, spy, groupNotes, patch, createRole, kickCall } = await setup();
    const writers = await createRole("Writers", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, writers.id);
    await setMemberRole(db, g.id, c.id, writers.id);
    for (const flag of ["delete", "managePublicLink", "manageMembers", "manageGroup"] as const) {
      const res = await patch(writers.id, { permissions: { ...NONE, edit: true, [flag]: true } });
      expect(res.statusCode, flag).toBe(200);
      expect(res.json().permissions[flag]).toBe(true);
    }
    expect((await patch(writers.id, { name: "Scribes" })).statusCode).toBe(200);
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(0);

    const off = await patch(writers.id, { permissions: NONE });
    expect(off.statusCode).toBe(200);
    expect(off.json().permissions).toEqual({ read: true, ...NONE });
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(kickCall(1)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });
    expect((await patch(writers.id, { permissions: { ...NONE, edit: true } })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expect(kickCall(2)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });

    const unheld = await createRole("Nobody", { ...NONE, edit: true });
    expect((await patch(unheld.id, { permissions: NONE })).statusCode).toBe(200);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(2);
  });

  it("RF3：把內建一般成員的編輯與新建關掉 → 200、read 仍 true、踢線（群組兩篇, [B, C]）恰 1 次，內建管理員 A 不在名單", async () => {
    const { g, a, b, c, spy, groupNotes, patch, roles, kickCall } = await setup();
    const res = await patch(g.memberRoleId, { permissions: NONE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().permissions).toEqual({ read: true, ...NONE });
    expect((await roles()).find(r => r.id === g.memberRoleId)?.permissions.read).toBe(true);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const kick = kickCall(1);
    expect(kick).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });
    expect(kick.userIds).not.toContain(a.id);
  });
});

describe("#175 PR3 DELETE …/roles/:roleId（T13）", () => {
  it("刪自訂角色（Q8）：持有者 B、C 改掛內建一般成員、角色消失、踢線（群組兩篇, [B, C]）恰 1 次；刪沒人掛的 → 204、不踢；同名可再建", async () => {
    const { db, g, b, c, spy, groupNotes, del, roles, memberOf, createRole, kickCall, app, adminCookies } = await setup();
    const readers = await createRole("Readers", NONE);
    await setMemberRole(db, g.id, b.id, readers.id);
    await setMemberRole(db, g.id, c.id, readers.id);
    expect((await memberOf(b))?.roleId).toBe(readers.id);
    const res = await del(readers.id);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    for (const u of [b, c]) expect(await memberOf(u)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect((await roles()).map(r => r.id)).not.toContain(readers.id);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(kickCall(1)).toEqual({ noteIds: groupNotes, userIds: sorted([b.id, c.id]) });

    const lonely = await createRole("Lonely", { ...NONE, edit: true });
    expect((await del(lonely.id)).statusCode).toBe(204);
    expect((await roles()).map(r => r.id)).not.toContain(lonely.id);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);

    const again = await app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies: adminCookies, payload: { name: "Readers", permissions: NONE } });
    expect(again.statusCode, again.body).toBe(201);
  });

  it("刪內建（管理員／一般成員）→ 409 builtin_role；角色四列不變", async () => {
    const { g, del, roles, createRole } = await setup();
    await createRole("One", NONE);
    await createRole("Two", NONE);
    const before = await roles();
    expect(before).toHaveLength(4);
    for (const roleId of [g.adminRoleId, g.memberRoleId]) {
      const res = await del(roleId);
      expect(res.statusCode, roleId).toBe(409);
      expect(res.json()).toEqual({ error: { code: "builtin_role", message: "內建角色不能刪除" } });
    }
    expect(await roles()).toEqual(before);
  });

  it("錯誤形：:roleId 非 UUID／別群組的角色 → 404 role_not_found，別群組的角色沒被刪", async () => {
    const { app, db, a, del } = await setup();
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const otherRole = await seedRole(db, other.id, "Elsewhere", { canRead: true });
    for (const roleId of ["not-a-uuid", otherRole]) {
      const res = await del(roleId);
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "找不到此角色" } });
    }
    const list = await app.inject({ method: "GET", url: `/api/groups/${other.id}/roles`, cookies: await cookieOf(a.id) });
    expect((list.json() as GroupRoleDto[]).map(r => r.id)).toContain(otherRole);
  });

  it("S1 不受影響：刪掉自訂角色、改掉內建一般成員旗標之後，唯一的內建管理員 A 仍是內建管理員", async () => {
    const { db, g, a, b, del, patch, memberOf, createRole } = await setup();
    const custom = await createRole("Temp", { ...NONE, edit: true });
    await setMemberRole(db, g.id, b.id, custom.id);
    expect((await del(custom.id)).statusCode).toBe(204);
    expect((await patch(g.memberRoleId, { permissions: NONE })).statusCode).toBe(200);
    expect(await memberOf(a)).toMatchObject({ roleId: g.adminRoleId, builtin: "admin" });
    expect(await memberOf(b)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
  });
});
