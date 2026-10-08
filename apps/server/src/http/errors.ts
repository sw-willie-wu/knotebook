import type { FastifyReply } from "fastify";
import type { ErrorCode, StorageQuotaErrorDetail } from "@knotebook/shared";

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
 * 登入節流 429 回應專用 helper：code 固定為 `"too_many_attempts"`、唯一允許
 * 頂層 `retryAfterMs` 欄位的出口。
 */
export function sendLoginThrottled(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply.code(429).send({
    error: { code: "too_many_attempts", message: "登入嘗試次數過多，請稍後再試" },
    retryAfterMs,
  });
}

/**
 * 儲存配額 409（spec §8.1）：`{ error: { code: "storage_quota_exceeded", message }, storage: detail }`——頂層額外欄位的第二個
 * 出口（先例 `sendLoginThrottled`）。`detail` 的數字可見性由呼叫端在交易外決定（`storage/usage.ts` 的 `quotaErrorDetail`）。
 * 上傳路徑的兩處 409（讀 body 之前的預檢、交易內判定）刻意同碼同形、不可分辨（跨 spec 契約，#200 §2.7(3)）——不得加任何旗標欄。
 */
export function sendStorageQuotaExceeded(reply: FastifyReply, detail: StorageQuotaErrorDetail): FastifyReply {
  return reply.code(409).send({ error: { code: "storage_quota_exceeded", message: "儲存空間已滿" }, storage: detail });
}
