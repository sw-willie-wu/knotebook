import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserGate } from "../auth/session.js";
import { createTransferAuth } from "../auth/transfer-auth.js";
import { drainWithCap } from "../http/drain.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation, isRetryableTxError } from "../db/pg-errors.js";
import { transferTokens, uploads } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { resolveNoteAccess, resolveRole, UUID_RE } from "../notes/service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { spaceOfNote } from "../storage/space.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { isSpaceFull, precheckDetail, quotaErrorDetail, readSpaceUsage } from "../storage/usage.js";
import { detectImageMimeType } from "../uploads/magic-bytes.js";
import { uploadFilePath } from "../uploads/service.js";
import { insertUploadInTx } from "../uploads/tx/insert-upload.js";

export interface UploadsRouteDeps {
  db: Db;
  config: AppConfig;
  /** #200：transfer token 路徑的 `checkUser`（停權／需改密碼）。 */
  gate: UserGate;
  /**
   * `upload`：per-user 節流（`UPLOAD_LIMIT`，同 collabToken/slugPatch 慣例，key=userId）。
   * #200：`bearerMiss`（per-IP，帶 header 的 401）與 `tokenRead`（transfer GET，key `token:${userId}`）——
   * 與 `authenticateAny` 同一個實例（`app.ts` 傳同一個 `limiters` 物件的成員）。
   */
  limiters: { upload: FixedWindowLimiter; bearerMiss: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
  uploadsDir: string;
  /** 交錯點測試注入縫（`groups/test-hook.ts`），透傳自 `AppDeps.groupTestHook`（配額的 `storage-space-locked`）。 */
  groupTestHook?: GroupTestHook;
  /** 空間鎖等待上限（ms），透傳自 `AppDeps.storageLockTimeoutMs`（預設 `DEFAULT_STORAGE_LOCK_TIMEOUT_MS`）。 */
  storageLockTimeoutMs: number;
}

/**
 * 上傳（POST）／下載（GET）路由（spec §12.4/§12.5，Task 10b）。
 *
 * `POST /api/notes/:id/uploads` 的 multipart body 解析與 CSRF 豁免（essence 檢查 +
 * Origin 驗證）在 `app.ts` 的全域 `onRequest` hook 已完成（Task 10a）——本模組只處理
 * routing 之後的邏輯：authenticate → editor+ 權限 → 節流 → 儲存配額「已滿」預檢 → 解析 multipart body →
 * magic bytes 偵測 → 寫檔 → 交易（筆記 KEY SHARE → 空間鎖＋配額 → INSERT；`uploads/tx/insert-upload.ts`）。
 *
 * `@fastify/multipart` 本身**必須**在頂層 `app`（非 encapsulated plugin）註冊——見
 * `app.ts` 的註冊點註解。本模組不重複註冊它，只消費 `request.parts()`。
 *
 * #200：兩支路由在 session 之外加收 **transfer token**（`auth/transfer-auth.ts`；一般 PAT／OAuth Bearer 不收，
 * spec §5.1）。POST 的 preHandler 順序是契約（spec §5.2）：認證 → token 的筆記＝路徑筆記 → 使用當下角色 → 上傳節流
 * → 儲存配額「已滿」預檢（第 4a 步；已滿不燒 token）→ 原子消費；全部在 `request.parts()` 之前、每個早退都 drain。
 * **消費之後**（server 開始讀檔之後）的任何失敗都燒掉 token、不退還（spec §5.2、Q2）——含交易內的 409
 * `storage_quota_exceeded`（放不下）與 409 `server_busy`（空間鎖逾時／死結），兩種 409 都與預檢的同碼同形。CSRF：`MULTIPART_EXEMPT_ROUTES` 不變——Bearer 不是 ambient 憑證。
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

    /**
     * 認證 + 授權 + 節流 + 儲存配額「已滿」預檢全部收在 preHandler，且**每個早退分支都要先 drain**
     * （`drainWithCap`，spec §13.2）——這幾個檢查都在真的開始解析 multipart body
     * （`request.parts()`）之前執行，而 `@fastify/multipart` 的 content-type parser
     * （`setMultipart`）本身完全不讀 body，只是設個旗標；若不主動 drain，未被消費的
     * request body 會讓底層 socket 卡住，client 收不到我們已經送出的結構化錯誤 body
     * （見 task-10-brief 的「大 body + 早退 4xx 仍收到結構化 error body」）。
     *
     * #200：認證改走 `transferAuth.require("upload")`（沒帶 `Authorization` 就回退 `app.authenticate`，session 路徑
     * 行為不變）；transfer 路徑多兩步——「token 的筆記＝路徑筆記」排在角色之前、原子消費排在節流之後（spec §5.2）。
     */
    async function authAndAuthorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await uploadAuth(request, reply);
      if (reply.sent) {
        drainWithCap(request);
        return;
      }

