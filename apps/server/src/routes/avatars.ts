import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_AVATAR_DISPLAY_BYTES, type AvatarCropUpload } from "@knotebook/shared";
import type { UserGate } from "../auth/session.js";
import { fetchOidcAvatar, PRODUCTION_AVATAR_FETCH_POLICY, type AvatarFetchPolicy } from "../avatars/oidc-fetch.js";
import {
  deleteAvatarInTx,
  insertAvatarInTx,
  refreshOidcAvatarInTx,
  selectAvatarInTx,
  updateAvatarDisplayInTx,
  type AvatarTestHooks,
  type DeleteAvatarInput,
  type InsertAvatarInput,
  type ReplaceOidcAvatarInput,
  type SelectAvatarInput,
  type UpdateAvatarDisplayInput,
} from "../avatars/tx/avatars.js";
import { listAvatars, toCandidateDto } from "../avatars/list.js";
import type { Db } from "../db/index.js";
import { userAvatars, userIdentities } from "../db/schema.js";
import { isForeignKeyViolation, isRetryableTxError, isUniqueViolation } from "../db/pg-errors.js";
import { drainWithCap } from "../http/drain.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import type { SiteLimits } from "../site-limits/store.js";
import { UUID_RE } from "../notes/service.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { isSpaceFull, precheckDetail, quotaErrorDetail, readSpaceUsage } from "../storage/usage.js";
import { detectRasterImageMimeType } from "../uploads/magic-bytes.js";
import { deleteUploadFiles, uploadFilePath } from "../uploads/service.js";

export interface AvatarsRouteDeps {
  db: Db;
  gate: UserGate;
  limiters: { upload: FixedWindowLimiter; avatarRefresh: FixedWindowLimiter };
  uploadsDir: string;
  siteLimits: SiteLimits;
  storageLockTimeoutMs: number;
  avatarFetchPolicy?: AvatarFetchPolicy;
  avatarTestHooks?: AvatarTestHooks;
}

/** All five fields go into `integer` columns; over int4 the DB raises 22003, so reject as 400. */
const INT4_MAX = 2147483647;
const VERSION_RE = /^[1-9]\d{0,9}$/;

const AVATAR_NOT_FOUND_MESSAGE = "No avatar with that id.";
const IDENTITY_NOT_FOUND_MESSAGE = "No linked sign-in with a picture has that id.";
const UPLOAD_TOO_LARGE_MESSAGE = "The file is over the size limit.";
const UNSUPPORTED_IMAGE_MESSAGE = "Unsupported image format. Upload a PNG, JPEG or WebP image.";
/** No URL or underlying message (a URL may contain a token). */
const AVATAR_FETCH_FAILED_MESSAGE = "Couldn't get the picture from the sign-in service.";

const cropFieldSchema = z
  .object({
    x: z.number().int().min(0).max(INT4_MAX),
    y: z.number().int().min(0).max(INT4_MAX),
    size: z.number().int().min(1).max(INT4_MAX),
    width: z.number().int().min(1).max(INT4_MAX),
    height: z.number().int().min(1).max(INT4_MAX),
  })
  .strict()
  .refine(c => c.x + c.size <= c.width && c.y + c.size <= c.height);

type CropField = z.infer<typeof cropFieldSchema>;

// Two-way check: a one-way `satisfies z.ZodType<…>` misses fields absent from the shared type.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _cropShapeMatchesShared: Equal<CropField, AvatarCropUpload> = true;
void _cropShapeMatchesShared;

const selectBodySchema = z.object({ candidateId: z.string().regex(UUID_RE).nullable() }).strict();

