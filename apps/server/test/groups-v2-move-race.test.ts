/**
 * #175 PR2 T3（spec §6.3）的交錯案：C1（同篇同時移兩處）、C5（移動 × 刪空群組）、C6（移動 × PUT shares，S5）、
 * C13／C14（移動 × public-link token／別名 PUT）、C15（移動 × 自訂 slug PATCH）、C18a／C18b／C18c（移動 × 移除成員／降級，
 * review r1 m-1：(1) 對目標群組列取 KEY SHARE，與 `lockGroup` 互斥；r2 m-3 補反向順序）、C18d（移動 × 改群組名，r2 m-2）。
 * C18 原叫 C17a／b，與 spec §11 既有的 C17（刪群組・全刪 vs 轉移）撞號，r2 m-1 改名。
 * 要證明「測到的是交錯」的案在注入縫裡呼叫 `waitForBlockedOrSettled`，最後斷言 `"blocked"`；C13–C15 在縫裡
 * `await` 一次完整的移動請求（授權之後、寫入之前的窗，序列即可）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { groups, noteRedirects } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, sharesOf, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";

const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });

type RaceState = { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string };

/** 在 `point` 第一次出現時發第二個請求，並等到它卡在鎖上（或沒被擋就結束）。 */
function raceHook(point: GroupRacePoint, state: RaceState, holder: { pool?: Pool }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.second) return;
    state.second = state.fire();
    state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
  };
}

describe("#175 PR2 移動的交錯（C1／C5／C6）", () => {
  it("C1 同一篇同時移進 G1、G2：先拿到 FOR UPDATE 的成功；後到者讀到 owner NULL → 409 conflict；轉址恰一列", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const owner = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: owner.id, role: "member" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = () => move(app, n.id, owner.id, g2.id);

    const first = await move(app, n.id, owner.id, g1.id);
    const second = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(first.statusCode).toBe(200);
    expect(first.json().groupId).toBe(g1.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: { code: "conflict", message: "筆記的歸屬已變更，請重新整理後再試" } });
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g1.id, slug: "plan" });
    expect(await db.select({ oldPath: noteRedirects.oldPath }).from(noteRedirects)).toEqual([{ oldPath: `/n/${owner.handle}/plan` }]);
  });

  it("C5a 刪空群組先鎖（group-delete-locked）→ 移動 (1) 的 KEY SHARE 等它 → 刪除 204、移動 404 group_not_found；交易 rollback：筆記仍是個人、shares 還在、轉址 0 列", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    await seedShare(db, n.id, c.id, "editor");
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const del = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(del.statusCode).toBe(204);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "editor" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("C5b 移動先 commit → 刪群組 409 group_not_empty", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    expect((await move(app, n.id, owner.id, g.id)).statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("group_not_empty");
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await noteState(db.$client, n.id)).toMatchObject({ group_id: g.id, owner_id: null });
  });

  it("C6a PUT shares 先拿到 FOR SHARE（share-group-checked）→ 移動的 FOR UPDATE 等它 commit → 移動清掉剛加的那一列；踢線名單含那個人", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const spy = spyCollabHooks();
    const built = await buildTestApp({ collabHooks: spy, groupTestHook: raceHook("share-group-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, late] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    state.fire = () => move(app, n.id, owner.id, g.id);

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/shares`, cookies: await cookieOf(owner.id), payload: { email: late.email, role: "editor" } });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(put.statusCode).toBe(200);
    expect(moved.statusCode).toBe(200);
    expect(await sharesOf(db, n.id)).toEqual([]);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = spy.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([n.id]);
    expect([...userIds].sort()).toEqual([late.id, owner.id].sort());
  });

  it("C6b 移動先拿到 FOR UPDATE（note-move-locked）→ PUT shares 的 FOR SHARE 等它 commit → 讀到 group_id 非 NULL → 409 note_in_group；沒有 shares 列", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, late] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    state.fire = async () =>
      app.inject({ method: "PUT", url: `/api/notes/${n.id}/shares`, cookies: await cookieOf(owner.id), payload: { email: late.email, role: "editor" } });

    const moved = await move(app, n.id, owner.id, g.id);
    const put = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(200);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("note_in_group");
    expect(await sharesOf(db, n.id)).toEqual([]);
  });
});

describe("#175 PR2 移動 × 成員異動（C18a／C18b／C18c）", () => {
  // C18a／b：成員異動先拿到 `lockGroup`（group-members-checked）→ 移動 (1) 的 KEY SHARE 等它 commit → 讀到異動後的成員資格。
  // C18c 是反過來（移動先持鎖、成員異動等它）：移動 commit 後路由在交易外重讀筆記組回應，可能與成員異動的 commit
  // 競速，回應不一定決定（review r2 第 3 節：自然時序 10/10 回 200，強制異動先 commit 可構造出 404）——所以只斷言
  // 決定性的部分：最終狀態是「先移動、後異動」，異動的踢線名單含剛移入的筆記。
  // 拿掉 KEY SHARE（突變實測）：移動讀到異動 commit 前的成員資格而通過，UPDATE 的 FK 才等鎖（interleave 仍 blocked），
  // 之後移動照樣 commit、筆記進了群組——C18b 回 200；C18a 回 404 `not_found`（commit 後重讀時呼叫者已不是成員）。
  it("C18a 移除成員先鎖 → 移動等 groups 列鎖 → 移除 204、移動 404 group_not_found；筆記仍是呼叫者的個人筆記、shares 還在、轉址 0 列", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    await seedShare(db, n.id, c.id, "editor");
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const removed = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id) });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(before).toMatchObject({ owner_id: owner.id, group_id: null });
    expect(await sharesOf(db, n.id)).toEqual([{ userId: c.id, role: "editor" }]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("C18b 降級成無 can_create 的角色先鎖 → 移動等 groups 列鎖 → 改角色 200、移動 404 group_not_found；筆記仍是個人筆記", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, g.id, "Reader", { canRead: true });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    const before = await noteState(db.$client, n.id);
    state.fire = () => move(app, n.id, owner.id, g.id);

    const demoted = await app.inject({
      method: "PATCH", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id), payload: { roleId: reader },
    });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(moved.statusCode).toBe(404);
    expect(moved.json()).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(before).toMatchObject({ owner_id: owner.id, group_id: null });
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("C18c 移動先持 KEY SHARE（note-move-locked）→ 移除成員的 lockGroup 等它 commit → 移除 204、筆記進了群組；移除的踢線名單含這篇與 owner", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const spy = spyCollabHooks();
    const built = await buildTestApp({ collabHooks: spy, groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    // 群組裡原有的一篇：移除的踢線名單一定含它，移動的不含——用來從兩次 onGroupAccessChanged 裡認出移除那次
    //（移動那次是 ([n], [owner])，同樣含 n 與 owner，不能拿來判）。
    const existing = await seedNote(db, { groupId: g.id });
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = async () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${owner.id}`, cookies: await cookieOf(admin.id) });

    // 不斷言移動的回應碼：移動 commit 後在交易外重讀筆記組回應，與移除的 commit 競速（200 或 404 都可能，見上方說明）。
    await move(app, n.id, owner.id, g.id);
    const removed = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id });
    // 安全性質：被移除的人不能留在剛移進來的筆記上。成立前提是 `groupNoteIdsQuery` 在 `lockGroup` 之後以另一條敘述讀
    //（READ COMMITTED 下才看得到剛 commit 的移動）。
    const removalCalls = spy.onGroupAccessChanged.mock.calls.filter(([noteIds]) => noteIds.includes(existing.id));
    expect(removalCalls).toHaveLength(1);
    const [noteIds, userIds] = removalCalls[0]!;
    expect([...noteIds].sort()).toEqual([existing.id, n.id].sort());
    expect(userIds).toEqual([owner.id]);
  });
});

