import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubLayoutTier, tierForWidth } from "@/test/layout-tier";
import { isOverlay, isPhone, OVERLAY_QUERY, PHONE_QUERY, useIsOverlay, useIsPhone } from "./layout-tiers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const remOf = (query: string): number => {
  const m = /^not all and \(min-width: ([0-9.]+)rem\)$/.exec(query);
  if (m === null) throw new Error(`unexpected query: ${query}`);
  return Number(m[1]);
};

function tailwindBreakpoint(name: string): number {
  const css = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
  const m = new RegExp(`--breakpoint-${name}:\\s*([0-9.]+)rem`).exec(css);
  if (m === null) throw new Error(`--breakpoint-${name} not found`);
  return Number(m[1]);
}

describe("layout-tiers: JS queries share a boundary with the Tailwind variants", () => {
  it("index.css does not override the sm or xl breakpoint", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
    const overrides = [...css.matchAll(/--breakpoint-(sm|xl)\s*:\s*([^;]+);/g)];
    for (const [, name, value] of overrides) {
      expect(value?.trim()).toBe(`${tailwindBreakpoint(name as string)}rem`);
    }
  });

  it("PHONE_QUERY is the Tailwind sm breakpoint", () => {
    expect(remOf(PHONE_QUERY)).toBe(tailwindBreakpoint("sm"));
  });

  it("OVERLAY_QUERY is the Tailwind xl breakpoint", () => {
    expect(remOf(OVERLAY_QUERY)).toBe(tailwindBreakpoint("xl"));
  });

  it.each([
    [639, "phone"],
    [640, "overlay"],
    [1279, "overlay"],
    [1280, "docked"],
  ] as const)("width %i px is the %s tier (rem boundary at 16 px/rem)", (px, tier) => {
    expect(tierForWidth(px)).toBe(tier);
    // the query strings, evaluated at this width, agree with the stub's tier
    const rem = px / 16;
    // `not all and (min-width: Nrem)` matches when the width is below N rem
    expect(!(rem >= remOf(PHONE_QUERY))).toBe(tier === "phone");
    expect(!(rem >= remOf(OVERLAY_QUERY))).toBe(tier !== "docked");
  });
});

describe("layout-tiers: functions", () => {
  it("jsdom default (no query matches) is the docked tier", () => {
    expect(isPhone()).toBe(false);
    expect(isOverlay()).toBe(false);
  });

  it.each([
    ["phone", true, true],
    ["overlay", false, true],
    ["docked", false, false],
  ] as const)("%s tier", (tier, phone, overlay) => {
    stubLayoutTier(tier);
    expect(isPhone()).toBe(phone);
    expect(isOverlay()).toBe(overlay);
  });

  it("return false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isPhone()).toBe(false);
    expect(isOverlay()).toBe(false);
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
  });
});

describe("layout-tiers: hooks", () => {
  it("re-render when the tier flips and unsubscribe on unmount", () => {
    const stub = stubLayoutTier("docked");
    const { result, unmount } = renderHook(() => ({ phone: useIsPhone(), overlay: useIsOverlay() }));
    expect(result.current).toEqual({ phone: false, overlay: false });
    expect(stub.listenerCount(PHONE_QUERY)).toBe(1);
    expect(stub.listenerCount(OVERLAY_QUERY)).toBe(1);

    act(() => stub.setLayoutTier("overlay"));
    expect(result.current).toEqual({ phone: false, overlay: true });
    act(() => stub.setLayoutTier("phone"));
    expect(result.current).toEqual({ phone: true, overlay: true });
    act(() => stub.setLayoutTier("docked"));
    expect(result.current).toEqual({ phone: false, overlay: false });

    unmount();
    expect(stub.listenerCount(PHONE_QUERY)).toBe(0);
    expect(stub.listenerCount(OVERLAY_QUERY)).toBe(0);
  });
});

describe("layout-tiers: stub change events", () => {
  it("notifies only the queries whose result flipped", () => {
    const stub = stubLayoutTier("overlay");
    const phone = vi.fn();
    const overlay = vi.fn();
    window.matchMedia(PHONE_QUERY).addEventListener("change", phone);
    window.matchMedia(OVERLAY_QUERY).addEventListener("change", overlay);

    stub.setLayoutTier("docked");
    stub.setLayoutTier("overlay");
    expect(phone).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledTimes(2);

    overlay.mockClear();
    stub.setLayoutTier("phone");
    expect(phone).toHaveBeenCalledTimes(1);
    expect(overlay).not.toHaveBeenCalled();
  });

  it("passes the new result and the query to the listener", () => {
    const stub = stubLayoutTier("docked");
    const seen: Array<{ matches: boolean; media: string }> = [];
    window.matchMedia(OVERLAY_QUERY).addEventListener("change", (e) => {
      seen.push({ matches: (e as MediaQueryListEvent).matches, media: (e as MediaQueryListEvent).media });
    });
    stub.setLayoutTier("overlay");
    stub.setLayoutTier("docked");
    expect(seen).toEqual([
      { matches: true, media: OVERLAY_QUERY },
      { matches: false, media: OVERLAY_QUERY },
    ]);
  });
});
