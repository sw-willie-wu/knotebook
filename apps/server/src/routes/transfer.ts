/**
 * bulk transfer spec 2026-11-02 §5–§9、§15：`/api/transfer/*`。只收 `knbt_` bulk 權杖（`transferAuth.requireBulk`），
 * 不回退 cookie。讀側三支：`GET /api/transfer/notes/:id`（單篇）、`DELETE /api/transfer/token`（自行撤銷）、`GET /api/transfer/export`
 * （整包）；寫側（PR-2）：`PUT /api/transfer/notes`（寫回一篇／新增）。
 * 讀取零副作用（plan §1-1）：只走 `loadNoteDoc`，不開直連、不 touch presence、不動 `notes.*`；唯一的寫入是 `transfer_bases`
 * 與撤銷。HTTP 層訊息中文（`sendError`）。log 不記內容、標題、檔名、權杖。
 */
import { eq } from "drizzle-orm";
import { publicUrlIssuer } from "../config.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createTransferAuth } from "../auth/transfer-auth.js";
import type { UserGate } from "../auth/session.js";
import type { CollabServer } from "../collab/server.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError } from "../http/errors.js";
import { retryAfterSeconds, type FixedWindowLimiter } from "../http/rate-limit.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { resolveNoteAccess } from "../notes/service.js";
import type { ErrorCode } from "@knotebook/shared";
import { FOLDER_NOT_FOUND_MESSAGE } from "../folders/messages.js";
import type { NoteWriteService, SyncFileOk } from "../notes/editing/write-service.js";
import { fileShaOf, resolveCreateDest } from "../transfer/create-file.js";
import { readNoteFile } from "../transfer/frontmatter.js";
import { normalizeBody } from "../transfer/normalize.js";
import { UNCLOSED_FENCE_MESSAGE } from "../transfer/regions.js";
import { parseErrorMessage } from "./notes.js";
import { deriveTransferKey, transferKeyId } from "../transfer/base-hash.js";
import { insertBases, pruneBases } from "../transfer/bases.js";
import { buildNoteFile } from "../transfer/note-file.js";
import { sanitizeTitle } from "../transfer/paths.js";
import { ExportSlot } from "../transfer/export-slot.js";
import { EXPORT_BUSY_RETRY_AFTER_S, TRANSFER_EXPORT_MAX_NOTES, streamExport, type ExportTestHooks } from "../transfer/export-stream.js";
import { inRangeIds, layoutOf, rangeGone, visibleNotes, visibleTree } from "../transfer/range.js";

/** plan §0.1-3（暫定，待 Willie 確認）：範圍物件（群組、資料夾）使用時已看不到。 */
export const RANGE_GONE_MESSAGE = "此 transfer token 的範圍已看不到";
export const NOT_IN_RANGE_MESSAGE = "這篇筆記不在此 transfer token 的範圍內";
export const TRANSFER_NOTE_NOT_FOUND_MESSAGE = "找不到此筆記";
export const TRANSFER_RATE_LIMITED_MESSAGE = "請求過於頻繁，請稍後再試";
/** plan §0.1-13：全站已有一個匯出在跑。 */
export const EXPORT_BUSY_MESSAGE = "已有一個匯出正在進行，請稍後再試";
export const TOO_MANY_NOTES_MESSAGE = `範圍內的筆記超過 ${TRANSFER_EXPORT_MAX_NOTES} 篇，請縮小範圍`;
/** §9.1：寫回的 body 不是 UTF-8（fatal 解碼失敗）。 */
export const INVALID_UTF8_MESSAGE = "檔案不是 UTF-8";

/** 寫回（PUT）的測試縫（plan H5）。生產不注入。 */
export interface WriteTestHooks {
  /** PUT 的 `reply.raw` close handler 第一行呼叫。 */
  onWriteClientClose?(): void;
  /** PUT handler 第一行 await（在掛 close 監聽之前；D5 用）。 */
  beforeWriteHandler?(): Promise<void>;
}
/** 單篇與整包共用的測試縫（`forceUnmergeable` 兩邊都看；其餘只有整包用）＋寫回的縫。 */
export type TransferTestHooks = ExportTestHooks & WriteTestHooks;

