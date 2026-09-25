import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NoteDto } from "@knotebook/shared";
import { groups, notes } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf, spyCollabHooks } from "./group-helpers.js";

const GROUP_404 = { error: { code: "group_not_found", message: "找不到此群組" } };

describe("#103 PUT /api/notes/:id/group", () => {
  it("授權：none／非 UUID → 404 not_found；editor（非 owner）→ 403；body 缺 role／groupId 非字串 → 400", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const editor = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(db, owner.id);
    await seedShare(db, note.id, editor.id, "editor");
    const put = async (userId: string, url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "PUT", url, cookies: await cookieOf(userId), payload });
    expect((await put(stranger.id, `/api/notes/${note.id}/group`, { groupId: g.id, role: "editor" })).statusCode).toBe(404);
    expect((await put(owner.id, `/api/notes/not-a-uuid/group`, { groupId: g.id, role: "editor" })).statusCode).toBe(404);
    expect((await put(editor.id, `/api/notes/${note.id}/group`, { groupId: g.id, role: "editor" })).statusCode).toBe(403);
    const noRole = await put(owner.id, `/api/notes/${note.id}/group`, { groupId: g.id });
    expect(noRole.statusCode).toBe(400);
    expect(noRole.json().error.code).toBe("invalid_body");
    expect((await put(owner.id, `/api/notes/${note.id}/group`, { groupId: null, role: "editor" })).statusCode).toBe(400);
  });

  it("groupId 非成員／不存在／非 UUID／成員檢查後被刪（FK）→ 404 group_not_found，四者逐位元組相同；RF3：非成員的站台 admin 也 404，且他的 GET /api/notes 看不到該群組的筆記", async () => {
    let doomed = "";
    // hook 只在 `built` 賦值之後的請求裡被呼叫，閉包引用後宣告的 const 不會撞 TDZ。
    const hook: GroupTestHook = async (point, ctx) => {
      if (point === "membership-checked" && ctx.groupId === doomed) await built.db.delete(groups).where(eq(groups.id, doomed));
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const db = built.db;
    const owner = await seedUser(db, { isAdmin: true });
    const other = await seedUser(db);
    const notMine = await seedGroup(db, "Theirs", [{ userId: other.id, role: "admin" }]);
    const willVanish = await seedGroup(db, "Doomed", [{ userId: owner.id, role: "admin" }]);
    doomed = willVanish.id;
    const note = await seedNote(db, owner.id);
    await seedShare(db, note.id, other.id, "viewer");
    const cookies = await cookieOf(owner.id);
    const put = (groupId: string) => built.app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies, payload: { groupId, role: "editor" } });

    const bodies = [
      await put(notMine.id), // owner 是站台 admin 但不是成員（A2：無豁免）
      await put("00000000-0000-4000-8000-00000000dead"),
      await put("not-a-uuid"),
      await put(willVanish.id), // 成員檢查通過後群組被刪 → UPDATE 撞 FK 23503
    ];
    for (const res of bodies) expect(res.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual(GROUP_404);
    // 交易 rollback：逐人分享沒有被清掉、歸屬沒變
    expect(await sharesOf(db, note.id)).toEqual([{ userId: other.id, role: "viewer" }]);
    expect((await noteState(db.$client, note.id)).group_id).toBeNull();
    // RF3 第三項：站台 admin 的清單不含他不屬於的群組的筆記
    const theirs = await seedNote(db, other.id, { groupId: notMine.id });
    const list = await built.app.inject({ method: "GET", url: "/api/notes", cookies });
    expect(list.statusCode).toBe(200);
    expect((list.json() as NoteDto[]).map(n => n.id)).not.toContain(theirs.id);
  });

  it("個人→群組：清光逐人分享與公開連結（含別名）、設歸屬與 role、回應 group 有值、不動 updated_at；踢線名單＝被清掉的人", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const c = await seedUser(db);
    const d = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: owner.id, role: "admin" }, { userId: d.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { publicToken: "t".repeat(43), publicSlug: "pub-name" });
    await seedShare(db, note.id, c.id, "editor");
    await seedShare(db, note.id, d.id, "viewer");
    const before = await noteState(db.$client, note.id);

    const res = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id), payload: { groupId: g.id, role: "viewer" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as NoteDto;
    expect(body.group).toEqual({ id: g.id, name: "Team", role: "viewer" });
    expect(body.role).toBe("owner");
    expect(await sharesOf(db, note.id)).toEqual([]);
    const after = await noteState(db.$client, note.id);
    expect(after).toMatchObject({ group_id: g.id, group_role: "viewer", public_token: null, public_slug: null });
    expect(after.updated_at).toBe(before.updated_at);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([note.id]);
    expect([...userIds].sort()).toEqual([c.id, d.id].sort());
  });

  it("群組→群組：同樣清分享與公開連結；踢線名單＝原群組全體成員 ∪ 被清掉的人", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const oldMate = await seedUser(db);
    const stray = await seedUser(db);
    const from = await seedGroup(db, "From", [{ userId: owner.id, role: "admin" }, { userId: oldMate.id, role: "member" }]);
    const to = await seedGroup(db, "To", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(db, owner.id, { groupId: from.id, publicToken: "p".repeat(43) });
    await seedShare(db, note.id, stray.id, "viewer"); // S5 破裂的殘留列：搬家時一併清掉並踢

    const res = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id), payload: { groupId: to.id, role: "editor" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().group).toEqual({ id: to.id, name: "To", role: "editor" });
    expect(await sharesOf(db, note.id)).toEqual([]);
    expect((await noteState(db.$client, note.id)).public_token).toBeNull();
    const [, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect([...userIds].sort()).toEqual([owner.id, oldMate.id, stray.id].sort());
  });

  it("同群組只改 role：A1 的 owner（已不是成員）也可以；不清公開連結、不查成員資格；踢線名單＝該群組全體成員；role 沒變＝no-op，不踢線（final-review Minor 1）", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    // seedNote 沒指定 groupRole，吃 DB DEFAULT 'editor'。
    const note = await seedNote(db, owner.id, { groupId: g.id, publicToken: "k".repeat(43), publicSlug: "keep-me" });
    const beforeNoop = await noteState(db.$client, note.id);

    // role 與現值相同（"editor"）→ 200，但整個 no-op：不踢線、狀態不變。
    const noop = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id), payload: { groupId: g.id, role: "editor" } });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().group).toEqual({ id: g.id, name: "G", role: "editor" });
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
    const afterNoop = await noteState(db.$client, note.id);
    expect(afterNoop).toEqual(beforeNoop);

    // role 真的改變（editor → viewer）→ 200，踢線名單＝該群組全體成員。
    const before = await noteState(db.$client, note.id);
    const res = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id), payload: { groupId: g.id, role: "viewer" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().group).toEqual({ id: g.id, name: "G", role: "viewer" });
    const after = await noteState(db.$client, note.id);
    expect(after).toMatchObject({ group_id: g.id, group_role: "viewer", public_token: "k".repeat(43), public_slug: "keep-me" });
    expect(after.updated_at).toBe(before.updated_at);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect([...userIds].sort()).toEqual([admin.id, member.id].sort());
  });
});

