import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SESSION_COOKIE, MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { buildTestApp, freshLimiters, signTestSession } from "./helpers.js";
import { notes, noteShares, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { docx, mp4, pdf } from "./helpers/upload-fixtures.js";
import { expectRangeServing } from "./helpers/upload-serving.js";
import { cookieOf } from "./group-helpers.js";
import { issueDirect, ownerWithPat } from "./transfer-helpers.js";
import { UPLOAD_CSP } from "../src/uploads/service.js";

const detectFaults = vi.hoisted(() => ({ head: false, whole: false }));
vi.mock("../src/uploads/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/uploads/detect.js")>("../src/uploads/detect.js");
  return {
    ...actual,
    classifyUploadHead: async (...args: Parameters<typeof actual.classifyUploadHead>) => {
      if (detectFaults.head) throw new Error("crafted head");
      return actual.classifyUploadHead(...args);
    },
    verifyWholeFile: async (...args: Parameters<typeof actual.verifyWholeFile>) => {
      if (detectFaults.whole) throw new Error("crafted body");
      return actual.verifyWholeFile(...args);
    },
  };
});


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
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>@keyframes spin{to{transform:rotate(360deg)}}rect{animation:spin 1s infinite}</style><rect width="20" height="20"/></svg>',
  "utf-8",
);
const MALICIOUS_SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject><image href="https://evil.example/track.png"/></svg>',
  "utf-8",
);
const NOT_AN_IMAGE_BYTES = Buffer.from("this is definitely not an image, just plain text bytes", "utf-8");
const UNSUPPORTED_MESSAGE =
  "Unsupported file type. Upload an image (PNG, JPEG, GIF, WebP or SVG), audio, video, a PDF, an Office or OpenDocument file, or a text file.";
const MIB = 1_048_576;
const EXPECTED_UPLOAD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";

function singleFileBody(data: Buffer, opts: { filename?: string; contentType?: string; boundary?: string } = {}): Buffer {
  return buildMultipartBody(
    [{ name: "file", filename: opts.filename ?? "test.png", contentType: opts.contentType ?? "image/png", data }],
    opts.boundary
  );
}

