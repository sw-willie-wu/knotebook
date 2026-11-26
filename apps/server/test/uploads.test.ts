import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { buildTestApp, freshLimiters, signTestSession } from "./helpers.js";
import { notes, noteShares, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";


async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

async function createNote(db: Db, ownerId: string, title?: string): Promise<{ id: string }> {
  const values = title === undefined ? { ownerId } : { ownerId, title };
  const [row] = await db.insert(notes).values(values).returning({ id: notes.id });
  return row;
}

async function share(db: Db, noteId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
  await db.insert(noteShares).values({ noteId, userId, role });
}


interface BodyPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

const BOUNDARY = "knotebookTestBoundary";

// Built from Buffers: file bytes are binary (image magic bytes) and must not round-trip through a string.
function buildMultipartBody(parts: BodyPart[], boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const dispo =
      part.filename !== undefined
        ? `form-data; name="${part.name}"; filename="${part.filename}"`
        : `form-data; name="${part.name}"`;
    const headerLines = [`--${boundary}`, `Content-Disposition: ${dispo}`];
    if (part.contentType !== undefined) headerLines.push(`Content-Type: ${part.contentType}`);
    headerLines.push("", "");
    chunks.push(Buffer.from(headerLines.join("\r\n"), "utf-8"));
    chunks.push(typeof part.data === "string" ? Buffer.from(part.data, "utf-8") : part.data);
    chunks.push(Buffer.from("\r\n", "utf-8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
  return Buffer.concat(chunks);
}

// A complete 8-byte PNG signature (`detectImageMimeType` requires the whole signature, not an arbitrary prefix) plus some content,
// so that "the file is not empty" is covered too.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
const NOT_AN_IMAGE_BYTES = Buffer.from("this is definitely not an image, just plain text bytes", "utf-8");

function singleFileBody(data: Buffer, opts: { filename?: string; contentType?: string; boundary?: string } = {}): Buffer {
  return buildMultipartBody(
    [{ name: "file", filename: opts.filename ?? "test.png", contentType: opts.contentType ?? "image/png", data }],
    opts.boundary
  );
}

function manyFileParts(count: number): BodyPart[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file${i}`,
    filename: `f${i}.bin`,
    contentType: "application/octet-stream",
    data: Buffer.from([0x00]),
  }));
}

function manyFieldParts(count: number): BodyPart[] {
  return Array.from({ length: count }, (_, i) => ({ name: `field${i}`, data: "x" }));
}

async function postUpload(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  noteId: string,
  body: Buffer,
  opts: { cookie?: string; boundary?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${opts.boundary ?? BOUNDARY}`,
    ...opts.headers,
  };
  return app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    payload: body,
    cookies: opts.cookie !== undefined ? { [SESSION_COOKIE]: opts.cookie } : undefined,
    headers,
  });
}


/**
 * Sends a real TCP request with `node:http` (not `app.inject`): inject goes through light-my-request with the whole payload in memory and no real
 * socket, so it cannot show "the server did not read the request body to the end, leaving the connection stuck" (which holds up `server.close()` only on a real socket).
 * The result contains `socket`: after asserting the response the caller must `socket.destroy()` BEFORE `app.close()`, otherwise the client's own
 * keep-alive connection makes `app.close()` wait for it to close naturally, a false positive (that connection's lifetime is not what is being tested).
 *
 * `clientErrors`: when the server cuts the connection (`drainWithCap` over its cap calls `destroy()` on `request.raw`, see `src/http/drain.ts`; a `Connection: close` refusal ends the socket) a
 * client still writing a large body gets ECONNRESET/EPIPE on its socket (seen in CI as `write ECONNRESET`; local loopback is usually too fast, the whole body is already
 * written, see the timing note in that test). That is an expected side effect of `destroy()`, not a bug, but the client must catch it: Node treats an 'error' on an
 * EventEmitter with no listener as an uncaughtException that blows up the whole test file even when every assertion passed. A listener only on
 * `req.on("error", reject)` catches errors before the response completes; socket-level errors after the response completed and the Promise resolved (the CI case:
 * the response arrived long ago while the client was still writing the rest of the large body) are not guaranteed to be covered by the request-level 'error'
 * proxy per the Node docs - so a permanent `error` listener is also attached directly on `req.socket` (obtained via `req.once("socket", ...)`, earlier and safer
 * than `req.socket`, which may not be assigned yet), which records errors into the `clientErrors` array instead of swallowing them: callers can assert selectively
 * (e.g. the over-cap test allows ECONNRESET/EPIPE), and unexpected client errors in other tests stay visible (the array is non-empty), so real regressions are not silenced.
 */
