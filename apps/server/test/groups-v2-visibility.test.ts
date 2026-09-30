/**
 * #175 §5.3：五份可見性查詢的群組分支。查詢層直接跑（`GET /api/notes` 的 DTO 由 Task 4 覆蓋；MCP 的翻頁與搜尋
 * 由 Task 8 覆蓋——舊的 groups-visibility.test.ts 裡那兩案搬到那裡）。
 */
import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { groupMembers, noteLinks, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { accessFromListRow, visibleNoteBranches } from "../src/notes/list-query.js";
import { visibleNoteTitles } from "../src/notes/editing/candidates.js";
import { fetchBacklinks, writeNoteLinks } from "../src/notes/links.js";
import { loadNoteAudience, resolveNoteAccess } from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { planOf, seedGroup, seedNote, seedPlannerData, seedRole, seedShare, seedUser, setMemberRole, PLANNER_GROUP_OF_USER1 } from "./group-helpers.js";

function listFor(db: Db, userId: string) {
  const { owned, shared, grouped } = visibleNoteBranches(db, userId);
  return unionAll(owned, shared, grouped).orderBy(desc(notes.updatedAt), desc(notes.id));
}
const idsAndRoles = (rows: Array<{ id: string; role: string }>) => rows.map(r => `${r.id}:${r.role}`).sort();

async function scene(db: Db) {
  const [owner, admin, member, reader, blind, outsider] = await Promise.all(Array.from({ length: 6 }, () => seedUser(db)));
  const g = await seedGroup(db, "G", [
    { userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" },
    { userId: reader!.id, role: "member" }, { userId: blind!.id, role: "member" },
  ]);
  await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
  await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageGroup: true }));
  const personal = await seedNote(db, { ownerId: owner!.id }, { title: "P" });
  await seedShare(db, personal.id, member!.id, "viewer");
  const groupNote = await seedNote(db, { groupId: g.id }, { title: "GN" });
  return { owner: owner!, admin: admin!, member: member!, reader: reader!, blind: blind!, outsider: outsider!, g, personal, groupNote };
}

describe("#175 visibleNoteBranches（清單／MCP 共用）", () => {
  it("三支結構性互斥；grouped 要 can_read；role＝CASE；群組欄與 ownerHandle 形；RF2：群組筆記上的殘留分享列不讓非成員看見", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await seedShare(db, s.groupNote.id, s.outsider.id, "editor"); // RF2：S5 破裂（DB 直塞）
    expect(idsAndRoles(await listFor(db, s.owner.id))).toEqual([`${s.personal.id}:owner`]);
    expect(idsAndRoles(await listFor(db, s.admin.id))).toEqual([`${s.groupNote.id}:editor`]);
    expect(idsAndRoles(await listFor(db, s.member.id))).toEqual([`${s.groupNote.id}:editor`, `${s.personal.id}:viewer`].sort());
    expect(idsAndRoles(await listFor(db, s.reader.id))).toEqual([`${s.groupNote.id}:viewer`]);
    expect(await listFor(db, s.blind.id)).toEqual([]);
    expect(await listFor(db, s.outsider.id)).toEqual([]);
    const [row] = await listFor(db, s.admin.id);
    expect(row).toMatchObject({ ownerId: null, ownerHandle: null, groupId: s.g.id, groupName: "G", groupCanDelete: true, groupCanManagePublicLink: true });
    const [mine] = await listFor(db, s.owner.id);
    expect(mine).toMatchObject({ ownerHandle: s.owner.handle, groupId: null, groupName: null, groupCanDelete: null, groupCanManagePublicLink: null });
  });

  it("TS／SQL 兩處推導等價（gate r2 M-8）：每一列的 accessFromListRow 等於同一人同一篇的 resolveNoteAccess", async () => {
    // SQL 側＝grouped 支的 `CASE WHEN can_edit …`（經 `accessFromListRow` 還原成 permissions）；TS 側＝`resolveNoteAccess`
    // 走 `roleFromGroupFlags`＋`groupNotePermissions`。角色 fixture 涵蓋：owner、逐人分享 viewer、內建管理員、內建一般成員、
    // 只讀自訂、讀＋編＋刪自訂、讀＋公開連結自訂、讀＋刪自訂（viewer 但 managePublicLink／changeSlug 為真）。
    const { db } = await buildTestApp();
    const s = await scene(db);
    const [deleter, linker, readDeleter] = [await seedUser(db), await seedUser(db), await seedUser(db)];
    await seedGroup(db, "unused", []); // 讓 group_roles 裡有別群組的列，確保 JOIN 條件沒有跨群組
    await db.insert(groupMembers).values([
      { groupId: s.g.id, userId: deleter.id, roleId: await seedRole(db, s.g.id, "Editor+Delete", { canRead: true, canEdit: true, canDelete: true }) },
      { groupId: s.g.id, userId: linker.id, roleId: await seedRole(db, s.g.id, "Reader+Link", { canRead: true, canManagePublicLink: true }) },
      // 讀＋刪、不能編輯：刪除旗標不得被綁在編輯上（TS 端或 SQL `group_can_delete` 任一側綁了，這裡對不上）。
      { groupId: s.g.id, userId: readDeleter.id, roleId: await seedRole(db, s.g.id, "Reader+Delete", { canRead: true, canDelete: true }) },
    ]);
    // blind／outsider 在正確的碼上清單為空（第一案斷言）；放進迴圈是讓「清單多吐一列」也在這裡對不上 resolveNoteAccess。
    for (const user of [s.owner, s.admin, s.member, s.reader, deleter, linker, readDeleter, s.blind, s.outsider]) {
      const rows = await listFor(db, user.id);
      if (user !== s.blind && user !== s.outsider) expect(rows.length, user.id).toBeGreaterThan(0);
      for (const row of rows) {
        const { role, permissions } = await resolveNoteAccess(db, user.id, row.id);
        expect(accessFromListRow(row), `${user.id} × ${row.title}`).toEqual({ role, permissions });
      }
    }
  });

  it("§5.3：grouped 支走 group_members_user_idx、notes_group_slug_idx；notes 不 Seq Scan", async () => {
    const { db } = await buildTestApp();
    const { userId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, visibleNoteBranches(db, userId).grouped.toSQL());
    expect(plan).toContain("group_members_user_idx");
    // Task 1 刪了 notes_group_idx（A-M5）：group_id 開頭的只剩 notes_group_slug_idx。group_roles 不斷存取方式——
    // seed 只有 500 列角色，planner 選 Seq Scan＋Filter can_read 是對的（gate r1 A-M3）。
    expect(plan).toContain("notes_group_slug_idx");
    expect(plan).not.toMatch(/Seq Scan on notes\b/);
    expect(PLANNER_GROUP_OF_USER1).toMatch(/^[0-9a-f-]{36}$/); // 使用者 1 確實有群組（seed 形的健全性）
  });
});

