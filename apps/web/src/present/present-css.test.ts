import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COLORS_DARK_MODE_DEFAULT, COLORS_DEFAULT } from "@blocknote/core";

const css = readFileSync(`${process.cwd()}/src/present/present.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selectorStart: string): string {
  const index = css.indexOf(selectorStart);
  expect(index, selectorStart).toBeGreaterThanOrEqual(0);
  return css.slice(index, css.indexOf("}", index));
}

describe("present.css", () => {
  it("每條規則都錨在 .kn-present 或 :root.dark .kn-present 底下（不碰全域）", () => {
    const selectors = css
      .split("}")
      .map((block) => block.split("{")[0].trim())
      .filter((selector) => selector !== "")
      .flatMap((selector) => selector.split(",").map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) expect(selector, selector).toMatch(/^(\.kn-present|:root\.dark \.kn-present)\b/);
  });

  it.each(Object.keys(COLORS_DEFAULT))("色名 %s：淺色與深色的字色、底色逐值等於 BlockNote 匯出的常數（§5.3 末列）", (name) => {
    expect(rule(`.kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DEFAULT[name].text};`);
    expect(rule(`.kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DEFAULT[name].background};`);
    expect(rule(`:root.dark .kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DARK_MODE_DEFAULT[name].text};`);
    expect(rule(`:root.dark .kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DARK_MODE_DEFAULT[name].background};`);
  });

  it("無轉場規則存在（deck.ts 的 NO_TRANSITION_CLASS）", () => {
    expect(rule(".kn-present .reveal.kn-present-no-transition .slides section")).toContain("transition: none !important;");
  });

  it("E6：沒有溢出的投影片 touch-action:none（溢出的帶 data-prevent-swipe，維持瀏覽器捲動）", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id]:not([data-prevent-swipe])")).toContain("touch-action: none;");
  });
});
