/**
 * #175 PR4（spec §6.8、§6.7 DELETE 列）：`DELETE /api/groups/:id` 必填 body 的兩種模式（HTTP 功能面）。
 *   `{mode:"transfer", transferTo}`（T6）：筆記全數改成 transferTo（該群組的內建管理員）的個人筆記、`/g/` 舊網址轉址、清公開連結；
 *     commit 後 `onGroupAccessChanged(noteIds, 成員 − transferTo)`、`onGroupAccessChanged(noteIds, [transferTo])`（筆記非空才呼叫）。
 *   `{mode:"delete"}`（T7）：交易外取 P0、每篇開 gate（`beforeNoteDeleted`）、`group-delete-gated` 縫、交易；失敗（含 TxAbort、40P01）
 *     每個 gate 都 release；成功 → 刪附件檔 → `L \ P0` 非空才 `onGroupAccessChanged(L \ P0, 成員)`。
 * 順序：groupAccess（404 同形）→ 403 → body（400 invalid_body）→ transferTo 非 UUID 409 not_admin（與非成員同形）。
 * 交易本體的逐欄斷言在 `groups-v2-delete-tx.test.ts`；並發在 `groups-v2-race.test.ts`、`groups-v2-move-race.test.ts`。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { groupMembers, groups, noteLinks, noteRedirects, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, runGroupAuthMatrix, seedGroup, seedNote, seedRole, seedUser, spyCollabHooks } from "./group-helpers.js";
import { seedUpload } from "./copy-helpers.js";

/** `spyCollabHooks` 再把 `beforeNoteDeleted` 換成「每個 gate 一個 `release` spy」的版本（數開了幾個、各 release 幾次）。 */
function gatedHooks() {
  const gates: Array<{ noteId: string; release: ReturnType<typeof vi.fn<() => void>> }> = [];
  const hooks = {
    ...spyCollabHooks(),
    beforeNoteDeleted: vi.fn(async (noteId: string) => {
      const release = vi.fn<() => void>();
      gates.push({ noteId, release });
      return { release };
    }),
  };
  return { hooks, gates };
}

