/** #398：parse worker 的站台設定（環境變數）——解析、範圍驗證、預設推算、CPU 偵測（cgroup 讀取可注入）。 */
import { PARSE_FILE_BUDGET_FACTOR } from "../../src/notes/editing/parse-core.js";
import { DOC_TIMEOUT_FACTOR } from "../../src/notes/editing/doc-jobs.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  AUTO_PARSE_WORKERS_MAX,
  DEFAULT_PARSE_QUEUE_WAIT_MS,
  DEFAULT_PARSE_TIMEOUT_MS,
  DEFAULT_PARSE_WORKER_MEMORY_MB,
  PARSE_LIMIT_RANGES,
  defaultParseWorkers,
  detectCpuCount,
  detectMemoryLimit,
  memoryParseWorkers,
  resolveParseSettings,
  type CpuProbe,
} from "../../src/notes/editing/parse-settings.js";

const GiB = 1024 ** 3;
const files = (m: Record<string, string>, ap = 24, mem = 64 * GiB): CpuProbe => ({ readFile: p => m[p] ?? null, availableParallelism: () => ap, totalmem: () => mem });
const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "https://notes.example.com" };

describe("detectCpuCount", () => {
  it("cgroup v2 `cpu.max` 有配額 → 配額向上取整，與 availableParallelism 取小", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "200000 100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "150000 100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "50000 100000\n" }))).toEqual({ cpus: 1, source: "cgroup-v2" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "800000 100000\n" }, 4))).toEqual({ cpus: 4, source: "cgroup-v2" });
  });
  it("cgroup v2 沒有配額（max）→ availableParallelism", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "max 100000\n" }, 6))).toEqual({ cpus: 6, source: "os" });
  });
  it("cgroup v1（`cpu/` 或 `cpu,cpuacct/`）：quota／period；-1＝沒有配額", () => {
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" }))).toEqual({ cpus: 2, source: "cgroup-v1" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "300000", "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000" }))).toEqual({ cpus: 3, source: "cgroup-v1" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" }, 8))).toEqual({ cpus: 8, source: "os" });
  });
  it("讀不到 cgroup（非 Linux）→ availableParallelism；壞內容也退回它", () => {
    expect(detectCpuCount(files({}, 12))).toEqual({ cpus: 12, source: "os" });
    expect(detectCpuCount(files({ "/sys/fs/cgroup/cpu.max": "garbage" }, 3))).toEqual({ cpus: 3, source: "os" });
  });
});

describe("defaultParseWorkers", () => {
  it(`max(1, min(${AUTO_PARSE_WORKERS_MAX}, CPU − 1))`, () => {
    expect([1, 2, 3, 4, 5, 8, 64].map(defaultParseWorkers)).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });
});

describe("detectMemoryLimit", () => {
  it("cgroup v2 `memory.max` 有值 → 它；`max` → 往下找", () => {
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "4294967296" }))).toEqual({ bytes: 4 * GiB, source: "cgroup-v2" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max" }, 24, 16 * GiB))).toEqual({ bytes: 16 * GiB, source: "os" });
  });
  it("cgroup v1 `memory.limit_in_bytes`；沒設上限的大數（約 2^63）不算", () => {
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648" }))).toEqual({ bytes: 2 * GiB, source: "cgroup-v1" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }, 24, 8 * GiB))).toEqual({ bytes: 8 * GiB, source: "os" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824" }))).toEqual({ bytes: GiB, source: "cgroup-v1" });
  });
  it("讀不到 cgroup、或內容壞掉 → os.totalmem()", () => {
    expect(detectMemoryLimit(files({}, 24, 32 * GiB))).toEqual({ bytes: 32 * GiB, source: "os" });
    expect(detectMemoryLimit(files({ "/sys/fs/cgroup/memory.max": "garbage" }, 24, 3 * GiB))).toEqual({ bytes: 3 * GiB, source: "os" });
  });
});

