/**
 * #175 PR2 T3（spec §6.3）：`POST /api/notes/:id/move`——個人筆記移進群組（功能面）。交錯案在 `groups-v2-move-race.test.ts`，
 * 真共編連線的踢線在 `groups-v2-revocation.test.ts` 檔尾。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { FastifyInstance } from "fastify";
import { validateSlug } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteLinks, noteRedirects, noteStates, uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sharesOf, spyCollabHooks } from "./group-helpers.js";

const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };

const move = async (app: FastifyInstance, noteId: string, userId: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

const get = async (app: FastifyInstance, url: string, userId: string) => app.inject({ method: "GET", url, cookies: await cookieOf(userId) });

describe("#175 PR2 POST /api/notes/:id/move（T3）", () => {
  it("個人筆記移進群組：200 新形 DTO；DB 清 shares／token／別名／prev、owner NULL、slug 與 slug_is_custom 不變、updated_at 不動；轉址恰一列；AI 紀錄／links／uploads／note_states 跟著 UUID", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    const [owner, c, admin] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true, prevSlug: "old", publicToken: "t".repeat(43), publicSlug: "alias" });
    const other = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, c.id, "editor");
    await db.insert(noteAiEdits).values({ noteId: n.id, userId: owner.id, op: "append" });
    await db.insert(noteLinks).values([{ sourceNoteId: n.id, targetNoteId: other.id }, { sourceNoteId: other.id, targetNoteId: n.id }]);
    const [up] = await db.insert(uploads).values({ noteId: n.id, uploaderId: owner.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    const before = await noteState(db.$client, n.id);

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: n.id, groupId: g.id, ownerId: null, ownerHandle: null, role: "editor", slug: "plan", slugIsCustom: true, prevSlug: null,
      group: { id: g.id, name: "G" }, permissions: MEMBER_PERMS,
    });
    expect(await noteState(db.$client, n.id)).toEqual({
      owner_id: null, group_id: g.id, slug: "plan", prev_slug: null, slug_is_custom: true, public_token: null, public_slug: null,
      updated_at: before.updated_at,
    });
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/n/${owner.handle}/plan`, noteId: n.id },
    ]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, n.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(eq(noteLinks.targetNoteId, n.id))).toHaveLength(1);
    expect(await db.select({ noteId: uploads.noteId }).from(uploads).where(eq(uploads.id, up!.id))).toEqual([{ noteId: n.id }]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, n.id))).toHaveLength(1);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = spy.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([n.id]);
    expect([...userIds].sort()).toEqual([c.id, owner.id].sort());
  });

  it("RF1：100 字元自訂 slug 在群組撞名 → ≤60、-2 結尾、slug_is_custom 仍 true、updated_at 不動、舊 /n/ 網址轉到它", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const base = "b".repeat(100);
    await seedNote(db, { groupId: g.id }, { slug: base });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: base, slugIsCustom: true });
    const before = await noteState(db.$client, n.id);

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    const expected = nextSlugCandidate(base, 2);
    expect(res.json().slug).toBe(expected);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
    expect(expected.endsWith("-2")).toBe(true);
    expect(validateSlug(expected)).toBeNull();
    // 撞名改了網址名（-2）也不動 updated_at——`docs/known-limitations.md`「**`list_notes` pages through live data, not a snapshot.**」條的「moving a note into a group can give it
    // a new URL name, but does not move it in this order」靠這條（案 1 是不撞名的形）；MCP `list_notes` 說明
    // （`LIST_NOTES_DESCRIPTION`）的同義句「a note moved into one of your groups … appear at their own unchanged
    // positions」也靠它。兩句都由 Task 6 寫入。
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: expected, slug_is_custom: true, group_id: g.id, updated_at: before.updated_at });
    const old = await get(app, `/api/notes/by-path/${owner.handle}/${base}`, owner.id);
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ id: n.id, groupId: g.id, slug: expected });
  });

  it("slug 撞名重試（note-move-slug-candidate）：探測之後、寫入之前群組裡冒出同名 → savepoint 回滾、重探測拿 -2；交易其餘部分照常 commit", async () => {
    const state: { candidates: string[] } = { candidates: [] };
    const holder: { groupId?: string; db?: Db } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "note-move-slug-candidate") return;
        state.candidates.push(ctx.slug!);
        // 另一條連線（pool）先 commit 一篇同 slug 的群組筆記——移動的 UPDATE 撞 notes_group_slug_idx。
        if (state.candidates.length === 1) await seedNote(holder.db!, { groupId: holder.groupId! }, { slug: ctx.slug! });
      },
    });
    const { app, db } = built;
    holder.db = db;
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    holder.groupId = g.id;
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true });
    await seedShare(db, n.id, c.id, "viewer");

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(state.candidates).toEqual(["plan", "plan-2"]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "plan-2", groupId: g.id });
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "plan-2", group_id: g.id, owner_id: null, slug_is_custom: true });
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(await db.select({ oldPath: noteRedirects.oldPath }).from(noteRedirects)).toEqual([{ oldPath: `/n/${owner.handle}/plan` }]);
  });

  it("RF5：移動後以大寫 handle 開舊網址 → 轉址命中 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true });
    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    const upper = await get(app, `/api/notes/by-path/${owner.handle.toUpperCase()}/plan`, owner.id);
    expect(owner.handle.toUpperCase()).not.toBe(owner.handle);
    expect(upper.statusCode).toBe(200);
    expect(upper.json()).toMatchObject({ id: n.id, groupId: g.id });
    const byGroup = await get(app, `/api/notes/by-group-path/${g.id}/plan`, owner.id);
    expect(byGroup.statusCode).toBe(200);
    expect(byGroup.json()).toMatchObject({ id: n.id, groupId: g.id });
  });

  it("公開連結當下失效：舊 token 的匿名讀取 404；移動不扣 publicLink 桶", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ publicLink: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) }) });
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const token = "p".repeat(43);
    const n = await seedNote(db, { ownerId: owner.id }, { publicToken: token });
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);

    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(404);
    const reopen = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(owner.id) });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().token).not.toBe(token);
  });

  it("授權：逐人分享 editor／viewer → 403 forbidden；陌生人 → 404 not_found；群組筆記（任何角色）→ 403；不存在的筆記 → 404", async () => {
    const { app, db } = await buildTestApp();
    const [owner, ed, vw, stranger, admin, member] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: ed.id, role: "member" }, { userId: vw.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, ed.id, "editor");
    await seedShare(db, n.id, vw.id, "viewer");
    const gn = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);

    for (const who of [ed, vw]) {
      const res = await move(app, n.id, who.id, { groupId: g.id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    const strangerRes = await move(app, n.id, stranger.id, { groupId: g.id });
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.json()).toEqual({ error: { code: "not_found", message: "找不到此筆記" } });
    for (const who of [admin, member]) {
      const res = await move(app, gn.id, who.id, { groupId: g.id });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    const missing = await move(app, "00000000-0000-4000-8000-000000000000", owner.id, { groupId: g.id });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(strangerRes.body);
    const badId = await move(app, "not-a-uuid", owner.id, { groupId: g.id });
    expect(badId.statusCode).toBe(404);
    expect(badId.body).toBe(strangerRes.body);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toHaveLength(2);
  });

  it("目標：非 UUID、不存在、非成員、成員但角色無 can_create → 404 group_not_found，四種 body 逐位元組相同；筆記原封不動", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const readOnly = await seedGroup(db, "ReadOnly", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, readOnly.id, "Reader", { canRead: true });
    await setMemberRole(db, readOnly.id, owner.id, reader);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", slugIsCustom: true, publicToken: "q".repeat(43) });
    await seedShare(db, n.id, c.id, "viewer");
    const before = await noteState(db.$client, n.id);

    const bodies: string[] = [];
    for (const groupId of ["not-a-uuid", "00000000-0000-4000-8000-00000000abcd", notMine.id, readOnly.id]) {
      const res = await move(app, n.id, owner.id, { groupId });
      expect(res.statusCode, groupId).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "viewer" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("body strict：多餘鍵 → 400 invalid_body；缺 groupId → 400；groupId 非字串 → 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    const before = await noteState(db.$client, n.id);
    for (const payload of [{ groupId: g.id, extra: 1 }, {}, { groupId: 42 }, { groupId: null }]) {
      const res = await move(app, n.id, owner.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await noteState(db.$client, n.id)).toEqual(before);
  });

  it("移動後 GET /api/notes：該篇落在群組分支（role editor、group 有值），owner 的個人分支沒有它", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    expect((await move(app, n.id, owner.id, { groupId: g.id })).statusCode).toBe(200);

    const list = (await get(app, "/api/notes", owner.id)).json() as Array<{ id: string; ownerId: string | null; role: string; group: unknown }>;
    const rows = list.filter(r => r.id === n.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: null, role: "editor", group: { id: g.id, name: "G" } });
  });

  it("create-only 角色（能新建、不能編輯）移入 → 200，回應 role viewer、permissions.edit false；onGroupAccessChanged 名單含 owner（重驗會把他的共編連線降為唯讀）", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    // 規格落差 17：PR3 的 0013 會 drop 這把 CHECK；PR2 單獨跑時本案自己拆（`IF EXISTS`：兩種 merge 順序都成立）。
    // 每個 buildTestApp 是獨立的新遷移資料庫，只影響本案。CHECK 沒拆掉時下一行 seedRole 會撞 23514 而紅（不會假綠）。
    await db.execute(sql`ALTER TABLE group_roles DROP CONSTRAINT IF EXISTS group_roles_create_needs_edit_chk`);
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const contributor = await seedRole(db, g.id, "Contributor", { canRead: true, canCreate: true });
    await setMemberRole(db, g.id, owner.id, contributor);
    const n = await seedNote(db, { ownerId: owner.id });

    const res = await move(app, n.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      groupId: g.id, ownerId: null, role: "viewer",
      permissions: { read: true, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    expect(spy.onGroupAccessChanged.mock.calls[0]).toEqual([[n.id], [owner.id]]);
    // 共編連線真的被降為唯讀（provider 拿到 viewer）由 groups-v2-revocation.test.ts 檔尾「create-only」案以真連線驗。
  });
});
