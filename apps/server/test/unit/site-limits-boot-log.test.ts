import { describe, expect, it } from "vitest";
import { parseSettingsLogFields } from "../../src/site-limits/boot-log.js";
import { SiteLimits } from "../../src/site-limits/store.js";
import type { MachineInfo } from "../../src/site-limits/types.js";

const GiB = 2 ** 30;
const machine: MachineInfo = { cpus: 4, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "os" };

describe("parseSettingsLogFields（開機 log「parse worker settings in effect」，#397 §6.3）", () => {
  it("全預設：欄位名照舊；worker 數依 CPU、兩個自動項 from=auto", () => {
    expect(parseSettingsLogFields(SiteLimits.defaults({ machine }))).toEqual({
      workers: 3,
      workersSource: "cpu",
      workerMemoryMb: 1024,
      timeoutMs: 10_000,
      queueWaitMs: 45_000,
      from: { workers: "auto", workerMemoryMb: "default", timeoutMs: "default", queueWaitMs: "auto" },
      cpus: 4,
      cpuSource: "os",
      memoryMb: 16_384,
      memorySource: "os",
    });
  });

  it("記憶體比 CPU 少 → workersSource=memory；機器來源照實帶出", () => {
    const f = parseSettingsLogFields(SiteLimits.defaults({ machine: { cpus: 8, cpuSource: "cgroup-v2", memoryBytes: 2 * GiB, memorySource: "cgroup-v1" } }));
    expect(f).toMatchObject({ workers: 1, workersSource: "memory", cpus: 8, cpuSource: "cgroup-v2", memoryMb: 2048, memorySource: "cgroup-v1" });
    expect(f.from.workers).toBe("auto");
  });

  it("env 給的 → workersSource=env、from=env；排隊等待仍自動、跟著 env 的時限", () => {
    const f = parseSettingsLogFields(SiteLimits.defaults({ machine, limitEnv: { parseWorkers: 2, parseTimeoutMs: 5000 } }));
    expect(f).toMatchObject({ workers: 2, workersSource: "env", timeoutMs: 5000, queueWaitMs: 25_000 });
    expect(f.from).toEqual({ workers: "env", workerMemoryMb: "default", timeoutMs: "env", queueWaitMs: "auto" });
  });

  it("管理頁存的 → workersSource=admin、from.workers=admin", () => {
    // `defaults()` 沒有 DB 列；把它的 view 裡 parseWorkers 的來源換成 admin（形狀同 `load` 讀到一列時）。
    const base = SiteLimits.defaults({ machine });
    const stub = {
      parseLimits: () => ({ ...base.parseLimits(), workers: 2 }),
      view: () => {
        const v = base.view();
        return { ...v, items: v.items.map(i => (i.key === "parseWorkers" ? { ...i, value: 2, source: "admin" as const, stored: 2 } : i)) };
      },
    };
    const f = parseSettingsLogFields(stub);
    expect(f).toMatchObject({ workers: 2, workersSource: "admin" });
    expect(f.from.workers).toBe("admin");
  });
});
