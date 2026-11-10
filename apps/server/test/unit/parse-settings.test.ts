/**
 * #398：parse worker 的四個設定——環境變數的解析與範圍驗證、預設常數、CPU 與記憶體偵測（cgroup 讀取可注入）。生效值（env＞管理頁＞
 * 預設／自動）的推算在 `site-limits-resolve.test.ts`；這裡只留一條從 `loadConfig` 到 `SiteLimits.parseLimits()` 的串接。
 */
import { SITE_LIMITS, siteLimitDef } from "@knotebook/shared";
import { PARSE_FILE_BUDGET_FACTOR } from "../../src/notes/editing/parse-core.js";
import { DOC_TIMEOUT_FACTOR } from "../../src/notes/editing/doc-jobs.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SiteLimits } from "../../src/site-limits/store.js";
import {
  AUTO_PARSE_WORKERS_MAX,
  DEFAULT_PARSE_QUEUE_WAIT_MS,
  DEFAULT_PARSE_TIMEOUT_MS,
  DEFAULT_PARSE_WORKER_MEMORY_MB,
  PARSE_LIMIT_RANGES,
  defaultParseWorkers,
  detectCpuCount,
  detectMachine,
  detectMemoryLimit,
  memoryParseWorkers,
  parseEnvLimits,
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

describe("parseEnvLimits／detectMachine（#397）", () => {
  it("只放有設的；空字串＝沒設；前後空白容許", () => {
    expect(parseEnvLimits({})).toEqual({});
    expect(parseEnvLimits({ PARSE_WORKERS: "", PARSE_TIMEOUT_MS: "20000" })).toEqual({ parseTimeoutMs: 20000 });
    expect(parseEnvLimits({ PARSE_WORKER_MEMORY_MB: "2048", PARSE_QUEUE_WAIT_MS: "7000", PARSE_WORKERS: "3" })).toEqual({ parseWorkers: 3, parseWorkerMemoryMb: 2048, parseQueueWaitMs: 7000 });
    expect(parseEnvLimits({ PARSE_WORKERS: "3", PARSE_WORKER_MEMORY_MB: " 768 ", PARSE_TIMEOUT_MS: "4000", PARSE_QUEUE_WAIT_MS: "" })).toEqual({ parseWorkers: 3, parseWorkerMemoryMb: 768, parseTimeoutMs: 4000 });
  });
  it("env 名取自註冊表：每個 PARSE_* 都對到同名 env 的那一項", () => {
    for (const [key, value] of [["parseWorkers", 3], ["parseWorkerMemoryMb", 768], ["parseTimeoutMs", 4000], ["parseQueueWaitMs", 7000]] as const) {
      expect(parseEnvLimits({ [siteLimitDef(key).env!]: String(value) }), key).toEqual({ [key]: value });
    }
  });
  it("範圍兩端收、超出一格就丟（訊息帶變數名、範圍與原值）", () => {
    const names = { workers: ["PARSE_WORKERS", "parseWorkers"], workerMemoryMb: ["PARSE_WORKER_MEMORY_MB", "parseWorkerMemoryMb"], timeoutMs: ["PARSE_TIMEOUT_MS", "parseTimeoutMs"], queueWaitMs: ["PARSE_QUEUE_WAIT_MS", "parseQueueWaitMs"] } as const;
    for (const [key, [name, siteKey]] of Object.entries(names) as Array<[keyof typeof names, (typeof names)[keyof typeof names]]>) {
      const { min, max } = PARSE_LIMIT_RANGES[key];
      expect(parseEnvLimits({ [name]: String(min) })[siteKey]).toBe(min);
      expect(parseEnvLimits({ [name]: String(max) })[siteKey]).toBe(max);
      for (const bad of [String(min - 1), String(max + 1), "1.5", "abc", "-3", "1e3", "0x10"]) {
        expect(() => parseEnvLimits({ [name]: bad }), `${name}=${bad}`).toThrow(`設定錯誤：${name} 必須是 ${min} 到 ${max} 的整數：${bad}`);
      }
    }
  });
  it("detectMachine 沿用 cpu／記憶體偵測", () => {
    expect(detectMachine(files({ "/sys/fs/cgroup/cpu.max": "200000 100000", "/sys/fs/cgroup/memory.max": String(2 * GiB) }))).toEqual({ cpus: 2, cpuSource: "cgroup-v2", memoryBytes: 2 * GiB, memorySource: "cgroup-v2" });
    expect(detectMachine(files({}, 8, 16 * GiB))).toEqual({ cpus: 8, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "os" });
  });
  it("loadConfig 帶出 limitEnv 與 machine（含注入的偵測），生效值由 SiteLimits 從這兩樣算；非法值讓 loadConfig 丟（開機 fail fast）", () => {
    const c = loadConfig({ ...valid, PARSE_TIMEOUT_MS: "3000" }, files({}, 5));
    expect(c.limitEnv).toEqual({ parseTimeoutMs: 3000 });
    expect(c.machine).toEqual({ cpus: 5, cpuSource: "os", memoryBytes: 64 * GiB, memorySource: "os" });
    // env 的時限低於管理頁範圍照用；排隊等待自動跟著它（4 × 3000 + 5000）；worker 數依 CPU（5 − 1）
    expect(SiteLimits.defaults({ limitEnv: c.limitEnv, machine: c.machine }).parseLimits()).toEqual({ workers: 4, workerMemoryMb: DEFAULT_PARSE_WORKER_MEMORY_MB, timeoutMs: 3000, queueWaitMs: 17_000 });
    // 2 GiB：依記憶體只放得下 1 個 1024 MiB 的 worker
    const small = loadConfig(valid, files({}, 5, 2 * GiB));
    expect(SiteLimits.defaults({ limitEnv: small.limitEnv, machine: small.machine }).parseLimits().workers).toBe(1);
    expect(() => loadConfig({ ...valid, PARSE_WORKERS: "0" })).toThrow(/設定錯誤：PARSE_WORKERS/);
  });
});

describe("排隊等待的預設", () => {
  it("沒設 PARSE_QUEUE_WAIT_MS：4 × PARSE_TIMEOUT_MS ＋ 5 秒（預設 45 秒），不短於最長的一件工作（批次寫回規劃 3× 預算＋1×、轉換 3×）", () => {
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBe(45_000);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan((PARSE_FILE_BUDGET_FACTOR + 1) * DEFAULT_PARSE_TIMEOUT_MS);
    expect(DEFAULT_PARSE_QUEUE_WAIT_MS).toBeGreaterThan(DOC_TIMEOUT_FACTOR * DEFAULT_PARSE_TIMEOUT_MS);
    expect(DEFAULT_PARSE_TIMEOUT_MS).toBe(SITE_LIMITS.parseTimeoutMs.default);
    const machine = detectMachine(files({}, 8));
    expect(SiteLimits.defaults({ limitEnv: { parseTimeoutMs: 30_000 }, machine }).parseLimits().queueWaitMs).toBe(125_000);
    expect(SiteLimits.defaults({ limitEnv: { parseTimeoutMs: 30_000, parseQueueWaitMs: 1000 }, machine }).parseLimits().queueWaitMs).toBe(1000);
  });
});
