import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { eq, or, sql } from "drizzle-orm";
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

  it("刪除交易失敗 → 閘門的 release() 被呼叫（否則閘門會對重連者謊稱「已刪除」兩分鐘）", async () => {
    // 閘門在 beforeNoteDeleted 就開了。交易失敗若不收回去，這篇筆記接下來兩分鐘
    // （DELETING_GATE_TTL_MS）都會對協作者回 note-deleting，client 據此收斂終態並導頁
    // ——而筆記其實還在。
    const release = vi.fn();
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      beforeNoteDeleted: vi.fn(async () => ({ release })),
      linkSyncGate: () => ({ ok: false as const }),
    };
    const { app, db } = await buildTestApp({ collabHooks });

    const owner = await insertUser(db, { email: "owner-del6@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    // 讓刪除交易真的爆掉：拔掉 uploads 表（同一個交易內會 DELETE 它）。
    await db.execute(sql`ALTER TABLE uploads RENAME TO uploads_hidden`);
    try {
      const res = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.execute(sql`ALTER TABLE uploads_hidden RENAME TO uploads`);
    }

    expect(release).toHaveBeenCalledTimes(1);
    // 交易 rollback：筆記還在。
    expect(await db.select().from(notes).where(eq(notes.id, note.id))).toHaveLength(1);
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
    const beforeNoteDeleted = vi.fn(async () => ({ release: () => {} }));
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      beforeNoteDeleted,
      linkSyncGate: () => ({ ok: false as const }),
    };
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
    const beforeNoteDeleted = vi.fn(async () => ({ release: () => {} }));
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      beforeNoteDeleted,
      linkSyncGate: () => ({ ok: false as const }),
    };
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
      return { release: () => {} };
    });
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked: vi.fn(),
      beforeNoteDeleted,
      linkSyncGate: () => ({ ok: false as const }),
    };

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
      beforeNoteDeleted: vi.fn(async (): Promise<never> => {
        throw new Error("collab teardown failed");
      }),
        linkSyncGate: () => ({ ok: false as const }),
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

  it("owner → 204，交易 commit 後補刪已存在的上傳 blob 檔案（Task 11；含跨筆記引用同一 blob 的情況——intended，該檔案仍隨其唯一歸屬的來源筆記一起被刪，見 task-11-brief）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del6@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const [upload] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 4 })
      .returning();
    const filePath = path.join(uploadsDir, upload.id);
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
    expect(existsSync(filePath)).toBe(true);

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(delRes.statusCode).toBe(204);

    expect(await db.select().from(uploads).where(eq(uploads.id, upload.id))).toHaveLength(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("上傳列存在但磁碟檔案已不存在 → DELETE 仍 204（best-effort 補刪失敗僅 log，不炸）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del7@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    // 只塞 DB 列、不寫實際檔案——模擬磁碟上該檔案已經不存在（例如 volume 被清過、手動誤刪）。
    await db.insert(uploads).values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 4 });

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(delRes.statusCode).toBe(204);
  });

  it("blob 補刪必須在交易 commit 之後才執行——commit 前的任何失敗（模擬用強制 rollback）都不能提前刪檔（Task 11 審查 Important-1 護欄：若刪檔被誤放進交易 callback 內，rollback 後 DB 列會復活，但檔案已經永久消失，形成資料與磁碟不一致）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-del8@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const [upload] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: 4 })
      .returning();
    const filePath = path.join(uploadsDir, upload.id);
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

    // 強制交易在 callback（DELETE 交易本體）跑完之後 rollback，模擬「commit 前的任何
    // 失敗」（例如 DB 連線在 commit 那一刻斷線）——不是真的走到我們自己程式碼裡任何
    // 已知分支，純粹是測試替身逼出「callback 已跑完、但整個交易最終沒有 commit」這個
    // 狀態，藉此檢驗「刪檔只能發生在交易確定 commit 之後」這個順序契約本身，而不是檢驗
    // 某個特定的錯誤處理分支。
    //
    // db.transaction 是 drizzle 的泛型 overload（回呼型別與具體 schema/query 型別綁定），
    // 這裡只是包一層「跑完 callback 後強制 throw」的測試替身，逐字對齊完整泛型簽章在這裡
    // 沒有實質好處（同 repo 既有測試替身走 any 的慣例，見
    // apps/web/src/components/wikilink/spec.tsx 等處）。
    /* eslint-disable @typescript-eslint/no-explicit-any -- 見上方註解 */
    const orig = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((cb: any, cfg?: any) =>
      orig(async (tx: any) => {
        await cb(tx);
        throw new Error("forced rollback（測試替身，非真實錯誤）");
      }, cfg)
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */

    try {
      const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
      expect(delRes.statusCode).toBe(500);

      // rollback 生效：uploads 列復活。
      expect(await db.select().from(uploads).where(eq(uploads.id, upload.id))).toHaveLength(1);
      // 檔案未被提前刪除——這是本測試真正要護的契約：刪檔只能發生在 commit 確定成功之後。
      expect(existsSync(filePath)).toBe(true);
    } finally {
      transactionSpy.mockRestore();
    }
  });
});