describe("#175 其餘四份可見性查詢", () => {
  it("visibleNoteTitles：只讀角色看得到群組筆記標題；無閱讀旗標與非成員看不到", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    const titles = async (userId: string) => (await visibleNoteTitles(db, userId)).map(t => t.title).sort();
    expect(await titles(s.reader.id)).toEqual(["GN"]);
    expect(await titles(s.member.id)).toEqual(["GN", "P"]);
    expect(await titles(s.blind.id)).toEqual([]);
    expect(await titles(s.outsider.id)).toEqual([]);
  });

  it("loadNoteAudience：個人＝owner ∪ shares；群組＝持 can_read 角色的成員（不含無閱讀旗標者），不混進 null", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    expect([...(await loadNoteAudience(db, s.personal.id))].sort()).toEqual([s.owner.id, s.member.id].sort());
    expect([...(await loadNoteAudience(db, s.groupNote.id))].sort()).toEqual([s.admin.id, s.member.id, s.reader.id].sort());
  });

  it("writeNoteLinks（T15）：只讀成員在自己的筆記寫 [[群組筆記]] 寫得進去；無閱讀旗標者與非成員提交同一個 target 被靜默丟棄", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    for (const [user, expected] of [[s.reader, 1], [s.blind, 0], [s.outsider, 0]] as const) {
      const source = await seedNote(db, { ownerId: user.id });
      expect(await writeNoteLinks(db, { sourceNoteId: source.id, userId: user.id, targetIds: [s.groupNote.id], clock: 1 })).toBe("applied");
      const rows = await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, source.id));
      expect(rows.length, user.id).toBe(expected);
    }
  });

  it("fetchBacklinks：群組筆記連到我的筆記 → 成員看得到那條（ownerHandle null、groupId 有值）；無閱讀旗標者與非成員看不到", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await db.insert(noteLinks).values({ sourceNoteId: s.groupNote.id, targetNoteId: s.personal.id });
    expect(await fetchBacklinks(db, s.personal.id, s.member.id)).toEqual([
      { id: s.groupNote.id, title: "GN", slug: s.groupNote.slug, ownerHandle: null, groupId: s.g.id },
    ]);
    expect(await fetchBacklinks(db, s.personal.id, s.blind.id)).toEqual([]);
    expect(await fetchBacklinks(db, s.personal.id, s.outsider.id)).toEqual([]);
  });

  it("RF2（gate r1 A-M6）：群組筆記上的殘留分享列不讓非成員從 backlinks、T15、候選看到或連到它", async () => {
    const { db } = await buildTestApp();
    const s = await scene(db);
    await seedShare(db, s.groupNote.id, s.outsider.id, "editor"); // S5 破裂（DB 直塞）
    const mine = await seedNote(db, { ownerId: s.outsider.id }, { title: "Mine" });
    await db.insert(noteLinks).values({ sourceNoteId: s.groupNote.id, targetNoteId: mine.id });
    expect(await fetchBacklinks(db, mine.id, s.outsider.id)).toEqual([]); // 不洩漏群組筆記的標題／slug／群組 id
    const source = await seedNote(db, { ownerId: s.outsider.id });
    expect(await writeNoteLinks(db, { sourceNoteId: source.id, userId: s.outsider.id, targetIds: [s.groupNote.id], clock: 1 })).toBe("applied");
    expect(await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, source.id))).toEqual([]);
    expect((await visibleNoteTitles(db, s.outsider.id)).map(t => t.id)).not.toContain(s.groupNote.id);
  });
});
