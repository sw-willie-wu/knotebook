import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRevealConfig, configMatches, htmlHasPrintClasses, LOCKED_CONFIG_KEYS } from "./reveal-config";

const handlers = { onEsc: vi.fn(), onF: vi.fn(), onO: vi.fn() };

describe("buildRevealConfig（A3 逐鍵）", () => {
  it("鎖定值逐字照 spec A3", () => {
    const config = buildRevealConfig(handlers);
    expect(config).toMatchObject({
      embedded: true, disableLayout: true, hash: false, history: false, respondToHashChanges: false,
      postMessage: false, postMessageEvents: false, previewLinks: false, view: null, parallaxBackgroundImage: "",
      autoSlide: 0, pause: false, help: false, jumpToSlide: false, focusBodyOnPageVisibilityChange: false,
      controls: true, progress: true, overview: true,
    });
    expect(Object.keys(config.keyboard as object).sort()).toEqual(["27", "70", "79"]);
    expect((config.keyboard as Record<number, unknown>)[27]).toBe(handlers.onEsc);
    expect((config.keyboard as Record<number, unknown>)[70]).toBe(handlers.onF);
    expect((config.keyboard as Record<number, unknown>)[79]).toBe(handlers.onO);
  });

  it("LOCKED_CONFIG_KEYS＝A3 的全部鍵（§6.4-3）", () => {
    expect([...LOCKED_CONFIG_KEYS].sort()).toEqual(Object.keys(buildRevealConfig(handlers)).sort());
  });

  it.each([
    [{ altKey: true }, false], [{ ctrlKey: true }, false], [{ metaKey: true }, false], [{ shiftKey: true }, true], [{}, true],
  ])("keyboardCondition(%j) → %s（Alt／Ctrl／Meta 一律不處理，§2.11-4 的 Alt 漏洞）", (init, expected) => {
    const condition = buildRevealConfig(handlers).keyboardCondition as (event: KeyboardEvent) => boolean;
    expect(condition(new KeyboardEvent("keydown", init))).toBe(expected);
  });
});

describe("configMatches（§6.4-3：getConfig() 逐鍵核對）", () => {
  it("同一份 → true", () => {
    const config = buildRevealConfig(handlers);
    expect(configMatches({ ...config, unrelated: 1 }, config)).toBe(true);
  });

  it.each(LOCKED_CONFIG_KEYS)("鍵 %s 被改掉 → false", (key) => {
    const config = buildRevealConfig(handlers);
    const tampered = { ...config, [key]: key === "keyboard" ? { ...(config.keyboard as object) } : "tampered" };
    expect(configMatches(tampered, config)).toBe(false);
  });
});

describe("htmlHasPrintClasses", () => {
  afterEach(() => document.documentElement.classList.remove("reveal-print", "print-pdf", "reveal-full-page"));
  it.each(["reveal-print", "print-pdf", "reveal-full-page"])("<html> 有 %s → true", (cls) => {
    expect(htmlHasPrintClasses()).toBe(false);
    document.documentElement.classList.add(cls);
    expect(htmlHasPrintClasses()).toBe(true);
  });
});
