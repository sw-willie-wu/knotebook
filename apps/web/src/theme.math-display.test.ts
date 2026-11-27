import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Math display rules that only a browser can apply: jsdom ignores CSS, so this guards the source text of `index.css`.
 * The real effect (computed font, mask) is checked in a browser by the e2e math spec.
 */
const raw = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replaceAll("\r\n", "\n");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const mediaStart = css.indexOf("@media (width < 40rem) {\n  .bn-editor.bn-editor [data-content-type=\"table\"] .tableWrapper {");
const phoneBlock = mediaStart < 0 ? "" : css.slice(mediaStart, css.indexOf("\n}\n", mediaStart) + 3);

/** Declarations of every rule whose selector list contains `selector` exactly (comments already stripped). */
function declarationsFor(source: string, selector: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(match[2]!);
  }
  return out;
}

/** Enclosing at-rule preludes of the first occurrence of `needle` in comment-free css, outermost first. */
function enclosing(source: string, needle: string): string[] {
  const at = source.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < at; i++) {
    if (source[i] === "{") {
      stack.push(source.slice(start, i).trim());
      start = i + 1;
    } else if (source[i] === "}") {
      stack.pop();
      start = i + 1;
    } else if (source[i] === ";") start = i + 1;
  }
  return stack;
}

describe("Chinese inside formulas uses the body font", () => {
  it("the rule is top level: not inside any @layer or @media (a layered rule would lose to KaTeX's unlayered ones)", () => {
    expect(enclosing(css, ".katex .cjk_fallback.cjk_fallback {")).toEqual([]);
  });

  it("KaTeX's own .cjk_fallback marker gets the body font (BlockNote variable, then --font-sans), with a doubled class so the later-loaded KaTeX CSS cannot tie", () => {
    const rules = declarationsFor(css, ".katex .cjk_fallback.cjk_fallback");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/font-family:\s*var\(--bn-font-family,\s*var\(--font-sans\)\);/);
  });

  it("does not restyle Latin letters or math symbols: no font-family rule on .katex or its font classes", () => {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      if (!/\.katex\b/.test(selector) && !/\.(mathnormal|textrm|mathrm|mathit|mathbf|mainrm)\b/.test(selector)) continue;
      if (/font-family/.test(match[2]!)) expect(selector).toBe(".katex .cjk_fallback.cjk_fallback");
    }
  });

  it("the fallback class is the only thing targeted; KaTeX's font files and stylesheet are not referenced here", () => {
    expect(css).not.toMatch(/@font-face[^}]*KaTeX/);
    expect(css).not.toMatch(/katex\.min\.css/);
  });
});

describe("phone right-edge hint on formulas", () => {
  const MATH = "[data-kb-math-scroll]";

  it("the mask for formulas sits in the width < 40rem block and reads the same --kb-table-fade as tables", () => {
    expect(phoneBlock).not.toBe("");
    const rules = declarationsFor(phoneBlock, MATH).filter((d) => d.includes("mask-image"));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("mask-image: linear-gradient(to right, #000 calc(100% - var(--kb-table-fade)), transparent);");
  });

  it("the formula mask's only enclosing rule is the phone media query", () => {
    expect(enclosing(css, "[data-kb-math-scroll],\n  .kn-present .kn-present-math {\n    mask-image")).toEqual(["@media (width < 40rem)"]);
  });

  it("no formula mask exists outside the phone media query (wide screens never fade)", () => {
    const outside = css.replace(phoneBlock, "");
    expect(outside).not.toContain(MATH);
  });

  it("reuses the table keyframes: one registered property and one keyframes rule, and the formula scroller is driven by its own inline scroll", () => {
    expect(css.match(/@property --kb-table-fade/g)).toHaveLength(1);
    expect(css.match(/@keyframes kb-table-fade/g)).toHaveLength(1);
    expect(phoneBlock).toMatch(
      /@supports \(animation-timeline: scroll\(self inline\)\) \{[^@]*\[data-kb-math-scroll\][^{]*\{[^}]*animation-name:\s*kb-table-fade;[^}]*animation-timeline:\s*scroll\(self inline\);/,
    );
  });

  it("without scroll-driven animation the formula scroller looks at data-kb-more-right, like tables", () => {
    expect(phoneBlock).toMatch(
      /@supports not \(animation-timeline: scroll\(self inline\)\) \{[^@]*\[data-kb-math-scroll\]\[data-kb-more-right\] \{\s*--kb-table-fade:\s*1\.5rem;/,
    );
  });

  it("presentation formula containers get the same fade (CSS-driven only)", () => {
    const rules = declarationsFor(phoneBlock, ".kn-present .kn-present-math").filter((d) => d.includes("mask-image"));
    expect(rules).toHaveLength(1);
  });
});
