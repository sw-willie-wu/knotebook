import { describe, it, expect } from "vitest";
import { EMPTY_YDOC_UPDATE_B64, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, freshDb, testConfig } from "./helpers.js";
import { noteShares, noteStates, notes, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { UserGate, signSession } from "../src/auth/session.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { uploadFilePath } from "../src/uploads/service.js";
import { AI_LIMIT, COLLAB_TOKEN_LIMIT, FixedWindowLimiter, OIDC_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT, PUBLIC_UPLOAD_LIMIT, SLUG_PATCH_LIMIT, UPLOAD_LIMIT } from "../src/http/rate-limit.js";

/**
 * #72 公開分享連結。本檔隨 Task 1a/1b/1c 逐步擴充——目前涵蓋**管理端三支（1a）
 * ＋公開兩端點與三步節流（1b）＋log 遮罩（1c）**。
 *
 * 錯誤慣例照 shares 端點（routes/notes.ts 註解明訂、三支一致）：resolveRole 為
 * none → 404 not_found（不可分辨「不存在」與「無權限」）、可讀但非 owner → 403。
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function insertUser(db: Db, email: string) {
  const [u] = await db.insert(users).values({ email, displayName: "Test User" }).returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv: 0 });
}

async function createNote(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("公開連結管理端（GET/PUT/DELETE /api/notes/:id/public-link）", () => {
  it("owner：初始 GET null → PUT 產生 43 字元 token → GET 讀回同一顆 → 再 PUT 重生換新 → DELETE 後 GET null", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);

    const g0 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g0.statusCode).toBe(200);
    expect(g0.json()).toEqual({ token: null, slug: null });

    const p1 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(p1.statusCode).toBe(200);
    const token1 = p1.json().token as string;
    expect(token1).toMatch(TOKEN_RE);

    const g1 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g1.json()).toEqual({ token: token1, slug: null });

    // 重生：token 必換（PUT 語意＝每次都重生）
    const p2 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    const token2 = p2.json().token as string;
    expect(token2).toMatch(TOKEN_RE);
    expect(token2).not.toBe(token1);

    const d = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(d.statusCode).toBe(204);
    const g2 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g2.json()).toEqual({ token: null, slug: null });

    // DELETE 對 token 狀態冪等：已是 null 再 DELETE 照樣 204（404 只留給 note 本身
    // 不見了的 I2 情境）。
    const d2 = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(d2.statusCode).toBe(204);
  });

  it("可讀非 owner（editor/viewer）→ 403；毫無關係者 → 404；三個動詞同慣例", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl2@example.com");
    const editor = await insertUser(db, "editor-pl2@example.com");
    const viewer = await insertUser(db, "viewer-pl2@example.com");
    const stranger = await insertUser(db, "stranger-pl2@example.com");
    const ownerCookie = await cookieFor(owner.id);
    const noteId = await createNote(app, ownerCookie);
    await db.insert(noteShares).values([
      { noteId, userId: editor.id, role: "editor" },
      { noteId, userId: viewer.id, role: "viewer" },
    ]);

    const runMatrix = async () => {
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        for (const [user, expected, code] of [
          [editor, 403, "forbidden"],
          [viewer, 403, "forbidden"],
          [stranger, 404, "not_found"],
        ] as const) {
          const res = await app.inject({
            method,
            url: `/api/notes/${noteId}/public-link`,
            cookies: { [SESSION_COOKIE]: await cookieFor(user.id) },
          });
          expect(res.statusCode, `${method} as ${user.email}`).toBe(expected);
          expect(res.json().error.code, `${method} as ${user.email}`).toBe(code);
        }
      }
    };

    // 無副作用鑑別（審查抓的洞）：403/404 只回錯誤還不夠——若寫入被挪到授權判定
    // 之前，非 owner 的 PUT/DELETE 照樣回 403/404 但 token 已被重生/撤銷。矩陣
    // 前後各用 owner 的 GET 釘住 token 狀態：先在無 token 態跑（結束仍 null），
    // 再由 owner 開一顆後重跑（結束仍是同一顆）。
    await runMatrix();
    const gNull = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(gNull.json()).toEqual({ token: null, slug: null });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    const ownerToken = put.json().token as string;
    await runMatrix();
    const gAfter = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(gAfter.json()).toEqual({ token: ownerToken, slug: null });
  });

  it("節流只掛 PUT/DELETE（10/10min，key=userId）：GET 開 11 次全 200；PUT+DELETE 合計超過 10 次 → 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl3@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);

    // GET 不吃桶：11 次全 200（dialog 開 11 次是正常操作）
    for (let i = 0; i < 11; i += 1) {
      const g = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
      expect(g.statusCode).toBe(200);
    }

    // PUT×5 + DELETE×5 = 10 次落在額度內，第 11 次（PUT）429
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(204);
    }
    const over = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");

    // key=userId 的鑑別（審查突變 D 證實原版守不住）：
    // ① 同一 user 的**另一篇**筆記照樣 429——key 若誤寫成 noteId 這裡會 200，而
    //    per-note key＋consume 先於授權＝任何登入者可把別人的管理端鎖 10 分鐘。
    const note2 = await createNote(app, cookie);
    const otherNote = await app.inject({ method: "PUT", url: `/api/notes/${note2}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(otherNote.statusCode).toBe(429);
    // ② 另一位 user 自己的筆記 200——key 若誤寫成全域常數這裡會 429。
    const other = await insertUser(db, "owner2-pl3@example.com");
    const otherCookie = await cookieFor(other.id);
    const otherOwned = await createNote(app, otherCookie);
    const otherPut = await app.inject({ method: "PUT", url: `/api/notes/${otherOwned}/public-link`, cookies: { [SESSION_COOKIE]: otherCookie } });
    expect(otherPut.statusCode).toBe(200);
  });

  it("consume 早於授權：陌生人的 404 照樣吃他自己的桶（第 11 次是 429 不是 404）", async () => {
    // 註解花最多篇幅論證的那條不變量（審查突變 D5 證實原本沒有測試守著）：順序
    // 反過來的話，任何登入者可對隨機 noteId 無限打 PUT，每次觸發 resolveRole 的
    // DB 查詢而完全不受節流。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl4@example.com");
    const stranger = await insertUser(db, "stranger-pl4@example.com");
    const noteId = await createNote(app, await cookieFor(owner.id));
    const sc = await cookieFor(stranger.id);
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: sc } }))
          .statusCode,
      ).toBe(404);
    }
    const over = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: sc } });
    expect(over.statusCode).toBe(429); // consume 若移到授權之後，這裡會是 404
  });
});

// ──────────────────── #122 PR3 Task 2：公開別名管理端 ────────────────────

describe("公開別名管理端（PUT/DELETE /api/notes/:id/public-link/slug）", () => {
  /** owner 建一篇並開公開，回 [noteId, token]。 */
  async function publicNote(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string): Promise<[string, string]> {
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);
    return [noteId, token];
  }
  const putSlug = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string, slug: string) =>
    app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug } });
  const delSlug = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string) =>
    app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie } });
  const getLink = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string) =>
    app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

  it("owner 全流程：設別名回 {token, slug} 全形 → GET 同形 → DELETE slug 204（token 留）→ 冪等 204", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps1@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId, token] = await publicNote(app, cookie);

    const p = await putSlug(app, cookie, noteId, "my-alias");
    expect(p.statusCode).toBe(200);
    // 全形釘住（gate r4-M1）：web mutation 直寫回應進快取，token 缺席＝快取 token 被
    // 抹成 undefined→公開連結列消失。
    expect(p.json()).toEqual({ token, slug: "my-alias" });

    const g = await getLink(app, cookie, noteId);
    expect(g.json()).toEqual({ token, slug: "my-alias" });

    const d = await delSlug(app, cookie, noteId);
    expect(d.statusCode).toBe(204);
    const g2 = await getLink(app, cookie, noteId);
    expect(g2.json()).toEqual({ token, slug: null }); // token 不動，只清別名

    // 冪等：本無別名再 DELETE 照樣 204
    expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
  });

  it("未公開（token NULL）設別名 → 400 invalid_body 且 DB 無殘留（rowcount-0 路徑的行為級殺手）", async () => {
    // 取消 token pre-read 後（plan r3-m1），這一案直接走「條件式 UPDATE 述詞不成立→
    // rowcount 0→400」——同時殺「刪 public_token is not null 述詞」（會變 200）與
    // 「忽略 rowcount 照回 200」兩類突變。
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie); // 不開公開
    const r = await putSlug(app, cookie, noteId, "early-alias");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_body");
    const [row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row.publicSlug).toBeNull(); // 述詞擋下＝零殘留列
  });

  it("owner 矩陣（editor/viewer→403、stranger→404，PUT/DELETE 同慣例）＋無副作用鑑別", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps3@example.com");
    const editor = await insertUser(db, "editor-ps3@example.com");
    const viewer = await insertUser(db, "viewer-ps3@example.com");
    const stranger = await insertUser(db, "stranger-ps3@example.com");
    const ownerCookie = await cookieFor(owner.id);
    const [noteId, token] = await publicNote(app, ownerCookie);
    await db.insert(noteShares).values([
      { noteId, userId: editor.id, role: "editor" },
      { noteId, userId: viewer.id, role: "viewer" },
    ]);
    expect((await putSlug(app, ownerCookie, noteId, "kept-alias")).statusCode).toBe(200);

    for (const [user, expected, code] of [
      [editor, 403, "forbidden"],
      [viewer, 403, "forbidden"],
      [stranger, 404, "not_found"],
    ] as const) {
      const c = await cookieFor(user.id);
      const p = await putSlug(app, c, noteId, "hijack");
      expect(p.statusCode, `PUT as ${user.email}`).toBe(expected);
      expect(p.json().error.code).toBe(code);
      const d = await delSlug(app, c, noteId);
      expect(d.statusCode, `DELETE as ${user.email}`).toBe(expected);
      expect(d.json().error.code).toBe(code);
    }
    // 無副作用鑑別（比照 public-link 矩陣）：403/404 的 PUT/DELETE 不得動到別名
    const g = await getLink(app, ownerCookie, noteId);
    expect(g.json()).toEqual({ token, slug: "kept-alias" });
  });

  it("409 public_slug_taken：同 owner 兩篇撞別名；跨 owner 同名共存；且與私人 slug 不互佔", async () => {
    const { app, db } = await buildTestApp();
    const a = await insertUser(db, "owner-a-ps4@example.com");
    const b = await insertUser(db, "owner-b-ps4@example.com");
    const ca = await cookieFor(a.id);
    const cb = await cookieFor(b.id);
    const [noteA1] = await publicNote(app, ca);
    const [noteA2] = await publicNote(app, ca);
    const [noteB] = await publicNote(app, cb);

    expect((await putSlug(app, ca, noteA1, "team-doc")).statusCode).toBe(200);
    const clash = await putSlug(app, ca, noteA2, "team-doc");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("public_slug_taken");
    // 無部分寫入（讀碼審 m4）：單條 UPDATE 的原子性下 409＝零落地——若未來改成
    // pre-check＋分步寫，這兩行是唯一會抓到殘影的地方
    const [a2row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteA2)).limit(1);
    expect(a2row.publicSlug).toBeNull();
    const [a1row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteA1)).limit(1);
    expect(a1row.publicSlug).toBe("team-doc");
    // 跨 owner 同名：per-user 語意
    expect((await putSlug(app, cb, noteB, "team-doc")).statusCode).toBe(200);
    // 同 owner 的**私人** slug 同名不佔別名命名空間（欄位獨立；migrate.test 有 DB 層案，
    // 這裡釘端點層沒偷加跨欄 pre-check）
    const patch = await app.inject({ method: "PATCH", url: `/api/notes/${noteA2}`, cookies: { [SESSION_COOKIE]: ca }, payload: { slug: "team-doc" } });
    expect(patch.statusCode).toBe(200);
  });

  it("驗證漏斗與 PATCH slug 同源：畸形 body/保留字/uuid 形/非法 → 400 且**耗桶**；大小寫混合 → 正規化成小寫", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps5@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    // 桶算術（SLUG_PATCH_LIMIT=10，先計後驗＝400 也計）：畸形 body ×2 ＋ 驗證違例
    // ×4 ＋ 合法 ×1 ＋ 驗證違例 ×3 ＝ 10 → 第 11 次（合法）必 429。
    // 突變審 L1：沒有這條尾斷言，「consume 挪到驗證後（400 不耗桶）」全套照綠——
    // 那正是 JSDoc「先計後驗」的反例（登入者可零成本無限打驗證面）。
    // 畸形 body（無 zod schema，手寫守衛——突變審 L3：整段刪掉會變 500 且無人紅）
    for (const payload of [{}, { slug: 123 }]) {
      const r = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    // ⚠ `café` 是**合法**輸入（slug 字元集是 \p{L}\p{N}-，spec §3a 在地化 slug）——
    // 別把它當非法案例；真正的 charset 違例用底線。
    for (const bad of ["new", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "under_score", ""]) {
      const r = await putSlug(app, cookie, noteId, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    const ok = await putSlug(app, cookie, noteId, "MiXeD-Alias");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slug).toBe("mixed-alias");
    for (const bad of ["also_bad", "still_bad", "worse_bad"]) {
      expect((await putSlug(app, cookie, noteId, bad)).statusCode, bad).toBe(400);
    }
    // 第 11 次：合法輸入也 429——400 若不耗桶，這裡會是 200
    const over = await putSlug(app, cookie, noteId, "over-alias");
    expect(over.statusCode).toBe(429);
  });

  it("節流併 slugPatch 桶（交叉計數）：PATCH slug 與別名 PUT/DELETE 合計 10 次後第 11 次 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps6@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    // 交叉消耗同一顆 user 桶：PATCH slug ×4 ＋ 別名 PUT ×3 ＋ 別名 DELETE ×3 ＝ 10
    for (let i = 0; i < 4; i += 1) {
      expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: `pv-${i}` } })).statusCode).toBe(200);
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await putSlug(app, cookie, noteId, `alias-${i}`)).statusCode).toBe(200);
      expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
    }
    // 第 11 次（別名 PUT）——若別名端點誤開自己的桶或併進 publicLink 桶，這裡會 200
    const over = await putSlug(app, cookie, noteId, "alias-over");
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");
    // 反向鑑別：桶滿後 PATCH slug 也 429（同一顆桶的另一面）
    const patchOver = await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pv-over" } });
    expect(patchOver.statusCode).toBe(429);
  });

  it("先授權後扣（與 publicLink 桶相反的紀律）：stranger 連打 404 不耗桶——PUT/DELETE 兩支各釘", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps7@example.com");
    const stranger = await insertUser(db, "stranger-ps7@example.com");
    const [noteId] = await publicNote(app, await cookieFor(owner.id));
    const sc = await cookieFor(stranger.id);
    // 突變審 L2：兩支**分開**灌——只灌 PUT 的話「DELETE 半邊 consume 挪到授權前」
    // 全套照綠（半邊紀律反轉觀測不到）。
    for (let i = 0; i < 12; i += 1) {
      expect((await putSlug(app, sc, noteId, "poke")).statusCode).toBe(404); // 不是 429
      expect((await delSlug(app, sc, noteId)).statusCode).toBe(404);
    }
    // stranger 自己的公開筆記照樣能設＋清別名——24 次 404 都沒吃他的 slugPatch 桶
    const [own] = await publicNote(app, sc);
    expect((await putSlug(app, sc, own, "own-alias")).statusCode).toBe(200);
    expect((await delSlug(app, sc, own)).statusCode).toBe(204);
  });

  it("重生 token 不動別名（回 {token, slug} 全形）；DELETE public-link 清兩者且別名不復活", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps8@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId, token1] = await publicNote(app, cookie);
    expect((await putSlug(app, cookie, noteId, "stable-alias")).statusCode).toBe(200);

    // 重生：token 換、別名留；回應是 {token, slug} 全形（web onSuccess 直寫快取）
    const regen = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(regen.statusCode).toBe(200);
    const token2 = regen.json().token as string;
    expect(token2).toMatch(TOKEN_RE);
    expect(token2).not.toBe(token1);
    expect(regen.json()).toEqual({ token: token2, slug: "stable-alias" });

    // 撤公開：同一支 UPDATE 清 token＋public_slug 兩者
    expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(204);
    expect((await getLink(app, cookie, noteId)).json()).toEqual({ token: null, slug: null });
    const [row] = await db.select({ publicSlug: notes.publicSlug, publicToken: notes.publicToken }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row).toEqual({ publicSlug: null, publicToken: null });

    // 再開公開：別名不復活（「以為刪掉的別名自己回來」是 plan gate M-2 點名的故障形）
    const reopened = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(reopened.json().slug).toBeNull();
  });

  it("語句形狀守衛（雙保險）：別名 PUT 無 token pre-read、恰一條 UPDATE 且述詞含 public_token is not null", async () => {
    // 行為級殺手是「未公開→400」案；這裡再釘語句形（plan gate M-2）：述詞無參數、
    // 必逐字出現在 SQL 文字，防未來有人把閘門搬回 pre-read（TOCTOU 窗重開）。
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // gate 也要跟著換（notes-slug.test 的雷：只換 db 會 401）
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb) });
    const owner = await insertUser(db, "owner-ps9@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    queries.length = 0;
    expect((await putSlug(app, cookie, noteId, "shape-alias")).statusCode).toBe(200);
    const updates = queries.filter(q => /^update/i.test(q.trim()));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/public_token" is not null/);
    // 無 pre-read：resolveRole 之外不得再有讀 public_token/public_slug 的 SELECT
    expect(queries.filter(q => /^select/i.test(q.trim()) && /public_(token|slug)/.test(q))).toHaveLength(0);

    // DELETE 側：恰一條 UPDATE（無條件述詞要求——清 NULL 本就冪等）
    queries.length = 0;
    expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
    expect(queries.filter(q => /^update/i.test(q.trim()))).toHaveLength(1);
  });
});


