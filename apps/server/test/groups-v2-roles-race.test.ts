/**
 * #175 PR3 Task 3：角色變動（T12／T13）與成員異動（T9／T10）的交錯（Review Focus RF2；spec §11 鎖序「成員／角色變動＝
 * groups 一把」）。照 `groups-members.test.ts` C2 的形：先發的請求在測試縫（鎖已取得、寫入之前）發出第二個請求，並以
 * `waitForBlockedOrSettled`（`pg_stat_activity` 的 Lock 等待）證明第二個請求確實在等鎖（有連線處於 Lock 等待；不靠時序）。當時唯一被持有的列鎖是 groups 列，但 helper 只數 Lock 等待、分不出是哪一把。
 *
 * 末段「groups FOR KEY SHARE」一案釘的是跨 PR 前提：PR2 的移動路徑讀成員資格前只對 groups 列取 `FOR KEY SHARE`，
 * 它的正確性靠「所有改 `group_members` 或角色旗標的寫入都先 `lockGroup`（groups FOR UPDATE，與 KEY SHARE 互斥）」。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import type { GroupTestHook, GroupRacePoint } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedRole, seedUser, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";

const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };

async function membersOf(app: FastifyInstance, groupId: string, cookies: Record<string, string>): Promise<GroupMemberDto[]> {
  const res = await app.inject({ method: "GET", url: `/api/groups/${groupId}/members`, cookies });
  expect(res.statusCode).toBe(200);
  return res.json() as GroupMemberDto[];
}

async function roleIdsOf(app: FastifyInstance, groupId: string, cookies: Record<string, string>): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: `/api/groups/${groupId}/roles`, cookies });
  expect(res.statusCode).toBe(200);
  return (res.json() as GroupRoleDto[]).map(r => r.id);
}

/**
 * 管理員 A、成員 B（內建一般成員）、非成員 D、自訂角色 X（可讀＋編輯，沒有人掛）。`at` 是先發請求停下來的點；
 * 到了那裡就呼叫 `race.fire()` 發第二個請求並等它卡住（或結束）。
 */
async function raceScene(at: GroupRacePoint) {
  let groupId = "";
  const race: { fire?: () => Promise<LightMyRequestResponse> } = {};
  const state: { second?: Promise<LightMyRequestResponse>; interleave?: "blocked" | "settled" } = {};
  const hook: GroupTestHook = async (point, ctx) => {
    if (point !== at || ctx.groupId !== groupId || state.second || !race.fire) return;
    state.second = race.fire();
    state.interleave = await waitForBlockedOrSettled(built.db.$client, state.second);
  };
  const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
  const a = await seedUser(built.db);
  const b = await seedUser(built.db);
  const d = await seedUser(built.db);
  const g = await seedGroup(built.db, "Race", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
  groupId = g.id;
  const x = await seedRole(built.db, g.id, "X", { canRead: true, canEdit: true });
  return { app: built.app, a, b, d, g, x, race, state, cookies: await cookieOf(a.id) };
}

describe("#175 PR3 RF2：刪自訂角色 vs 把人掛上該角色（同一把 groups 列鎖序列化）", () => {
  it("R1（T10 先）：換 B 到 X 停在寫入前時發出 DELETE X → PATCH 200、DELETE 204；B 最後被改掛內建一般成員，X 不在了", async () => {
    const { app, b, g, x, race, state, cookies } = await raceScene("group-members-checked");
    race.fire = () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const first = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: x } });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ userId: b.id, roleId: x, builtin: null });
    expect(second.statusCode, second.body).toBe(204);
    expect((await membersOf(app, g.id, cookies)).find(m => m.userId === b.id)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect(await roleIdsOf(app, g.id, cookies)).not.toContain(x);
    expect(state.interleave).toBe("blocked");
  });

  it("R2（T13 先）：刪 X 停在寫入前時發出「換 B 到 X」→ DELETE 204、PATCH 404 role_not_found；B 仍掛內建一般成員", async () => {
    const { app, b, g, x, race, state, cookies } = await raceScene("group-roles-checked");
    race.fire = () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: x } });
    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(204);
    expect(second.statusCode, second.body).toBe(404);
    expect(second.json()).toEqual({ error: { code: "role_not_found", message: "找不到此角色" } });
    expect((await membersOf(app, g.id, cookies)).find(m => m.userId === b.id)).toMatchObject({ roleId: g.memberRoleId, builtin: "member" });
    expect(await roleIdsOf(app, g.id, cookies)).not.toContain(x);
    expect(state.interleave).toBe("blocked");
  });

  it("R3（T13 先 vs T9）：刪 X 停在寫入前時發出「加 D 並掛 X」→ DELETE 204、PUT 404 role_not_found；D 不是成員", async () => {
    const { app, d, g, x, race, state, cookies } = await raceScene("group-roles-checked");
    race.fire = () => app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: d.email, roleId: x } });
    const first = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${x}`, cookies });
    const second = await state.second!;
    expect(first.statusCode, first.body).toBe(204);
    expect(second.statusCode, second.body).toBe(404);
    expect(second.json()).toEqual({ error: { code: "role_not_found", message: "找不到此角色" } });
    expect((await membersOf(app, g.id, cookies)).map(m => m.userId)).not.toContain(d.id);
    expect(state.interleave).toBe("blocked");
  });
});

describe("#175 PR3 跨 PR 前提：改角色／成員的寫入都先 lockGroup（groups FOR UPDATE）", () => {
  it("另一條交易對 groups 列持 FOR KEY SHARE 時，PATCH／DELETE 角色與 PUT／PATCH／DELETE 成員都卡住，對方 commit 後才完成", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const pool = db.$client;
    const a = await seedUser(db);
    const b = await seedUser(db);
    const c = await seedUser(db);
    const d = await seedUser(db);
    const g = await seedGroup(db, "Locked", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }, { userId: c.id, role: "member" }]);
    const cookies = await cookieOf(a.id);
    const patchMe = await seedRole(db, g.id, "PatchMe", { canRead: true, canEdit: true });
    const deleteMe = await seedRole(db, g.id, "DeleteMe", { canRead: true });
    const cases: Array<{ label: string; send: () => Promise<LightMyRequestResponse>; status: number }> = [
      { label: "PATCH role（T12）", status: 200, send: () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/roles/${patchMe}`, cookies, payload: { permissions: NONE } }) },
      { label: "DELETE role（T13）", status: 204, send: () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/roles/${deleteMe}`, cookies }) },
      { label: "PUT member（T9）", status: 200, send: () => app.inject({ method: "PUT", url: `/api/groups/${g.id}/members`, cookies, payload: { email: d.email } }) },
      { label: "PATCH member（T10）", status: 200, send: () => app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies, payload: { roleId: patchMe } }) },
      { label: "DELETE member（T11）", status: 204, send: () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${c.id}`, cookies }) },
    ];
    for (const { label, send, status } of cases) {
      const holder = await pool.connect();
      let pending: Promise<LightMyRequestResponse> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select id from groups where id = $1 for key share", [g.id]);
        pending = send();
        expect(await waitForBlockedOrSettled(pool, pending), label).toBe("blocked");
        await holder.query("commit");
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      const res = await pending!;
      expect(res.statusCode, `${label}：${res.body}`).toBe(status);
    }
  });
});
