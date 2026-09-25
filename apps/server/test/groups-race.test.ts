/**
 * #103 並發驗收（spec §11.1、§12 第 2 條）：把 spec gate r2（A–G）與 r3（H–J）在拋棄式 pg 上用兩條
 * psql session 實跑過的交錯，變成走真路由的決定性測試。每一案在注入縫裡發出第二個請求並等到它卡在鎖上。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { groups, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import {
  cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf, spyCollabHooks, waitForBlockedOrSettled,
} from "./group-helpers.js";

interface Race {
  app: FastifyInstance;
  db: Db;
  pool: Pool;
  hooks: ReturnType<typeof spyCollabHooks>;
  /** 在 `point`（且 ctx 符合 `match`）第一次出現時發出 `fire()`，並等它卡在鎖上。 */
  arm(point: GroupRacePoint, match: { noteId?: string; groupId?: string }, fire: () => Promise<LightMyRequestResponse>): void;
  second(): Promise<LightMyRequestResponse>;
  interleave(): "blocked" | "settled" | undefined;
}

async function race(): Promise<Race> {
  let armed: { point: GroupRacePoint; match: { noteId?: string; groupId?: string }; fire: () => Promise<LightMyRequestResponse> } | null = null;
  let second: Promise<LightMyRequestResponse> | undefined;
  let interleave: "blocked" | "settled" | undefined;
  const hooks = spyCollabHooks();
  const built = await buildTestApp({
    collabHooks: hooks,
    groupTestHook: async (point, ctx) => {
      if (!armed || second || point !== armed.point) return;
      if (armed.match.noteId !== undefined && ctx.noteId !== armed.match.noteId) return;
      if (armed.match.groupId !== undefined && ctx.groupId !== armed.match.groupId) return;
      second = armed.fire();
      // 閉包在請求進行中才被呼叫，此時 `built` 已賦值（比照 groups-members.test.ts）。
      interleave = await waitForBlockedOrSettled(built.db.$client, second);
    },
  });
  const pool: Pool = built.db.$client;
  return {
    app: built.app,
    db: built.db,
    pool,
    hooks,
    arm: (point, match, fire) => { armed = { point, match, fire }; },
    second: () => second!,
    interleave: () => interleave,
  };
}

describe("#103 S5：PUT …/shares × PUT …/group（spec gate r3 J，兩種交錯）", () => {
  it("shares 先拿到 FOR SHARE → group 的 (0) 等它 commit → (a) 讀到新列並清掉；踢線名單含那個人", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const c = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(r.db, owner.id);
    const cookies = await cookieOf(owner.id);
    r.arm("share-group-checked", { noteId: note.id }, () =>
      r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies, payload: { groupId: g.id, role: "editor" } }));

    const share = await r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, cookies, payload: { email: c.email, role: "editor" } });
    const move = await r.second();
    expect(share.statusCode).toBe(200);
    expect(move.statusCode).toBe(200);
    expect(await sharesOf(r.db, note.id)).toEqual([]);
    expect((await noteState(r.pool, note.id)).group_id).toBe(g.id);
    expect(r.hooks.onGroupAccessChanged).toHaveBeenCalledWith([note.id], [c.id]);
    expect(r.interleave()).toBe("blocked");
  });

  it("group 先拿到 FOR UPDATE → shares 的 FOR SHARE 等它 commit → 讀到非 null → 409 note_in_group", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const c = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(r.db, owner.id);
    const cookies = await cookieOf(owner.id);
    r.arm("note-group-locked", { noteId: note.id }, () =>
      r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, cookies, payload: { email: c.email, role: "editor" } }));

    const move = await r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies, payload: { groupId: g.id, role: "editor" } });
    const share = await r.second();
    expect(move.statusCode).toBe(200);
    expect(share.statusCode).toBe(409);
    expect(share.json().error.code).toBe("note_in_group");
    expect(await sharesOf(r.db, note.id)).toEqual([]);
    expect(r.interleave()).toBe("blocked");
  });
});

