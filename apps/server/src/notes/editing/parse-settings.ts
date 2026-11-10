/**
 * #398：parse worker 的四個站台設定（環境變數 `PARSE_WORKERS`、`PARSE_WORKER_MEMORY_MB`、`PARSE_TIMEOUT_MS`、`PARSE_QUEUE_WAIT_MS`）
 * 的預設、範圍、CPU 與記憶體偵測。`config.ts` 開機時呼叫 {@link resolveParseSettings}；pool 吃 {@link ParseLimits}（`ParsePool.configure`
 * 可在執行期換，給 #397 的管理頁用）。換算方法與建議值表在 `docs/self-hosting.md`「Parse workers」。
 */
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";

export interface ParseLimits {
  /** 常駐 worker 數。 */
  workers: number;
  /** 每個 worker 的 V8 old generation 上限（MiB，`resourceLimits.maxOldGenerationSizeMb`）。 */
  workerMemoryMb: number;
  /** 一次解析的時限（毫秒）；超過就終止那個 worker、回 400 `too_complex`。 */
  timeoutMs: number;
  /** 排隊最長等待（毫秒）；超過回 503 `server_busy`。 */
  queueWaitMs: number;
}

/**
 * 記憶體上限預設（MiB）。量測（`docs/self-hosting.md`「Parse workers」）：256 KiB 的一般格式筆記 256 MiB 就解析得過；同大小、整篇擠在一段裡的
 * 密集格式最吃——`<br>` 隔開的字要 640、`**粗** _斜_` 交錯要 768 才過。1024 給後者留約 1.3 倍。
 */
export const DEFAULT_PARSE_WORKER_MEMORY_MB = 1_024;
/**
 * 時限預設。同一批量測：一般格式 256 KiB 約 1.3 秒；最慢的是 256 KiB 的 `<br>` 密集段落，約 5–6 秒（在主執行緒時本來就接受、只是卡住整台）。
 * 10 秒讓 v0.15 之前寫得進去的內容照樣寫得進去（約 1.7 倍），也是「一個人塞滿一個 worker 時，別人最多多等多久」的上限。
 */
export const DEFAULT_PARSE_TIMEOUT_MS = 10_000;
/**
 * 排隊等待預設＝{@link QUEUE_WAIT_TIMEOUT_FACTOR} × 時限＋{@link QUEUE_WAIT_SLACK_MS}（沒設 `PARSE_QUEUE_WAIT_MS` 時跟著 `PARSE_TIMEOUT_MS` 走；
 * 預設時限下＝45 秒）。理由：一件工作最長可以跑 4 × 時限（批次寫回的規劃：3 × 的檔案預算＋1 × 給整篇比對；讀出與套用的轉換
 * 是 3 ×），排在一件跑滿時限的工作後面的人仍要輪得到，不能被它擋到 503。只有 1 個 worker 時，前面若有兩件以上同時跑滿才會等不到。
 */
export const QUEUE_WAIT_TIMEOUT_FACTOR = 4;
export const QUEUE_WAIT_SLACK_MS = 5_000;
export const DEFAULT_PARSE_QUEUE_WAIT_MS = QUEUE_WAIT_TIMEOUT_FACTOR * DEFAULT_PARSE_TIMEOUT_MS + QUEUE_WAIT_SLACK_MS;
/** 自動推算的 worker 數上限（沒設 `PARSE_WORKERS` 時）。 */
export const AUTO_PARSE_WORKERS_MAX = 4;

/** 各設定的合法範圍（含兩端）。逾時類上限是 Node 計時器上限 2^31−1 ms。 */
export const PARSE_LIMIT_RANGES: Record<keyof ParseLimits, { min: number; max: number }> = {
  workers: { min: 1, max: 32 },
  workerMemoryMb: { min: 128, max: 16_384 },
  timeoutMs: { min: 100, max: 2_147_483_647 },
  queueWaitMs: { min: 100, max: 2_147_483_647 },
};