function rawSocketPost(opts: { port: number; path: string; headers: Record<string, string>; body: Buffer }): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  socket: Socket;
  clientErrors: Error[];
}> {
  return new Promise((resolve, reject) => {
    const clientErrors: Error[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: "POST",
        headers: { ...opts.headers, "content-length": String(opts.body.length) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
            socket: req.socket!,
            clientErrors,
          });
        });
        res.on("error", reject);
      }
    );
    // Permanent on the socket itself: covers errors after the response completed (Promise already resolved); such errors neither would nor need to change the settled Promise.
    req.once("socket", socket => {
      socket.on("error", err => {
        clientErrors.push(err);
      });
    });
    // Covers errors before the response completes (e.g. cannot connect) - keeps the original reject semantics; rejecting an already resolved Promise is a no-op.
    req.on("error", err => {
      clientErrors.push(err);
      reject(err);
    });
    req.end(opts.body);
  });
}

describe("uploadsDir writability probe at startup (AppDeps.uploadsDir)", () => {
  it("the parent path of uploadsDir is actually a regular file (not a directory) -> buildApp throws synchronously, fail-fast (regardless of mode)", async () => {
    // Fixture: create a real parent directory containing a regular file, then pass `<that file>/uploads` as uploadsDir - any attempt to write a probe file
    // under it fails with ENOTDIR because a path segment is a file, regardless of the file's mode (even chmod 777 is still a file, not a directory).
    const parentDir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-fixture-"));
    const regularFile = path.join(parentDir, "not-a-directory");
    writeFileSync(regularFile, "");
    const bogusUploadsDir = path.join(regularFile, "uploads");

    try {
      await expect(buildTestApp({ uploadsDir: bogusUploadsDir })).rejects.toThrow(/uploads 目錄不可寫/);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});

// The real `POST /api/notes/:id/uploads` is mounted (the earlier stub route `withUploadStubRoute` / `/__test/not-exempt` was removed because registering the same URL twice gives
// FST_ERR_DUPLICATED_ROUTE). The essence / Origin mismatch branches are stopped in the CSRF hook, with no real login or real note needed - a fake UUID noteId works,
// because both early exits happen before route params are parsed and before resolveRole queries the DB. The positive Origin-match case goes through the full real
// flow (real login + real note + valid PNG bytes) and asserts 201, covering both "CSRF lets it through" and "the real route really accepts this request".
// The allowlist check needs no dedicated stub route: `@fastify/multipart` is registered at the top level of the production app (`app.ts`),
// so the "CSRF regression" case below (multipart body to `/api/auth/login` still 415) catches it: if `isMultipartExemptRoute`
// degraded to "check only essence, not the allowlist", that request would flow into the real `/api/auth/login` handler (multipart does not fill `request.body`, zod safeParse
// fails on undefined) -> 400 instead of the correct 415; the status code alone shows it.
describe("CSRF hook: multipart upload route exemption + Origin check (re-verified against the real route)", () => {
  const FAKE_NOTE_ID = "11111111-1111-1111-1111-111111111111";

  it("essence is not multipart/form-data (upload endpoint, no Origin) -> 415 unsupported_media_type (essence is checked before Origin)", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${FAKE_NOTE_ID}/uploads`,
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("a faked essence (text/plain) is still 415", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${FAKE_NOTE_ID}/uploads`,
      payload: "x",
      headers: { "content-type": "text/plain" },
    });
    expect(res.statusCode).toBe(415);
  });

  describe("Origin matrix (after essence matches)", () => {
    it("Origin host differs from request.host -> 403 forbidden", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "https://evil.example.com", host: "localhost:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toEqual({ code: "forbidden", message: "Origin check failed: the request's Origin doesn't match its Host." });
    });

    it("same host, different port (neither 80/443) -> 403 (a port difference must not be ignored in the LAN shape)", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "http://192.168.1.50:9999", host: "192.168.1.50:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("Origin: null (literal string) -> 403", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "null", host: "localhost:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("LAN shape with a port (192.168.x.x:3000) where Origin matches host -> passes the CSRF gate and reaches the real route (201 after login + real note)", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-lan@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "http://192.168.1.50:3000", host: "192.168.1.50:3000" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("mixed scheme (https Origin vs http host) still matches -> passes (scheme ignored)", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-scheme@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "https://example.com", host: "example.com" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("default port normalization (example.com vs example.com:443) -> passes", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-port443@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "https://example.com", host: "example.com:443" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("no Origin header -> allowed (not a vector the CSRF gate protects)", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-noorigin@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie, headers: { host: "localhost:3000" } });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("CSRF regression: the existing JSON guard is unaffected by this extension", () => {
    it("non-multipart route (existing /api/auth/login) with a non-JSON content-type -> still 415", async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: "x",
        headers: { "content-type": "text/plain" },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    });

    it("multipart body to a non-exempt route (existing /api/auth/login) -> still 415 (covers the allowlist check, see the comment above)", async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: singleFileBody(PNG_BYTES),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    });
  });
});


describe("POST /api/notes/:id/uploads", () => {
  it("201: DB row noteId/uploaderId/mime/size correct, GET round-trips the same bytes as the original upload", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-201@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string };
    expect(body.url).toBe(`/api/uploads/${body.id}`);

    const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id)).limit(1);
    expect(row).toMatchObject({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: PNG_BYTES.length });

    const getRes = await app.inject({ method: "GET", url: body.url, cookies: { [SESSION_COOKIE]: cookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("multiple file parts: only the first is taken (mime/size match the first), the rest are drained without being stored", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-multi@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const body = buildMultipartBody([
      { name: "file", filename: "a.png", contentType: "image/png", data: PNG_BYTES },
      { name: "file2", filename: "b.jpg", contentType: "image/jpeg", data: JPEG_BYTES },
    ]);
    const res = await postUpload(app, note.id, body, { cookie });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.mime).toBe("image/png");
    expect(row?.size).toBe(PNG_BYTES.length);
    const allRows = await db.select().from(uploads).where(eq(uploads.noteId, note.id));
    expect(allRows).toHaveLength(1);
  });

  it("400 invalid_body: parts over the limit (32, built from many file parts so the fields limit does not trigger first)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-parts@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, buildMultipartBody(manyFileParts(33)), { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("400 invalid_body: fields over the limit (16)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-fields@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, buildMultipartBody(manyFieldParts(17)), { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("400 invalid_body: missing boundary (Content-Type is multipart/form-data without boundary=)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-noboundary@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/uploads`,
      payload: singleFileBody(PNG_BYTES),
      cookies: { [SESSION_COOKIE]: cookie },
      headers: { "content-type": "multipart/form-data" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("401: unauthenticated", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-401@example.com" });
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES));
    expect(res.statusCode).toBe(401);
  });

  it("unauthenticated + mismatched Origin -> 403 (not 401: the Origin check is in the CSRF hook's onRequest, before authenticate; do not assert 401)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-badorigin@example.com" });
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
      headers: { origin: "https://evil.example.com", host: "localhost:3000" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404: note does not exist (valid UUID format but no such note)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-404@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await postUpload(app, "22222222-2222-2222-2222-222222222222", singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404: noteId is not a valid UUID format", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-notuuid@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await postUpload(app, "not-a-uuid", singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("403: a viewer has no upload permission", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-viewer403@example.com" });
    const viewer = await insertUser(db, { email: "viewer-403@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, viewer.id, "viewer");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: viewerCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("an editor can upload (not only the owner)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-editor201@example.com" });
    const editor = await insertUser(db, { email: "editor-201@example.com" });
    const editorCookie = await cookieFor(editor.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, editor.id, "editor");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: editorCookie });
    expect(res.statusCode).toBe(201);
  });

  it("415: magic bytes disguised (claims image/png but the content is no supported image format)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-415@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(NOT_AN_IMAGE_BYTES, { contentType: "image/png" }), { cookie });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("413: file over MAX_UPLOAD_BYTES -> file_too_large, nothing stored (no file left on disk, including temp files)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-413@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_UPLOAD_BYTES, 0x41)]);
    const res = await postUpload(app, note.id, singleFileBody(oversized), { cookie });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("file_too_large");

    const allRows = await db.select().from(uploads).where(eq(uploads.noteId, note.id));
    expect(allRows).toHaveLength(0);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  }, 20_000);

  it("429: over the rate limit (per user, overridden to limit:1 so the test need not send 121 requests)", async () => {
    const smallUploadLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({
      limiters: freshLimiters({ upload: smallUploadLimiter }),
    });
    const owner = await insertUser(db, { email: "owner-429@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res1 = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res1.statusCode).toBe(201);

    const res2 = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error.code).toBe("too_many_requests");
  });

  // This uses `app.inject` (no real socket): it can only prove that "an early 4xx exit gets a structured error body" - NOT that "the connection is not stuck" (inject has no TCP
  // connection to get stuck). The preHandler early exits (401/403/404/429) are fine on a real socket because they never touch `request.parts()`: Node's own
  // `resOnFinish`/`_dump()` drops the unread body; what needs a real socket is the path that already started parsing and then errored midway, see the "real socket drain" section below.
  it("large body + early 4xx exit (viewer 403, limiter/parts have not touched the body yet) still gets a structured error body", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-drain@example.com" });
    const viewer = await insertUser(db, { email: "viewer-drain@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, viewer.id, "viewer");

    // `2 * MAX_UPLOAD_BYTES` equals the cap exactly, and multipart framing overhead (boundary/headers, about 147 bytes) would silently push the real byte count over the cap,
    // making this "under cap" regression test land in the same branch as the "over cap" test - subtract 1 KiB as a buffer to be strictly under the cap, so this and the over-cap test
    // form a true under/over pair.
    const bigBody = singleFileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES - 1024, 0x42));
    const res = await postUpload(app, note.id, bigBody, { cookie: viewerCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  }, 20_000);
});


