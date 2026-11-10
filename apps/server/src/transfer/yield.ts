/**
 * bulk transfer：讓出事件迴圈的唯一一支（`export-note.ts` 的 `defaultYield` 原樣搬來）。
 *
 * 兩次 `setImmediate`：從 check 以外的階段接著跑時，一次 setImmediate 會在**同一輪**的 check 階段就回來——從 poll（I/O 回呼）
 * 進入時，timers 與新到的 I/O 都輪不到；從 timers 進入時，已到期的 timer 輪不到。兩次才保證跨過一輪 timers＋poll（共編的
 * WebSocket 訊息在 poll 處理）。守衛：`transfer-export-note.test.ts` 的 Y1（timer）、Y2（socket 資料）、`transfer-line-diff.test.ts`
 * 的設計；Node 22 與 24 各實跑 20 次結果一致。bench（2 000 顆）：一次時最長停頓 p50 378 ms，兩次時 209 ms。
 *
 * 讓出一律**按時間預算**：距上次讓出 ≥ `YIELD_AFTER_MS` 才讓（同一個呼叫內跨迴圈與遞迴共用計時器）。
 */
import { setImmediate as setImmediateP } from "node:timers/promises";

export const YIELD_AFTER_MS = 20;

export async function yieldToLoop(): Promise<void> {
  await setImmediateP();
  await setImmediateP();
}