/** CPU 與記憶體偵測的來源（啟動 log 印出）。 */
export type CpuSource = "cgroup-v2" | "cgroup-v1" | "os";
export type MemorySource = CpuSource;
export interface CpuProbe {
  /** 讀檔；讀不到回 null（測試注入）。 */
  readFile?: (path: string) => string | null;
  /** `os.availableParallelism()`（測試注入）。 */
  availableParallelism?: () => number;
  /** `os.totalmem()`（bytes，測試注入）。 */
  totalmem?: () => number;
}

/** 沒設 `PARSE_WORKERS` 時，worker 的記憶體上限加起來最多佔可用記憶體的這個比例（其餘留給主程序、協作與同機的 PostgreSQL）。 */
export const PARSE_MEMORY_SHARE = 0.5;
/** cgroup v1 沒設上限時 `memory.limit_in_bytes` 是接近 2^63 的數；大於這個值就當沒設。 */
const CGROUP_V1_UNLIMITED = 2 ** 60;

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * 這個程序實際能用的 CPU 數：`os.availableParallelism()`（只看 CPU 親和性，**不看 cgroup 的 CPU 配額**——實測 Node 22.23 在
 * `docker run --cpus=2` 裡回主機的 24）與 cgroup 配額（v2 `/sys/fs/cgroup/cpu.max` 的 `quota period`；v1 `cpu.cfs_quota_us`／
 * `cpu.cfs_period_us`）取小，配額向上取整。沒有配額（`max`、-1）或讀不到（非 Linux）就只用 `availableParallelism()`。
 */
export function detectCpuCount(probe: CpuProbe = {}): { cpus: number; source: CpuSource } {
  const read = probe.readFile ?? readOrNull;
  const ap = Math.max(1, (probe.availableParallelism ?? availableParallelism)());
  const quota = (q: number, p: number): number | null => (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? Math.max(1, Math.ceil(q / p)) : null);
  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2 !== null) {
    const [q, p] = v2.trim().split(/\s+/);
    const n = q === "max" ? null : quota(Number(q), Number(p));
    return n === null ? { cpus: ap, source: "os" } : { cpus: Math.min(ap, n), source: "cgroup-v2" };
  }
  for (const dir of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"]) {
    const q = read(`${dir}/cpu.cfs_quota_us`);
    const p = read(`${dir}/cpu.cfs_period_us`);
    if (q === null || p === null) continue;
    const n = quota(Number(q.trim()), Number(p.trim()));
    return n === null ? { cpus: ap, source: "os" } : { cpus: Math.min(ap, n), source: "cgroup-v1" };
  }
  return { cpus: ap, source: "os" };
}

/** 依 CPU 的 worker 數：留 1 核給主程序（HTTP、協作），至少 1、至多 {@link AUTO_PARSE_WORKERS_MAX}。 */
export function defaultParseWorkers(cpus: number): number {
  return Math.max(1, Math.min(AUTO_PARSE_WORKERS_MAX, cpus - 1));
}

/**
 * 這個程序能用的記憶體（bytes）：cgroup v2 `/sys/fs/cgroup/memory.max`（`max`＝沒設）→ cgroup v1 `memory.limit_in_bytes`
 * （接近 2^63 的「沒設」值不算）→ `os.totalmem()`。容器裡 `os.totalmem()` 回的是主機的記憶體，所以 cgroup 優先。
 */
