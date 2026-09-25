import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { groupMembers } from "../src/db/schema.js";
import { resolveRole, resolveRoleWithOwner, roleQuery } from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { planOf, seedGroup, seedNote, seedPlannerData, seedShare, seedUser } from "./group-helpers.js";

const NONE = { role: "none", ownerId: null, isGroupMember: false, groupId: null };

describe("#103 resolveRoleWithOwner：多來源取最大值（spec §5.1）", () => {
  it("矩陣：owner（兼成員／非成員）、逐人 editor／viewer、群組 editor／viewer、非成員、已退出、不存在、非 UUID——含每格的 isGroupMember／groupId", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const viewerMember = await seedUser(db);
    const stranger = await seedUser(db);
    const leaver = await seedUser(db);
    const shareEditor = await seedUser(db);
    const shareViewer = await seedUser(db);
    const g = await seedGroup(db, "G", [
      { userId: owner.id, role: "admin" },
      { userId: member.id, role: "member" },
      { userId: leaver.id, role: "member" },
    ]);
    const gv = await seedGroup(db, "GV", [{ userId: viewerMember.id, role: "admin" }]);
    const inG = await seedNote(db, owner.id, { groupId: g.id }); // group_role 吃 default editor
    const inGv = await seedNote(db, owner.id, { groupId: gv.id, groupRole: "viewer" }); // owner 不是 GV 成員（A1 形）
    const personal = await seedNote(db, owner.id);
    await seedShare(db, personal.id, shareEditor.id, "editor");
    await seedShare(db, personal.id, shareViewer.id, "viewer");
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, leaver.id)));

    expect(await resolveRoleWithOwner(db, owner.id, inG.id)).toEqual({ role: "owner", ownerId: owner.id, isGroupMember: true, groupId: g.id });
    expect(await resolveRoleWithOwner(db, owner.id, inGv.id)).toEqual({ role: "owner", ownerId: owner.id, isGroupMember: false, groupId: gv.id });
    expect(await resolveRoleWithOwner(db, shareEditor.id, personal.id)).toEqual({ role: "editor", ownerId: owner.id, isGroupMember: false, groupId: null });
    expect(await resolveRoleWithOwner(db, shareViewer.id, personal.id)).toEqual({ role: "viewer", ownerId: owner.id, isGroupMember: false, groupId: null });
    expect(await resolveRoleWithOwner(db, member.id, inG.id)).toEqual({ role: "editor", ownerId: owner.id, isGroupMember: true, groupId: g.id });
    expect(await resolveRoleWithOwner(db, viewerMember.id, inGv.id)).toEqual({ role: "viewer", ownerId: owner.id, isGroupMember: true, groupId: gv.id });
    expect(await resolveRoleWithOwner(db, stranger.id, inG.id)).toEqual(NONE);
    expect(await resolveRoleWithOwner(db, leaver.id, inG.id)).toEqual(NONE);
    expect(await resolveRoleWithOwner(db, member.id, personal.id)).toEqual(NONE); // 成員資格不外溢到個人筆記
    expect(await resolveRoleWithOwner(db, owner.id, "00000000-0000-4000-8000-00000000dead")).toEqual(NONE);
    expect(await resolveRoleWithOwner(db, owner.id, "not-a-uuid")).toEqual(NONE);
    // resolveRole（簽名凍結）與姊妹函式的 role 一致
    expect(await resolveRole(db, member.id, inG.id)).toBe("editor");
    expect(await resolveRole(db, viewerMember.id, inGv.id)).toBe("viewer");
    expect(await resolveRole(db, leaver.id, inG.id)).toBe("none");
  });

  it("S5 破裂（直接塞 DB：同一人既是成員又有逐人分享）→ 兩個方向都取最大值", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const m1 = await seedUser(db);
    const m2 = await seedUser(db);
    const g = await seedGroup(db, "G", [
      { userId: owner.id, role: "admin" },
      { userId: m1.id, role: "member" },
      { userId: m2.id, role: "member" },
    ]);
    const viewerNote = await seedNote(db, owner.id, { groupId: g.id, groupRole: "viewer" });
    const editorNote = await seedNote(db, owner.id, { groupId: g.id, groupRole: "editor" });
    await seedShare(db, viewerNote.id, m1.id, "editor");
    await seedShare(db, editorNote.id, m2.id, "viewer");
    expect(await resolveRoleWithOwner(db, m1.id, viewerNote.id)).toEqual({ role: "editor", ownerId: owner.id, isGroupMember: true, groupId: g.id });
    expect(await resolveRoleWithOwner(db, m2.id, editorNote.id)).toEqual({ role: "editor", ownerId: owner.id, isGroupMember: true, groupId: g.id });
    expect(await resolveRole(db, m1.id, viewerNote.id)).toBe("editor");
  });

  it("【推→驗】§5.1 單次 JOIN：三個來源各走索引、沒有 Seq Scan", async () => {
    const { db } = await buildTestApp();
    const { userId, noteId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, roleQuery(db, userId, noteId).toSQL());
    expect(plan).toContain("notes_pkey");
    // 單列外表的 join：PK 與 user 索引估計成本接近，planner 選哪一把都合法（比照 Task 3 的寬容形）
    expect(plan).toMatch(/note_shares_note_id_user_id_pk|note_shares_user_idx/);
    expect(plan).toMatch(/group_members_group_id_user_id_pk|group_members_user_idx/);
    expect(plan).not.toContain("Seq Scan");
  });
});
