import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { IssueTransferTokenSeam } from "../src/auth/tx/issue-transfer-token.js";
import { MAX_PENDING_UPLOAD_TOKENS } from "../src/auth/transfer-token.js";
import { loadConfig } from "../src/config.js";
import { apiTokens, notes, transferTokens, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import {
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RO,
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RW,
  DOWNLOAD_NEXT,
  REVOKED_MESSAGE,
  STORAGE_FULL_HIDDEN_MESSAGE,
  TOO_MANY_PENDING_MESSAGE,
  UPLOAD_NEXT,
  VIEWER_UPLOAD_MESSAGE,
  storageFullVisibleMessage,
} from "../src/mcp/tools/create-transfer-token.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedShare, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { PNG_BYTES, expireToken, fileBody, issueDirect, ownerWithPat, upload } from "./transfer-helpers.js";
import { giveUserQuota, seedAttachment } from "./storage-helpers.js";
import { SESSION_COOKIE } from "@knotebook/shared";

// Uses buildTestApp without collab because create_transfer_token sits outside the deployment-shape gate; deterministic concurrency and no-plaintext-in-log tests are in mcp-transfer-flow.test.ts.
// PUBLIC_URL is deliberately a different https origin than inject's Host (`localhost:80`), proving `url`/`curl` come from PUBLIC_URL.
const ORIGIN = "https://kb.example.test:8443";
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64), PUBLIC_URL: `${ORIGIN}/` });

type Payload = { purpose: string; noteId: string; token: string; expiresAt: string; url: string; method: string; curl: string; next: string };

async function call(app: Parameters<typeof mcpPost>[0], token: string, args: Record<string, unknown>) {
  const res = await mcpPost(app, rpc("tools/call", { name: "create_transfer_token", arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as { isError?: true; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text: string }> };
}
async function toolsOf(app: Parameters<typeof mcpPost>[0], opts: { token?: string; cookie?: string }) {
  const res = await mcpPost(app, rpc("tools/list"), opts);
  expect(res.statusCode).toBe(200);
  return res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[]; description?: string }> } }>;
}

describe("tools/list", () => {
  it("read-write credential: has create_transfer_token, a two-value purpose enum, and the read-write description", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const tool = (await toolsOf(app, { token: o.pat })).find(t => t.name === "create_transfer_token");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(CREATE_TRANSFER_TOKEN_DESCRIPTION_RW);
    expect(tool!.inputSchema.properties.purpose!.enum).toEqual(["upload", "download"]);
    expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual(["note_id", "purpose"]);
    // Upload only stores a file, which enters the note only via edit_note (#200); also pins the older overclaiming wording so re-adding it fails.
    expect(tool!.inputSchema.properties.purpose!.description).toBe(
      "`upload` stores one file for the note (then reference it with edit_note); `download` fetches its files."
    );
    expect(tool!.inputSchema.properties.purpose!.description).not.toContain("adds one image to the note");
  });

  it("read-only credential: tool present, enum is only download, read-only description (does not describe the upload purpose)", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db, "notes:read");
    const tool = (await toolsOf(app, { token: o.pat })).find(t => t.name === "create_transfer_token");
    expect(tool!.description).toBe(CREATE_TRANSFER_TOKEN_DESCRIPTION_RO);
    // The read-only description already contains "uploaded" ("any file uploaded to that note"); what must be excluded is describing the `upload` purpose:
    expect(tool!.description).not.toContain("`upload`");
    expect(tool!.description).not.toContain("upload a file");
    expect(tool!.inputSchema.properties.purpose!.enum).toEqual(["download"]);
  });

  it("session (cookie) on /api/mcp: no create_transfer_token", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const cookie = (await cookieOf(o.userId))[SESSION_COOKIE]!;
    const names = (await toolsOf(app, { cookie })).map(t => t.name);
    expect(names).not.toContain("create_transfer_token");
  });

  it("read-only credential with purpose:upload -> SDK input validation error (no code), and tokenWrite is not charged", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db, "notes:read");
    const r = await call(app, o.pat, { note_id: o.noteId, purpose: "upload" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(await db.select().from(transferTokens)).toHaveLength(0);
    // Same user's read-write credential: tokenWrite (key token:<userId>) still has its 1 remaining slot
    const { token: rw } = await seedTokenForUser(db, o.userId, "notes:read notes:write");
    const write = await mcpPost(app, rpc("tools/call", { name: "create_note", arguments: {} }), { token: rw });
    expect(write.json().result.isError).toBeUndefined();
  });
});

