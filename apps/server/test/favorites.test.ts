/**
 * #334 最愛 REST。
 *
 * - `GET /api/favorites`：只回呼叫者此刻看得見、不在垃圾桶的最愛，依加入時間新到舊（同一時間依 note id 由大到小）。
 *   這幾案的紀錄直接寫進 `note_favorites`；失去讀取權與進垃圾桶只在讀取時濾掉，紀錄本身不動。
 * - `PUT /api/favorites/:id`（加入）與 `DELETE /api/favorites/:id`（移出）：404 的幾種來源逐位元組相同、
 *   重複加入保留原時間、移出恆 204 且只動呼叫者自己那列、共用 `favorite` 節流桶。
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers, noteFavorites, notes, noteShares } from "../src/db/schema.js";
import { addFavorite } from "../src/favorites/queries.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
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

// ───────────────────────────── PUT／DELETE ─────────────────────────────

const NOT_FOUND_BODY = '{"error":{"code":"not_found","message":"No note with that id."}}';
const INVALID_BODY = { error: { code: "invalid_body", message: "Invalid request body." } };
const TOO_MANY = { error: { code: "too_many_requests", message: "Too many requests. Wait a moment and try again." } };

const put = (app: FastifyInstance, userId: string | null, id: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  inject(app, "PUT", `/api/favorites/${id}`, userId, payload);
const del = (app: FastifyInstance, userId: string | null, id: string): Promise<LightMyRequestResponse> =>
  inject(app, "DELETE", `/api/favorites/${id}`, userId);

/** 表裡的列（全部使用者）；`at` 是 UTC、微秒精度的文字，看得出有沒有截到毫秒。 */
async function storedRows(db: Db): Promise<Array<{ user_id: string; note_id: string; at: string }>> {
  const { rows } = await db.$client.query<{ user_id: string; note_id: string; at: string }>(
    `select user_id::text, note_id::text, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as at
       from note_favorites order by user_id, note_id`,
  );
  return rows;
}
/** 微秒精度的 UTC 文字 → 毫秒 ISO（只在微秒尾數是 000 時與 `toISOString()` 相同）。 */
const usToIso = (at: string): string => `${at.slice(0, 23)}Z`;

