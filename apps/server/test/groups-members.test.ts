import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { groupMembers } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedUser, spyCollabHooks, waitForBlockedOrSettled,
} from "./group-helpers.js";

async function roleOf(db: Db, groupId: string, userId: string): Promise<string | undefined> {
  const [row] = await db.select({ role: groupMembers.role }).from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  return row?.role;
}

describe("#103 成員異動：授權矩陣", () => {
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
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: (id, s) => `/api/groups/${id}/members/${s.other.id}`,
      payload: () => ({ role: "admin" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
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
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies, payload: { role: "admin" } })),
      (await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies, payload: { role: "admin" } })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/not-a-uuid`, cookies })),
      (await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${stranger.id}`, cookies })),
    ];
    for (const res of bodies) expect(res.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
  });
});

describe("#103 PUT …/members", () => {
  it("email 不分大小寫、停用帳號照樣加、role 預設 member／可指定 admin；找不到 email → 404 user_not_found", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const plain = await seedUser(db);
    const disabled = await seedUser(db, { disabled: true });
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);

    const a = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: plain.email.toUpperCase() } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ userId: plain.id, email: plain.email, displayName: expect.any(String), role: "member" });
    const b = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: disabled.email, role: "admin" } });
    expect(b.statusCode).toBe(200);
    expect(await roleOf(db, g.id, disabled.id)).toBe("admin");
    const missing = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "nobody@example.com" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("user_not_found");
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled(); // §7：加人不踢線
  });

  it("只新增：已是成員 → 409 already_member，且既有 admin 的 role 不變", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const res = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id), payload: { email: admin.email, role: "member" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("already_member");
    expect(await roleOf(db, g.id, admin.id)).toBe("admin");
  });

  it("admin 送壞 body → 400 invalid_body：PUT …/members 的非 email、PATCH …/members/:userId 的 role 不在 admin／member", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const cookies = await cookieOf(admin.id);
    const put = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: "not-an-email" } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error.code).toBe("invalid_body");
    const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${member.id}`, cookies, payload: { role: "owner" } });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error.code).toBe("invalid_body");
    expect(await roleOf(db, g.id, member.id)).toBe("member");
  });
});

describe("#103 S1：每個群組至少一位 admin", () => {
  it("最後一位 admin 退出／被站台 admin 移除／被降級 → 409 last_admin；兩位 admin 時都可以", async () => {
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
    const demote = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { role: "member" } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_admin");
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    await db.insert(groupMembers).values({ groupId: g.id, userId: a2.id, role: "admin" });
    const demoteOk = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id), payload: { role: "member" } });
    expect(demoteOk.statusCode).toBe(200);
    expect(demoteOk.json()).toMatchObject({ userId: a1.id, role: "member" });
    const leaveOk = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${a1.id}`, cookies: await cookieOf(a1.id) });
    expect(leaveOk.statusCode).toBe(204);
  });

  it("一般成員自行退出 → 204；admin 移人 → 204；兩者都以（群組所有筆記, [那一人]）呼叫 onGroupAccessChanged；升降級不呼叫", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const leaver = await seedUser(db);
    const removed = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: leaver.id, role: "member" }, { userId: removed.id, role: "member" }]);
    const n1 = await seedNote(db, admin.id, { groupId: g.id });
    const n2 = await seedNote(db, leaver.id, { groupId: g.id });

    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: await cookieOf(admin.id), payload: { role: "admin" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: await cookieOf(admin.id), payload: { role: "member" } })).statusCode).toBe(200);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${leaver.id}`, cookies: await cookieOf(leaver.id) })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${removed.id}`, cookies: await cookieOf(admin.id) })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    const [notes1, users1] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect([...notes1].sort()).toEqual([n1.id, n2.id].sort());
    expect(users1).toEqual([leaver.id]);
    expect(hooks.onGroupAccessChanged.mock.calls[1]![1]).toEqual([removed.id]);
  });

  it("並發（spec gate r2 E）：兩位 admin 同時退出 → 恰一個 204、一個 409 last_admin；群組最後剩一位 admin", async () => {
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
    const admins = await built.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.role, "admin")));
    expect(admins).toHaveLength(1);
    expect(interleave).toBe("blocked");
  });
});
