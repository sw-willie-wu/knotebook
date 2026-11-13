/**
 * 列表端點的頭貼參照（`readAvatarRefs`）：群組成員、分享名單、使用者建議。
 * 每個端點的 `avatar` 都要等於該人在 `/api/auth/me` 的 `{ id, v }`；待補顯示圖的候選別人讀不到，列表一律給 null；
 * 查詢句數不隨人數成長；旁觀者的頭貼不會出現在任何回應。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AvatarRef } from "@knotebook/shared";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { countQueries, seedAvatarRow } from "./avatar-helpers.js";
import { noteAiEdits, noteVersions, storagePlans, userAvatars, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { readAvatarRefs } from "../src/avatars/read.js";

/** 目前頭貼（版本 3）加一張非目前的舊候選。 */
async function giveCurrentPicture(db: Db, userId: string, version = 3): Promise<AvatarRef> {
  await seedAvatarRow(db, { userId, originalSize: 4000, displaySize: 200 });
  const id = await seedAvatarRow(db, { userId, originalSize: 5000, displaySize: 300, isCurrent: true });
  await db.update(userAvatars).set({ version }).where(eq(userAvatars.id, id));
  return { id, v: version };
}

/** 顯示圖尚未補產的目前候選（OIDC 剛下載、尚未由本人瀏覽器補產）。 */
async function givePendingPicture(db: Db, userId: string): Promise<string> {
  return seedAvatarRow(db, { userId, originalSize: 800, displaySize: 0, isCurrent: true });
}

// helper 的批次查詢（`user_id = any($1::uuid[])`）；閘門讀自己的頭貼走 `user_id = $1`，不算在內。
const AVATAR_SQL = /"user_avatars"\."user_id" = any\(\$1::uuid\[\]\)/;

describe("readAvatarRefs", () => {
  it("空陣列不發查詢；重複 id 只查一次且結果正確；非 UUID 形的 id 不進查詢", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const ref = await giveCurrentPicture(db, alice.id);

    const empty = await countQueries(() => readAvatarRefs(db, []));
    expect(empty.count).toBe(0);
    expect(empty.result.size).toBe(0);

    const dup = await countQueries(() => readAvatarRefs(db, [alice.id, alice.id, alice.id]), AVATAR_SQL);
    expect(dup.count).toBe(1);
    expect([...dup.result.entries()]).toEqual([[alice.id, ref]]);

    const junk = await countQueries(() => readAvatarRefs(db, ["not-a-uuid", "'; drop table users; --"]));
    expect(junk.count).toBe(0);
    expect(junk.result.size).toBe(0);
  });

  it("只收目前且顯示圖已備好的列：非目前候選、待補候選、沒有頭貼的人都不在結果裡", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const carol = await seedUser(db);
    const ref = await giveCurrentPicture(db, alice.id);
    await seedAvatarRow(db, { userId: bob.id, originalSize: 4000, displaySize: 200 });
    await givePendingPicture(db, carol.id);
    const map = await readAvatarRefs(db, [alice.id, bob.id, carol.id]);
    expect(Object.fromEntries(map)).toEqual({ [alice.id]: ref });
  });
});