describe("PUT /api/favorites/:id：加入", () => {
  it("加入自己的筆記 → 200 { noteId, favoritedAt }，存成毫秒精度；再加一次（帶 `{}` 也一樣）→ 同一個字串、表中仍一列", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const first = await put(app, alice.id, n.id);
    expect(first.statusCode, first.body).toBe(200);
    const dto = first.json() as FavoriteDto;
    expect(Object.keys(dto).sort()).toEqual(["favoritedAt", "noteId"]);
    expect(dto.noteId).toBe(n.id);
    expect(new Date(dto.favoritedAt).toISOString()).toBe(dto.favoritedAt);
    const rows = await storedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at.endsWith("000"), rows[0]!.at).toBe(true);
    expect(usToIso(rows[0]!.at)).toBe(dto.favoritedAt);

    const again = await put(app, alice.id, n.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(dto);
    const withEmptyBody = await put(app, alice.id, n.id, {});
    expect(withEmptyBody.statusCode, withEmptyBody.body).toBe(200);
    expect(withEmptyBody.json()).toEqual(dto);
    expect(await storedRows(db)).toEqual(rows);
    expect(await list(app, alice.id)).toEqual([dto]);
  });

  it("逐人分享的 viewer、群組裡只能讀的成員都能加入", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const shared = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, shared.id, alice.id, "viewer");
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const readOnly = await seedRole(db, g.id, "reader", { canRead: true });
    await setMemberRole(db, g.id, alice.id, readOnly);
    const inGroup = await seedNote(db, { groupId: g.id });

    for (const id of [shared.id, inGroup.id]) {
      const res = await put(app, alice.id, id);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as FavoriteDto).noteId).toBe(id);
    }
    expect(await favoriteRows(db, alice.id)).toEqual([shared.id, inGroup.id].sort());
  });

  it("不存在、別人沒分享的、自己在垃圾桶裡的、群組裡讀不到的、非 UUID 的 :id → 404，五者 body 逐位元組相同，表中沒有新列", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const bobs = await seedNote(db, { ownerId: bob.id });
    const trashed = await seedNote(db, { ownerId: alice.id });
    await markTrashed(db.$client, trashed.id, alice.id);
    const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const noRead = await seedRole(db, g.id, "no-read", { canRead: false });
    await setMemberRole(db, g.id, alice.id, noRead);
    const unreadableGroupNote = await seedNote(db, { groupId: g.id });

    for (const id of [randomUUID(), bobs.id, trashed.id, unreadableGroupNote.id, "not-a-uuid"]) {
      const res = await put(app, alice.id, id);
      expect(res.statusCode, `${id} ${res.body}`).toBe(404);
      expect(res.body, id).toBe(NOT_FOUND_BODY);
    }
    // 非 UUID 先於 body 檢查：壞 body 仍是同一個 404。
    const badIdBadBody = await put(app, alice.id, "not-a-uuid", { extra: 1 });
    expect(badIdBadBody.statusCode).toBe(404);
    expect(badIdBadBody.body).toBe(NOT_FOUND_BODY);
    expect(await storedRows(db)).toEqual([]);
  });

  it("大寫 UUID 的 :id → 200，存進去與回傳的 noteId 都是小寫", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const res = await put(app, alice.id, n.id.toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as FavoriteDto).noteId).toBe(n.id);
    expect((await storedRows(db)).map(r => r.note_id)).toEqual([n.id]);
  });

  it("沒有 body（也沒有 Content-Type）的 PUT → 加入時間是現在、存成整毫秒", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    // 五篇：pg 的 now() 剛好落在整毫秒的機率約千分之一，五篇都剛好的機率可以忽略——沒截到毫秒就一定看得出來。
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedNote(db, { ownerId: alice.id })).id);

    const before = Date.now();
    const got = new Map<string, string>();
    for (const id of ids) {
      const res = await app.inject({ method: "PUT", url: `/api/favorites/${id}`, cookies: await cookieOf(alice.id) });
      expect(res.statusCode, res.body).toBe(200);
      got.set(id, (res.json() as FavoriteDto).favoritedAt);
    }
    const after = Date.now();

    const rows = await storedRows(db);
    expect(rows.map(r => r.note_id).sort()).toEqual([...ids].sort());
    for (const r of rows) {
      expect(r.at.endsWith("000"), r.at).toBe(true);
      expect(usToIso(r.at)).toBe(got.get(r.note_id));
      // 資料庫與測試程序共用同一個時鐘；留 1 秒寬容。
      const t = Date.parse(got.get(r.note_id)!);
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(after + 1000);
    }
    // 毫秒有保留：只截到秒的話五篇都會是 `.000000`（五篇都剛好落在整秒的機率可以忽略）。
    expect(rows.some(r => !r.at.endsWith(".000000")), rows.map(r => r.at).join(" ")).toBe(true);
  });

  it("帶了 body 但不是空物件（任何欄位、陣列、JSON null）→ 400 invalid_body，不寫入；`{}` → 200", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const bad: unknown[] = [{ extra: 1 }, { favoritedAt: "2026-01-01T00:00:00.000Z" }, { favoritedAt: null }, []];
    for (const payload of bad) {
      const res = await put(app, alice.id, n.id, payload);
      expect(res.statusCode, `${JSON.stringify(payload)} ${res.body}`).toBe(400);
      expect(res.json()).toEqual(INVALID_BODY);
    }
    const nullBody = await app.inject({
      method: "PUT",
      url: `/api/favorites/${n.id}`,
      cookies: await cookieOf(alice.id),
      headers: { "content-type": "application/json" },
      payload: "null",
    });
    expect(nullBody.statusCode, nullBody.body).toBe(400);
    expect(nullBody.json()).toEqual(INVALID_BODY);
    expect(await storedRows(db)).toEqual([]);

    const empty = await put(app, alice.id, n.id, {});
    expect(empty.statusCode, empty.body).toBe(200);
    expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
  });

  it("授權之後、寫入之前筆記被永久刪除 → 404（同一個 body）、不寫入、沒有 error log；縫裡不刪 → 200", async () => {
    for (const purgeInSeam of [true, false]) {
      const points: GroupRacePoint[] = [];
      const seam: { db?: Db; target?: string } = {};
      const logs = captureLogs();
      const { app, db } = await buildTestApp(
        {
          groupTestHook: async (point, ctx) => {
            points.push(point);
            if (point === "favorite-authorized" && purgeInSeam) {
              expect(ctx.noteId).toBe(seam.target);
              await seam.db!.delete(notes).where(eq(notes.id, seam.target!));
            }
          },
        },
        logs.options,
      );
      seam.db = db;
      const alice = await seedUser(db, { displayName: "Alice" });
      const n = await seedNote(db, { ownerId: alice.id });
      seam.target = n.id;

      const res = await put(app, alice.id, n.id);
      expect(points, String(purgeInSeam)).toEqual(["favorite-authorized"]);
      if (purgeInSeam) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.body).toBe(NOT_FOUND_BODY);
        expect(await storedRows(db)).toEqual([]);
      } else {
        expect(res.statusCode, res.body).toBe(200);
        expect(await favoriteRows(db, alice.id)).toEqual([n.id]);
      }
      expect(logs.lines.filter(l => l.level === "error" || l.level === "fatal")).toEqual([]);
      await app.close();
    }
  });

  it("addFavorite 對不存在的筆記 → \"gone\"（不丟例外）", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    expect(await addFavorite(db, { userId: alice.id, noteId: randomUUID() })).toBe("gone");
    expect(await storedRows(db)).toEqual([]);
  });
});

