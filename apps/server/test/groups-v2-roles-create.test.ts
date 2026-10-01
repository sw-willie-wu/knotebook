/**
 * #175 PR3 Task 2：`POST /api/groups/:id/roles`（spec §6.7；閱讀恆真＝spec 疑點 10；旗標不蘊含＝spec 疑點 11）。
 * 回讀一律走 `GET /api/groups/:id/roles`。
 */
import { describe, expect, it } from "vitest";
import type { GroupRoleDto } from "@knotebook/shared";
import { buildTestApp } from "./helpers.js";
import { cookieOf, runGroupAuthMatrix, seedGroup, seedRole, seedUser, setMemberRole, spyCollabHooks } from "./group-helpers.js";

const NUL = String.fromCharCode(0);
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NONE = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false } as const;

async function setup() {
  const spy = spyCollabHooks();
  const { app, db } = await buildTestApp({ collabHooks: spy });
  const admin = await seedUser(db);
  const member = await seedUser(db);
  const g = await seedGroup(db, "Roles", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
  ]);
  const adminCookies = await cookieOf(admin.id);
  const post = async (payload: unknown, cookies = adminCookies) =>
    app.inject({ method: "POST", url: `/api/groups/${g.id}/roles`, cookies, payload: payload as Record<string, unknown> });
  const roles = async (): Promise<GroupRoleDto[]> => {
    const res = await app.inject({ method: "GET", url: `/api/groups/${g.id}/roles`, cookies: adminCookies });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupRoleDto[];
  };
  return { app, db, spy, admin, member, g, post, roles };
}

