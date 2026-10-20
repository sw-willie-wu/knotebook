/**
 * #297 公開頁寬度：`PUT /api/notes/:id/public-width`（權限同公開連結、自己的速率桶、C13 歸屬述詞）與公開端點回 `width`。
 * public-link 三支回應帶 `width`、DELETE 不重設在 `public-share.test.ts`；移動／轉移保留寬度在 `groups-v2-move`／`groups-v2-delete`。
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Db } from "../src/db/index.js";
import { notes } from "../src/db/schema.js";
import { FixedWindowLimiter, PUBLIC_WIDTH_LIMIT } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, spyCollabHooks } from "./group-helpers.js";

const put = async (app: FastifyInstance, id: string, userId: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/notes/${id}/public-width`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

const widthOf = async (db: Db, id: string): Promise<string | undefined> =>
  (await db.select({ w: notes.publicWidth }).from(notes).where(eq(notes.id, id)).limit(1))[0]?.w;

const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });

const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });

const CONFLICT_BODY = { error: { code: "conflict", message: "筆記的歸屬已變更，請重新整理後再試" } };

describe("#297 PUT /api/notes/:id/public-width", () => {
  it("W1 owner 個人筆記（未公開）→ 200 { width }、落地；token 仍 null、updated_at 不動", async () => {
    const { app, db } = await buildTestApp();
    const [owner, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedNote(db, { ownerId: owner.id });
    // 述詞要含 note id：同 owner 的另一篇、別人的個人筆記都必須不被改到。
    const sibling = await seedNote(db, { ownerId: owner.id });
    const foreign = await seedNote(db, { ownerId: other.id });
    const before = await noteState(db.$client, n.id);

    const res = await put(app, n.id, owner.id, { width: "wide" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ width: "wide" });
    expect(await widthOf(db, n.id)).toBe("wide");
    expect(await widthOf(db, sibling.id)).toBe("standard");
    expect(await widthOf(db, foreign.id)).toBe("standard");
    expect(await noteState(db.$client, n.id)).toMatchObject({ public_token: null, updated_at: before.updated_at });
  });

  it("W2 權限同公開連結：群組內建管理員／有 canManagePublicLink 的自訂角色 200；一般成員 403；非成員 404 與不存在的 id 同形；被分享的 viewer 403", async () => {
    const { app, db } = await buildTestApp();
    const [admin, pl, member, outsider, owner, viewer] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: pl.id, role: "member" }, { userId: member.id, role: "member" }]);
    const role = await seedRole(db, g.id, "pl", { canRead: true, canManagePublicLink: true });
    await setMemberRole(db, g.id, pl.id, role);
    const gn = await seedNote(db, { groupId: g.id });
    const gSibling = await seedNote(db, { groupId: g.id }); // 同群組另一篇：不得被改到

    const byAdmin = await put(app, gn.id, admin.id, { width: "wide" });
    expect(byAdmin.statusCode).toBe(200);
    expect(await widthOf(db, gn.id)).toBe("wide");
    const byPl = await put(app, gn.id, pl.id, { width: "full" });
    expect(byPl.statusCode).toBe(200);
    expect(await widthOf(db, gn.id)).toBe("full");
    expect(await widthOf(db, gSibling.id)).toBe("standard");

    const byMember = await put(app, gn.id, member.id, { width: "standard" });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().error.code).toBe("forbidden");
    const byOutsider = await put(app, gn.id, outsider.id, { width: "standard" });
    expect(byOutsider.statusCode).toBe(404);
    expect(byOutsider.json().error.code).toBe("not_found");
    const missing = await put(app, randomUUID(), outsider.id, { width: "standard" });
    expect(missing.statusCode).toBe(404);
    expect(byOutsider.body).toBe(missing.body);
    expect(await widthOf(db, gn.id)).toBe("full");

    const pn = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, pn.id, viewer.id, "viewer");
    const byViewer = await put(app, pn.id, viewer.id, { width: "wide" });
    expect(byViewer.statusCode).toBe(403);
    expect(byViewer.json().error.code).toBe("forbidden");
    expect(await widthOf(db, pn.id)).toBe("standard");
  });

  it("W3 body strict：缺鍵／壞值／未知鍵／非字串 → 400 invalid_body、DB 不變；陌生人送壞 body 也是 400（先解析 body）", async () => {
    const { app, db } = await buildTestApp();
    const [owner, stranger] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedNote(db, { ownerId: owner.id });
    for (const body of [{}, { width: "huge" }, { width: "full", x: 1 }, { width: 1 }]) {
      const res = await put(app, n.id, owner.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code, JSON.stringify(body)).toBe("invalid_body");
    }
    expect(await widthOf(db, n.id)).toBe("standard");
    const s = await put(app, n.id, stranger.id, { width: "huge" });
    expect(s.statusCode).toBe(400);
    expect(s.json().error.code).toBe("invalid_body");
  });

  it("W4 授權之後筆記被刪 → 404 not_found", async () => {
    const state: { noteId?: string; db?: Db; fired?: boolean } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId) return;
        state.fired = true;
        await state.db!.delete(notes).where(eq(notes.id, ctx.noteId!));
      },
    });
    state.db = db;
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    state.noteId = n.id;

    const res = await put(app, n.id, owner.id, { width: "full" });

    expect(state.fired).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("W5 C13：授權之後筆記被移進群組 → 409 conflict；寬度沒寫進去", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    Object.assign(state, { noteId: n.id, fire: () => move(app, n.id, owner.id, g.id) });

    const res = await put(app, n.id, owner.id, { width: "full" });

    expect(state.moved!.statusCode).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(CONFLICT_BODY);
    expect(await widthOf(db, n.id)).toBe("standard");
    expect(await noteState(db.$client, n.id)).toMatchObject({ group_id: g.id });
  });

  it("W6 C13 反向：授權之後群組被轉移給個人 → 409 conflict；寬度沒寫進去", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const { app, db } = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    Object.assign(state, { noteId: n.id, fire: () => transfer(app, g.id, a.id, a.id) });

    const res = await put(app, n.id, a.id, { width: "full" });

    expect(state.moved!.statusCode).toBe(204);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(CONFLICT_BODY);
    expect(await widthOf(db, n.id)).toBe("standard");
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null });
  });

  it("W7 公開端點兩形都回 width：設過的值；沒設過 → standard", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const T = "w".repeat(43);
    const U = "s".repeat(43);
    await seedNote(db, { ownerId: owner.id }, { publicToken: T, publicSlug: "w", publicWidth: "full" });
    await seedNote(db, { ownerId: owner.id }, { publicToken: U });

    for (const url of [`/api/public/notes/${T}`, `/api/public/notes/${owner.handle}/w`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().width, url).toBe("full");
    }
    const plain = await app.inject({ method: "GET", url: `/api/public/notes/${U}` });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().width).toBe("standard");
  });
});

describe("#297 publicWidth 速率桶", () => {
  it("R1 60 次／10 分鐘、與 publicLink 分開：第 61 次 429；之後 DELETE public-link 仍 204", async () => {
    expect(PUBLIC_WIDTH_LIMIT).toEqual({ limit: 60, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ publicLink: new FixedWindowLimiter({ limit: 1, windowMs: 600_000 }) }) });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id }, { publicToken: "p".repeat(43) });
    for (let i = 0; i < 60; i += 1) {
      const res = await put(app, n.id, owner.id, { width: i % 2 ? "wide" : "full" });
      expect(res.statusCode, `#${i + 1}`).toBe(200);
    }
    const over = await put(app, n.id, owner.id, { width: "standard" });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");

    const del = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(owner.id) });
    expect(del.statusCode).toBe(204);
  });

  it("R2 不扣桶：陌生人的 404、viewer 的 403、壞 body 的 400 各 61 次之後，三人改自己的筆記仍 200", async () => {
    const { app, db } = await buildTestApp();
    const [owner, stranger, viewer] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, viewer.id, "viewer");
    for (let i = 0; i < 61; i += 1) {
      expect((await put(app, n.id, stranger.id, { width: "wide" })).statusCode, `stranger #${i + 1}`).toBe(404);
      expect((await put(app, n.id, viewer.id, { width: "wide" })).statusCode, `viewer #${i + 1}`).toBe(403);
      expect((await put(app, n.id, owner.id, { width: "huge" })).statusCode, `owner #${i + 1}`).toBe(400);
    }
    for (const u of [stranger, viewer, owner]) {
      const own = await seedNote(db, { ownerId: u.id });
      expect((await put(app, own.id, u.id, { width: "full" })).statusCode).toBe(200);
    }
  });
});