describe("DELETE /api/favorites/:id：移出", () => {
  it("自己有的 → 204、列消失；沒有的 → 204；同一篇 bob 的列不動；讀不到的筆記（撤分享後）→ 204、列消失；非 UUID → 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const both = await seedNote(db, { groupId: g.id });
    const mine = await seedNote(db, { ownerId: alice.id });
    const fromBob = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, fromBob.id, alice.id, "viewer");
    for (const id of [both.id, mine.id, fromBob.id]) expect((await put(app, alice.id, id)).statusCode).toBe(200);
    expect((await put(app, bob.id, both.id)).statusCode).toBe(200);

    const r1 = await del(app, alice.id, both.id);
    expect(r1.statusCode, r1.body).toBe(204);
    expect(r1.body).toBe("");
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id, fromBob.id].sort());
    expect(await favoriteRows(db, bob.id)).toEqual([both.id]);

    const r2 = await del(app, alice.id, both.id);
    expect(r2.statusCode, r2.body).toBe(204);
    const never = await del(app, alice.id, randomUUID());
    expect(never.statusCode, never.body).toBe(204);

    await db.delete(noteShares).where(and(eq(noteShares.noteId, fromBob.id), eq(noteShares.userId, alice.id)));
    const unreadable = await del(app, alice.id, fromBob.id);
    expect(unreadable.statusCode, unreadable.body).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id]);
    expect(await favoriteRows(db, bob.id)).toEqual([both.id]);

    const bad = await del(app, alice.id, "not-a-uuid");
    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(NOT_FOUND_BODY);
    expect(await favoriteRows(db, alice.id)).toEqual([mine.id]);
  });

  it("大寫 UUID 的 :id 也刪得到", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    expect((await put(app, alice.id, n.id)).statusCode).toBe(200);
    expect((await del(app, alice.id, n.id.toUpperCase())).statusCode).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([]);
  });
});

