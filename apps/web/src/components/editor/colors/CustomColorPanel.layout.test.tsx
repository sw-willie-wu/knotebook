import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import i18n from "@/i18n";
import { declaredContentWidth } from "@/test/color-menu-host";
import { CustomColorPanel } from "./CustomColorPanel";

// 讓 lazy 的 picker 永遠載不完，面板停在 Suspense fallback
vi.mock("./ColorfulPicker", () => new Promise(() => {}));

describe("CustomColorPanel 版面", () => {
  it("PN13 picker 還在載入時，fallback 與 react-colorful 同為 200px 寬、放得進面板", async () => {
    await i18n.changeLanguage("en");
    const { container } = render(
      <CustomColorPanel
        request={{ section: "text", target: { kind: "inline" }, current: "default", byKeyboard: false, returnTo: "x" }}
        onBack={() => {}}
        onApply={() => {}}
      />,
    );
    const panel = container.querySelector(".kb-color-panel")!;
    const fallback = container.querySelector("[data-kb-color-picker-fallback]")!;
    expect(fallback).not.toBeNull();
    expect(declaredContentWidth(fallback)).toBe(200);
    expect(fallback.classList).toContain("h-[200px]");
    expect(declaredContentWidth(panel)).toBeGreaterThanOrEqual(declaredContentWidth(fallback));
  });
});
