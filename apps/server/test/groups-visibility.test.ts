/**
 * #103 §5.2：`visibleNoteBranches` 的 grouped 分支與三個 union 呼叫端（REST `GET /api/notes`、MCP
 * `list_notes`／`search_notes`）。`NoteDto.group` 的值在 Task 5 的 `groups-note-dto.test.ts` 驗；
 * 這裡只驗「誰看得到、看到幾列、role 是什麼」。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { groupMembers, notes } from "../src/db/schema.js";
import { visibleNoteBranches } from "../src/notes/list-query.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, planOf, seedGroup, seedNote, seedPlannerData, seedShare, seedUser } from "./group-helpers.js";

const PASSWORD = "correct-horse-battery";

async function listed(app: FastifyInstance, userId: string): Promise<Array<{ id: string; role: string }>> {
  const res = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(userId) });
  expect(res.statusCode).toBe(200);
  return (res.json() as Array<{ id: string; role: string }>).map(n => ({ id: n.id, role: n.role }));
}

describe("#103 GET /api/notes 的 grouped 分支", () => {
  it("成員看得到群組筆記、role＝group_role（editor／viewer 兩格）；非成員看不到；成員資格不外溢到個人筆記", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const asEditor = await seedNote(db, owner.id, { groupId: g.id });
    const asViewer = await seedNote(db, owner.id, { groupId: g.id, groupRole: "viewer" });
    const personal = await seedNote(db, owner.id);

    const mine = await listed(app, member.id);
    expect(mine).toContainEqual({ id: asEditor.id, role: "editor" });
    expect(mine).toContainEqual({ id: asViewer.id, role: "viewer" });
    expect(mine.map(n => n.id)).not.toContain(personal.id);
    const theirs = (await listed(app, stranger.id)).map(n => n.id);
    expect(theirs).not.toContain(asEditor.id);
    expect(theirs).not.toContain(asViewer.id);
  });

  it("RF5：owner 本身也是成員 → 自己的群組筆記恰一列、role=owner；owner 退出群組（A1）後仍恰一列 owner", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id });

    const before = (await listed(app, owner.id)).filter(n => n.id === note.id);
    expect(before).toEqual([{ id: note.id, role: "owner" }]);
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, owner.id)));
    const after = (await listed(app, owner.id)).filter(n => n.id === note.id);
    expect(after).toEqual([{ id: note.id, role: "owner" }]);
  });

  it("S5 破裂（直接塞 DB：成員另有逐人分享）→ 清單恰一列，role 取逐人分享那一列的值（spec §5.2 明示的代價；實際授權仍取 max）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id, groupRole: "editor" });
    await seedShare(db, note.id, member.id, "viewer");

    expect((await listed(app, member.id)).filter(n => n.id === note.id)).toEqual([{ id: note.id, role: "viewer" }]);
  });

  it("【推→驗】§5.2／§4.1：grouped 分支的計畫走 group_members_user_idx 與 notes_group_idx，NOT EXISTS 是 anti join、不對 note_shares 全表掃", async () => {
    const { db } = await buildTestApp();
    const { userId } = await seedPlannerData(db.$client);
    const plan = await planOf(db.$client, visibleNoteBranches(db, userId).grouped.toSQL());
    expect(plan).toContain("group_members_user_idx");
    expect(plan).toContain("notes_group_idx");
    expect(plan).toMatch(/Anti Join/);
    expect(plan).toMatch(/note_shares_note_id_user_id_pk|note_shares_user_idx/);
    expect(plan).not.toContain("Seq Scan on note_shares");
    expect(plan).not.toContain("Seq Scan on notes");
  });
});

describe("#103 MCP 的 grouped 分支", () => {
  it("list_notes：自有／逐人分享／群組三支混在一起翻頁（limit 2），四頁湊回全集、無重複無遺漏", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: `me-${randomUUID()}@example.com`, password: PASSWORD });
    const other = await ctx.createUser({ email: `ot-${randomUUID()}@example.com`, password: PASSWORD });
    const g = await seedGroup(ctx.db, "G", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }]);
    const specs: Array<{ owner: string; share?: boolean; group?: boolean }> = [
      { owner: me.id },
      { owner: other.id, share: true },
      { owner: other.id, group: true },
      { owner: me.id, group: true },
      { owner: other.id, share: true },
      { owner: other.id, group: true },
      { owner: other.id, group: true },
    ];
    const ids: string[] = [];
    for (const [i, s] of specs.entries()) {
      const n = await seedNote(ctx.db, s.owner, { title: `P${i}`, ...(s.group ? { groupId: g.id } : {}) });
      if (s.share) await seedShare(ctx.db, n.id, me.id, "viewer");
      await ctx.db.update(notes).set({ updatedAt: new Date(`2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`) }).where(eq(notes.id, n.id));
      ids.push(n.id);
    }
    const invisible = await seedNote(ctx.db, other.id, { title: "Invisible" });
    const { token } = await seedTokenForUser(ctx.db, me.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const args: Record<string, unknown> = cursor === null ? { limit: 2 } : { limit: 2, cursor };
      const res = await mcpPost(ctx.app, rpc("tools/call", { name: "list_notes", arguments: args }), { token });
      expect(res.statusCode).toBe(200);
      const out = res.json().result.structuredContent as { notes: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...out.notes.map(n => n.id));
      cursor = out.nextCursor;
      if (page < 3) expect(typeof cursor).toBe("string");
      else expect(cursor).toBeNull();
    }
    expect(seen).toEqual([...ids].reverse());
    expect(seen).not.toContain(invisible.id);
  });

  it("search_notes：rank（完全相等 → 前綴 → 子字串）跨三支成立；我不是成員的群組筆記不出現", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: `me-${randomUUID()}@example.com`, password: PASSWORD });
    const other = await ctx.createUser({ email: `ot-${randomUUID()}@example.com`, password: PASSWORD });
    const g = await seedGroup(ctx.db, "G", [{ userId: other.id, role: "admin" }, { userId: me.id, role: "member" }]);
    const foreign = await seedGroup(ctx.db, "F", [{ userId: other.id, role: "admin" }]);
    const exactGrouped = await seedNote(ctx.db, other.id, { title: "Alpha", groupId: g.id });
    const prefixShared = await seedNote(ctx.db, other.id, { title: "Alpha beta" });
    await seedShare(ctx.db, prefixShared.id, me.id, "viewer");
    const substringOwned = await seedNote(ctx.db, me.id, { title: "The alpha" });
    const notMine = await seedNote(ctx.db, other.id, { title: "Alpha", groupId: foreign.id });
    const { token } = await seedTokenForUser(ctx.db, me.id);

    const res = await mcpPost(ctx.app, rpc("tools/call", { name: "search_notes", arguments: { query: "alpha" } }), { token });
    expect(res.statusCode).toBe(200);
    const out = res.json().result.structuredContent as { notes: Array<{ id: string }> };
    expect(out.notes.map(n => n.id)).toEqual([exactGrouped.id, prefixShared.id, substringOwned.id]);
    expect(out.notes.map(n => n.id)).not.toContain(notMine.id);
  });
});