describe("#103 DELETE /api/notes/:id/group", () => {
  it("移出群組：group_id=NULL、公開連結保留（A10）、不動 updated_at、回應 group=null；踢線名單＝原群組全體成員；editor 403；不在群組裡 → 409 conflict", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id, publicToken: "z".repeat(43) });
    const before = await noteState(db.$client, note.id);

    const noAccess = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(stranger.id) });
    expect(noAccess.statusCode).toBe(404);
    expect(noAccess.json().error.code).toBe("not_found");
    expect((await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(member.id) })).statusCode).toBe(403);
    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().group).toBeNull();
    const after = await noteState(db.$client, note.id);
    expect(after).toMatchObject({ group_id: null, public_token: "z".repeat(43) });
    expect(after.updated_at).toBe(before.updated_at);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([note.id]);
    expect([...userIds].sort()).toEqual([owner.id, member.id].sort());

    const again = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/group`, cookies: await cookieOf(owner.id) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("conflict");
  });
});

describe("#103 逐人分享端點對群組筆記（D13）", () => {
  it("PUT …/shares → 409 note_in_group；DELETE 放行（S5 修復路徑）；GET → []", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const target = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id });
    const cookies = await cookieOf(owner.id);

    const put = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, cookies, payload: { email: target.email, role: "editor" } });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("note_in_group");
    expect(await sharesOf(db, note.id)).toEqual([]);
    const list = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies });
    expect(list.json()).toEqual([]);

    await seedShare(db, note.id, target.id, "editor"); // 違反 S5 的殘留列
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/shares/${target.id}`, cookies });
    expect(del.statusCode).toBe(204);
    expect(await sharesOf(db, note.id)).toEqual([]);
  });
});

describe("#103 POST /api/notes {groupId}", () => {
  it("成員可建：201、group_role=editor、回應 group 有值；非成員／站台 admin 非成員（RF3）→ 404 group_not_found；{content, groupId} → 400；非 UUID → 400", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const member = await seedUser(db);
    const site = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "Crew", [{ userId: member.id, role: "member" }]);

    const ok = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { title: "Plan", groupId: g.id } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().group).toEqual({ id: g.id, name: "Crew", role: "editor" });
    expect(ok.json().slug).toBe("plan");
    expect((await noteState(db.$client, ok.json().id)).group_id).toBe(g.id);

    const denied = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(site.id), payload: { groupId: g.id } });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(GROUP_404);
    const noSuchGroup = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: "00000000-0000-4000-8000-00000000dead" } });
    expect(noSuchGroup.statusCode).toBe(404);
    expect(noSuchGroup.json()).toEqual(GROUP_404);
    const both = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { content: "# x", groupId: g.id } });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe("invalid_body");
    const badId = await app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: "nope" } });
    expect(badId.statusCode).toBe(400);
  });

  it("成員檢查之後群組被刪（FK 23503）→ 404 group_not_found，且沒有建出任何列", async () => {
    let doomed = "";
    // hook 只在 `built` 賦值之後的請求裡被呼叫，閉包引用後宣告的 const 不會撞 TDZ。
    const hook: GroupTestHook = async (point, ctx) => {
      if (point === "membership-checked" && ctx.groupId === doomed) await built.db.delete(groups).where(eq(groups.id, doomed));
    };
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: hook });
    const db = built.db;
    const member = await seedUser(db);
    const g = await seedGroup(db, "Doomed", [{ userId: member.id, role: "admin" }]);
    doomed = g.id;
    const res = await built.app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(member.id), payload: { groupId: g.id } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(GROUP_404);
    expect(await db.select().from(notes).where(eq(notes.ownerId, member.id))).toEqual([]);
  });
});
