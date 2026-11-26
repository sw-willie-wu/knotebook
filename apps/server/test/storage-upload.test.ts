import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { MAX_UPLOAD_BYTES, SESSION_COOKIE } from "@knotebook/shared";
import { uploads } from "../src/db/schema.js";
import { purgeTrashedNotesInTx } from "../src/notes/tx/trash.js";
import { buildTestApp, signTestSession } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { QUOTA_BOUNDARY, filesIn, giveGroupQuota, giveUserQuota, multipartFile, pngOf, quotaBody, seedAttachment, upload, usedOf } from "./storage-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";
import { fileBody, issueDirect, ownerWithPat, tokenRow, upload as transferUpload } from "./transfer-helpers.js";

// In this file the default space-lock limit is 60 s (5000 ms in production), so the wall-clock bound of "the injected short limit took effect" stays far from both ends - see ./lock-timeout-bound.ts.
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const rowsOf = async (db: Awaited<ReturnType<typeof buildTestApp>>["db"], noteId: string) =>
  db.select({ size: uploads.size }).from(uploads).where(eq(uploads.noteId, noteId));

describe("upload: quota decisions", () => {
  it("plan 1000: 600 -> 201; 600 -> 409 (owner sees three numbers), no new file on disk, no new row; 400 -> 201 (equal to the limit); then the preHandler 409 (incomingBytes null)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });

    expect((await upload(app, n.id, u.id, 600)).statusCode).toBe(201);
    const files1 = await filesIn(uploadsDir);
    const r2 = await upload(app, n.id, u.id, 600);
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect(await filesIn(uploadsDir)).toEqual(files1);
    expect(await rowsOf(db, n.id)).toEqual([{ size: 600 }]);

    expect((await upload(app, n.id, u.id, 400)).statusCode).toBe(201);
    const r4 = await upload(app, n.id, u.id, 8);
    expect(r4.statusCode).toBe(409);
    expect(r4.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(1000);
  });

  it("preHandler pre-check responds before the body is read: a real socket sends a 9 MB body and the 409 arrives before the body is fully sent (still structured JSON)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 0);
    const n = await seedNote(db, { ownerId: u.id });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const body = multipartFile(pngOf(9 * 1024 * 1024));
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
    let sentWhenResponded = -1;
    let written = 0;
    let clientReq: http.ClientRequest | undefined;
    let guard: NodeJS.Timeout | undefined;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/notes/${n.id}/uploads`, method: "POST", headers: {
        "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}`, "content-length": String(body.length), cookie,
      } }, r => {
        sentWhenResponded = written;
        const chunks: Buffer[] = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      });
      clientReq = req;
      req.on("error", () => { /* the server ending the connection after the 409 is expected (Connection: close) */ });
      req.once("socket", s => s.on("error", () => {}));
      // 64 KB per chunk, yielding to the event loop between chunks so the response can arrive before sending finishes.
      const CHUNK = 64 * 1024;
      const pump = (): void => {
        while (written < body.length) {
          const ok = req.write(body.subarray(written, written + CHUNK));
          written += Math.min(CHUNK, body.length - written);
          if (!ok) { req.once("drain", pump); return; }
          if (written % (CHUNK * 8) === 0) { setImmediate(pump); return; }
        }
        req.end();
      };
      pump();
      guard = setTimeout(() => reject(new Error("timeout")), 20_000);
    });
    clearTimeout(guard);
    // The client connection's lifecycle is not what this case tests: destroy the client socket before app.close(), otherwise keep-alive
    // or a body still being written makes the graceful shutdown wait for it (same note as `rawSocketPost` in test/uploads.test.ts).
    clientReq!.destroy();
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual(quotaBody({ incomingBytes: null, usedBytes: 0, quotaBytes: 0 }));
    expect(sentWhenResponded).toBeLessThan(body.length);
    await app.close();
  }, 30_000);
});

