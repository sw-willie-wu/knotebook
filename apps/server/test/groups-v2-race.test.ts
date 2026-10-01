/**
 * #175 RF4：刪空群組（T5）與成員同時建筆記。兩種順序都不 500：建立先 commit → 刪除 409 group_not_empty；刪除先拿到
 * lockGroup → 建立的 INSERT 卡在 FK KEY SHARE（pg_stat_activity 見 Lock）→ 刪除 commit 後 23503 → 404 group_not_found。
 * 另一案：刪空群組 × 同時加人（T9 的 lockGroup 決定這個交錯是 404 還是 500）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { groupMembers, groups, notes } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";

describe("#175 RF4：刪空群組 × 同時建立", () => {
  it("刪除先鎖（group-delete-locked）→ 建立卡在 FK → 刪除 204、建立 404 group_not_found、沒有孤兒列", async () => {
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
    const del = await built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    const create = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe("group_not_found");
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(notes).where(eq(notes.title, "late"))).toEqual([]);
  });

  it("建立先 commit（membership-checked 之後才發刪除）→ 刪除 409 group_not_empty、群組與筆記都在", async () => {
    const state: { second?: Promise<LightMyRequestResponse>; fire?: () => Promise<LightMyRequestResponse> } = {};
    const built = await buildTestApp({
      groupTestHook: async (point: GroupRacePoint) => {
        if (point !== "membership-checked" || !state.fire || state.second) return;
        state.second = state.fire(); // 通常建立會先完成（不保證——兩種結局都接受，見下）
      },
    });
    const [admin, member] = await Promise.all([seedUser(built.db), seedUser(built.db)]);
    const g = await seedGroup(built.db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    state.fire = async () => built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(admin.id) });
    const create = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id, title: "early" } });
    const del = await state.second!;
    // 兩種結局之一（誰先拿到 groups 列的鎖取決於排程），但**都不是 500**：
    //   建立先 → 201／409 group_not_empty（群組留著）；刪除先 → 404 group_not_found／204（群組沒了、沒有孤兒）。
    const outcome = `${create.statusCode}/${del.statusCode}`;
    expect(["201/409", "404/204"]).toContain(outcome);
    if (outcome === "201/409") expect(del.json().error.code).toBe("group_not_empty");
    else expect(create.json().error.code).toBe("group_not_found");
    expect(await built.db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(outcome === "201/409" ? 1 : 0);
    expect(await built.db.select().from(notes).where(eq(notes.title, "early"))).toHaveLength(outcome === "201/409" ? 1 : 0);
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
    const del = await built.app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies });
    const put = await state.second!;
    expect(del.statusCode).toBe(204);
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual({ error: { code: "not_found", message: "找不到此群組" } });
    expect(state.interleave).toBe("blocked");
    expect(await built.db.select().from(groupMembers).where(eq(groupMembers.userId, newcomer.id))).toEqual([]);
  });
});