describe("GET /api/uploads/:id", () => {
  async function uploadOne(
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    noteId: string,
    cookie: string
  ): Promise<{ id: string; url: string }> {
    const res = await postUpload(app, noteId, singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; url: string };
  }

  it("200: Content-Type is the DB mime, with nosniff + Cache-Control, bytes equal the original file", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get200@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, cookie);

    const res = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("401: unauthenticated", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getunauth@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, cookie);

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("403: signed-in user has no permission on the note (a DB row exists, they just cannot see it)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get403@example.com" });
    const stranger = await insertUser(db, { email: "stranger-get403@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, ownerCookie);

    const res = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("404: id is not UUID format", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getnotuuid@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/uploads/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404: valid UUID but no such upload record", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getmissing@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/uploads/33333333-3333-3333-3333-333333333333",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404: DB row exists but the file is not found on disk", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getdiskmissing@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    // Insert an uploads DB row directly, without the real POST (no disk file), simulating "DB has a record, disk has no file" (e.g. the volume was wiped or a file deleted by hand).
    const [row] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: PNG_BYTES.length })
      .returning();

    const res = await app.inject({ method: "GET", url: `/api/uploads/${row.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

// This describe covers what `app.inject` cannot measure: `request.parts()` has started consuming (`request.pipe(bb)` really ran) and then ended in error midway because
// parts/fields exceeded the limit - busboy's `cleanup(err)` only does `request.unpipe(bb)` and never `resume()`s the rest of the body. Once parsing has started, Node considers
// the app layer to have taken over consuming this request (`req._consuming`), and the automatic `_dump()` (discard unread body) on response close does not apply - a different
// path from "preHandler exits early without touching the body" (401/403/404/429), which is fine on a real socket (Node dumps by itself); only "started parsing, then errored midway"
// needs our own `resume()` (see the catch branch in `routes/uploads.ts`). Only a real socket can show "body not read to the end -> connection stuck -> graceful shutdown
// (`app.close()`) hangs"; `app.inject`'s payload is entirely in memory and has no TCP connection to get stuck.
describe("real socket drain check (parts over the limit reaches the catch branch)", () => {
  it(
    "400 invalid_body (33 small file parts trip the parts limit, followed by an unparsed 20 MB part): " +
      "the client gets a structured error body and graceful shutdown (app.close()) finishes in reasonable time - " +
      "it does not hang on the undrained rest of the body (the client socket is destroyed before close so keep-alive itself causes no false positive)",
    async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-realsocket-drain@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("app.listen 後取不到 TCP 位址——真 socket 測試需要真的 port");
      }

      // 33 small file parts (parts limit 32, the 33rd trips partsLimit) + one part slightly under 20 MB that will never be parsed - once the parts limit trips, busboy
      // unpipes at once and that part's bytes stay in the request untouched. About 20 MB is chosen on purpose: too small and the OS/Node buffer might hold it even with
      // no resume(), and the hang would not be observed.
      //
      // `20 * 1024 * 1024` equals the cap exactly (`MAX_UPLOAD_BYTES * 2`), and the multipart framing overhead of 33 small parts (about 4.6 KB) would silently push the
      // total over the cap and land this "under cap" regression in the "over cap" branch - subtract a 64 KiB buffer (far more than the overhead) to be strictly under.
      const bigTail = {
        name: "big",
        filename: "big.bin",
        contentType: "application/octet-stream",
        data: Buffer.alloc(20 * 1024 * 1024 - 64 * 1024, 0x41),
      };
      const body = buildMultipartBody([...manyFileParts(33), bigTail]);

      let socket: Socket | undefined;
      try {
        const res = await rawSocketPost({
          port: address.port,
          path: `/api/notes/${note.id}/uploads`,
          headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, cookie: `${SESSION_COOKIE}=${cookie}` },
          body,
        });
        socket = res.socket;

        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ error: { code: "invalid_body" } });
      } finally {
        // Close the client connection first, then the server - otherwise even if the server drained the body correctly, the client's own keep-alive connection
        // makes app.close() wait for it to end naturally, misreading an unrelated keep-alive as the bug being tested.
        socket?.destroy();
      }

      const closeStart = Date.now();
      const CLOSE_TIMEOUT_MS = 10_000;
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`app.close() 逾時（${CLOSE_TIMEOUT_MS}ms）——剩餘 request body 未被 drain，連線卡住`)),
            CLOSE_TIMEOUT_MS
          )
        ),
      ]);
      expect(Date.now() - closeStart).toBeLessThan(CLOSE_TIMEOUT_MS);
    },
    30_000
  );
});

// `app.inject` cannot show what is verified here (no real socket; `request.raw.destroy()` merely destroys an in-memory fake stream) - a real socket is required.
//
// Both cases send a body clearly over the drain cap (2 x MAX_UPLOAD_BYTES + 8 MiB) with an early refusal, and assert the structured error still arrives and the client socket
// then closes by itself well within Node's default `keepAliveTimeout` (5000 ms). The response is written in the same synchronous stack as the refusal, so it finishes
// before the server can cut the connection.
const overCapBody = (): Buffer => singleFileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES + 8 * 1024 * 1024, 0x42));

async function expectClientSocketClosesByItself(res: { socket: Socket; clientErrors: Error[] }, what: string): Promise<void> {
  // 800 ms is well below keepAliveTimeout yet about 40x the ~20 ms close of the passing case, so a stuck connection is detected quickly.
  const CLIENT_CLOSE_TIMEOUT_MS = 800;
  await new Promise<void>((resolve, reject) => {
    if (res.socket.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`client socket 未在 ${CLIENT_CLOSE_TIMEOUT_MS}ms 內自行關閉——${what}`)),
      CLIENT_CLOSE_TIMEOUT_MS
    );
    res.socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  expect(res.socket.destroyed).toBe(true);
  // A server-side cut is a hard abort for a client still writing the rest of the large body (CI timing; local loopback is usually too fast to observe it):
  // only ECONNRESET/EPIPE are expected, any other error code must not be silenced.
  for (const err of res.clientErrors) {
    expect(["ECONNRESET", "EPIPE"]).toContain((err as NodeJS.ErrnoException).code);
  }
}

async function closeAppPromptly(app: Awaited<ReturnType<typeof buildTestApp>>["app"]): Promise<void> {
  // The client has already closed by itself, so there is no lingering connection to wait for.
  const closeStart = Date.now();
  const CLOSE_TIMEOUT_MS = 10_000;
  await Promise.race([
    app.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`app.close() 逾時（${CLOSE_TIMEOUT_MS}ms）`)), CLOSE_TIMEOUT_MS)),
  ]);
  expect(Date.now() - closeStart).toBeLessThan(CLOSE_TIMEOUT_MS);
}

describe("upload preHandler refusal closes the connection (real socket, body over 2 x MAX_UPLOAD_BYTES)", () => {
  it(
    "viewer 403 before multipart parsing + a huge body: the structured 403 arrives with Connection: close, and the client socket closes by itself without the server reading the body",
    async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-drain-overcap@example.com" });
      const viewer = await insertUser(db, { email: "viewer-drain-overcap@example.com" });
      const viewerCookie = await cookieFor(viewer.id);
      const note = await createNote(db, owner.id);
      await share(db, note.id, viewer.id, "viewer");

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("app.listen 後取不到 TCP 位址——真 socket 測試需要真的 port");
      }

      const res = await rawSocketPost({
        port: address.port,
        path: `/api/notes/${note.id}/uploads`,
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          cookie: `${SESSION_COOKIE}=${viewerCookie}`,
        },
        body: overCapBody(),
      });

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden" } });
      expect(res.headers.connection).toBe("close");
      await expectClientSocketClosesByItself(res, "Connection: close 沒有結束連線");
      await closeAppPromptly(app);
    },
    30_000
  );
});

describe("drainWithCap byte limit (real socket, pre-auth refusal with a body over the cap)", () => {
  it(
    "401 for a malformed transfer token + a body past the cap: the structured 401 arrives (no Connection: close), then drainWithCap destroys the connection instead of keeping it alive",
    async () => {
      const { app } = await buildTestApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("app.listen 後取不到 TCP 位址——真 socket 測試需要真的 port");
      }

      const res = await rawSocketPost({
        port: address.port,
        path: `/api/notes/00000000-0000-4000-8000-000000000000/uploads`,
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          authorization: "Bearer not-a-transfer-token",
        },
        body: overCapBody(),
      });

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "unauthorized" } });
      expect(res.headers.connection).not.toBe("close");
      await expectClientSocketClosesByItself(res, "drainWithCap 疑似沒有真的 destroy() 底層連線");
      await closeAppPromptly(app);
    },
    30_000
  );
});
