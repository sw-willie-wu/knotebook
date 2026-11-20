/** #397: `http/limiters.ts`: merging limiters, and the 9 tunable limiters read `siteLimits`. */
import { describe, expect, it } from "vitest";
import { SITE_LIMIT_KEYS, type SiteLimitKey } from "@knotebook/shared";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";
import { ADJUSTABLE_LIMITER_KEYS, buildAdjustableLimiters, buildFixedLimiters, mergeLimiters, type Limiters } from "../../src/http/limiters.js";
import { SiteLimits } from "../../src/site-limits/store.js";
import { testConfig } from "../helpers.js";

const EXPECTED_KEYS = [
  "ai", "authorize", "avatarRefresh", "bearerMiss", "collabToken", "contentRead", "dcr", "edit", "favorite", "folder", "oidcCallback", "oidcLogin",
  "oneTimeLinkAttempt", "oneTimeLinkMiss", "patCreate", "publicLink", "publicMiss", "publicNote", "publicUpload", "publicWidth",
  "register", "search", "slugPatch", "tag", "tokenEndpoint", "tokenRead", "tokenRename", "tokenWrite", "transferExport", "transferWrite",
  "upload", "userSuggest",
];

const base = (): Limiters => {
  const siteLimits = SiteLimits.defaults({ machine: testConfig.machine });
  return { ...buildFixedLimiters(), ...buildAdjustableLimiters(siteLimits) };
};

describe("mergeLimiters", () => {
  it("uses the overriding one", () => {
    const b = base();
    const mine = new FixedWindowLimiter({ limit: 3, windowMs: 60_000 });
    const merged = mergeLimiters(b, { edit: mine });
    expect(merged.edit).toBe(mine);
    expect(merged.search).toBe(b.search);
  });
  it("`{ edit: undefined }` still gives the base one", () => {
    const b = base();
    const merged = mergeLimiters(b, { edit: undefined });
    expect(merged.edit).toBe(b.edit);
  });
  it("no overrides returns base", () => {
    const b = base();
    expect(mergeLimiters(b)).toBe(b);
  });
  it("all 32 keys are present", () => {
    expect(EXPECTED_KEYS).toHaveLength(32);
    expect(Object.keys(mergeLimiters(base(), {})).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(mergeLimiters(base(), { edit: undefined })).sort()).toEqual(EXPECTED_KEYS);
  });
});

describe("tunable limiters", () => {
  it("tunable limiters read the passed siteLimits (default values)", () => {
    const adj = buildAdjustableLimiters(SiteLimits.defaults({ machine: testConfig.machine }));
    expect(adj.edit.currentLimit()).toBe(30);
    expect(adj.upload.currentLimit()).toBe(120);
    expect(adj.tokenRead.currentLimit()).toBe(300);
  });
  it("all 9 keys match the rate* entries of the registry", () => {
    expect(ADJUSTABLE_LIMITER_KEYS).toHaveLength(9);
    const adj = buildAdjustableLimiters(SiteLimits.defaults({ machine: testConfig.machine }));
    const rateKeys = SITE_LIMIT_KEYS.filter(k => k.startsWith("rate"));
    expect(rateKeys).toHaveLength(9);
    expect(Object.keys(adj).sort()).toEqual([...ADJUSTABLE_LIMITER_KEYS].sort());
  });
  it("the mapping from limiter name to registry key is pinned one by one (stub siteLimits returns a different value for each key)", () => {
    const stub = { get: (k: SiteLimitKey) => SITE_LIMIT_KEYS.indexOf(k) + 1000 } as unknown as SiteLimits;
    const adj = buildAdjustableLimiters(stub);
    const expected: Record<keyof typeof adj, SiteLimitKey> = {
      tokenRead: "rateTokenRead", tokenWrite: "rateTokenWrite", contentRead: "rateContentRead", edit: "rateEdit", search: "rateSearch",
      upload: "rateUpload", ai: "rateAi", transferExport: "rateTransferExport", transferWrite: "rateTransferWrite",
    };
    for (const name of ADJUSTABLE_LIMITER_KEYS) {
      expect(adj[name].currentLimit(), name).toBe(SITE_LIMIT_KEYS.indexOf(expected[name]) + 1000);
    }
  });
});
