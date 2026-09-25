/**
 * #103 §6.5：`NoteDto.group` 的可見性（S4）——只在 `role === 'owner'` 或呼叫者是該群組成員時有值。
 * 清單路徑的判定點＝分支輸出欄（shared 支恆 NULL）；單篇路徑＝`resolveRoleWithOwner` 的
 * `isGroupMember`，且只在它回的 `groupId` 等於取到那一列的 `group_id` 時採用。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { NoteDto } from "@knotebook/shared";
import { groupMembers, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";

async function scene(db: Db) {
  const owner = await seedUser(db);
  const member = await seedUser(db);
  const outsider = await seedUser(db);
  const g = await seedGroup(db, "Design", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
  const note = await seedNote(db, owner.id, { groupId: g.id, groupRole: "viewer" });
  // S5 破裂：outsider 不是成員但有一列逐人分享（直接塞 DB）——他看得到筆記，卻不得拿到群組名（S4）。
  await seedShare(db, note.id, outsider.id, "editor");
  return { owner, member, outsider, g, note };
}

describe("#103 NoteDto.group（spec §6.5）", () => {
  it("GET /api/notes：owner 與成員拿到 {id,name,role:group_role}；S5 破裂的非成員拿到 null；個人筆記恆 null", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const personal = await seedNote(db, s.owner.id);
    const expected = { id: s.g.id, name: "Design", role: "viewer" };
    const find = async (userId: string, noteId: string): Promise<NoteDto> => {
      const res = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(userId) });
      return (res.json() as NoteDto[]).find(n => n.id === noteId)!;
    };
    expect((await find(s.owner.id, s.note.id)).group).toEqual(expected);
    expect((await find(s.member.id, s.note.id)).group).toEqual(expected);
    expect((await find(s.outsider.id, s.note.id)).group).toBeNull();
    expect((await find(s.owner.id, personal.id)).group).toBeNull();
  });

  it("GET /api/notes/:ref 與 by-path：owner（含已退出群組的 A1）與成員有值；S5 破裂的非成員 null", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const expected = { id: s.g.id, name: "Design", role: "viewer" };
    const byRef = async (userId: string) =>
      (await app.inject({ method: "GET", url: `/api/notes/${s.note.id}`, cookies: await cookieOf(userId) })).json() as NoteDto;
    const byPath = async (userId: string) =>
      (await app.inject({ method: "GET", url: `/api/notes/by-path/${s.owner.handle}/${s.note.slug}`, cookies: await cookieOf(userId) })).json() as NoteDto;

    expect((await byRef(s.member.id)).group).toEqual(expected);
    expect((await byPath(s.member.id)).group).toEqual(expected);
    expect((await byRef(s.outsider.id)).group).toBeNull();
    expect((await byPath(s.outsider.id)).group).toBeNull();
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, s.g.id), eq(groupMembers.userId, s.owner.id)));
    expect((await byRef(s.owner.id)).group).toEqual(expected);
    expect((await byPath(s.owner.id)).group).toEqual(expected);
  });

  it("RF4：成員（editor）PATCH 標題 → 200、group 有值（.returning() 那條路補查群組名）、updated_at 照舊推高", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "Ops", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id });
    const before = (await db.select({ u: notes.updatedAt }).from(notes).where(eq(notes.id, note.id)))[0]!.u;

    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: await cookieOf(member.id), payload: { title: "Renamed" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().group).toEqual({ id: g.id, name: "Ops", role: "editor" });
    expect(res.json().role).toBe("editor");
    expect(new Date(res.json().updatedAt).getTime()).toBeGreaterThan(before.getTime());
  });

  it(":ref 在授權與取列之間換了群組（groupTestHook ref-authorized）→ 200，但 group 為 null（新群組的名字不外洩給非成員）", async () => {
    // hook 必須在 buildTestApp 之前建好，db 卻要等 buildTestApp 回來才有——經 holder 事後補上（prefer-const）。
    const live: { db?: Db } = {};
    let moveTo = "";
    let noteId = "";
    const hook: GroupTestHook = async (point, ctx) => {
      if (point === "ref-authorized" && ctx.noteId === noteId) {
        await live.db!.update(notes).set({ groupId: moveTo }).where(eq(notes.id, noteId));
      }
    };
    const built = await buildTestApp({ groupTestHook: hook });
    const db = built.db;
    live.db = db;
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const g1 = await seedGroup(db, "Old", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const g2 = await seedGroup(db, "Secret", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(db, owner.id, { groupId: g1.id });
    noteId = note.id;
    moveTo = g2.id;

    const res = await built.app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: await cookieOf(member.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("editor"); // 授權當下的角色
    expect(res.json().group).toBeNull();
    expect(res.body).not.toContain("Secret");
  });
});