      const { id: noteId } = request.params as { id: string };
      const userId = request.user!.id;
      const transfer = request.transfer;

      // #200 spec §5.2 第 2 步：排在角色之前——持 A 篇 token 的人拿 B 篇的 id 來打一律同形 403，不洩漏 B 存不存在。
      // DB 存小寫正規形、`UUID_RE` 收大寫（M1），所以比對前 toLowerCase。
      if (transfer !== undefined && transfer.noteId !== noteId.toLowerCase()) {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", "此 transfer token 不適用於這篇筆記");
        return;
      }

      // 第 3 步：使用當下重驗角色（spec A）。`ownerId`／`groupId` 是配額的空間鍵，也在使用當下決定。
      const access = await resolveNoteAccess(deps.db, userId, noteId);
      if (access.role === "none") {
        drainWithCap(request);
        sendError(reply, 404, "not_found", "找不到此筆記");
        return;
      }
      if (access.role === "viewer") {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", "沒有編輯權限");
        return;
      }
      request.uploadSpace = { ownerId: access.ownerId, groupId: access.groupId };

      // 第 4 步：排在消費 token 之前——被 429 擋下時 token 不被燒掉。
      if (!deps.limiters.upload.consume(userId)) {
        drainWithCap(request);
        sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
        return;
      }