// ───────────────────────────── Task 1b：公開端點 ─────────────────────────────

/** 全鍵 limiter 物件（三個公開桶可覆寫；其餘取生產常數的新實例）。 */
function limitersWithPublic(overrides: Partial<Record<"publicMiss" | "publicNote" | "publicUpload", FixedWindowLimiter>> = {}) {
  return {
    collabToken: new FixedWindowLimiter(COLLAB_TOKEN_LIMIT),
    slugPatch: new FixedWindowLimiter(SLUG_PATCH_LIMIT),
    upload: new FixedWindowLimiter(UPLOAD_LIMIT),
    ai: new FixedWindowLimiter(AI_LIMIT),
    oidcLogin: new FixedWindowLimiter(OIDC_LIMIT),
    oidcCallback: new FixedWindowLimiter(OIDC_LIMIT),
    publicLink: new FixedWindowLimiter(PUBLIC_LINK_LIMIT),
    publicMiss: overrides.publicMiss ?? new FixedWindowLimiter(PUBLIC_MISS_LIMIT),
    publicNote: overrides.publicNote ?? new FixedWindowLimiter(PUBLIC_NOTE_LIMIT),
    publicUpload: overrides.publicUpload ?? new FixedWindowLimiter(PUBLIC_UPLOAD_LIMIT),
  };
}

