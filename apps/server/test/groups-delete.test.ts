import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { groupMembers, groups } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, noteState, runGroupAuthMatrix, seedGroup, seedNote, seedShare, seedUser, sharesOf, spyCollabHooks,
} from "./group-helpers.js";

describe("#103 DELETE /api/groups/:id", () => {
  it("授權矩陣", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("物化（D8）：筆記變個人筆記；成員依原 group_role 各得一列 note_shares；owner 不得一列（含 A1 已退出的 owner）；公開連結保留；不踢線", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const ownerMember = await seedUser(db);
    const leftOwner = await seedUser(db);
    const g = await seedGroup(db, "G", [
      { userId: admin.id, role: "admin" },
      { userId: member.id, role: "member" },
      { userId: ownerMember.id, role: "member" },
    ]);
    const n1 = await seedNote(db, ownerMember.id, { groupId: g.id, groupRole: "editor", publicToken: "q".repeat(43), publicSlug: "still-public" });
    const n2 = await seedNote(db, leftOwner.id, { groupId: g.id, groupRole: "viewer" }); // A1：owner 不是成員

    const res = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    expect(res.statusCode).toBe(204);

    expect(await sharesOf(db, n1.id)).toEqual(
      [{ userId: admin.id, role: "editor" }, { userId: member.id, role: "editor" }].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
    );
    expect(await sharesOf(db, n2.id)).toEqual(
      [
        { userId: admin.id, role: "viewer" },
        { userId: member.id, role: "viewer" },
        { userId: ownerMember.id, role: "viewer" },
      ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
    );
    expect(await noteState(db.$client, n1.id)).toMatchObject({ group_id: null, public_token: "q".repeat(43), public_slug: "still-public" });
    expect((await noteState(db.$client, n2.id)).group_id).toBeNull();
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();

    const again = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    expect(again.statusCode).toBe(404);
  });

  it("S5 破裂的既有逐人分享（塞 DB）：物化只升不降", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const admin = await seedUser(db);
    const m = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const upgrade = await seedNote(db, admin.id, { groupId: g.id, groupRole: "editor" });
    const keep = await seedNote(db, admin.id, { groupId: g.id, groupRole: "viewer" });
    await seedShare(db, upgrade.id, m.id, "viewer");
    await seedShare(db, keep.id, m.id, "editor");

    expect((await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) })).statusCode).toBe(204);
    expect(await sharesOf(db, upgrade.id)).toEqual([{ userId: m.id, role: "editor" }]);
    expect(await sharesOf(db, keep.id)).toEqual([{ userId: m.id, role: "editor" }]);
  });
});
