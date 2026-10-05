/**
 * #175 §6.2／§6.6／§12.1：建立（REST）、刪除、分享、公開連結對群組筆記的判準。S5／C13／C14 的交錯用
 * groupTestHook 在「授權之後、寫入之前」以 SQL 把個人筆記移進群組（模擬 PR2 的移動）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { groups, noteLinks, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sharesOf } from "./group-helpers.js";

const ALL = { read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true };

async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, userId: string, payload?: object) {
  return app.inject({ method, url, cookies: await cookieOf(userId), ...(payload ? { payload } : {}) });
}

async function scene(db: Db) {
  const [admin, member, reader, outsider] = await Promise.all(Array.from({ length: 4 }, () => seedUser(db)));
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const g = await seedGroup(db, "Team", [{ userId: admin!.id, role: "admin" }, { userId: member!.id, role: "member" }, { userId: reader!.id, role: "member" }]);
  await setMemberRole(db, g.id, reader!.id, await seedRole(db, g.id, "Reader", { canRead: true }));
  return { admin: admin!, member: member!, reader: reader!, outsider: outsider!, siteAdmin, g };
}

interface MoverState { point?: GroupRacePoint; noteId?: string; groupId?: string; reopenToken?: string }

/**
 * 在指定的注入點把某篇個人筆記移進群組（清 owner、設 group、清 token／別名——PR2 的移動會做的事）。
 * `reopenToken` 有值時，移動之後再以群組管理員的身分重開 token（C14 的三方交錯，gate r2 A-12）。
 */
function moverHook(db: () => Db, state: MoverState) {
  return async (point: GroupRacePoint, ctx: { noteId?: string }) => {
    if (point !== state.point || ctx.noteId !== state.noteId) return;
    await db().update(notes).set({ ownerId: null, groupId: state.groupId!, publicToken: null, publicSlug: null }).where(eq(notes.id, state.noteId!));
    if (state.reopenToken) await db().update(notes).set({ publicToken: state.reopenToken }).where(eq(notes.id, state.noteId!));
  };
}

