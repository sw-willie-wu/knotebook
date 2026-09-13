/**
 * 寫入端點的 HTTP body 上限（#108 D30）。葉節點模組，不依賴任何路由。
 *
 * ⚠ **單位是 byte**，與 `notes/schemas.ts` 的 `MD`（UTF-16 **code unit**）**數值相同、
 * 單位不同，永遠不得合併成同一個常數**：一份 262 144 code unit 的 CJK markdown ≈ 786 KB
 * UTF-8，會先撞這一道的 413、根本走不到 zod 的 400。兩道關各守一件事，都要留著。
 * 邊界形（`WRITE_BODY_LIMIT` 恰好／+1）由 `test/write-body-limit.test.ts` 四發釘住。
 */

/** `POST /api/notes/:id/edits` 與 `POST /api/mcp` 共用的 body 上限（**bytes**）。不明寫就是 fastify 預設的 1 MiB。 */
export const WRITE_BODY_LIMIT = 262_144;
