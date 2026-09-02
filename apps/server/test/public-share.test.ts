import { describe, it, expect } from "vitest";
import { EMPTY_YDOC_UPDATE_B64, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, freshDb, testConfig } from "./helpers.js";
import { noteShares, noteStates, notes, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { UserGate, signSession } from "../src/auth/session.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import { backfillHandleRegistry } from "../src/auth/handle.js";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadFilePath } from "../src/uploads/service.js";
import { AI_LIMIT, COLLAB_TOKEN_LIMIT, FixedWindowLimiter, OIDC_LIMIT, PUBLIC_LINK_LIMIT, PUBLIC_MISS_LIMIT, PUBLIC_NOTE_LIMIT, PUBLIC_UPLOAD_LIMIT, SLUG_PATCH_LIMIT, UPLOAD_LIMIT } from "../src/http/rate-limit.js";

/**
 * #72 公開分享連結＋#122 PR3 公開別名。涵蓋：管理端五支（token 三支＋別名
 * PUT/DELETE /public-link/slug）、公開四端點（token 形＋別名形各帶 uploads）與
 * 四步節流、log 遮罩。
 *
 * 錯誤慣例照 shares 端點（routes/notes.ts 註解明訂）：resolveRole 為 none →
 * 404 not_found（不可分辨「不存在」與「無權限」）、可讀但非 owner → 403。
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function insertUser(db: Db, email: string, handle?: string) {
  // handle 未指定時吃 DB default（user-<uuid8>）——#122 PR3 的 by-path 案要可預期
  // 的 handle 才能組公開別名網址。
  const [u] = await db.insert(users).values({ email, displayName: "Test User", ...(handle ? { handle } : {}) }).returning();
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

// ──────────────── #122 PR3 Task 3：公開別名端（by-path 雙段） ────────────────

describe("公開別名端（GET /api/public/notes/:handle/:slug，無需登入）", () => {
  const byPath = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], handle: string, slug: string, ip?: string) =>
    app.inject({ method: "GET", url: `/api/public/notes/${handle}/${slug}`, ...(ip ? { remoteAddress: ip } : {}) });
  const byToken = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], token: string, ip?: string) =>
    app.inject({ method: "GET", url: `/api/public/notes/${token}`, ...(ip ? { remoteAddress: ip } : {}) });

  /** owner（指定 handle）＋公開筆記＋別名，回常用把手。 */
  async function aliasSetup(handle: string, alias: string, overrides: Parameters<typeof buildTestApp>[0] = {}) {
    const built = await buildTestApp(overrides);
    const owner = await insertUser(built.db, `${handle}@example.com`, handle);
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(built.app, cookie);
    const token = await openPublicLink(built.app, cookie, noteId);
    const set = await built.app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: alias } });
    expect(set.statusCode).toBe(200);
    return { ...built, owner, cookie, noteId, token };
  }

  it("命中 → 200 與 token 端點**同形**（恰 {title, ydoc} 兩鍵、不回 token）＋ cache-control: no-store", async () => {
    const { app, db, cookie, noteId, token } = await aliasSetup("alice", "my-doc");
    await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Alias Note" } });
    const ydocBytes = randomBytes(24);
    await db.insert(noteStates).values({ noteId, ydoc: ydocBytes });

    const res = await byPath(app, "alice", "my-doc");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // 形狀斷言（plan gate m9）：恰兩鍵——token/noteId/updatedAt 任何一個混進來都紅
    expect(res.json()).toEqual({ title: "Alias Note", ydoc: ydocBytes.toString("base64") });

    // 與 token 端點逐鍵同值（共用 200 回應器的行為面證明）
    const viaToken = await byToken(app, token);
    expect(viaToken.json()).toEqual(res.json());
    expect(viaToken.headers["cache-control"]).toBe("no-store");
  });

  it("三條負向（安全核心）：私人 slug 不可達、prev_slug 不補查、legacy_slug 不查", async () => {
    const { app, db, cookie, noteId } = await aliasSetup("bob", "real-alias");
    // 給同一篇筆記設上私人 slug＋prev＋legacy 三個值，逐一打 by-path 驗 404。
    // ⚠ 兩發 PATCH 必須斷 200（讀碼審 M3）：失敗（節流/驗證回歸）會讓底下三個 404
    // 打在不存在的值上——「安全核心」變 vacuous 而全綠。
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "private-name" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "private-name-2" } })).statusCode).toBe(200); // prev=private-name
    // legacy 由 trigger 凍結（新列恆 NULL）——直接以 raw SQL 暫停 trigger 就地寫入，
    // 讓三個值落在**同一列**（同列才證明「同一篇公開筆記的 legacy 也打不到」）。
    await db.execute(sql`alter table notes disable trigger notes_legacy_slug_guard`);
    await db.update(notes).set({ legacySlug: "old-global-name" }).where(eq(notes.id, noteId));
    await db.execute(sql`alter table notes enable trigger notes_legacy_slug_guard`);
    // fixture 落地覆核（同 M3 動機——三個值真的在場）
    const [row] = await db.select({ slug: notes.slug, prevSlug: notes.prevSlug, legacySlug: notes.legacySlug }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row).toEqual({ slug: "private-name-2", prevSlug: "private-name", legacySlug: "old-global-name" });

    // ① 公開＋有別名，但**私人 slug** 不是公開面（JOIN 打錯欄＝所有公開筆記可被猜）
    expect((await byPath(app, "bob", "private-name-2")).statusCode).toBe(404);
    // ② prev_slug 不補查（照抄私人 by-path 會讓舊值復活）
    expect((await byPath(app, "bob", "private-name")).statusCode).toBe(404);
    // ③ legacy_slug 不查
    expect((await byPath(app, "bob", "old-global-name")).statusCode).toBe(404);
    // 對照組：真正的別名活著（上面三個 404 不是因為整條路由壞掉）
    expect((await byPath(app, "bob", "real-alias")).statusCode).toBe(200);
  });

  it("讀取述詞含 token 非空：直插殘留列（token NULL＋別名非 NULL）→ 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "carol@example.com", "carol");
    // 生產路徑（T2 條件式 UPDATE＋DELETE 清兩者）產不出這形——直插模擬歷史/手動殘留
    await db.insert(notes).values({ ownerId: owner.id, title: "Residue", publicSlug: "ghost" });
    expect((await byPath(app, "carol", "ghost")).statusCode).toBe(404);
  });

  it("撤銷矩陣逐格：撤別名→token 活；重生→別名活、舊 token 死；撤公開→全死", async () => {
    const { app, cookie, noteId, token } = await aliasSetup("dave", "matrix");
    const del = (url: string) => app.inject({ method: "DELETE", url, cookies: { [SESSION_COOKIE]: cookie } });
    const put = (url: string) => app.inject({ method: "PUT", url, cookies: { [SESSION_COOKIE]: cookie } });

    // 撤別名：by-path 死、token 活
    expect((await del(`/api/notes/${noteId}/public-link/slug`)).statusCode).toBe(204);
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(404);
    expect((await byToken(app, token)).statusCode).toBe(200);

    // 設回別名、重生 token：別名活、舊 token 死、新 token 活
    expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "matrix" } })).statusCode).toBe(200);
    const regen = await put(`/api/notes/${noteId}/public-link`);
    const token2 = regen.json().token as string;
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(200);
    expect((await byToken(app, token)).statusCode).toBe(404);
    expect((await byToken(app, token2)).statusCode).toBe(200);

    // 撤公開：全死
    expect((await del(`/api/notes/${noteId}/public-link`)).statusCode).toBe(204);
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(404);
    expect((await byToken(app, token2)).statusCode).toBe(404);
  });

  it("404 **逐位元組同形**：格式 guard 拒／查無／殘留列 三形，並與 token 端點 404 交叉比對", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "erin@example.com", "erin");
    await db.insert(notes).values({ ownerId: owner.id, title: "R", publicSlug: "residue" });

    const tokenMiss = await byToken(app, randomToken());
    const guardReject = await byPath(app, "erin", "bad_slug"); // underscore＝charset 違例
    const noMatch = await byPath(app, "erin", "no-such-alias");
    const residue = await byPath(app, "erin", "residue");
    for (const [name, res] of [["guard", guardReject], ["miss", noMatch], ["residue", residue]] as const) {
      expect(res.statusCode, name).toBe(404);
      expect(res.body, name).toBe(tokenMiss.body); // byte-identical 交叉
    }
  });

  it("大小寫變體：/Frank/X-Doc 正規化後照常命中，且與小寫形共用同一顆 hit 桶額度", async () => {
    const { app } = await aliasSetup("frank", "x-doc", {
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    expect((await byPath(app, "Frank", "X-Doc")).statusCode).toBe(200);
    // 兩個變體解到同一篇筆記 → 同一顆額度（429）。key 綁 noteId 的證明在下一案
    // （跨 owner 同名別名各自桶）——本案只釘「變體不會各開一桶」。
    expect((await byPath(app, "frank", "x-doc")).statusCode).toBe(429);
  });

  it("hit 桶 key 綁 noteId：跨 owner 同名別名各自一桶（key 含 slug 的退化形在此紅）", async () => {
    // 突變審 L1：key 誤寫成 `${ip}:${q.slug}` 時，同 IP 讀兩個 owner 的同名別名會
    // 共用額度——「跨 owner 同名共存」是管理端已釘的合法狀態，公開端不得互相扣。
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    for (const handle of ["ada", "brian"]) {
      const u = await insertUser(db, `${handle}@example.com`, handle);
      const cookie = await cookieFor(u.id);
      const noteId = await createNote(app, cookie);
      await openPublicLink(app, cookie, noteId);
      expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "shared-name" } })).statusCode).toBe(200);
    }
    expect((await byPath(app, "ada", "shared-name")).statusCode).toBe(200);
    expect((await byPath(app, "brian", "shared-name")).statusCode).toBe(200); // key 含 slug 的退化形：429
  });

  it("別名 slug 走 Unicode 漏斗（normalizeSlug 的 NFC＋Unicode 小寫，非 handle 的 ASCII 漏斗）", async () => {
    // 突變審 L3：把 pathSpec.guard 的 normalizeSlug 換成 normalizeHandle（ASCII-only）
    // 全套照綠——PR2 私人 by-path 就補過同款洞（notes-slug.test.ts 的 NFD 案，突變審
    // F2 前科）。管理端以 NFC 存 café；公開網址以 NFD 拼形（e＋U+0301）與 Unicode
    // 大寫形 CAFÉ 都必須命中。**三個 fixture 全用碼位逸出**——字面 é 會被編輯器/
    // 工具鏈自動正規化，NFD 案就靜默變成 NFC 對 NFC 的套套邏輯。
    const { app } = await aliasSetup("nfd-owner", "caf\u00e9"); // NFC
    expect((await byPath(app, "nfd-owner", "cafe\u0301")).statusCode).toBe(200); // NFD 拼形
    expect((await byPath(app, "nfd-owner", "CAF\u00c9")).statusCode).toBe(200); // Unicode 大寫形
  });
  it("節流 key 隔離：同筆記 token 形與 by-path 形各自扣（同一 limiter 實例、key 形不同）", async () => {
    const { app, token } = await aliasSetup("grace", "iso-doc", {
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    // token 形打滿（limit 1）
    expect((await byToken(app, token)).statusCode).toBe(200);
    expect((await byToken(app, token)).statusCode).toBe(429);
    // by-path 形不受影響（key=ip:path:<noteId> vs ip:token）——再打第二發才 429
    expect((await byPath(app, "grace", "iso-doc")).statusCode).toBe(200);
    expect((await byPath(app, "grace", "iso-doc")).statusCode).toBe(429);
  });

  it("miss 共桶：by-path 查無耗 ip 桶，token 形的 miss 下一發即 429（兩形共用 publicMiss）", async () => {
    const { app } = await aliasSetup("heidi", "real-doc", {
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    expect((await byPath(app, "heidi", "no-such")).statusCode).toBe(404); // 耗掉 miss 額度
    expect((await byToken(app, randomToken())).statusCode).toBe(429); // 預檢擋（共桶證明）
  });

  it("格式 guard 先於一切：非法 handle/slug → 404 同形、不進 miss 桶、不打 DB", async () => {
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const { app } = await buildTestApp({
      db: loggedDb,
      gate: new UserGate(loggedDb),
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "ivan@example.com", "ivan");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    await openPublicLink(app, cookie, noteId);

    queries.length = 0;
    // handle 非法（underscore）、slug 非法（保留字 new）、超長段——全 404 且零 DB 查詢
    for (const [h, s] of [["bad_handle", "ok-slug"], ["ivan", "a_b"], ["ivan", "new"], ["x".repeat(200), "y"]] as const) {
      const res = await byPath(app, h, s);
      expect(res.statusCode, `${h}/${s}`).toBe(404);
    }
    expect(queries.filter(q => /^select/i.test(q.trim()))).toHaveLength(0); // 不打 DB
    // 不進桶：miss limit 1 未被上面消耗——真 miss 仍可用（404 而非 429）
    expect((await byPath(app, "ivan", "not-set")).statusCode).toBe(404);
  });

  it("改名互動（spec §5.8 唯一可觀測點）：真實改名後 /p/<舊>/<slug> 404、/p/<新>/<slug> 活", async () => {
    const { app, db, cookie } = await aliasSetup("judy", "moving-doc");
    // 走真實端點（PATCH /api/auth/profile 需要 registry 列——backfill 補登）
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const renamed = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "judy-new" }, cookies: { [SESSION_COOKIE]: cookie } });
    expect(renamed.statusCode).toBe(200);

    expect((await byPath(app, "judy", "moving-doc")).statusCode).toBe(404); // 舊 handle 死（tombstone 不轉發）
    expect((await byPath(app, "judy-new", "moving-doc")).statusCode).toBe(200); // 新 handle 活
  });
});