describe("#175 POST /api/notes {groupId}（§6.2，gate r1 I3、r4 N-2）", () => {
  it("成員（內建一般成員）：帶與不帶 content 都 201，role editor、owner 欄 null、groupId／group 有值、permissions 取角色；個人建立仍是 owner", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const bare = await call(app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, title: "Plan" });
    expect(bare.statusCode).toBe(201);
    expect(bare.json()).toMatchObject({
      role: "editor", ownerId: null, ownerHandle: null, groupId: s.g.id, group: { id: s.g.id, name: "Team" }, slug: "plan",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    const byAdmin = await call(app, "POST", "/api/notes", s.admin.id, { groupId: s.g.id, title: "Plan" });
    expect(byAdmin.json()).toMatchObject({ role: "editor", slug: "plan-2", permissions: { delete: true, managePublicLink: true, changeSlug: true } });
    // 群組範圍去重：同一人的個人筆記同名不佔群組的位子
    const personal = await call(app, "POST", "/api/notes", s.member.id, { title: "Plan" });
    expect(personal.json()).toMatchObject({ role: "owner", slug: "plan", groupId: null, group: null, permissions: ALL });
    expect((await noteState(db.$client, bare.json().id)).owner_id).toBeNull();
  });

  it("帶 content＋groupId（Q13 解除互斥）→ 過了 schema（無 collab 的 app 在部署閘門回 400 invalid_body，與個人建立同一道閘）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const res = await call(app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, content: "# Hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // 訊息是部署閘門那一句，不是 schema 的互斥訊息——互斥若還在，這裡會是「content 與 groupId 不可同時出現」。
    expect(res.json().error.message).toBe("此部署不支援帶內容建立筆記");
    // 帶 collab 的完整形在 note-create-content.test.ts 補一案（Step 7）
  });

  it("非成員／非成員站台 admin／群組不存在 → 404 group_not_found（三者逐位元組相同）；成員缺新建旗標 → 403 forbidden；非 UUID → 400", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const bodies = [
      await call(app, "POST", "/api/notes", s.outsider.id, { groupId: s.g.id }),
      await call(app, "POST", "/api/notes", s.siteAdmin.id, { groupId: s.g.id }),
      await call(app, "POST", "/api/notes", s.member.id, { groupId: "00000000-0000-4000-8000-00000000dead" }),
    ];
    for (const r of bodies) expect(r.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json().error.code).toBe("group_not_found");
    const reader = await call(app, "POST", "/api/notes", s.reader.id, { groupId: s.g.id });
    expect(reader.statusCode).toBe(403);
    expect(reader.json().error.code).toBe("forbidden");
    // 能編輯但沒有新建旗標 → 同樣 403：判準是 can_create，不是 can_edit（只讀角色分不出這兩者）。
    await setMemberRole(db, s.g.id, s.reader.id, await seedRole(db, s.g.id, "Editor", { canRead: true, canEdit: true }));
    const editorNoCreate = await call(app, "POST", "/api/notes", s.reader.id, { groupId: s.g.id });
    expect(editorNoCreate.statusCode).toBe(403);
    expect(editorNoCreate.json().error.code).toBe("forbidden");
    expect((await call(app, "POST", "/api/notes", s.member.id, { groupId: "nope" })).statusCode).toBe(400);
    expect(await db.select().from(notes).where(eq(notes.groupId, s.g.id))).toEqual([]);
  });

  it("成員檢查之後群組被刪（FK 23503）→ 404 group_not_found，沒有建出任何列", async () => {
    const holder: { db?: Db } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "membership-checked") return;
        await holder.db!.delete(groups).where(eq(groups.id, ctx.groupId!));
      },
    });
    holder.db = built.db;
    const s = await scene(built.db);
    const res = await call(built.app, "POST", "/api/notes", s.member.id, { groupId: s.g.id, title: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("group_not_found");
    expect(await built.db.select().from(notes).where(eq(notes.title, "x"))).toEqual([]);
  });
});