describe("create_transfer_token flow", () => {
  it("upload happy path: url/curl/next verbatim; noteId lowercased (uppercase input); expiresAt about now + 10 min; method POST", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const before = Date.now();
    const r = await call(app, o.pat, { note_id: o.noteId.toUpperCase(), purpose: "upload" });
    expect(r.isError).toBeUndefined();
    const p = r.structuredContent as Payload;
    expect(r.content[0]!.text).toBe(JSON.stringify(p));
    expect(p.purpose).toBe("upload");
    expect(p.noteId).toBe(o.noteId);
    expect(p.token).toMatch(/^knbt_[A-Za-z0-9_-]{43}$/);
    expect(p.method).toBe("POST");
    expect(p.url).toBe(`${ORIGIN}/api/notes/${o.noteId}/uploads`);
    expect(p.curl).toBe(`curl -sS -X POST -H "Authorization: Bearer ${p.token}" -F "file=@<path-to-file>" "${ORIGIN}/api/notes/${o.noteId}/uploads"`);
    expect(p.next).toBe(UPLOAD_NEXT);
    // The bearerMiss 429 replaces a 401, so the token may already be used: only "this rejection doesn't use it up" can be claimed.
    expect(UPLOAD_NEXT).toContain("A 403 or 429 doesn't use the token up");
    expect(UPLOAD_NEXT).not.toContain("leaves the token unused");
    // Verbatim text, including the two 409 sentences added with the storage quota (after the 404 sentence, before the 413/415 one).
    expect(UPLOAD_NEXT).toBe(
      "The reply is JSON `{id, url, mime, kind}`, where `kind` is `image`, `audio`, `video` or `file`. Put an image (PNG, JPEG, GIF, WebP or SVG) in the note with " +
        "edit_note using markdown `![description](url)`, audio as `<audio src=\"url\" data-name=\"name\"></audio>`, video as `<video src=\"url\" data-name=\"name\"></video>` and any other file as `<embed src=\"url\" data-name=\"name\">`, with `url` exactly as returned " +
        "(`/api/uploads/<id>`, relative). The token is good for one upload until `expiresAt`. A 401 " +
        "means the token can't be used (expired, already used, or revoked) — ask for a new one. A 403 or 429 doesn't use the " +
        "token up (after a 429, wait a moment and retry), unless the 403 is for a role lost while the file was uploading; a 404 means the note is gone or you can no longer see it, and one that comes while the file is uploading comes after the token was used up. A 409 " +
        "`storage_quota_exceeded` means the note's storage space has no room for this file: don't retry until space has been " +
        "freed, and then ask for a new token. A 409 `server_busy` means the server was busy and the token is used up: ask for " +
        "a new token and retry. Once the server has started reading the file, a rejection (for example 413: over the size limit, " +
        "415: not a supported type — an image (PNG, JPEG, GIF, WebP or SVG), audio, video, a PDF, an Office or OpenDocument file, or a text file) still uses the token up. " +
        "If curl reports a connection error (a reset or a failed send) instead of a status, the server most likely refused the file — too large, not a supported type, or no room in the space — and the token is used up: check the file's size, type and the space's room before asking for a new token."
    );
    const exp = Date.parse(p.expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
  });

  it("download happy path: url has an <upload_id> placeholder, curl verbatim, method GET, next verbatim", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const p = (await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent as Payload;
    expect(p.method).toBe("GET");
    expect(p.url).toBe(`${ORIGIN}/api/uploads/<upload_id>`);
    expect(p.curl).toBe(`curl -sS -H "Authorization: Bearer ${p.token}" -o <output-file> "${ORIGIN}/api/uploads/<upload_id>"`);
    expect(p.next).toBe(DOWNLOAD_NEXT);
    // The description promises "what its status codes mean": every code GET can answer (401/403/404/429) must be mentioned.
    for (const code of ["401", "403", "404", "429"]) expect(DOWNLOAD_NEXT).toContain(`A ${code} `);
  });

  it("note the caller cannot see and a nonexistent note give the same not_found (byte-identical)", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const stranger = await ownerWithPat(db);
    const hidden = await call(app, o.pat, { note_id: stranger.noteId, purpose: "download" });
    const missing = await call(app, o.pat, { note_id: randomUUID(), purpose: "download" });
    expect(hidden.structuredContent).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
    expect(hidden.content[0]!.text).toBe(missing.content[0]!.text);
  });

  it("viewer: upload -> forbidden (verbatim message); download is issued", async () => {
    const { app, db } = await buildTestApp({ config });
    const owner = await ownerWithPat(db);
    const viewer = await seedUser(db);
    const { token } = await seedTokenForUser(db, viewer.id);
    await seedShare(db, owner.noteId, viewer.id, "viewer");
    expect((await call(app, token, { note_id: owner.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "forbidden",
      message: VIEWER_UPLOAD_MESSAGE,
    });
    expect((await call(app, token, { note_id: owner.noteId, purpose: "download" })).isError).toBeUndefined();
  });

  it("upload charges tokenWrite (limit:1 -> second issuance too_many_requests) and not contentRead; download charges contentRead and not tokenWrite", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const contentRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite, contentRead }) });
    const o = await ownerWithPat(db);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent!.code).toBe("too_many_requests");
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent!.code).toBe("too_many_requests");
  });

  // upload charges tokenWrite before checking note access, so issuing for an invisible note still charges. If requireWriteScope
  // moved after resolveNoteAccess, none would return before the charge and the second issuance below would succeed.
  it("upload for an invisible note: not_found, but tokenWrite is charged (limit:1 -> a following upload for the caller's own note gets too_many_requests)", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db);
    const stranger = await ownerWithPat(db);
    expect((await call(app, o.pat, { note_id: stranger.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "not_found",
      message: NOTE_NOT_FOUND_MESSAGE,
    });
    // Pin the message too: too_many_requests is also the pending-limit code (TOO_MANY_PENDING_MESSAGE), so the code alone can't
    // tell a limiter rejection. Literal copied from RATE_LIMITED_MESSAGE in `mcp/write-scope.ts` (not exported).
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "too_many_requests",
      message: "Too many writes with this credential right now. Wait a few minutes before writing again.",
    });
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("parent credential with 60 s left: expiresAt is capped to it; next and the description make no time promise other than 10 min", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const parentExp = new Date(Date.now() + 60_000);
    await db.update(apiTokens).set({ accessExpiresAt: parentExp }).where(eq(apiTokens.id, o.patId));
    const p = (await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload;
    expect(Date.parse(p.expiresAt)).toBe(parentExp.getTime());
    for (const s of [UPLOAD_NEXT, DOWNLOAD_NEXT, CREATE_TRANSFER_TOKEN_DESCRIPTION_RW, CREATE_TRANSFER_TOKEN_DESCRIPTION_RO]) {
      expect(s.match(/\d+\s*(?:minutes?|seconds?|hours?)/g) ?? [], s).toEqual(s.includes("10 minutes") ? ["10 minutes"] : []);
    }
  });

  it("parent credential deleted mid-issuance (beforeLock hook): unauthorized, zero rows", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
    const o = await ownerWithPat(db);
    seam.beforeLock = async () => {
      await db.delete(apiTokens).where(eq(apiTokens.id, o.patId));
    };
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "unauthorized",
      message: REVOKED_MESSAGE,
    });
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("parent credential expires mid-issuance (beforeLock hook sets access_expires_at to the past): expiry_chk -> unauthorized", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
    const o = await ownerWithPat(db);
    seam.beforeLock = async () => {
      await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 second'` }).where(eq(apiTokens.id, o.patId));
    };
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent).toEqual({
      code: "unauthorized",
      message: REVOKED_MESSAGE,
    });
  });

  for (const purpose of ["upload", "download"] as const) {
    it(`note deleted after resolveNoteAccess (afterCount hook, ${purpose}): not_found with NOTE_NOT_FOUND_MESSAGE`, async () => {
      const seam: IssueTransferTokenSeam = {};
      const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
      const o = await ownerWithPat(db);
      seam.afterCount = async () => {
        await db.delete(notes).where(eq(notes.id, o.noteId));
      };
      expect((await call(app, o.pat, { note_id: o.noteId, purpose })).structuredContent).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
    });
  }

  it("basic pending limit: 5 upload tokens in a row, 6th gets too_many_requests (verbatim); usable again after one is used (POST 201) or one expires; download is unlimited", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    expect(TOO_MANY_PENDING_MESSAGE).toContain(` ${MAX_PENDING_UPLOAD_TOKENS} unused upload tokens`);
    const tokens: Payload[] = [];
    for (let i = 0; i < 5; i++) tokens.push((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "too_many_requests",
      message: TOO_MANY_PENDING_MESSAGE,
    });
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: tokens[0]!.token })).statusCode).toBe(201);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
    const [row] = await db
      .select({ id: transferTokens.id })
      .from(transferTokens)
      .where(sql`${transferTokens.purpose} = 'upload' and ${transferTokens.consumedAt} is null`)
      .limit(1);
    await expireToken(db, row!.id);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
  });
});