function parseVersionField(raw: string | undefined): number | null {
  if (raw === undefined || !VERSION_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= INT4_MAX ? n : null;
}

function parseCropField(raw: string): CropField | null {
  if (raw.includes("\u0000")) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = cropFieldSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function readParts(
  request: FastifyRequest,
  fileFields: readonly string[],
  fileSize: number,
): Promise<{ files: Map<string, { data: Buffer; truncated: boolean }>; fields: Map<string, string> }> {
  const files = new Map<string, { data: Buffer; truncated: boolean }>();
  const fields = new Map<string, string>();
  // Run the loop to the end (no break) and resume extra file parts: that is what drains the body (see routes/uploads.ts).
  for await (const part of request.parts({ limits: { fileSize } })) {
    if (part.type === "file") {
      if (fileFields.includes(part.fieldname) && !files.has(part.fieldname)) {
        const data = await part.toBuffer();
        files.set(part.fieldname, { data, truncated: part.file.truncated });
      } else {
        part.file.resume();
      }
    } else if (!fields.has(part.fieldname) && typeof part.value === "string") {
      fields.set(part.fieldname, part.value);
    }
  }
  return { files, fields };
}

interface CheckedUpload {
  buffers: Map<string, Buffer>;
  mimes: Map<string, string>;
  crop: CropField;
  fields: Map<string, string>;
}

async function readAndCheck(request: FastifyRequest, reply: FastifyReply, fileFields: readonly ("original" | "display")[], fileSize: number): Promise<CheckedUpload | null> {
  let parsed;
  try {
    parsed = await readParts(request, fileFields, fileSize);
  } catch (err) {
    drainWithCap(request);
    request.log.warn({ err }, "multipart 解析失敗");
    sendError(reply, 400, "invalid_body", "The upload isn't valid multipart/form-data.");
    return null;
  }
  const { files, fields } = parsed;
  const display = files.get("display");
  if ([...files.values()].some(f => f.truncated) || (display !== undefined && display.data.length > MAX_AVATAR_DISPLAY_BYTES)) {
    drainWithCap(request);
    sendError(reply, 413, "file_too_large", UPLOAD_TOO_LARGE_MESSAGE);
    return null;
  }
  const cropRaw = fields.get("crop");
  if (fileFields.some(f => !files.has(f)) || cropRaw === undefined) {
    drainWithCap(request);
    sendError(reply, 400, "invalid_body", `The upload needs the ${fileFields.join(", ")} and crop parts.`);
    return null;
  }
  const crop = parseCropField(cropRaw);
  if (crop === null) {
    drainWithCap(request);
    sendError(reply, 400, "invalid_body", "The crop field isn't valid.");
    return null;
  }
  // Only the file header is trusted, not Content-Type or extension; GIF/SVG are not accepted.
  const buffers = new Map<string, Buffer>();
  const mimes = new Map<string, string>();
  for (const name of fileFields) {
    const data = files.get(name)!.data;
    const mime = detectRasterImageMimeType(data);
    if (mime === null || mime === "image/gif") {
      drainWithCap(request);
      sendError(reply, 415, "unsupported_media_type", UNSUPPORTED_IMAGE_MESSAGE);
      return null;
    }
    buffers.set(name, data);
    mimes.set(name, mime);
  }
  return { buffers, mimes, crop, fields };
}

// Cookie-only (no Bearer or transfer token). Originals live in the uploads directory, not the `uploads` table (unaffected by note deletion/trash and not reachable through
// /api/uploads/:id); display images are in the DB. Multipart routes are exempt from the JSON CSRF check (MULTIPART_EXEMPT_ROUTES) in favour of an essence + Origin check.
// The space-full pre-check runs before reading the body; re-cropping skips it because shrinking must always succeed.
export function avatarsRoutes(deps: AvatarsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    async function authenticateAndThrottle(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
      await app.authenticate(request, reply);
      if (reply.sent) {
        drainWithCap(request);
        return false;
      }
      // Deliberately shares the upload limiter with note attachments.
      if (!deps.limiters.upload.consume(request.user!.id)) {
        drainWithCap(request);
        sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        return false;
      }
      return true;
    }

    async function authAndPrecheck(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (!(await authenticateAndThrottle(request, reply))) return;
      const user = request.user!;
      const space = { kind: "user", id: user.id } as const;
      const usage = await readSpaceUsage(deps.db, space);
      if (isSpaceFull(usage)) {
        drainWithCap(request);
        sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, user, space, usage));
      }
    }

    async function authForRecrop(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await authenticateAndThrottle(request, reply);
    }

    async function replyTxError(request: FastifyRequest, reply: FastifyReply, err: unknown): Promise<boolean> {
      // Subclass first (StorageQuotaExceeded extends TxAbort), else the numbers are lost.
      if (err instanceof StorageQuotaExceeded) {
        sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
        return true;
      }
      if (err instanceof TxAbort) {
        sendError(reply, err.status, err.errCode, err.message);
        return true;
      }
      if (isRetryableTxError(err) || isUniqueViolation(err) || isForeignKeyViolation(err)) {
        sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        return true;
      }
      return false;
    }

    const idOf = (request: FastifyRequest): string | null => {
      const raw = (request.params as { id: string }).id;
      return UUID_RE.test(raw) ? raw.toLowerCase() : null;
    };
    const sendAvatarNotFound = (reply: FastifyReply) => sendError(reply, 404, "not_found", AVATAR_NOT_FOUND_MESSAGE);

    app.get("/api/auth/avatars", { preHandler: app.authenticate }, async request => listAvatars(deps.db, request.user!.id));

    app.post("/api/auth/avatars", { preHandler: authAndPrecheck }, async (request, reply) => {
      const me = request.user!.id;
      const checked = await readAndCheck(request, reply, ["original", "display"], deps.siteLimits.get("uploadMaxBytes"));
      if (checked === null) return reply;
      const original = checked.buffers.get("original")!;
      const display = checked.buffers.get("display")!;
      const cropField = checked.crop;

      const originalFile = randomUUID();
      const finalPath = uploadFilePath(deps.uploadsDir, originalFile);
      const tempPath = `${finalPath}.tmp`;
      try {
        await writeFile(tempPath, original);
        await rename(tempPath, finalPath);
      } catch (err) {
        await unlink(tempPath).catch(() => {});
        await unlink(finalPath).catch(() => {});
        throw err;
      }

      const input: InsertAvatarInput = {
        userId: me,
        originalFile,
        originalSha256: createHash("sha256").update(original).digest(),
        originalMime: checked.mimes.get("original")!,
        originalSize: original.length,
        originalWidth: cropField.width,
        originalHeight: cropField.height,
        crop: { x: cropField.x, y: cropField.y, size: cropField.size },
        displayData: display,
        displayMime: checked.mimes.get("display")!,
        lockTimeoutMs: deps.storageLockTimeoutMs,
      };
      let row;
      try {
        row = await deps.db.transaction(tx => insertAvatarInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        // No DB row, no file; a failed cleanup must not mask the original error.
        await unlink(finalPath).catch(() => {});
        if (await replyTxError(request, reply, err)) return reply;
        throw redactDbError(request.log, err, "上傳頭貼");
      }

      deps.gate.invalidate(me);
      return reply.code(201).send(toCandidateDto({ ...row, pending: false }, null));
    });

    app.put("/api/auth/avatars/:id/display", { preHandler: authForRecrop }, async (request, reply) => {
      const me = request.user!.id;
      const avatarId = idOf(request);
      if (avatarId === null) {
        drainWithCap(request);
        return sendAvatarNotFound(reply);
      }
      const checked = await readAndCheck(request, reply, ["display"], MAX_AVATAR_DISPLAY_BYTES + 1);
      if (checked === null) return reply;
      const version = parseVersionField(checked.fields.get("version"));
      if (version === null) return sendError(reply, 400, "invalid_body", "The version field isn't valid.");

      const input: UpdateAvatarDisplayInput = {
        userId: me,
        avatarId,
        version,
        crop: { x: checked.crop.x, y: checked.crop.y, size: checked.crop.size },
        originalWidth: checked.crop.width,
        originalHeight: checked.crop.height,
        displayData: checked.buffers.get("display")!,
        displayMime: checked.mimes.get("display")!,
        lockTimeoutMs: deps.storageLockTimeoutMs,
      };
      try {
        await deps.db.transaction(tx => updateAvatarDisplayInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        if (await replyTxError(request, reply, err)) return reply;
        throw redactDbError(request.log, err, "重新裁切頭貼");
      }

      deps.gate.invalidate(me);
      const list = await listAvatars(deps.db, me);
      const candidate = list.candidates.find(c => c.id === avatarId);
      return candidate === undefined ? sendAvatarNotFound(reply) : candidate;
    });

    app.put("/api/auth/avatar", { preHandler: app.authenticate }, async (request, reply) => {
      const me = request.user!.id;
      const parsed = selectBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const input: SelectAvatarInput = { userId: me, candidateId: parsed.data.candidateId === null ? null : parsed.data.candidateId.toLowerCase() };
      try {
        await deps.db.transaction(tx => selectAvatarInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        if (await replyTxError(request, reply, err)) return reply;
        throw redactDbError(request.log, err, "選用頭貼");
      }
      deps.gate.invalidate(me);
      const result = await deps.gate.checkUser(me);
      if (result.status !== "ok") return sendError(reply, 401, "unauthorized", "Not signed in.");
      return result.user;
    });

    app.delete("/api/auth/avatars/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const me = request.user!.id;
      const avatarId = idOf(request);
      if (avatarId === null) return sendAvatarNotFound(reply);
      const input: DeleteAvatarInput = { userId: me, avatarId };
      let removed;
      try {
        removed = await deps.db.transaction(tx => deleteAvatarInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        if (await replyTxError(request, reply, err)) return reply;
        throw redactDbError(request.log, err, "刪除頭貼");
      }
      deps.gate.invalidate(me);
      // A file that can't be deleted is only an orphan: warn, don't fail the request.
      await deleteUploadFiles(deps.uploadsDir, [removed.originalFile], { error: (obj, msg) => request.log.warn(obj, msg) });
      return reply.code(204).send();
    });

    app.post("/api/auth/avatars/oidc/:identityId/refresh", { preHandler: app.authenticate }, async (request, reply) => {
      const me = request.user!.id;
      const raw = (request.params as { identityId: string }).identityId;
      if (!UUID_RE.test(raw)) return sendError(reply, 404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);
      const identityId = raw.toLowerCase();
      const [identity] = await deps.db
        .select({ issuer: userIdentities.issuer, lastPictureUrl: userIdentities.lastPictureUrl })
        .from(userIdentities)
        .where(and(eq(userIdentities.id, identityId), eq(userIdentities.userId, me)));
      if (identity === undefined || identity.lastPictureUrl === null) return sendError(reply, 404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);
      // After the identity check, so 404s cost no quota. The limiter is 10 per hour per user; the download times out after 10 s (→ 422). Clearing picture_dismissed_url,
      // creating/replacing and selecting the candidate and setting avatar_auto = false all happen in refreshOidcAvatarInTx's single transaction.
      if (!deps.limiters.avatarRefresh.consume(me)) return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      const space = { kind: "user", id: me } as const;
      const usage = await readSpaceUsage(deps.db, space);
      if (isSpaceFull(usage)) return sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, request.user!, space, usage));

      const picture = identity.lastPictureUrl;
      const fetched = await fetchOidcAvatar(picture, { issuer: identity.issuer, policy: deps.avatarFetchPolicy ?? PRODUCTION_AVATAR_FETCH_POLICY });
      if (!fetched.ok) {
        // Fixed reason only: URLs may carry a token.
        request.log.info({ userId: me, identityId, reason: fetched.reason }, "手動取得頭貼失敗");
        return sendError(reply, 422, "avatar_fetch_failed", AVATAR_FETCH_FAILED_MESSAGE);
      }

      const originalFile = randomUUID();
      const finalPath = uploadFilePath(deps.uploadsDir, originalFile);
      const tempPath = `${finalPath}.tmp`;
      const removeNewFile = async (): Promise<void> => {
        await unlink(tempPath).catch(() => {});
        await unlink(finalPath).catch(() => {});
      };
      try {
        await writeFile(tempPath, fetched.bytes);
        await rename(tempPath, finalPath);
      } catch (err) {
        await removeNewFile();
        throw err;
      }

      const input: ReplaceOidcAvatarInput = {
        userId: me,
        identityId,
        oidcPictureUrl: picture,
        originalFile,
        originalSha256: createHash("sha256").update(fetched.bytes).digest(),
        originalMime: fetched.mime,
        originalSize: fetched.bytes.length,
        lockTimeoutMs: deps.storageLockTimeoutMs,
      };
      let outcome;
      try {
        outcome = await deps.db.transaction(tx => refreshOidcAvatarInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        await removeNewFile();
        if (await replyTxError(request, reply, err)) return reply;
        throw redactDbError(request.log, err, "重新取得 IdP 頭貼");
      }

      if (outcome.outcome === "same_bytes") await removeNewFile();
      else if (outcome.outcome === "replaced") await deleteUploadFiles(deps.uploadsDir, [outcome.oldFile], { error: (obj, msg) => request.log.warn(obj, msg) });
      deps.gate.invalidate(me);
      return listAvatars(deps.db, me);
    });

    app.get("/api/auth/avatars/:id/original", { preHandler: app.authenticate }, async (request, reply) => {
      const avatarId = idOf(request);
      if (avatarId === null) return sendAvatarNotFound(reply);
      const [row] = await deps.db
        .select({ originalFile: userAvatars.originalFile, originalMime: userAvatars.originalMime })
        .from(userAvatars)
        .where(and(eq(userAvatars.id, avatarId), eq(userAvatars.userId, request.user!.id)));
      if (row === undefined) return sendAvatarNotFound(reply);
      const filePath = uploadFilePath(deps.uploadsDir, row.originalFile);
      try {
        await stat(filePath);
      } catch {
        // Row without file is not user-fixable: log for ops, same 404.
        request.log.warn({ avatarId }, "頭貼候選有紀錄但磁碟找不到原圖檔");
        return sendAvatarNotFound(reply);
      }
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("cache-control", "private, no-cache");
      reply.type(row.originalMime);
      return reply.send(createReadStream(filePath));
    });

    // Any signed-in user who has the id may read the display image; ownership is checked only for the original. Ignores `is_current` (replaced candidates stay readable). A candidate without a display image exposes only its owner's original and is never immutable.
    app.get("/api/avatars/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const avatarId = idOf(request);
      if (avatarId === null) return sendAvatarNotFound(reply);
      const [row] = await deps.db
        .select({
          userId: userAvatars.userId,
          displayData: userAvatars.displayData,
          displayMime: userAvatars.displayMime,
          originalFile: userAvatars.originalFile,
          originalMime: userAvatars.originalMime,
          version: userAvatars.version,
        })
        .from(userAvatars)
        .where(eq(userAvatars.id, avatarId));
      if (row === undefined) return sendAvatarNotFound(reply);
      if (row.displayData !== null && row.displayMime !== null) {
        reply.header("x-content-type-options", "nosniff");
        reply.header("content-security-policy", "default-src 'none'; sandbox");
        const v = (request.query as { v?: unknown }).v;
        reply.header("cache-control", typeof v === "string" && v === String(row.version) ? "private, max-age=31536000, immutable" : "private, no-cache");
        reply.type(row.displayMime);
        return reply.send(row.displayData);
      }
      if (row.userId !== request.user!.id) return sendAvatarNotFound(reply);
      const filePath = uploadFilePath(deps.uploadsDir, row.originalFile);
      try {
        await stat(filePath);
      } catch {
        request.log.warn({ avatarId }, "頭貼候選有紀錄但磁碟找不到原圖檔");
        return sendAvatarNotFound(reply);
      }
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("cache-control", "private, no-cache");
      reply.type(row.originalMime);
      return reply.send(createReadStream(filePath));
    });
  };
}