      // 第 4a 步（配額預檢，#200 spec §5.2-4a；儲存配額 §6.3-1、§8.3）：不持鎖的「已滿」預檢——讀 body 之前、
      // 消費 token 之前，所以已滿不燒 token。放得下與否的權威判定在交易內（insertUploadInTx）；這裡只擋「已經滿了」。
      const space = spaceOfNote(access);
      const usage = await readSpaceUsage(deps.db, space);
      if (isSpaceFull(usage)) {
        drainWithCap(request);
        sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, request.user!, space, usage));
        return;
      }

      // 第 5 步：原子消費。兩發並發同一支 token：row lock 讓後到的那句看到 consumed_at 已非 NULL → 0 列 → 401；
      // body 都還沒讀，第二發不會寫任何東西到磁碟。到期以 DB now() 判（與認證那句同一個時鐘）。
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

      // 完整跑完這個迴圈（不提早 break）本身即是 drain 通則的落地：無論最終判定是
      // 成功、413、415 還是 400，迴圈跑到底代表整個 multipart body 已經從 socket
      // 讀完（file part 的 backpressure 是靠實際消費——`toBuffer()`／`.resume()`——
      // 才會釋放，不是靠 `drainWithCap` 就能繞過的，那個只對「完全還沒進
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
        // 這行也沒事，Node 自己會 dump）。這裡若不主動 drain（`drainWithCap`），
        // client 送到一半／送完但尚未被讀完的剩餘 body 會卡在 paused 狀態，
        // 底層 socket 遲遲不會真正結束——真 socket 實測會讓 `app.close()`
        // graceful shutdown 永遠等不到這個連線收尾（見 test/uploads.test.ts
        // 的「真 socket：parts 超限」測試，先前少這行時實測 app.close() 逾時
        // 10s 才觸發 timeout guard，加上這行後 100ms 內完成）。
        drainWithCap(request);
        // 外掛其餘錯誤（缺 boundary 的 `Multipart: Boundary not found`、
        // `FST_PARTS_LIMIT`、`FST_FIELDS_LIMIT` 等）一律在這裡接住，統一映射成
        // 400 invalid_body——不 rethrow，否則會逃到全域 errorHandler 被
        // `clientErrorCode` 分流成語意不符的 bad_request（#106 起 413 在那裡映成
        // `content_too_large`，也一樣不是本路由該回的碼——multipart 的大小超限由下面
        // 的 `truncated` 分支自己回 413 `file_too_large`）。
        request.log.warn({ err }, "multipart 解析失敗");
        return sendError(reply, 400, "invalid_body", "上傳格式錯誤");
      }

      if (!sawFile || fileBuf === undefined) {
        // 迴圈正常跑到底才會落到這裡（沒有 file part，但也沒有任何解析錯誤）——
        // 邏輯上 body 應已被 busboy 完整消費過。仍補一行 `drainWithCap`：
        // `drainWithCap` 本身冪等（見該 helper 說明），且不依賴「迴圈一定跑到底」
        // 這個前提在未來重構後繼續成立（防禦性，同 413/415 分支）。
        drainWithCap(request);
        return sendError(reply, 400, "invalid_body", "缺少上傳檔案");
      }
      if (truncated) {
        drainWithCap(request);
        return sendError(reply, 413, "file_too_large", "檔案超過大小上限");
      }

      // 只信任 magic bytes，不採信任何請求端聲稱的 Content-Type／副檔名（見
      // `uploads/magic-bytes.ts` 頂部說明）——聲稱值完全不記錄比對，偵測失敗一律
      // 415，不做任何格式猜測。
      const mime = detectImageMimeType(fileBuf);
      if (mime === null) {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", "不支援的圖片格式");
      }

      const id = randomUUID();
      const finalPath = uploadFilePath(deps.uploadsDir, id);
      const tempPath = `${finalPath}.tmp`;

      // 先寫暫名再 rename：避免其他讀者（GET 路由的 `stat`／`createReadStream`）在
      // 寫入尚未完成時就看到一個內容不完整的檔案。
      await writeFile(tempPath, fileBuf);
      await rename(tempPath, finalPath);

      // 儲存配額 U-tx（§6.3-2）：筆記 KEY SHARE → 空間鎖＋配額 → INSERT。S14：callback 整段是 insertUploadInTx(tx, …)，引數是
      // 交易前備好的純資料與測試縫（屬性存取）。
      const input = { id, noteId: noteId.toLowerCase(), uploaderId: userId, mime, size: fileBuf.length, lockTimeoutMs: deps.storageLockTimeoutMs };
      try {
        await deps.db.transaction(tx => insertUploadInTx(tx, input, deps.groupTestHook));
      } catch (err) {
        // 交易任何拋出都先清檔（M4）：DB 沒有列的檔不該留在磁碟。清檔本身失敗（理論上不太可能，寫入才剛成功）
        // 不吞原錯誤。
        await unlink(finalPath).catch(() => {});
        // 先判子類（StorageQuotaExceeded extends TxAbort）：反序會失去數字。
        if (err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
        // 筆記在處理途中被刪：交易內 KEY SHARE 讀到 0 列 → TxAbort 404（同本檔 authAndAuthorize 的 none 分支），不是 500。
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // 防禦縱深：交易已持筆記 KEY SHARE，INSERT 不會撞 FK；撞到也回同一條 404（同既有語意）。
        if (isForeignKeyViolation(err)) return sendError(reply, 404, "not_found", "找不到此筆記");
        // §6.9：空間鎖逾時（55P03）／死結（40P01）／序列化失敗（40001）→ 409 server_busy（字面同 routes/groups.ts）。
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", "伺服器忙碌，請稍後再試");
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
    app.get("/api/uploads/:id", { preHandler: downloadAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const transfer = request.transfer;

      if (!UUID_RE.test(id)) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
      if (!row) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      // #200 spec §5.3：transfer token 只綁一篇筆記——上傳不屬於那一篇 → 403（與下面「看不到的上傳回 403」同碼，
      // 上方 JSDoc 的理由同樣成立）。兩邊都是 DB 的小寫正規形，不必再 toLowerCase。
      if (transfer !== undefined && row.noteId !== transfer.noteId) {
        return sendError(reply, 403, "forbidden", "此 transfer token 不適用於這個檔案");
      }

      const role = await resolveRole(deps.db, userId, row.noteId);
      if (role === "none") {
        return sendError(reply, 403, "forbidden", "無權存取此檔案");
      }

      // #200：transfer GET 扣 token 讀取桶（key 與 `auth/bearer.ts` 同形 `token:${userId}`、同一實例＝同一本帳）。
      if (transfer !== undefined && !deps.limiters.tokenRead.consume(`token:${userId}`)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
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
