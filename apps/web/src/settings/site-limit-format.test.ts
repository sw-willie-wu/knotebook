import { describe, expect, it } from "vitest";
import type { SiteLimitItemDto, SiteLimitsDto } from "@knotebook/shared";
import { effectiveWorkers, estimateParseMemoryMb, formatApiValue, formatMib, fromInput, toInput } from "./site-limit-format";

const GiB = 1024 ** 3;
const MACHINE: SiteLimitsDto["machine"] = { cpus: 8, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" };

describe("formatMib", () => {
  it("whole GiB read as GiB, everything else stays in MiB", () => {
    expect(formatMib(100)).toBe("100 MiB");
    expect(formatMib(1024)).toBe("1 GiB");
    expect(formatMib(2048)).toBe("2 GiB");
    expect(formatMib(1536)).toBe("1536 MiB");
    expect(formatMib(10)).toBe("10 MiB");
  });
});

describe("toInput: API unit -> input unit", () => {
  it("when aligned converts to the input unit; when not aligned returns null (shown as-is in API units)", () => {
    expect(toInput("noteMaxBytes", 5_242_880)).toBe(5);
    expect(toInput("noteMaxBytes", 5_242_881)).toBeNull();
    expect(toInput("parseTimeoutMs", 10_000)).toBe(10);
    expect(toInput("parseTimeoutMs", 12_345)).toBeNull();
    expect(toInput("sessionTtlSeconds", 604_800)).toBe(168);
    expect(toInput("parseWorkerMemoryMb", 1_024)).toBe(1_024);
    expect(toInput("rateEdit", 30)).toBe(30);
  });
});

describe("fromInput: input text -> API unit", () => {
  it("a whole number of input units converts to API units", () => {
    expect(fromInput("noteMaxBytes", "2")).toEqual({ ok: true, value: 2_097_152 });
    expect(fromInput("noteMaxBytes", " 5 ")).toEqual({ ok: true, value: 5_242_880 });
    expect(fromInput("sessionTtlSeconds", "24")).toEqual({ ok: true, value: 86_400 });
    expect(fromInput("parseTimeoutMs", "4")).toEqual({ ok: true, value: 4_000 });
  });

  it("decimal, blank, non-numeric -> notInteger", () => {
    expect(fromInput("noteMaxBytes", "0.5")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "   ")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "abc")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("noteMaxBytes", "1e3")).toEqual({ ok: false, reason: "notInteger" });
    expect(fromInput("parseTimeoutMs", "1.5")).toEqual({ ok: false, reason: "notInteger" });
  });

  it("out of the admin page range after conversion -> range", () => {
    expect(fromInput("noteMaxBytes", "6")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("noteMaxBytes", "0")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("noteMaxBytes", "-1")).toEqual({ ok: false, reason: "range" });
    expect(fromInput("parseTimeoutMs", "3")).toEqual({ ok: false, reason: "range" });
  });
});

describe("formatApiValue: shown as-is in API units", () => {
  it("bytes and ms aren't rounded, grouped every three digits with spaces", () => {
    expect(formatApiValue("noteMaxBytes", 5_242_881)).toBe("5 242 881 bytes");
    expect(formatApiValue("parseTimeoutMs", 12_345)).toBe("12 345 ms");
    expect(formatApiValue("parseTimeoutMs", 999)).toBe("999 ms");
    expect(formatApiValue("noteMaxBytes", 104_857_601, "bytes")).toBe("104 857 601 bytes");
  });
});

describe("estimateParseMemoryMb: (N x (M + 150) + 1000) x 1.2", () => {
  it("2 workers, 1024 MiB -> 4017.6", () => {
    expect(estimateParseMemoryMb(2, 1_024)).toBe(4017.6);
    expect(estimateParseMemoryMb(2, 512)).toBe(2788.8);
    expect(estimateParseMemoryMb(1, 512)).toBe(1994.4);
  });
});

describe("effectiveWorkers: the worker count used when estimating memory", () => {
  const auto: SiteLimitItemDto = { key: "parseWorkers", value: 1, source: "auto", locked: false, stored: null, autoValue: 1, autoSource: "memory" };

  it("auto and the input is blank -> recomputed from the new memory limit, not the server's old autoValue", () => {
    expect(effectiveWorkers("", auto, MACHINE, 512)).toBe(2);
    expect(effectiveWorkers("", auto, { ...MACHINE, cpus: 2 }, 512)).toBe(1);
    expect(effectiveWorkers("", auto, MACHINE, 1_024)).toBe(1);
  });

  it("a valid value typed -> use the typed value; env-locked -> use the effective value", () => {
    expect(effectiveWorkers("3", auto, MACHINE, 512)).toBe(3);
    const env: SiteLimitItemDto = { key: "parseWorkers", value: 4, source: "env", locked: true, stored: null, autoValue: 1, autoSource: "memory" };
    expect(effectiveWorkers("", env, MACHINE, 512)).toBe(4);
  });

  it("an adjusted item with invalid input -> use the current effective value; cleared (= back to auto) -> recomputed from the new memory limit", () => {
    const admin: SiteLimitItemDto = { key: "parseWorkers", value: 3, source: "admin", locked: false, stored: 3, autoValue: 1, autoSource: "memory" };
    expect(effectiveWorkers("1.5", admin, MACHINE, 512)).toBe(3);
    expect(effectiveWorkers("", admin, MACHINE, 512)).toBe(2);
  });
});