describe("memoryParseWorkers", () => {
  it("floor(記憶體 × 0.5 ÷ 每個 worker 的上限)，至少 1", () => {
    expect(memoryParseWorkers(2 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(4 * GiB, 1024)).toBe(2);
    expect(memoryParseWorkers(8 * GiB, 1024)).toBe(4);
    expect(memoryParseWorkers(3 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(1 * GiB, 1024)).toBe(1);
    expect(memoryParseWorkers(16 * GiB, 2048)).toBe(4);
  });
});

describe("resolveParseSettings", () => {
  it("worker 數預設＝依 CPU 與依記憶體取小；記憶體比較小時來源是 memory（用生效的 PARSE_WORKER_MEMORY_MB 算）", () => {
    const cg = (cpu: string, mem: string) => files({ "/sys/fs/cgroup/cpu.max": cpu, "/sys/fs/cgroup/memory.max": mem });
    // 8 CPU、2 GiB：CPU 說 4、記憶體說 1 → 1（memory）
    expect(resolveParseSettings({}, cg("800000 100000", String(2 * GiB)))).toMatchObject({ workers: 1, workersSource: "memory", memoryBytes: 2 * GiB, memorySource: "cgroup-v2", cpus: 8 });
    // 4 CPU、16 GiB：CPU 說 3、記憶體說 8 → 3（cpu）
    expect(resolveParseSettings({}, cg("400000 100000", String(16 * GiB)))).toMatchObject({ workers: 3, workersSource: "cpu" });
    // 4 CPU、4 GiB、每個 worker 512：記憶體說 4 → 3（cpu）；每個 2048：記憶體說 1 → 1（memory）
    expect(resolveParseSettings({ PARSE_WORKER_MEMORY_MB: "512" }, cg("400000 100000", String(4 * GiB)))).toMatchObject({ workers: 3, workersSource: "cpu" });
    expect(resolveParseSettings({ PARSE_WORKER_MEMORY_MB: "2048" }, cg("400000 100000", String(4 * GiB)))).toMatchObject({ workers: 1, workersSource: "memory" });
    // 兩者相等 → cpu
    expect(resolveParseSettings({}, cg("300000 100000", String(4 * GiB)))).toMatchObject({ workers: 2, workersSource: "cpu" });
    // 明設 PARSE_WORKERS 就照它（記憶體再小也一樣）
    expect(resolveParseSettings({ PARSE_WORKERS: "6" }, cg("800000 100000", String(GiB)))).toMatchObject({ workers: 6, workersSource: "env" });
  });
  it("都沒設 → 預設；worker 數依偵測到的 CPU；from 全是 default", () => {
    const r = resolveParseSettings({}, files({ "/sys/fs/cgroup/cpu.max": "200000 100000" }));
    expect(r).toEqual({
      workers: 1,
      workerMemoryMb: DEFAULT_PARSE_WORKER_MEMORY_MB,
      timeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
      queueWaitMs: DEFAULT_PARSE_QUEUE_WAIT_MS,
      from: { workers: "default", workerMemoryMb: "default", timeoutMs: "default", queueWaitMs: "default" },
      workersSource: "cpu",
      cpus: 2,
      cpuSource: "cgroup-v2",
      memoryBytes: 64 * GiB,
      memorySource: "os",
    });
  });
  it("環境變數覆寫（空字串＝沒設；前後空白容許）", () => {
    const r = resolveParseSettings({ PARSE_WORKERS: "3", PARSE_WORKER_MEMORY_MB: " 768 ", PARSE_TIMEOUT_MS: "4000", PARSE_QUEUE_WAIT_MS: "" }, files({}, 8));
    // 排隊等待沒設：跟著生效的時限走（4 × 4000 + 5000，審查 r4 I4）
    expect(r).toMatchObject({ workers: 3, workerMemoryMb: 768, timeoutMs: 4000, queueWaitMs: 21_000 });
    expect(r.from).toEqual({ workers: "env", workerMemoryMb: "env", timeoutMs: "env", queueWaitMs: "default" });
    expect(r.workersSource).toBe("env");
  });
  it("範圍兩端收、超出一格就丟（訊息帶變數名、範圍與原值）", () => {
    const names = { workers: "PARSE_WORKERS", workerMemoryMb: "PARSE_WORKER_MEMORY_MB", timeoutMs: "PARSE_TIMEOUT_MS", queueWaitMs: "PARSE_QUEUE_WAIT_MS" } as const;
    for (const [key, name] of Object.entries(names) as Array<[keyof typeof names, string]>) {
      const { min, max } = PARSE_LIMIT_RANGES[key];
      expect(resolveParseSettings({ [name]: String(min) }, files({}))[key]).toBe(min);
      expect(resolveParseSettings({ [name]: String(max) }, files({}))[key]).toBe(max);
      for (const bad of [String(min - 1), String(max + 1), "1.5", "abc", "-3", "1e3", "0x10"]) {
        expect(() => resolveParseSettings({ [name]: bad }, files({})), `${name}=${bad}`).toThrow(new RegExp(`${name} 必須是 ${min} 到 ${max} 的整數`));
      }
    }
  });
  it("loadConfig 帶出 parse（含注入的 CPU 偵測）；非法值讓 loadConfig 丟（開機 fail fast）", () => {
    expect(loadConfig({ ...valid, PARSE_TIMEOUT_MS: "3000" }, files({}, 5)).parse).toMatchObject({ workers: 4, workersSource: "cpu", timeoutMs: 3000, cpus: 5, cpuSource: "os", memorySource: "os" });
    expect(loadConfig(valid, files({}, 5, 2 * GiB)).parse).toMatchObject({ workers: 1, workersSource: "memory" });
    expect(() => loadConfig({ ...valid, PARSE_WORKERS: "0" })).toThrow(/設定錯誤：PARSE_WORKERS/);
  });
});

describe("排隊等待的預設（審查 r4 I4）", () => {
  it("沒設 PARSE_QUEUE_WAIT_MS：4 × PARSE_TIMEOUT_MS ＋ 5 秒（預設 45 秒），不短於最長的一件工作（批次寫回規劃 3× 預算＋1×、轉換 3×）", () => {
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBe(45_000);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan((PARSE_FILE_BUDGET_FACTOR + 1) * DEFAULT_PARSE_TIMEOUT_MS);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan(DOC_TIMEOUT_FACTOR * DEFAULT_PARSE_TIMEOUT_MS);
    expect(resolveParseSettings({ PARSE_TIMEOUT_MS: "30000" }).queueWaitMs).toBe(125_000);
    expect(resolveParseSettings({ PARSE_TIMEOUT_MS: "30000", PARSE_QUEUE_WAIT_MS: "1000" }).queueWaitMs).toBe(1000);
  });
});
