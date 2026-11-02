/**
 * bulk transfer spec 2026-11-02 §5.3：`transferAuth.requireBulk("read")`（plan T9 A1–A12）。矩陣在單篇 GET 上全跑、DELETE 抽三案。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { BULK_TRANSFER_PAT_MESSAGE, TRANSFER_INVALID_MESSAGE } from "../src/auth/transfer-auth.js";
import { apiTokens, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { expireToken, issueDirect } from "./transfer-helpers.js";
import { bulkDelete, bulkGet, issueBulkDirect, seedMd } from "./bulk-transfer-helpers.js";

async function scene(opts: { bearerMiss?: FixedWindowLimiter } = {}) {
  const ctx = await buildCollabTestApp(opts.bearerMiss ? { limiters: { bearerMiss: opts.bearerMiss } } : {});
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "A" });
  await seedMd(ctx.db, note.id, "hello bulk");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId);
  return { ctx, u, pat, note, bulk, url: `/api/transfer/notes/${note.id}` };
}
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;

describe("requireBulk：A 矩陣（GET /api/transfer/notes/:id）", () => {
  it("A10 唯讀母憑證的 bulk → 200（讀取只要 notes:read）", async () => {
    const s = await scene();
    expect((await bulkGet(s.ctx.app, s.url, s.bulk.token)).statusCode).toBe(200);
  });

  it("A1 無 header、帶有效 session cookie → 401（不回退 cookie）、不吃 bearerMiss", async () => {
    const s = await scene({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) });
    const cookies = await cookieOf(s.u.id);
    for (let i = 0; i < 3; i++) {
      const r = await bulkGet(s.ctx.app, s.url, undefined, { cookies });
      expect(r.statusCode, `#${i}`).toBe(401);
      expect(errOf(r).code).toBe("unauthorized");
    }
    // 桶沒被吃：第一發無效 token 仍是 401 不是 429
    expect((await bulkGet(s.ctx.app, s.url, "knbt_nope")).statusCode).toBe(401);
  });

  it("A2 Basic → 401、吃 bearerMiss", async () => {
    const s = await scene({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) });
    const basic = () => s.ctx.app.inject({ method: "GET", url: s.url, headers: { authorization: "Basic eHg6eXk=" } });
    expect((await basic()).statusCode).toBe(401);
    expect((await basic()).statusCode).toBe(429);
  });

  it("A3 有效的 knb_ PAT → 401＋BULK_TRANSFER_PAT_MESSAGE；A4 knbt_ 亂碼 → 401＋TRANSFER_INVALID_MESSAGE、challenge 含 invalid_token；A11 body 是 JSON", async () => {
    const s = await scene();
    const a3 = await bulkGet(s.ctx.app, s.url, s.pat.token);
    expect(a3.statusCode).toBe(401);
    expect(errOf(a3)).toEqual({ code: "unauthorized", message: BULK_TRANSFER_PAT_MESSAGE });
    const a4 = await bulkGet(s.ctx.app, s.url, "knbt_nope");
    expect(a4.statusCode).toBe(401);
    expect(errOf(a4)).toEqual({ code: "unauthorized", message: TRANSFER_INVALID_MESSAGE });
    expect(a4.headers["www-authenticate"]).toContain("invalid_token");
    expect(a4.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("A5 過期 bulk、A6 母憑證被撤銷、A7 母憑證過期 → 401 同字", async () => {
    const s = await scene();
    const msgs: unknown[] = [];
    const exp = await issueBulkDirect(s.ctx.db, s.pat.tokenId);
    await expireToken(s.ctx.db, exp.id);
    const r5 = await bulkGet(s.ctx.app, s.url, exp.token);
    expect(r5.statusCode).toBe(401);
    msgs.push(errOf(r5));
    const p7 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read");
    const b7 = await issueBulkDirect(s.ctx.db, p7.tokenId);
    await s.ctx.db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, p7.tokenId));
    const r7 = await bulkGet(s.ctx.app, s.url, b7.token);
    expect(r7.statusCode).toBe(401);
    msgs.push(errOf(r7));
    await s.ctx.db.delete(apiTokens).where(eq(apiTokens.id, s.pat.tokenId));
    const r6 = await bulkGet(s.ctx.app, s.url, s.bulk.token);
    expect(r6.statusCode).toBe(401);
    msgs.push(errOf(r6));
    for (const m of msgs) expect(m).toEqual({ code: "unauthorized", message: TRANSFER_INVALID_MESSAGE });
  });

  it("A8 使用者停權／需改密碼 → 401 同形", async () => {
    const s = await scene();
    const v = await seedUser(s.ctx.db, { disabled: true });
    const vp = await seedTokenForUser(s.ctx.db, v.id, "notes:read");
    const vb = await issueBulkDirect(s.ctx.db, vp.tokenId);
    const r1 = await bulkGet(s.ctx.app, s.url, vb.token);
    expect(r1.statusCode).toBe(401);
    expect(errOf(r1)).toEqual({ code: "unauthorized", message: TRANSFER_INVALID_MESSAGE });
    const w = await seedUser(s.ctx.db);
    await s.ctx.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, w.id));
    const wp = await seedTokenForUser(s.ctx.db, w.id, "notes:read");
    const wb = await issueBulkDirect(s.ctx.db, wp.tokenId);
    const r2 = await bulkGet(s.ctx.app, s.url, wb.token);
    expect(r2.statusCode).toBe(401);
    expect(errOf(r2)).toEqual(errOf(r1));
  });

  it("A9 upload／download 權杖打 bulk 路由 → 403 forbidden", async () => {
    const s = await scene();
    for (const purpose of ["upload", "download"] as const) {
      const t = await issueDirect(s.ctx.db, s.pat.tokenId, s.note.id, purpose);
      const r = await bulkGet(s.ctx.app, s.url, t.token);
      expect(r.statusCode, purpose).toBe(403);
      expect(errOf(r).code, purpose).toBe("forbidden");
    }
  });

  it("A12 bearerMiss limit 1：連兩發 A4 → 第二發 429＋Retry-After ≥ 1 的整數、不帶 WWW-Authenticate", async () => {
    const s = await scene({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) });
    expect((await bulkGet(s.ctx.app, s.url, "knbt_nope")).statusCode).toBe(401);
    const r = await bulkGet(s.ctx.app, s.url, "knbt_nope");
    expect(r.statusCode).toBe(429);
    expect(String(r.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
    expect(r.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("requireBulk：DELETE /api/transfer/token 抽三案", () => {
  it("無 header → 401；PAT → 401 專屬訊息；download 權杖 → 403；有效 bulk → 204", async () => {
    const s = await scene();
    expect((await bulkDelete(s.ctx.app)).statusCode).toBe(401);
    const p = await bulkDelete(s.ctx.app, s.pat.token);
    expect(p.statusCode).toBe(401);
    expect(errOf(p).message).toBe(BULK_TRANSFER_PAT_MESSAGE);
    const d = await issueDirect(s.ctx.db, s.pat.tokenId, s.note.id, "download");
    expect((await bulkDelete(s.ctx.app, d.token)).statusCode).toBe(403);
    expect((await bulkDelete(s.ctx.app, s.bulk.token)).statusCode).toBe(204);
  });
});
