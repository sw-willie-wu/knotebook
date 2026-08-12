import type { FastifyRequest } from "fastify";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";

const DRAIN_CAP_BYTES = MAX_UPLOAD_BYTES * 2;

const drainedRequests = new WeakSet<object>();

/**
 * 安全 backlog ③（spec §13.2）：drain 位元組上限。單一共用 helper，取代 `app.ts`
 * onRequest 兩處＋`routes/uploads.ts` preHandler 四處／handler 四處合計十個
 * `request.raw.resume()` 呼叫點（`§12.4` 原本的「早退必 drain」通則現由這支 helper
 * 承接——舊註解已就地改引這裡）。`part.file.resume()`（`@fastify/multipart` 的
 * file part stream，不是 `request.raw`）是不同對象，不在這支 helper 的管轄範圍內。
 *
 * **裸 `request.raw.resume()` 不計位元組**：它只是把底層 socket 切進 flowing mode
 * 讓 Node 把剩餘 body 讀掉、丟棄，本身量不出讀了多少——惡意 client 可以送一個
 * 遠超合理大小的 body，讓 server 端持續花時間/記憶體把它讀完才真正結束這個連線。
 * 這裡改成掛 `data` listener 自己累計位元組數，**且仍明確呼叫一次 `resume()`**——
 * 不能只靠「掛 `data` listener 本身會讓 stream 自動進入 flowing mode」這個 Node
 * 一般通則：`request.parts()`（`@fastify/multipart`）內部的 busboy 在 parts/fields
 * 超限這類錯誤時會 `request.unpipe(bb)`，Node 的 `Readable.prototype.unpipe()`
 * （無指定 dest、拆全部管線的那個重載）**會呼叫一次 `this.pause()`**，把
 * `_readableState.flowing` 顯式釘成 `false`；而 `Readable.prototype.on('data', …)`
 * 只在 `flowing !== false` 時才會自動 `resume()`——顯式 `false` 會讓那個自動路徑
 * 整個跳過。若省略這裡的顯式 `resume()`，`routes/uploads.ts` 的 catch 分支（busboy
 * 已 unpipe 過）掛上 `data` listener 後 stream 仍停在暫停狀態，一個位元組都不會被
 * 讀取，等同完全沒有 drain——真 socket 測試會卡在 `app.close()` 逾時（見
 * `test/uploads.test.ts` 的「真 socket：parts 超限」迴歸）。
 *
 * 累計超過 `MAX_UPLOAD_BYTES * 2` 就 `request.raw.destroy()`——直接砍斷底層連線。
 *
 * **超限語意（明文取捨；review fix round 1 依實測修正措辭）**：`destroy()` 之後
 * client 端**最壞情況**是收到 TCP/socket 層級的 network error 而非我們原本要送出的
 * 結構化 `{ error: { code, message } }`——`destroy()` 是硬中斷（可能帶 RST），若
 * response 尚未完整送達／被 client 讀走，RST 可以把已經 buffer 但還沒被讀取的回應
 * 一併吃掉；這在有中間 proxy／非 loopback 的網路路徑上更容易發生，是這裡接受的
 * 取捨，不是 bug。**loopback 實測（本機開發／測試環境）行為更好**：`drainWithCap`
 * 與緊接著的 `sendError(...)` 在同一段同步程式碼內執行、中間沒有 `await`，而累計
 * 位元組超過 cap 進而呼叫 `destroy()` 至少要等一輪事件迴圈之後的 `data` 事件才會
 * 發生——回應幾乎總是搶先寫出，client 實際上仍會收到完整的結構化 403/400 body，
 * 只是連線隨後被關閉、不維持 keep-alive（見 `test/uploads.test.ts` Task 9 那支真
 * socket 測試的時序註解，內含實測數據）。正常的早退情境（未登入、無權限、節流、
 * 格式錯誤……）body 遠低於這個上限，既有「早退仍收到結構化 error body」的迴歸測試
 * 不受影響；只有真的送出異常巨量 body 的 client 才會撞到這條防線。
 *
 * **冪等**：同一個 `request` 重複呼叫只會在第一次真的掛上 `data` listener，第二次
 * 起直接 no-op——不會疊加多個 listener 重複計數（那樣會讓累計提早、且錯誤地超過
 * `DRAIN_CAP_BYTES`）。用 `WeakSet` 記錄「這個 `request.raw` 是否已經掛過」，key 是
 * `request.raw` 本身（每個請求各自獨立的物件），不會跨請求誤判。
 */
export function drainWithCap(request: FastifyRequest): void {
  const raw = request.raw;
  if (drainedRequests.has(raw)) {
    return;
  }
  drainedRequests.add(raw);

  let received = 0;
  raw.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > DRAIN_CAP_BYTES) {
      raw.destroy();
    }
  });
  raw.resume();
}