async function openPublicLink(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string): Promise<string> {
  const res = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const randomToken = () => randomBytes(32).toString("base64url");

describe("公開內容端（GET /api/public/notes/:token，無需登入）", () => {
  it("有效 token → 200 {title, ydoc}（真實 note_states 位元組的 base64、無 updatedAt 鍵）＋ cache-control: no-store", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const ydocBytes = Buffer.from([1, 2, 3, 4, 5]);
    await db.insert(noteStates).values({ noteId, ydoc: ydocBytes });
    await db.update(notes).set({ title: "公開的筆記" }).where(eq(notes.id, noteId));
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}` }); // 無 cookie
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const bodyJson = res.json();
    expect(bodyJson).toEqual({ title: "公開的筆記", ydoc: ydocBytes.toString("base64") });
    expect(Object.keys(bodyJson)).not.toContain("updatedAt");
  });

  it("查無 note_states（從沒開過編輯器）→ 200 ＋ EMPTY_YDOC_UPDATE_B64（不是 404、不是空字串）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ydoc).toBe(EMPTY_YDOC_UPDATE_B64);
  });

  it("404 三情境**逐位元組同形**（防列舉）：亂 token／已撤銷／格式不符", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub3@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const revoked = await openPublicLink(app, cookie, noteId);
    await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

    const bodies: string[] = [];
    for (const bad of [randomToken(), revoked, "not-a-valid-token"]) {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/${bad}` });
      expect(res.statusCode).toBe(404);
      // shape 斷言（缺了它，路由不存在時 fastify 預設 404 也「三者同形」＝空泛通過）
      expect(res.json().error.code).toBe("not_found");
      bodies.push(res.body);
    }
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
  });

  it("同一 token 的內容請求吃 hit 桶（ip:token）：limit 2 之下第 3 次 429", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub4@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(429);
  });

  it("miss 桶（ip）擋亂數 token 洪水，且**預檢對有效 token 一視同仁**（oracle 前提）", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub5@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    // 兩發亂 token 吃滿 miss 桶
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    // 第三發亂 token：429（大量相異 token 不免疫——miss 桶 key=ip 不含 token）
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
    // **有效 token 此刻同樣 429**：pre-DB 預檢對命中與未命中一視同仁，429 不成為
    // 存在性 oracle（攻擊者拿不到區分）。
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(429);
  });

  it("格式 guard 先於 limiter：超長/非法輸入回 404 且不進 miss 桶", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub6@example.com");
    const cookie = await cookieFor(owner.id);
    await createNote(app, cookie);

    // 非法格式 ×3：全 404、非 429（沒 consume）——guard 若在 limiter 之後，第 2 發
    // 起就是 429；超長字串也不會成為 BoundedMap 的 key。
    const oversized = "A".repeat(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: `/api/public/notes/${oversized}` })).statusCode).toBe(404);
    }
    // 合法格式的亂 token 才 consume：第 1 發 404（吃掉唯一額度）、第 2 發 429
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });

  it("hit 桶 key 含 token：tokenA 打滿（limit 1）不影響 tokenB；key 也含 ip：另一 IP 打同 token 不受影響", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub7@example.com");
    const cookie = await cookieFor(owner.id);
    const noteA = await createNote(app, cookie);
    const noteB = await createNote(app, cookie);
    const tokenA = await openPublicLink(app, cookie, noteA);
    const tokenB = await openPublicLink(app, cookie, noteB);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}` })).statusCode).toBe(429);
    // key 拿掉 token 的退化形（審查抓的洞）：這裡會 429——同代理後讀不同筆記的
    // 讀者互相拖累。
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenB}` })).statusCode).toBe(200);
    // key 拿掉 ip 前綴的退化形：任一讀者可吃光全世界對該筆記的額度——另一 IP
    // 打 tokenA 必須不受 127.0.0.1 那桶影響。
    expect(
      (await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}`, remoteAddress: "10.9.8.7" })).statusCode,
    ).toBe(200);
  });

  it("命中不啃 miss 額度（內容端）：miss limit 1 之下同一有效 token 連打 3 發全 200", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub8@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    // 「DB 命中後仍 consume(ip)」的退化形（spec §2b 點名）：第 2 發就會 429。
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode, `hit ${i}`).toBe(200);
    }
    // miss 額度確實還在：亂 token 第 1 發 404（consume 唯一額度）、第 2 發 429。
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });
});

describe("公開圖片端（GET /api/public/notes/:token/uploads/:uploadId）", () => {
  async function seedUpload(db: Db, uploadsDir: string, noteId: string): Promise<string> {
    const [row] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 3 }).returning();
    await writeFile(uploadFilePath(uploadsDir, row.id), Buffer.from([0x50, 0x4e, 0x47]));
    return row.id;
  }

  it("本篇筆記的 upload → 200＋nosniff＋cache-control private immutable＋mime", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, "owner-pubu1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const uploadId = await seedUpload(db, uploadsDir, noteId);
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${uploadId}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("跨筆記 uploadId → 404（token 只授權自己那篇的 blob），且**記 hit 桶不啃 miss 額度**", async () => {
    const { app, db, uploadsDir } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pubu2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteA = await createNote(app, cookie);
    const noteB = await createNote(app, cookie);
    const uploadOfB = await seedUpload(db, uploadsDir, noteB);
    const tokenA = await openPublicLink(app, cookie, noteA);

    // miss 桶先吃一發（亂 token），確立基準
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    // 跨筆記 404 ×5：全 404 非 429——hit/miss 判準是「token 解得到 noteId」而非
    // 「請求成功」，跨筆記引用是**正常讀者**會產生的 404，落 ip:token 桶（生產
    // 額度）；若誤記 miss（此處 limit 3、已用 1），第 3 發起就會 429。
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}/uploads/${uploadOfB}` });
      expect(res.statusCode, `cross-note attempt ${i}`).toBe(404);
    }
    // miss 額度還剩 2：再兩發亂 token 仍 404、第三發才 429
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });
  it("已撤銷 token ＋ 真實 uploadId → 與連結 404 同形（不是檔案 404）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub9@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const [row] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 3 }).returning();
    await writeFile(uploadFilePath(uploadsDir, row.id), Buffer.from([0x50, 0x4e, 0x47]));
    const token = await openPublicLink(app, cookie, noteId);
    await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

    const viaUpload = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${row.id}` });
    const viaContent = await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` });
    expect(viaUpload.statusCode).toBe(404);
    // 撤銷後 blob 一起失效，且 body 與連結 404 逐位元組同形（token 解析失敗走同
    // 一條 resolvePublicNote——這案把「共用」從閱讀保證變成斷言）。
    expect(viaUpload.body).toBe(viaContent.body);
  });
});