describe("PUT／DELETE：favorite 節流桶", () => {
  it("PUT 與 DELETE 共用一顆、每人各自計；GET、授權前的 400 與 404 不扣；超過 → 429 且不寫入、不刪除", async () => {
    const { app, db } = await buildTestApp({ limiters: { favorite: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const a1 = await seedNote(db, { ownerId: alice.id });
    const a2 = await seedNote(db, { ownerId: alice.id });
    const bobs = await seedNote(db, { ownerId: bob.id });

    for (let i = 0; i < 10; i++) await list(app, alice.id);
    for (const id of [randomUUID(), bobs.id, "not-a-uuid"]) expect((await put(app, alice.id, id)).statusCode).toBe(404);
    expect((await put(app, alice.id, a1.id, { extra: 1 })).statusCode).toBe(400);
    expect((await del(app, alice.id, "not-a-uuid")).statusCode).toBe(404);

    expect((await put(app, alice.id, a1.id)).statusCode).toBe(200);
    expect((await del(app, alice.id, a2.id)).statusCode).toBe(204);

    const overPut = await put(app, alice.id, a2.id);
    expect(overPut.statusCode, overPut.body).toBe(429);
    expect(overPut.json()).toEqual(TOO_MANY);
    const overDel = await del(app, alice.id, a1.id);
    expect(overDel.statusCode, overDel.body).toBe(429);
    expect(overDel.json()).toEqual(TOO_MANY);
    expect(await favoriteRows(db, alice.id)).toEqual([a1.id]);

    const bobPut = await put(app, bob.id, bobs.id);
    expect(bobPut.statusCode, bobPut.body).toBe(200);
  });
});

describe("PUT／DELETE：只收 cookie", () => {
  it("未登入 → 401；只帶 Bearer token、沒有 cookie → 401；都不寫入、不刪除", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const kept = await seedNote(db, { ownerId: alice.id });
    expect((await put(app, alice.id, kept.id)).statusCode).toBe(200);
    const { token } = await seedTokenForUser(db, alice.id);

    for (const method of ["PUT", "DELETE"] as const) {
      for (const id of [n.id, kept.id]) {
        const anon = await app.inject({ method, url: `/api/favorites/${id}` });
        expect(anon.statusCode, `${method} anon ${anon.body}`).toBe(401);
        const withToken = await app.inject({ method, url: `/api/favorites/${id}`, headers: bearer(token) });
        expect(withToken.statusCode, `${method} bearer ${withToken.body}`).toBe(401);
      }
    }
    expect(await favoriteRows(db, alice.id)).toEqual([kept.id]);
  });
});

describe("永久刪除筆記帶走最愛紀錄", () => {
  it("垃圾桶的永久刪除 → 那篇的紀錄消失；另一篇的紀錄還在", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const gone = await seedNote(db, { ownerId: alice.id });
    const stays = await seedNote(db, { ownerId: alice.id });
    for (const id of [gone.id, stays.id]) expect((await put(app, alice.id, id)).statusCode).toBe(200);
    await markTrashed(db.$client, gone.id, alice.id);
    expect(await favoriteRows(db, alice.id)).toEqual([gone.id, stays.id].sort());

    const res = await inject(app, "POST", "/api/trash/purge", alice.id, { ids: [gone.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(await favoriteRows(db, alice.id)).toEqual([stays.id]);
  });

  it("刪群組・全部刪除 → 群組筆記上每個人的紀錄都消失；個人筆記的紀錄還在", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }]);
    const inGroup = await seedNote(db, { groupId: g.id });
    const personal = await seedNote(db, { ownerId: alice.id });
    for (const [who, id] of [[alice.id, inGroup.id], [bob.id, inGroup.id], [alice.id, personal.id]] as const) {
      expect((await put(app, who, id)).statusCode).toBe(200);
    }

    const res = await inject(app, "DELETE", `/api/groups/${g.id}`, alice.id, { mode: "delete" });
    expect(res.statusCode, res.body).toBe(204);
    expect(await favoriteRows(db, alice.id)).toEqual([personal.id]);
    expect(await favoriteRows(db, bob.id)).toEqual([]);
  });
});
