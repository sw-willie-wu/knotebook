// Every adversarial case asserts that nothing extra appears on disk or in the DB.
// Issuing through the MCP tool and reproducing the curl form end to end is in `mcp-transfer-flow.test.ts`.
import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { TRANSFER_INVALID_MESSAGE, TRANSFER_PAT_MESSAGE } from "../src/auth/transfer-auth.js";
import { apiTokens, noteShares, notes, oauthClients, uploads, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { runOauthCleanup } from "../src/oauth/cleanup.js";
import { buildCollabTestApp, buildTestApp, createUserAndLogin, freshLimiters } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, waitForBlockedOrSettled } from "./group-helpers.js";
import { authorizeAndConsent, codeGrant, exchange, obtainCode } from "./helpers/oauth-flow.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import {
  MULTIPART,
  PNG_BYTES,
  download,
  expireToken,
  fieldOnlyBody,
  fileBody,
  issueDirect,
  ownerWithPat,
  tokenRow,
  upload,
} from "./transfer-helpers.js";
import { giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, usedOf } from "./storage-helpers.js";
import { issueBulkDirect } from "./bulk-transfer-helpers.js";

const NOT_AN_IMAGE = Buffer.from("plain text, not an image", "utf-8");

describe("POST /api/notes/:id/uploads x transfer token", () => {
  it("upload token -> 201 {id, url: /api/uploads/<id>}; uploader = the parent credential's user; token consumed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string };
    expect(body.url).toBe(`/api/uploads/${body.id}`);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id));
    expect(row).toMatchObject({ noteId: o.noteId, uploaderId: o.userId, mime: "image/png", size: PNG_BYTES.length });
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });

  it("reusing a consumed upload token -> 401 (with challenge); file count on disk unchanged", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
    const again = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_INVALID_MESSAGE } });
    expect(again.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });

  it("POST: child token expired -> 401; parent credential expired (child not expired) -> 401; both write nothing", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const a = await issueDirect(db, o.patId, o.noteId, "upload");
    await expireToken(db, a.id);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: a.token })).statusCode).toBe(401);
    const b = await issueDirect(db, o.patId, o.noteId, "upload");
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, o.patId));
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: b.token })).statusCode).toBe(401);
    expect((await tokenRow(db, b.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("a token for note A hitting note B -> 403; same 403 with a byte-identical body when B does not exist; token not consumed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const other = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const toExisting = await upload(app, other.noteId, fileBody(PNG_BYTES), { token: t.token });
    const toMissing = await upload(app, randomUUID(), fileBody(PNG_BYTES), { token: t.token });
    expect(toExisting.statusCode).toBe(403);
    expect(toExisting.json().error.code).toBe("forbidden");
    expect(toMissing.statusCode).toBe(403);
    expect(toMissing.body).toBe(toExisting.body);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("POST half: download token hitting POST -> 403 forbidden, nothing written", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("POST: downgraded to viewer after issue -> 403, token not consumed; share removed -> 404, token still not consumed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await ownerWithPat(db);
    const editor = await seedUser(db);
    const { tokenId } = await seedTokenForUser(db, editor.id);
    await seedShare(db, owner.noteId, editor.id, "editor");
    const t = await issueDirect(db, tokenId, owner.noteId, "upload");
    await db.update(noteShares).set({ role: "viewer" }).where(and(eq(noteShares.noteId, owner.noteId), eq(noteShares.userId, editor.id)));
    expect((await upload(app, owner.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(403);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    await db.delete(noteShares).where(eq(noteShares.noteId, owner.noteId));
    const gone = await upload(app, owner.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("not_found");
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("the same upload token sent twice concurrently over a real socket -> exactly one 201 and one 401; exactly one more file on disk (20 rounds)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("listen 後取不到 port");
      const o = await ownerWithPat(db);
      for (let round = 0; round < 20; round++) {
        const t = await issueDirect(db, o.patId, o.noteId, "upload");
        const send = () =>
          fetch(`http://127.0.0.1:${address.port}/api/notes/${o.noteId}/uploads`, {
            method: "POST",
            headers: { "content-type": MULTIPART, authorization: `Bearer ${t.token}` },
            body: new Uint8Array(fileBody(PNG_BYTES)),
          }).then(r => r.status);
        const statuses = (await Promise.all([send(), send()])).sort();
        expect(statuses, `round ${round}`).toEqual([201, 401]);
        expect(readdirSync(uploadsDir), `round ${round}`).toHaveLength(round + 1);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  it("10 MiB + 1 -> 413 file_too_large; token consumed; nothing left on disk (including temp files)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_UPLOAD_BYTES, 0x41)])), { token: t.token });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("file_too_large");
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  }, 20_000);

  it("claims image/png but is actually text -> 415; token consumed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(NOT_AN_IMAGE), { token: t.token });
    expect(res.statusCode).toBe(415);
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("multipart without a file part -> 400 invalid_body; token consumed; no new file on disk", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fieldOnlyBody(), { token: t.token });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("transfer tokens hitting authenticateTokenOrSession routes are always 401 and do not query the DB; cookie-only routes ignore the header (no cookie -> 401)", async () => {
    const ctx = await buildCollabTestApp();
    const o = await ownerWithPat(ctx.db);
    const t = await issueDirect(ctx.db, o.patId, o.noteId, "download");
    const auth = { authorization: `Bearer ${t.token}` };
    const spy = vi.spyOn(ctx.db, "select");
    const probes: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { method: "GET", url: "/api/notes" },
      { method: "GET", url: `/api/notes/${o.noteId}` },
      { method: "GET", url: `/api/notes/${o.noteId}/content` },
      { method: "POST", url: `/api/notes/${o.noteId}/edits`, payload: { op: "append", markdown: "x" } },
      { method: "POST", url: "/api/notes", payload: {} },
    ];
    for (const p of probes) {
      spy.mockClear();
      const res = await ctx.app.inject({ method: p.method, url: p.url, headers: auth, ...(p.payload ? { payload: p.payload } : {}) });
      expect(res.statusCode, `${p.method} ${p.url}`).toBe(401);
      expect(spy, `${p.method} ${p.url} 不得查 DB`).not.toHaveBeenCalled();
    }
    spy.mockClear();
    const mcp = await mcpPost(ctx.app, rpc("tools/list"), { token: t.token });
    expect(mcp.statusCode).toBe(401);
    expect(spy, "POST /api/mcp 不得查 DB").not.toHaveBeenCalled();
    spy.mockRestore();
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: auth });
    expect(me.statusCode).toBe(401);
  });

  it("POST: a valid read-write PAT hitting the upload endpoint directly -> 401 dedicated message with invalid_token; charges bearerMiss", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    const first = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: o.pat });
    expect(first.statusCode).toBe(401);
    expect(first.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_PAT_MESSAGE } });
    expect(first.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    const second = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: o.pat });
    expect(second.statusCode).toBe(429);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("valid session cookie + invalid transfer token -> 401, no cookie fallback", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_bogus", cookies: await cookieOf(o.userId) });
    expect(res.statusCode).toBe(401);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("valid transfer token + another user's session cookie -> 201, the uploader is the token's user", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const stranger = await seedUser(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token, cookies: await cookieOf(stranger.id) });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, (res.json() as { id: string }).id));
    expect(row!.uploaderId).toBe(o.userId);
  });

  it("user suspended or must change password -> 401; token not consumed", async () => {
    const { app, db } = await buildTestApp();
    const a = await ownerWithPat(db);
    const ta = await issueDirect(db, a.patId, a.noteId, "upload");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.userId));
    expect((await upload(app, a.noteId, fileBody(PNG_BYTES), { token: ta.token })).statusCode).toBe(401);
    const b = await ownerWithPat(db);
    const tb = await issueDirect(db, b.patId, b.noteId, "upload");
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, b.userId));
    expect((await upload(app, b.noteId, fileBody(PNG_BYTES), { token: tb.token })).statusCode).toBe(401);
    expect((await tokenRow(db, ta.id))!.consumedAt).toBeNull();
    expect((await tokenRow(db, tb.id))!.consumedAt).toBeNull();
  });

  it("UPLOAD_LIMIT used up -> transfer POST 429, token not burned", async () => {
    const uploadLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ upload: uploadLimiter }) });
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { cookies: await cookieOf(o.userId) })).statusCode).toBe(201);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(429);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
  });

  it("large body (several MiB) + early transfer exit (401 invalid, 403 wrong note) still gets a structured error body", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const other = await ownerWithPat(db);
    const big = fileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES - 1024, 0x42));
    const bad = await upload(app, o.noteId, big, { token: "knbt_bogus" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: "unauthorized" } });
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const wrong = await upload(app, other.noteId, big, { token: t.token });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: "forbidden" } });
  }, 30_000);

  it("bearerMiss injected with limit:1 -> second invalid transfer token is 429, no WWW-Authenticate", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" })).statusCode).toBe(401);
    const second = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" });
    expect(second.statusCode).toBe(429);
    expect(second.headers["www-authenticate"]).toBeUndefined();
    // Bulk transfer: the shared reject401 makes #200's bearerMiss 429 also carry Retry-After (integer seconds >= 1).
    expect(String(second.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
  });

  it("a 429 replacing a 401 when the bearerMiss bucket is full does not consume the token either - after the window passes and the cause is removed the same token is still 201 (upload `next`: 'A 403 or 429 doesn't use the token up')", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 300 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    // The 401 reason chosen is "parent credential expired": SQL re-evaluates it with now() every time, so restoring takes effect at once (UserGate's suspension/must-change-password is cached and hard to restore).
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, o.patId));
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" })).statusCode).toBe(401);
    // Parent expired -> would have been 401; with the bucket full -> 429 instead.
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(429);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() + interval '1 hour'` }).where(eq(apiTokens.id, o.patId));
    await new Promise(r => setTimeout(r, 400));
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
  });

  it("path with the same UUID in uppercase -> 201 (comparison is case-insensitive)", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId.toUpperCase(), fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
  });

  it("no transfer 401 contains resource_metadata; Basic -> no error and charges bearerMiss; a 401 without a header does not", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    const anon1 = await upload(app, o.noteId, fileBody(PNG_BYTES));
    const anon2 = await upload(app, o.noteId, fileBody(PNG_BYTES));
    expect([anon1.statusCode, anon2.statusCode]).toEqual([401, 401]);
    // No Authorization header: falls back to app.authenticate, whose 401 carries no challenge at all (the docs/api.md sentence is bounded by this).
    expect(anon1.headers["www-authenticate"]).toBeUndefined();
    const basic = await upload(app, o.noteId, fileBody(PNG_BYTES), { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(basic.statusCode).toBe(401);
    expect(basic.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer"');
    const afterBasic = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" });
    expect(afterBasic.statusCode).toBe(429);
  });

  it("every kind of transfer 401 with a header (invalid shape, not found, PAT, consumed, parent expired, user suspended) has a realm-shaped challenge without resource_metadata", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const used = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: used.token })).statusCode).toBe(201);
    const expiredParent = await ownerWithPat(db);
    const tExp = await issueDirect(db, expiredParent.patId, expiredParent.noteId, "upload");
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, expiredParent.patId));
    const disabled = await ownerWithPat(db);
    const tDis = await issueDirect(db, disabled.patId, disabled.noteId, "upload");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.userId));
    const cases: Array<[string, string, string]> = [
      ["無效 knbt_", o.noteId, "knbt_unknown"],
      ["非 knbt_", o.noteId, "garbage"],
      ["PAT", o.noteId, o.pat],
      ["已消費", o.noteId, used.token],
      ["母憑證過期", expiredParent.noteId, tExp.token],
      ["使用者停權", disabled.noteId, tDis.token],
    ];
    for (const [label, noteId, token] of cases) {
      const res = await upload(app, noteId, fileBody(PNG_BYTES), { token });
      expect(res.statusCode, label).toBe(401);
      expect(res.headers["www-authenticate"], label).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    }
  });

  it("the 401 from the consume step (atomic UPDATE hits 0 rows) also charges bearerMiss and writes nothing", async () => {
    // Deterministic construction: the holder locks the token row first -> the request under test passes the authentication lookup (a
    // plain select is not blocked) and stalls on the atomic UPDATE (blocked) -> the holder sets consumed_at and commits -> the UPDATE
    // re-evaluates its predicate -> 0 rows -> the 401 is emitted from the consume step (not the fast path).
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const pool = db.$client;
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from transfer_tokens where id = $1 for update", [t.id]);
      const req = upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
      expect(await waitForBlockedOrSettled(pool, req)).toBe("blocked");
      await holder.query("update transfer_tokens set consumed_at = now() where id = $1", [t.id]);
      await holder.query("commit");
      const res = await req;
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(readdirSync(uploadsDir)).toHaveLength(0);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" })).statusCode).toBe(429);
  });

  it("the expiry predicate of the consume step: the token expires after authentication while stalled on the atomic UPDATE -> 401, token not consumed, nothing written", async () => {
    // Guards `expires_at > now()` in the atomic UPDATE of routes/uploads.ts: the token is still valid at the authentication lookup, the
    // holder locks the row so the UPDATE stalls, then moves expires_at into the past and commits -> the UPDATE re-evaluates -> 0 rows -> 401.
    // Without that predicate this would be 201.
    const { app, db, uploadsDir } = await buildTestApp();
    const pool = db.$client;
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from transfer_tokens where id = $1 for update", [t.id]);
      const req = upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
      expect(await waitForBlockedOrSettled(pool, req)).toBe("blocked");
      // `created_at` is moved back too, otherwise it hits transfer_tokens_expiry_chk (expires_at > created_at).
      await holder.query("update transfer_tokens set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where id = $1", [
        t.id,
      ]);
      await holder.query("commit");
      const res = await req;
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_INVALID_MESSAGE } });
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("note deleted during the upload (real socket; consumption passed, body being sent) -> 404 not_found; the token row is deleted by cascade; nothing left on disk", async () => {
    // Covers the "after consumption" source of the `next` hint "a 404 means the note is gone": deleting the note while uploading.
    // Construction: send headers + multipart head + half the file -> poll until consumed_at is non-NULL (preHandler passed) -> delete the note -> send the rest -> the INSERT hits the FK.
    const { app, db, uploadsDir } = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("listen 後取不到 port");
      const o = await ownerWithPat(db);
      const t = await issueDirect(db, o.patId, o.noteId, "upload");
      const body = fileBody(Buffer.concat([PNG_BYTES, Buffer.alloc(256 * 1024, 0x41)]));
      const half = Math.floor(body.length / 2);
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: `/api/notes/${o.noteId}/uploads`,
            method: "POST",
            headers: { "content-type": MULTIPART, authorization: `Bearer ${t.token}`, "content-length": String(body.length) },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(body.subarray(0, half));
        void (async () => {
          await vi.waitFor(async () => expect((await tokenRow(db, t.id))?.consumedAt ?? null).not.toBeNull(), { timeout: 5_000 });
          await db.delete(notes).where(eq(notes.id, o.noteId));
          req.end(body.subarray(half));
        })().catch(reject);
      });
      const res = await response;
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "not_found" } });
      expect(await tokenRow(db, t.id)).toBeUndefined();
      expect(readdirSync(uploadsDir)).toHaveLength(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("note moved into a group after issue -> judged by the group role at use time: editable 201, read-only 403; the group space is charged (a full personal space does not block)", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const g = await seedGroup(db, `g-${randomUUID().slice(0, 8)}`, [{ userId: o.userId, role: "admin" }]);
    // Personal space quota 0 (0 >= 0 = full), group unlimited: if the pre-check or the in-transaction decision still used the personal space from issue time (before the move), this request would be 409.
    await giveUserQuota(db, o.userId, 0);
    await giveGroupQuota(db, g.id, null);
    const t1 = await issueDirect(db, o.patId, o.noteId, "upload");
    const t2 = await issueDirect(db, o.patId, o.noteId, "upload");
    const moved = await app.inject({ method: "POST", url: `/api/notes/${o.noteId}/move`, cookies: await cookieOf(o.userId), payload: { groupId: g.id } });
    expect(moved.statusCode).toBe(200);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t1.token })).statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(PNG_BYTES.length);
    expect(await usedOf(db.$client, { kind: "user", id: o.userId })).toBe(0);
    const reader = await seedRole(db, g.id, "reader", { canRead: true });
    await setMemberRole(db, g.id, o.userId, reader);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t2.token })).statusCode).toBe(403);
    expect((await tokenRow(db, t2.id))!.consumedAt).toBeNull();
  });

  it("note deleted after issue -> child token deleted by cascade -> 401; nothing new on disk", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    await db.delete(notes).where(eq(notes.id, o.noteId));
    expect(await tokenRow(db, t.id)).toBeUndefined();
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(401);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("session path unchanged: cookie upload is still 201", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { cookies: await cookieOf(o.userId) })).statusCode).toBe(201);
  });

  it("#239: after the parent credential is downgraded to read-only, an upload transfer token issued earlier -> 403 insufficient_scope, no uploads row", async () => {
    const { app, db } = await buildTestApp();
    const { patId, noteId, userId } = await ownerWithPat(db, "notes:read notes:write");
    const { token } = await issueDirect(db, patId, noteId, "upload");
    const down = await app.inject({
      method: "PATCH",
      url: `/api/auth/tokens/${patId}`,
      cookies: await cookieOf(userId),
      payload: { scope: "notes:read" },
    });
    expect(down.statusCode).toBe(200);
    const res = await upload(app, noteId, fileBody(PNG_BYTES), { token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
    expect(await db.select().from(uploads).where(eq(uploads.noteId, noteId))).toHaveLength(0);
  });
});

describe("POST /api/notes/:id/uploads with transfer token and storage quota (the two 409 statements of #200)", () => {
  /** Shape of the two 409s: numbers replaced by type markers, the rest compared field by field (#200: same code same shape, no flag field). */
  const shapeOf = (body: { storage: Record<string, unknown> } & Record<string, unknown>) => ({
    ...body,
    storage: Object.fromEntries(Object.keys(body.storage).map(k => [k, "<n>"])),
  });

  it("space full -> 409 storage_quota_exceeded (pre-check, incomingBytes null), nothing new on disk; token not consumed, after freeing space the same token -> 201", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    const filler = await seedAttachment(db, uploadsDir, o.noteId, o.userId, 1000, { noFile: true });
    const t = await issueDirect(db, o.patId, o.noteId, "upload");

    const full = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);

    await db.delete(uploads).where(eq(uploads.id, filler));
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
  });

  it("space full, token belongs to a shared editor (cannot see usage) -> 409 carries only incomingBytes null; token not consumed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await ownerWithPat(db);
    const editor = await seedUser(db);
    const { tokenId } = await seedTokenForUser(db, editor.id);
    await seedShare(db, owner.noteId, editor.id, "editor");
    await giveUserQuota(db, owner.userId, 1000);
    await seedAttachment(db, uploadsDir, owner.noteId, owner.userId, 1000, { noFile: true });
    const t = await issueDirect(db, tokenId, owner.noteId, "upload");
    const res = await upload(app, owner.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(quotaBody({ incomingBytes: null }));
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
  });

  it("not full but does not fit -> 409 once the file streams past the room (incomingBytes null), file unlinked, no new row; token burned - after freeing space the same token is 401; the two 409s have the same shape apart from numbers", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    const filler = await seedAttachment(db, uploadsDir, o.noteId, o.userId, 1000 - PNG_BYTES.length + 1, { noFile: true });
    const t = await issueDirect(db, o.patId, o.noteId, "upload");

    const streamed = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(streamed.statusCode).toBe(409);
    expect(streamed.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000 - PNG_BYTES.length + 1, quotaBytes: 1000 }));
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
    expect(await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, o.noteId))).toEqual([{ id: filler }]);

    await seedAttachment(db, uploadsDir, o.noteId, o.userId, PNG_BYTES.length, { noFile: true });
    const t2 = await issueDirect(db, o.patId, o.noteId, "upload");
    const pre = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t2.token });
    expect(pre.statusCode).toBe(409);
    expect(pre.json().storage.incomingBytes).toBeNull();
    expect(shapeOf(pre.json())).toEqual(shapeOf(streamed.json()));

    await db.delete(uploads).where(eq(uploads.noteId, o.noteId));
    const reused = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_INVALID_MESSAGE } });
  });

  it("transfer upload: test hook storage-space-locked throws 55P03 -> 409 server_busy, file unlinked; token burned - the same token is 401 afterwards", async () => {
    let busy = true;
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point === "storage-space-locked" && busy) throw Object.assign(new Error("55P03"), { code: "55P03" });
      },
    });
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);

    busy = false;
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(401);
    const fresh = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: fresh.token })).statusCode).toBe(201);
  });
});

describe("GET /api/uploads/:id x transfer token", () => {
  async function seedUpload(app: Parameters<typeof upload>[0], noteId: string, cookies: Record<string, string>, bytes: Buffer = PNG_BYTES) {
    const res = await upload(app, noteId, fileBody(bytes), { cookies });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("download token used several times within its TTL - two uploads of one note each GET 200 with identical bytes and the same headers as the session path; HEAD 200", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const cookies = await cookieOf(o.userId);
    const second = Buffer.concat([PNG_BYTES, Buffer.from([0x09, 0x09])]);
    const id1 = await seedUpload(app, o.noteId, cookies);
    const id2 = await seedUpload(app, o.noteId, cookies, second);
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    const r1 = await download(app, id1, { token: t.token });
    const r2 = await download(app, id2, { token: t.token });
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect(r1.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(r2.rawPayload.equals(second)).toBe(true);
    const viaSession = await download(app, id1, { cookies });
    for (const h of ["content-type", "cache-control", "x-content-type-options"]) expect(r1.headers[h], h).toBe(viaSession.headers[h]);
    expect((await download(app, id1, { token: t.token, method: "HEAD" })).statusCode).toBe(200);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
  });

  it("GET: download token expired -> 401", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, t.id);
    expect((await download(app, id, { token: t.token })).statusCode).toBe(401);
  });

  it("download token of note A reading an upload of note B -> 403 forbidden", async () => {
    const { app, db } = await buildTestApp();
    const a = await ownerWithPat(db);
    const b = await ownerWithPat(db);
    const idB = await seedUpload(app, b.noteId, await cookieOf(b.userId));
    const t = await issueDirect(db, a.patId, a.noteId, "download");
    const res = await download(app, idB, { token: t.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("two notes of the same user: A's download token reading an upload of B (which they can see) -> still 403", async () => {
    // Both notes belong to the same person, so only the "token's note = the upload's note" comparison blocks the read; with notes of
    // different users resolveRole would return none and give 403 even without that comparison.
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const cookies = await cookieOf(o.userId);
    const noteB = await seedNote(db, { ownerId: o.userId });
    const idB = await seedUpload(app, noteB.id, cookies);
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    const res = await download(app, idB, { token: t.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect((await download(app, idB, { cookies })).statusCode).toBe(200);
  });

  it("GET half: upload token hitting GET -> 403; the upload token is not consumed", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await download(app, id, { token: t.token })).statusCode).toBe(403);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
  });

  it("GET: share removed after issue -> GET 403", async () => {
    const { app, db } = await buildTestApp();
    const owner = await ownerWithPat(db);
    const reader = await seedUser(db);
    const { tokenId } = await seedTokenForUser(db, reader.id, "notes:read");
    await seedShare(db, owner.noteId, reader.id, "viewer");
    const id = await seedUpload(app, owner.noteId, await cookieOf(owner.userId));
    const t = await issueDirect(db, tokenId, owner.noteId, "download");
    expect((await download(app, id, { token: t.token })).statusCode).toBe(200);
    await db.delete(noteShares).where(eq(noteShares.noteId, owner.noteId));
    expect((await download(app, id, { token: t.token })).statusCode).toBe(403);
  });

  it("GET: a valid PAT hitting directly -> 401 dedicated message", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const res = await download(app, id, { token: o.pat });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_PAT_MESSAGE } });
  });

  it("transfer GET charges tokenRead (key token:<userId>) - injected limit:1: a 403/404 first does not charge, the 200 uses the only point, the next request is 429", async () => {
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenRead }) });
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    // A 403 (another note's upload) and a 404 (no such upload) blocked by the access checks both return before charging, so they do not eat the bucket
    // - otherwise the 200 below would become 429 (docs/api.md GET row "that gets past the access checks").
    const otherId = await seedUpload(app, (await seedNote(db, { ownerId: o.userId })).id, await cookieOf(o.userId));
    expect((await download(app, otherId, { token: t.token })).statusCode).toBe(403);
    expect((await download(app, randomUUID(), { token: t.token })).statusCode).toBe(404);
    expect((await download(app, id, { token: t.token })).statusCode).toBe(200);
    expect((await download(app, id, { token: t.token })).statusCode).toBe(429);
    // Same ledger: the same user's PAT hitting authenticateTokenOrSession routes is blocked too (same key).
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${o.pat}` } })).statusCode).toBe(429);
  });

  it("the 404 and 429 statements of download `next`: non-UUID and unknown upload are both 404; after a 429, once the window passes the same token GETs 200", async () => {
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 300 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenRead }) });
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    expect((await download(app, "not-a-uuid", { token: t.token })).statusCode).toBe(404);
    expect((await download(app, randomUUID(), { token: t.token })).statusCode).toBe(404);
    expect((await download(app, id, { token: t.token })).statusCode).toBe(200);
    expect((await download(app, id, { token: t.token })).statusCode).toBe(429);
    await new Promise(r => setTimeout(r, 400));
    expect((await download(app, id, { token: t.token })).statusCode).toBe(200);
  });

  it("download token + uppercase upload id -> 200", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const id = await seedUpload(app, o.noteId, await cookieOf(o.userId));
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    expect((await download(app, id.toUpperCase(), { token: t.token })).statusCode).toBe(200);
  });

  it("session GET path unchanged (does not charge tokenRead)", async () => {
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenRead }) });
    const o = await ownerWithPat(db);
    const cookies = await cookieOf(o.userId);
    const id = await seedUpload(app, o.noteId, cookies);
    expect((await download(app, id, { cookies })).statusCode).toBe(200);
    expect((await download(app, id, { cookies })).statusCode).toBe(200);
  });
});