describe("token 不進 log（Task 1c：req serializer 遮罩）", () => {
  it("三條帶 token 的路徑（/p/ HTML fallback＋兩條公開 API）打過之後，整份 log 不含 token 字面量、且含遮罩後的 :token", async () => {
    const captured: string[] = [];
    const webDist = mkdtempSync(path.join(tmpdir(), "knotebook-pub-log-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>t</title>");
    try {
      // 只注入 destination（stream）——**禁止自帶 serializers**：帶了的話斷言的是
      // 測試自己的設定，production（logger: true）零遮罩照樣綠（spec B 不變量）。
      const { app, db } = await buildTestApp(
        {},
        {
          webDist,
          logger: { level: "info", stream: { write: (line: string) => void captured.push(line) } },
        },
      );
      const owner = await insertUser(db, "owner-log1@example.com");
      const cookie = await cookieFor(owner.id);
      const noteId = await createNote(app, cookie);
      const token = await openPublicLink(app, cookie, noteId);

      await app.inject({ method: "GET", url: `/p/${token}`, headers: { accept: "text/html" } });
      // 洩漏變體（審查真 socket 實測抓到）：SPA fallback 對這兩形照樣 200。
      await app.inject({ method: "GET", url: `//p/${token}`, headers: { accept: "text/html" } });
      await app.inject({ method: "GET", url: `/P/${token}`, headers: { accept: "text/html" } });
      await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
      await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/00000000-0000-0000-0000-000000000000` });

      const all = captured.join("");
      // 有在記 log（防「logger 靜默沒開」的空泛通過）且 url 被遮成 :token。
      expect(all).toContain(":token");
      // 核心不變量：token 字面量一個位元組都不出現——這是 D1「存原文」定案的
      // 承重條件①（fastify 預設 req serializer 會印 req.url，靠 buildApp 無條件
      // 合併的遮罩 serializer 擋）。
      expect(all).not.toContain(token);
    } finally {
      rmSync(webDist, { recursive: true, force: true });
    }
  });
});
