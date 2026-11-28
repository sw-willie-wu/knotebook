import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { UserGate } from "../auth/session.js";
import { createTransferAuth } from "../auth/transfer-auth.js";
import { drainWithCap } from "../http/drain.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { isForeignKeyViolation, isRetryableTxError } from "../db/pg-errors.js";
import {
  BLOCK_ANCHOR_RE,
  TOP_SECTION_ID,
  UPLOAD_FRAMING_ALLOWANCE_BYTES,
  sanitizeUploadFileName,
  uploadKindOfMime,
  uploadLimitClass,
  type UploadCategory,
  type UploadResponseDto,
} from "@knotebook/shared";
import { transferTokens, uploads } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { resolveNoteAccess, resolveRole, UUID_RE } from "../notes/service.js";
import type { NotificationHub } from "../notifications/hub.js";
import { recordUploadFinished } from "../notifications/upload-finished.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { spaceOfNote, type StorageSpace } from "../storage/space.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { precheckDetail, quotaErrorDetail, readSpaceUsage, remainingRoom, type SpaceUsage } from "../storage/usage.js";
import { classifyUploadHead, HEAD_BYTES, verifyWholeFile, type HeadVerdict, type SvgRefusal } from "../uploads/detect.js";
import { deleteUploadFilesAnyName, sendUploadFile, uploadFilePath, uploadTempPath } from "../uploads/service.js";
import { insertUploadInTx } from "../uploads/tx/insert-upload.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the upload preHandler: bytes left in the space, `null` = no limit. */
    uploadRoom?: number | null;
    /** Set with a non-null `uploadRoom`: what a refusal for room reports. */
    uploadSpace?: { space: StorageSpace; usage: SpaceUsage };
  }
}

const MIB = 1_048_576;

export const UNSUPPORTED_UPLOAD_MESSAGE =
  "Unsupported file type. Upload an image (PNG, JPEG, GIF, WebP or SVG), audio, video, a PDF, an Office or OpenDocument file, or a text file.";

function svgRefusalMessage(refusal: SvgRefusal): string {
  if (refusal.svg === "missing_xmlns") return 'SVG files must declare xmlns="http://www.w3.org/2000/svg" on the root <svg> element.';
  if (refusal.svg === "undeclared_prefix") return undeclaredPrefixMessage(refusal.prefix);
  return "Unsupported image format. Upload a PNG, JPEG, GIF, WebP or SVG image.";
}

function uploadLimitBytes(siteLimits: SiteLimits, category: UploadCategory): number {
  return uploadLimitClass(category) === "media" ? siteLimits.get("uploadMediaMaxMib") * MIB : siteLimits.get("uploadMaxBytes");
}

function largestUploadLimit(siteLimits: SiteLimits): number {
  return Math.max(siteLimits.get("uploadMaxBytes"), siteLimits.get("uploadMediaMaxMib") * MIB);
}

/** Larger of the two live upload limits, doubled: the most a legitimate body can still be sending when the handler refuses it. */
export function uploadDrainCap(siteLimits: SiteLimits): number {
  return 2 * largestUploadLimit(siteLimits);
}