/** plan §0.1-13：HTTP 層中文（PR-3 一起審）。 */
export const BASE_UNAVAILABLE_MESSAGE = "無法以這份副本合併：已送回過不同的內容、不屬於這篇，或已過期；請重新下載再改";
export const NOT_MERGEABLE_MESSAGE = "這篇筆記不能用檔案寫回，請改用 edit_note";

export interface TransferRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  collab: CollabServer;
  editing: EditingRuntime;
  /** 與 app 其他路由同一個實例（`bearerMiss` 與 `authenticateAny` 共用一本帳）。 */
  limiters: {
    bearerMiss: FixedWindowLimiter;
    contentRead: FixedWindowLimiter;
    transferExport: FixedWindowLimiter;
    /** 寫回：只在佇列內扣（plan 不變量 13）；這裡只做不計數的 isBlocked 預檢。 */
    transferWrite: FixedWindowLimiter;
    /** 與 MCP／REST 的 Bearer 讀取同一顆（key `token:${userId}`）：零區、同檔重送、去重命中扣這顆。 */
    tokenRead: FixedWindowLimiter;
  };
  /** 寫入 service（全樹唯一的佇列；寫回與 edit_note 串行）。 */
  writes: NoteWriteService;
  testHooks?: TransferTestHooks;
}

