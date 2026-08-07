import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { uploads } from "../db/schema.js";
import { resolveRole, UUID_RE } from "../notes/service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { detectImageMimeType } from "../uploads/magic-bytes.js";

export interface UploadsRouteDeps {
  db: Db;
  config: AppConfig;
  /** per-user 節流（`UPLOAD_LIMIT`，同 collabToken/slugPatch 慣例，key=userId）。 */
  limiters: { upload: FixedWindowLimiter };
  uploadsDir: string;
}

/**
 * 上傳檔案在磁碟上的實際路徑——固定用 DB 主鍵 `id`（無副檔名）當檔名，`Content-Type`
 * 一律由 GET 端在回應時從 DB 的 `mime`（偵測值）欄位回填，不依賴檔名推斷。
 */
function uploadFilePath(uploadsDir: string, id: string): string {
  return path.join(uploadsDir, id);
}

/**
 * 上傳（POST）／下載（GET）路由（spec §12.4/§12.5，Task 10b）。
 *
 * `POST /api/notes/:id/uploads` 的 multipart body 解析與 CSRF 豁免（essence 檢查 +
 * Origin 驗證）在 `app.ts` 的全域 `onRequest` hook 已完成（Task 10a）——本模組只處理
 * routing 之後的邏輯：authenticate → editor+ 權限 → 節流 → 解析 multipart body →
 * magic bytes 偵測 → 寫檔 → INSERT。
 *
 * `@fastify/multipart` 本身**必須**在頂層 `app`（非 encapsulated plugin）註冊——見
 * `app.ts` 的註冊點註解。本模組不重複註冊它，只消費 `request.parts()`。
 */
