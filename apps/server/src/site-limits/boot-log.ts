/**
 * #398／#397 §6.3：開機 log「parse worker settings in effect」的欄位（純函式；`index.ts` 在 `SiteLimits.load` 之後呼叫）。
 * 欄位名照 #398 的舊 log：`workers, workersSource, workerMemoryMb, timeoutMs, queueWaitMs, from, cpus, cpuSource, memoryMb, memorySource`。
 */
import type { SiteLimitItemDto, SiteLimitKey, SiteLimitSource } from "@knotebook/shared";
import type { CpuSource, MemorySource, ParseLimits } from "../notes/editing/parse-settings.js";
import type { SiteLimits } from "./store.js";

export interface ParseSettingsLogFields extends ParseLimits {
  /** worker 數怎麼來的：env、管理頁（admin），或自動時依 CPU／記憶體推算取小的那一邊。 */
  workersSource: "env" | "admin" | "cpu" | "memory";
  /** 四項各自的來源：env／admin（管理頁）／default／auto。 */
  from: Record<keyof ParseLimits, SiteLimitSource>;
  cpus: number;
  cpuSource: CpuSource;
  memoryMb: number;
  memorySource: MemorySource;
}

export function parseSettingsLogFields(siteLimits: Pick<SiteLimits, "view" | "parseLimits">): ParseSettingsLogFields {
  const { workers, workerMemoryMb, timeoutMs, queueWaitMs } = siteLimits.parseLimits();
  const { items, machine } = siteLimits.view();
  const item = (key: SiteLimitKey): SiteLimitItemDto => {
    const found = items.find(i => i.key === key);
    if (found === undefined) throw new Error(`parseSettingsLogFields: view() has no item ${key}`);
    return found;
  };
  const w = item("parseWorkers");
  const workersSource: ParseSettingsLogFields["workersSource"] = w.source === "env" || w.source === "admin" ? w.source : (w.autoSource ?? "cpu");
  return {
    workers,
    workersSource,
    workerMemoryMb,
    timeoutMs,
    queueWaitMs,
    from: {
      workers: w.source,
      workerMemoryMb: item("parseWorkerMemoryMb").source,
      timeoutMs: item("parseTimeoutMs").source,
      queueWaitMs: item("parseQueueWaitMs").source,
    },
    cpus: machine.cpus,
    cpuSource: machine.cpuSource,
    memoryMb: Math.round(machine.memoryBytes / 2 ** 20),
    memorySource: machine.memorySource,
  };
}