describe("parent credential gone -> child tokens die with it", () => {
  it("DELETE /api/auth/tokens/:id revokes the PAT -> child token 401, transfer_tokens rows no longer exist", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const revoked = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${o.patId}`, cookies: await cookieOf(o.userId) });
    expect(revoked.statusCode).toBeLessThan(300);
    expect(await tokenRow(db, t.id)).toBeUndefined();
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(401);
  });

  async function oauthGrant(app: Parameters<typeof upload>[0], db: Parameters<typeof ownerWithPat>[0]) {
    const { userId, cookie } = await createUserAndLogin(db);
    const c = await obtainCode(app, cookie, { scope: "notes:write" });
    const tokens = (await exchange(app, codeGrant(c))).json() as { access_token: string; refresh_token: string };
    const [grant] = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
    const note = await seedNote(db, { ownerId: userId });
    return { userId, cookie, c, grantId: grant!.id, refresh: tokens.refresh_token, noteId: note.id };
  }

  it("OAuth re-authorization with the same client (delete then insert) -> old child token 401", async () => {
    const { app, db } = await buildTestApp();
    const g = await oauthGrant(app, db);
    const t = await issueDirect(db, g.grantId, g.noteId, "upload");
    const again = await authorizeAndConsent(app, g.cookie, g.c.clientId, g.c.redirectUri, "notes:write");
    expect((await exchange(app, codeGrant({ ...g.c, ...again }))).statusCode).toBe(200);
    expect(await tokenRow(db, t.id)).toBeUndefined();
    expect((await upload(app, g.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(401);
  });

  it("OAuth client cleanup cascades two levels (oauth_clients -> api_tokens -> transfer_tokens) -> child rows disappear", async () => {
    const { app, db } = await buildTestApp();
    const g = await oauthGrant(app, db);
    const t = await issueDirect(db, g.grantId, g.noteId, "download");
    await db.update(oauthClients).set({ lastUsedAt: sql`now() - interval '31 days'` }).where(eq(oauthClients.clientId, g.c.clientId));
    await runOauthCleanup(db);
    expect(await tokenRow(db, t.id)).toBeUndefined();
  });

  it("after refresh rotation (in-place UPDATE, id unchanged) the child token still works", async () => {
    const { app, db } = await buildTestApp();
    const g = await oauthGrant(app, db);
    const t = await issueDirect(db, g.grantId, g.noteId, "upload");
    const rotated = await exchange(app, { grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.c.clientId });
    expect(rotated.statusCode).toBe(200);
    expect((await upload(app, g.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
  });
});

describe("bulk tokens hitting #200's upload/download endpoints -> 403 (purpose comparison in `require()`)", () => {
  it("GET /api/uploads/:id and POST /api/notes/:id/uploads both 403 forbidden, nothing written", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const bulk = await issueBulkDirect(db, o.patId);
    const g = await download(app, randomUUID(), { token: bulk.token });
    expect(g.statusCode).toBe(403);
    expect(g.json()).toMatchObject({ error: { code: "forbidden" } });
    const before = readdirSync(uploadsDir).length;
    const p = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: bulk.token });
    expect(p.statusCode).toBe(403);
    expect(p.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(readdirSync(uploadsDir).length).toBe(before);
  });
});
