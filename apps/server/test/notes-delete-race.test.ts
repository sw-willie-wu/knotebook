/**
 * #188：單篇 `DELETE /api/notes/:id` × 上傳的交錯（比照 `groups-v2-delete-race.test.ts` 的 C22，群組全刪形）。
 * `deleteNotesInTx` 先對待刪筆記取 `FOR UPDATE`，之後才 `DELETE uploads … RETURNING`；上傳交易（`insertUploadInTx`）先以
 * `SELECT … FOR KEY SHARE` 讀那篇筆記列，與 FOR UPDATE 互斥 → 等刪除 commit 後讀到 0 列 → TxAbort 404 not_found（路由先 unlink）。
 * 儲存配額 PR1 以前同一把鎖是 INSERT 的 FK 檢查取的（撞 23503 → 404，`b1430b8`）；那條映射仍留作防禦縱深。
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

/** 等到這個測試 DB 上至少有 `n` 條連線在等鎖，或 `other` 已結束（同 C22 的 `waitForWaiters`）。 */
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
  it("單篇 DELETE 持筆記 FOR UPDATE 時上傳到同一篇 → 上傳交易的筆記 KEY SHARE 讀等刪除 commit → 刪除 204、上傳 404 not_found（讀到 0 列 → TxAbort，路由已 unlink）；uploads 0 列、磁碟沒有孤兒檔", async () => {
    // 把刪除交易停在「`deleteNotesInTx` 的 DELETE uploads 還沒做完」：另一條連線先對該篇既有的附件列 u0 取 FOR UPDATE，
    // 刪除的 DELETE uploads 就卡在 u0 上（有 #188 的修法時，此時筆記列的 FOR UPDATE 已到手）。在這個窗裡發上傳：
    // 持筆記 FOR UPDATE 時上傳交易的 `FOR KEY SHARE` 讀 → 互斥 → 等刪除 commit 後 0 列 → 404；沒有那把鎖時上傳直接成功（201），
    // 之後 DELETE uploads 的快照看不到它、DELETE notes 以 CASCADE 帶走它的列——它不在回傳的 upload id 裡，磁碟檔成了孤兒。
    // 鑑別：拿掉 `deleteNotesInTx` 的 FOR UPDATE 時本案先紅在 interleave 斷言（上傳沒被擋、`settled`）。
    const { app, db, uploadsDir } = await buildTestApp({ collabHooks: spyCollabHooks() });
    const pool = db.$client;
    const a = await seedUser(db);
    const n = await seedNote(db, { ownerId: a.id });
    const u0 = await seedUpload(db, uploadsDir, n.id, a.id);

    const c = await pool.connect();
    let del: Promise<LightMyRequestResponse> | undefined;
    let up: Promise<LightMyRequestResponse> | undefined;
    let deleteBlocked: string | undefined;
    let interleave: string | undefined;
    try {
      await c.query("begin");
      await c.query("select id from uploads where id = $1 for update", [u0]);
      del = app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id) });
      deleteBlocked = await waitForWaiters(pool, 1, del);
      up = upload(app, n.id, a.id);
      interleave = await waitForWaiters(pool, 2, up);
    } finally {
      await c.query("commit");
      c.release();
    }
    const delRes = await del!;
    const upRes = await up!;

    expect(deleteBlocked).toBe("blocked");
    expect(interleave).toBe("blocked");
    expect(delRes.statusCode).toBe(204);
    expect(upRes.statusCode).toBe(404);
    // 與「筆記本來就不存在」的 404 逐位元組相同（uploads.test.ts 的 404 案同形）。
    const missing = await upload(app, "22222222-2222-2222-2222-222222222222", a.id);
    expect(missing.statusCode).toBe(404);
    expect(upRes.body).toBe(missing.body);
    expect(await db.select().from(notes)).toEqual([]);
    expect(await db.select().from(uploads)).toEqual([]);
    expect(await readdir(uploadsDir)).toEqual([]);
  });
});
