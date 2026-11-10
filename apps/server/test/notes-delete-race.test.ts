/**
 * #188：單篇 `DELETE /api/notes/:id` × 上傳的交錯（比照 `groups-v2-delete-race.test.ts` 的 C22，群組全刪形）。
 * #181 起 DELETE 是移到垃圾桶：`trashNotesInTx` 第一步對筆記列取 `FOR UPDATE`；上傳交易（`insertUploadInTx`）以
 * `SELECT … WHERE deleted_at IS NULL FOR KEY SHARE` 讀那篇筆記列，與 FOR UPDATE 互斥 → 等移入 commit 後重評條件不成立 → 0 列 →
 * TxAbort 404 not_found（路由先 unlink）。移入不刪 uploads，所以「孤兒檔」那一形只剩永久刪除（垃圾桶筆記本來就上傳不了：授權即 none）。
 */
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { notes, uploads } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedNote, seedUser, sleep, spyCollabHooks } from "./group-helpers.js";
import { PNG, seedUpload } from "./copy-helpers.js";

const BOUNDARY = "kbNoteDeleteRaceBoundary";
/** 單一 PNG file part 的 multipart body（同 `uploads.test.ts` 的手組形）。 */
function pngMultipart(): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    PNG,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8"),
  ]);
}
const upload = async (app: FastifyInstance, noteId: string, userId: string) =>
  app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    cookies: await cookieOf(userId),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: pngMultipart(),
  });

/** 等到這個測試 DB 上至少有 `n` 條連線在等鎖，或 `other` 已結束（同 `groups-v2-delete-race.test.ts` 的 `waitForWaiters`）。 */
async function waitForWaiters(pool: Pool, n: number, other?: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
  let settled = false;
  void other?.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled) return "settled";
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n >= n) return "blocked";
    await sleep(20);
  }
  throw new Error(`waitForWaiters(${n}) 逾時（${timeoutMs}ms）`);
}

describe("#188 單篇刪除 × 上傳", () => {
  it("單篇 DELETE（移入垃圾桶）持筆記 FOR UPDATE 時上傳到同一篇 → 上傳交易的筆記 KEY SHARE 讀等移入 commit → 移入 204、上傳 404 not_found（讀到 0 列 → TxAbort，路由已 unlink）；uploads 只剩原本那列、磁碟沒有孤兒檔", async () => {
    // 把移入交易停在「已持筆記 FOR UPDATE、還沒 UPDATE」（`note-trash-locked` 縫）：在這個窗裡發上傳——上傳的授權在交易外，
    // 此時筆記還活著所以通過；交易內 `FOR KEY SHARE` 讀與 FOR UPDATE 互斥 → 等移入 commit 後 `deleted_at IS NULL` 不成立 → 404。
    // 縫裡**不等**上傳結束（它正等這個交易的鎖），只等它卡進鎖等待。
    // 鑑別：拿掉 `trashNotesInTx` 的 FOR UPDATE 時本案先紅在 interleave 斷言（上傳沒被擋、`settled`）。
    const holder: { app?: FastifyInstance; pool?: Pool; noteId?: string; userId?: string; up?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async point => {
        if (point !== "note-trash-locked" || holder.up) return;
        holder.up = upload(holder.app!, holder.noteId!, holder.userId!);
        holder.interleave = await waitForWaiters(holder.pool!, 1, holder.up);
      },
    });
    const pool = db.$client;
    const a = await seedUser(db);
    const n = await seedNote(db, { ownerId: a.id });
    const u0 = await seedUpload(db, uploadsDir, n.id, a.id);
    Object.assign(holder, { app, pool, noteId: n.id, userId: a.id });

    const delRes = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id) });
    const upRes = await holder.up!;

    expect(holder.interleave).toBe("blocked");
    expect(delRes.statusCode).toBe(204);
    expect(upRes.statusCode).toBe(404);
    // 與「筆記本來就不存在」的 404 逐位元組相同（uploads.test.ts 的 404 案同形）。
    const missing = await upload(app, "22222222-2222-2222-2222-222222222222", a.id);
    expect(missing.statusCode).toBe(404);
    expect(upRes.body).toBe(missing.body);
    expect((await db.select({ deletedAt: notes.deletedAt }).from(notes))[0]?.deletedAt).not.toBeNull();
    expect((await db.select({ id: uploads.id }).from(uploads)).map(r => r.id)).toEqual([u0]);
    expect(await readdir(uploadsDir)).toEqual([u0]);
  });
});
