import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import type { CollabHooks } from "../src/collab/hooks.js";

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv: 0 });
}

function spyCollabHooks(): CollabHooks {
  return {
    onShareChanged: vi.fn(),
    onUserRevoked: vi.fn(),
    beforeNoteDeleted: vi.fn(async () => {}),
    linkSyncGate: () => ({ ok: false as const }),
  };
}

describe("GET /api/notes/:id/shares", () => {
  it("owner → 200，形狀正確", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-gs1@example.com" });
    const viewer = await insertUser(db, { email: "viewer-gs1@example.com", displayName: "Viewer One" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([{ userId: viewer.id, email: "viewer-gs1@example.com", displayName: "Viewer One", role: "viewer" }]);
  });

  it("非 owner 但可讀（editor）→ 403", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-gs2@example.com" });
    const editor = await insertUser(db, { email: "editor-gs2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies: { [SESSION_COOKIE]: editorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("不可讀（陌生人）→ 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-gs3@example.com" });
    const stranger = await insertUser(db, { email: "stranger-gs3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("不存在的 note → 404", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/shares",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}/shares` });
    expect(res.statusCode).toBe(401);
  });
});

describe("PUT /api/notes/:id/shares", () => {
  it("owner 分享 viewer → 200；對方 GET :id 200 role=viewer；GET 清單看得到（role 正確）；onShareChanged 被呼叫", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-ps1@example.com" });
    const target = await insertUser(db, { email: "target-ps1@example.com", displayName: "Target One" });
    const ownerCookie = await cookieFor(owner.id);
    const targetCookie = await cookieFor(target.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "target-ps1@example.com", role: "viewer" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ userId: target.id, email: "target-ps1@example.com", displayName: "Target One", role: "viewer" });
    expect(collabHooks.onShareChanged).toHaveBeenCalledWith(note.id, target.id);
    expect(collabHooks.onShareChanged).toHaveBeenCalledTimes(1);

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toMatchObject({ role: "viewer" });

    const listRes = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: note.id, role: "viewer" });
  });

  it("upsert 改 role viewer→editor → 200；對方 PATCH title 變可行；onShareChanged 被呼叫", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-ps2@example.com" });
    const target = await insertUser(db, { email: "target-ps2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const targetCookie = await cookieFor(target.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: target.id, role: "viewer" });

    // upsert 前先確認 viewer 還不能 PATCH（403）
    const beforeRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: targetCookie },
      payload: { title: "still viewer" },
    });
    expect(beforeRes.statusCode).toBe(403);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "target-ps2@example.com", role: "editor" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toMatchObject({ userId: target.id, role: "editor" });
    expect(collabHooks.onShareChanged).toHaveBeenCalledWith(note.id, target.id);
    expect(collabHooks.onShareChanged).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(noteShares).where(eq(noteShares.noteId, note.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: target.id, role: "editor" });

    const afterRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: targetCookie },
      payload: { title: "now editor" },
    });
    expect(afterRes.statusCode).toBe(200);
  });

  it("非 owner（editor）管理 shares → 403；onShareChanged 未被呼叫（I1：hook 只在成功路徑觸發）", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-ps3@example.com" });
    const editor = await insertUser(db, { email: "editor-ps3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { email: "other-ps3@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(collabHooks.onShareChanged).not.toHaveBeenCalled();
  });

  it("role: 'owner' → 400 invalid_body（M1：分享角色只能是 viewer/editor，不可透過此端點授予 owner）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ps7@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "target-ps7@example.com", role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });

    const rows = await db.select().from(noteShares).where(eq(noteShares.noteId, note.id));
    expect(rows).toHaveLength(0);
  });

  it("陌生人 → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ps4@example.com" });
    const stranger = await insertUser(db, { email: "stranger-ps4@example.com" });
    const strangerCookie = await cookieFor(stranger.id);
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
      payload: { email: "owner-ps4@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("分享給自己 → 400 cannot_share_with_self", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ps5@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "owner-ps5@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "cannot_share_with_self" } });
  });

  it("不存在 email → 404 user_not_found", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ps6@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "nobody-ps6@example.com", role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "user_not_found" } });
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "PUT", url: `/api/notes/${note.id}/shares`, payload: { email: "x@example.com", role: "viewer" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/notes/:id/shares/:userId", () => {
  it("owner 撤銷 → 204；對方 GET :id 404；onShareChanged 被呼叫且參數正確", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-ds1@example.com" });
    const target = await insertUser(db, { email: "target-ds1@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const targetCookie = await cookieFor(target.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: target.id, role: "viewer" });

    const beforeRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(beforeRes.statusCode).toBe(200);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}/shares/${target.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(delRes.statusCode).toBe(204);
    expect(collabHooks.onShareChanged).toHaveBeenCalledWith(note.id, target.id);
    expect(collabHooks.onShareChanged).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(noteShares).where(eq(noteShares.noteId, note.id));
    expect(rows).toHaveLength(0);

    const afterRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(afterRes.statusCode).toBe(404);
  });

  it("非 owner（editor）→ 403", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ds2@example.com" });
    const editor = await insertUser(db, { email: "editor-ds2@example.com" });
    const viewer = await insertUser(db, { email: "viewer-ds2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}/shares/${viewer.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("陌生人 → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ds3@example.com" });
    const stranger = await insertUser(db, { email: "stranger-ds3@example.com" });
    const target = await insertUser(db, { email: "target-ds3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: target.id, role: "viewer" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}/shares/${target.id}`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("分享列不存在 → 404 share_not_found；onShareChanged 未被呼叫（I1：hook 只在成功路徑觸發）", async () => {
    const collabHooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-ds4@example.com" });
    const notShared = await insertUser(db, { email: "not-shared-ds4@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}/shares/${notShared.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "share_not_found" } });
    expect(collabHooks.onShareChanged).not.toHaveBeenCalled();
  });

  it(":userId 非 UUID → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ds5@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/notes/${note.id}/shares/not-a-uuid`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const target = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}/shares/${target.id}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notes 清單去重（防禦縱深）", () => {
  it("owner 自我分享列（繞過 API 手動 insert）不造成清單重複，role 仍為 'owner'", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-dedupe@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    // 繞過 API（PUT /shares 會擋 cannot_share_with_self）直接插入 owner 對自己 note 的
    // note_shares 列，模擬資料異常／未來程式錯誤造成的自我分享列。
    await db.insert(noteShares).values({ noteId: note.id, userId: owner.id, role: "editor" });

    const res = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    const matching = list.filter((n: { id: string }) => n.id === note.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ role: "owner" });
  });
});
