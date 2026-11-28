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
  it("every rule is anchored under .kn-present or :root.dark .kn-present (touches nothing global)", () => {
    // The `@media (...) {` wrapper isn't a selector; with it stripped, the rules inside must still be anchored under .kn-present.
    const selectors = css
      .replace(/@media[^{]*\{/g, "")
      .split("}")
      .map((block) => block.split("{")[0].trim())
      .filter((selector) => selector !== "")
      .flatMap((selector) => selector.split(",").map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) expect(selector, selector).toMatch(/^(\.kn-present|:root\.dark \.kn-present)\b/);
  });

  it.each(Object.keys(COLORS_DEFAULT))("color name %s: light and dark text and background colors equal BlockNote's exported constants value by value", (name) => {
    expect(rule(`.kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DEFAULT[name].text};`);
    expect(rule(`.kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DEFAULT[name].background};`);
    expect(rule(`:root.dark .kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DARK_MODE_DEFAULT[name].text};`);
    expect(rule(`:root.dark .kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DARK_MODE_DEFAULT[name].background};`);
  });

  it("phone (width < 40rem): slide H1 / H2 / H3 shrink and remain h1 > h2 > h3, written after the desktop rules so they override", () => {
    const phone = css.match(/@media \(width < 40rem\) \{\s*\.kn-present \.kn-slide-body h1 \{[^@]*?\n\}/);
    expect(phone).not.toBeNull();
    const size = (h: string) => Number(new RegExp(`\\.kn-slide-body ${h} \\{ font-size: ([\\d.]+)em;`).exec(phone![0])?.[1]);
    expect(size("h1")).toBe(1.75);
    expect(size("h2")).toBe(1.5);
    expect(size("h3")).toBe(1.25);
    expect(size("h1")).toBeGreaterThan(size("h2"));
    expect(size("h2")).toBeGreaterThan(size("h3"));
    // The desktop h4 is 1.2em: the phone h3 must still be larger than it.
    expect(size("h3")).toBeGreaterThan(1.2);
    for (const h of ["h1", "h2", "h3"]) {
      expect(css.indexOf(phone![0])).toBeGreaterThan(css.indexOf(`.kn-present .kn-slide-body ${h} { font-size: `));
    }
  });

  it("no transition rule exists (NO_TRANSITION_CLASS in deck.ts)", () => {
    expect(rule(".kn-present .reveal.kn-present-no-transition .slides section")).toContain("transition: none !important;");
  });

  it("the .reveal ancestor adds pinch-zoom to reveal's embedded pan-y / vertical-slide none, otherwise the intersection cancels the slides' pinch-zoom (#235)", () => {
    expect(rule(".kn-present .reveal.embedded {")).toContain("touch-action: pan-y pinch-zoom;");
    expect(rule(".kn-present .reveal.embedded.is-vertical-slide {")).toContain("touch-action: pinch-zoom;");
  });

  it("non-overflowing slides get touch-action:pinch-zoom (no pan, so swipes reach reveal; two-finger zoom stays on, #235; overflowing ones carry data-prevent-swipe to keep browser scrolling)", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id]:not([data-prevent-swipe])")).toContain("touch-action: pinch-zoom;");
  });

  it("columns: a stacked row is display:block !important with row gap 24px !important (overrides the canonical inline style)", () => {
    expect(rule(".kn-present .kn-slide-body [data-kb-columns][data-stacked] {")).toContain("display: block !important;");
    expect(rule(".kn-present .kn-slide-body [data-kb-columns] {")).toContain("gap: 24px !important;");
  });

  it("a <pre> that doesn't overflow horizontally inside a non-overflowing slide also gets touch-action:pinch-zoom (<pre> is a scroll container; otherwise a swipe starting on short code wouldn't change slides)", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id]:not([data-prevent-swipe]) pre:not([data-prevent-swipe])")).toContain("touch-action: pinch-zoom;");
  });

  it("overflowing slides and their non-overflowing <pre> get touch-action:pan-y pinch-zoom so vertical scrolling and pinch-zoom stay native while overflow-swipe handles horizontal swipes (#573)", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id][data-prevent-swipe] {")).toContain("touch-action: pan-y pinch-zoom;");
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id][data-prevent-swipe] pre:not([data-prevent-swipe])")).toContain("touch-action: pan-y pinch-zoom;");
  });
});
