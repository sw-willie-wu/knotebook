/**
 * #175 S14 (c)（spec §12.1、C16 PATCH 形）：以 max=3 的小 pool 起 app，並發 max+1 個自訂 slug 改名（每篇舊 slug 是自訂、
 * 同路徑有轉址列——走 T1 的 DELETE 分支）。全部 200、轉址全刪、之後其他請求照常。pool 設 2 秒借連線逾時：S14 被違反時
 * 表現為 500（gate r5 A-7），而不是把整支測試卡到逾時。hook 在 T1 內當柵欄：等到 3 個交易同時持有連線（或 1 秒）才放行。
 * pool 走生產的 `createPool`（§6.10 保險絲；Task 10 由 Task 6 的 `new Pool(…)` 換過來——plan gate r2 A-N9）。
 */
import { describe, expect, it } from "vitest";
import { noteRedirects } from "../src/db/schema.js";
import { createDb } from "../src/db/index.js";
import { createPool } from "../src/db/pool.js";
import { UserGate } from "../src/auth/session.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { cookieOf, seedNote, seedRedirect, seedUser } from "./group-helpers.js";

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