export function detectMemoryLimit(probe: CpuProbe = {}): { bytes: number; source: MemorySource } {
  const read = probe.readFile ?? readOrNull;
  const asBytes = (raw: string | null): number | null => {
    if (raw === null) return null;
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n > 0 && n < CGROUP_V1_UNLIMITED ? n : null;
  };
  const v2 = asBytes(read("/sys/fs/cgroup/memory.max"));
  if (v2 !== null) return { bytes: v2, source: "cgroup-v2" };
  const v1 = asBytes(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  if (v1 !== null) return { bytes: v1, source: "cgroup-v1" };
  return { bytes: (probe.totalmem ?? totalmem)(), source: "os" };
}

/** 依記憶體的 worker 數：floor(可用記憶體 × {@link PARSE_MEMORY_SHARE} ÷ 每個 worker 的上限)，至少 1。 */
export function memoryParseWorkers(memoryBytes: number, workerMemoryMb: number): number {
  return Math.max(1, Math.floor((memoryBytes * PARSE_MEMORY_SHARE) / (workerMemoryMb * 1024 * 1024)));
}

export interface ResolvedParseSettings extends ParseLimits {
  /** 每個值是環境變數給的還是預設（`workers` 的預設是推算的）。 */
  from: Record<keyof ParseLimits, "env" | "default">;
  /** worker 數怎麼來的：環境變數、依 CPU、或依記憶體（兩者推算取小，記憶體那邊比較小時是 `memory`）。 */
  workersSource: "env" | "cpu" | "memory";
  cpus: number;
  cpuSource: CpuSource;
  /** 偵測到的可用記憶體（bytes）與來源。 */
  memoryBytes: number;
  memorySource: MemorySource;
}

const ENV_NAMES: Record<keyof ParseLimits, string> = {
  workers: "PARSE_WORKERS",
  workerMemoryMb: "PARSE_WORKER_MEMORY_MB",
  timeoutMs: "PARSE_TIMEOUT_MS",
  queueWaitMs: "PARSE_QUEUE_WAIT_MS",
};

/** 環境變數 → 生效值。不合法（非整數、超出 {@link PARSE_LIMIT_RANGES}）丟 `設定錯誤：…`（開機 fail fast）；空字串＝沒設。 */
export function resolveParseSettings(env: NodeJS.ProcessEnv, probe?: CpuProbe): ResolvedParseSettings {
  const { cpus, source } = detectCpuCount(probe);
  const memory = detectMemoryLimit(probe);
  const defaults: ParseLimits = {
    workers: defaultParseWorkers(cpus),
    workerMemoryMb: DEFAULT_PARSE_WORKER_MEMORY_MB,
    timeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
    queueWaitMs: DEFAULT_PARSE_QUEUE_WAIT_MS,
  };
  const out = { ...defaults };
  const from = { workers: "default", workerMemoryMb: "default", timeoutMs: "default", queueWaitMs: "default" } as ResolvedParseSettings["from"];
  for (const key of Object.keys(ENV_NAMES) as Array<keyof ParseLimits>) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw === "") continue;
    const { min, max } = PARSE_LIMIT_RANGES[key];
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`設定錯誤：${ENV_NAMES[key]} 必須是 ${min} 到 ${max} 的整數：${raw}`);
    out[key] = value;
    from[key] = "env";
  }
  // 排隊等待的預設跟著生效的時限走（見 DEFAULT_PARSE_QUEUE_WAIT_MS）。
  if (from.queueWaitMs === "default") out.queueWaitMs = Math.min(PARSE_LIMIT_RANGES.queueWaitMs.max, QUEUE_WAIT_TIMEOUT_FACTOR * out.timeoutMs + QUEUE_WAIT_SLACK_MS);
  // worker 數的預設：依 CPU 與依記憶體（用生效的每個 worker 上限算）取小。明設 `PARSE_WORKERS` 就照它。
  let workersSource: ResolvedParseSettings["workersSource"] = "env";
  if (from.workers === "default") {
    const byMemory = memoryParseWorkers(memory.bytes, out.workerMemoryMb);
    workersSource = byMemory < out.workers ? "memory" : "cpu";
    out.workers = Math.min(out.workers, byMemory);
  }
  return { ...out, from, workersSource, cpus, cpuSource: source, memoryBytes: memory.bytes, memorySource: memory.source };
}
