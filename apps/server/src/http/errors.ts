import type { FastifyReply } from "fastify";

/**
 * 統一錯誤回應格式 `{ error: { code, message } }` 的唯一定義處。app.ts（全域錯誤
 * handler、404、認證 decorator）與各路由模組（setup.ts、auth.ts、…）一律從這裡
 * import，不要各自重複宣告——這個模組不依賴 app.ts、也不依賴任何路由模組，
 * 純粹是被兩邊共同依賴的葉節點，因此不會造成循環 import。
 */
export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: { code, message } });
}
