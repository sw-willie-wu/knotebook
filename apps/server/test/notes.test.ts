import { describe, it, expect, vi } from "vitest";
import { eq, or } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { notes, noteLinks, noteShares, noteStateBackups, noteStates, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { resolveRole } from "../src/notes/service.js";
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

// 測試裡的 session 一律直接簽發（不走 /api/auth/login），tokenVersion 一律用 DB 預設值
// 0（insertUser 不改它），與 UserGate.check 比對的 tv 一致。
async function cookieFor(userId: string): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv: 0 });
}

describe("resolveRole", () => {
  it("owner → 'owner'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db);
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await expect(resolveRole(db, owner.id, note.id)).resolves.toBe("owner");
  });

  it("有 note_shares 'editor' 列 → 'editor'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-editor@example.com" });
    const editor = await insertUser(db, { email: "editor@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    await expect(resolveRole(db, editor.id, note.id)).resolves.toBe("editor");
  });

  it("有 note_shares 'viewer' 列 → 'viewer'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-viewer@example.com" });
    const viewer = await insertUser(db, { email: "viewer@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });
    await expect(resolveRole(db, viewer.id, note.id)).resolves.toBe("viewer");
  });

  it("note 存在但未分享 → 'none'", async () => {
    const { db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-none@example.com" });
    const stranger = await insertUser(db, { email: "stranger@example.com" });
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await expect(resolveRole(db, stranger.id, note.id)).resolves.toBe("none");
  });

  it("note 不存在（合法 UUID 格式）→ 'none'", async () => {
    const { db } = await buildTestApp();
    const user = await insertUser(db);
    await expect(resolveRole(db, user.id, "00000000-0000-0000-0000-000000000000")).resolves.toBe("none");
  });

  it("noteId 非 UUID 格式 → 'none'（不 throw invalid input syntax）", async () => {
    const { db } = await buildTestApp();
    const user = await insertUser(db);
    await expect(resolveRole(db, user.id, "not-a-uuid")).resolves.toBe("none");
  });
});

