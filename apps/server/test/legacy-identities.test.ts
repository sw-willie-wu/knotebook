import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { userIdentities, users } from "../src/db/schema.js";
import { backfillLegacyOidcIdentities } from "../src/auth/legacy-identities.js";

/** 收集 pino 輸出（NDJSON），供斷言 warn 的 msg。 */
function captureLogger(): { logger: pino.Logger; lines: () => Array<{ level: number; msg: string }> } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  return { logger: pino({ level: "info" }, stream), lines: () => chunks.join("").split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}

describe("backfillLegacyOidcIdentities（#187）", () => {
  it("舊碼（回滾期）寫的 users.oidc_* → 補成 identity；冪等；不 warn", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a] = await db.insert(users).values({ email: "a@x", displayName: "A" }).returning();
    // raw SQL 模擬舊碼：users.oidc_* 只有舊碼會寫（新碼一律走 user_identities）。
    await pool.query(`update users set oidc_issuer = 'https://idp.example', oidc_sub = 'sa' where id = $1`, [a!.id]);
    const { logger, lines } = captureLogger();
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 1, conflicts: 0 });
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 0, conflicts: 0 });
    const rows = await db.select().from(userIdentities).where(eq(userIdentities.userId, a!.id));
    expect(rows.map(r => [r.issuer, r.sub])).toEqual([["https://idp.example", "sa"]]);
    expect(lines().filter(l => l.level === 40)).toHaveLength(0);
  });

  it("舊欄指向的身分已屬別人 → 跳過不改資料、warn 一行（users_oidc_idx 唯一，所以「別人」只可能出現在 user_identities 那一側）", async () => {
    const { db } = await buildTestApp();
    const [a] = await db.insert(users).values({ email: "a@x", displayName: "A" }).returning();
    const [b] = await db.insert(users).values({ email: "b@x", displayName: "B" }).returning();
    await db.$client.query(`update users set oidc_issuer = 'https://idp.example', oidc_sub = 'sa' where id = $1`, [a!.id]);
    await db.insert(userIdentities).values({ userId: b!.id, issuer: "https://idp.example", sub: "sa" });
    const { logger, lines } = captureLogger();
    expect(await backfillLegacyOidcIdentities(db, logger)).toEqual({ inserted: 0, conflicts: 1 });
    expect(await db.select().from(userIdentities).where(eq(userIdentities.userId, a!.id))).toHaveLength(0);
    const warns = lines().filter(l => l.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain("belongs to another account");
  });
});