describe("#175 DELETE／shares／public-link 的新判準（§2.4 #15、#17–19、#22）", () => {
  it("DELETE：群組筆記看 permissions.delete（一般成員 403、非成員 404、管理員 204）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.member.id)).statusCode).toBe(403);
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.outsider.id)).statusCode).toBe(404);
    expect((await call(app, "DELETE", `/api/notes/${gn.id}`, s.admin.id)).statusCode).toBe(204);
    expect(await db.select().from(notes).where(eq(notes.id, gn.id))).toEqual([]);
  });

  it("shares 三支：群組筆記一律 403（manageShares 恆 false，連管理員也是）；RF2 殘留列 404；S5 窗——授權為個人 owner、之後被移進群組 → PUT 409 note_in_group、不留分享列", async () => {
    const state: MoverState = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({ groupTestHook: moverHook(() => holder.db!, state) });
    holder.db = built.db;
    const { app, db } = built;
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    for (const [method, url, payload] of [
      ["GET", `/api/notes/${gn.id}/shares`, undefined],
      ["PUT", `/api/notes/${gn.id}/shares`, { email: s.outsider.email, role: "viewer" }],
      ["DELETE", `/api/notes/${gn.id}/shares/${s.outsider.id}`, undefined],
    ] as const) {
      expect((await call(app, method, url, s.admin.id, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
    // RF2（gate r2 A-N7）：非成員拿著群組筆記上的殘留分享列（S5 破裂，DB 直塞）→ 404，與不存在的筆記逐位元組相同。
    await seedShare(db, gn.id, s.outsider.id, "editor");
    const leftover = await call(app, "PUT", `/api/notes/${gn.id}/shares`, s.outsider.id, { email: s.member.email, role: "viewer" });
    const missing = await call(app, "PUT", "/api/notes/00000000-0000-4000-8000-00000000dead/shares", s.outsider.id, { email: s.member.email, role: "viewer" });
    expect([leftover.statusCode, leftover.body]).toEqual([404, missing.body]);
    const mine = await seedNote(db, { ownerId: s.member.id });
    Object.assign(state, { point: "share-authorized", noteId: mine.id, groupId: s.g.id });
    const raced = await call(app, "PUT", `/api/notes/${mine.id}/shares`, s.member.id, { email: s.outsider.email, role: "editor" });
    expect(raced.statusCode).toBe(409);
    expect(raced.json().error.code).toBe("note_in_group");
    expect(await sharesOf(db, mine.id)).toEqual([]);
    // 交錯確實發生了：筆記此刻在群組裡（hook 沒觸發的話，PUT 會 200 而筆記仍是個人的）。
    expect((await noteState(db.$client, mine.id)).group_id).toBe(s.g.id);
  });

  it("public-link：群組筆記看 managePublicLink（一般成員 403、管理員 200）；別名 PUT 對群組筆記 400（不是 500）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id });
    expect((await call(app, "PUT", `/api/notes/${gn.id}/public-link`, s.member.id)).statusCode).toBe(403);
    const on = await call(app, "PUT", `/api/notes/${gn.id}/public-link`, s.admin.id);
    expect(on.statusCode).toBe(200);
    expect(on.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await noteState(db.$client, gn.id)).public_token).toBe(on.json().token);
    const alias = await call(app, "PUT", `/api/notes/${gn.id}/public-link/slug`, s.admin.id, { slug: "team-plan" });
    expect(alias.statusCode).toBe(400);
    expect((await noteState(db.$client, gn.id)).public_slug).toBeNull();
  });

  it("C13：token PUT 授權為個人 owner、之後被移進群組 → 409 conflict、token 沒被寫進群組筆記；C14 三方交錯：移動 → 群組重開 token → 過時的別名 PUT → 400", async () => {
    const state: MoverState = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({ groupTestHook: moverHook(() => holder.db!, state) });
    holder.db = built.db;
    const { app, db } = built;
    const s = await scene(db);
    const a = await seedNote(db, { ownerId: s.member.id });
    Object.assign(state, { point: "public-link-authorized", noteId: a.id, groupId: s.g.id });
    const put = await call(app, "PUT", `/api/notes/${a.id}/public-link`, s.member.id);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, a.id)).toMatchObject({ group_id: s.g.id, public_token: null });

    // C14 三方交錯：授權（個人 owner）→ 移進群組（token 清掉）→ 群組管理員重開 token → 過時的別名 PUT。
    // 舊述詞 `public_token IS NOT NULL` 在這一刻為真——沒有 `group_id IS NULL` 就撞 S11 CHECK → 500（gate r2 A-12）。
    const b = await seedNote(db, { ownerId: s.member.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, { noteId: b.id, reopenToken: "u".repeat(43) });
    const res = await call(app, "PUT", `/api/notes/${b.id}/public-link/slug`, s.member.id, { slug: "my-alias" });
    expect(res.statusCode).toBe(400);
    expect(await noteState(db.$client, b.id)).toMatchObject({ group_id: s.g.id, public_token: "u".repeat(43), public_slug: null });
  });
});

describe("#175 GET /api/notes/:id/backlinks 的群組來源（Task 3 review N-4：路由層接線）", () => {
  it("群組筆記連到個人筆記：成員看得到來源（groupId 有值、ownerHandle null）；只拿到目標分享的非成員看不到", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const target = await seedNote(db, { ownerId: s.member.id }, { title: "Target" });
    await seedShare(db, target.id, s.outsider.id, "viewer");
    const src = await seedNote(db, { groupId: s.g.id }, { title: "From group" });
    await db.insert(noteLinks).values({ sourceNoteId: src.id, targetNoteId: target.id });

    const byMember = await call(app, "GET", `/api/notes/${target.id}/backlinks`, s.member.id);
    expect(byMember.statusCode).toBe(200);
    expect(byMember.json().backlinks).toEqual([{ id: src.id, title: "From group", slug: src.slug, ownerHandle: null, groupId: s.g.id }]);

    const byOutsider = await call(app, "GET", `/api/notes/${target.id}/backlinks`, s.outsider.id);
    expect(byOutsider.statusCode).toBe(200);
    expect(byOutsider.json().backlinks).toEqual([]);
  });
});