const del = async (app: FastifyInstance, groupId: string, userId: string, payload?: unknown) =>
  app.inject({
    method: "DELETE",
    url: `/api/groups/${groupId}`,
    cookies: await cookieOf(userId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const get = async (app: FastifyInstance, url: string, userId: string) => app.inject({ method: "GET", url, cookies: await cookieOf(userId) });

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const NOT_ADMIN_BODY = { error: { code: "not_admin", message: NOT_ADMIN_MESSAGE } };
const SERVER_BUSY_BODY = { error: { code: "server_busy", message: "伺服器忙碌，請稍後再試" } };
const GROUP_NOT_FOUND_BODY = { error: { code: "not_found", message: "找不到此群組" } };

describe("#175 PR4 DELETE /api/groups/:id：授權與 body", () => {
  it("授權矩陣・delete 模式（payload {mode:'delete'}）：member 403、admin／站台 admin 204；非成員／非 UUID／不存在 404 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      payload: () => ({ mode: "delete" }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("授權矩陣・transfer 模式（transferTo＝場景的內建管理員）：member 403、admin／站台 admin 204；非成員／非 UUID／不存在 404 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "DELETE",
      url: id => `/api/groups/${id}`,
      payload: scene => ({ mode: "transfer", transferTo: scene.admin.id }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 204, siteAdmin: 204, badId: 404, missing: 404 },
    });
  });

  it("N5：路由 :id 不是 UUID（兩模式、body 合法）→ 404，與不存在的 UUID 逐位元組相同；不進交易（沒有 hook、沒有 gate）", async () => {
    const recorded: GroupRacePoint[] = [];
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id });
    const bodies: string[] = [];
    for (const id of ["not-a-uuid", `${g.id}x`, g.id.slice(0, 35), randomUUID()]) {
      for (const payload of [{ mode: "delete" }, { mode: "transfer", transferTo: admin.id }]) {
        const res = await del(app, id, admin.id, payload);
        expect(res.statusCode, `${id} ${JSON.stringify(payload)}`).toBe(404);
        bodies.push(res.body);
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(GROUP_NOT_FOUND_BODY);
    expect(recorded).toEqual([]);
    expect(gates).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("RF6／body：無 body、{}、{mode:'bogus'}、{mode:'transfer'}（缺 transferTo）、{mode:'delete', transferTo}（多餘鍵）、{mode:'transfer', transferTo: 1} → 400 invalid_body；群組與筆記原封不動；member 送壞 body 仍是 403（授權先於 body）", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [admin, member] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);
    const bad: unknown[] = [undefined, {}, { mode: "bogus" }, { mode: "transfer" }, { mode: "delete", transferTo: admin.id }, { mode: "transfer", transferTo: 1 }];
    for (const payload of bad) {
      const res = await del(app, g.id, admin.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    for (const payload of bad) {
      const res = await del(app, g.id, member.id, payload);
      expect(res.statusCode, `member ${JSON.stringify(payload)}`).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(gates).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("transferTo 非 UUID／非成員／一般成員／勾滿七旗標的自訂角色／站台 admin（非成員）→ 409 not_admin，五形 body 逐位元組相同；群組、筆記、成員原封不動；沒有任何 hook 被呼叫", async () => {
    const recorded: GroupRacePoint[] = [];
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const [admin, member, boss, outsider, siteAdmin] = await Promise.all([
      seedUser(db), seedUser(db), seedUser(db), seedUser(db), seedUser(db, { isAdmin: true }),
    ]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }, { userId: boss.id, role: "member" }]);
    const bossRole = await seedRole(db, g.id, "Boss", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await db.update(groupMembers).set({ roleId: bossRole }).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, boss.id)));
    const n = await seedNote(db, { groupId: g.id });
    const before = await noteState(db.$client, n.id);

    const bodies: string[] = [];
    for (const transferTo of ["not-a-uuid", outsider.id, member.id, boss.id, siteAdmin.id]) {
      const res = await del(app, g.id, admin.id, { mode: "transfer", transferTo });
      expect(res.statusCode, transferTo).toBe(409);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual(NOT_ADMIN_BODY);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))).toHaveLength(3);
    expect(recorded).toEqual([]);
    expect(gates).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });
});

