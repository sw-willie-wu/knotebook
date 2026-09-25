import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import { groupMembers, groups } from "../src/db/schema.js";
import { groupNoteIdsQuery, listMyGroupsQuery } from "../src/groups/queries.js";
import { buildTestApp } from "./helpers.js";
import {
  PLANNER_GROUP_OF_USER1, cookieOf, planOf, runGroupAuthMatrix, seedGroup, seedPlannerData, seedUser, spyCollabHooks,
} from "./group-helpers.js";

const NUL = String.fromCharCode(0);

describe("#103 POST／GET /api/groups", () => {
  it("POST：201 GroupDto（myRole=admin、名稱 trim）、同交易 insert 建立者為 admin（S2）、created_by=我；未登入 401", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db);
    const res = await app.inject({ method: "POST", url: "/api/groups", cookies: await cookieOf(me.id), payload: { name: "  Design  " } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as GroupDto;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "myRole", "name"]);
    expect(body).toMatchObject({ name: "Design", myRole: "admin" });
    const [row] = await db.select().from(groupMembers).where(eq(groupMembers.groupId, body.id));
    expect(row).toMatchObject({ userId: me.id, role: "admin" });
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

  it("GET /api/groups：只列我所屬的、依 name 再依 id；myRole 正確；站台 admin 也看不到非所屬群組", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const me = await seedUser(db, { isAdmin: true });
    const other = await seedUser(db);
    const same1 = await seedGroup(db, "Same", [{ userId: me.id, role: "member" }, { userId: other.id, role: "admin" }]);
    const same2 = await seedGroup(db, "Same", [{ userId: me.id, role: "admin" }]);
    const alpha = await seedGroup(db, "Alpha", [{ userId: me.id, role: "admin" }]);
    await seedGroup(db, "Aardvark", [{ userId: other.id, role: "admin" }]);

    const res = await app.inject({ method: "GET", url: "/api/groups", cookies: await cookieOf(me.id) });
    expect(res.statusCode).toBe(200);
    const list = res.json() as GroupDto[];
    const sameIds = [same1.id, same2.id].sort();
    expect(list.map(g => g.id)).toEqual([alpha.id, ...sameIds]);
    expect(list.find(g => g.id === same1.id)!.myRole).toBe("member");
    expect(list.find(g => g.id === same2.id)!.myRole).toBe("admin");
  });
});

describe("#103 PATCH /api/groups/:id 與 GET …/members", () => {
  it("PATCH 改名的授權矩陣（含站台 admin、非 UUID、不存在；三種 404 逐位元組相同）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "PATCH",
      url: id => `/api/groups/${id}`,
      payload: () => ({ name: "Renamed" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("PATCH：trim 後寫入、回 GroupDto；非 admin 的成員即使 body 壞也先拿 403；admin 送壞名稱 → 400 invalid_name、送 {} → 400 invalid_body；站台 admin 非成員的 myRole=admin", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "Old", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const ok = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " New " } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: g.id, name: "New", myRole: "admin" });
    expect((await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(member.id), payload: {} })).statusCode).toBe(403);
    const bad = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_name");
    const emptyBody = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: {} });
    expect(emptyBody.statusCode).toBe(400);
    expect(emptyBody.json().error.code).toBe("invalid_body");
    const bySite = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(site.id), payload: { name: "Site" } });
    expect(bySite.json()).toMatchObject({ name: "Site", myRole: "admin" });
  });

  it("GET …/members 的授權矩陣（成員即可讀）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "GET",
      url: id => `/api/groups/${id}/members`,
      expected: { anon: 401, nonMember: 404, member: 200, admin: 200, siteAdmin: 200, badId: 404, missing: 404 },
    });
  });

  it("GET …/members：admin 在前、再依 displayName、再依 userId；每列含 email（A8）", async () => {
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
    expect(rows[0]).toEqual({ userId: zed.id, email: zed.email, displayName: "Zed", role: "admin" });
    expect(Object.keys(rows[1]!).sort()).toEqual(["displayName", "email", "role", "userId"]);
  });

  it("【推→驗】§4.1：GET /api/groups 走 group_members_user_idx；「群組內所有筆記」走 notes_group_idx", async () => {
    const { db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const { userId } = await seedPlannerData(db.$client);
    expect(await planOf(db.$client, listMyGroupsQuery(db, userId).toSQL())).toContain("group_members_user_idx");
    expect(await planOf(db.$client, groupNoteIdsQuery(db, PLANNER_GROUP_OF_USER1).toSQL())).toContain("notes_group_idx");
  });
});