describe("upload: metering by space and number visibility", () => {
  it("A's personal note shared to B (editor), B uploads -> counts for A; when B is rejected only incomingBytes; when A is rejected three numbers", async () => {
    const { app, db } = await buildTestApp();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    await giveUserQuota(db, b.id, null);
    const n = await seedNote(db, { ownerId: a.id });
    await seedShare(db, n.id, b.id, "editor");
    expect((await upload(app, n.id, b.id, 900)).statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(900);
    expect(await usedOf(db.$client, { kind: "user", id: b.id })).toBe(0);
    const rb = await upload(app, n.id, b.id, 200);
    expect(rb.statusCode).toBe(409);
    expect(rb.json()).toEqual(quotaBody({ incomingBytes: 200 }));
    const ra = await upload(app, n.id, a.id, 200);
    expect(ra.json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
  });

  it("group note: ordinary member rejected -> incomingBytes only; manageGroup rejected -> three numbers; a non-member site admin has no role on the note -> 404; manageGroup's pre-check 409 -> three numbers (null incoming)", async () => {
    const { app, db } = await buildTestApp();
    const [gAdmin, gMember, site] = await Promise.all([seedUser(db), seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 1000);
    const n = await seedNote(db, { groupId: g.id });
    expect((await upload(app, n.id, gMember.id, 900)).statusCode).toBe(201);
    expect((await upload(app, n.id, gMember.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200 }));
    expect((await upload(app, n.id, gAdmin.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect((await upload(app, n.id, gAdmin.id, 100)).statusCode).toBe(201);
    // A site admin who is not a member has no role on the note -> 404 (not a quota issue); the three numbers are confirmed through the group manager's preHandler shape.
    expect((await upload(app, n.id, site.id, 8)).statusCode).toBe(404);
    expect((await upload(app, n.id, gAdmin.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
  });

  it("site admin as an editor share target on someone's personal note: rejected sees three numbers (both in-transaction 409 and pre-check 409); an ordinary editor in the same situation sees incomingBytes only", async () => {
    const { app, db } = await buildTestApp();
    const [a, site, plain] = await Promise.all([seedUser(db), seedUser(db, { isAdmin: true }), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    const n = await seedNote(db, { ownerId: a.id });
    await seedShare(db, n.id, site.id, "editor");
    await seedShare(db, n.id, plain.id, "editor");
    expect((await upload(app, n.id, site.id, 900)).statusCode).toBe(201);
    expect((await upload(app, n.id, site.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect((await upload(app, n.id, plain.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200 }));
    expect((await upload(app, n.id, site.id, 100)).statusCode).toBe(201);
    expect((await upload(app, n.id, site.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
    expect((await upload(app, n.id, plain.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null }));
  });
});

describe("upload: unlimited and already over quota", () => {
  it("quota NULL -> many uploads all 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, null);
    const n = await seedNote(db, { ownerId: u.id });
    for (let i = 0; i < 3; i++) expect((await upload(app, n.id, u.id, 5 * 1024 * 1024)).statusCode).toBe(201);
  });

  it("direct insert makes used > quota -> upload 409; a note with big attachments moved to the trash still 409 (trash still counts); after permanent delete uploading works again", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const big = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, big.id, u.id, 5000);
    const n = await seedNote(db, { ownerId: u.id });
    expect((await upload(app, n.id, u.id, 8)).statusCode).toBe(409);
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${big.id}`, cookies: await cookieOf(u.id) });
    expect(del.statusCode).toBe(204);
    expect((await upload(app, n.id, u.id, 8)).statusCode).toBe(409);
    await db.transaction(tx => purgeTrashedNotesInTx(tx, { ids: [big.id], by: u.id }));
    expect((await upload(app, n.id, u.id, 8)).statusCode).toBe(201);
  });
});

describe("upload: busy mapping and real timeout", () => {
  for (const [label, code] of [["40P01", "40P01"], ["55P03", "55P03"], ["40001", "40001"]] as const) {
    it(`test hook storage-space-locked throws ${label} -> 409 server_busy, written file unlinked, no new row`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => {
          if (point === "storage-space-locked") throw Object.assign(new Error(label), { code });
        },
      });
      const u = await seedUser(db);
      await giveUserQuota(db, u.id, 1000);
      const n = await seedNote(db, { ownerId: u.id });
      const before = await filesIn(uploadsDir);
      const r = await upload(app, n.id, u.id, 100);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: { code: "server_busy", message: "The server is busy. Try again in a moment." } });
      expect(await filesIn(uploadsDir)).toEqual(before);
      expect(await rowsOf(db, n.id)).toEqual([]);
    });
  }

  it("any other throw in the transaction (non-pg error) -> 500, the file is unlinked just the same", async () => {
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => { if (point === "storage-space-locked") throw new Error("boom"); },
    });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    const before = await filesIn(uploadsDir);
    expect((await upload(app, n.id, u.id, 100)).statusCode).toBe(500);
    expect(await filesIn(uploadsDir)).toEqual(before);
  });

  it("storageLockTimeoutMs=200; upload A stopped at the hook, upload B to the same space really gets 55P03 -> 409 server_busy (< 20 s: the injected value took effect, not this file's default 60 s), B's file unlinked; A is 201 afterwards", async () => {
    const holder: { app?: FastifyInstance; noteId?: string; userId?: string; b?: LightMyRequestResponse; bMs?: number } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.b) return;
        const t0 = Date.now();
        holder.b = await upload(holder.app!, holder.noteId!, holder.userId!, 50);
        holder.bMs = Date.now() - t0;
      },
    });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    Object.assign(holder, { app, noteId: n.id, userId: u.id });
    const before = await filesIn(uploadsDir);
    const a = await upload(app, n.id, u.id, 100);
    expect(holder.b!.statusCode).toBe(409);
    expect(holder.b!.json().error.code).toBe("server_busy");
    // The 20 s bound sits between 200 ms and this file's default 60 s: if the injected value did not reach `assertSpaceRoomInTx` all the way (falling back to the default), B would wait about 60 s before timing out -> red.
    expect(holder.bMs!).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    expect(a.statusCode).toBe(201);
    const after = await filesIn(uploadsDir);
    expect(after.length).toBe(before.length + 1);
    expect(await rowsOf(db, n.id)).toEqual([{ size: 100 }]);
  });
});

describe("upload: existing contracts unchanged", () => {
  it("note missing -> 404 not_found (preHandler); viewer -> 403; the 413 limit still comes before the quota transaction", async () => {
    const { app, db } = await buildTestApp();
    const [o, v] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, o.id, 10);
    const n = await seedNote(db, { ownerId: o.id });
    await seedShare(db, n.id, v.id, "viewer");
    expect((await upload(app, "00000000-0000-4000-8000-000000000000", o.id, 8)).statusCode).toBe(404);
    expect((await upload(app, n.id, v.id, 8)).statusCode).toBe(403);
    // Room just under the file size but above the declared length minus the framing allowance: the early room check passes, so only the size limit (413) coming first keeps the in-transaction quota check (409) from answering.
    await giveUserQuota(db, o.id, MAX_UPLOAD_BYTES - 1);
    const tooBig = await upload(app, n.id, o.id, MAX_UPLOAD_BYTES + 1);
    expect(tooBig.statusCode).toBe(413);
  });
});

describe("upload: early room refusal before the body", () => {
  const FRAMING = 65_536;
  const injectDeclared = async (app: FastifyInstance, noteId: string, userId: string, size: number, declared: number): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/uploads`,
      payload: multipartFile(pngOf(size)),
      headers: { "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}`, "content-length": String(declared) },
      cookies: await cookieOf(userId),
    });

  it("declared length minus the framing allowance over the room -> 409 (incomingBytes null, owner sees three numbers), connection closed", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    const res = await injectDeclared(app, n.id, u.id, 16, 1000 + FRAMING + 1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 0, quotaBytes: 1000 }));
    expect(res.headers.connection).toBe("close");
    expect(await filesIn(uploadsDir)).toEqual([]);
  });

  it("declared length exactly room + allowance proceeds; one byte more is refused", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    expect((await injectDeclared(app, n.id, u.id, 16, 1000 + FRAMING + 1)).statusCode).toBe(409);
    expect((await injectDeclared(app, n.id, u.id, 16, 1000 + FRAMING)).statusCode).toBe(201);
    // 16 bytes are used now, so the room left is 984.
    expect((await injectDeclared(app, n.id, u.id, 16, 984 + FRAMING + 1)).statusCode).toBe(409);
    expect((await injectDeclared(app, n.id, u.id, 16, 984 + FRAMING)).statusCode).toBe(201);
  });

  it("a space without a storage limit skips the check", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, null);
    const n = await seedNote(db, { ownerId: u.id });
    expect((await injectDeclared(app, n.id, u.id, 16, 50_000_000_000)).statusCode).toBe(201);
  });

  it("a chunked request (no Content-Length) skips the declared-length check and meets the in-transaction check instead (incomingBytes is a number)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: u.id, tv: 0 })}`;
    const body = multipartFile(pngOf(5000));
    const res = await new Promise<{ status: number; body: string; hadLength: boolean }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/notes/${n.id}/uploads`, method: "POST", agent: false, headers: {
        "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}`, "transfer-encoding": "chunked", cookie,
      } }, r => {
        const chunks: Buffer[] = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8"), hadLength: req.hasHeader("content-length") }));
      });
      req.on("error", reject);
      req.write(body.subarray(0, 3000));
      req.end(body.subarray(3000));
    });
    expect(res.hadLength).toBe(false);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual(quotaBody({ incomingBytes: 5000, usedBytes: 0, quotaBytes: 1000 }));
    await app.close();
  });

  it("a full space is refused even for a tiny declared length; a viewer is refused 403 before the room check, both closing the connection", async () => {
    const { app, db } = await buildTestApp();
    const [o, v] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, o.id, 0);
    const n = await seedNote(db, { ownerId: o.id });
    await seedShare(db, n.id, v.id, "viewer");
    const full = await upload(app, n.id, o.id, 8);
    expect(full.statusCode).toBe(409);
    expect(full.headers.connection).toBe("close");
    const viewer = await upload(app, n.id, v.id, 8);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.headers.connection).toBe("close");
    const missing = await upload(app, "00000000-0000-4000-8000-000000000000", o.id, 8);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.connection).toBe("close");
  });

  it("a room refusal does not consume the transfer token: the same token then uploads", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    await giveUserQuota(db, o.userId, 1000);
    const { token, id } = await issueDirect(db, o.patId, o.noteId, "upload");
    const small = fileBody(pngOf(16));
    const refused = await transferUpload(app, o.noteId, small, { token, headers: { "content-length": String(1000 + FRAMING + 1) } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 0, quotaBytes: 1000 }));
    expect((await tokenRow(db, id))?.consumedAt).toBeNull();
    expect((await transferUpload(app, o.noteId, small, { token })).statusCode).toBe(201);
    expect((await tokenRow(db, id))?.consumedAt).not.toBeNull();
  });
});
