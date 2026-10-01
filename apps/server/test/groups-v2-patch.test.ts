/**
 * #175 PATCH（§6.2 row 12、§4.3、C15、RF5、規格落差 9）。轉址列用 seedRedirect 直插（PR1 沒有寫轉址的生產路徑）；
 * 「移進群組」以 SQL 模擬 PR2 的移動。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { noteRedirects, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SlugPatchTestHook } from "../src/notes/tx/patch-slug.js";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, noteState, seedGroup, seedNote, seedRedirect, seedRole, seedShare, seedUser, setMemberRole, waitForBlockedOrSettled,
} from "./group-helpers.js";

async function patch(app: FastifyInstance, noteId: string, userId: string, payload: object) {
  return app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: await cookieOf(userId), payload });
}
async function byPath(app: FastifyInstance, handle: string, slug: string, userId: string) {
  return app.inject({ method: "GET", url: `/api/notes/by-path/${handle}/${slug}`, cookies: await cookieOf(userId) });
}
async function redirectRow(db: Db, oldPath: string) {
  return (await db.select().from(noteRedirects).where(eq(noteRedirects.oldPath, oldPath)))[0];
}

describe("#175 PATCH 的權限（§2.4 #12、Q11）", () => {
  it("群組：只讀角色改標題 403、一般成員改標題 200 但改 slug 403、管理員改 slug 200；個人：editor 改 slug 403、owner 200", async () => {
    const { app, db } = await buildTestApp();
    const [admin, member, reader, owner, editor] = await Promise.all(Array.from({ length: 5 }, () => seedUser(db)));
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: reader.id, role: "member" }]);
    await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "Reader", { canRead: true }));
    const gn = await seedNote(db, { groupId: g.id });
    expect((await patch(app, gn.id, reader.id, { title: "x" })).statusCode).toBe(403);
    expect((await patch(app, gn.id, member.id, { title: "Member Title" })).json()).toMatchObject({ title: "Member Title", ownerHandle: null, groupId: g.id, role: "editor" });
    expect((await patch(app, gn.id, member.id, { slug: "custom" })).statusCode).toBe(403);
    expect((await patch(app, gn.id, admin.id, { slug: "custom" })).json()).toMatchObject({ slug: "custom", slugIsCustom: true, groupId: g.id });
    const mine = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, mine.id, editor.id, "editor");
    expect((await patch(app, mine.id, editor.id, { slug: "nope" })).statusCode).toBe(403);
    expect((await patch(app, mine.id, owner.id, { slug: "yes" })).json()).toMatchObject({ slug: "yes", ownerHandle: owner.handle });
  });

  it("RF5：群組 editor 改標題的 auto slug 在**群組**範圍去重——同人個人筆記同名不加 -2；同群組另一篇同名加 -2；撞 notes_group_slug_idx 的真競態重試成功", async () => {
    const holder: { db?: Db; groupId?: string; armed?: boolean } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async candidate => {
        if (!holder.armed) return;
        holder.armed = false; // 只搶插一次：讓第一輪 UPDATE 撞 notes_group_slug_idx
        await holder.db!.insert(notes).values({ groupId: holder.groupId!, title: "racer", slug: candidate });
      },
    });
    Object.assign(holder, { db: built.db });
    const { app, db } = built;
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: member.id, role: "member" }]);
    holder.groupId = g.id;
    await seedNote(db, { ownerId: member.id }, { slug: "roadmap" });
    const a = await seedNote(db, { groupId: g.id });
    expect((await patch(app, a.id, member.id, { title: "Roadmap" })).json().slug).toBe("roadmap");
    const b = await seedNote(db, { groupId: g.id });
    expect((await patch(app, b.id, member.id, { title: "Roadmap" })).json().slug).toBe("roadmap-2");
    const c = await seedNote(db, { groupId: g.id });
    holder.armed = true;
    const raced = await patch(app, c.id, member.id, { title: "Roadmap" });
    expect(raced.statusCode).toBe(200);
    expect(raced.json().slug).toBe("roadmap-4"); // roadmap-3 被搶插者佔走，重探測後落在 -4
  });

  it("群組筆記的自訂 slug 撞同群組另一篇 → 409 slug_taken（認 notes_group_slug_idx）；撞別的群組或個人筆記同名不算", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: admin.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "taken", slugIsCustom: true });
    await seedNote(db, { groupId: h.id }, { slug: "elsewhere", slugIsCustom: true });
    await seedNote(db, { ownerId: admin.id }, { slug: "mine", slugIsCustom: true });
    const n = await seedNote(db, { groupId: g.id });
    const clash = await patch(app, n.id, admin.id, { slug: "taken" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("slug_taken");
    expect((await patch(app, n.id, admin.id, { slug: "elsewhere" })).json()).toMatchObject({ slug: "elsewhere", groupId: g.id });
    expect((await patch(app, n.id, admin.id, { slug: "mine" })).json()).toMatchObject({ slug: "mine", groupId: g.id });
  });

  it("規格落差 9（Q22 套在格 2）：授權之後、UPDATE 之前被移進群組 → 回應的 role／permissions 以重算的群組 access 組", async () => {
    const holder: { db?: Db; noteId?: string; groupId?: string } = {};
    const built = await buildTestApp({
      slugUpdateTestHook: async () => {
        if (!holder.noteId) return;
        const noteId = holder.noteId;
        holder.noteId = undefined;
        await holder.db!.update(notes).set({ ownerId: null, groupId: holder.groupId! }).where(eq(notes.id, noteId));
      },
    });
    holder.db = built.db;
    const { app, db } = built;
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id });
    Object.assign(holder, { noteId: n.id, groupId: g.id });
    const res = await patch(app, n.id, u.id, { title: "Moved Meanwhile" });
    expect(res.statusCode).toBe(200);
    // 授權時是 owner（OWNER_PERMISSIONS）；落地時已是群組筆記、u 的角色是內建一般成員（無刪除／公開連結旗標）。
    expect(res.json()).toMatchObject({
      title: "Moved Meanwhile",
      groupId: g.id,
      ownerHandle: null,
      role: "editor",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false },
    });
  });
});

describe("#175 T1：寫 prev 時刪同路徑轉址（B4、C15）", () => {
  it("R1（gate r3 A-6）：N1 移進群組留下 /n/h/c15 轉址；N2 取 c15 再自訂改名 → prev=c15 且轉址被刪 → /n/h/c15 解到 N2", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "c15", slugIsCustom: true });
    await seedRedirect(db, `/n/${u.handle}/c15`, n1.id);
    const n2 = await seedNote(db, { ownerId: u.id });
    expect((await patch(app, n2.id, u.id, { slug: "c15" })).statusCode).toBe(200); // 活網址勝轉址
    expect(await redirectRow(db, `/n/${u.handle}/c15`)).toBeDefined(); // auto→custom 不寫 prev、不刪
    expect((await patch(app, n2.id, u.id, { slug: "c15b" })).json().prevSlug).toBe("c15");
    expect(await redirectRow(db, `/n/${u.handle}/c15`)).toBeUndefined();
    expect((await byPath(app, u.handle, "c15", u.id)).json().id).toBe(n2.id);
  });

  it("群組 scope 不刪轉址（§4.3：DELETE 只在個人 scope 發）：管理員把群組筆記的自訂 slug 改掉 → prev 寫入，但 /n/<管理員>/<舊 slug> 的轉址仍在", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id }, { slug: "gold", slugIsCustom: true });
    const mine = await seedNote(db, { ownerId: admin.id });
    await seedRedirect(db, `/n/${admin.handle}/gold`, mine.id);
    expect((await patch(app, gn.id, admin.id, { slug: "gold2" })).json()).toMatchObject({ slug: "gold2", prevSlug: "gold", groupId: g.id });
    expect(await redirectRow(db, `/n/${admin.handle}/gold`)).toMatchObject({ noteId: mine.id });
  });

  it("R2（gate r3 A-7 誤刪反例）：舊列是 auto、prev 原樣保留時不刪較新的轉址", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n3 = await seedNote(db, { ownerId: u.id }, { slug: "auto3", prevSlug: "pp" });
    const n4 = await seedNote(db, { groupId: g.id }, { slug: "pp" });
    await seedRedirect(db, `/n/${u.handle}/pp`, n4.id);
    expect((await patch(app, n3.id, u.id, { slug: "r3" })).json().prevSlug).toBe("pp"); // CASE：舊列 auto → prev 不變
    expect(await redirectRow(db, `/n/${u.handle}/pp`)).toBeDefined();
    expect((await byPath(app, u.handle, "pp", u.id)).json().id).toBe(n4.id);
  });

  it("並發（gate r4 M-2、r5 N-5）：A 把 N 改成自訂 foo 並持列鎖；B 改成 bar 被擋；A commit 後 B 讀到被覆寫的 custom 版 → prev=foo、刪 /n/h/foo", async () => {
    const state: { noteId?: string; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { app?: FastifyInstance; db?: Db; userId?: string } = {};
    const hook: SlugPatchTestHook = async (point, ctx) => {
      if (point !== "slug-written" || ctx.noteId !== state.noteId || state.second) return;
      state.second = patch(holder.app!, state.noteId!, holder.userId!, { slug: "bar" });
      state.interleave = await waitForBlockedOrSettled(holder.db!.$client, state.second);
    };
    const built = await buildTestApp({ slugPatchTestHook: hook });
    Object.assign(holder, { app: built.app, db: built.db });
    const { app, db } = built;
    const u = await seedUser(db);
    holder.userId = u.id;
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "a0" });
    const other = await seedNote(db, { groupId: g.id });
    await seedRedirect(db, `/n/${u.handle}/foo`, other.id);
    state.noteId = n.id;
    expect((await patch(app, n.id, u.id, { slug: "foo" })).statusCode).toBe(200);
    const b = await state.second!;
    expect(state.interleave).toBe("blocked");
    expect(b.json()).toMatchObject({ slug: "bar", prevSlug: "foo" });
    expect(await redirectRow(db, `/n/${u.handle}/foo`)).toBeUndefined();
    expect((await byPath(app, u.handle, "foo", u.id)).json().id).toBe(n.id);
  });

  it("授權後被移進群組（gate r5 M-2，C15 移入交錯）→ 409 conflict；slug 不寫、移動留下的轉址保留；授權後被刪 → 404", async () => {
    const state: { noteId?: string; groupId?: string; handle?: string; mode?: "move" | "delete" } = {};
    const holder: { db?: Db } = {};
    const built = await buildTestApp({
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId) return;
        if (state.mode === "delete") {
          await holder.db!.delete(notes).where(eq(notes.id, state.noteId!));
          return;
        }
        await holder.db!.update(notes).set({ ownerId: null, groupId: state.groupId!, prevSlug: null }).where(eq(notes.id, state.noteId!));
        await holder.db!.insert(noteRedirects).values({ oldPath: `/n/${state.handle}/baz`, noteId: state.noteId!, expiresAt: new Date(Date.now() + 86_400_000) });
      },
    });
    holder.db = built.db;
    const { app, db } = built;
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, groupId: g.id, handle: u.handle, mode: "move" });
    const res = await patch(app, n.id, u.id, { slug: "qux" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "baz", group_id: g.id });
    expect(await redirectRow(db, `/n/${u.handle}/baz`)).toBeDefined();
    const gone = await seedNote(db, { ownerId: u.id }, { slugIsCustom: true });
    Object.assign(state, { noteId: gone.id, mode: "delete" });
    expect((await patch(app, gone.id, u.id, { slug: "zz" })).statusCode).toBe(404);
  });
});