/** Declared body length, or null when absent (chunked) or malformed. */
function declaredLength(request: FastifyRequest): number | null {
  const raw = request.headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

class UploadRefusal extends Error {
  constructor(readonly reason: "empty" | "unsupported" | "too_large" | "no_room") {
    super(reason);
  }
}

interface ReceivedFile {
  verdict: HeadVerdict;
  size: number;
}

/**
 * Streams one file part into `tempPath`. Nothing is written before the head is classified; past `min(type limit, room)` the stream stops with an `UploadRefusal`,
 * which also destroys the part, so @fastify/multipart ends the parts() loop and stops reading the request.
 */
async function receiveFile(
  part: MultipartFile,
  tempPath: string,
  opts: { fileName: string | null; limitOf: (c: UploadCategory) => number; room: number | null; log: FastifyBaseLogger },
): Promise<ReceivedFile> {
  const state: { verdict: HeadVerdict | null; size: number; limit: number; cap: number } = { verdict: null, size: 0, limit: 0, cap: 0 };
  const head: Buffer[] = [];
  let headLength = 0;

  // Decided by which bound is the cap, not by `size`: one chunk can cross both.
  const overCap = (): UploadRefusal | null =>
    state.size <= state.cap ? null : new UploadRefusal(state.cap < state.limit ? "no_room" : "too_large");

  const decide = async (): Promise<Buffer> => {
    const buffered = Buffer.concat(head);
    head.length = 0;
    let found: HeadVerdict | null;
    try {
      found = await classifyUploadHead(buffered.subarray(0, HEAD_BYTES), opts.fileName);
    } catch (err) {
      // file-type can throw on crafted input; such a file is simply not a supported type.
      opts.log.warn({ err }, "upload type detection failed");
      found = null;
    }
    if (found === null) throw new UploadRefusal("unsupported");
    state.verdict = found;
    state.limit = opts.limitOf(found.category);
    state.cap = opts.room === null ? state.limit : Math.min(state.limit, opts.room);
    const refusal = overCap();
    if (refusal !== null) throw refusal;
    return buffered;
  };

  const gate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.size += chunk.length;
      if (state.verdict !== null) {
        const refusal = overCap();
        if (refusal !== null) callback(refusal);
        else callback(null, chunk);
        return;
      }
      head.push(chunk);
      headLength += chunk.length;
      if (headLength < HEAD_BYTES) {
        callback();
        return;
      }
      decide().then(buffered => callback(null, buffered), callback);
    },
    flush(callback) {
      if (state.verdict !== null) {
        callback();
        return;
      }
      if (headLength === 0) {
        callback(new UploadRefusal("empty"));
        return;
      }
      decide().then(buffered => callback(null, buffered), callback);
    },
  });
  // busboy truncates a file past the larger of the two limits and drops the rest; without this the parts() loop would go on reading the body to its end.
  part.file.once("limit", () => gate.destroy(new UploadRefusal("too_large")));

  const out = createWriteStream(tempPath, { flags: "wx" });
  // A destroyed write stream may still be opening its file: unlinking before `close` could leave an empty temp file behind.
  const closed = new Promise<void>(resolve => out.once("close", () => resolve()));
  try {
    await pipeline(part.file, gate, out);
  } finally {
    await closed;
  }
  if (state.verdict === null) throw new UploadRefusal("unsupported");
  return { verdict: state.verdict, size: state.size };
}

export interface UploadsRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
  gate: UserGate;
  limiters: { upload: FixedWindowLimiter; bearerMiss: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
  uploadsDir: string;
  groupTestHook?: GroupTestHook;
  storageLockTimeoutMs: number;
  notifications?: NotificationHub;
}

const finishedBodySchema = z.object({ blockId: z.string() }).strict();

const MAX_ECHOED_PREFIX_CHARS = 64;

/** The prefix comes from an untrusted file and is echoed to clients that may render it: bound its length and drop invisible direction/format characters. */
export function echoablePrefix(prefix: string | undefined): string {
  let out = "";
  let kept = 0;
  for (const ch of prefix ?? "") {
    if (/[\p{Cc}\p{Cf}]/u.test(ch)) continue;
    if (kept === MAX_ECHOED_PREFIX_CHARS) return `${out}…`;
    out += ch;
    kept++;
  }
  return out;
}

/** An empty echoable prefix (all invisible characters) would read as `the prefix ""`, so the message leaves it out. */
export function undeclaredPrefixMessage(prefix: string | undefined): string {
  const shown = echoablePrefix(prefix);
  return shown === ""
    ? "SVG files must declare every namespace prefix they use."
    : `SVG files must declare every namespace prefix they use: the prefix "${shown}" has no matching xmlns declaration.`;
}

/**
 * Multipart parsing and its CSRF exemption are done by the global onRequest in app.ts; @fastify/multipart must be registered on the top-level app (not an encapsulated plugin).
 * Transfer tokens (#200) are accepted besides sessions; ordinary PAT/OAuth Bearer tokens are not (docs/api-tokens.md). The POST preHandler order is a contract, all before
 * request.parts(): authentication → token's note = path note → current role → upload limiter → storage-room pre-check (so a refusal for space doesn't burn the token) → atomic
 * consumption. Refusals between authentication and token consumption, and the handler's refusals while the file streams in (415 after the head, 413 or 409 past the cap), close the
 * connection instead of reading the rest of a possibly huge body. Any failure after consumption burns the token, including the in-transaction 409 storage_quota_exceeded (same code
 * and shape as the pre-check) and 409 server_busy (space-lock timeout/deadlock). CSRF stays exempt: Bearer isn't an ambient credential.
 */
