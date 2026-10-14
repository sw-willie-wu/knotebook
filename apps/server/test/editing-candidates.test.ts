import { describe, expect, it, vi } from "vitest";
import { buildCollabTestApp } from "./helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { visibleNoteTargets, visibleNoteTitles, visibleTitlesByIds } from "../src/notes/editing/candidates.js";

describe("visibleNoteTitles", () => {
  it("含自有與被分享的筆記，不含別人未分享的筆記", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "me@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "o@example.com", password: "correct-horse-battery" });
    const mine = await ctx.createNote(me.id, "Mine");
    const shared = await ctx.createNote(other.id, "Shared"); await ctx.share(shared.id, me.id, "viewer");
    await ctx.createNote(other.id, "Secret");
    const titles = (await visibleNoteTitles(ctx.db, me.id)).map(t => t.title).sort();
    expect(titles).toEqual(["Mine", "Shared"]);
    expect((await visibleNoteTitles(ctx.db, me.id)).map(t => t.id)).toContain(mine.id);
  });
});

describe("#269 visibleNoteTargets／visibleTitlesByIds", () => {
  it("可見清單帶 slug／groupId／ownerHandle（個人筆記的 handle 是 owner 的，不是讀者的）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "t-me@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "t-o@example.com", password: "correct-horse-battery" });
    const mine = await ctx.createNote(me.id, "Mine");
    const shared = await ctx.createNote(other.id, "Shared");
    await ctx.share(shared.id, me.id, "viewer");
    const targets = await visibleNoteTargets(ctx.db, me.id);
    const byId = new Map(targets.map(t => [t.id, t]));
    expect(byId.get(mine.id)).toMatchObject({ title: "Mine", groupId: null, ownerHandle: expect.any(String), slug: expect.any(String) });
    expect(byId.has(shared.id)).toBe(true);
    expect(byId.get(shared.id)?.ownerHandle).not.toBe(byId.get(mine.id)?.ownerHandle);
  });

  it("visibleTitlesByIds：只回 ids 裡、且讀者看得到的；空集合不發任何查詢；非 uuid 的 id 被濾掉（不撞 22P02）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await ctx.createUser({ email: "t-me2@example.com", password: "correct-horse-battery" });
    const other = await ctx.createUser({ email: "t-o2@example.com", password: "correct-horse-battery" });
    const a = await ctx.createNote(me.id, "A");
    const b = await ctx.createNote(me.id, "B");
    const secret = await ctx.createNote(other.id, "Secret");
    // 看得到但不在 ids 裡的：shared 支（被分享）與 grouped 支（可讀群組）各一篇——三支的 `idCond` 各有一篇守著（review r0 m1）。
    const sharedIn = await ctx.createNote(other.id, "SharedIn");
    await ctx.share(sharedIn.id, me.id, "viewer");
    const g = await seedGroup(ctx.db, "G", [{ userId: me.id, role: "member" }]);
    const groupNote = await seedNote(ctx.db, { groupId: g.id }, { title: "GN" });
    expect((await visibleTitlesByIds(ctx.db, me.id, [a.id, secret.id, "not-a-uuid"])).map(t => t.title)).toEqual(["A"]);
    expect((await visibleTitlesByIds(ctx.db, me.id, [b.id])).map(t => t.id)).toEqual([b.id]);
    // 前提：上兩句沒回的 SharedIn／GN 確實是我看得到的（不是因為看不到才沒回）。
    expect((await visibleNoteTargets(ctx.db, me.id)).map(t => t.id)).toEqual(expect.arrayContaining([sharedIn.id, groupNote.id]));
    const spy = vi.spyOn(ctx.db, "select");
    expect(await visibleTitlesByIds(ctx.db, me.id, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