// The first part is a valid PNG: an unsupported first file would be refused with 415 before the parts limit is reached.
function manyFileParts(count: number): BodyPart[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file${i}`,
    filename: i === 0 ? "f0.png" : `f${i}.bin`,
    contentType: i === 0 ? "image/png" : "application/octet-stream",
    data: i === 0 ? PNG_BYTES : Buffer.from([0x00]),
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

  it("startup sweeps temp files older than an hour from uploadsDir, keeping fresh temp files and stored files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-sweep-"));
    try {
      const hoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
      for (const name of ["stale.tmp", "fresh.tmp", "stored"]) writeFileSync(path.join(dir, name), "x");
      utimesSync(path.join(dir, "stale.tmp"), hoursAgo, hoursAgo);
      utimesSync(path.join(dir, "stored"), hoursAgo, hoursAgo);
      await buildTestApp({ uploadsDir: dir });
      await vi.waitFor(() => expect(readdirSync(dir)).not.toContain("stale.tmp"), { timeout: 5_000 });
      expect(readdirSync(dir).sort()).toEqual(["fresh.tmp", "stored"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    expect(body).toEqual({ id: body.id, url: `/api/uploads/${body.id}`, mime: "image/png", kind: "image" });

    const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id)).limit(1);
    expect(row).toMatchObject({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: PNG_BYTES.length });

    const getRes = await app.inject({ method: "GET", url: body.url, cookies: { [SESSION_COOKIE]: cookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("multiple file parts: only the first is taken (mime/size match the first), the rest are drained without being stored", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
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
    expect(readdirSync(uploadsDir)).toEqual([id]);
  });

  it("400 invalid_body: parts over the limit (32, built from many file parts so the fields limit does not trigger first)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-parts@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, buildMultipartBody(manyFileParts(33)), { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // The first part was already received into its temp file when the limit tripped.
    expect(readdirSync(uploadsDir)).toEqual([]);
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
    expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: UNSUPPORTED_MESSAGE } });

    const badSvg = await postUpload(
      app,
      note.id,
      singleFileBody(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>', "utf-8"), { filename: "bad.svg", contentType: "image/svg+xml" }),
      { cookie },
    );
    expect(badSvg.statusCode).toBe(415);
    expect(badSvg.json().error).toEqual({
      code: "unsupported_media_type",
      message: "Unsupported image format. Upload a PNG, JPEG, GIF, WebP or SVG image.",
    });

    const noXmlnsSvg = await postUpload(
      app,
      note.id,
      singleFileBody(Buffer.from('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', "utf-8"), { filename: "no-xmlns.svg", contentType: "image/svg+xml" }),
      { cookie },
    );
    expect(noXmlnsSvg.statusCode).toBe(415);
    expect(noXmlnsSvg.json().error).toEqual({
      code: "unsupported_media_type",
      message: 'SVG files must declare xmlns="http://www.w3.org/2000/svg" on the root <svg> element.',
    });
  });

  it("415: SVG that uses an undeclared namespace prefix -> the message names the prefix (#389)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-svg-prefix@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(
      app,
      note.id,
      singleFileBody(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#r"/></svg>', "utf-8"), { filename: "prefix.svg", contentType: "image/svg+xml" }),
      { cookie },
    );
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toEqual({
      code: "unsupported_media_type",
      message: 'SVG files must declare every namespace prefix they use: the prefix "xlink" has no matching xmlns declaration.',
    });
  });

  it("201: SVG upload (including animated style and active tags kept verbatim) -> stored as image/svg+xml and served with CSP sandbox + nosniff (#389)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-svg@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    for (const [filename, data] of [["anim.svg", SVG_BYTES], ["evil.svg", MALICIOUS_SVG_BYTES]] as const) {
      const res = await postUpload(app, note.id, singleFileBody(data, { filename, contentType: "image/svg+xml" }), { cookie });
      expect(res.statusCode, filename).toBe(201);
      const body = res.json() as { id: string; url: string };
      const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id)).limit(1);
      expect(row, filename).toMatchObject({ noteId: note.id, uploaderId: owner.id, mime: "image/svg+xml", size: data.length });

      const getRes = await app.inject({ method: "GET", url: body.url, cookies: { [SESSION_COOKIE]: cookie } });
      expect(getRes.statusCode, filename).toBe(200);
      expect(getRes.headers["content-type"], filename).toBe("image/svg+xml");
      expect(getRes.headers["x-content-type-options"], filename).toBe("nosniff");
      expect(getRes.headers["content-security-policy"], filename).toBe(EXPECTED_UPLOAD_CSP);
      expect(getRes.headers["cache-control"], filename).toBe("private, max-age=31536000, immutable");
      expect(getRes.rawPayload.equals(data), filename).toBe(true);
    }
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
    expect(res.headers["content-security-policy"]).toBe(EXPECTED_UPLOAD_CSP);
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

describe("GET /api/uploads/:id: class headers, Range and HEAD", () => {
  const OOXML_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  async function uploadAs(
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    noteId: string,
    cookie: string,
    data: Buffer,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const res = await postUpload(app, noteId, singleFileBody(data, { filename, contentType }), { cookie });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function ownerSetup(overrides: Parameters<typeof buildTestApp>[0] = {}) {
    const built = await buildTestApp(overrides);
    const owner = await insertUser(built.db, { email: "alice@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(built.db, owner.id);
    return { ...built, owner, cookie, noteId: note.id };
  }

  it("session: a video plays inline under UPLOAD_CSP and answers a media player's Range, If-Range and HEAD requests", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const video = padded(mp4(), 4096);
    const id = await uploadAs(app, noteId, cookie, video, "clip.mp4", "video/mp4");
    await expectRangeServing(
      opts => app.inject({ method: opts?.method ?? "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie }, headers: opts?.headers }),
      video,
    );
    const tail = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie }, headers: { range: "bytes=-5000" } });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers["content-range"]).toBe("bytes 0-4095/4096");
    expect(tail.rawPayload.equals(video)).toBe(true);
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-security-policy"]).toBe(UPLOAD_CSP);
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"clip.mp4\"; filename*=UTF-8''clip.mp4");
  });

  it("transfer token: the same Range traffic works with a download token", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const video = padded(mp4(), 2048);
    const id = await uploadAs(app, o.noteId, (await cookieOf(o.userId))[SESSION_COOKIE]!, video, "clip.mp4", "video/mp4");
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    await expectRangeServing(
      opts => app.inject({ method: opts?.method ?? "GET", url: `/api/uploads/${id}`, headers: { authorization: `Bearer ${t.token}`, ...opts?.headers } }),
      video,
    );
  });

  it("transfer token: every Range request is charged to tokenRead, so the request over its limit is 429", async () => {
    const tokenRead = new FixedWindowLimiter({ limit: 3, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenRead }) });
    const o = await ownerWithPat(db);
    const id = await uploadAs(app, o.noteId, (await cookieOf(o.userId))[SESSION_COOKIE]!, padded(mp4(), 2048), "clip.mp4", "video/mp4");
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    const ranged = (range: string) => app.inject({ method: "GET", url: `/api/uploads/${id}`, headers: { authorization: `Bearer ${t.token}`, range } });
    expect((await ranged("bytes=0-1")).statusCode).toBe(206);
    expect((await ranged("bytes=100-")).statusCode).toBe(206);
    expect((await ranged("bytes=-10")).statusCode).toBe(206);
    expect((await ranged("bytes=0-1")).statusCode).toBe(429);
  });

  for (const segment of [".hidden", "100%done"]) {
    it(`uploadsDir under a directory named ${segment} serves 200 and 206`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "knb-serve-dir-"));
      const uploadsDir = path.join(root, segment, "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      try {
        const { app, cookie, noteId } = await ownerSetup({ uploadsDir });
        const id = await uploadAs(app, noteId, cookie, PNG_BYTES, "a.png", "image/png");
        const full = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
        expect(full.statusCode, full.body).toBe(200);
        expect(full.rawPayload.equals(PNG_BYTES)).toBe(true);
        const part = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie }, headers: { range: "bytes=0-1" } });
        expect(part.statusCode).toBe(206);
        expect(part.rawPayload.equals(PNG_BYTES.subarray(0, 2))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("an image keeps its headers: inline under UPLOAD_CSP with no Content-Disposition", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const id = await uploadAs(app, noteId, cookie, PNG_BYTES, "photo.png", "image/png");
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-security-policy"]).toBe(UPLOAD_CSP);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("a PDF opens inline with its own CSP and no sandbox", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const id = await uploadAs(app, noteId, cookie, Buffer.from(pdf()), "spec.pdf", "application/pdf");
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"spec.pdf\"; filename*=UTF-8''spec.pdf");
  });

  it("a docx named report.jar downloads as report.docx", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const id = await uploadAs(app, noteId, cookie, Buffer.from(docx()), "report.jar", "application/java-archive");
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(OOXML_DOCX);
    expect(res.headers["content-disposition"]).toBe("attachment; filename=\"report.docx\"; filename*=UTF-8''report.docx");
  });

  it("an old row without a stored name downloads as <id>.<canonical extension>", async () => {
    const { app, db, uploadsDir, owner, cookie, noteId } = await ownerSetup();
    const bytes = Buffer.from(docx());
    const [row] = await db.insert(uploads).values({ noteId, uploaderId: owner.id, mime: OOXML_DOCX, size: bytes.length }).returning();
    expect(row.fileName).toBeNull();
    writeFileSync(path.join(uploadsDir, row.id), bytes);
    const res = await app.inject({ method: "GET", url: `/api/uploads/${row.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${row.id}.docx"; filename*=UTF-8''${row.id}.docx`);
  });

  it("a non-ASCII name reaches the browser only as an ASCII fallback plus filename*", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const id = await uploadAs(app, noteId, cookie, Buffer.from(pdf()), "報告.pdf", "application/pdf");
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"__.pdf\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf");
  });

  it("HTML in a .txt file is served inline as text/plain under UPLOAD_CSP", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const html = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>\n", "utf-8");
    const id = await uploadAs(app, noteId, cookie, html, "notes.txt", "text/html");
    const res = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(UPLOAD_CSP);
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"notes.txt\"; filename*=UTF-8''notes.txt");
    expect(res.rawPayload.equals(html)).toBe(true);
  });

  it("a Latin-1 CSV (not valid UTF-8) is a download, and a script-like text name gets .txt appended", async () => {
    const { app, cookie, noteId } = await ownerSetup();
    const latin1 = await uploadAs(app, noteId, cookie, Buffer.from("caf\xe9,1\nna\xefve,2\n", "latin1"), "data.csv", "text/csv");
    const csv = await app.inject({ method: "GET", url: `/api/uploads/${latin1}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(csv.headers["content-type"]).toBe("text/csv");
    expect(csv.headers["content-disposition"]).toBe("attachment; filename=\"data.csv\"; filename*=UTF-8''data.csv");

    const script = await uploadAs(app, noteId, cookie, Buffer.from("Write-Host hi\n", "utf-8"), "build.ps1", "text/plain");
    const ps1 = await app.inject({ method: "GET", url: `/api/uploads/${script}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(ps1.headers["content-disposition"]).toBe("inline; filename=\"build.ps1.txt\"; filename*=UTF-8''build.ps1.txt");
  });

  it("HEAD on a row whose file is missing is the uniform 404", async () => {
    const { app, db, owner, cookie, noteId } = await ownerSetup();
    const [row] = await db.insert(uploads).values({ noteId, uploaderId: owner.id, mime: "image/png", size: 3 }).returning();
    const res = await app.inject({ method: "HEAD", url: `/api/uploads/${row.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-disposition"]).toBeUndefined();
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
        throw new Error("no TCP address after app.listen; this test needs a real socket");
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
            () => reject(new Error(`app.close() timed out after ${CLOSE_TIMEOUT_MS}ms: the rest of the request body was not drained and the connection hung`)),
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
      () => reject(new Error(`client socket did not close by itself within ${CLIENT_CLOSE_TIMEOUT_MS}ms: ${what}`)),
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
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`app.close() timed out after ${CLOSE_TIMEOUT_MS}ms`)), CLOSE_TIMEOUT_MS)),
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
        throw new Error("no TCP address after app.listen; this test needs a real socket");
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
      await expectClientSocketClosesByItself(res, "Connection: close did not end the connection");
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
        throw new Error("no TCP address after app.listen; this test needs a real socket");
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
      await expectClientSocketClosesByItself(res, "drainWithCap probably did not destroy() the underlying connection");
      await closeAppPromptly(app);
    },
    30_000
  );
});

/** `head` padded to `size` bytes: the head decides the type, the padding only makes the file big. */
function padded(head: Uint8Array, size: number): Buffer {
  return Buffer.concat([Buffer.from(head), Buffer.alloc(size - head.length, 0x20)]);
}

async function withDocumentLimit(built: Awaited<ReturnType<typeof buildTestApp>>, bytes: number): Promise<void> {
  const admin = await insertUser(built.db);
  await built.siteLimits.update(admin.id, { uploadMaxBytes: bytes });
}

describe("POST /api/notes/:id/uploads: streamed body", () => {
  it("a video within the media limit but over the document limit -> 201 kind video", async () => {
    const built = await buildTestApp();
    const { app, db, uploadsDir } = built;
    await withDocumentLimit(built, MIB);
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const video = padded(mp4(), Math.round(1.5 * MIB));

    const res = await postUpload(app, note.id, singleFileBody(video, { filename: "clip.mp4", contentType: "video/mp4" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    expect(res.json()).toEqual({ id, url: `/api/uploads/${id}`, mime: "video/mp4", kind: "video" });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    expect(row).toMatchObject({ mime: "video/mp4", size: video.length, fileName: "clip.mp4" });
    expect(readdirSync(uploadsDir)).toEqual([id]);
  }, 20_000);

  it("a PDF over the document limit -> 413, connection closed, no file left", async () => {
    const built = await buildTestApp();
    const { app, db, uploadsDir } = built;
    await withDocumentLimit(built, MIB);
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(padded(pdf(), MIB + 1), { filename: "a.pdf", contentType: "application/pdf" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("file_too_large");
    expect(res.headers.connection).toBe("close");
    expect(readdirSync(uploadsDir)).toEqual([]);
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toEqual([]);
  }, 20_000);

  it("a PDF exactly at the document limit -> 201", async () => {
    const built = await buildTestApp();
    const { app, db } = built;
    await withDocumentLimit(built, MIB);
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const res = await postUpload(app, note.id, singleFileBody(padded(pdf(), MIB), { filename: "a.pdf", contentType: "application/pdf" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ mime: "application/pdf", kind: "file" });
  }, 20_000);

  it("an unknown binary longer than the head -> 415 with the accepted kinds named, nothing left in the uploads directory", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const binary = Buffer.alloc(64 * 1024);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7919) & 0xff;

    const res = await postUpload(app, note.id, singleFileBody(binary, { filename: "tool.bin", contentType: "application/octet-stream" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: UNSUPPORTED_MESSAGE } });
    expect(res.headers.connection).toBe("close");
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("an empty file -> 400 invalid_body before any type check, no file left", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const res = await postUpload(app, note.id, singleFileBody(Buffer.alloc(0), { filename: "empty.txt", contentType: "text/plain" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "invalid_body", message: "The upload has no file." } });
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("HTML in a .txt file -> 201 stored as text/plain; charset=utf-8", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const html = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>\n", "utf-8");
    const res = await postUpload(app, note.id, singleFileBody(html, { filename: "notes.txt", contentType: "text/html" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    expect(res.json()).toEqual({ id, url: `/api/uploads/${id}`, mime: "text/plain; charset=utf-8", kind: "file" });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    expect(row?.mime).toBe("text/plain; charset=utf-8");
  });

  it("a text file whose long name is cut keeps its extension and is accepted as text", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const filename = `${"報".repeat(70)}.txt`;
    const res = await postUpload(app, note.id, singleFileBody(Buffer.from("hello\n", "utf-8"), { filename, contentType: "text/plain" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    expect(res.json()).toMatchObject({ mime: "text/plain; charset=utf-8", kind: "file" });
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    expect(row?.fileName?.endsWith(".txt")).toBe(true);
  });

  it("a text file with a NUL after the head -> 415 from the whole-file check, no file left", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const text = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0]), Buffer.alloc(16, 0x61)]);
    const res = await postUpload(app, note.id, singleFileBody(text, { filename: "a.csv", contentType: "text/csv" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.message).toBe(UNSUPPORTED_MESSAGE);
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("the stored file name is sanitized (format characters stripped)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const res = await postUpload(app, note.id, singleFileBody(Buffer.from(pdf()), { filename: "rep\u202Eort.pdf", contentType: "application/pdf" }), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, (res.json() as { id: string }).id));
    expect(row?.fileName).toBe("report.pdf");
  });

  for (const fault of ["head", "whole"] as const) {
    it(`type detection throwing on a crafted file (${fault} check) -> 415, no file left`, async () => {
      const { app, db, uploadsDir } = await buildTestApp();
      const owner = await insertUser(db);
      const note = await createNote(db, owner.id);
      detectFaults[fault] = true;
      try {
        const res = await postUpload(app, note.id, singleFileBody(Buffer.from("a,b\n1,2\n"), { filename: "a.csv", contentType: "text/csv" }), { cookie: await cookieFor(owner.id) });
        expect(res.statusCode).toBe(415);
        expect(res.json().error.code).toBe("unsupported_media_type");
      } finally {
        detectFaults[fault] = false;
      }
      expect(readdirSync(uploadsDir)).toEqual([]);
    });
  }

  it("no request timeout: a long upload is not cut off by the server", async () => {
    const { app } = await buildTestApp();
    expect(app.server.requestTimeout).toBe(0);
  });
});

describe("POST /api/notes/:id/uploads: access lost while the file was being received", () => {
  function atReceived(act: (noteId: string) => Promise<void>): { hook: GroupTestHook; hits: () => number } {
    let hits = 0;
    return {
      hook: async (point, ctx) => {
        if (point !== "upload-received") return;
        hits++;
        await act(ctx.noteId!);
      },
      hits: () => hits,
    };
  }

  it("editor share downgraded to viewer -> 403, no row, no file under either name", async () => {
    const holder: { db?: Db; editorId?: string } = {};
    const seam = atReceived(async noteId => {
      await holder.db!.update(noteShares).set({ role: "viewer" }).where(and(eq(noteShares.noteId, noteId), eq(noteShares.userId, holder.editorId!)));
    });
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seam.hook });
    const owner = await insertUser(db);
    const editor = await insertUser(db);
    Object.assign(holder, { db, editorId: editor.id });
    const note = await createNote(db, owner.id);
    await share(db, note.id, editor.id, "editor");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: await cookieFor(editor.id) });
    expect(seam.hits()).toBe(1);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: "You don't have edit access to this note." } });
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toEqual([]);
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("share removed -> 404, no row, no file", async () => {
    const holder: { db?: Db } = {};
    const seam = atReceived(async noteId => {
      await holder.db!.delete(noteShares).where(eq(noteShares.noteId, noteId));
    });
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seam.hook });
    const owner = await insertUser(db);
    const editor = await insertUser(db);
    holder.db = db;
    const note = await createNote(db, owner.id);
    await share(db, note.id, editor.id, "editor");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: await cookieFor(editor.id) });
    expect(seam.hits()).toBe(1);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toEqual([]);
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("note moved to the trash -> 404, no row, no file", async () => {
    const holder: { db?: Db; ownerId?: string } = {};
    const seam = atReceived(async noteId => {
      await holder.db!.update(notes).set({ deletedAt: new Date(), deletedBy: holder.ownerId! }).where(eq(notes.id, noteId));
    });
    const { app, db, uploadsDir } = await buildTestApp({ groupTestHook: seam.hook });
    const owner = await insertUser(db);
    Object.assign(holder, { db, ownerId: owner.id });
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: await cookieFor(owner.id) });
    expect(seam.hits()).toBe(1);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "No note with that id." } });
    expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toEqual([]);
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it("at upload-received the whole file is in its temp file and has no final name yet", async () => {
    const seen: { files?: string[] } = {};
    const holder: { dir?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point === "upload-received") seen.files = readdirSync(holder.dir!);
      },
    });
    holder.dir = uploadsDir;
    const owner = await insertUser(db);
    const note = await createNote(db, owner.id);
    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: await cookieFor(owner.id) });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect(seen.files).toEqual([`${id}.tmp`]);
    expect(readFileSync(path.join(uploadsDir, id)).equals(PNG_BYTES)).toBe(true);
    expect(readdirSync(uploadsDir)).toEqual([id]);
  });
});

describe("real socket: a client that aborts while the file streams in", () => {
  it(
    "the client destroys its socket after part of a PDF: the temp file is deleted, no row is written, and app.close() finishes promptly",
    async () => {
      const { app, db, uploadsDir } = await buildTestApp();
      const owner = await insertUser(db);
      const note = await createNote(db, owner.id);
      const cookie = await cookieFor(owner.id);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("no TCP address after app.listen");

      const body = singleFileBody(padded(pdf(), MIB), { filename: "cut.pdf", contentType: "application/pdf" });
      const req = http.request({
        host: "127.0.0.1", port: address.port, path: `/api/notes/${note.id}/uploads`, method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length), cookie: `${SESSION_COOKIE}=${cookie}` },
      });
      req.on("error", () => {});
      req.write(body.subarray(0, 256 * 1024));
      // Abort only once the server is writing the temp file, so the cut lands mid-stream rather than before the handler ran.
      await vi.waitFor(() => expect(readdirSync(uploadsDir).some(f => f.endsWith(".tmp"))).toBe(true), { timeout: 5_000, interval: 20 });
      req.destroy();

      await vi.waitFor(() => expect(readdirSync(uploadsDir)).toEqual([]), { timeout: 5_000, interval: 20 });
      expect(await db.select().from(uploads).where(eq(uploads.noteId, note.id))).toEqual([]);
      await closeAppPromptly(app);
    },
    30_000,
  );
});

describe("real socket: a refusal while the file streams in", () => {
  it(
    "a PDF three times the document limit -> the 413 arrives while the client still holds a third of the body back, with Connection: close, and no file is left",
    async () => {
      const built = await buildTestApp();
      const { app, db, uploadsDir } = built;
      await withDocumentLimit(built, MIB);
      const owner = await insertUser(db);
      const note = await createNote(db, owner.id);
      const cookie = await cookieFor(owner.id);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("no TCP address after app.listen");

      const body = singleFileBody(padded(pdf(), 3 * MIB), { filename: "big.pdf", contentType: "application/pdf" });
      // The client sends two thirds of the body and then waits: a server that only answers after the whole body never answers inside the wait.
      const PAUSE_AT = 2 * MIB;
      const WAIT_MS = 5_000;
      let clientReq: http.ClientRequest | undefined;
      const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; writtenAtResponse: number }>((resolve, reject) => {
        let written = 0;
        let responded = false;
        const req = http.request(
          {
            host: "127.0.0.1", port: address.port, path: `/api/notes/${note.id}/uploads`, method: "POST",
            headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length), cookie: `${SESSION_COOKIE}=${cookie}` },
          },
          r => {
            responded = true;
            const writtenAtResponse = written;
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString("utf-8"), writtenAtResponse }));
            r.on("error", reject);
          },
        );
        clientReq = req;
        // The server closing the connection while the client still has unsent bytes is expected.
        req.on("error", () => {});
        req.once("socket", s => s.on("error", () => {}));
        const CHUNK = 64 * 1024;
        const pump = (): void => {
          while (written < PAUSE_AT) {
            const end = Math.min(written + CHUNK, PAUSE_AT);
            const ok = req.write(body.subarray(written, end));
            written = end;
            if (!ok) {
              req.once("drain", pump);
              return;
            }
          }
          setTimeout(() => {
            if (responded) return;
            written = body.length;
            req.end(body.subarray(PAUSE_AT));
          }, WAIT_MS);
        };
        pump();
      });
      clientReq?.destroy();

      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "file_too_large" } });
      expect(res.headers.connection).toBe("close");
      expect(res.writtenAtResponse).toBeLessThan(body.length);
      expect(readdirSync(uploadsDir)).toEqual([]);
      await closeAppPromptly(app);
    },
    30_000,
  );
});
