/**
 * #175 C4（spec §11）：刪群組（PR4 兩模式，T6 轉移／T7 全刪）與成員同時建筆記。任何順序都不 500：
 *   刪除先拿到 lockGroup → 建立的 INSERT 卡在 FK KEY SHARE（pg_stat_activity 見 Lock）→ 刪除 commit 後 23503 → 404 group_not_found；
 *   建立先 commit → 刪除以群組述詞把它撈進去（轉移＝成為 transferTo 的個人筆記；全刪＝一起刪）。
 * 另一案：刪空群組（全刪模式）× 同時加人（T9 的 lockGroup 決定這個交錯是 404 還是 500）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { groupMembers, groups, notes } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";

describe("#175 C4：刪群組 × 同時建立", () => {
  it("C4 刪除（轉移）先鎖（group-delete-locked）→ 建立卡在 FK → 刪除 204、建立 404 group_not_found、沒有孤兒列", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { pool?: import("pg").Pool } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "group-delete-locked" || !state.fire || state.second) return;
        state.second = state.fire();
        state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
      },
    });
    holder.pool = built.db.$client;
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () => built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "late" } });
    const del = await built.app.inject({
      method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
    });
    const create = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe("group_not_found");
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(notes).where(eq(notes.title, "late"))).toEqual([]);
  });

  it("C4 轉移與建立不定序（membership-checked 之後才發轉移）：建立先 → 201／204 且該篇成為 transferTo 的個人筆記；轉移先 → 404／204、沒有孤兒", async () => {
    const state: { second?: Promise<LightMyRequestResponse>; fire?: () => Promise<LightMyRequestResponse> } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "membership-checked" || !state.fire || state.second) return;
        state.second = state.fire(); // 通常建立會先完成（不保證——兩種結局都接受，見下）
      },
    });
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () =>
      built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id } });
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    const del = await state.second!;
    // 兩種結局之一（誰先拿到 groups 列的鎖取決於排程），但**都不是 500**、群組都沒了。
    const outcome = `${create.statusCode}/${del.statusCode}`;
    expect(["201/204", "404/204"]).toContain(outcome);
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    const rows = await built.db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.title, "early"));
    if (outcome === "201/204") expect(rows).toEqual([{ ownerId: admin.id, groupId: null }]);
    else {
      expect(create.json().error.code).toBe("group_not_found");
      expect(rows).toEqual([]);
    }
  });

  it("C4 全刪與建立不定序（membership-checked 之後才發全刪）：建立先 → 201／204 且該篇被刪；全刪先 → 404／204；兩者都沒有孤兒", async () => {
    const state: { second?: Promise<LightMyRequestResponse>; fire?: () => Promise<LightMyRequestResponse> } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "membership-checked" || !state.fire || state.second) return;
        state.second = state.fire();
      },
    });
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () =>
      built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "delete" } });
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    const del = await state.second!;
    const outcome = `${create.statusCode}/${del.statusCode}`;
    expect(["201/204", "404/204"]).toContain(outcome);
    if (outcome === "404/204") expect(create.json().error.code).toBe("group_not_found");
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
    expect(await built.db.select().from(notes).where(eq(notes.title, "early"))).toEqual([]);
  });

  it("C4 建立先 commit（序列：先 await 建立再刪）→ 轉移把它撈進去", async () => {
    const built = await buildTestApp();
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    expect(create.statusCode).toBe(201);
    const del = await built.app.inject({
      method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id), payload: { mode: "transfer", transferTo: admin.id },
    });
    expect(del.statusCode).toBe(204);
    expect(await built.db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.title, "early"))).toEqual([
      { id: create.json().id, ownerId: admin.id, groupId: null },
    ]);
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("刪空群組 × 同時加人（T9）：刪除先鎖 → PUT …/members 卡在 T9 的 lockGroup → 刪除 204、加人 404 not_found（不是 500）、沒有成員列", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const holder: { pool?: import("pg").Pool } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "group-delete-locked" || !state.fire || state.second) return;
        state.second = state.fire();
        state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
      },
    });
    holder.pool = built.db.$client;
    const [admin, newcomer] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }]);
    const cookies = await cookieOf(admin.id);
    state.fire = () => built.app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: newcomer.email } });
    const del = await built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies, payload: { mode: "delete" } });
    const put = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(groupMembers).where(eq(groupMembers.userId, newcomer.id))).toEqual([]);
  });
});
