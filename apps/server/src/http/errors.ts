import type { FastifyReply } from "fastify";
import type { ErrorCode, StorageQuotaErrorDetail } from "@knotebook/shared";
import { noteTooLargeMessage } from "../notes/note-size.js";
import { STORAGE_QUOTA_EXCEEDED_MESSAGE } from "../storage/space.js";

/**
 * #372：413 的固定訊息——REST（`app.ts` 的全域 errorHandler，`content_too_large`）與 OAuth 兩個 RFC 形 plugin
 * （`routes/oauth.ts` 的 `registerRfcErrorHandlers`，`invalid_request`）共用。各路由的 `bodyLimit` 不同，不寫數字。
 */
export const BODY_TOO_LARGE_MESSAGE = "The request body is over this endpoint's size limit. Send a smaller request.";

/**
 * 統一錯誤回應格式 `{ error: { code, message } }` 的唯一定義處。app.ts（全域錯誤
 * handler、404、認證 decorator）與各路由模組（setup.ts、auth.ts、…）一律從這裡
 * import，不要各自重複宣告——這個模組不依賴 app.ts、也不依賴任何路由模組，
 * 純粹是被兩邊共同依賴的葉節點，因此不會造成循環 import。
 */
export function sendError(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}

/**
 * 筆記大小上限 413（`notes/note-size.ts`）：`{ error: { code: "note_too_large", message, limitBytes } }`——`limitBytes`＝上限（位元組）。
 */
export function sendNoteTooLarge(reply: FastifyReply, limitBytes: number): FastifyReply {
  return reply.code(413).send({ error: { code: "note_too_large", message: noteTooLargeMessage(limitBytes), limitBytes } });
}

/**
 * 登入節流 429 回應專用 helper：code 固定為 `"too_many_attempts"`、唯一允許
 * 頂層 `retryAfterMs` 欄位的出口。
 */
export function sendLoginThrottled(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply.code(429).send({
    error: { code: "too_many_attempts", message: "Too many sign-in attempts. Wait a moment and try again." },
    retryAfterMs,
  });
}

/**
 * 儲存配額 409：`{ error: { code: "storage_quota_exceeded", message }, storage: detail }`——頂層額外欄位的第二個
 * 出口（先例 `sendLoginThrottled`）。`detail` 的數字可見性由呼叫端在交易外決定（`storage/usage.ts` 的 `quotaErrorDetail`）。
 * 上傳路徑的兩處 409（讀 body 之前的預檢、交易內判定）刻意同碼同形、不可分辨（#200 的契約）——不得加任何旗標欄。
 * `message` 與 `StorageQuotaExceeded`（`storage/tx/quota.ts`）共用 `storage/space.ts` 的常數——上傳 preHandler 預檢（沒有 exception 物件）與交易內判定吐同一句（守衛：`storage-quota-structure.test.ts` ⑦）。
 */
export function sendStorageQuotaExceeded(reply: FastifyReply, detail: StorageQuotaErrorDetail): FastifyReply {
  return reply.code(409).send({ error: { code: "storage_quota_exceeded", message: STORAGE_QUOTA_EXCEEDED_MESSAGE }, storage: detail });
}

/** #181：404 in_trash——頂層第三個額外欄位出口（先例 sendLoginThrottled／sendStorageQuotaExceeded）。只給有垃圾桶權的人。 */
export function sendInTrash(reply: FastifyReply, noteId: string): FastifyReply {
  return reply.code(404).send({ error: { code: "in_trash", message: "This note is in the trash." }, noteId });
}