export function uploadsRoutes(deps: UploadsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * 認證 + 授權 + 節流全部收在 preHandler，且**每個早退分支都要先 drain**
     * （`request.raw.resume()`）——這幾個檢查都在真的開始解析 multipart body
     * （`request.parts()`）之前執行，而 `@fastify/multipart` 的 content-type parser
     * （`setMultipart`）本身完全不讀 body，只是設個旗標；若不主動 drain，未被消費的
     * request body 會讓底層 socket 卡住，client 收不到我們已經送出的結構化錯誤 body
     * （見 task-10-brief 的「大 body + 早退 4xx 仍收到結構化 error body」）。
     */
    async function authAndAuthorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await app.authenticate(request, reply);
      if (reply.sent) {
        request.raw.resume();
        return;
      }

      const { id: noteId } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") {
        request.raw.resume();
        sendError(reply, 404, "not_found", "找不到此筆記");
        return;
      }
      if (role === "viewer") {
        request.raw.resume();
        sendError(reply, 403, "forbidden", "沒有編輯權限");
        return;
      }

      if (!deps.limiters.upload.consume(userId)) {
        request.raw.resume();
        sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
        return;
      }
    }

    app.post("/api/notes/:id/uploads", { preHandler: authAndAuthorize }, async (request, reply) => {
      const { id: noteId } = request.params as { id: string };
      const userId = request.user!.id;

      // 完整跑完這個迴圈（不提早 break）本身即是 drain 通則的落地：無論最終判定是
      // 成功、413、415 還是 400，迴圈跑到底代表整個 multipart body 已經從 socket
      // 讀完（file part 的 backpressure 是靠實際消費——`toBuffer()`／`.resume()`——
      // 才會釋放，不是靠 `request.raw.resume()` 就能繞過的，那個只對「完全還沒進
      // multipart 解析」的早退才有效，見上面 `authAndAuthorize`）。
      //
      // 「多 file part 取第一其餘 drain」（spec §12.4）：刻意不對 `request.parts()` 設
      // `limits.files`——設了的話多餘的 file part 會讓外掛自己丟 413（FilesLimitError）
      // 直接逃逸出我們的錯誤分類，不會走到這裡的「取第一個、其餘忽略」邏輯。
      let fileBuf: Buffer | undefined;
      let truncated = false;
      let sawFile = false;

      try {
        for await (const part of request.parts()) {
          if (part.type !== "file") continue; // field part 在 yield 時已由 busboy 完整消費，不需額外動作。
          if (!sawFile) {
            sawFile = true;
            fileBuf = await part.toBuffer();
            // `throwFileSizeLimit:false`（app.ts 的 `@fastify/multipart` 註冊選項）：
            // 超過 `limits.fileSize` 不會讓 `toBuffer()` throw，只會把 `.truncated`
            // 設為 true、內容被截斷——我們自己判斷、自己決定回 413，不落檔。
            truncated = part.file.truncated;
          } else {
            part.file.resume();
          }
        }
      } catch (err) {
        // 【Critical-2，真 socket 審查發現】busboy 的 `cleanup(err)` 只
        // `request.unpipe(bb)`，不會 resume `request.raw`——一旦 `request.pipe(bb)`
        // 真的跑過（`request.parts()` 已經開始消費），Node 會把這個 request 標成
        // 「應用層已接手消費」（`req._consuming`），關閉回應時內建的自動
        // `_dump()`（丟棄未讀 body）機制就不會生效了（那個機制只保護「完全沒被
        // 動過」的 request，例如 `authAndAuthorize` 的早退分支——那幾支不需要
        // 這行也沒事，Node 自己會 dump）。這裡若不主動 `request.raw.resume()`，
        // client 送到一半／送完但尚未被讀完的剩餘 body 會卡在 paused 狀態，
        // 底層 socket 遲遲不會真正結束——真 socket 實測會讓 `app.close()`
        // graceful shutdown 永遠等不到這個連線收尾（見 test/uploads.test.ts
        // 的「真 socket：parts 超限」測試，先前少這行時實測 app.close() 逾時
        // 10s 才觸發 timeout guard，加上這行後 100ms 內完成）。
        request.raw.resume();
        // 外掛其餘錯誤（缺 boundary 的 `Multipart: Boundary not found`、
        // `FST_PARTS_LIMIT`、`FST_FIELDS_LIMIT` 等）一律在這裡接住，統一映射成
        // 400 invalid_body——不 rethrow，否則會逃到全域 errorHandler 被
        // `clientErrorCode` 分流成語意不符的 bad_request（或更糟，若該錯誤帶的
        // statusCode 剛好是 413，會被誤判成看似合理但實際上語意錯誤的
        // file_too_large）。
        request.log.warn({ err }, "multipart 解析失敗");
        return sendError(reply, 400, "invalid_body", "上傳格式錯誤");
      }

      if (!sawFile || fileBuf === undefined) {
        // 迴圈正常跑到底才會落到這裡（沒有 file part，但也沒有任何解析錯誤）——
        // 邏輯上 body 應已被 busboy 完整消費過。仍補一行 `resume()`：零成本
        // （已結束的 stream 上 `resume()` 是 no-op），且不依賴「迴圈一定跑到底」
        // 這個前提在未來重構後繼續成立（防禦性，同 413/415 分支）。
        request.raw.resume();
        return sendError(reply, 400, "invalid_body", "缺少上傳檔案");
      }
      if (truncated) {
        request.raw.resume();
        return sendError(reply, 413, "file_too_large", "檔案超過大小上限");
      }

      // 只信任 magic bytes，不採信任何請求端聲稱的 Content-Type／副檔名（見
      // `uploads/magic-bytes.ts` 頂部說明）——聲稱值完全不記錄比對，偵測失敗一律
      // 415，不做任何格式猜測。
      const mime = detectImageMimeType(fileBuf);
      if (mime === null) {
        request.raw.resume();
        return sendError(reply, 415, "unsupported_media_type", "不支援的圖片格式");
      }

      const id = randomUUID();
      const finalPath = uploadFilePath(deps.uploadsDir, id);
      const tempPath = `${finalPath}.tmp`;

      // 先寫暫名再 rename：避免其他讀者（GET 路由的 `stat`／`createReadStream`）在
      // 寫入尚未完成時就看到一個內容不完整的檔案。
      await writeFile(tempPath, fileBuf);
      await rename(tempPath, finalPath);

      try {
        await deps.db.insert(uploads).values({ id, noteId, uploaderId: userId, mime, size: fileBuf.length });
      } catch (err) {
        // best-effort 清檔：INSERT 失敗（例如 noteId 剛好在這個請求處理期間被刪除，
        // FK violation）就不該留下一個 DB 沒有紀錄、卻真的佔用磁碟空間的孤兒檔案。
        // 清檔本身失敗（理論上不太可能，寫入才剛成功）不影響「INSERT 失敗」這個
        // 結論，不因此吞掉原始錯誤。
        await unlink(finalPath).catch(() => {});
        throw err;
      }

      return reply.code(201).send({ id, url: `/api/uploads/${id}` });
    });

    /**
     * GET 契約與其他 notes 路由的「none → 404」慣例刻意不同：這裡 DB 有列但呼叫者
     * 無權限 → **403**（不是 404）。理由：上傳紀錄本身不是「可能存在也可能不存在、
     * 需要防列舉」的資源——`:id` 是 `crypto.randomUUID()`，不可猜測，列出/不列出
     * 這個 id 是否存在本身不洩漏任何有意義的資訊；而「這個 id 對應到哪篇筆記、你
     * 有沒有權限看」才是需要明確告知呼叫端的部分，用 403 更精確地表達「你查得到、
     * 但沒有權限」，比起用 404 混淆「不存在」與「無權限」更符合這個資源的語意。
     */
    app.get("/api/uploads/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      if (!UUID_RE.test(id)) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
      if (!row) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      const role = await resolveRole(deps.db, userId, row.noteId);
      if (role === "none") {
        return sendError(reply, 403, "forbidden", "無權存取此檔案");
      }

      const filePath = uploadFilePath(deps.uploadsDir, row.id);
      try {
        await stat(filePath);
      } catch {
        // DB 有列、磁碟找不到對應檔案——不是使用者能自己修復的狀態，記一筆 log 供
        // 維運排查（例如 volume 被清過、手動誤刪），對呼叫端仍回統一的 404，不洩漏
        // 內部路徑等細節。
        request.log.error({ uploadId: row.id }, "DB 有上傳紀錄但磁碟找不到對應檔案");
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      reply.type(row.mime);
      return reply.send(createReadStream(filePath));
    });
  };
}
