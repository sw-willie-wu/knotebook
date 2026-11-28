import { describe, expect, it } from "vitest";
import type { SiteLimits } from "../../src/site-limits/store.js";
import { uploadDrainCap } from "../../src/routes/uploads.js";
import { remainingRoom, type SpaceUsage } from "../../src/storage/usage.js";

const usage = (usedBytes: number, quotaBytes: number | null): SpaceUsage => ({ usedBytes, quotaBytes, planId: "p", planName: "Plan" });

describe("remainingRoom", () => {
  it("no usage row or no storage limit -> null", () => {
    expect(remainingRoom(null)).toBeNull();
    expect(remainingRoom(usage(5, null))).toBeNull();
  });

  it("quota minus used; exactly full is 0 and over quota is negative", () => {
    expect(remainingRoom(usage(400, 1000))).toBe(600);
    expect(remainingRoom(usage(1000, 1000))).toBe(0);
    expect(remainingRoom(usage(1200, 1000))).toBe(-200);
  });
});

describe("uploadDrainCap", () => {
  const limits = (uploadMaxBytes: number, uploadMediaMaxMib: number): SiteLimits =>
    ({ get: (k: string) => (k === "uploadMaxBytes" ? uploadMaxBytes : uploadMediaMaxMib) }) as unknown as SiteLimits;

  it("twice the larger of the live document and media limits", () => {
    expect(uploadDrainCap(limits(10 * 1_048_576, 100))).toBe(2 * 100 * 1_048_576);
    expect(uploadDrainCap(limits(10 * 1_048_576, 4))).toBe(2 * 10 * 1_048_576);
  });
});