/** RFC 5987 的 `filename*` 值：`encodeURIComponent` 再補逸 `'()*`。 */
export function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function transferRoutes(deps: TransferRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const auth = createTransferAuth({ db: deps.db, gate: deps.gate, authenticate: app.authenticate, limiters: { bearerMiss: deps.limiters.bearerMiss } });
    const requireBulkRead = auth.requireBulk("read");
    const requireBulkWrite = auth.requireBulk("write");
    const key = deriveTransferKey(deps.config.appSecret);
    const fileDeps = { db: deps.db, collab: deps.collab, editing: deps.editing, key, keyId: transferKeyId(key) };
    const slot = new ExportSlot();
    const site = publicUrlIssuer(deps.config.publicUrl);

    /**
     * 整包（spec §6）。順序是契約（plan T10）：1b 範圍物件看不到 → 403（不碰桶、不拿 slot）→ 2 全站 slot（忙 → 429
     * `Retry-After: 30`，不扣桶）→ 3（同步，中間不得有 await）扣 `transferExport`，不足 → 放 slot＋429＋`Retry-After` →
     * 4 完整可見集合命名、範圍篩；範圍內 > 3 000 篇 → 413（串流前）→ 6 hijack 串流。拿到 slot 之後任何出口都放。
     */
    // `exposeHeadRoute: false`（T7–T11 審查 m6）：Fastify 5 預設替 GET 掛 HEAD，HEAD 會跑完整匯出、扣桶、拿 slot。
    app.get("/api/transfer/export", { preHandler: requireBulkRead, exposeHeadRoute: false }, async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const bt = request.bulkTransfer!;
      const tree = await visibleTree(deps.db, userId);
      if (await rangeGone(deps.db, userId, bt.range, tree)) return sendError(reply, 403, "forbidden", RANGE_GONE_MESSAGE);
      const release = slot.tryAcquire();
      if (release === null) {
        reply.header("retry-after", String(EXPORT_BUSY_RETRY_AFTER_S));
        return sendError(reply, 429, "too_many_requests", EXPORT_BUSY_MESSAGE);
      }
      if (!deps.limiters.transferExport.consume(userId)) {
        release();
        reply.header("retry-after", String(retryAfterSeconds(deps.limiters.transferExport.retryAfterMs(userId))));
        return sendError(reply, 429, "too_many_requests", TRANSFER_RATE_LIMITED_MESSAGE);
      }
      let streaming = false;
      const started = Date.now();
      try {
        const exportedAt = new Date();
        const layout = layoutOf({ notes: await visibleNotes(deps.db, userId), ...tree }, bt.range);
        if (layout.files.size > TRANSFER_EXPORT_MAX_NOTES) return sendError(reply, 413, "too_many_notes", TOO_MANY_NOTES_MESSAGE);
        streaming = true;
        reply.hijack();
        await streamExport({
          db: deps.db,
          gate: deps.gate,
          log: request.log,
          fileDeps,
          reply,
          userId,
          tokenId: bt.id,
          parentTokenId: bt.parentTokenId,
          range: bt.range,
          tree,
          layout,
          site,
          exportedAt,
          release,
          hooks: deps.testHooks,
        });
      } catch (err) {
        if (!streaming) throw err;
        // 能到這裡的只有 streamExport 自己的 try 之前（writeHead／建 writer／掛監聽）丟的錯——它的 finally 沒跑，所以
        // log 與 onExportEnd 在這裡補（outcome 照中止語意記 aborted；鍵集合與 streamExport 那一行相同，複審 F4）。
        // hijack 之後 Fastify 不再替我們回錯誤：斷 socket（§5.6 的中止形），只記 code／constraint。
        request.log.warn({ ...pgErrorSummary(err) }, "整包匯出串流前失敗");
        reply.raw.destroy();
        release(); // 先放 slot 再報結束（同 streamExport 的 finally 順序）；finally 再放一次是冪等的
        deps.testHooks?.onExportEnd?.("aborted");
        request.log.info(
          { userId, tokenId: bt.parentTokenId, range: bt.range, notes: 0, skipped: 0, notMergeable: 0, bytes: 0, ms: Date.now() - started, outcome: "aborted" },
          "bulk transfer export",
        );
      } finally {
        // release 冪等（T7–T11 審查 m2）：streamExport 在 writeHead／建 writer 之前丟錯時，它自己的 finally 不會跑。
        release();
      }
    });

    /** 自行撤銷（spec §5.6）：刪這支 bulk 權杖的列。 */
    app.delete("/api/transfer/token", { preHandler: requireBulkRead }, async (request: FastifyRequest, reply: FastifyReply) => {
      await deps.db.delete(transferTokens).where(eq(transferTokens.id, request.bulkTransfer!.id));
      return reply.code(204).send();
    });

    /**
     * 單篇（spec §7）。順序：① 看不到／不存在／垃圾桶／非 uuid → 404 同字 ② 範圍物件看不到 → 403 RANGE_GONE ③ 不在範圍 → 403
     * ④ 扣 `contentRead`（角色與範圍檢查之後）⑤ 組檔 ⑥ 寫一列基底 ⑦ 清理（fire-and-forget）⑧ 200 text/markdown。
     */
    app.get("/api/transfer/notes/:id", { preHandler: requireBulkRead, exposeHeadRoute: false }, async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const range = request.bulkTransfer!.range;
      const { id } = request.params as { id: string };
      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") return sendError(reply, 404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
      const tree = await visibleTree(deps.db, userId);
      if (await rangeGone(deps.db, userId, range, tree)) return sendError(reply, 403, "forbidden", RANGE_GONE_MESSAGE);
      const rows = await visibleNotes(deps.db, userId, { ids: [id] });
      const row = rows[0];
      if (row === undefined || !inRangeIds(rows, tree, range).has(row.id)) return sendError(reply, 403, "forbidden", NOT_IN_RANGE_MESSAGE);
      if (!deps.limiters.contentRead.consume(userId)) {
        reply.header("retry-after", String(retryAfterSeconds(deps.limiters.contentRead.retryAfterMs(userId))));
        return sendError(reply, 429, "too_many_requests", TRANSFER_RATE_LIMITED_MESSAGE);
      }
      const nf = await buildNoteFile(fileDeps, userId, row, { forceUnmergeable: deps.testHooks?.forceUnmergeable?.(row.id) === true });
      await insertBases(deps.db, request.log, [nf.base]);
      pruneBases(deps.db, request.log, userId, [row.id]);
      return reply
        .code(200)
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeRfc5987(sanitizeTitle(row.title) + ".md")}`)
        .header("cache-control", "no-store")
        .send(nf.file);
    });

    /**
     * 寫回一篇（spec §9；PR-2）。`text/markdown` 的 415／Origin 403 在全域 onRequest（`TEXT_BODY_EXEMPT_ROUTES`），parser 在頂層
     * 只回 Buffer；1 MiB 上限 → 413 `content_too_large`（§21 D11）。解碼在這裡：`fatal: true`，非 UTF-8 → 400 `invalid_body`。
     */
    app.put("/api/transfer/notes", { preHandler: requireBulkWrite, bodyLimit: TRANSFER_WRITE_BODY_LIMIT }, async (request: FastifyRequest, reply: FastifyReply) => {
      await deps.testHooks?.beforeWriteHandler?.();
      const started = Date.now();
      // S14 斷線守衛（plan §0.1-11）：只掛 `reply.raw` 的 close（T1 探針：PUT 上 `request.raw` 的 close 在 body 讀完時就觸發）；
      // 掛上之後立刻補查一次 `destroyed`（handler 開始之前就斷線的請求，gate r1 m14）。斷線**不改變任何流程**，只記 `clientClosed`。
      let clientClosed = false;
      const onClose = () => {
        deps.testHooks?.onWriteClientClose?.();
        if (!reply.raw.writableFinished) clientClosed = true;
      };
      reply.raw.once("close", onClose);
      if (reply.raw.destroyed) onClose();
      const userId = request.user!.id;
      const bt = request.bulkTransfer!;
      let noteId: string | null = null;
      /** §13 寫回 log＋plan §0.1-10：規定鍵 13 個；錯誤出口沒算到的 diff 鍵給 null（rev 4）。不記標題、本文、frontmatter 值。 */
      const logLine = (result: string, d?: Partial<Pick<SyncFileOk, "applied" | "same" | "conflicts" | "diffOverflow" | "anchored" | "degradedLines">> & { versionId?: string | null }) =>
        request.log.info(
          {
            userId, tokenId: bt.parentTokenId, noteId, result,
            applied: d?.applied ?? null, same: d?.same ?? null, conflicts: d?.conflicts ?? null, versionId: d?.versionId ?? null,
            ms: Date.now() - started, diffOverflow: d?.diffOverflow ?? null, anchored: d?.anchored ?? null, degradedLines: d?.degradedLines ?? null, clientClosed,
          },
          "bulk transfer write",
        );
      const fail = (status: number, code: ErrorCode, message: string) => {
        logLine(code);
        return sendError(reply, status, code, message);
      };
      const tooMany = (retryAfterMs: number) => {
        reply.header("retry-after", String(retryAfterSeconds(retryAfterMs)));
        return fail(429, "too_many_requests", TRANSFER_RATE_LIMITED_MESSAGE);
      };
      // 審查 m1：未預期的例外（全域 handler 回 500）也要記這一行——鍵同 ⑪ 的 13 個、diff 鍵 null、`result: "internal"`；
      // 例外本身照舊往外丟（不吞、不改回應）。帶內容的 DB 錯誤在 service 已經 `redactDbError` 過。
      try {
        const raw = request.body;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(raw) ? raw : new Uint8Array(0));
        } catch {
          return fail(400, "invalid_body", INVALID_UTF8_MESSAGE);
        }
        const file = readNoteFile(text);
        if (file.kind === "error") return fail(400, "invalid_body", file.message);
        const limiters = { transferWrite: deps.limiters.transferWrite, tokenRead: deps.limiters.tokenRead };
        const tree = await visibleTree(deps.db, userId);

        if (file.kind === "new") {
          // §10：新增（T10）。
          if (await rangeGone(deps.db, userId, bt.range, tree)) return fail(403, "forbidden", RANGE_GONE_MESSAGE);
          const dest = await resolveCreateDest(deps.db, userId, bt.range, file.folderId, tree);
          if (!dest.ok) return fail(dest.status, dest.code, dest.message);
          if (deps.limiters.transferWrite.isBlocked(userId)) return tooMany(deps.limiters.transferWrite.retryAfterMs(userId));
          const out = await deps.writes.createFromFile(request.log, {
            userId, userHandle: request.user!.handle, tokenId: bt.parentTokenId, fileSha: fileShaOf(key, userId, normalizeBody(text)), keyId: fileDeps.keyId,
            title: file.title, body: file.body, dest: { scope: dest.scope, folderId: dest.folderId }, limiters,
          });
          if (!out.ok) {
            if (out.kind === "parse") return fail(400, out.code, parseErrorMessage(out.code, "無法解析內容"));
            if (out.kind === "rate_limited") return tooMany(out.retryAfterMs);
            if (out.kind === "folder_gone") return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
            if (out.kind === "busy") return fail(503, "server_busy", "伺服器忙碌中，請稍後再試");
            return fail(500, "internal", "無法建立筆記");
          }
          noteId = out.noteId;
          logLine(out.created ? "created" : "unchanged");
          return out.created
            ? reply.code(201).send({ id: out.noteId, created: true, result: "created", base: null, unboundWikilinks: out.unboundWikilinks })
            : reply.code(200).send({ id: out.noteId, created: false, result: "unchanged", base: null });
        }

        // §9.2 寫回既有筆記（T8／T9）。順序是契約：可見 → 範圍物件 → 範圍 → 角色 → isBlocked 預檢 → syncFile。
        noteId = file.id;
        const access = await resolveNoteAccess(deps.db, userId, file.id);
        if (access.role === "none") return fail(404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
        if (await rangeGone(deps.db, userId, bt.range, tree)) return fail(403, "forbidden", RANGE_GONE_MESSAGE);
        const rows = await visibleNotes(deps.db, userId, { ids: [file.id] });
        const row = rows[0];
        if (row === undefined || !inRangeIds(rows, tree, bt.range).has(row.id)) return fail(403, "forbidden", NOT_IN_RANGE_MESSAGE);
        if (!access.permissions.edit) return fail(403, "forbidden", "沒有編輯權限");
        if (deps.limiters.transferWrite.isBlocked(userId)) return tooMany(deps.limiters.transferWrite.retryAfterMs(userId));
        const out = await deps.writes.syncFile(request.log, {
          noteId: file.id, userId, userHandle: request.user!.handle, tokenId: bt.parentTokenId, access, baseKey: file.base, title: file.title,
          body: file.body, key, keyId: fileDeps.keyId, limiters,
        });
        if (!out.ok) {
          if (out.kind === "base_unavailable") return fail(409, "base_unavailable", BASE_UNAVAILABLE_MESSAGE);
          if (out.kind === "not_mergeable") return fail(409, "not_mergeable", NOT_MERGEABLE_MESSAGE);
          if (out.kind === "busy") return fail(503, "server_busy", "伺服器忙碌中，請稍後再試");
          if (out.kind === "gone") return fail(404, "not_found", TRANSFER_NOTE_NOT_FOUND_MESSAGE);
          if (out.kind === "rate_limited") return tooMany(out.retryAfterMs);
          if (out.kind === "parse") {
            if (out.code === "unclosed_fence") return fail(400, "invalid_body", UNCLOSED_FENCE_MESSAGE);
            return fail(400, out.code, parseErrorMessage(out.code, "無法套用檔案"));
          }
          return fail(500, "internal", "無法寫回");
        }
        logLine(out.result, { ...out, versionId: out.version?.id ?? null });
        return reply.code(200).send({
          id: file.id, created: false, result: out.result, applied: out.applied, same: out.same, conflicts: out.conflicts,
          ...(out.version ? { version: out.version } : {}), editIds: out.editIds, renamed: out.renamed,
          ...(out.renameFailed ? { renameFailed: out.renameFailed } : {}), unboundWikilinks: out.unboundWikilinks, base: null,
        });
      } catch (err) {
        logLine("internal");
        throw err;
      }
    });
  };
}