describe("storage quota \"already full\" precheck (#200)", () => {
  const GIB2 = 2 ** 31;
  const rowCount = async (db: Awaited<ReturnType<typeof buildTestApp>>["db"]) => (await db.select({ id: transferTokens.id }).from(transferTokens)).length;

  it("visible form (note owner): storage_quota_exceeded, verbatim message (two numbers via formatBytes), extra has both raw numbers; no token issued (row count unchanged)", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, GIB2);
    // Two 1 GiB rows make 2 GiB.
    for (let i = 0; i < 2; i++) await seedAttachment(db, uploadsDir, o.noteId, o.userId, GIB2 / 2, { noFile: true });
    const before = await rowCount(db);
    const r = await call(app, o.pat, { note_id: o.noteId, purpose: "upload" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "storage_quota_exceeded",
      message:
        "This note's storage space is full (2 GB of 2 GB used), so no file can be uploaded to it. A site admin can assign a larger storage plan; deleting notes that have files also frees space.",
      usedBytes: GIB2,
      quotaBytes: GIB2,
    });
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    expect(storageFullVisibleMessage(GIB2, GIB2)).toBe((r.structuredContent as { message: string }).message);
    expect(await rowCount(db)).toBe(before);
  });

  it("hidden form (shared editor): verbatim message, no extra; no token issued", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ config });
    const owner = await ownerWithPat(db);
    const editor = await seedUser(db);
    const { token } = await seedTokenForUser(db, editor.id);
    await seedShare(db, owner.noteId, editor.id, "editor");
    await giveUserQuota(db, owner.userId, 1000);
    await seedAttachment(db, uploadsDir, owner.noteId, owner.userId, 1000, { noFile: true });
    const before = await rowCount(db);
    const r = await call(app, token, { note_id: owner.noteId, purpose: "upload" });
    expect(r.structuredContent).toEqual({
      code: "storage_quota_exceeded",
      message: "This note's storage space is full, so no file can be uploaded to it. Ask the note's owner or a site admin for more space.",
    });
    expect(STORAGE_FULL_HIDDEN_MESSAGE).toBe((r.structuredContent as { message: string }).message);
    expect(await rowCount(db)).toBe(before);
  });

  it("shared editor who is a site admin gets the visible form (isAdmin is read by a statement outside the transaction)", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ config });
    const owner = await ownerWithPat(db);
    const admin = await seedUser(db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const { token } = await seedTokenForUser(db, admin.id);
    await seedShare(db, owner.noteId, admin.id, "editor");
    await giveUserQuota(db, owner.userId, 1536);
    await seedAttachment(db, uploadsDir, owner.noteId, owner.userId, 2048, { noFile: true });
    const r = await call(app, token, { note_id: owner.noteId, purpose: "upload" });
    expect(r.structuredContent).toEqual({
      code: "storage_quota_exceeded",
      message: storageFullVisibleMessage(2048, 1536),
      usedBytes: 2048,
      quotaBytes: 1536,
    });
    expect(storageFullVisibleMessage(2048, 1536)).toContain("(2 KB of 1.5 KB used)");
  });

  it("download has no precheck: still issued when storage is full (one more row)", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    await seedAttachment(db, uploadsDir, o.noteId, o.userId, 1000, { noFile: true });
    const before = await rowCount(db);
    const r = await call(app, o.pat, { note_id: o.noteId, purpose: "download" });
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as Payload).purpose).toBe("download");
    expect(await rowCount(db)).toBe(before + 1);
  });

  it("under quota (1 byte short): upload is issued; the precheck only blocks used >= quota", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    await seedAttachment(db, uploadsDir, o.noteId, o.userId, 999, { noFile: true });
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
  });
});

describe("cleanup", () => {
  it("an expired row is gone after the next successful issuance (fire-and-forget, awaited); an unexpired one stays", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const dead = await issueDirect(db, o.patId, o.noteId, "download");
    const live = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, dead.id);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    await vi.waitFor(
      async () => {
        const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
        expect(ids).not.toContain(dead.id);
        expect(ids).toContain(live.id);
      },
      { timeout: 5_000 }
    );
  });
});
