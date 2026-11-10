/**
 * #397：解析 worker 數的自動推算（純函式，前後端共用：server 的 `site-limits/auto.ts` 組合、web 的記憶體公式警告）。
 * 從 server 的 `parse-settings.ts` 原樣搬來（#398）。
 */

/** 自動推算的 worker 數上限（沒設 `PARSE_WORKERS` 時）。 */
export const AUTO_PARSE_WORKERS_MAX = 4;

/** 沒設 `PARSE_WORKERS` 時，worker 的記憶體上限加起來最多佔可用記憶體的這個比例（其餘留給主程序、協作與同機的 PostgreSQL）。 */
export const PARSE_MEMORY_SHARE = 0.5;

/** 依 CPU 的 worker 數：留 1 核給主程序（HTTP、協作），至少 1、至多 {@link AUTO_PARSE_WORKERS_MAX}。 */
export function defaultParseWorkers(cpus: number): number {
  return Math.max(1, Math.min(AUTO_PARSE_WORKERS_MAX, cpus - 1));
}

/** 依記憶體的 worker 數：floor(可用記憶體 × {@link PARSE_MEMORY_SHARE} ÷ 每個 worker 的上限)，至少 1。 */
export function memoryParseWorkers(memoryBytes: number, workerMemoryMb: number): number {
  return Math.max(1, Math.floor((memoryBytes * PARSE_MEMORY_SHARE) / (workerMemoryMb * 1024 * 1024)));
}
