/**
 * bulk transfer spec 2026-11-02 §5.3（write）、§9.1、§15：`PUT /api/transfer/notes` 的認證與 body 外殼（plan PR-2 T1 W-A1–W-A10）。
 * 只斷言在讀入 frontmatter **之前**就決定的出口；T1 的 handler 解碼成功後回佔位 400（T8 起換成寫回）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BULK_TRANSFER_INVALID_MESSAGE, BULK_TRANSFER_PAT_MESSAGE, BULK_TRANSFER_REQUIRED_MESSAGE, TRANSFER_PURPOSE_MESSAGE } from "../src/auth/transfer-auth.js";
import { INVALID_UTF8_MESSAGE } from "../src/routes/transfer.js";
import type { TokenScope } from "@knotebook/shared";
import { apiTokens } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { TRANSFER_WRITE_BODY_LIMIT, WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { buildCollabTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { issueDirect } from "./transfer-helpers.js";
import { basesOf, bulkPut, issueBulkDirect, seedMd } from "./bulk-transfer-helpers.js";

async function scene(opts: { bearerMiss?: FixedWindowLimiter; parentScope?: TokenScope; access?: "read" | "write"; disabled?: boolean } = {}) {
  const ctx = await buildCollabTestApp(opts.bearerMiss ? { limiters: { bearerMiss: opts.bearerMiss } } : {});
  const u = await seedUser(ctx.db, opts.disabled ? { disabled: true } : {});
  const pat = await seedTokenForUser(ctx.db, u.id, opts.parentScope ?? "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "A" });
  await seedMd(ctx.db, note.id, "hello bulk");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: opts.access ?? "write" });
  return { ctx, u, pat, note, bulk };
}
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;
const FILE = "---\nknotebook: 1\n---\nhello";

describe("requireBulk(\"write\")：W-A 矩陣", () => {
  it("W-A1 無 header＋有效 session cookie → 401（不回退 cookie）、不吃 bearerMiss", async () => {
    const s = await scene({ bearerMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) });
    const cookies = await cookieOf(s.u.id);
    for (let i = 0; i < 3; i++) {
      const r = await bulkPut(s.ctx.app, undefined, FILE, { cookies });
      expect(r.statusCode, `#${i}`).toBe(401);
      expect(errOf(r), `#${i}`).toEqual({ code: "unauthorized", message: BULK_TRANSFER_REQUIRED_MESSAGE });
    }
    expect((await bulkPut(s.ctx.app, "knbt_nope", FILE)).statusCode).toBe(401);
  });

  it("W-A2 有效 knb_ PAT → 401＋BULK_TRANSFER_PAT_MESSAGE", async () => {
    const s = await scene();
    const r = await bulkPut(s.ctx.app, s.pat.token, FILE);
    expect(r.statusCode).toBe(401);
    expect(errOf(r)).toEqual({ code: "unauthorized", message: BULK_TRANSFER_PAT_MESSAGE });
  });

  it("W-A3 access='read' 的 bulk（唯讀母憑證簽的）→ 403 insufficient_scope、不帶 WWW-Authenticate（守 RO description「This credential can't send notes back.」）", async () => {
    const s = await scene({ parentScope: "notes:read", access: "read" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, FILE);
    expect(r.statusCode).toBe(403);
    expect(errOf(r)).toEqual({ code: "insufficient_scope", message: "This token's scope doesn't allow this action." });
    expect(r.headers["www-authenticate"]).toBeUndefined();
  });

  // 上一案的母憑證本身也沒有 notes:write，scope 檢查單獨就擋得下——這案讓母憑證有 notes:write，只剩 `access` 承重（T1-M1 實測存活後補）。
  it("W-A3c access='read' 的 bulk、母憑證有 notes:write → 仍 403 insufficient_scope（權杖本身的 access 承重）", async () => {
    const s = await scene({ parentScope: "notes:read notes:write", access: "read" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, FILE);
    expect(r.statusCode).toBe(403);
    expect(errOf(r)).toEqual({ code: "insufficient_scope", message: "This token's scope doesn't allow this action." });
  });

  it("W-A3 對照：同一支唯讀權杖讀取照常 200（只擋寫）", async () => {
    const s = await scene({ parentScope: "notes:read", access: "read" });
    const r = await s.ctx.app.inject({ method: "GET", url: `/api/transfer/notes/${s.note.id}`, headers: { authorization: `Bearer ${s.bulk.token}` } });
    expect(r.statusCode).toBe(200);
  });

  it("W-A3b access='read' 的 bulk＋使用者已停權 → 401＋BULK_TRANSFER_INVALID_MESSAGE（閘門排在 access 檢查之前）", async () => {
    const s = await scene({ parentScope: "notes:read", access: "read", disabled: true });
    const r = await bulkPut(s.ctx.app, s.bulk.token, FILE);
    expect(r.statusCode).toBe(401);
    expect(errOf(r)).toEqual({ code: "unauthorized", message: BULK_TRANSFER_INVALID_MESSAGE });
  });

  it("W-A4 access='write'，但母憑證之後被改成唯讀 scope → 403 insufficient_scope", async () => {
    const s = await scene();
    await s.ctx.db.update(apiTokens).set({ scope: "notes:read" }).where(eq(apiTokens.id, s.pat.tokenId));
    const r = await bulkPut(s.ctx.app, s.bulk.token, FILE);
    expect(r.statusCode).toBe(403);
    expect(errOf(r)).toEqual({ code: "insufficient_scope", message: "This token's scope doesn't allow this action." });
  });

  it("W-A5 upload／download 權杖 → 403「This transfer token can't be used for this action.」", async () => {
    const s = await scene();
    for (const purpose of ["upload", "download"] as const) {
      const t = await issueDirect(s.ctx.db, s.pat.tokenId, s.note.id, purpose);
      const r = await bulkPut(s.ctx.app, t.token, FILE);
      expect(r.statusCode, purpose).toBe(403);
      expect(errOf(r), purpose).toEqual({ code: "forbidden", message: TRANSFER_PURPOSE_MESSAGE });
    }
  });
});

describe("body 外殼：415／Origin／413／UTF-8", () => {
  it("W-A6 Content-Type: application/json（帶 body）→ 415「This request needs Content-Type text/markdown.」、基底未變", async () => {
    const s = await scene();
    const before = (await basesOf(s.ctx.db)).length;
    const r = await bulkPut(s.ctx.app, s.bulk.token, JSON.stringify({ a: 1 }), { contentType: "application/json" });
    expect(r.statusCode).toBe(415);
    expect(errOf(r)).toEqual({ code: "unsupported_media_type", message: "This request needs Content-Type text/markdown." });
    expect((await basesOf(s.ctx.db)).length).toBe(before);
  });

  it("W-A7 text/markdown＋Origin: https://evil.example → 403「Origin check failed」；同一請求不帶 Origin → 通過 onRequest（T10 起是新增 → 201）", async () => {
    const s = await scene();
    const bad = await bulkPut(s.ctx.app, s.bulk.token, FILE, { origin: "https://evil.example" });
    expect(bad.statusCode).toBe(403);
    expect(errOf(bad)).toEqual({ code: "forbidden", message: "Origin check failed: the request's Origin doesn't match its Host." });
    const good = await bulkPut(s.ctx.app, s.bulk.token, FILE);
    expect(good.statusCode).toBe(201);
  });

  it("W-A8（全分支審查 I2(c) 起 256 KiB，同 WRITE_BODY_LIMIT）body 256 KiB＋1 byte → 413 content_too_large；恰 256 KiB → 201 寫入", async () => {
    const s = await scene();
    expect(TRANSFER_WRITE_BODY_LIMIT).toBe(262_144);
    expect(TRANSFER_WRITE_BODY_LIMIT).toBe(WRITE_BODY_LIMIT);
    const over = await bulkPut(s.ctx.app, s.bulk.token, Buffer.alloc(TRANSFER_WRITE_BODY_LIMIT + 1, 0x61));
    expect(over.statusCode).toBe(413);
    expect(errOf(over).code).toBe("content_too_large");
    const exact = await bulkPut(s.ctx.app, s.bulk.token, Buffer.alloc(TRANSFER_WRITE_BODY_LIMIT, 0x61));
    expect(exact.statusCode).toBe(201);
  });

  it("W-A9 body 非 UTF-8 → 400 invalid_body＋INVALID_UTF8_MESSAGE", async () => {
    const s = await scene();
    const r = await bulkPut(s.ctx.app, s.bulk.token, Buffer.from([0xff, 0xfe, 0x00]));
    expect(r.statusCode).toBe(400);
    expect(errOf(r)).toEqual({ code: "invalid_body", message: INVALID_UTF8_MESSAGE });
  });

  it("W-A10 其他路由（POST /api/notes）帶 text/markdown → 仍 415「This request needs Content-Type application/json.」", async () => {
    const s = await scene();
    const r = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: { "content-type": "text/markdown", authorization: `Bearer ${s.pat.token}` }, payload: "# hi" });
    expect(r.statusCode).toBe(415);
    expect(errOf(r)).toEqual({ code: "unsupported_media_type", message: "This request needs Content-Type application/json." });
  });
});
