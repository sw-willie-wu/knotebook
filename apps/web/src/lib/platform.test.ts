import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform } from "@/lib/platform";

afterEach(() => vi.unstubAllGlobals());

describe("isMacPlatform", () => {
  it("MacIntel -> true", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(isMacPlatform()).toBe(true);
  });
  it.each(["Win32", "Linux x86_64"])("%s -> false", (platform) => {
    vi.stubGlobal("navigator", { platform });
    expect(isMacPlatform()).toBe(false);
  });
  it("沒有 platform 欄位 -> false 且不丟錯", () => {
    vi.stubGlobal("navigator", {});
    expect(isMacPlatform()).toBe(false);
  });
  it("iPhone -> false（spec 只說 Mac；iOS 外接鍵盤顯示 Ctrl）", () => {
    vi.stubGlobal("navigator", { platform: "iPhone" });
    expect(isMacPlatform()).toBe(false);
  });
});