describe("#186 PATCH /api/notes/:id：帶 title 一律要 permissions.edit（不論有沒有帶 slug）", () => {
  async function titleOf(db: Db, noteId: string) {
    const [r] = await db.select({ title: notes.title }).from(notes).where(eq(notes.id, noteId));
    return r!.title;
  }

  it("只有 managePublicLink（無 edit）的角色：只帶 slug → 200；slug＋title → 403 且 title／slug 未變；只帶 title → 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    await setMemberRole(db, s.g.id, s.reader.id, await seedRole(db, s.g.id, "LinkMgr", { canRead: true, canManagePublicLink: true }));
    const gn = await seedNote(db, { groupId: s.g.id }, { title: "Original" });

    const slugOnly = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: "linkmgr-slug" });
    expect(slugOnly.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("Original");
    expect((await noteState(db.$client, gn.id)).slug).toBe("linkmgr-slug");

    const both = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: "other-slug", title: "Hijacked" });
    expect(both.statusCode).toBe(403);
    expect(both.json().error.code).toBe("forbidden");
    expect(await titleOf(db, gn.id)).toBe("Original");
    expect((await noteState(db.$client, gn.id)).slug).toBe("linkmgr-slug");

    const nullSlugBoth = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { slug: null, title: "Hijacked" });
    expect(nullSlugBoth.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Original");

    const titleOnly = await call(app, "PATCH", `/api/notes/${gn.id}`, s.reader.id, { title: "Hijacked" });
    expect(titleOnly.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Original");
  });

  it("同時有 edit 與 changeSlug 的角色（內建管理員）帶 slug＋title → 200，兩者都寫入；只有 edit 的一般成員帶 slug → 403（不誤傷也不放寬）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id }, { title: "Original" });
    const ok = await call(app, "PATCH", `/api/notes/${gn.id}`, s.admin.id, { slug: "admin-slug", title: "Renamed" });
    expect(ok.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("Renamed");
    expect((await noteState(db.$client, gn.id)).slug).toBe("admin-slug");
    const memberSlug = await call(app, "PATCH", `/api/notes/${gn.id}`, s.member.id, { slug: "member-slug", title: "X" });
    expect(memberSlug.statusCode).toBe(403);
    expect(await titleOf(db, gn.id)).toBe("Renamed");
    const memberTitle = await call(app, "PATCH", `/api/notes/${gn.id}`, s.member.id, { title: "ByMember" });
    expect(memberTitle.statusCode).toBe(200);
    expect(await titleOf(db, gn.id)).toBe("ByMember");
  });

  it("個人筆記：owner 帶 slug＋title → 200；被分享的 editor 帶 title → 200、帶 slug → 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const pn = await seedNote(db, { ownerId: s.outsider.id }, { title: "Mine" });
    await seedShare(db, pn.id, s.member.id, "editor");
    const own = await call(app, "PATCH", `/api/notes/${pn.id}`, s.outsider.id, { slug: "mine-slug", title: "Mine 2" });
    expect(own.statusCode).toBe(200);
    expect(await titleOf(db, pn.id)).toBe("Mine 2");
    const ed = await call(app, "PATCH", `/api/notes/${pn.id}`, s.member.id, { title: "Edited" });
    expect(ed.statusCode).toBe(200);
    const edSlug = await call(app, "PATCH", `/api/notes/${pn.id}`, s.member.id, { slug: "x-slug", title: "Edited 2" });
    expect(edSlug.statusCode).toBe(403);
    expect(await titleOf(db, pn.id)).toBe("Edited");
  });
});
