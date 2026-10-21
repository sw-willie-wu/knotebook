/**
 * #286 spec §3.7：`deleteEndedOneTimeLinks` 只刪「結束（用掉／撤銷／過期）超過 30 天」的列，且不等別人的列鎖。
 * 每列各用一位新使用者（避開 I3 的 partial unique index）。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { deleteEndedOneTimeLinks } from "../src/auth/one-time-link-cleanup.js";
import { freshDb } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";

/** 時間欄一律是 SQL 運算式（測試常數，不是使用者輸入）；NULL 寫 `null`。 */
async function insertLink(pool: Pool, t: { created: string; expires: string; used?: string; revoked?: string }): Promise<string> {
  const u = await pool.query(`insert into users (email, display_name) values ($1, 'C') returning id`, [`otc-${randomUUID()}@example.com`]);
  const r = await pool.query(
    `insert into one_time_links (kind, token_hash, target_user_id, created_at, expires_at, used_at, revoked_at)
     values ('password_reset', $1, $2, ${t.created}, ${t.expires}, ${t.used ?? "null"}, ${t.revoked ?? "null"}) returning id`,
    [`h-${randomUUID()}`, u.rows[0].id],
  );
  return r.rows[0].id as string;
}

async function remaining(pool: Pool): Promise<string[]> {
  return (await pool.query(`select id from one_time_links`)).rows.map((r: { id: string }) => r.id).sort();
}

describe("deleteEndedOneTimeLinks（spec §3.7）", () => {
  it("K1：結束時間＝coalesce(used_at, revoked_at, expires_at)，超過 30 天才刪", async () => {
    const { db, pool } = await freshDb();
    const ago = (s: string) => `now() - interval '${s}'`;
    const a = await insertLink(pool, { created: ago("31 days 1 hour"), expires: ago("30 days 23 hours"), used: ago("31 days") });
    const b = await insertLink(pool, { created: ago("31 days 1 hour"), expires: ago("30 days 23 hours"), revoked: ago("31 days") });
    const c = await insertLink(pool, { created: ago("31 days 2 hours"), expires: ago("31 days") });
    const d = await insertLink(pool, { created: ago("29 days 2 hours"), expires: ago("29 days") });
    const e = await insertLink(pool, { created: "now()", expires: "now() + interval '1 hour'" });
    const f = await insertLink(pool, { created: ago("29 days 1 hour"), expires: ago("28 days 23 hours"), used: ago("29 days") });
    // g：31 天前用掉，但 expires_at 只到 29 天前——以用掉的時間起算，應刪
    const g = await insertLink(pool, { created: ago("32 days"), expires: ago("29 days"), used: ago("31 days") });
    // h：31 天前撤銷，但 expires_at 只到 29 天前——以撤銷的時間起算，應刪
    const h = await insertLink(pool, { created: ago("32 days"), expires: ago("29 days"), revoked: ago("31 days") });
    // i：沒用過、沒撤銷，created_at 在 31 天前但 expires_at 只到 29 天前——以到期時間起算，應留
    const i = await insertLink(pool, { created: ago("31 days"), expires: ago("29 days") });
    expect(await remaining(pool)).toEqual([a, b, c, d, e, f, g, h, i].sort());

    await deleteEndedOneTimeLinks(db);
    expect(await remaining(pool)).toEqual([d, e, f, i].sort());
  });

  it("K2 skip locked：別的交易鎖著的已結束列被跳過，清理不等鎖、其餘照刪；放鎖後再跑才刪", async () => {
    const { db, pool } = await freshDb();
    const old = { created: "now() - interval '40 days'", expires: "now() - interval '39 days'" };
    const a = await insertLink(pool, old);
    await insertLink(pool, old);
    const holder = await pool.connect();
    let first: Promise<void> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from one_time_links where id = $1 for update", [a]);
      first = deleteEndedOneTimeLinks(db);
      expect(await waitForBlockedOrSettled(pool, first)).toBe("settled");
      await first;
      expect(await remaining(pool)).toEqual([a]);
    } finally {
      await holder.query("commit");
      holder.release();
      await first?.catch(() => {});
    }
    await deleteEndedOneTimeLinks(db);
    expect(await remaining(pool)).toEqual([]);
  });
});