describe("POST /api/notes", () => {
  it("未帶 title → 201，title 預設 Untitled，形狀正確", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: "Untitled", ownerId: u.id, role: "owner" });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");

    // M6（審查）：精確鎖住 DTO 的欄位集合（而非只用 toMatchObject 驗子集）——notes 表
    // 實際還有 linksClock、deletedAt 兩個內部欄位，NoteDto 组裝必須明確排除，不能讓
    // 未來有人不小心把 `...note` 展開進回應而洩漏出去。
    expect(Object.keys(body).sort()).toEqual(["createdAt", "id", "ownerId", "role", "slug", "title", "updatedAt"]);
  });

  it("帶 title → 201 使用該 title", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db);
    const cookie = await cookieFor(u.id);

    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "My Note" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: "My Note" });
  });

  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/notes", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notes", () => {
  it("含自有與被分享（role 正確），依 updatedAt desc 排序", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-list@example.com" });
    const viewer = await insertUser(db, { email: "viewer-list@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const note1Res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { title: "First" } });
    const note1 = note1Res.json();
    const note2Res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { title: "Second" } });
    const note2 = note2Res.json();

    await db.insert(noteShares).values({ noteId: note1.id, userId: viewer.id, role: "viewer" });

    // 讓 note1 的 updatedAt 晚於 note2：透過 PATCH 更新一次 note1（owner 打）。
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note1.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { title: "First Updated" },
    });
    expect(patchRes.statusCode).toBe(200);

    const ownerListRes = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(ownerListRes.statusCode).toBe(200);
    const ownerList = ownerListRes.json();
    expect(ownerList.map((n: { id: string }) => n.id)).toEqual([note1.id, note2.id]);
    expect(ownerList.find((n: { id: string }) => n.id === note1.id)).toMatchObject({ role: "owner", title: "First Updated" });

    const viewerListRes = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: viewerCookie } });
    expect(viewerListRes.statusCode).toBe(200);
    const viewerList = viewerListRes.json();
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]).toMatchObject({ id: note1.id, role: "viewer" });
  });

  it("未登入 → 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/notes" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/notes/:id", () => {
  it("未分享者 → 404 not_found（不是 403）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get@example.com" });
    const stranger = await insertUser(db, { email: "stranger-get@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("viewer → 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get2@example.com" });
    const viewer = await insertUser(db, { email: "viewer-get2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: viewerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, role: "viewer" });
  });

  it("不存在的 noteId → 404", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({
      method: "GET",
      url: "/api/notes/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("noteId 非 UUID 格式 → 404（route 層驗證 resolveRole 的 UUID guard 真的接上，不 500）", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db);
    const cookie = await cookieFor(user.id);
    const res = await app.inject({ method: "GET", url: "/api/notes/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/notes/:id", () => {
  it("viewer → 403 forbidden", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch@example.com" });
    const viewer = await insertUser(db, { email: "viewer-patch@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: viewerCookie },
      payload: { title: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("editor → 200，updatedAt 變大", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch2@example.com" });
    const editor = await insertUser(db, { email: "editor-patch2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "Edited by editor" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ title: "Edited by editor", role: "editor" });
    expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(note.updatedAt));
  });

  it("空 title → 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("無權限者 → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-patch3@example.com" });
    const stranger = await insertUser(db, { email: "stranger-patch3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
      payload: { title: "Nope" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/notes/:id", () => {
  it("editor → 403 forbidden；beforeNoteDeleted 未被呼叫（授權失敗須早於 collab teardown，不能被當成 DoS 面利用）", async () => {
    const beforeNoteDeleted = vi.fn(async () => {});
    const collabHooks: CollabHooks = { onShareChanged: vi.fn(), onUserRevoked: vi.fn(), beforeNoteDeleted };
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-del@example.com" });
    const editor = await insertUser(db, { email: "editor-del@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: editorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("非相關者 → 404；beforeNoteDeleted 未被呼叫（同上，無權限者不該觸發任何 collab teardown 副作用）", async () => {
    const beforeNoteDeleted = vi.fn(async () => {});
    const collabHooks: CollabHooks = { onShareChanged: vi.fn(), onUserRevoked: vi.fn(), beforeNoteDeleted };
    const { app, db } = await buildTestApp({ collabHooks });
    const owner = await insertUser(db, { email: "owner-del2@example.com" });
    const stranger = await insertUser(db, { email: "stranger-del2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(404);
    expect(beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("owner → 204，關聯表（note_states/note_state_backups/note_shares/note_links/uploads）清空，再 GET 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del3@example.com" });
    const linkedUser = await insertUser(db, { email: "linked-del3@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    const otherRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const otherNote = otherRes.json();

    // 手動塞好每個關聯表至少一列，驗證 DELETE 交易確實清空這些表（不是只砍 notes 靠
    // schema 的 FK cascade「順便」清掉——binding 規格要求交易內明確依序刪除）。
    await db.insert(noteStates).values({ noteId: note.id, ydoc: Buffer.from("state") });
    await db.insert(noteStateBackups).values({ noteId: note.id, ydoc: Buffer.from("backup") });
    await db.insert(noteShares).values({ noteId: note.id, userId: linkedUser.id, role: "viewer" });
    await db.insert(noteLinks).values({ sourceNoteId: note.id, targetNoteId: otherNote.id });
    await db.insert(noteLinks).values({ sourceNoteId: otherNote.id, targetNoteId: note.id });
    await db.insert(uploads).values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 100 });

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(delRes.statusCode).toBe(204);

    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, note.id))).toHaveLength(0);
    expect(await db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).toHaveLength(0);
    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, note.id))).toHaveLength(0);
    expect(
      await db.select().from(noteLinks).where(or(eq(noteLinks.sourceNoteId, note.id), eq(noteLinks.targetNoteId, note.id)))
    ).toHaveLength(0);
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toHaveLength(0);
    expect(await db.select().from(notes).where(eq(notes.id, note.id))).toHaveLength(0);

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(getRes.statusCode).toBe(404);
  });

  it("beforeNoteDeleted 於交易前被 await：hook 內查 DB 時 notes 列仍存在", async () => {
    // dbRef 是個可變的 box：beforeNoteDeleted 這個 vi.fn 在 buildTestApp() 回傳「真正
    // 要用的 db」之前就已經被定義（它要作為 overrides 傳進 buildTestApp），只能靠這個
    // box 延遲取得 db——box 本身用 const（只指派一次），box.current 才是可變欄位。
    const dbRef: { current: Db | undefined } = { current: undefined };
    const beforeNoteDeleted = vi.fn(async (noteId: string) => {
      const rows = await dbRef.current!.select().from(notes).where(eq(notes.id, noteId));
      expect(rows).toHaveLength(1);
    });
    const collabHooks: CollabHooks = { onShareChanged: vi.fn(), onUserRevoked: vi.fn(), beforeNoteDeleted };

    const built = await buildTestApp({ collabHooks });
    dbRef.current = built.db;
    const { app, db } = built;

    const owner = await insertUser(db, { email: "owner-del4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(204);
    expect(beforeNoteDeleted).toHaveBeenCalledTimes(1);
    expect(beforeNoteDeleted).toHaveBeenCalledWith(note.id);
  });

  it("beforeNoteDeleted throw → 交易不執行（notes 仍存在）", async () => {
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      beforeNoteDeleted: vi.fn(async () => {
        throw new Error("collab teardown failed");
      }),
    };
    const { app, db } = await buildTestApp({ collabHooks });

    const owner = await insertUser(db, { email: "owner-del5@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(res.statusCode).toBe(500);

    const rows = await db.select().from(notes).where(eq(notes.id, note.id));
    expect(rows).toHaveLength(1);
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}` });
    expect(res.statusCode).toBe(401);
  });
});
