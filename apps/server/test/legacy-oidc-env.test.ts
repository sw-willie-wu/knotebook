import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { authProviders, siteSettings, userIdentities, users } from "../src/db/schema.js";
import { backfillLegacyOidcIdentities, importLegacyOidcEnv } from "../src/auth/legacy-oidc-env.js";
import { openClientSecret } from "../src/auth/oidc-providers.js";

/** 收集 pino 輸出（NDJSON），供斷言 warn 的 msg。 */
function captureLogger(): { logger: pino.Logger; lines: () => Array<{ level: number; msg: string }> } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  return { logger: pino({ level: "info" }, stream), lines: () => chunks.join("").split("\n").filter(Boolean).map(l => JSON.parse(l)) };
}

const ENV = { issuerUrl: "http://idp.example/", clientId: "knotebook", clientSecret: "env-secret" };
const cfg = (over: Partial<{ legacyOidcEnv: typeof ENV; legacyOidcEnvProblem: "partial" | "invalid" }> = {}) => ({ appSecret: testConfig.appSecret, ...over });

describe("importLegacyOidcEnv（#187 §10.2）", () => {
  it("首次啟動、env 齊全、沒有 provider → 匯入一列（自訂 OIDC、SSO、legacy、enabled、secret 可解）、標記已設；http issuer 警告", async () => {
    const { db } = await buildTestApp();
    const { logger, lines } = captureLogger();
    const out = await importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger);
    expect(out.kind).toBe("imported");
    const rows = await db.select().from(authProviders);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "oidc", displayName: "SSO", issuerUrl: ENV.issuerUrl, clientId: "knotebook", enabled: true, legacyCallback: true, configVersion: 1, resolvedIssuer: null });
    expect(openClientSecret(testConfig.appSecret, rows[0]!)).toBe("env-secret");
    const [s] = await db.select().from(siteSettings);
    expect(s!.legacyOidcEnvHandledAt).not.toBeNull();
    expect(lines().some(l => l.level === 40 && /plain http/i.test(l.msg))).toBe(true);
  });

  it("標記已設 → 不匯入（之後補設 env 也一樣），並 warn「OIDC_* are ignored」", async () => {
    const { db } = await buildTestApp();
    await db.update(siteSettings).set({ legacyOidcEnvHandledAt: new Date() });
    const { logger, lines } = captureLogger();
    expect((await importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger)).kind).toBe("already_handled");
    expect(await db.select().from(authProviders)).toHaveLength(0);
    expect(lines().some(l => l.level === 40 && l.msg.includes("OIDC_* are ignored"))).toBe(true);
  });

  it("已有 provider → 不匯入、仍設標記", async () => {
    const { db } = await buildTestApp();
    await db.insert(authProviders).values({ id: "11111111-1111-1111-1111-111111111111", template: "gitlab", displayName: "GitLab", issuerUrl: "https://gitlab.com", clientId: "c" });
    const { logger } = captureLogger();
    expect((await importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger)).kind).toBe("providers_exist");
    expect(await db.select().from(authProviders)).toHaveLength(1);
    const [s] = await db.select().from(siteSettings);
    expect(s!.legacyOidcEnvHandledAt).not.toBeNull();
  });

  it("半套／不合法 → warn、不 crash、只設標記；沒設 env → 只設標記、不 warn", async () => {
    for (const problem of ["partial", "invalid"] as const) {
      const { db } = await buildTestApp();
      const { logger, lines } = captureLogger();
      expect((await importLegacyOidcEnv(db, cfg({ legacyOidcEnvProblem: problem }), logger)).kind).toBe("nothing_to_import");
      expect(await db.select().from(authProviders)).toHaveLength(0);
      expect(lines().some(l => l.level === 40)).toBe(true);
    }
    const { db } = await buildTestApp();
    const { logger, lines } = captureLogger();
    expect((await importLegacyOidcEnv(db, cfg(), logger)).kind).toBe("nothing_to_import");
    const [s] = await db.select().from(siteSettings);
    expect(s!.legacyOidcEnvHandledAt).not.toBeNull();
    expect(lines().some(l => l.level === 40)).toBe(false);
  });

  it("C4：另一個啟動持有 site_settings 列鎖時，匯入卡在 FOR UPDATE；對方設好標記並 commit 後得 already_handled、零列", async () => {
    // 兩條連線交錯（gate r1 t1-7 I3）：只 `Promise.all` 兩個 importLegacyOidcEnv 的話，序列跑也得 already_handled，
    // 拿掉 FOR UPDATE 照樣綠——證明不了交錯（主檔 Global Constraints「race 測試」條）。
    const { db } = await buildTestApp();
    const pool = db.$client;
    const other = await pool.connect();
    try {
      await other.query("begin");
      await other.query("select singleton from site_settings where singleton for update");
      const { logger } = captureLogger();
      const p = importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger);
      expect(await waitForBlockedOrSettled(pool, p)).toBe("blocked");
      await other.query("update site_settings set legacy_oidc_env_handled_at = now()");
      await other.query("commit");
      expect((await p).kind).toBe("already_handled");
      expect(await db.select().from(authProviders)).toHaveLength(0);
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
  });

  it("resolved_issuer 推定：env 帶尾斜線、既有 identity 是無斜線 → 填無斜線；沒有相符 → NULL；兩個不同字面都正規化相等 → NULL（不猜）", async () => {
    const cases: Array<[string[], string | null]> = [
      [["http://idp.example"], "http://idp.example"],
      [["http://elsewhere.example"], null],
      [["http://idp.example", "http://IDP.example"], null],
    ];
    for (const [issuers, expected] of cases) {
      const { db } = await buildTestApp();
      const [u] = await db.insert(users).values({ email: `u${issuers.length}@x`, displayName: "U" }).returning();
      await db.insert(userIdentities).values(issuers.map((issuer, i) => ({ userId: u!.id, issuer, sub: `s${i}` })));
      const { logger } = captureLogger();
      const out = await importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger);
      expect(out).toMatchObject({ kind: "imported", resolvedIssuer: expected });
      const [p] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders);
      expect(p!.r).toBe(expected);
    }
  });

  it("site_settings 沒有列 → throw（啟動失敗，§4.3）", async () => {
    const { db } = await buildTestApp();
    await db.delete(siteSettings);
    const { logger } = captureLogger();
    await expect(importLegacyOidcEnv(db, cfg({ legacyOidcEnv: ENV }), logger)).rejects.toThrow(/site_settings/);
  });
});

describe("backfillLegacyOidcIdentities（#187 §10.3）", () => {
  it("舊碼（回滾期）寫的 users.oidc_* → 補成 identity；冪等；屬別人 → warn 不改資料", async () => {
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
