/** #397：兩個自動項的推算（組合 shared 的純函式與現有常數）。 */
import { defaultParseWorkers, memoryParseWorkers } from "@knotebook/shared";
import { QUEUE_WAIT_SLACK_MS, QUEUE_WAIT_TIMEOUT_FACTOR } from "../notes/editing/parse-settings.js";
import type { MachineInfo } from "./types.js";

/** `min(依 CPU, 依記憶體)`；記憶體那邊嚴格較小才標 `memory`（同 parse-settings 開機時的判斷）。 */
export function autoParseWorkers(machine: MachineInfo, workerMemoryMb: number): { value: number; source: "cpu" | "memory" } {
  const byCpu = defaultParseWorkers(machine.cpus);
  const byMemory = memoryParseWorkers(machine.memoryBytes, workerMemoryMb);
  return byMemory < byCpu ? { value: byMemory, source: "memory" } : { value: byCpu, source: "cpu" };
}

/** 排隊等待的自動值：跟著（生效的）時限走；上限 2^31−1（setTimeout 的上限），不受管理頁範圍限制。 */
export function autoQueueWaitMs(timeoutMs: number): number {
  return Math.min(2 ** 31 - 1, QUEUE_WAIT_TIMEOUT_FACTOR * timeoutMs + QUEUE_WAIT_SLACK_MS);
}