describe("#175 PR4 DELETE /api/groups/:id：轉移（T6）", () => {
  it("轉移給另一位管理員：204 空 body；筆記成為 B 的個人筆記；GET /api/notes：B 看得到、role owner、groupId null；C（一般成員）看不到；onGroupAccessChanged 恰兩次：(全部筆記, 成員−B)、(全部筆記, [B])；beforeNoteDeleted 沒被呼叫", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const asB = (await get(app, "/api/notes", b.id)).json() as Array<{ id: string; role: string; groupId: string | null; ownerId: string | null }>;
    const mine = asB.filter(x => x.id === n1.id || x.id === n2.id);
    expect(sorted(mine.map(x => x.id))).toEqual(sorted([n1.id, n2.id]));
    for (const x of mine) expect(x).toMatchObject({ role: "owner", groupId: null, ownerId: b.id });
    const asC = (await get(app, "/api/notes", c.id)).json() as Array<{ id: string }>;
    expect(asC.filter(x => x.id === n1.id || x.id === n2.id)).toEqual([]);

    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    const [first, second] = hooks.onGroupAccessChanged.mock.calls;
    expect(sorted(first![0])).toEqual(sorted([n1.id, n2.id]));
    expect(sorted(first![1])).toEqual(sorted([a.id, c.id]));
    expect(sorted(second![0])).toEqual(sorted([n1.id, n2.id]));
    expect(second![1]).toEqual([b.id]);
    expect(hooks.beforeNoteDeleted).not.toHaveBeenCalled();
    expect(gates).toEqual([]);
  });

  it("N4：大寫的路由 :id 與大寫的 transferTo → 204；轉址鍵是小寫 group id；第一批踢線名單照樣濾掉 transferTo；hook 的 groupId 是小寫", async () => {
    const ctxs: Array<{ point: GroupRacePoint; groupId?: string }> = [];
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async (point, ctx) => { ctxs.push({ point, groupId: ctx.groupId }); } });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });

    const res = await del(app, g.id.toUpperCase(), a.id, { mode: "transfer", transferTo: b.id.toUpperCase() });
    expect(res.statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "plan" });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/plan`, noteId: n.id },
    ]);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(2);
    expect(sorted(hooks.onGroupAccessChanged.mock.calls[0]![1])).toEqual(sorted([a.id, c.id]));
    expect(hooks.onGroupAccessChanged.mock.calls[1]![1]).toEqual([b.id]);
    expect(ctxs).toEqual([{ point: "group-delete-locked", groupId: g.id }, { point: "group-transfer-slug-candidate", groupId: g.id }]);

    // 全刪模式的大寫 :id：P0 照樣取得（每篇一個 gate），hook 的 groupId 是小寫。
    ctxs.length = 0;
    const h = await seedGroup(db, "H", [{ userId: a.id, role: "admin" }]);
    const m = await seedNote(db, { groupId: h.id });
    const gone = await del(app, h.id.toUpperCase(), a.id, { mode: "delete" });
    expect(gone.statusCode).toBe(204);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledTimes(1);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledWith(m.id);
    expect(await db.select().from(notes).where(eq(notes.id, m.id))).toEqual([]);
    expect(ctxs).toEqual([{ point: "group-delete-gated", groupId: h.id }, { point: "group-delete-locked", groupId: h.id }]);
  });

  it("RF4：舊 /g/ 網址——B（transferTo）GET by-group-path 200、ownerHandle＝B、groupId null（轉址命中）；A（原管理員、非 transferTo）與 C → 404，body 與從沒存在過的 /g/<隨機 uuid>/<slug> 逐位元組相同", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const y = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    const asB = await get(app, `/api/notes/by-group-path/${g.id}/plan`, b.id);
    expect(asB.statusCode).toBe(200);
    expect(asB.json()).toMatchObject({ id: y.id, ownerHandle: b.handle, groupId: null, role: "owner" });
    const never = await get(app, `/api/notes/by-group-path/${randomUUID()}/plan`, a.id);
    expect(never.statusCode).toBe(404);
    for (const who of [a, c]) {
      const res = await get(app, `/api/notes/by-group-path/${g.id}/plan`, who.id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(never.body);
    }
  });

  it("轉移清掉公開連結（Willie 2026-10-02）：匿名 GET /api/public/notes/<token> 轉移前 200、轉移後 404，body 與從沒存在過的 token 逐位元組相同；該篇附件的公開端點 /api/public/notes/<token>/uploads/<id> 轉移後也 404", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const token = "k".repeat(43);
    const n = await seedNote(db, { groupId: g.id }, { publicToken: token });
    const up = await seedUpload(db, uploadsDir, n.id, a.id);
    const anon = (url: string) => app.inject({ method: "GET", url });
    expect((await anon(`/api/public/notes/${token}`)).statusCode).toBe(200);
    expect((await anon(`/api/public/notes/${token}/uploads/${up}`)).statusCode).toBe(200);

    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    const never = "z".repeat(43);
    const page = await anon(`/api/public/notes/${token}`);
    expect(page.statusCode).toBe(404);
    expect(page.body).toBe((await anon(`/api/public/notes/${never}`)).body);
    const file = await anon(`/api/public/notes/${token}/uploads/${up}`);
    expect(file.statusCode).toBe(404);
    expect(file.body).toBe((await anon(`/api/public/notes/${never}/uploads/${up}`)).body);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, public_token: null, public_slug: null });
  });

  it("Q15：轉移給自己（呼叫者是內建管理員）→ 204、呼叫者成為 owner", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null });
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("站台 admin（非成員）把群組轉給該群組的內建管理員 → 204", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, site] = await Promise.all([seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    expect((await del(app, g.id, site.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null });
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("RF3：transferTo 的舊轉址被活網址遮蔽——/n/<B>/x 原本轉到 X（B 先前移進別的群組的筆記），轉移後群組筆記 Y 在 B 範圍拿到 x → by-path /n/<B>/x 回 Y", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const h = await seedGroup(db, "H", [{ userId: b.id, role: "member" }]);
    const x = await seedNote(db, { ownerId: b.id }, { slug: "x" });
    const moved = await app.inject({ method: "POST", url: `/api/notes/${x.id}/move`, cookies: await cookieOf(b.id), payload: { groupId: h.id } });
    expect(moved.statusCode).toBe(200);
    const beforeHit = await get(app, `/api/notes/by-path/${b.handle}/x`, b.id);
    expect(beforeHit.statusCode).toBe(200);
    expect(beforeHit.json().id).toBe(x.id);

    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const y = await seedNote(db, { groupId: g.id }, { slug: "x" });
    expect((await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id })).statusCode).toBe(204);

    expect(await noteState(db.$client, y.id)).toMatchObject({ owner_id: b.id, slug: "x" });
    const after = await get(app, `/api/notes/by-path/${b.handle}/x`, b.id);
    expect(after.statusCode).toBe(200);
    expect(after.json().id).toBe(y.id);
  });
});

describe("#175 PR4 DELETE /api/groups/:id：全刪（T7）", () => {
  it("全刪：204；P0 每篇各呼叫一次 beforeNoteDeleted、沒有 release；L＝P0 時不呼叫 onGroupAccessChanged；筆記、群組消失", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(sorted(gates.map(x => x.noteId))).toEqual(sorted([n1.id, n2.id]));
    for (const gate of gates) expect(gate.release).not.toHaveBeenCalled();
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(await db.select().from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toEqual([]);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toEqual([]);
  });

  it("RF5：全刪有附件、與別人個人筆記互相連結的群組——uploads 列與磁碟檔都消失（其中一個磁碟檔事先刪掉也照樣 204）；p→g1、g1→p 兩條 note_links 都消失、p 仍在；p 的 GET …/backlinks 刪前列出 g1、刪後不列", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const g1 = await seedNote(db, { groupId: g.id });
    const p = await seedNote(db, { ownerId: c.id });
    await db.insert(noteLinks).values([{ sourceNoteId: p.id, targetNoteId: g1.id }, { sourceNoteId: g1.id, targetNoteId: p.id }]);
    const withFile = await seedUpload(db, uploadsDir, g1.id, a.id);
    const fileMissing = await seedUpload(db, uploadsDir, g1.id, a.id, undefined, { noFile: true });
    expect(existsSync(uploadFilePath(uploadsDir, withFile))).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, fileMissing))).toBe(false);
    const backBefore = await get(app, `/api/notes/${p.id}/backlinks`, c.id);
    expect((backBefore.json() as { backlinks: Array<{ id: string }> }).backlinks.map(x => x.id)).toContain(g1.id);

    expect((await del(app, g.id, a.id, { mode: "delete" })).statusCode).toBe(204);

    expect(existsSync(uploadFilePath(uploadsDir, withFile))).toBe(false);
    expect(await db.select().from(uploads).where(inArray(uploads.id, [withFile, fileMissing]))).toEqual([]);
    expect(await db.select().from(noteLinks).where(or(eq(noteLinks.sourceNoteId, g1.id), eq(noteLinks.targetNoteId, g1.id)))).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(eq(notes.id, p.id))).toEqual([{ id: p.id }]);
    expect(await db.select().from(notes).where(eq(notes.id, g1.id))).toEqual([]);
    const backAfter = await get(app, `/api/notes/${p.id}/backlinks`, c.id);
    expect(backAfter.statusCode).toBe(200);
    expect((backAfter.json() as { backlinks: Array<{ id: string }> }).backlinks.map(x => x.id)).not.toContain(g1.id);
  });

  it("全刪的交易失敗 → 每個 gate 都 release、筆記與群組原封不動、回 500", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-locked") throw new Error("boom"); },
    });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toHaveLength(2);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("全刪：gate 開完之後、交易之前的縫（group-delete-gated）丟錯 → 500、每個 gate 都 release、筆記與群組原封不動", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-gated") throw new Error("boom"); },
    });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id]))).toHaveLength(2);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("全刪：其中一篇的 beforeNoteDeleted reject（契約外）→ 500、其餘已開的 gate 都 release、不進交易、筆記與群組原封不動（spec 疑點 Q5 的 allSettled）", async () => {
    const recorded: GroupRacePoint[] = [];
    const released: string[] = [];
    const holder: { bad?: string } = {};
    const hooks = {
      ...spyCollabHooks(),
      beforeNoteDeleted: vi.fn(async (noteId: string) => {
        if (noteId === holder.bad) throw new Error("gate exploded");
        return { release: () => { released.push(noteId); } };
      }),
    };
    const { app, db } = await buildTestApp({ collabHooks: hooks, groupTestHook: async p => { recorded.push(p); } });
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id });
    const n2 = await seedNote(db, { groupId: g.id });
    const n3 = await seedNote(db, { groupId: g.id });
    holder.bad = n2.id;

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(500);
    expect(hooks.beforeNoteDeleted).toHaveBeenCalledTimes(3);
    expect(sorted(released)).toEqual(sorted([n1.id, n3.id]));
    expect(recorded).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [n1.id, n2.id, n3.id]))).toHaveLength(3);
    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
  });

  it("全刪在 gate 之後、交易之前群組已被刪 → 404 not_found、gate 全部 release", async () => {
    const holder: { gid?: string; db?: Awaited<ReturnType<typeof buildTestApp>>["db"] } = {};
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => {
        if (p !== "group-delete-gated" || !holder.gid) return;
        await holder.db!.delete(notes).where(eq(notes.groupId, holder.gid));
        await holder.db!.delete(groups).where(eq(groups.id, holder.gid));
      },
    });
    holder.db = db;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id });
    await seedNote(db, { groupId: g.id });
    await seedNote(db, { groupId: g.id });
    holder.gid = g.id;

    const res = await del(app, g.id, a.id, { mode: "delete" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(gates).toHaveLength(3);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    holder.gid = undefined;
    const never = await del(app, randomUUID(), a.id, { mode: "delete" });
    expect(res.body).toBe(never.body);
  });
});

describe("#175 PR4 DELETE /api/groups/:id：兩模式共通", () => {
  it("空群組：兩模式各 204；不呼叫 onGroupAccessChanged／beforeNoteDeleted", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g1 = await seedGroup(db, "Empty1", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const g2 = await seedGroup(db, "Empty2", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    expect((await del(app, g1.id, a.id, { mode: "transfer", transferTo: a.id })).statusCode).toBe(204);
    expect((await del(app, g2.id, a.id, { mode: "delete" })).statusCode).toBe(204);
    expect(await db.select().from(groups).where(inArray(groups.id, [g1.id, g2.id]))).toEqual([]);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(hooks.beforeNoteDeleted).not.toHaveBeenCalled();
    expect(gates).toEqual([]);
  });

  it("交易內 40P01（hook 在 group-delete-locked 拋 { code: '40P01' }）→ 409 server_busy：轉移、全刪各一發；全刪的 gate 全數 release；群組與筆記原封不動", async () => {
    const { hooks, gates } = gatedHooks();
    const { app, db } = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => { if (p === "group-delete-locked") throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); },
    });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "one" });
    const n2 = await seedNote(db, { groupId: g.id }, { slug: "two" });
    const before = [await noteState(db.$client, n1.id), await noteState(db.$client, n2.id)];

    const transfer = await del(app, g.id, a.id, { mode: "transfer", transferTo: b.id });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json()).toEqual(SERVER_BUSY_BODY);
    expect(gates).toEqual([]);

    const wipe = await del(app, g.id, a.id, { mode: "delete" });
    expect(wipe.statusCode).toBe(409);
    expect(wipe.json()).toEqual(SERVER_BUSY_BODY);
    expect(gates).toHaveLength(2);
    for (const gate of gates) expect(gate.release).toHaveBeenCalledTimes(1);

    expect(await db.select().from(groups).where(eq(groups.id, g.id))).toHaveLength(1);
    expect([await noteState(db.$client, n1.id), await noteState(db.$client, n2.id)]).toEqual(before);
    expect(await db.select().from(noteRedirects)).toEqual([]);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });
});
