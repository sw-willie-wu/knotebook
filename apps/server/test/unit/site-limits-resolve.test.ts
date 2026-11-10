import { SITE_LIMIT_KEYS, defaultParseWorkers, memoryParseWorkers } from "@knotebook/shared";
import { describe, expect, it } from "vitest";
import { autoParseWorkers, autoQueueWaitMs } from "../../src/site-limits/auto.js";
import { checkStorable, resolveSnapshot } from "../../src/site-limits/resolve.js";
import type { MachineInfo } from "../../src/site-limits/types.js";

const machine: MachineInfo = { cpus: 8, cpuSource: "os", memoryBytes: 16 * 2 ** 30, memorySource: "os" };
const GIB2: MachineInfo = { ...machine, memoryBytes: 2 * 2 ** 30 };

describe("resolveSnapshot 優先序", () => {
  it("env > admin > default", () => {
    const a = resolveSnapshot(new Map([["rateEdit", 10]]), {}, machine);
    expect(a.values.rateEdit).toBe(10);
    expect(a.source.rateEdit).toBe("admin");
    expect(a.source.rateSearch).toBe("default");
    expect(a.values.rateSearch).toBe(60);
    const b = resolveSnapshot(new Map([["noteMaxBytes", 1048576]]), { noteMaxBytes: 2097152 }, machine);
    expect(b.values.noteMaxBytes).toBe(2097152);
    expect(b.source.noteMaxBytes).toBe("env");
  });

  it("env 超出管理頁範圍或沒對齊照用", () => {
    for (const v of [104857600, 5242881, 3145729]) {
      const s = resolveSnapshot(new Map(), { noteMaxBytes: v }, machine);
      expect(s.values.noteMaxBytes).toBe(v);
      expect(s.source.noteMaxBytes).toBe("env");
      expect(s.ignored).toEqual([]);
    }
  });

  it("越界／沒對齊／未知 key 的列被忽略", () => {
    const s = resolveSnapshot(new Map([["noteMaxBytes", 6291456], ["parseTimeoutMs", 4500], ["bogusKey", 1]]), {}, machine);
    expect(s.values.noteMaxBytes).toBe(5242880);
    expect(s.source.noteMaxBytes).toBe("default");
    expect(s.values.parseTimeoutMs).toBe(10000);
    expect(s.source.parseTimeoutMs).toBe("default");
    expect(s.values.parseQueueWaitMs).toBe(45000);
    expect(s.source.parseQueueWaitMs).toBe("auto");
    expect(s.ignored).toHaveLength(3);
    expect(s.ignored).toEqual(expect.arrayContaining([
      { key: "noteMaxBytes", value: 6291456 }, { key: "parseTimeoutMs", value: 4500 }, { key: "bogusKey", value: 1 },
    ]));
  });
});

describe("resolveSnapshot 自動項", () => {
  it("parseWorkers 自動隨記憶體上限", () => {
    expect(memoryParseWorkers(GIB2.memoryBytes, 512)).toBe(2);
    expect(defaultParseWorkers(8)).toBe(4);
    const a = resolveSnapshot(new Map([["parseWorkerMemoryMb", 512]]), {}, GIB2);
    expect(a.values.parseWorkers).toBe(2);
    expect(a.source.parseWorkers).toBe("auto");
    expect(a.autoSource).toBe("memory");
    expect(a.autoValue.parseWorkers).toBe(2);
    const b = resolveSnapshot(new Map(), {}, GIB2);
    expect(b.values.parseWorkers).toBe(1);
    expect(b.autoSource).toBe("memory");
    const c = resolveSnapshot(new Map(), { parseWorkerMemoryMb: 128 }, GIB2);
    expect(c.values.parseWorkers).toBe(4);
    expect(c.autoSource).toBe("cpu");
  });

  it("parseWorkers 有 env 或 admin 值時不是自動，但 autoValue 仍算", () => {
    const a = resolveSnapshot(new Map([["parseWorkers", 2]]), {}, machine);
    expect(a.values.parseWorkers).toBe(2);
    expect(a.source.parseWorkers).toBe("admin");
    expect(a.autoValue.parseWorkers).toBe(4);
    const b = resolveSnapshot(new Map([["parseWorkers", 2]]), { parseWorkers: 3 }, machine);
    expect(b.values.parseWorkers).toBe(3);
    expect(b.source.parseWorkers).toBe("env");
  });

  it("parseQueueWaitMs 自動隨時限", () => {
    const a = resolveSnapshot(new Map([["parseTimeoutMs", 5000]]), {}, machine);
    expect(a.values.parseQueueWaitMs).toBe(25000);
    expect(a.source.parseQueueWaitMs).toBe("auto");
    expect(a.autoValue.parseQueueWaitMs).toBe(25000);
    const b = resolveSnapshot(new Map(), { parseTimeoutMs: 60000 }, machine);
    expect(b.values.parseQueueWaitMs).toBe(245000);
    const c = resolveSnapshot(new Map([["parseQueueWaitMs", 6000]]), {}, machine);
    expect(c.values.parseQueueWaitMs).toBe(6000);
    expect(c.source.parseQueueWaitMs).toBe("admin");
    expect(c.autoValue.parseQueueWaitMs).toBe(45000);
  });

  it("被忽略的 parseQueueWaitMs 列退回自動", () => {
    const s = resolveSnapshot(new Map([["parseQueueWaitMs", 4500]]), {}, machine);
    expect(s.values.parseQueueWaitMs).toBe(45000);
    expect(s.source.parseQueueWaitMs).toBe("auto");
    expect(s.ignored).toEqual([{ key: "parseQueueWaitMs", value: 4500 }]);
  });

  it("所有生效值都是整數", () => {
    const s = resolveSnapshot(new Map(), {}, machine);
    for (const k of SITE_LIMIT_KEYS) expect(Number.isInteger(s.values[k])).toBe(true);
  });
});

describe("auto.ts", () => {
  it("autoParseWorkers：記憶體嚴格較小才是 memory", () => {
    expect(autoParseWorkers(GIB2, 512)).toEqual({ value: 2, source: "memory" });
    expect(autoParseWorkers(machine, 1024)).toEqual({ value: 4, source: "cpu" });
    // 兩邊相等 → cpu
    expect(autoParseWorkers({ ...machine, cpus: 3, memoryBytes: 2 * 2 ** 30 }, 512)).toEqual({ value: 2, source: "cpu" });
  });
  it("autoQueueWaitMs 上限 2^31-1", () => {
    expect(autoQueueWaitMs(10000)).toBe(45000);
    expect(autoQueueWaitMs(2 ** 31)).toBe(2 ** 31 - 1);
  });
});

describe("checkStorable", () => {
  it("先範圍後刻度", () => {
    expect(checkStorable("noteMaxBytes", 1048575)).toBe("range");
    expect(checkStorable("noteMaxBytes", 1048577)).toBe("step");
    expect(checkStorable("noteMaxBytes", 1048576)).toBe("ok");
    expect(checkStorable("parseWorkers", 4)).toBe("ok");
    expect(checkStorable("parseWorkers", 5)).toBe("range");
    expect(checkStorable("parseWorkers", 2.5)).toBe("range");
  });
});