describe("GET/PUT/PATCH /api/groups/:id/members 的 avatar", () => {
  it("alice 帶 { id, v }、bob 與待補的 carol 為 null；旁觀者 dave 的頭貼不出現；PUT／PATCH 的回應也對", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const dave = await seedUser(db, { displayName: "Dave" });
    const g = await seedGroup(db, "G", [
      { userId: admin.id, role: "admin" },
      { userId: alice.id, role: "member" },
      { userId: bob.id, role: "member" },
      { userId: carol.id, role: "member" },
    ]);
    const aliceRef = await giveCurrentPicture(db, alice.id);
    await givePendingPicture(db, carol.id);
    const daveRef = await giveCurrentPicture(db, dave.id);
    const cookies = await cookieOf(admin.id);

    const list = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies });
    expect(list.statusCode).toBe(200);
    const byId = new Map((list.json() as Array<{ userId: string; avatar: AvatarRef | null }>).map(m => [m.userId, m.avatar]));
    expect(byId.get(alice.id)).toEqual(aliceRef);
    expect(byId.get(bob.id)).toBeNull();
    expect(byId.get(carol.id)).toBeNull();
    expect(byId.get(admin.id)).toBeNull();
    expect(list.body).not.toContain(daveRef.id);

    const added = await app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: dave.email } });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().avatar).toEqual(daveRef);
    const patched = await app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${alice.id}`, cookies, payload: { roleId: g.adminRoleId },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().avatar).toEqual(aliceRef);
    const patchedBob = await app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${bob.id}`, cookies, payload: { roleId: g.adminRoleId },
    });
    expect(patchedBob.json().avatar).toBeNull();
  });

  it("停用帳號的頭貼照常顯示", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const erin = await seedUser(db, { displayName: "Erin", disabled: true });
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: erin.id, role: "member" }]);
    const ref = await giveCurrentPicture(db, erin.id);
    const list = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id) });
    const erinRow = (list.json() as Array<{ userId: string; avatar: AvatarRef | null }>).find(m => m.userId === erin.id);
    expect(erinRow?.avatar).toEqual(ref);
  });

  it("換頭貼（選用另一張候選）後 id 與 v 跟著變", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: alice.id, role: "member" }]);
    const first = await giveCurrentPicture(db, alice.id, 1);
    const second = await seedAvatarRow(db, { userId: alice.id, originalSize: 6000, displaySize: 400 });
    await db.update(userAvatars).set({ version: 7 }).where(eq(userAvatars.id, second));
    const read = async () => {
      const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id) });
      return (res.json() as Array<{ userId: string; avatar: AvatarRef | null }>).find(m => m.userId === alice.id)?.avatar;
    };
    expect(await read()).toEqual(first);
    const sel = await app.inject({ method: "PUT", url: "/api/auth/avatar", cookies: await cookieOf(alice.id), payload: { candidateId: second } });
    expect(sel.statusCode, sel.body).toBe(200);
    const after = await read();
    expect(after?.id).toBe(second);
    expect(after?.v).toBeGreaterThanOrEqual(7);
    // 與本人 /me 一致
    expect(sel.json().avatar).toMatchObject({ id: after?.id, v: after?.v });
  });

  it("查詢句數：3 人與 6 人的 GET members 碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const make = async (name: string, n: number) => {
      const members: Array<{ userId: string; role: "admin" | "member" }> = [{ userId: admin.id, role: "admin" }];
      for (let i = 0; i < n; i++) {
        const u = await seedUser(db);
        await giveCurrentPicture(db, u.id);
        members.push({ userId: u.id, role: "member" });
      }
      return seedGroup(db, name, members);
    };
    const small = await make("S", 2);
    const big = await make("B", 5);
    const cookies = await cookieOf(admin.id);
    const run = (id: string, re?: RegExp) =>
      countQueries(() => app.inject({ method: "GET", url: `/api/groups/${id}/members`, cookies }), re);
    const a = await run(small.id, AVATAR_SQL);
    const b = await run(big.id, AVATAR_SQL);
    expect(a.result.json()).toHaveLength(3);
    expect(b.result.json()).toHaveLength(6);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    const aAll = await run(small.id);
    const bAll = await run(big.id);
    expect(bAll.count).toBe(aAll.count);
  });
});

