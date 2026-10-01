import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { groupMembers, groupRoles } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import {
  MATRIX_ACTORS, cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, setMemberRole, spyCollabHooks,
  waitForBlockedOrSettled, type MatrixActor,
} from "./group-helpers.js";

/** 成員目前角色的 `builtin`（自訂角色為 null；不是成員為 undefined）。 */
async function roleOf(db: Db, groupId: string, userId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  return row?.builtin;
}

/** 內建管理員人數（S1 數的就是這個，§4.1——自訂角色勾滿七旗標也不算）。 */
async function adminCount(db: Db, groupId: string): Promise<number> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupRoles.builtin, "admin")));
  return rows.length;
}

describe("#103／#175 成員異動：授權矩陣", () => {
  it("PUT …/members", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PUT",
      url: id => `/api/groups/${id}/members`,
      payload: s => ({ email: s.newcomer.email }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("PATCH …/members/:userId", async () => {
    // `runGroupAuthMatrix` 的 payload 是同步函式、拿不到場景群組的角色 id（`{roleId}` 必須是那個群組的角色），
    // 這支在本檔自己跑同一張矩陣：每個 actor 一個全新的場景、三種 404 逐位元組相同（S4）。
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const expected: Record<MatrixActor, number> = { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 };
    const notFoundBodies: string[] = [];
    for (const actor of MATRIX_ACTORS) {
      const [admin, member, other, outsider] = [await seedUser(db), await seedUser(db), await seedUser(db), await seedUser(db)];
      const siteAdmin = await seedUser(db, { isAdmin: true });
      const g = await seedGroup(db, "Matrix", [
        { userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: other.id, role: "member" },
      ]);
      const groupId = actor === "badId" ? "not-a-uuid" : actor === "missing" ? randomUUID() : g.id;
      const who = actor === "anon" ? null : actor === "nonMember" ? outsider : actor === "member" ? member : actor === "siteAdmin" ? siteAdmin : admin;
      const res = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}/members/${other.id}`,
        ...(who ? { cookies: await cookieOf(who.id) } : {}),
        payload: { roleId: g.adminRoleId },
      });
      expect(res.statusCode, `PATCH as ${actor}：${res.body}`).toBe(expected[actor]);
      if (actor === "nonMember" || actor === "badId" || actor === "missing") notFoundBodies.push(res.body);
      if (res.statusCode === 200) expect(await roleOf(db, g.id, other.id)).toBe("admin");
    }
    expect(new Set(notFoundBodies).size).toBe(1);
    expect(JSON.parse(notFoundBodies[0]!)).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
  });

  it("DELETE …/members/:userId（刪別人）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: (id, s) => `/api/groups/${id}/members/${s.other.id}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it(":userId 非 UUID／不是成員 → 404，與群組 404 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    const bodies = [
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies, payload: { roleId: g.adminRoleId } })),
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies, payload: { roleId: g.adminRoleId } })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies })),
    ];
    for (const res of bodies) expect(res.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
  });
});

describe("#103／#175 PUT …/members", () => {
  it("email 不分大小寫、停用帳號照樣加、預設掛內建一般成員／可指定 roleId；找不到 email → 404 user_not_found；roleId 不合法／別群組的 → 404 role_not_found；舊鍵 role → 400", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const plain = await seedUser(db);
    const disabled = await seedUser(db, { disabled: true });
    const third = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const other = await seedGroup(db, "Other", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);

    const a = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: plain.email.toUpperCase() } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ userId: plain.id, email: plain.email, displayName: expect.any(String), roleId: g.memberRoleId, builtin: "member" });
    const b = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: disabled.email, roleId: g.adminRoleId } });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ userId: disabled.id, roleId: g.adminRoleId, builtin: "admin" });
    expect(await roleOf(db, g.id, disabled.id)).toBe("admin");
    const missing = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "nobody@example.com" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("user_not_found");

    for (const roleId of ["nope", other.memberRoleId]) {
      const res = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: third.email, roleId } });
      expect(res.statusCode, roleId).toBe(404);
      expect(res.json()).toEqual({ error: { code: "role_not_found", message: "找不到此角色" } });
    }
    expect(await roleOf(db, g.id, third.id)).toBeUndefined();
    const legacy = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: third.email, role: "admin" } });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error.code).toBe("invalid_body");
    expect(await roleOf(db, g.id, third.id)).toBeUndefined();
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled(); // §7：加人不踢線
  });

  it("只新增：已是成員 → 409 already_member，且既有管理員的角色不變", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const res = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id), payload: { email: admin.email, roleId: g.memberRoleId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("already_member");
    expect(await roleOf(db, g.id, admin.id)).toBe("admin");
  });

  it("管理員送壞 body → 400 invalid_body：PUT …/members 的非 email；PATCH …/members/:userId 的 roleId 型別錯、舊鍵 role；PATCH roleId 非 UUID／別群組的 → 404 role_not_found", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    const put = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "not-an-email" } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error.code).toBe("invalid_body");
    for (const payload of [{ roleId: 1 }, { role: "admin" }, {}]) {
      const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${member.id}`, cookies, payload });
      expect(patch.statusCode, JSON.stringify(payload)).toBe(400);
      expect(patch.json().error.code).toBe("invalid_body");
    }
    for (const roleId of ["owner", other.adminRoleId]) {
      const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${member.id}`, cookies, payload: { roleId } });
      expect(patch.statusCode, roleId).toBe(404);
      expect(patch.json().error.code).toBe("role_not_found");
    }
    expect(await roleOf(db, g.id, member.id)).toBe("member");
  });
});