export function uploadsRoutes(deps: UploadsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const transferAuth = createTransferAuth({
      db: deps.db,
      gate: deps.gate,
      authenticate: app.authenticate,
      limiters: { bearerMiss: deps.limiters.bearerMiss },
    });
    const uploadAuth = transferAuth.require("upload");
    const downloadAuth = transferAuth.require("download");

    // An unread body would hang the socket (@fastify/multipart doesn't read it), so a refusal either drains (before authentication) or closes the connection.
    function refuse(reply: FastifyReply): FastifyReply {
      return reply.header("connection", "close");
    }

    async function authAndAuthorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await uploadAuth(request, reply);
      if (reply.sent) {
        drainWithCap(request);
        return;
      }

      const { id: noteId } = request.params as { id: string };
      const userId = request.user!.id;
      const transfer = request.transfer;

      // Before the role check: a token for note A used on note B always gets the same 403, so B's existence isn't leaked. DB ids are lowercase, UUID_RE accepts uppercase.
      if (transfer !== undefined && transfer.noteId !== noteId.toLowerCase()) {
        sendError(refuse(reply), 403, "forbidden", "This transfer token is for a different note.");
        return;
      }

      const access = await resolveNoteAccess(deps.db, userId, noteId);
      if (access.role === "none") {
        sendError(refuse(reply), 404, "not_found", "No note with that id.");
        return;
      }
      if (access.role === "viewer") {
        sendError(refuse(reply), 403, "forbidden", "You don't have edit access to this note.");
        return;
      }

      // Before consuming the token, so a 429 doesn't burn it.
      if (!deps.limiters.upload.consume(userId)) {
        sendError(refuse(reply), 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        return;
      }

      // Lock-free room check before reading the body and consuming the token; the authoritative fit check is in insertUploadInTx. The declared length includes multipart framing, hence the allowance.
      const space = spaceOfNote(access);
      const usage = await readSpaceUsage(deps.db, space);
      const room = remainingRoom(usage);
      request.uploadRoom = room;
      if (room !== null) request.uploadSpace = { space, usage: usage! };
      if (room !== null) {
        const declared = declaredLength(request);
        if (room <= 0 || (declared !== null && declared - UPLOAD_FRAMING_ALLOWANCE_BYTES > room)) {
          sendStorageQuotaExceeded(refuse(reply), await precheckDetail(deps.db, request.user!, space, usage!));
          return;
        }
      }

      // Two concurrent uses of one token: the row lock makes the later UPDATE see consumed_at set → 0 rows → 401, before any body is read. Expiry uses DB now() like the authentication query.
      if (transfer !== undefined) {
        const consumed = await deps.db
          .update(transferTokens)
          .set({ consumedAt: sql`now()` })
          .where(and(eq(transferTokens.id, transfer.id), isNull(transferTokens.consumedAt), sql`${transferTokens.expiresAt} > now()`))
          .returning({ id: transferTokens.id });
        if (consumed.length === 0) {
          transferAuth.rejectInvalid(request, reply);
          return;
        }
      }
    }

    app.post("/api/notes/:id/uploads", { preHandler: authAndAuthorize }, async (request, reply) => {
      const { id: noteId } = request.params as { id: string };
      const userId = request.user!.id;
      const drainCap = (): number => uploadDrainCap(deps.siteLimits);
      const limitOf = (c: UploadCategory): number => uploadLimitBytes(deps.siteLimits, c);
      const room = request.uploadRoom ?? null;

      const id = randomUUID();
      const finalPath = uploadFilePath(deps.uploadsDir, id);
      const tempPath = uploadTempPath(deps.uploadsDir, id);

      // Running the loop to the end is what drains the multipart body (file backpressure is released only by consuming; drainWithCap only helps before multipart parsing started).
      // limits.files is deliberately not set: the plugin would throw FilesLimitError (413) outside our error classification.
      let received: ReceivedFile | undefined;
      let fileName: string | null = null;
      let refusal: UploadRefusal | undefined;
      let sawFile = false;

      try {
        for await (const part of request.parts({ limits: { fileSize: largestUploadLimit(deps.siteLimits) } })) {
          if (part.type !== "file") continue;
          if (sawFile) {
            part.file.resume();
            continue;
          }
          sawFile = true;
          fileName = sanitizeUploadFileName(part.filename ?? "");
          try {
            received = await receiveFile(part, tempPath, { fileName, limitOf, room, log: request.log });
          } catch (err) {
            if (!(err instanceof UploadRefusal)) throw err;
            refusal = err;
            break;
          }
        }
      } catch (err) {
        await deleteUploadFilesAnyName(deps.uploadsDir, [id], request.log);
        if (typeof (err as NodeJS.ErrnoException).syscall === "string") {
          request.log.error({ err }, "writing an upload to disk failed");
          return sendError(refuse(reply), 500, "internal", "Internal server error.");
        }
        // busboy's cleanup only unpipes; once request.pipe(bb) ran, Node considers the request consumed and skips its automatic _dump(), so the rest of the body stays paused and app.close()
        // waits forever for the connection (pinned by "real socket: parts over the limit" in test/uploads.test.ts).
        drainWithCap(request, drainCap());
        // All other plugin errors (missing boundary, FST_PARTS_LIMIT, FST_FIELDS_LIMIT) map to 400 invalid_body; rethrowing would reach the global handler's clientErrorCode with a wrong code.
        request.log.warn({ err }, "multipart 解析失敗");
        return sendError(reply, 400, "invalid_body", "The upload isn't valid multipart/form-data.");
      }

      if (refusal !== undefined) {
        await deleteUploadFilesAnyName(deps.uploadsDir, [id], request.log);
        // The rest of the body is never read, so the connection can't be reused.
        refuse(reply);
        switch (refusal.reason) {
          case "empty":
            return sendError(reply, 400, "invalid_body", "The upload has no file.");
          case "unsupported":
            return sendError(reply, 415, "unsupported_media_type", UNSUPPORTED_UPLOAD_MESSAGE);
          case "too_large":
            return sendError(reply, 413, "file_too_large", "The file is over the size limit.");
          case "no_room":
            return sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, request.user!, request.uploadSpace!.space, request.uploadSpace!.usage));
        }
      }

      if (!sawFile || received === undefined) {
        // Defensive and idempotent: the loop above should already have drained the body.
        drainWithCap(request, drainCap());
        return sendError(reply, 400, "invalid_body", "The upload has no file.");
      }

      let mime: string;
      let refusalMessage = UNSUPPORTED_UPLOAD_MESSAGE;
      try {
        const whole = await verifyWholeFile(tempPath, received.verdict);
        if (whole === null) throw new UploadRefusal("unsupported");
        if ("svg" in whole) {
          refusalMessage = svgRefusalMessage(whole);
          throw new UploadRefusal("unsupported");
        }
        mime = whole.mime;
      } catch (err) {
        if (!(err instanceof UploadRefusal)) request.log.warn({ err }, "upload whole-file check failed");
        await deleteUploadFilesAnyName(deps.uploadsDir, [id], request.log);
        return sendError(reply, 415, "unsupported_media_type", refusalMessage);
      }

      const input = {
        id, noteId: noteId.toLowerCase(), uploaderId: userId, mime, size: received.size, fileName, tempPath, finalPath, lockTimeoutMs: deps.storageLockTimeoutMs,
      };
      try {
        await deps.groupTestHook?.("upload-received", { noteId: input.noteId });
        await deps.groupTestHook?.("upload-authorized", { noteId: input.noteId });
        await deps.db.transaction(tx => insertUploadInTx(tx, input, deps.groupTestHook));
      } catch (err) {
        // No DB row, no file under either name (the rename may have run before a failed commit).
        await deleteUploadFilesAnyName(deps.uploadsDir, [id], request.log);
        if (err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
        // Note deleted mid-request (KEY SHARE finds 0 rows), or the uploader's role was lost during the upload.
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // Defense in depth: the note KEY SHARE is already held, so the INSERT shouldn't hit the FK.
        if (isForeignKeyViolation(err)) return sendError(reply, 404, "not_found", "No note with that id.");
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        throw err;
      }

      const body: UploadResponseDto = { id, url: `/api/uploads/${id}`, mime, kind: uploadKindOfMime(mime) };
      return reply.code(201).send(body);
    });

    // Unlike other notes routes this is 403, not 404: the upload id is an unguessable randomUUID(), so confirming it exists leaks nothing, and 403 says "found, no access".
    app.get("/api/uploads/:id", { preHandler: downloadAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const transfer = request.transfer;

      if (!UUID_RE.test(id)) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }

      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
      if (!row) {
        return sendError(reply, 404, "not_found", "No file with that id.");
      }

      // A transfer token binds one note; same 403 as an invisible upload.
      if (transfer !== undefined && row.noteId !== transfer.noteId) {
        return sendError(reply, 403, "forbidden", "This transfer token is for a different file.");
      }

      const role = await resolveRole(deps.db, userId, row.noteId);
      if (role === "none") {
        return sendError(reply, 403, "forbidden", "You don't have access to this file.");
      }

      // Same key and instance as auth/bearer.ts.
      if (transfer !== undefined && !deps.limiters.tokenRead.consume(`token:${userId}`)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }

      return sendUploadFile(request, reply, row, deps.uploadsDir);
    });

    // Session only, like the bell it feeds. A repeat is a no-op: one notification per upload.
    app.post("/api/uploads/:id/finished", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = finishedBodySchema.safeParse(request.body ?? {});
      if (!body.success || !BLOCK_ANCHOR_RE.test(body.data.blockId) || body.data.blockId === TOP_SECTION_ID) {
        return sendError(reply, 400, "invalid_body", "Invalid request body.");
      }
      const userId = request.user!.id;
      const outcome = await recordUploadFinished(deps.db, { userId, uploadId: id, blockId: body.data.blockId });
      if (outcome === "not_found") return sendError(reply, 404, "not_found", "No file with that id.");
      if (outcome === "not_uploader") return sendError(reply, 403, "forbidden", "You didn't upload this file.");
      if (outcome === "no_access") return sendError(reply, 403, "forbidden", "You don't have access to this file.");
      if (outcome === "created") deps.notifications?.notify([userId]);
      return reply.code(204).send();
    });
  };
}
