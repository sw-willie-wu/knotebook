/** #397：站台限制在 server 端共用的型別。 */
import type { SiteLimitKey } from "@knotebook/shared";
import type { CpuSource, MemorySource } from "../notes/editing/parse-settings.js";

/** env 有設的限制值（只放有設的；沒有 env 的項目永遠不在裡面）。範圍照 config.ts 的舊驗證，不受管理頁範圍限制。 */
export type LimitEnv = Partial<Record<SiteLimitKey, number>>;

/** 偵測到的機器資訊（CPU 數、可用記憶體與來源）。 */
export interface MachineInfo {
  cpus: number;
  cpuSource: CpuSource;
  memoryBytes: number;
  memorySource: MemorySource;
}
