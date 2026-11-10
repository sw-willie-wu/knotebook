import { SITE_LIMIT_KEYS, siteLimitStep } from "@knotebook/shared";
import { describe, expect, it } from "vitest";
import { LimitLockedError, LimitRangeError, LimitStepError } from "../../src/site-limits/errors.js";
import { resolveSnapshot } from "../../src/site-limits/resolve.js";
import { SiteLimits } from "../../src/site-limits/store.js";
import type { MachineInfo } from "../../src/site-limits/types.js";

const machine: MachineInfo = { cpus: 8, cpuSource: "os", memoryBytes: 16 * 2 ** 30, memorySource: "os" };

describe("SiteLimits.defaults()", () => {
  it("get 等於 resolveSnapshot(空表)", () => {
    const s = SiteLimits.defaults({ machine });
    const snap = resolveSnapshot(new Map(), {}, machine);
    for (const k of SITE_LIMIT_KEYS) expect(s.get(k)).toBe(snap.values[k]);
  });

  it("env 鎖：envName、view.locked 同真同假", () => {
    const s = SiteLimits.defaults({ machine, limitEnv: { parseTimeoutMs: 5000 } });
    expect(s.envName("parseTimeoutMs")).toBe("PARSE_TIMEOUT_MS");
    expect(s.envName("rateEdit")).toBeUndefined();
    const items = s.view().items;
    expect(items.find(i => i.key === "parseTimeoutMs")).toMatchObject({ locked: true, source: "env", value: 5000 });
    for (const i of items) expect(i.locked).toBe(s.envName(i.key) !== undefined);
    expect(s.get("parseQueueWaitMs")).toBe(25000);
  });

  it("parseLimits 四鍵對應", () => {
    const s = SiteLimits.defaults({ machine, limitEnv: { parseTimeoutMs: 5000 } });
    expect(s.parseLimits()).toEqual({
      workers: s.get("parseWorkers"), workerMemoryMb: s.get("parseWorkerMemoryMb"),
      timeoutMs: s.get("parseTimeoutMs"), queueWaitMs: s.get("parseQueueWaitMs"),
    });
  });

  it("view.items 順序＝SITE_LIMIT_KEYS，欄位形狀", () => {
    const v = SiteLimits.defaults({ machine }).view();
    expect(v.items.map(i => i.key)).toEqual([...SITE_LIMIT_KEYS]);
    expect(v.machine).toEqual(machine);
    const byKey = Object.fromEntries(v.items.map(i => [i.key, i]));
    expect(byKey.parseWorkers).toMatchObject({ autoValue: 4, autoSource: "cpu", stored: null, source: "auto" });
    expect(byKey.parseQueueWaitMs).toMatchObject({ autoValue: 45000 });
    expect(byKey.parseQueueWaitMs).not.toHaveProperty("autoSource");
    expect(byKey.rateEdit).not.toHaveProperty("autoValue");
    expect(byKey.rateEdit).not.toHaveProperty("storedIgnored");
    expect(byKey.rateEdit).toMatchObject({ stored: null, locked: false, value: 30, source: "default" });
  });

  it("get 永遠回整數", () => {
    const s = SiteLimits.defaults({ machine, limitEnv: { noteMaxBytes: 104857600 } });
    for (const k of SITE_LIMIT_KEYS) expect(Number.isInteger(s.get(k))).toBe(true);
  });

  it("limitEnv 含沒有 env 的 key → 丟錯", () => {
    expect(() => SiteLimits.defaults({ machine, limitEnv: { rateEdit: 5 } })).toThrow(/rateEdit/);
  });

  it("update 在唯讀實例上拒絕", async () => {
    await expect(SiteLimits.defaults({ machine }).update("u", { rateEdit: 3 })).rejects.toThrow(/read-only/);
  });

  it("onChange 回傳可呼叫的解除函式", () => {
    const off = SiteLimits.defaults({ machine }).onChange(() => {});
    expect(typeof off).toBe("function");
    off();
  });
});

describe("errors", () => {
  it("訊息逐字", () => {
    expect(new LimitLockedError("noteMaxBytes", "NOTE_MAX_BYTES").message)
      .toBe("noteMaxBytes is set by the server's environment variable NOTE_MAX_BYTES. Change it there and restart the server.");
    const r = new LimitRangeError("noteMaxBytes");
    expect(r.message).toBe("noteMaxBytes must be a whole number from 1048576 to 5242880.");
    expect(r.key).toBe("noteMaxBytes");
    const st = new LimitStepError("noteMaxBytes");
    expect(st.message).toBe("noteMaxBytes must be a multiple of 1048576.");
    expect(st.message).toBe(`noteMaxBytes must be a multiple of ${siteLimitStep("noteMaxBytes")}.`);
  });
});
