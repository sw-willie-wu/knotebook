/**
 * #175 S14 (c)（spec §12.1、C16 PATCH 形）：以 max=3 的小 pool 起 app，並發 max+1 個自訂 slug 改名（每篇舊 slug 是自訂、
 * 同路徑有轉址列——走 T1 的 DELETE 分支）。全部 200、轉址全刪、之後其他請求照常。pool 設 2 秒借連線逾時：S14 被違反時
 * 表現為 500（gate r5 A-7），而不是把整支測試卡到逾時。hook 在 T1 內當柵欄：等到 3 個交易同時持有連線（或 1 秒）才放行。
 * pool 走生產的 `createPool`（§6.10 保險絲；Task 10 由 Task 6 的 `new Pool(…)` 換過來——plan gate r2 A-N9）。
 */
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { groups, noteRedirects, notes } from "../src/db/schema.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import { loadNoteAudience } from "../src/notes/service.js";
import { createDb } from "../src/db/index.js";
import type { Db } from "../src/db/index.js";
import { createPool } from "../src/db/pool.js";
import { UserGate } from "../src/auth/session.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRedirect, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";

describe("S14 (c)：PATCH 短交易在小 pool 下不卡死（C16）", () => {
  it("max=3、並發 4 個自訂改名 → 全 200、轉址全刪；之後 GET /api/notes 照常", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 });
    const db = createDb(pool);
    let arrived = 0;
    const barrier = async () => {
      arrived++;
      const deadline = Date.now() + 1_000;
      while (arrived < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    };
    const { app } = await buildTestApp({ db, gate: new UserGate(db), slugPatchTestHook: async point => { if (point === "slug-written") await barrier(); } });
    try {
      const users = await Promise.all(Array.from({ length: 4 }, () => seedUser(target.db)));
      const notesById = await Promise.all(users.map(u => seedNote(target.db, { ownerId: u.id }, { slug: "c", slugIsCustom: true })));
      await Promise.all(users.map((u, i) => seedRedirect(target.db, `/n/${u.handle}/c`, notesById[i]!.id)));
      const results = await Promise.all(users.map(async (u, i) =>
        app.inject({ method: "PATCH", url: `/api/notes/${notesById[i]!.id}`, cookies: await cookieOf(u.id), payload: { slug: "c2" } })));
      expect(results.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(await target.db.select().from(noteRedirects)).toEqual([]);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(users[0]!.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });
});

/**
 * #175 PR4 S14 全刪形（plan Task 5）：`DELETE /api/groups/:id` `{ mode: "delete" }` 的 gate（`beforeNoteDeleted`）在交易之前開完；
 * 交易內只用 tx。假 gate 要**真的借連線**（`loadNoteAudience(db, …)`，生產 gate 同一支，collab/server.ts:938），否則 noop gate
 * 碰不到 pool、這組案量不到 S14。柵欄兩道：① `group-delete-locked`（交易內）等 3 個交易同時持連線（或 1 秒）；
 * ② 假 gate 內等「來自 3 個不同群組」的呼叫同時到達（或 1 秒）——只數呼叫次數的話，每群組 2 篇，3 個呼叫可能只來自 2 個交易。
 */
describe("S14 全刪形：刪群組（delete 模式）在小 pool 下不卡死（PR4）", () => {
  const POOL_OPTS = { databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 } as const;

  /** 假 gate：可選的「N 個不同群組同時到達」柵欄＋真的借連線；記錄開了幾道、release 了幾道。 */
  function makeGate(db: Db, groupOfNote: Map<string, string>, distinctGroups: number) {
    // 以「這篇是第幾次被 gate」分輪：正確碼只有第 0 輪（交易外）。突變「交易外那份留著、交易內再開一次 gate」會多出第 1 輪
    // （交易內、3 個交易同時持連線）；第 1 輪要等 3 個不同群組同時到才放行，才會同時借連線而把 pool 借光。plan 原柵欄（不分輪、
    // 只有一個集合）抓不到這個形：第 0 輪的集合已滿，交易內那輪直接通過、各交易錯開借連線，(a) 的狀態碼全 204，只剩 gate 次數
    // 斷言會紅。分輪柵欄比 plan 原柵欄嚴格；純搬移（gate 從交易外移進交易、不留交易外那份）兩種柵欄都抓得到。
    const roundOf = new Map<string, number>();
    const arrivedByRound = new Map<number, Set<string>>();
    const stat = { opened: 0, released: 0 };
    const beforeNoteDeleted = async (noteId: string) => {
      if (distinctGroups > 0) {
        const round = roundOf.get(noteId) ?? 0;
        roundOf.set(noteId, round + 1);
        const arrived = arrivedByRound.get(round) ?? new Set<string>();
        arrivedByRound.set(round, arrived);
        arrived.add(groupOfNote.get(noteId) ?? noteId);
        const deadline = Date.now() + 1_000;
        while (arrived.size < distinctGroups && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      }
      await loadNoteAudience(db, noteId);
      stat.opened++;
      return { release: () => { stat.released++; } };
    };
    return { beforeNoteDeleted, stat };
  }

  const del = async (app: FastifyInstance, userId: string, groupId: string) =>
    app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });

  it("(a) max=3、並發 4 個全刪（四個群組各 2 篇）→ 全 204、筆記全刪；之後 GET /api/notes 照常", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const groupOfNote = new Map<string, string>();
    const gate = makeGate(db, groupOfNote, 3);
    let inTx = 0;
    const barrier = async () => {
      inTx++;
      const deadline = Date.now() + 1_000;
      while (inTx < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    };
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
      groupTestHook: async point => { if (point === "group-delete-locked") await barrier(); },
    });
    try {
      const users = await Promise.all(Array.from({ length: 4 }, () => seedUser(target.db)));
      const groupIds: string[] = [];
      const noteIds: string[] = [];
      for (const [i, u] of users.entries()) {
        const g = await seedGroup(target.db, `S14-a-${i}`, [{ userId: u.id, role: "admin" }]);
        groupIds.push(g.id);
        for (let k = 0; k < 2; k++) {
          const n = await seedNote(target.db, { groupId: g.id });
          noteIds.push(n.id);
          groupOfNote.set(n.id, g.id);
        }
      }
      const results = await Promise.all(users.map((u, i) => del(app, u.id, groupIds[i]!)));
      expect(results.map(r => r.statusCode)).toEqual([204, 204, 204, 204]);
      expect(await target.db.select({ id: notes.id }).from(notes).where(inArray(notes.id, noteIds))).toEqual([]);
      expect(await target.db.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds))).toEqual([]);
      expect(gate.stat.opened).toBe(8);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(users[0]!.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });

  it("(a') max=3、同一群組並發 4 個全刪 → 恰一個 204、三個 404 not_found；被 404 的請求開的 gate 都 release；之後 GET /api/notes 照常", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const gate = makeGate(db, new Map(), 0);
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
    });
    try {
      const admin = await seedUser(target.db);
      const g = await seedGroup(target.db, "S14-a2", [{ userId: admin.id, role: "admin" }]);
      const ids = [(await seedNote(target.db, { groupId: g.id })).id, (await seedNote(target.db, { groupId: g.id })).id];
      const results = await Promise.all(Array.from({ length: 4 }, () => del(app, admin.id, g.id)));
      const codes = results.map(r => r.statusCode).sort();
      expect(codes).toEqual([204, 404, 404, 404]);
      for (const r of results) if (r.statusCode === 404) expect(r.json().error.code).toBe("not_found");
      expect(await target.db.select({ id: notes.id }).from(notes).where(inArray(notes.id, ids))).toEqual([]);
      // 贏家的 gate 不 release（刪除成功，閘門留給 TTL／刪除本身）；其餘每個請求開的 gate 都 release：
      // 贏家的 P0 恆為那 2 篇（它 commit 之前沒人能刪），所以 released ＝ opened − 2。
      expect(gate.stat.opened).toBeGreaterThanOrEqual(2);
      expect(gate.stat.released).toBe(gate.stat.opened - 2);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(admin.id) });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });

  // (b) 的鑑別力（Task 4–6 review r1 N3；scratch 突變實跑，(a)(a')(b) 全紅：全刪得 500）：它守的是「交易內、lockGroup 之後不得再向 pool 借連線」——
  // 在 T7 的 lockGroup 之後、交易內多借一條連線（對小 pool 做 `select 1`）時，pool 會被借光。
  it("(b) max=3、1 個全刪＋3 個在該群組建筆記的請求（全刪持鎖時才發）→ 全刪 204、建立全 404 group_not_found；之後照常", async () => {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, ...POOL_OPTS });
    const db = createDb(pool);
    const gate = makeGate(db, new Map(), 0);
    const state: { creates?: Array<Promise<LightMyRequestResponse>>; fired?: boolean; interleave?: string } = {};
    let fire: (() => Array<Promise<LightMyRequestResponse>>) | undefined;
    const { app } = await buildTestApp({
      db,
      gate: new UserGate(db),
      collabHooks: { ...noopCollabHooks, beforeNoteDeleted: gate.beforeNoteDeleted },
      groupTestHook: async point => {
        if (point !== "group-delete-locked" || state.fired) return;
        state.fired = true;
        state.creates = fire!();
        // 用 target.pool（不是小 pool）看鎖等待：小 pool 此刻可能已被占滿。
        state.interleave = await waitForBlockedOrSettled(target.db.$client, Promise.race(state.creates));
      },
    });
    try {
      const admin = await seedUser(target.db);
      const g = await seedGroup(target.db, "S14-b", [{ userId: admin.id, role: "admin" }]);
      await seedNote(target.db, { groupId: g.id });
      await seedNote(target.db, { groupId: g.id });
      const cookies = await cookieOf(admin.id);
      fire = () => Array.from({ length: 3 }, () => app.inject({ method: "POST", url: "/api/notes", cookies, payload: { groupId: g.id } }));
      const deleted = await del(app, admin.id, g.id);
      const creates = await Promise.all(state.creates!);
      expect(state.interleave).toBe("blocked");
      expect(deleted.statusCode).toBe(204);
      expect(creates.map(r => r.statusCode)).toEqual([404, 404, 404]);
      for (const r of creates) expect(r.json().error.code).toBe("group_not_found");
      expect(await target.db.select({ id: notes.id }).from(notes).where(eq(notes.groupId, g.id))).toEqual([]);
      const after = await app.inject({ method: "GET", url: "/api/notes", cookies });
      expect(after.statusCode).toBe(200);
    } finally {
      await pool.end();
    }
  });
});
