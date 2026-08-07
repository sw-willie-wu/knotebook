import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { MAX_LINK_TARGETS, SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { notes, noteLinks, noteShares, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import type { WriteNoteLinksHooks } from "../src/notes/links.js";

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

/**
 * `linkSyncGate` 恆回 `{ ok: true, clock }`——`buildTestApp` 是整包替換 `collabHooks`
 * （非局部 patch），故一律從 `noopCollabHooks` spread 出去，確保 `onShareChanged` 等其他
 * 成員維持 no-op（brief 契約：測試 stub 一律「完整 CollabHooks spread」）。`clock` 用
 * getter 而非固定值，讓同一個 app 實例可以在單一測試內模擬 client 陸續送出不同 clock
 * 的多次提交（LWW／no-op／並發等情境都需要這個彈性）。
 */
function collabHooksAllowing(getClock: () => number): CollabHooks {
  return { ...noopCollabHooks, linkSyncGate: () => ({ ok: true as const, clock: getClock() }) };
}

async function createNote(db: Db, ownerId: string, title?: string): Promise<{ id: string }> {
  const values = title === undefined ? { ownerId } : { ownerId, title };
  const [row] = await db.insert(notes).values(values).returning({ id: notes.id });
  return row;
}

async function linkedTargets(db: Db, sourceId: string): Promise<string[]> {
  const rows = await db.select({ targetNoteId: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, sourceId));
  return rows.map(r => r.targetNoteId).sort();
}

/** 輪詢直到 `predicate()` 為真，逾時仍未達成則 throw（供下方「並發」測試等待 A 真的抵達 hook）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 逾時（${timeoutMs}ms）`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("POST /api/notes/:id/links", () => {
  it("204，整組取代（第二次提交較小的集合會把多出的舊連結砍掉，不是只累加）", async () => {
    let clock = 1;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links1@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id, b.id] },
    });
    expect(res1.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([a.id, b.id].sort());

    clock = 2;
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([b.id]);

    const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, source.id));
    expect(row?.linksClock).toBe(2);
  });

  it(">= 同 clock 仍受理（LWW）：同一 clock 重送不同集合會覆蓋前一次的內容", async () => {
    const clock = 5;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links2@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id] },
    });
    expect(res1.statusCode).toBe(204);

    // clock 不變（仍是 5），但目標集合換成 b——`<=` 閘門讓同 clock 的重送依然生效。
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([b.id]);
  });

  it("clock 回退 → 204 但 no-op（DB 斷言：note_links 與 links_clock 皆不變）", async () => {
    let clock = 5;
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => clock) });
    const owner = await insertUser(db, { email: "owner-links3@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");

    const res1 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id] },
    });
    expect(res1.statusCode).toBe(204);

    clock = 3; // 比已提交的 5 更舊
    const res2 = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [b.id] },
    });
    expect(res2.statusCode).toBe(204);

    expect(await linkedTargets(db, source.id)).toEqual([a.id]);
    const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, source.id));
    expect(row?.linksClock).toBe(5);
  });

  it("並發兩次相異集合的提交 → B 被 A 的列鎖擋住（無法在 A commit 前抵達寫入點），最終集合恰為其一之完整集合", async () => {
    // 直接證明「clock UPDATE 必為交易第一個寫入語句」這個不變式（而非只用 Promise.all
    // 兩個 app.inject 假裝並發——那種寫法在 pg Pool 對第二個請求要惰性開新連線的情況下，
    // 兩個 inject 之間可能完全不重疊，等價於連續送兩次，測不到任何序列化行為）：
    //
    // 用 `beforeLinkWrite`（命中批次授權查詢之後、寫入 note_links 之前）當探針。A 的第一次
    // 呼叫在此暫停（此時 A 已經跑完自己的 `UPDATE notes SET links_clock=...` 並持有 source
    // 這一列的列鎖，直到 A commit 才釋放）。若程式碼正確（UPDATE 是第一個寫入語句），B 的
    // 交易連自己的 UPDATE 都會被 A 的列鎖卡住——B 的批次授權查詢與 hook 根本執行不到，
    // `bReachedHook` 應該在 A 暫停期間持續是 false。若 mutation 把 UPDATE 移到交易最後，
    // B 不會被卡：hook 會在 A 釋放之前就被呼叫（`bReachedHook` 提早變 true），測試失效。
    let callCount = 0;
    let aReachedHook = false;
    let bReachedHook = false;
    let resolveADeferred: () => void = () => {};
    const aDeferred = new Promise<void>(resolve => {
      resolveADeferred = resolve;
    });

    const hooks: WriteNoteLinksHooks = {
      beforeLinkWrite: async () => {
        callCount += 1;
        if (callCount === 1) {
          aReachedHook = true;
          await aDeferred;
        } else {
          bReachedHook = true;
        }
      },
    };

    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1), linkSyncTestHooks: hooks });
    const owner = await insertUser(db, { email: "owner-links4@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const a = await createNote(db, owner.id, "A");
    const b = await createNote(db, owner.id, "B");
    const c = await createNote(db, owner.id, "C");

    const resAPromise = app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [a.id, b.id] },
    });

    await waitUntil(() => aReachedHook); // A 已跑完 UPDATE、持有列鎖，暫停在自己的 hook 內

    const resBPromise = app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [c.id] },
    });

    // 從這裡開始包 try/finally：任何一個斷言失敗都必須確保 A 被釋放、兩個請求都真的跑完
    // ——否則失敗時 A 會永遠卡在 `await aDeferred`（交易不 commit、不 rollback），佔用
    // pool 的一條連線，直接拖累同檔案下一個測試的 `freshDb()`（`CREATE DATABASE` 等不到
    // 連線而 hang）。這不是假設：C1 review 要求的 mutation 驗證（UPDATE 移到交易最後）
    // 跑過一次，親眼看到這個 hang（下一個 test 卡滿 180s hookTimeout）才補上這段防禦。
    try {
      // 給 B 一段寬裕的時間嘗試推進——B 若真的被 A 的列鎖卡在自己的 UPDATE 上，這段等待
      // 期間無論多久都不會抵達 hook（不是「還沒排到」，是真的被 pg 擋住）；若會抵達，代表
      // UPDATE 不是（或不再是）交易第一個寫入語句，列鎖沒有覆蓋到批次授權/寫入這段。
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(bReachedHook, "B 不應該在 A 釋放列鎖之前就抵達 beforeLinkWrite——代表 UPDATE 沒有序列化後續寫入").toBe(false);

      resolveADeferred();
      const resA = await resAPromise;
      expect(resA.statusCode).toBe(204);

      const resB = await resBPromise;
      expect(resB.statusCode).toBe(204);
      expect(bReachedHook).toBe(true); // A 釋放後 B 才終於能推進到自己的寫入點

      const finalTargets = await linkedTargets(db, source.id);
      const setA = [a.id, b.id].sort();
      const setB = [c.id].sort();
      const isCompleteSetA = JSON.stringify(finalTargets) === JSON.stringify(setA);
      const isCompleteSetB = JSON.stringify(finalTargets) === JSON.stringify(setB);
      expect(
        isCompleteSetA || isCompleteSetB,
        `note_links 最終集合必須恰為兩次提交之一的完整集合，不得是混合結果（實際：${JSON.stringify(finalTargets)}）`
      ).toBe(true);
    } finally {
      resolveADeferred(); // 已經 resolve 過的 promise 再 resolve 一次是安全的 no-op
      await Promise.allSettled([resAPromise, resBPromise]);
    }
  });

  it("批次授權命中後、寫入前 target 被併發刪除（FK race）→ 剔除該 target 重試一次，不 500", async () => {
    const hooks: WriteNoteLinksHooks = {
      // `db` 在下方 buildTestApp 呼叫之後才存在——用閉包延後綁定，見下方立即賦值。
      beforeLinkWrite: async () => {},
    };
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1), linkSyncTestHooks: hooks });
    const owner = await insertUser(db, { email: "owner-links5@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const survivor = await createNote(db, owner.id, "Survivor");
    const doomed = await createNote(db, owner.id, "Doomed");

    // 批次授權查詢已經把 doomed 判定為可連結（此刻它還存在）之後、insert 之前，用另一條
    // 連線（同一個 `db`，但不是交易內的 `tx`——見 links.ts `attemptOnce` 對這個窗口的說明）
    // 直接刪掉它並 commit，讓緊接著的 insert 撞上 foreign_key_violation。
    hooks.beforeLinkWrite = async () => {
      await db.delete(notes).where(eq(notes.id, doomed.id));
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [survivor.id, doomed.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([survivor.id]);
  });

  it("無權存取的 target（陌生人筆記，未分享）→ 靜默過濾，不報錯", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links6@example.com" });
    const stranger = await insertUser(db, { email: "stranger-links6@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const allowed = await createNote(db, owner.id, "Allowed");
    const forbidden = await createNote(db, stranger.id, "Forbidden");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [allowed.id, forbidden.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([allowed.id]);
  });

  it("editor（被分享者）對其有權存取的 target 一樣受理（非僅 owner 專屬）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links7@example.com" });
    const editor = await insertUser(db, { email: "editor-links7@example.com" });
    const editorCookie = await cookieFor(editor.id);
    const source = await createNote(db, owner.id);
    await db.insert(noteShares).values({ noteId: source.id, userId: editor.id, role: "editor" });
    // target 是 editor 自己被分享的另一篇筆記（非 owner）——驗證批次授權查詢的 shared 分支。
    const sharedTarget = await createNote(db, owner.id, "Shared Target");
    await db.insert(noteShares).values({ noteId: sharedTarget.id, userId: editor.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { link_target_ids: [sharedTarget.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([sharedTarget.id]);
  });

  it("self-link（target 指向自己）→ 濾除，不落地成自我連結", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links8@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const other = await createNote(db, owner.id, "Other");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [source.id, other.id] },
    });
    expect(res.statusCode).toBe(204);
    expect(await linkedTargets(db, source.id)).toEqual([other.id]);
  });

  it("非 uuid 格式的 :id → 404（不 500，不洩漏格式錯誤細節）", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links9@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/not-a-uuid/links",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("正規化後目標數超過 MAX_LINK_TARGETS → 400 invalid_body", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links10@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);

    const tooMany = Array.from({ length: MAX_LINK_TARGETS + 1 }, () => randomUUID());
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: tooMany },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await linkedTargets(db, source.id)).toEqual([]);
  });

  it("未登入 → 401", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links11@example.com" });
    const source = await createNote(db, owner.id);

    const res = await app.inject({ method: "POST", url: `/api/notes/${source.id}/links`, payload: { link_target_ids: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("不存在的 note → 404", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links12@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/notes/00000000-0000-0000-0000-000000000000/links",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("viewer（唯讀分享）→ 403", async () => {
    const { app, db } = await buildTestApp({ collabHooks: collabHooksAllowing(() => 1) });
    const owner = await insertUser(db, { email: "owner-links13@example.com" });
    const viewer = await insertUser(db, { email: "viewer-links13@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const source = await createNote(db, owner.id);
    await db.insert(noteShares).values({ noteId: source.id, userId: viewer.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: viewerCookie },
      payload: { link_target_ids: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("linkSyncGate ok:false（noopCollabHooks 預設）→ 409 not_loaded，不落地寫入", async () => {
    const { app, db } = await buildTestApp(); // 預設 noopCollabHooks：linkSyncGate 恆回 { ok: false }
    const owner = await insertUser(db, { email: "owner-links14@example.com" });
    const cookie = await cookieFor(owner.id);
    const source = await createNote(db, owner.id);
    const target = await createNote(db, owner.id, "Target");

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${source.id}/links`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { link_target_ids: [target.id] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(db, source.id)).toEqual([]);
  });
});
