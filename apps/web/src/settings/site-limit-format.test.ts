import { describe, expect, it } from "vitest";
import type { SiteLimitItemDto, SiteLimitsDto } from "@knotebook/shared";
import { effectiveWorkers, estimateParseMemoryMb, formatApiValue, fromInput, toInput } from "./site-limit-format";

const GiB = 1024 ** 3;
const MACHINE: SiteLimitsDto["machine"] = { cpus: 8, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" };

describe("toInput：API 單位 → 輸入單位", () => {
  it("對齊時換成輸入單位；沒對齊回 null（照 API 單位原樣顯示）", () => {
    expect(toInput("noteMaxBytes", 5_242_880)).toBe(5);
    expect(toInput("noteMaxBytes", 5_242_881)).toBeNull();
    expect(toInput("parseTimeoutMs", 10_000)).toBe(10);
    expect(toInput("parseTimeoutMs", 12_345)).toBeNull();
    expect(toInput("sessionTtlSeconds", 604_800)).toBe(168);
    expect(toInput("parseWorkerMemoryMb", 1_024)).toBe(1_024);
    expect(toInput("rateEdit", 30)).toBe(30);
  });
});

describe("fromInput：輸入文字 → API 單位", () => {
  it("整數個輸入單位換成 API 單位", () => {
    expect(fromInput("noteMaxBytes", "2")).toEqual({ ok: true, value: 2_097_152 });
    expect(fromInput("noteMaxBytes", " 5 ")).toEqual({ ok: true, value: 5_242_880 });
    expect(fromInput("sessionTtlSeconds", "24")).toEqual({ ok: true, value: 86_400 });
    expect(fromInput("parseTimeoutMs", "4")).toEqual({ ok: true, value: 4_000 });
  });

  it("小數、空白、非數字 → notInteger", () => {
    expect(fromInput("noteMaxBytes", "0.5")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "   ")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "abc")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "1e3")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("parseTimeoutMs", "1.5")).toEqual({ ok: false, reason: "notInteger" });
  });

  it("換算後超出管理頁範圍 → range", () => {
    expect(fromInput("noteMaxBytes", "6")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("noteMaxBytes", "0")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("noteMaxBytes", "-1")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("parseTimeoutMs", "3")).toEqual({ ok: false, reason: "range" });
  });
});

describe("formatApiValue：照 API 單位原樣顯示", () => {
  it("bytes 與 ms 不四捨五入，每三位以空格分隔", () => {
    expect(formatApiValue("noteMaxBytes", 5_242_881)).toBe("5 242 881 bytes");
    expect(formatApiValue("parseTimeoutMs", 12_345)).toBe("12 345 ms");
    expect(formatApiValue("parseTimeoutMs", 999)).toBe("999 ms");
    expect(formatApiValue("noteMaxBytes", 104_857_601, "bytes")).toBe("104 857 601 bytes");
  });
});

describe("estimateParseMemoryMb：(N × (M + 150) + 1000) × 1.2", () => {
  it("2 個 worker、1024 MiB → 4017.6", () => {
    expect(estimateParseMemoryMb(2, 1_024)).toBe(4017.6);
    expect(estimateParseMemoryMb(2, 512)).toBe(2788.8);
    expect(estimateParseMemoryMb(1, 512)).toBe(1994.4);
  });
});

describe("effectiveWorkers：試算記憶體時用的 worker 數", () => {
  const auto: SiteLimitItemDto = { key: "parseWorkers", value: 1, source: "auto", locked: false, stored: null, autoValue: 1, autoSource: "memory" };

  it("自動且輸入框空白 → 依新的記憶體上限重算，不用伺服器舊的 autoValue", () => {
    expect(effectiveWorkers("", auto, MACHINE, 512)).toBe(2);
    expect(effectiveWorkers("", auto, { ...MACHINE, cpus: 2 }, 512)).toBe(1);
    expect(effectiveWorkers("", auto, MACHINE, 1_024)).toBe(1);
  });

  it("輸入了合法值 → 用輸入值；env 鎖住 → 用生效值", () => {
    expect(effectiveWorkers("3", auto, MACHINE, 512)).toBe(3);
    const env: SiteLimitItemDto = { key: "parseWorkers", value: 4, source: "env", locked: true, stored: null, autoValue: 1, autoSource: "memory" };
    expect(effectiveWorkers("", env, MACHINE, 512)).toBe(4);
  });

  it("已調整的項目輸入不合法 → 用目前生效值；清空（＝改回自動）→ 依新的記憶體上限重算", () => {
    const admin: SiteLimitItemDto = { key: "parseWorkers", value: 3, source: "admin", locked: false, stored: 3, autoValue: 1, autoSource: "memory" };
    expect(effectiveWorkers("1.5", admin, MACHINE, 512)).toBe(3);
    expect(effectiveWorkers("", admin, MACHINE, 512)).toBe(2);
  });
});