describe("公開別名圖片端（GET /api/public/notes/:handle/:slug/uploads/:uploadId）", () => {
  async function uploadSetup() {
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "knb-alias-up-"));
    const built = await buildTestApp({ uploadsDir });
    const owner = await insertUser(built.db, "kim@example.com", "kim");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(built.app, cookie);
    await openPublicLink(built.app, cookie, noteId);
    await built.app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pics" } });
    const [up] = await built.db.insert(uploads).values({ noteId, mime: "image/png", size: 4 }).returning();
    await writeFile(uploadFilePath(uploadsDir, up.id), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return { ...built, cookie, noteId, uploadId: up.id, uploadsDir };
  }

  it("本篇 upload → 200＋標頭與 token 版同款（nosniff／private immutable／mime）", async () => {
    const { app, uploadsDir, uploadId } = await uploadSetup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${uploadId}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });

  it("別名 uploads 吃 publicUpload 桶（非 publicNote）：uploads limit 1 第 2 發 429、內容端不受影響", async () => {
    // 突變審 L2：新路由的 limiter 接線沒人釘——貼成 publicNote 桶（60/min vs
    // 300/min）圖片會啃內容端額度，全套照綠。
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "knb-alias-lim-"));
    try {
      const { app, db } = await buildTestApp({
        uploadsDir,
        limiters: limitersWithPublic({ publicUpload: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
      });
      const owner = await insertUser(db, "leo@example.com", "leo");
      const cookie = await cookieFor(owner.id);
      const noteId = await createNote(app, cookie);
      await openPublicLink(app, cookie, noteId);
      await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pics2" } });
      const [up] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 1 }).returning();
      await writeFile(uploadFilePath(uploadsDir, up.id), Buffer.from([0x89]));

      expect((await app.inject({ method: "GET", url: `/api/public/notes/leo/pics2/uploads/${up.id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/public/notes/leo/pics2/uploads/${up.id}` })).statusCode).toBe(429);
      // 兩桶分離：uploads 桶滿不影響內容端（publicNote 桶）
      expect((await app.inject({ method: "GET", url: "/api/public/notes/leo/pics2" })).statusCode).toBe(200);
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });

  it("跨筆記 uploadId → 404；撤別名後同 URL → 連結 404 同形（走同一 resolve 管線）", async () => {
    const { app, db, cookie, noteId, uploadsDir, uploadId } = await uploadSetup();
    try {
      // 跨筆記：另一篇的 upload 打這篇的別名 URL
      const otherNote = await createNote(app, cookie);
      const [foreign] = await db.insert(uploads).values({ noteId: otherNote, mime: "image/png", size: 1 }).returning();
      const cross = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${foreign.id}` });
      expect(cross.statusCode).toBe(404);

      // 撤別名 → 整條 URL 死（含 uploads）——與連結 404 同形
      await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie } });
      const gone = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${uploadId}` });
      expect(gone.statusCode).toBe(404);
      const tokenMiss = await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` });
      expect(gone.body).toBe(tokenMiss.body);
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });
});