describe("#175 PR3 POST /api/groups/:id/roles", () => {
  it("授權矩陣：401／404×3（逐位元組相同）／403／201／站台 admin 201", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    await runGroupAuthMatrix(app, db, {
      method: "POST",
      url: g => `/api/groups/${g}/roles`,
      payload: () => ({ name: "Reader", permissions: NONE }),
      expected: { anon: 401, nonMember: 404, member: 403, admin: 201, siteAdmin: 201, badId: 404, missing: 404 },
    });
  });

  it("201 形：name 正規化、permissions 七鍵且 read 恆 true、memberCount 0；GET 回讀排在兩個內建角色之後，其餘依 lower(name)", async () => {
    const { post, roles } = await setup();
    const res = await post({ name: "  Reviewers ", permissions: { ...NONE, edit: true } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as GroupRoleDto;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_SHAPE),
      builtin: null,
      name: "Reviewers",
      permissions: { read: true, create: false, edit: true, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false },
      memberCount: 0,
    });
    const list = await roles();
    expect(list.map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Reviewers"]);
    expect(list[2]).toEqual(body);
    // 排序：自訂角色依 lower(name)，不依建立順序
    expect((await post({ name: "alpha", permissions: NONE })).statusCode).toBe(201);
    expect((await post({ name: "Beta", permissions: NONE })).statusCode).toBe(201);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "alpha", "Beta", "Reviewers"]);
  });

  it("RF5：六旗標全關 → 201，存成「只能閱讀」（read true、其餘 false）", async () => {
    const { post, roles } = await setup();
    const res = await post({ name: "Readers", permissions: NONE });
    expect(res.statusCode).toBe(201);
    const READ_ONLY = { read: true, create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
    expect(res.json().permissions).toEqual(READ_ONLY);
    const row = (await roles()).find(r => r.id === res.json().id);
    expect(row?.permissions).toEqual(READ_ONLY);
  });

  it("body 帶 read 鍵（true／false 兩形）→ 400 invalid_body 且沒寫進 DB；create-only（能新建不能編輯）→ 201", async () => {
    const { post, roles } = await setup();
    for (const read of [true, false]) {
      const res = await post({ name: "WithRead", permissions: { ...NONE, read } });
      expect(res.statusCode, `read=${read}`).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await roles()).toHaveLength(2);
    const res = await post({ name: "Creators", permissions: { ...NONE, create: true } });
    expect(res.statusCode).toBe(201);
    const CREATE_ONLY = { read: true, create: true, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
    expect(res.json().permissions).toEqual(CREATE_ONLY);
    expect((await roles()).find(r => r.id === res.json().id)?.permissions).toEqual(CREATE_ONLY);
  });

  it("兩個管理旗標獨立：只開 manageGroup → 201；只開 manageMembers → 201", async () => {
    const { post, roles } = await setup();
    const g1 = await post({ name: "GroupOnly", permissions: { ...NONE, manageGroup: true } });
    expect(g1.statusCode).toBe(201);
    expect(g1.json().permissions).toMatchObject({ manageGroup: true, manageMembers: false });
    const m1 = await post({ name: "MembersOnly", permissions: { ...NONE, manageMembers: true } });
    expect(m1.statusCode).toBe(201);
    expect(m1.json().permissions).toMatchObject({ manageGroup: false, manageMembers: true });
    const list = await roles();
    expect(list.find(r => r.id === g1.json().id)?.permissions).toMatchObject({ manageGroup: true, manageMembers: false });
    expect(list.find(r => r.id === m1.json().id)?.permissions).toMatchObject({ manageGroup: false, manageMembers: true });
  });

  it("RF1 名稱：trim／大小寫／NFC 撞名與保留名 → 409 role_name_taken；'Admins' 可以建", async () => {
    const { post, roles } = await setup();
    const reader = await post({ name: " Reader ", permissions: NONE });
    expect(reader.statusCode).toBe(201);
    expect(reader.json().name).toBe("Reader");
    const cafe = await post({ name: "Café", permissions: NONE });
    expect(cafe.statusCode).toBe(201);
    expect(cafe.json().name).toBe("Café");
    for (const name of ["reader", "Café", "admin", "MEMBER", "管理員", "一般成員"]) {
      const res = await post({ name, permissions: NONE });
      expect(res.statusCode, name).toBe(409);
      expect(res.json()).toEqual({ error: { code: "role_name_taken", message: "這個群組已有同名的角色，或該名稱保留給內建角色" } });
    }
    expect((await post({ name: "Admins", permissions: NONE })).statusCode).toBe(201);
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Admins", "Café", "Reader"]);
  });

  it("名稱邊界：空字串／全空白／41 字元／含 NUL／落單代理 → 400 invalid_name（不是 500）；40 個 emoji → 201", async () => {
    const { post, roles } = await setup();
    for (const name of ["", "   ", "a".repeat(41), `a${NUL}b`, "\uD800"]) {
      const res = await post({ name, permissions: NONE });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(res.json()).toEqual({ error: { code: "invalid_name", message: "角色名稱須為 1–40 個字元" } });
    }
    expect(await roles()).toHaveLength(2);
    const emoji = await post({ name: "\u{1F600}".repeat(40), permissions: NONE });
    expect(emoji.statusCode).toBe(201);
    expect(emoji.json().name).toBe("\u{1F600}".repeat(40));
  });

  it("body 形狀：缺一個旗標／多 builtin 鍵／name 非字串 → 400 invalid_body", async () => {
    const { post, roles } = await setup();
    const { manageGroup: _omit, ...missingOne } = NONE;
    for (const payload of [
      { name: "X", permissions: missingOne },
      { name: "X", builtin: null, permissions: NONE },
      { name: 5, permissions: NONE },
    ]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await roles()).toHaveLength(2);
  });

  it("授權看的是呼叫者的 manageGroup（不是 manageMembers）：只有 manageMembers 的自訂角色成員 → 403、沒寫入；只有 manageGroup 的 → 201", async () => {
    const { db, g, member, post, roles } = await setup();
    const doorman = await seedRole(db, g.id, "Doorman", { canRead: true, canManageMembers: true });
    const renamer = await seedRole(db, g.id, "Renamer", { canRead: true, canManageGroup: true });
    const cookies = await cookieOf(member.id);
    await setMemberRole(db, g.id, member.id, doorman);
    const denied = await post({ name: "ByDoorman", permissions: NONE }, cookies);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    expect((await roles()).map(r => r.builtin ?? r.name)).toEqual(["admin", "member", "Doorman", "Renamer"]);
    await setMemberRole(db, g.id, member.id, renamer);
    const ok = await post({ name: "ByRenamer", permissions: NONE }, cookies);
    expect(ok.statusCode).toBe(201);
  });

  it("授權先於 body：一般成員送壞 body（{}）→ 403，不是 400", async () => {
    const { post, member } = await setup();
    const res = await post({}, await cookieOf(member.id));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("§5.5：身為內建一般成員的站台 admin → 201", async () => {
    const { app, db } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const owner = await seedUser(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "SA", [{ userId: owner.id, role: "admin" }, { userId: siteAdmin.id, role: "member" }]);
    const res = await app.inject({
      method: "POST", url: `/api/groups/${g.id}/roles`, cookies: await cookieOf(siteAdmin.id), payload: { name: "ByAdmin", permissions: NONE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ builtin: null, name: "ByAdmin", memberCount: 0 });
  });

  it("不踢線：連建數個角色後 onGroupAccessChanged 呼叫 0 次（§7：建立角色沒有人掛它）", async () => {
    const { post, spy } = await setup();
    expect((await post({ name: "A", permissions: NONE })).statusCode).toBe(201);
    expect((await post({ name: "B", permissions: { ...NONE, edit: true, create: true } })).statusCode).toBe(201);
    expect((await post({ name: "C", permissions: { create: true, edit: true, delete: true, managePublicLink: true, manageMembers: true, manageGroup: true } })).statusCode).toBe(201);
    expect(spy.onGroupAccessChanged).toHaveBeenCalledTimes(0);
    expect(spy.onShareChanged).toHaveBeenCalledTimes(0);
    expect(spy.onUserRevoked).toHaveBeenCalledTimes(0);
  });

  it("create-only 持有者建群組筆記：201、role viewer（先看 canEdit 再看 canRead）、GET 也是 viewer；掛全關角色 → 403", async () => {
    const { app, db, post, member, g } = await setup();
    const createOnly = await post({ name: "Creators", permissions: { ...NONE, create: true } });
    expect(createOnly.statusCode).toBe(201);
    await setMemberRole(db, g.id, member.id, createOnly.json().id);
    const cookies = await cookieOf(member.id);
    const created = await app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id, title: "Draft" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: "viewer", groupId: g.id, ownerId: null });
    expect(created.json().permissions).toMatchObject({ read: true, edit: false });
    const read = await app.inject({ method: "GET", url: `/api/notes/${created.json().id}`, cookies });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ role: "viewer" });
    expect(read.json().permissions).toMatchObject({ read: true, edit: false });

    const none = await post({ name: "Nothing", permissions: NONE });
    expect(none.statusCode).toBe(201);
    await setMemberRole(db, g.id, member.id, none.json().id);
    const denied = await app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id, title: "Nope" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
  });
});
