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

/**
 * bulk transfer spec §9.1、§21 D11：`PUT /api/transfer/notes` 的 body 上限（**bytes**）→ 413 `content_too_large`。全分支審查 I2(c)（Willie
 * 2026-11-05 拍板）從 1 MiB 降到與 `WRITE_BODY_LIMIT` 相同：完整解析的成本隨大小與內容形狀而定（不是線性：行內格式密的 1 MiB 檔實測一發 9–22 秒，256 KiB 在已量過的形裡最慢約 5 秒）。
 * 兩者單位相同（bytes），所以直接共用；名字分開留著，下載端（`tooLargeToSend`）與寫回路由看的是這個名字。
 */
export const TRANSFER_WRITE_BODY_LIMIT = WRITE_BODY_LIMIT;