describe("#103 刪群組的物化 × 筆記歸屬（spec gate r2）", () => {
  it("A：物化先鎖住筆記 → DELETE …/group 等到 commit 後讀到 NULL → 409 conflict；物化照常寫入（二者擇一）", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const m = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const note = await seedNote(r.db, owner.id, { groupId: g.id });
    const cookies = await cookieOf(owner.id);
    r.arm("group-delete-locked", { groupId: g.id }, () =>
      r.app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies }));

    const del = await r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    const leave = await r.second();
    expect(del.statusCode).toBe(204);
    expect(leave.statusCode).toBe(409);
    expect(leave.json().error.code).toBe("conflict");
    expect(await sharesOf(r.db, note.id)).toEqual([{ userId: m.id, role: "editor" }]);
    expect(r.interleave()).toBe("blocked");
  });

  it("B：DELETE …/group 先鎖住筆記 → 物化的 FOR UPDATE 等待後把它排除 → 沒有物化該篇", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const m = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const note = await seedNote(r.db, owner.id, { groupId: g.id });
    const cookies = await cookieOf(owner.id);
    r.arm("note-group-locked", { noteId: note.id }, () =>
      r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies }));

    const leave = await r.app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies });
    const del = await r.second();
    expect(leave.statusCode).toBe(200);
    expect(del.statusCode).toBe(204);
    expect(await sharesOf(r.db, note.id)).toEqual([]);
    expect((await noteState(r.pool, note.id)).group_id).toBeNull();
    expect(r.interleave()).toBe("blocked");
  });

  it("C：物化進行中，另一篇被搬進這個群組 → UPDATE 的 FK 檢查卡在 groups 鎖上，commit 後 23503 → 404 group_not_found；交易 rollback（逐人分享還在）", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const x = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }]);
    const other = await seedNote(r.db, owner.id);
    await seedShare(r.db, other.id, x.id, "viewer");
    const cookies = await cookieOf(owner.id);
    r.arm("group-delete-locked", { groupId: g.id }, () =>
      r.app.inject({ method: "PUT", url: `/api/notes/${other.id}/group`, cookies, payload: { groupId: g.id, role: "editor" } }));

    const del = await r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    const move = await r.second();
    expect(del.statusCode).toBe(204);
    expect(move.statusCode).toBe(404);
    expect(move.json()).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await sharesOf(r.db, other.id)).toEqual([{ userId: x.id, role: "viewer" }]);
    expect((await noteState(r.pool, other.id)).group_id).toBeNull();
    expect(r.interleave()).toBe("blocked");
  });

  it("D（結果與 spec 引述不同，見規格落差第 5 條）：物化先鎖 → 同群組改 role 的 PUT 等到 commit 後讀到 NULL、分流成換群組、查無群組 → 404 group_not_found；物化以原 role（editor）寫入", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const m = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const note = await seedNote(r.db, owner.id, { groupId: g.id, groupRole: "editor" });
    const cookies = await cookieOf(owner.id);
    r.arm("group-delete-locked", { groupId: g.id }, () =>
      r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies, payload: { groupId: g.id, role: "viewer" } }));

    const del = await r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    const demote = await r.second();
    expect(del.statusCode).toBe(204);
    expect(demote.statusCode).toBe(404);
    expect(demote.json().error.code).toBe("group_not_found");
    expect(await sharesOf(r.db, note.id)).toEqual([{ userId: m.id, role: "editor" }]);
    expect(r.interleave()).toBe("blocked");
  });

  it("G：物化進行中，成員 POST /api/notes {groupId} → INSERT 的 FK 檢查卡在 groups 鎖上 → 404 group_not_found，沒有建出列", async () => {
    const r = await race();
    const admin = await seedUser(r.db);
    const m = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const memberCookies = await cookieOf(m.id);
    r.arm("group-delete-locked", { groupId: g.id }, () =>
      r.app.inject({ method: "POST", url: "/api/notes", cookies: memberCookies, payload: { groupId: g.id } }));

    const del = await r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    const create = await r.second();
    expect(del.statusCode).toBe(204);
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe("group_not_found");
    expect(await r.db.select().from(notes).where(eq(notes.ownerId, m.id))).toEqual([]);
    expect(r.interleave()).toBe("blocked");
  });

  it("【推→驗】§12 第 2 條鎖順序：PUT …/group 已 UPDATE（持 groups 的 KEY SHARE）時刪群組 → 物化等它 commit 後把這篇一起物化；兩邊都成功、沒有死結、S5 成立", async () => {
    const r = await race();
    const owner = await seedUser(r.db);
    const m = await seedUser(r.db);
    const g = await seedGroup(r.db, "G", [{ userId: owner.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const note = await seedNote(r.db, owner.id);
    const cookies = await cookieOf(owner.id);
    r.arm("note-group-written", { noteId: note.id }, () =>
      r.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies }));

    const move = await r.app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies, payload: { groupId: g.id, role: "viewer" } });
    const del = await r.second();
    expect(move.statusCode).toBe(200);
    expect(del.statusCode).toBe(204);
    expect(await sharesOf(r.db, note.id)).toEqual([{ userId: m.id, role: "viewer" }]);
    expect((await noteState(r.pool, note.id)).group_id).toBeNull();
    expect(await r.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(r.interleave()).toBe("blocked");
  });
});