describe("GET/PUT /api/notes/:id/shares 的 avatar", () => {
  it("被分享者的 avatar 正確（待補與沒有頭貼為 null）；PUT 回應正確；旁觀者的頭貼不出現；非擁有者仍 403", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const dave = await seedUser(db, { displayName: "Dave" });
    const note = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, note.id, alice.id, "viewer");
    await seedShare(db, note.id, bob.id, "editor");
    await seedShare(db, note.id, carol.id, "viewer");
    const aliceRef = await giveCurrentPicture(db, alice.id);
    await givePendingPicture(db, carol.id);
    const daveRef = await giveCurrentPicture(db, dave.id);
    const cookies = await cookieOf(owner.id);

    const list = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies });
    expect(list.statusCode).toBe(200);
    const byId = new Map((list.json() as Array<{ userId: string; avatar: AvatarRef | null }>).map(s => [s.userId, s.avatar]));
    expect(byId.get(alice.id)).toEqual(aliceRef);
    expect(byId.get(bob.id)).toBeNull();
    expect(byId.get(carol.id)).toBeNull();
    expect(list.body).not.toContain(daveRef.id);

    const put = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, cookies, payload: { email: dave.email, role: "viewer" } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().avatar).toEqual(daveRef);
    const putBob = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, cookies, payload: { email: bob.email, role: "viewer" } });
    expect(putBob.json().avatar).toBeNull();

    const denied = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies: await cookieOf(alice.id) });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(aliceRef.id);
  });

  it("查詢句數：2 人與 4 人的分享名單碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const small = await seedNote(db, { ownerId: owner.id });
    const big = await seedNote(db, { ownerId: owner.id });
    const share = async (noteId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const u = await seedUser(db);
        await giveCurrentPicture(db, u.id);
        await seedShare(db, noteId, u.id, "viewer");
      }
    };
    await share(small.id, 2);
    await share(big.id, 4);
    const cookies = await cookieOf(owner.id);
    const run = (id: string, re?: RegExp) => countQueries(() => app.inject({ method: "GET", url: `/api/notes/${id}/shares`, cookies }), re);
    const a = await run(small.id, AVATAR_SQL);
    const b = await run(big.id, AVATAR_SQL);
    expect(a.result.json()).toHaveLength(2);
    expect(b.result.json()).toHaveLength(4);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect((await run(big.id)).count).toBe((await run(small.id)).count);
  });
});

describe("GET /api/users/suggest 的 avatar", () => {
  it("每個建議帶本人的 avatar（待補與沒有頭貼為 null）；不在建議結果裡的人頭貼不出現；停用帳號本來就不在建議裡", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters() });
    const me = await seedUser(db);
    const alice = await seedUser(db, { displayName: "sugg Alice" });
    const bob = await seedUser(db, { displayName: "sugg Bob" });
    const carol = await seedUser(db, { displayName: "sugg Carol" });
    const dave = await seedUser(db, { displayName: "sugg Dave" });
    await seedGroup(db, "G", [
      { userId: me.id, role: "admin" }, { userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }, { userId: carol.id, role: "member" },
    ]);
    const aliceRef = await giveCurrentPicture(db, alice.id);
    await givePendingPicture(db, carol.id);
    const daveRef = await giveCurrentPicture(db, dave.id);

    const res = await app.inject({ method: "GET", url: "/api/users/suggest?q=sugg", cookies: await cookieOf(me.id) });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json().users as Array<{ userId: string; avatar: AvatarRef | null }>).map(u => [u.userId, u.avatar]));
    expect([...byId.keys()].sort()).toEqual([alice.id, bob.id, carol.id].sort());
    expect(byId.get(alice.id)).toEqual(aliceRef);
    expect(byId.get(bob.id)).toBeNull();
    expect(byId.get(carol.id)).toBeNull();
    expect(res.body).not.toContain(daveRef.id);
  });

  it("查詢句數：2 人與 4 人的建議碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters() });
    const me = await seedUser(db);
    const make = async (tag: string, n: number) => {
      const members: Array<{ userId: string; role: "admin" | "member" }> = [{ userId: me.id, role: "admin" }];
      for (let i = 0; i < n; i++) {
        const u = await seedUser(db, { displayName: `${tag} ${i}` });
        await giveCurrentPicture(db, u.id);
        members.push({ userId: u.id, role: "member" });
      }
      await seedGroup(db, tag, members);
    };
    await make("aaaa", 2);
    await make("bbbb", 4);
    const cookies = await cookieOf(me.id);
    const run = (q: string, re?: RegExp) => countQueries(() => app.inject({ method: "GET", url: `/api/users/suggest?q=${q}`, cookies }), re);
    const a = await run("aaaa", AVATAR_SQL);
    const b = await run("bbbb", AVATAR_SQL);
    expect(a.result.json().users).toHaveLength(2);
    expect(b.result.json().users).toHaveLength(4);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect((await run("bbbb")).count).toBe((await run("aaaa")).count);
  });
});

