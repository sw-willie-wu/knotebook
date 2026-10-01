/**
 * #175 §5.2：`resolveNoteAccess` 的矩陣（spec §12.1「resolveNoteAccess 矩陣」）。群組筆記的 role 從不是 owner；
 * 非成員的站台 admin 在筆記上沒有任何特權（§5.5）；群組筆記上的殘留逐人分享列不給權限（規格落差 2、RF2）。
 */
import { describe, expect, it } from "vitest";
import type { NotePermissions } from "@knotebook/shared";
import {
  NO_PERMISSIONS, OWNER_PERMISSIONS, accessQuery, resolveNoteAccess, resolveRole, roleFromGroupFlags, type NoteAccess,
} from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { planOf, seedGroup, seedNote, seedPlannerData, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const P = (o: Partial<NotePermissions>): NotePermissions => ({ ...NO_PERMISSIONS, ...o });
const NONE: NoteAccess = { role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS };

describe("#175 resolveNoteAccess（spec §5.2）", () => {
  it("矩陣：個人 owner／逐人 editor／viewer／陌生人／群組成員；群組 × 內建管理員／一般成員／只讀自訂／刪除限定自訂／公開連結限定自訂／無閱讀自訂／非成員；非成員站台 admin／身為成員的站台 admin；不存在；非 UUID", async () => {
    const { db } = await buildTestApp();
    const [owner, ed, vw, stranger, admin, member, reader, blind, deleter, publisher] = await Promise.all(
      Array.from({ length: 10 }, () => seedUser(db)),
    );
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const memberSiteAdmin = await seedUser(db, { isAdmin: true });
    const personal = await seedNote(db, { ownerId: owner!.id });
    await seedShare(db, personal.id, ed!.id, "editor");
    await seedShare(db, personal.id, vw!.id, "viewer");
    const g = await seedGroup(db, "G", [
      { userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" },
      { userId: reader!.id, role: "member" }, { userId: blind!.id, role: "member" },
      { userId: deleter!.id, role: "member" }, { userId: publisher!.id, role: "member" },
      { userId: memberSiteAdmin.id, role: "member" },
    ]);
    await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    // 無閱讀旗標但勾了管理成員（兩個管理旗標不蘊含閱讀，gate r2 M-4）——筆記上仍是 none
    await setMemberRole(db, g.id, blind!.id, await seedRole(db, g.id, "Nothing", { canManageMembers: true }));
    // 刪除與公開連結各自獨立的兩個角色：讓 delete 與 managePublicLink／changeSlug 在矩陣裡可分辨，
    // 也讓「把刪除當成編輯」分得出來（task2 review r1 I-1）
    await setMemberRole(db, g.id, deleter!.id, await seedRole(db, g.id, "Del", { canRead: true, canDelete: true }));
    await setMemberRole(db, g.id, publisher!.id, await seedRole(db, g.id, "Pub", { canRead: true, canManagePublicLink: true }));
    const groupNote = await seedNote(db, { groupId: g.id });

    const cases: Array<[string, string, string, NoteAccess]> = [
      ["個人 owner", owner!.id, personal.id, { role: "owner", ownerId: owner!.id, groupId: null, permissions: OWNER_PERMISSIONS }],
      ["逐人 editor", ed!.id, personal.id, { role: "editor", ownerId: owner!.id, groupId: null, permissions: P({ read: true, edit: true }) }],
      ["逐人 viewer", vw!.id, personal.id, { role: "viewer", ownerId: owner!.id, groupId: null, permissions: P({ read: true }) }],
      ["陌生人", stranger!.id, personal.id, NONE],
      ["群組成員查別人的個人筆記（成員資格不外溢）", member!.id, personal.id, NONE],
      ["內建管理員", admin!.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true, delete: true, managePublicLink: true, changeSlug: true }) }],
      ["內建一般成員", member!.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true }) }],
      ["只讀自訂", reader!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true }) }],
      ["刪除限定自訂", deleter!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true, delete: true }) }],
      ["公開連結限定自訂", publisher!.id, groupNote.id, { role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true, managePublicLink: true, changeSlug: true }) }],
      ["無閱讀自訂", blind!.id, groupNote.id, NONE],
      ["非成員", stranger!.id, groupNote.id, NONE],
      ["非成員站台 admin", siteAdmin.id, groupNote.id, NONE],
      // §5.5：站台 admin 身分不加任何筆記旗標——身為一般成員就照一般成員角色（沒有 delete）
      ["身為一般成員的站台 admin", memberSiteAdmin.id, groupNote.id, { role: "editor", ownerId: null, groupId: g.id, permissions: P({ read: true, edit: true }) }],
      ["不存在", owner!.id, "00000000-0000-4000-8000-00000000dead", NONE],
      ["非 UUID", owner!.id, "not-a-uuid", NONE],
    ];
    // expect.soft：每一列各自報紅，不在第一列失敗就中止（task2 review r1 M-1）
    for (const [label, userId, noteId, expected] of cases) {
      expect.soft(await resolveNoteAccess(db, userId, noteId), label).toEqual(expected);
      expect.soft(await resolveRole(db, userId, noteId), label).toBe(expected.role);
    }
  });

  it("RF2：群組筆記上的殘留逐人分享列（S5 破裂，DB 直塞）不給非成員任何權限；成員另有分享列時以群組角色為準", async () => {
    const { db } = await buildTestApp();
    const [admin, reader, outsider] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: reader.id, role: "member" }]);
    await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    const note = await seedNote(db, { groupId: g.id });
    await seedShare(db, note.id, outsider.id, "editor");
    await seedShare(db, note.id, reader.id, "editor");
    expect(await resolveNoteAccess(db, outsider.id, note.id)).toEqual(NONE);
    expect(await resolveNoteAccess(db, reader.id, note.id)).toEqual({ role: "viewer", ownerId: null, groupId: g.id, permissions: P({ read: true }) });
  });

  it("roleFromGroupFlags：edit→editor、只有 read→viewer、兩者皆否→none", () => {
    expect(roleFromGroupFlags({ canRead: true, canEdit: true })).toBe("editor");
    expect(roleFromGroupFlags({ canRead: true, canEdit: false })).toBe("viewer");
    expect(roleFromGroupFlags({ canRead: false, canEdit: false })).toBe("none");
  });

  it("§5.2 單次 SELECT：notes PK、兩把成員／分享索引、group_roles PK；沒有 Seq Scan", async () => {
    const { db } = await buildTestApp();
    const { userId, noteId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, accessQuery(db, userId, noteId).toSQL());
    expect(plan).toContain("notes_pkey");
    expect(plan).toMatch(/group_members_group_id_user_id_pk|group_members_user_idx/);
    expect(plan).toMatch(/note_shares_note_id_user_id_pk|note_shares_user_idx/);
    expect(plan).toContain("group_roles_pkey");
    expect(plan).not.toContain("Seq Scan");
  });
});
