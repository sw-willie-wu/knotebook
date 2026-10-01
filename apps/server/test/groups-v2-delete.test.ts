/**
 * #175 T5（§6.7、B9）：PR1–PR3 的 `DELETE /api/groups/:id` 只刪**空**群組。非空 → 409 `group_not_empty`、什麼都不動；
 * 空 → 204，角色與成員由 FK CASCADE 帶走。刪空群組沒有筆記可重驗，不呼叫 `onGroupAccessChanged`。
 * （「同時建立」的兩種順序在 `groups-v2-race.test.ts`。）
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { groupMembers, groupRoles, groups, notes } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, runGroupAuthMatrix, seedGroup, seedNote, seedUser, spyCollabHooks } from "./group-helpers.js";

describe("#175 DELETE /api/groups/:id（只刪空群組）", () => {
  it("授權矩陣（每個 actor 的場景都是空群組）：member 403、admin／站台 admin 204；非成員／非 UUID／不存在 404 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("非空 → 409 group_not_empty，群組、角色、成員、筆記都還在；刪掉那篇之後 → 204，group_roles／group_members 對該群組 0 列（CASCADE）；再刪 → 404", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const cookies = await cookieOf(admin.id);

    const blocked = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: { code: "group_not_empty", message: "群組內還有筆記，無法刪除" } });
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await db.select().from(groupRoles).where(eq(groupRoles.groupId, g.id))).toHaveLength(2);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toHaveLength(2);
    expect(await db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, n.id))).toEqual([{ groupId: g.id }]);

    await db.delete(notes).where(eq(notes.id, n.id));
    const ok = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    expect(ok.statusCode).toBe(204);
    expect(ok.body).toBe("");
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(await db.select().from(groupRoles).where(eq(groupRoles.groupId, g.id))).toEqual([]);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toEqual([]);

    const again = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
  });

  it("不呼叫 onGroupAccessChanged（409 與 204 兩條路都不呼叫）", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const full = await seedGroup(db, "Full", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    await seedNote(db, { groupId: full.id });
    const empty = await seedGroup(db, "Empty", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const cookies = await cookieOf(admin.id);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${full.id}`, cookies })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/groups/${empty.id}`, cookies })).statusCode).toBe(204);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(hooks.onShareChanged).not.toHaveBeenCalled();
  });
});