describe("列表與 /api/auth/me 一致", () => {
  it("alice 的列表 avatar 等於 /me 的 { id, v }；待補的 carol 在 /me 是 pending: true、列表是 null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const alice = await seedUser(db);
    const carol = await seedUser(db);
    const g = await seedGroup(db, "G", [
      { userId: admin.id, role: "admin" }, { userId: alice.id, role: "member" }, { userId: carol.id, role: "member" },
    ]);
    await giveCurrentPicture(db, alice.id);
    await givePendingPicture(db, carol.id);
    const me = async (id: string) => (await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(id) })).json().avatar;
    const list = await app.inject({ method: "GET", url: `/api/groups/${g.id}/members`, cookies: await cookieOf(admin.id) });
    const rows = list.json() as Array<{ userId: string; avatar: AvatarRef | null }>;
    const aliceMe = await me(alice.id);
    expect(rows.find(r => r.userId === alice.id)?.avatar).toEqual({ id: aliceMe.id, v: aliceMe.v });
    expect((await me(carol.id)).pending).toBe(true);
    expect(rows.find(r => r.userId === carol.id)?.avatar).toBeNull();
  });
});

describe("readAvatarRefs 大量 id", () => {
  it("幾千個 id 仍是 1 句查詢、綁定參數只有 2 個（id 陣列一個）；結果只含有頭貼的人", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const ref = await giveCurrentPicture(db, alice.id);
    const ids = [alice.id, ...Array.from({ length: 5000 }, () => randomUUID())];
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      const map = await readAvatarRefs(db, ids);
      expect([...map.entries()]).toEqual([[alice.id, ref]]);
      const calls = spy.mock.calls
        .map(([q]) => q as { text?: string; values?: unknown[] } | string)
        .filter((q): q is { text: string; values: unknown[] } => typeof q !== "string" && typeof q?.text === "string" && AVATAR_SQL.test(q.text));
      expect(calls).toHaveLength(1);
      // 綁定參數的個數不隨 id 數成長：一個陣列（全部 id）加 is_current 的布林。
      expect(calls[0]!.values).toHaveLength(2);
      expect(Array.isArray(calls[0]!.values[0])).toBe(true);
      expect(calls[0]!.values[0]).toHaveLength(ids.length);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/admin/users 的 avatar", () => {
  it("每人帶本人的 avatar（待補與沒有頭貼為 null）；PATCH storage-plan 的回應也帶；非管理員仍 403", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const aliceRef = await giveCurrentPicture(db, alice.id);
    await givePendingPicture(db, carol.id);
    const cookies = await cookieOf(admin.id);

    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json() as Array<{ id: string; avatar: AvatarRef | null }>).map(u => [u.id, u.avatar]));
    expect(byId.get(alice.id)).toEqual(aliceRef);
    expect(byId.get(bob.id)).toBeNull();
    expect(byId.get(carol.id)).toBeNull();
    expect(byId.get(admin.id)).toBeNull();

    const [plan] = await db.select({ id: storagePlans.id }).from(storagePlans).limit(1);
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/users/${alice.id}/storage-plan`, cookies, payload: { planId: plan!.id } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().avatar).toEqual(aliceRef);
    const patchedBob = await app.inject({ method: "PATCH", url: `/api/admin/users/${bob.id}/storage-plan`, cookies, payload: { planId: plan!.id } });
    expect(patchedBob.json().avatar).toBeNull();

    expect((await app.inject({ method: "GET", url: "/api/admin/users", cookies: await cookieOf(alice.id) })).statusCode).toBe(403);
  });

  it("查詢句數：3 人與 6 人的列表碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const run = async (n: number) => {
      const { app, db } = await buildTestApp();
      const admin = await seedUser(db, { isAdmin: true });
      for (let i = 0; i < n - 1; i++) await giveCurrentPicture(db, (await seedUser(db)).id);
      const cookies = await cookieOf(admin.id);
      const one = await countQueries(() => app.inject({ method: "GET", url: "/api/admin/users", cookies }), AVATAR_SQL);
      const all = await countQueries(() => app.inject({ method: "GET", url: "/api/admin/users", cookies }));
      expect(one.result.json()).toHaveLength(n);
      return { avatar: one.count, total: all.count };
    };
    const small = await run(3);
    const big = await run(6);
    expect(small.avatar).toBe(1);
    expect(big.avatar).toBe(1);
    expect(big.total).toBe(small.total);
  });
});

describe("版本歷史 editors 的 avatar", () => {
  async function seedVersion(db: Db, noteId: string, seq: number, editors: Array<{ user_id: string; agent_label: string | null }>) {
    await db.insert(noteVersions).values({ noteId, seq, ydoc: Buffer.from([0]), kind: "auto", name: null, editors, baseSeq: null });
  }

  it("人與 AI 兩種身分各帶本人的頭貼（同一人兩個 editor 帶同一個 { id, v }）；沒有頭貼為 null；已刪除的使用者 handle 為空字串且 avatar 為 null；旁觀者的頭貼不出現", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const dave = await seedUser(db, { displayName: "Dave" });
    const gone = await seedUser(db, { displayName: "Gone" });
    const note = await seedNote(db, { ownerId: alice.id });
    const aliceRef = await giveCurrentPicture(db, alice.id);
    const bobRef = await giveCurrentPicture(db, bob.id);
    const daveRef = await giveCurrentPicture(db, dave.id);
    await giveCurrentPicture(db, gone.id);
    await seedShare(db, note.id, bob.id, "editor");
    await seedVersion(db, note.id, 1, [
      { user_id: alice.id, agent_label: null }, { user_id: alice.id, agent_label: "Claude" }, { user_id: bob.id, agent_label: "Codex" },
    ]);
    await seedVersion(db, note.id, 2, [{ user_id: gone.id, agent_label: null }]);
    await db.delete(users).where(eq(users.id, gone.id));
    const cookies = await cookieOf(alice.id);

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/versions`, cookies });
    expect(res.statusCode, res.body).toBe(200);
    const versions = res.json().versions as Array<{ seq: number; editors: Array<{ handle: string; agentLabel: string | null; avatar: AvatarRef | null }> }>;
    const v1 = versions.find(v => v.seq === 1)!;
    expect(v1.editors).toEqual([
      { handle: alice.handle, agentLabel: null, avatar: aliceRef },
      { handle: alice.handle, agentLabel: "Claude", avatar: aliceRef },
      { handle: bob.handle, agentLabel: "Codex", avatar: bobRef },
    ]);
    expect(versions.find(v => v.seq === 2)!.editors).toEqual([{ handle: "", agentLabel: null, avatar: null }]);
    expect(res.body).not.toContain(daveRef.id);

    // 改名（PATCH）的回應同樣帶
    const renamed = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}/versions/1`, cookies, payload: { name: "第一版" } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().editors[2]).toEqual({ handle: bob.handle, agentLabel: "Codex", avatar: bobRef });
  });

  it("查詢句數：編輯者 2 人與 4 人的清單碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const run = async (n: number) => {
      const { app, db } = await buildTestApp();
      const owner = await seedUser(db);
      const note = await seedNote(db, { ownerId: owner.id });
      const editors: Array<{ user_id: string; agent_label: string | null }> = [];
      for (let i = 0; i < n; i++) {
        const u = await seedUser(db);
        await giveCurrentPicture(db, u.id);
        editors.push({ user_id: u.id, agent_label: null });
      }
      await seedVersion(db, note.id, 1, editors);
      const cookies = await cookieOf(owner.id);
      const url = `/api/notes/${note.id}/versions`;
      const one = await countQueries(() => app.inject({ method: "GET", url, cookies }), AVATAR_SQL);
      const all = await countQueries(() => app.inject({ method: "GET", url, cookies }));
      expect(one.result.json().versions[0].editors).toHaveLength(n);
      return { avatar: one.count, total: all.count };
    };
    const small = await run(2);
    const big = await run(4);
    expect(small.avatar).toBe(1);
    expect(big.avatar).toBe(1);
    expect(big.total).toBe(small.total);
  });
});

describe("GET /api/notes/:id/edits（AI 修改紀錄）的 avatar", () => {
  it("每列帶寫入者本人的頭貼（agentLabel 非 null 也是本人的）；沒有頭貼為 null；旁觀者的頭貼不出現", async () => {
    const { db, app } = await buildCollabTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const dave = await seedUser(db, { displayName: "Dave" });
    const note = await seedNote(db, { ownerId: alice.id });
    await seedShare(db, note.id, bob.id, "editor");
    const aliceRef = await giveCurrentPicture(db, alice.id);
    const daveRef = await giveCurrentPicture(db, dave.id);
    await db.insert(noteAiEdits).values([
      { noteId: note.id, userId: alice.id, op: "append", agentLabel: "Claude" },
      { noteId: note.id, userId: alice.id, op: "append", agentLabel: null },
      { noteId: note.id, userId: bob.id, op: "append", agentLabel: "Codex" },
    ]);
    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/edits`, cookies: await cookieOf(alice.id) });
    expect(res.statusCode, res.body).toBe(200);
    const edits = res.json().edits as Array<{ byHandle: string; agentLabel: string | null; avatar: AvatarRef | null }>;
    expect(edits).toHaveLength(3);
    const mine = edits.filter(x => x.byHandle === alice.handle);
    expect(mine).toHaveLength(2);
    expect(mine.map(x => x.avatar)).toEqual([aliceRef, aliceRef]);
    expect(mine.some(x => x.agentLabel === "Claude")).toBe(true);
    expect(edits.find(x => x.byHandle === bob.handle)!.avatar).toBeNull();
    expect(res.body).not.toContain(daveRef.id);
  });

  it("查詢句數：寫入者 2 人與 4 人的紀錄碰 user_avatars 都恰 1 句，總句數相同", async () => {
    const run = async (n: number) => {
      const { db, app } = await buildCollabTestApp();
      const owner = await seedUser(db);
      const note = await seedNote(db, { ownerId: owner.id });
      for (let i = 0; i < n; i++) {
        const u = await seedUser(db);
        await giveCurrentPicture(db, u.id);
        await db.insert(noteAiEdits).values({ noteId: note.id, userId: u.id, op: "append" });
      }
      const cookies = await cookieOf(owner.id);
      const url = `/api/notes/${note.id}/edits`;
      const one = await countQueries(() => app.inject({ method: "GET", url, cookies }), AVATAR_SQL);
      const all = await countQueries(() => app.inject({ method: "GET", url, cookies }));
      expect(one.result.json().edits).toHaveLength(n);
      return { avatar: one.count, total: all.count };
    };
    const small = await run(2);
    const big = await run(4);
    expect(small.avatar).toBe(1);
    expect(big.avatar).toBe(1);
    expect(big.total).toBe(small.total);
  });
});
