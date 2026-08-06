import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Role } from "@knotebook/shared";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { noteShares, notes, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { verifyCollabToken } from "../src/collab/token.js";

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string; tokenVersion: number }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      tokenVersion: overrides.tokenVersion ?? 0,
    })
    .returning();
  return u;
}

async function cookieFor(userId: string, tv = 0): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv });
}

describe("POST /api/notes/:id/collab-token", () => {
  it("owner/editor/viewer 各自得對應 role，body.role 與 token 內 claims 一致", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct1@example.com" });
    const editor = await insertUser(db, { email: "editor-ct1@example.com" });
    const viewer = await insertUser(db, { email: "viewer-ct1@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    await db.insert(noteShares).values({ noteId: note.id, userId: viewer.id, role: "viewer" });

    const cases: Array<{ user: { id: string }; role: Role }> = [
      { user: owner, role: "owner" },
      { user: editor, role: "editor" },
      { user: viewer, role: "viewer" },
    ];

    for (const { user, role } of cases) {
      const cookie = await cookieFor(user.id);
      const res = await app.inject({
        method: "POST",
        url: `/api/notes/${note.id}/collab-token`,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(["role", "token"]);
      expect(body.role).toBe(role);
      expect(typeof body.token).toBe("string");

      const claims = await verifyCollabToken(testConfig.appSecret, body.token);
      expect(claims).toEqual({ noteId: note.id, userId: user.id, role, tv: 0 });
    }
  });

  it("有 session 但無權限（陌生人）→ 200 + role:'none'（絕不 403/404，spec §8-2 關鍵契約）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct2@example.com" });
    const stranger = await insertUser(db, { email: "stranger-ct2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/collab-token`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe("none");
    const claims = await verifyCollabToken(testConfig.appSecret, body.token);
    expect(claims?.role).toBe("none");
  });

  it("不存在的 note（合法 UUID 格式）→ 200 + role:'none'", async () => {
    const { app, db } = await buildTestApp();
    const user = await insertUser(db, { email: "user-ct3@example.com" });
    const cookie = await cookieFor(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/collab-token",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("none");
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} });
    const note = createRes.json();

    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token` });
    expect(res.statusCode).toBe(401);
  });

  it("帳號已停用 → 401（gate.check 自動擋，非本 endpoint 自行判斷）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct5@example.com" });
    const ownerCookie = await cookieFor(owner.id);

    // 直接落地建 note（不經 HTTP），避免先打一次 authenticate 讓 UserGate 把「未停用」
    // 的 row 快取住（TTL 60s）——那樣即使下面把 disabledAt 寫進 DB，這個使用者在本次
    // 測試剩餘時間內都還會命中快取而繼續被判定為「未停用」，401 斷言會失敗，且失敗
    // 原因跟本測試想驗證的「gate.check 自動擋停用帳號」完全無關（是快取語意，不是
    // bug）。同一份 UserGate 實例在真實生產路徑上會由 admin 的 disable endpoint 呼叫
    // `gate.invalidate` 即時清掉快取，這裡直接用「從未查過」達到等效效果，不重造一套
    // admin 路由 harness。
    const [note] = await db.insert(notes).values({ ownerId: owner.id }).returning();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/collab-token`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token version 不符（例如改密碼後舊 cookie）→ 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct6@example.com", tokenVersion: 5 });
    const staleCookie = await cookieFor(owner.id, 0);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/collab-token",
      cookies: { [SESSION_COOKIE]: staleCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("第 61 次請求 → 429 too_many_requests，body 無 retryAfterMs（per-user 60/分鐘節流）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ct7@example.com" });
    const cookie = await cookieFor(owner.id);
    const createRes = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    const note = createRes.json();

    let last;
    for (let i = 0; i < 61; i++) {
      last = await app.inject({ method: "POST", url: `/api/notes/${note.id}/collab-token`, cookies: { [SESSION_COOKIE]: cookie } });
    }
    expect(last!.statusCode).toBe(429);
    const body = last!.json();
    expect(body).toEqual({ error: { code: "too_many_requests", message: expect.any(String) } });
    expect(body.retryAfterMs).toBeUndefined();
  });
});