describe("#175 PR2 移動 × 改群組名（C18d）", () => {
  it("C18d 移動持 groups KEY SHARE（note-move-locked）時改群組名不被擋 → 改名在移動放行前就完成（settled）、200；移動 200", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan" });
    state.fire = async () =>
      app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { name: "Renamed" } });

    const moved = await move(app, n.id, owner.id, g.id);
    const renamed = await state.second!;

    // 改名是非鍵 UPDATE（`FOR NO KEY UPDATE`），與 KEY SHARE 相容；把 (1) 改成 `FOR SHARE` 時這裡變 "blocked"（突變實測）。
    expect(state.interleave).toBe("settled");
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed");
    expect(moved.statusCode).toBe(200);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id });
    expect(await db.select({ name: groups.name }).from(groups).where(eq(groups.id, g.id))).toEqual([{ name: "Renamed" }]);
  });
});

describe("#175 PR2 授權之後被移走（C13／C14／C15）", () => {
  it("C13 token PUT 授權之後（public-link-authorized）筆記被移走 → PUT 409 conflict；token 仍 NULL", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: owner.id });
    Object.assign(state, { noteId: n.id, fire: () => move(app, n.id, owner.id, g.id) });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(owner.id) });

    expect(state.moved!.statusCode).toBe(200);
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ group_id: g.id, public_token: null });
  });

  it("C14 別名 PUT 授權之後筆記被移走（群組又重開了 token）→ 400 invalid_body（不是 500），public_slug 仍 NULL", async () => {
    const state: { noteId?: string; userId?: string; groupId?: string; moved?: LightMyRequestResponse; reopened?: LightMyRequestResponse } = {};
    const holder: { app?: FastifyInstance } = {};
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await move(holder.app!, state.noteId!, state.userId!, state.groupId!);
        // 移進群組後，有 managePublicLink 的成員（這裡是 owner 本人，群組內建管理員）重開 token——別名 UPDATE 的
        // `public_token IS NOT NULL` 因此為真，只剩 `group_id IS NULL` 擋住撞 S11 CHECK（500）。
        state.reopened = await holder.app!.inject({ method: "PUT", url: `/api/notes/${state.noteId}/public-link`, cookies: await cookieOf(state.userId!) });
      },
    });
    holder.app = built.app;
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { publicToken: "a".repeat(43) });
    Object.assign(state, { noteId: n.id, userId: owner.id, groupId: g.id });

    const res = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link/slug`, cookies: await cookieOf(owner.id), payload: { slug: "alias" } });

    expect(state.moved!.statusCode).toBe(200);
    expect(state.reopened!.statusCode).toBe(200);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    const after = await noteState(db.$client, n.id);
    expect(after).toMatchObject({ group_id: g.id, public_slug: null });
    expect(after.public_token).not.toBeNull();
  });

  it("C15 自訂 slug PATCH 授權之後（slugPatchTestHook authorized）筆記被移走 → 409 conflict；slug 未寫、移動寫的轉址仍在", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, fire: () => move(app, n.id, owner.id, g.id) });

    const res = await app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(owner.id), payload: { slug: "qux" } });

    expect(state.moved!.statusCode).toBe(200);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(await noteState(db.$client, n.id)).toMatchObject({ slug: "baz", group_id: g.id, prev_slug: null });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/n/${owner.handle}/baz`, noteId: n.id },
    ]);
  });
});
