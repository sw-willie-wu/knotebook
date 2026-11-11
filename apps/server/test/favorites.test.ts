/**
 * #334 `GET /api/favorites`：只回呼叫者此刻看得見、不在垃圾桶的最愛，依加入時間新到舊（同一時間依 note id 由大到小）。
 * 紀錄直接寫進 `note_favorites`；失去讀取權與進垃圾桶只在讀取時濾掉，紀錄本身不動。
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers, noteFavorites, noteShares } from "../src/db/schema.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject, markRestored, markTrashed } from "./trash-helpers.js";

const list = async (app: FastifyInstance, userId: string): Promise<FavoriteDto[]> => {
  const res = await inject(app, "GET", "/api/favorites", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FavoriteDto[];
};
const listIds = async (app: FastifyInstance, userId: string) => (await list(app, userId)).map(f => f.noteId);

async function favorite(db: Db, userId: string, noteId: string, at?: Date): Promise<void> {
  await db.insert(noteFavorites).values({ userId, noteId, ...(at === undefined ? {} : { createdAt: at }) });
}
async function favoriteRows(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ noteId: noteFavorites.noteId }).from(noteFavorites).where(eq(noteFavorites.userId, userId));
  return rows.map(r => r.noteId).sort();
}

describe("GET /api/favorites：排序與回應形", () => {
  it("沒有任何最愛 → 200 []", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    expect(await list(app, alice.id)).toEqual([]);
  });

  it("依加入時間新到舊；favoritedAt 是毫秒精度的 ISO 字串、與存進去的時間相同", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    // id 與插入順序都刻意和時間順序不同：只有依時間排才會得到 a、c、b。
    const a = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000001" });
    const b = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000002" });
    const c = await seedNote(db, { ownerId: alice.id }, { id: "00000000-0000-4000-8000-000000000003" });
    const t0 = Date.parse("2026-01-01T00:00:00.123Z");
    await favorite(db, alice.id, a.id, new Date(t0 + 2000));
    await favorite(db, alice.id, b.id, new Date(t0));
    await favorite(db, alice.id, c.id, new Date(t0 + 1000));

    const got = await list(app, alice.id);
    expect(got).toEqual([
      { noteId: a.id, favoritedAt: new Date(t0 + 2000).toISOString() },
      { noteId: c.id, favoritedAt: new Date(t0 + 1000).toISOString() },
      { noteId: b.id, favoritedAt: new Date(t0).toISOString() },
    ]);
    for (const f of got) {
      expect(typeof f.favoritedAt).toBe("string");
      expect(new Date(f.favoritedAt).toISOString()).toBe(f.favoritedAt);
    }
  });

  it("加入時間相同的幾篇依 note id 由大到小（跨個人、共享、群組三種來源）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    // id 依插入順序遞增：不靠排序的話，表與各支的自然順序都是由小到大。
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const owned = [1, 4, 7].map(n => id(n));
    const shared = [2, 5].map(n => id(n));
    const grouped = [3, 6].map(n => id(n));
    for (const nid of owned) await seedNote(db, { ownerId: alice.id }, { id: nid });
    for (const nid of shared) {
      await seedNote(db, { ownerId: bob.id }, { id: nid });
      await seedShare(db, nid, alice.id, "viewer");
    }
    for (const nid of grouped) await seedNote(db, { groupId: g.id }, { id: nid });
    const same = new Date("2026-02-02T02:02:02.222Z");
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await favorite(db, alice.id, id(n), same);

    const got = await list(app, alice.id);
    expect(got.map(f => f.noteId)).toEqual([7, 6, 5, 4, 3, 2, 1].map(n => id(n)));
    expect(new Set(got.map(f => f.favoritedAt))).toEqual(new Set([same.toISOString()]));
  });

  it("個人、共享、群組筆記的最愛同時存在 → 三篇都回；同來源沒加入最愛的不回", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const mine = await seedNote(db, { ownerId: alice.id });
    const fromBob = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, fromBob.id, alice.id, "viewer");
    const inGroup = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, mine.id, new Date("2026-03-01T00:00:00.000Z"));
    await favorite(db, alice.id, fromBob.id, new Date("2026-03-02T00:00:00.000Z"));
    await favorite(db, alice.id, inGroup.id, new Date("2026-03-03T00:00:00.000Z"));
    // 每種來源各一篇看得見、但沒加入最愛的筆記：不能出現在清單裡。
    await seedNote(db, { ownerId: alice.id });
    const sharedOther = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, sharedOther.id, alice.id, "editor");
    await seedNote(db, { groupId: g.id });

    expect(await listIds(app, alice.id)).toEqual([inGroup.id, fromBob.id, mine.id]);
  });
});

describe("GET /api/favorites：只回自己的、此刻看得見的", () => {
  it("同群組的 alice 與 bob：alice 的最愛只出現在 alice 的清單", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, n.id);

    expect(await listIds(app, alice.id)).toEqual([n.id]);
    expect(await list(app, bob.id)).toEqual([]);
  });

  it("alice 與 bob 各自把同一篇加入最愛 → 各自的清單帶各自的加入時間", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const aliceAt = new Date("2026-06-06T06:06:06.111Z");
    const bobAt = new Date("2026-06-07T07:07:07.222Z");
    await favorite(db, alice.id, n.id, aliceAt);
    await favorite(db, bob.id, n.id, bobAt);

    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: aliceAt.toISOString() }]);
    expect(await list(app, bob.id)).toEqual([{ noteId: n.id, favoritedAt: bobAt.toISOString() }]);
  });

  it("撤銷分享 → 不回、紀錄仍在；重新分享 → 以原本的時間回來", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, n.id, alice.id, "viewer");
    const at = new Date("2026-04-04T04:04:04.444Z");
    await favorite(db, alice.id, n.id, at);
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);

    await db.delete(noteShares).where(and(eq(noteShares.noteId, n.id), eq(noteShares.userId, alice.id)));
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await seedShare(db, n.id, alice.id, "viewer");
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);
  });

  it("群組角色改成不能讀、或被移出群組 → 不回群組的筆記；兩種情況紀錄都還在", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    await favorite(db, alice.id, n.id);
    expect(await listIds(app, alice.id)).toEqual([n.id]);

    const noRead = await seedRole(db, g.id, "no-read", { canRead: false });
    await setMemberRole(db, g.id, alice.id, noRead);
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await setMemberRole(db, g.id, alice.id, g.memberRoleId);
    expect(await listIds(app, alice.id)).toEqual([n.id]);

    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, alice.id)));
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
  });

  it("移到垃圾桶 → 不回、紀錄仍在；還原 → 回來、時間不變", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const at = new Date("2026-05-05T05:05:05.555Z");
    await favorite(db, alice.id, n.id, at);

    await markTrashed(db.$client, n.id, alice.id);
    expect(await list(app, alice.id)).toEqual([]);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);

    await markRestored(db.$client, n.id);
    expect(await list(app, alice.id)).toEqual([{ noteId: n.id, favoritedAt: at.toISOString() }]);
  });
});

describe("GET /api/favorites：只收 cookie", () => {
  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/favorites" });
    expect(res.statusCode, res.body).toBe(401);
  });

  it("只帶 Bearer token、沒有 cookie → 401", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await favorite(db, alice.id, n.id);
    const { token } = await seedTokenForUser(db, alice.id);
    const res = await app.inject({ method: "GET", url: "/api/favorites", headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(401);
  });
});