describe("#103／#175 S1：每個群組至少一位內建管理員", () => {
  it("最後一位內建管理員退出／被站台 admin 移除／被降級 → 409 last_admin；兩位管理員時都可以", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const a1 = await seedUser(db);
    const a2 = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }]);
    const leave = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leave.statusCode).toBe(409);
    expect(leave.json().error.code).toBe("last_admin");
    const removedBySite = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(site.id) });
    expect(removedBySite.statusCode).toBe(409);
    expect(removedBySite.json().error.code).toBe("last_admin");
    const demote = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_admin");
    expect(await roleOf(db, g.id, a1.id)).toBe("admin");
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    await db.insert(groupMembers).values({ groupId: g.id, userId: a2.id, roleId: g.adminRoleId });
    const demoteOk = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    expect(demoteOk.statusCode).toBe(200);
    expect(demoteOk.json()).toMatchObject({ userId: a1.id, roleId: g.memberRoleId, builtin: "member" });
    const leaveOk = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leaveOk.statusCode).toBe(204);
  });

  it("S1 只數內建管理員：勾滿七旗標的自訂角色不算——唯一的內建管理員降級／退出仍 409", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const a1 = await seedUser(db);
    const full = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }, { userId: full.id, role: "member" }]);
    const all = await seedRole(db, g.id, "Everything", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await setMemberRole(db, g.id, full.id, all);
    const demote = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(full.id), payload: { roleId: g.memberRoleId } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_admin");
    const leave = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leave.statusCode).toBe(409);
    expect(await adminCount(db, g.id)).toBe(1);
  });

  it("Q9 不防升權：只勾 canManageMembers（不可讀）的自訂角色可把自己換成內建管理員；只勾 canManageGroup 的自訂角色可以建立（兩旗標獨立）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const x = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: x.id, role: "member" }]);
    const manager = await seedRole(db, g.id, "Doorman", { canRead: false, canManageMembers: true });
    const groupOnly = await seedRole(db, g.id, "Renamer", { canRead: false, canManageGroup: true });
    expect(groupOnly).toEqual(expect.any(String));
    await setMemberRole(db, g.id, x.id, manager);
    const self = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${x.id}`, cookies: await cookieOf(x.id), payload: { roleId: g.adminRoleId } });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ userId: x.id, roleId: g.adminRoleId, builtin: "admin" });
    expect(await roleOf(db, g.id, x.id)).toBe("admin");
    expect(await adminCount(db, g.id)).toBe(2);
  });

  it("踢線：一般成員自行退出、管理員移人 → 204，換角色（升降皆）→ 200，都以（群組所有筆記, [那一人]）呼叫 onGroupAccessChanged；換成同一個角色、加人不呼叫", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const leaver = await seedUser(db);
    const removed = await seedUser(db);
    const newcomer = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: leaver.id, role: "member" }, { userId: removed.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });
    await seedNote(db, { ownerId: admin.id }); // 群組外的筆記不在名單裡
    const groupNotes = [n1.id, n2.id].sort();
    const adminCookies = await cookieOf(admin.id);
    const expectLastCall = (userId: string): void => {
      const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls.at(-1)!;
      expect([...noteIds].sort()).toEqual(groupNotes);
      expect(userIds).toEqual([userId]);
    };

    expect((await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies: adminCookies, payload: { email: newcomer.email } })).statusCode).toBe(200);
    const same = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.memberRoleId } });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ userId: removed.id, roleId: g.memberRoleId, builtin: "member" });
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.adminRoleId } })).statusCode).toBe(200);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expectLastCall(removed.id);
    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies, payload: { roleId: g.memberRoleId } })).statusCode).toBe(200);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expectLastCall(removed.id);

    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${leaver.id}`, cookies: await cookieOf(leaver.id) })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(3);
    expectLastCall(leaver.id);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: adminCookies })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(4);
    expectLastCall(removed.id);
  });

  it("並發 C3（spec gate r2 E）：兩位管理員同時退出 → 恰一個 204、一個 409 last_admin；群組最後剩一位內建管理員", async () => {
    let groupId = "";
    let second: Promise<LightMyRequestResponse> | undefined;
    let secondCookies: Record<string, string> = {};
    let secondUrl = "";
    let interleave: "blocked" | "settled" | undefined;
    // hook 只在 `built` 賦值之後的請求裡被呼叫，閉包引用後宣告的 const 不會撞 TDZ。
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second) return;
      second = built.app.inject({ method: "DELETE", url: secondUrl, cookies: secondCookies });
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const app: FastifyInstance = built.app;
    const a1 = await seedUser(built.db);
    const a2 = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [{ userId: a1.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    groupId = g.id;
    secondUrl = `/api/groups/${g.id}/members/${a2.id}`;
    secondCookies = await cookieOf(a2.id);

    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    const other = await second!;
    expect([first.statusCode, other.statusCode].sort()).toEqual([204, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });
});

describe("#175 S1 並發 C2（spec §11 C2、§12.1「S1：C2、C3」；gate r1 A-I2）", () => {
  it("C2a：恰兩位管理員同時把對方降成一般成員 → 恰一個 200、一個 409 last_admin；最後恰一位內建管理員", async () => {
    let groupId = "";
    // `fire` 只賦值一次（在 `built` 之後）——放進 holder，`let` 會被 prefer-const 擋。
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    // 第一個請求（T10）在「鎖已取得、計數完、寫入前」發出第二個，並等它卡在 lockGroup 上（或已結束）。
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const a = await seedUser(built.db);
    const b = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    groupId = g.id;
    const cookieB = await cookieOf(b.id);
    race.fire = () =>
      built.app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a.id}`, cookies: cookieB, payload: { roleId: g.memberRoleId } });

    const first = await built.app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(a.id), payload: { roleId: g.memberRoleId },
    });
    const other = await second!;
    expect([first.statusCode, other.statusCode].sort()).toEqual([200, 409]);
    expect([first, other].find(r => r.statusCode === 409)!.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });

  it("C2b（spec gate r2 A-10 形）：持 canManageMembers 的自訂角色降級管理員 alice，同時另一位管理員 bob 退出 → 降級 200、退出 409 last_admin；最後恰一位內建管理員", async () => {
    let groupId = "";
    const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
    let second: Promise<LightMyRequestResponse> | undefined;
    let interleave: "blocked" | "settled" | undefined;
    const hook: GroupTestHook = async (point, ctx) => {
      if (point !== "group-members-checked" || ctx.groupId !== groupId || second || !race.fire) return;
      second = race.fire();
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const alice = await seedUser(built.db);
    const bob = await seedUser(built.db);
    const x = await seedUser(built.db);
    const g = await seedGroup(built.db, "G", [
      { userId: alice.id, role: "admin" }, { userId: bob.id, role: "admin" }, { userId: x.id, role: "member" },
    ]);
    await setMemberRole(built.db, g.id, x.id, await seedRole(built.db, g.id, "Manager", { canRead: true, canManageMembers: true }));
    groupId = g.id;
    const cookieBob = await cookieOf(bob.id);
    race.fire = () => built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${bob.id}`, cookies: cookieBob });

    const first = await built.app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${alice.id}`, cookies: await cookieOf(x.id), payload: { roleId: g.memberRoleId },
    });
    const other = await second!;
    expect([first.statusCode, other.statusCode]).toEqual([200, 409]);
    expect(other.json().error.code).toBe("last_admin");
    expect(await adminCount(built.db, g.id)).toBe(1);
    expect(interleave).toBe("blocked");
  });
});
