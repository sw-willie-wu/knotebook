import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "./index.js";
import { SITE_LIMIT_KEYS, SITE_LIMITS, siteLimitDef, siteLimitStep, type SiteLimitDef } from "./site-limits.js";

describe("site limits registry", () => {
  it("18 entries, in the same order as SITE_LIMIT_KEYS", () => {
    expect(SITE_LIMIT_KEYS).toEqual(Object.keys(SITE_LIMITS));
    expect(SITE_LIMIT_KEYS).toHaveLength(18);
  });

  it("every default is within range and aligned to the step", () => {
    for (const key of SITE_LIMIT_KEYS) {
      const d = siteLimitDef(key);
      if (d.default === "auto") continue;
      expect(d.default, key).toBeGreaterThanOrEqual(d.min);
      expect(d.default, key).toBeLessThanOrEqual(d.max);
      expect(d.default % siteLimitStep(key), key).toBe(0);
    }
  });

  it("min/max are aligned to the step, 0 <= min <= max <= 2^31-1", () => {
    for (const key of SITE_LIMIT_KEYS) {
      const d = siteLimitDef(key);
      const step = siteLimitStep(key);
      expect(d.min % step, key).toBe(0);
      expect(d.max % step, key).toBe(0);
      expect(d.min, key).toBeGreaterThanOrEqual(0);
      expect(d.min, key).toBeLessThanOrEqual(d.max);
      expect(d.max, key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it("exactly 5 have an env", () => {
    expect(SITE_LIMIT_KEYS.filter((k) => siteLimitDef(k).env)).toEqual([
      "noteMaxBytes",
      "parseWorkers",
      "parseWorkerMemoryMb",
      "parseTimeoutMs",
      "parseQueueWaitMs",
    ]);
  });

  it("siteLimitStep", () => {
    expect(siteLimitStep("uploadMaxBytes")).toBe(1_048_576);
    expect(siteLimitStep("parseTimeoutMs")).toBe(1_000);
    expect(siteLimitStep("sessionTtlSeconds")).toBe(3_600);
    expect(siteLimitStep("parseWorkerMemoryMb")).toBe(1);
    expect(siteLimitStep("rateEdit")).toBe(1);
  });

  it("only rate* has windowMs", () => {
    for (const key of SITE_LIMIT_KEYS) {
      const w = siteLimitDef(key).windowMs;
      if (key.startsWith("rate")) expect(w, key).toBeGreaterThan(0);
      else expect(w, key).toBeUndefined();
    }
  });

  it("each entry's default and range are pinned verbatim", () => {
    const expected: Record<string, SiteLimitDef> = {
    uploadMaxBytes: { type: "int", unit: "bytes", default: 10_485_760, min: 1_048_576, max: 10_485_760, category: "uploadsNotes", input: { unit: "mib", step: 1 } },
    uploadMediaMaxMib: { type: "int", unit: "mib", default: 100, min: 10, max: 1_048_576, category: "uploadsNotes", input: { unit: "mib", step: 1 } },
    noteMaxBytes: { type: "int", unit: "bytes", default: 5_242_880, min: 1_048_576, max: 5_242_880, env: "NOTE_MAX_BYTES", category: "uploadsNotes", input: { unit: "mib", step: 1 } },
    parseWorkers: { type: "int", unit: "count", default: "auto", min: 1, max: 4, env: "PARSE_WORKERS", category: "parseWorkers", input: { unit: "count", step: 1 } },
    parseWorkerMemoryMb: { type: "int", unit: "mib", default: 1_024, min: 512, max: 3_072, env: "PARSE_WORKER_MEMORY_MB", category: "parseWorkers", input: { unit: "mib", step: 1 } },
    parseTimeoutMs: { type: "int", unit: "ms", default: 10_000, min: 4_000, max: 10_000, env: "PARSE_TIMEOUT_MS", category: "parseWorkers", input: { unit: "seconds", step: 1 } },
    parseQueueWaitMs: { type: "int", unit: "ms", default: "auto", min: 5_000, max: 45_000, env: "PARSE_QUEUE_WAIT_MS", category: "parseWorkers", input: { unit: "seconds", step: 1 } },
    rateTokenRead: { type: "int", unit: "count", default: 300, min: 30, max: 300, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    rateTokenWrite: { type: "int", unit: "count", default: 60, min: 6, max: 60, category: "rateLimits", windowMs: 600_000, input: { unit: "count", step: 1 } },
    rateContentRead: { type: "int", unit: "count", default: 120, min: 12, max: 120, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    rateEdit: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    rateSearch: { type: "int", unit: "count", default: 60, min: 6, max: 60, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    rateUpload: { type: "int", unit: "count", default: 120, min: 12, max: 120, category: "rateLimits", windowMs: 600_000, input: { unit: "count", step: 1 } },
    rateAi: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    rateTransferExport: { type: "int", unit: "count", default: 10, min: 1, max: 10, category: "rateLimits", windowMs: 3_600_000, input: { unit: "count", step: 1 } },
    rateTransferWrite: { type: "int", unit: "count", default: 30, min: 3, max: 30, category: "rateLimits", windowMs: 60_000, input: { unit: "count", step: 1 } },
    sessionTtlSeconds: { type: "int", unit: "seconds", default: 604_800, min: 3_600, max: 2_592_000, category: "signIn", input: { unit: "hours", step: 1 } },
    apiTokensPerUser: { type: "int", unit: "count", default: 20, min: 1, max: 20, category: "signIn", input: { unit: "count", step: 1 } },
    };
    expect(SITE_LIMITS).toEqual(expected);
  });

  it("siteLimitStep throws for a unit pairing not in the allow table", () => {
    const real = SITE_LIMITS.rateEdit;
    const mutable = SITE_LIMITS as unknown as Record<string, { input: { unit: string; step: number } }>;
    const saved = mutable.rateEdit!.input;
    try {
      mutable.rateEdit!.input = { unit: "hours", step: 1 };
      expect(() => siteLimitStep("rateEdit")).toThrow(/unsupported unit pair count\/hours/);
    } finally {
      mutable.rateEdit!.input = saved;
    }
    expect(real.input.unit).toBe("count");
  });

  it("MAX_UPLOAD_BYTES equals the registry default", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10_485_760);
    expect(MAX_UPLOAD_BYTES).toBe(SITE_LIMITS.uploadMaxBytes.default);
  });
});
