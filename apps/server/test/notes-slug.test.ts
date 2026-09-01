import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SESSION_COOKIE, validateSlug } from "@knotebook/shared";
import { buildTestApp, freshDb, testConfig } from "./helpers.js";
import { noteShares, notes, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { resolveRoleWithOwner } from "../src/notes/service.js";
import { UserGate, signSession } from "../src/auth/session.js";

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

  it("owner 清除 slug（slug:null）→ 200，回 auto（以 DB 現行 title 算——pre-read 格 4）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Stay Title" } })
    ).json();

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
    // #122 起 slug NOT NULL：清除＝回 auto 形（不帶 title 的格 4——以 DB 現行 title 算）
    expect(clearRes.json()).toMatchObject({ slug: "stay-title" });
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
    // slug 未動＝仍是 POST 時的 DB default（untitled-<uuid8> 形）
    expect(getRes.json()).toMatchObject({ title: "Untitled", slug: note.slug });
  });

  it("非 owner 矩陣：editor 只帶 title（不帶 slug）→ 200，且**會重算 owner 的 auto slug**（spec §5.9 刻意行為）", async () => {
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
    // editor 是受信任協作者、本就有改標題之權——auto slug 跟標題走是同一件事的延伸
    // （無節流、不留 prev；濫用面與「editor 亂改標題」同類屬社交層，spec §5.9 明示取捨）。
    expect(res.json()).toMatchObject({ title: "editor can rename", slug: "editor-can-rename" });
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
    // 單一 UPDATE 原子：409 時 title 與 slug 皆未動（slug 仍是 POST 的 DB default）
    expect(getRes.json()).toMatchObject({ title: "B", slug: noteB.slug });
  });

  it("並發同一 slug 恰一 409（DB 唯一索引裁決；「無 pre-check SELECT」由語句形狀案守著）", async () => {
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

  it("slug:null **計入** slugPatch 節流（#122 意圖反轉：進 slug 分支即計）——第 11 次清除 429", async () => {
    // 舊契約是「清除不計流」；#122 起 {slug:null} 是「回 auto」的實寫入（格 3/4），
    // 與格 1 同桶先計後驗（null 無格式驗）。api.md／CHANGELOG 同步改（spec m4-6）。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug11@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: null },
      });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toMatchObject({ error: { code: "too_many_requests" } });
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

  it("解碼後 UTF-16 長度 > 100 的舊形長 ref 仍可查到（I1：maxParamLength 守衛）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref-astral@example.com" });
    const cookie = await cookieFor(owner.id);

    // #122 起 slug NOT NULL、canonicalNotePath 不再組 `<vanity>-<uuid>` 長 ref——但
    // 舊版產出的長連結**永久活著**（uuid 尾碼解析原樣），maxParamLength: 512 的守衛
    // 不能跟著消失。手組舊形 ref：𠮷（U+20BB7，astral、UTF-16 佔 2 code unit）×40
    // ＝ 80 units，加 `-<uuid>`（37 units）共 117 > find-my-way 預設 100（量的是
    // 「解碼後」UTF-16 長度）。沒有 app.ts 的 maxParamLength: 512，這裡在路由層直接
    // 被拒（實測 414，handler 不會被呼叫；mutation-check 驗過：還原該行→下方 200 變 414）。
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const ref = `${"𠮷".repeat(40)}-${note.id}`;
    expect(ref.length).toBeGreaterThan(100); // 解碼後 UTF-16 長度（find-my-way 量的尺）

    const res = await app.inject({ method: "GET", url: `/api/notes/${encodeURIComponent(ref)}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id });
  });
});

describe("GET /api/notes — 清單含 slug", () => {
  it("清單每筆都帶 slug 欄位（#122 起恆為字串——新列吃 DB default untitled-<uuid8> 形）", async () => {
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

    const plain = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; slug: string }>;
    expect(body.find(n => n.id === note.id)).toMatchObject({ slug: "listed-slug" });
    expect(body.find(n => n.id === plain.id)?.slug).toMatch(/^untitled-[0-9a-f]{8}$/);
  });
});

/**
 * #122 PR2 Task 2：PATCH 分流矩陣（spec §3a）。prev_slug/slug_is_custom 尚未進 DTO
 * （Task 3 才回填），這裡直接查 DB 斷言。
 */
describe("PATCH /api/notes/:id — #122 分流矩陣", () => {
  async function dbRow(db: Db, id: string) {
    const [row] = await db
      .select({ slug: notes.slug, slugIsCustom: notes.slugIsCustom, prevSlug: notes.prevSlug, legacySlug: notes.legacySlug })
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1);
    return row;
  }

  it("prev_slug 只記自訂變更：auto→custom 不記、custom→custom 記、custom→auto 記；legacy 恆不動", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Prev Rules" } })
    ).json();

    // auto→custom：不記 prev（記了會把 untitled-<uuid8> 這種殘渣當歷史）
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "first-custom" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "first-custom", slugIsCustom: true, prevSlug: null, legacySlug: null });

    // custom→custom：記上一個自訂名
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "second-custom" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "second-custom", slugIsCustom: true, prevSlug: "first-custom", legacySlug: null });

    // custom→auto（{slug:null}）：記被放棄的自訂名、custom 翻 false、slug 回 auto
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: null } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "prev-rules", slugIsCustom: false, prevSlug: "second-custom", legacySlug: null });

    // auto 重算（title-only）：prev 不動（打字殘影不得覆蓋掉真正的自訂歷史）
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Prev Rules Renamed" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "prev-rules-renamed", slugIsCustom: false, prevSlug: "second-custom", legacySlug: null });
  });

  it("格 1 同請求帶 title 不觸發重算；此後 title-only PATCH 因 custom=true 不動 slug", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "Changed Title", slug: "pinned" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Changed Title", slug: "pinned" });

    const res2 = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "Changed Again" },
    });
    expect(res2.json()).toMatchObject({ title: "Changed Again", slug: "pinned" });
  });

  it("格 3 {title, slug:null}：以**請求新 title** 算 auto（不是 DB 現行 title）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Old Name" } })
    ).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "was-custom" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "New Name", slug: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "New Name", slug: "new-name" });
  });

  it("探測排除自身：同標題重存 slug 不變（不震盪成 -2）；uuid 形標題退 untitled", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx4@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes" } })
    ).json();

    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes" } });
    expect((await dbRow(db, note.id)).slug).toBe("meeting-notes");
    // 標題微調但 auto slug 相同——述詞不排除本列的話這裡會變 meeting-notes-2（震盪形）
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes!" } });
    expect((await dbRow(db, note.id)).slug).toBe("meeting-notes");

    await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
    });
    expect((await dbRow(db, note.id)).slug).toBe("untitled");
  });

  it("auto 撞名：同 owner 同標題第二篇得 -2 尾碼（永不 409）；跨 owner 同名共存", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx5@example.com" });
    const other = await insertUser(db, { email: "other-mx5@example.com" });
    const cookie = await cookieFor(owner.id);
    const otherCookie = await cookieFor(other.id);

    const a = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } })).json();
    const b = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${a.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } });
    const resB = await app.inject({ method: "PATCH", url: `/api/notes/${b.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } });
    expect(resB.statusCode).toBe(200);
    expect((await dbRow(db, b.id)).slug).toBe("shared-title-2");

    // 跨 owner：per-user 唯一——另一個 owner 的 auto 撞不到我
    const c = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: otherCookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${c.id}`, cookies: { [SESSION_COOKIE]: otherCookie }, payload: { title: "Shared Title" } });
    expect((await dbRow(db, c.id)).slug).toBe("shared-title");

    // 跨 owner 的自訂 slug 也共存（slug_taken 只在同 owner 內）
    const resCustom = await app.inject({
      method: "PATCH",
      url: `/api/notes/${c.id}`,
      cookies: { [SESSION_COOKIE]: otherCookie },
      payload: { slug: "shared-title-2" },
    });
    expect(resCustom.statusCode).toBe(200);
  });

  it("探測上限 20：base 與 -2..-20 全占 → 直接退 untitled-<uuid8>", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx6@example.com" });
    const cookie = await cookieFor(owner.id);
    // 直接 db.insert 佔位（走 API 會吃 slugPatch 10 次/10 分鐘的桶）
    const taken = ["blocked", ...Array.from({ length: 19 }, (_, i) => `blocked-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Blocked" } });
    expect(res.statusCode).toBe(200);
    expect((await dbRow(db, note.id)).slug).toMatch(/^untitled-[0-9a-f]{8}$/);
  });

  it("UPDATE 真競態重試（hook 縫）：連撞 5 次後第 6 次退 untitled-<uuid8>，永不 409", async () => {
    // slugUpdateTestHook 在每輪「探測完、UPDATE 前」被呼叫——在這裡搶插同 owner 同
    // slug 的佔位列，讓 UPDATE 真的撞 (owner_id, slug) 唯一索引（探測本身攔不到）。
    const hookCtx: { db?: Db; ownerId?: string } = {};
    const candidates: string[] = [];
    const hook = async (candidate: string) => {
      candidates.push(candidate);
      if (candidates.length <= 5 && hookCtx.db && hookCtx.ownerId) {
        await hookCtx.db.insert(notes).values({ ownerId: hookCtx.ownerId, title: "sniper", slug: candidate });
      }
    };
    const { app, db } = await buildTestApp({ slugUpdateTestHook: hook });
    const owner = await insertUser(db, { email: "owner-mx7@example.com" });
    const cookie = await cookieFor(owner.id);
    hookCtx.db = db;
    hookCtx.ownerId = owner.id;

    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Race Me" } });
    expect(res.statusCode).toBe(200);
    // 1..5 輪：探測給的候選都被 hook 搶走 → 撞索引重試；第 6 輪退 uuid8 形
    expect(candidates).toHaveLength(6);
    expect(candidates[0]).toBe("race-me");
    expect(candidates[5]).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect((await dbRow(db, note.id)).slug).toBe(candidates[5]);
  });

  it("title-only PATCH **不計** slugPatch 節流（spec §3a 格 2 刻意取捨）——連發 11 次全 200", async () => {
    // TitleInput 的自動存檔走這條路；若誤計流，10 分鐘內第 11 次存檔就 429、
    // 核心編輯路徑掛掉（突變審查 G1：這條產品級行為反轉原本無人看守）。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx8@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { title: `Rename ${i}` },
      });
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(200);
    }
  });

  it("slugPatch 成敗都計：10 次非法格式（400）耗盡額度後，第 11 次合法 slug 也 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx9@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "-invalid-" },
      });
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(400);
    }
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "perfectly-fine" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("探測下邊界：占 base 與 -2..-19 → 得 -20（不是 uuid8）——上限恰為 20 的雙邊夾", async () => {
    // 「探測上限 20」若只從上方夾（全占→uuid8），把上限悄悄改小照樣綠（突變審查 G5）。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx10@example.com" });
    const cookie = await cookieFor(owner.id);
    const taken = ["bound", ...Array.from({ length: 18 }, (_, i) => `bound-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Bound" } });
    expect((await dbRow(db, note.id)).slug).toBe("bound-20");
  });

  it("兩篇同時退位 → 兩個 fallback slug 互異（uuid8 不是固定字串）", async () => {
    // fallbackAutoSlug 改回傳固定值時，第二篇的第 6 次 UPDATE 會撞索引直接 500
    // （突變審查 G6：形斷言 /^untitled-[0-9a-f]{8}$/ 攔不住固定字串）。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx11@example.com" });
    const cookie = await cookieFor(owner.id);
    const taken = ["dead", ...Array.from({ length: 19 }, (_, i) => `dead-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const a = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const b = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${a.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Dead" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${b.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Dead" } })).statusCode).toBe(200);
    const slugA = (await dbRow(db, a.id)).slug;
    const slugB = (await dbRow(db, b.id)).slug;
    expect(slugA).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(slugB).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(slugA).not.toBe(slugB);
  });

  it("去重尾碼重截：長 base（59 字元）撞名 → 總長 ≤60、尾非 dash、過 validateSlug（與 0007 SQL 版同界）", async () => {
    // 「重截基底使總長 ≤60」是 TS/SQL 兩份實作唯一必須對齊的算術；短 base 的去重案
    // 全都測不到它（讀碼審查 M2／突變審查 G4——把 60-suffix.length 改回 60 原本全綠）。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx12@example.com" });
    const cookie = await cookieFor(owner.id);
    const longTitle = "a".repeat(59) + " bbbb"; // autoSlugFromTitle → "a"×59（Task 1 同值）
    await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug: "a".repeat(59) });
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: longTitle } });
    const got = (await dbRow(db, note.id)).slug;
    expect(got).toBe("a".repeat(58) + "-2"); // 58 + '-2' ＝ 恰 60
    expect(Array.from(got).length).toBeLessThanOrEqual(60);
    expect(validateSlug(got)).toBeNull();
  });

  it("語句形狀守衛：格 1 無 pre-check/pre-read、格 3 無 pre-read、格 4 恰一次 pre-read；四格寫入語句各恰一條", async () => {
    // 「不做唯一性 pre-check、單一 UPDATE」是 JSDoc/spec 的承重契約，結果值測試釘不住
    // 語句形狀（加一段 pre-check SELECT 照樣全綠——突變審查 G2）。用 drizzle logger
    // 逐請求收 SQL 字面驗形。
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // gate 也要跟著換——buildTestApp 預設 `new UserGate(db)` 綁它自己的 fresh 庫，
    // 只換 db 會讓 session 驗證查到另一個庫（401）。
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb) });
    const owner = await insertUser(db, { email: "owner-mx13@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape" } })).json();

    const updates = () => queries.filter(q => /^update/i.test(q.trim()));
    // pre-check／探測都長成「select ... where owner_id 且 slug =」的形；pre-read 則是
    // 「select title, slug_is_custom ... where id」——分開數。
    const slugFilteredSelects = () => queries.filter(q => /^select/i.test(q.trim()) && /"slug"\s*=/.test(q));
    const preReads = () => queries.filter(q => /^select/i.test(q.trim()) && /slug_is_custom/.test(q) && !/"slug"\s*=/.test(q));

    // 格 1：無任何 slug 述詞 SELECT（無 pre-check、無探測）、恰一條 UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "shape-custom" } })).statusCode).toBe(200);
    expect(slugFilteredSelects()).toHaveLength(0);
    expect(preReads()).toHaveLength(0);
    expect(updates()).toHaveLength(1);

    // 格 3：{title, slug:null}——無 pre-read（title 已在請求）、恰一條 UPDATE。
    // 順帶讓 slugFilteredSelects 的 regex 自我驗證：本格必有探測（帶 "slug" = 述詞的
    // SELECT）——若 drizzle 換了 SQL 渲染形讓 regex 失配，這行會先紅，格 1 的「==0」
    // 才不會靜默變成恆真。
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape Three", slug: null } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(0);
    expect(slugFilteredSelects().length).toBeGreaterThan(0);
    expect(updates()).toHaveLength(1);

    // 格 2：{title}——恰一次 pre-read（讀 slug_is_custom）、恰一條 UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape Two" } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(1);
    expect(updates()).toHaveLength(1);

    // 格 4：{slug:null}——恰一次 pre-read（讀現行 title）、恰一條 UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: null } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("源碼守衛：src/ 內除 schema.ts 外無 legacySlug 賦值鍵（凍結快照唯一寫入點是 0007 的②）", () => {
    // trigger 是結構層防線（migrate.test 守著）；這裡再釘 app 層——`legacySlug:` 這種
    // 賦值鍵只允許出現在 schema.ts 的欄位定義，src/ 其他任何檔出現＝有人想寫它。
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !p.endsWith(`db${path.sep}schema.ts`)) {
          if (/legacySlug\s*:/.test(readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("resolveRoleWithOwner（notes/service.ts）", () => {
  it("契約：owner/editor 帶真 ownerId；none（陌生人/不存在/非法 id）ownerId=null", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx14@example.com" });
    const editor = await insertUser(db, { email: "editor-mx14@example.com" });
    const stranger = await insertUser(db, { email: "stranger-mx14@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });

    expect(await resolveRoleWithOwner(db, owner.id, note.id)).toEqual({ role: "owner", ownerId: owner.id });
    // editor 拿到的是 **owner 的** id（auto 探測要以 owner 為範圍，不是操作者）
    expect(await resolveRoleWithOwner(db, editor.id, note.id)).toEqual({ role: "editor", ownerId: owner.id });
    // 無權限者連 owner 是誰都不該拿到（JSDoc 契約）
    expect(await resolveRoleWithOwner(db, stranger.id, note.id)).toEqual({ role: "none", ownerId: null });
    expect(await resolveRoleWithOwner(db, owner.id, "00000000-0000-4000-8000-00000000dead")).toEqual({ role: "none", ownerId: null });
    expect(await resolveRoleWithOwner(db, owner.id, "not-a-uuid")).toEqual({ role: "none", ownerId: null });
  });
});
