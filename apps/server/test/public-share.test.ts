import { describe, it, expect } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";

/**
 * #72 公開分享連結。本檔隨 Task 1a/1b/1c 逐步擴充——目前涵蓋**管理端三支（1a）**；
 * 公開端與 log 遮罩的案組由後續 commit 補進來。
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
    expect(g0.json()).toEqual({ token: null });

    const p1 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(p1.statusCode).toBe(200);
    const token1 = p1.json().token as string;
    expect(token1).toMatch(TOKEN_RE);

    const g1 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g1.json()).toEqual({ token: token1 });

    // 重生：token 必換（PUT 語意＝每次都重生）
    const p2 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    const token2 = p2.json().token as string;
    expect(token2).toMatch(TOKEN_RE);
    expect(token2).not.toBe(token1);

    const d = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(d.statusCode).toBe(204);
    const g2 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g2.json()).toEqual({ token: null });

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
    expect(gNull.json()).toEqual({ token: null });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    const ownerToken = put.json().token as string;
    await runMatrix();
    const gAfter = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(gAfter.json()).toEqual({ token: ownerToken });
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
