import { describe, it, expect } from "vitest";
import { SESSION_COOKIE, canonicalNotePath } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";

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

describe("PATCH /api/notes/:id — slug", () => {
  it("owner 設定 slug → 200，slug 回填", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "my-note" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "my-note" });
  });

  it("owner 清除 slug（slug:null）→ 200，slug 變回 null，且不計入節流器", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "clear-me" },
    });
    expect(setRes.statusCode).toBe(200);

    const clearRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json()).toMatchObject({ slug: null });
  });

  it("NFD 變體 ref 也能查到以 NFC 儲存的 slug（normalizeSlug 兩邊都 NFC 合成後比對）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const nfc = "café"; // é = U+00E9（單一合成字元）
    const nfd = "café"; // e + U+0301（combining acute）—— normalize("NFC") 後與 nfc 相同
    expect(nfd.normalize("NFC")).toBe(nfc);

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: nfc },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().slug).toBe(nfc);

    const res = await app.inject({
      method: "GET",
      url: `/api/notes/${encodeURIComponent(nfd)}`,
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, slug: nfc });
  });

  it("非 owner 矩陣：none → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug4@example.com" });
    const stranger = await insertUser(db, { email: "stranger-slug4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
      payload: { slug: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("非 owner 矩陣：editor 帶 slug → 403（整包拒絕，不因合法 title 而放行）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug5@example.com" });
    const editor = await insertUser(db, { email: "editor-slug5@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "editor-slug5@example.com", role: "editor" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "should not apply", slug: "editor-slug" },
    });
    expect(res.statusCode).toBe(403);

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(getRes.json()).toMatchObject({ title: "Untitled", slug: null });
  });

  it("非 owner 矩陣：editor 只帶 title（不帶 slug）→ 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug6@example.com" });
    const editor = await insertUser(db, { email: "editor-slug6@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "editor-slug6@example.com", role: "editor" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "editor can rename" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "editor can rename", slug: null });
  });

  it("混合 {title,slug} 撞 409 時 title 亦不套用（單一 UPDATE 原子性）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug7@example.com" });
    const cookie = await cookieFor(owner.id);
    const noteA = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "A" } })
    ).json();
    const noteB = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "B" } })
    ).json();

    const takeRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${noteA.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "taken-slug" },
    });
    expect(takeRes.statusCode).toBe(200);

    const conflictRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${noteB.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "B changed", slug: "taken-slug" },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json()).toMatchObject({ error: { code: "slug_taken" } });

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${noteB.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(getRes.json()).toMatchObject({ title: "B", slug: null });
  });

  it("並發同一 slug 恰一 409（不做 pre-check SELECT，交給 DB 唯一索引裁決）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug8@example.com" });
    const cookie = await cookieFor(owner.id);
    const noteA = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const noteB = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const [res1, res2] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/notes/${noteA.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "race-slug" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/notes/${noteB.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "race-slug" },
      }),
    ]);

    const codes = [res1.statusCode, res2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = res1.statusCode === 409 ? res1 : res2;
    expect(conflict.json()).toMatchObject({ error: { code: "slug_taken" } });
  });

  it("非法格式 slug（uuid-like）→ 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug9@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("第 11 次帶非 null slug 的 PATCH → 429 too_many_requests，body 無 retryAfterMs（per-user 10/10分鐘節流）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug10@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: `slug-attempt-${i}` },
      });
    }
    expect(last!.statusCode).toBe(429);
    const body = last!.json();
    expect(body).toEqual({ error: { code: "too_many_requests", message: expect.any(String) } });
    expect(body.retryAfterMs).toBeUndefined();
  });

  it("slug:null 的清除操作不計入節流器——連續 20 次清除不觸發 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug11@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    let last;
    for (let i = 0; i < 20; i++) {
      last = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: null },
      });
    }
    expect(last!.statusCode).toBe(200);
  });
});

describe("GET /api/notes/:ref", () => {
  it("uuid ref 行為不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id });
  });

  it("slug ref 查得到對應筆記", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "ref-lookup" },
    });

    const res = await app.inject({ method: "GET", url: "/api/notes/ref-lookup", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, slug: "ref-lookup" });
  });

  it("查無 slug 且非合法 uuid 格式 → 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref3@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/notes/no-such-slug", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("astral 字元標題組出的 vanity ref（解碼後 UTF-16 長度 > 100）仍可查到（I1：maxParamLength）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref-astral@example.com" });
    const cookie = await cookieFor(owner.id);

    // 𠮷（U+20BB7）是 astral-plane 字元，UTF-16 用 surrogate pair 編碼成 2 code unit，
    // 但 titleSlug 是以 code point 計數截斷（上限 60）——40 個 astral 字沒被截斷，
    // vanity slug 解碼後卻已經是 80 UTF-16 units，加上 `-<uuid>`（37 units）共 117，
    // 超過 find-my-way maxParamLength 預設的 100（且是量「解碼後」的 UTF-16 長度，
    // 不是 code point）。沒有 app.ts 的 maxParamLength: 512 修正，這支測試會在路由層
    // 直接被拒絕（實測 414 URI Too Long，handler 完全不會被呼叫；mutation-check 已
    // 驗證：暫時還原 app.ts 該行會讓下方 expect(200) 收到 414 而失敗）。
    const title = "𠮷".repeat(40);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title } })
    ).json();
    expect(note.slug).toBeNull();

    const path = canonicalNotePath(note); // "/notes/<vanity>-<id>"（無自訂 slug 時的第二態）
    const ref = path.slice("/notes/".length);
    expect(Array.from(ref).length).toBeGreaterThan(60); // 確認真的組出了非平凡的 vanity ref
    expect(ref.length).toBeGreaterThan(100); // 解碼後 UTF-16 長度（find-my-way 量的尺）

    const res = await app.inject({ method: "GET", url: `/api/notes/${encodeURIComponent(ref)}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id });
  });
});

describe("GET /api/notes — 清單含 slug", () => {
  it("清單每筆都帶 slug 欄位（未設定為 null）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-list-slug@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "listed-slug" },
    });

    const res = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([expect.objectContaining({ id: note.id, slug: "listed-slug" })]);
  });
});
