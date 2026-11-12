import { createHash, randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_AVATAR_DISPLAY_BYTES } from "@knotebook/shared";
import type { UserGate } from "../auth/session.js";
import { insertAvatarInTx, type AvatarTestHooks, type InsertAvatarInput } from "../avatars/tx/avatars.js";
import { listAvatars, toCandidateDto } from "../avatars/list.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation, isRetryableTxError, isUniqueViolation } from "../db/pg-errors.js";
import { drainWithCap } from "../http/drain.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import type { SiteLimits } from "../site-limits/store.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { isSpaceFull, precheckDetail, quotaErrorDetail, readSpaceUsage } from "../storage/usage.js";
import { detectImageMimeType } from "../uploads/magic-bytes.js";
import { uploadFilePath } from "../uploads/service.js";

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

const UPLOAD_TOO_LARGE_MESSAGE = "The file is over the size limit.";
const UNSUPPORTED_IMAGE_MESSAGE = "Unsupported image format. Upload a PNG, JPEG or WebP image.";

/** `crop` 欄：裁切方框（原圖像素座標）＋原圖寬高。整數、方框落在原圖內。 */
const cropFieldSchema = z
  .object({
    x: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    y: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    width: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    height: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(c => c.x + c.size <= c.width && c.y + c.size <= c.height);

type CropField = z.infer<typeof cropFieldSchema>;

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

/**
 * 頭貼候選的清單與上傳。全部 cookie-only（`app.authenticate`，不收 Bearer／transfer token）；本人操作本人。
 * 原圖存 uploads 目錄、不進 `uploads` 表（不受筆記刪除與垃圾桶影響，也讀不到於 `/api/uploads/:id`）；顯示圖存 DB。
 *
 * `POST /api/auth/avatars` 是 multipart（`original`、`display`、`crop`），`MULTIPART_EXEMPT_ROUTES` 豁免 JSON CSRF 檢查，
 * 改由 essence 必須 multipart 加 Origin 驗證把關。順序：認證 → 節流 → 空間已滿預檢（讀 body 之前，已滿不白讀）→ 解析 →
 * 驗證 → 寫檔 → 交易。每個早退都先 drain。
 */
export function avatarsRoutes(deps: AvatarsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    async function authAndPrecheck(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await app.authenticate(request, reply);
      if (reply.sent) {
        drainWithCap(request);
        return;
      }
      const user = request.user!;
      if (!deps.limiters.upload.consume(user.id)) {
        drainWithCap(request);
        sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        return;
      }
      const space = { kind: "user", id: user.id } as const;
      const usage = await readSpaceUsage(deps.db, space);
      if (isSpaceFull(usage)) {
        drainWithCap(request);
        sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, user, space, usage));
      }
    }

    app.get("/api/auth/avatars", { preHandler: app.authenticate }, async request => listAvatars(deps.db, request.user!.id));

    app.post("/api/auth/avatars", { preHandler: authAndPrecheck }, async (request, reply) => {
      const me = request.user!.id;

      // 跑完整個迴圈（不提早 break）：整個 body 讀完才算 drain 過。多出來的 file part 一律丟棄。
      let original: Buffer | undefined;
      let originalTruncated = false;
      let display: Buffer | undefined;
      let displayTruncated = false;
      let cropRaw: string | undefined;
      try {
        for await (const part of request.parts({ limits: { fileSize: deps.siteLimits.get("uploadMaxBytes") } })) {
          if (part.type === "file") {
            if (part.fieldname === "original" && original === undefined) {
              original = await part.toBuffer();
              originalTruncated = part.file.truncated;
            } else if (part.fieldname === "display" && display === undefined) {
              display = await part.toBuffer();
              displayTruncated = part.file.truncated;
            } else {
              part.file.resume();
            }
          } else if (part.fieldname === "crop" && cropRaw === undefined && typeof part.value === "string") {
            cropRaw = part.value;
          }
        }
      } catch (err) {
        drainWithCap(request);
        request.log.warn({ err }, "multipart 解析失敗");
        return sendError(reply, 400, "invalid_body", "The upload isn't valid multipart/form-data.");
      }

      if (originalTruncated || displayTruncated || (display !== undefined && display.length > MAX_AVATAR_DISPLAY_BYTES)) {
        drainWithCap(request);
        return sendError(reply, 413, "file_too_large", UPLOAD_TOO_LARGE_MESSAGE);
      }
      if (original === undefined || display === undefined || cropRaw === undefined) {
        drainWithCap(request);
        return sendError(reply, 400, "invalid_body", "The upload needs the original, display and crop parts.");
      }
      const cropField = parseCropField(cropRaw);
      if (cropField === null) {
        drainWithCap(request);
        return sendError(reply, 400, "invalid_body", "The crop field isn't valid.");
      }
      // 只信檔頭，不採信請求端聲稱的 Content-Type／副檔名；GIF 與 SVG 不收。
      const originalMime = detectImageMimeType(original);
      const displayMime = detectImageMimeType(display);
      if (originalMime === null || originalMime === "image/gif" || displayMime === null || displayMime === "image/gif") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", UNSUPPORTED_IMAGE_MESSAGE);
      }

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
        originalMime,
        originalSize: original.length,
        originalWidth: cropField.width,
        originalHeight: cropField.height,
        crop: { x: cropField.x, y: cropField.y, size: cropField.size },
        displayData: display,
        displayMime,
        lockTimeoutMs: deps.storageLockTimeoutMs,
      };
      let row;
      try {
        row = await deps.db.transaction(tx => insertAvatarInTx(tx, input, deps.avatarTestHooks));
      } catch (err) {
        // DB 沒有列的檔不該留在磁碟；清檔失敗不吞原錯誤。
        await unlink(finalPath).catch(() => {});
        // 先判子類（StorageQuotaExceeded extends TxAbort）：反序會失去數字。
        if (err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // 空間鎖逾時（55P03）／死結（40P01）／序列化失敗（40001），以及保底的唯一鍵與外鍵衝突 → 409 server_busy。
        if (isRetryableTxError(err) || isUniqueViolation(err) || isForeignKeyViolation(err)) {
          return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        }
        throw redactDbError(request.log, err, "上傳頭貼");
      }

      deps.gate.invalidate(me);
      return reply.code(201).send(toCandidateDto({ ...row, pending: false }, null));
    });
  };
}
