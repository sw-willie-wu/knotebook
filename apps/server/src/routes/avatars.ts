import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_AVATAR_DISPLAY_BYTES } from "@knotebook/shared";
import type { UserGate } from "../auth/session.js";
import {
  deleteAvatarInTx,
  insertAvatarInTx,
  selectAvatarInTx,
  updateAvatarDisplayInTx,
  type AvatarTestHooks,
  type DeleteAvatarInput,
  type InsertAvatarInput,
  type SelectAvatarInput,
  type UpdateAvatarDisplayInput,
} from "../avatars/tx/avatars.js";
import { listAvatars, toCandidateDto } from "../avatars/list.js";
import type { Db } from "../db/index.js";
import { userAvatars } from "../db/schema.js";
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
import { detectImageMimeType } from "../uploads/magic-bytes.js";
import { deleteUploadFiles, uploadFilePath } from "../uploads/service.js";

export interface AvatarsRouteDeps {
  db: Db;
  /** 寫入頭貼的路徑在 commit 後 `invalidate`，`UserDto.avatar` 才不會讀到 60 秒前的快取。 */
  gate: UserGate;
  /** `upload`：與筆記附件共用同一個節流桶（key＝userId）。 */
  limiters: { upload: FixedWindowLimiter };
  uploadsDir: string;
  siteLimits: SiteLimits;
  /** 空間鎖等待上限（ms），透傳自 `AppDeps.storageLockTimeoutMs`。 */
  storageLockTimeoutMs: number;
  /** 交錯點測試注入縫；生產不注入。 */
  avatarTestHooks?: AvatarTestHooks;
}

/** 五個欄位都存進 `integer` 欄，超過就是 DB 的 22003；在驗證層擋成 400。 */
const INT4_MAX = 2147483647;
const VERSION_RE = /^[1-9]\d{0,9}$/;

const AVATAR_NOT_FOUND_MESSAGE = "No avatar with that id.";
const UPLOAD_TOO_LARGE_MESSAGE = "The file is over the size limit.";
const UNSUPPORTED_IMAGE_MESSAGE = "Unsupported image format. Upload a PNG, JPEG or WebP image.";

/** `crop` 欄：裁切方框（原圖像素座標）＋原圖寬高。整數、方框落在原圖內。 */
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

const selectBodySchema = z.object({ candidateId: z.string().regex(UUID_RE).nullable() }).strict();

/** `version` 欄：正規十進位的正整數，且不超過 int4。回 null＝格式不合。 */
function parseVersionField(raw: string | undefined): number | null {
  if (raw === undefined || !VERSION_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= INT4_MAX ? n : null;
}

/** 回 null＝格式不合（非 JSON、含 NUL、欄位型別或範圍不對）。 */
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

/** 讀 multipart：指定名稱的 file part 收成 buffer（每個名稱只收第一個），文字欄只收第一個字串值。跑完整個迴圈，body 才算讀完。 */
async function readParts(
  request: FastifyRequest,
  fileFields: readonly string[],
  fileSize: number,
): Promise<{ files: Map<string, { data: Buffer; truncated: boolean }>; fields: Map<string, string> }> {
  const files = new Map<string, { data: Buffer; truncated: boolean }>();
  const fields = new Map<string, string>();
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

/**
 * 讀並驗 multipart：413（截斷或顯示圖過大）→ 400（缺 part、crop 壞）→ 415（不是 PNG／JPEG／WebP）。
 * 回 null＝已送出錯誤回應（每條早退都先 drain）。
 */
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
  // 只信檔頭，不採信請求端聲稱的 Content-Type／副檔名；GIF 與 SVG 不收。
  const buffers = new Map<string, Buffer>();
  const mimes = new Map<string, string>();
  for (const name of fileFields) {
    const data = files.get(name)!.data;
    const mime = detectImageMimeType(data);
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

/**
 * 頭貼候選的清單、上傳與管理。全部 cookie-only（`app.authenticate`，不收 Bearer／transfer token）；本人操作本人。
 * 原圖存 uploads 目錄、不進 `uploads` 表（不受筆記刪除與垃圾桶影響，也讀不到於 `/api/uploads/:id`）；顯示圖存 DB。
 *
 * `POST /api/auth/avatars`（`original`、`display`、`crop`）與 `PUT /api/auth/avatars/:id/display`（`display`、`crop`、`version`）是 multipart，
 * `MULTIPART_EXEMPT_ROUTES` 豁免 JSON CSRF 檢查，改由 essence 必須 multipart 加 Origin 驗證把關。
 * 上傳順序：認證 → 節流 → 空間已滿預檢（讀 body 之前，已滿不白讀）→ 解析 → 驗證 → 寫檔 → 交易。每個早退都先 drain。
 * 重新裁切不做已滿預檢：變小一定要能成功。
 * 別人的候選、不存在的 id、不是 UUID 的 id 一律同一個 404。
 */
export function avatarsRoutes(deps: AvatarsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    async function authenticateAndThrottle(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
      await app.authenticate(request, reply);
      if (reply.sent) {
        drainWithCap(request);
        return false;
      }
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

    /** 交易拋出的共同分流；回 true＝已送出回應。其他錯誤原樣丟出（呼叫端用 `redactDbError`）。 */
    async function replyTxError(request: FastifyRequest, reply: FastifyReply, err: unknown): Promise<boolean> {
      // 先判子類（StorageQuotaExceeded extends TxAbort）：反序會失去數字。
      if (err instanceof StorageQuotaExceeded) {
        sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
        return true;
      }
      if (err instanceof TxAbort) {
        sendError(reply, err.status, err.errCode, err.message);
        return true;
      }
      // 空間鎖逾時（55P03）／死結（40P01）／序列化失敗（40001），以及保底的唯一鍵與外鍵衝突 → 409 server_busy。
      if (isRetryableTxError(err) || isUniqueViolation(err) || isForeignKeyViolation(err)) {
        sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        return true;
      }
      return false;
    }

    /** `:id` 過 UUID 形後轉小寫；不過回 null。 */
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

      // 交易 callback 的引數只放純資料：雜湊與長度在交易之前算好。
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
        // DB 沒有列的檔不該留在磁碟；清檔失敗不吞原錯誤。
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
      // 剛 commit 的列在清單裡；清單讀取之間被刪掉的極小窗口回 404。
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
      // commit 後讓閘門的快取失效，再走和 `/api/auth/me` 同一條路徑重讀目前使用者。
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
      // 列已刪乾淨；檔刪不掉只是磁碟上多一個孤兒檔，記 warn、不讓請求失敗。
      await deleteUploadFiles(deps.uploadsDir, [removed.originalFile], { error: (obj, msg) => request.log.warn(obj, msg) });
      return reply.code(204).send();
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
        // 列在、檔不在：不是使用者能自己修的狀態，記一筆 log 供維運排查，對呼叫端仍是同一個 404。
        request.log.warn({ avatarId }, "頭貼候選有紀錄但磁碟找不到原圖檔");
        return sendAvatarNotFound(reply);
      }
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("cache-control", "private, no-cache");
      reply.type(row.originalMime);
      return reply.send(createReadStream(filePath));
    });

    // 顯示圖：任何登入者都讀得到（知道 id 才讀得到）；不看 `is_current`，換掉的候選仍可讀。
    // 還沒補產顯示圖的候選只有本人讀得到原圖，且永不標 immutable。
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
