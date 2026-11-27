import { describe, expect, it } from "vitest";
import { getLanguageId } from "@blocknote/core";
import type { BundledLanguage } from "shiki";
import { CODE_BLOCK_OPTIONS, SUPPORTED_LANGUAGES, createHighlighter } from "./code-highlight";

/**
 * issue #96: core contract of code-block syntax highlighting.
 *
 * These assertions run against the real shiki (not a mock): the main risk is not our logic but a language in the list that shiki
 * cannot load. `loadLanguage()` throws for a language not in the bundle (`ShikiError: Language \`x\` is not included in this bundle`),
 * and BlockNote's highlight plugin calls it lazily when the cursor enters a code block, so the failure would only be an unhandled
 * rejection in the console and highlighting silently stops. Loading every key of the list once here turns that run-time-only
 * failure into a red test.
 */

// One highlighter for the whole file: building one per test costs hundreds of ms, and the highlighter accumulates no state
// (loadLanguage only adds), so sharing does not affect test independence.
let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;
function sharedHighlighter() {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

describe("createHighlighter (css-variables theme)", () => {
  it("loads a single theme: the prosemirror-highlight parser hardcodes getLoadedThemes()[0], so loading another one in the wrong order silently changes colors", async () => {
    const hl = await sharedHighlighter();
    expect(hl.getLoadedThemes()).toHaveLength(1);
  });

  it("highlight output colors are CSS variables (var(--code-...)), not hardcoded values: light/dark switching relies on index.css changing the variable values", async () => {
    const hl = await sharedHighlighter();
    await hl.loadLanguage("typescript");
    const { fg, bg, tokens } = hl.codeToTokens('const x = "hi"; // note', {
      lang: "typescript",
      theme: hl.getLoadedThemes()[0]!,
      // A slow machine exceeding the default 500 ms stops tokenizing midway and leaves the whole line one color: a test-environment time limit, not product behavior.
      tokenizeTimeLimit: 0,
    });
    expect(fg).toBe("var(--code-foreground)");
    expect(bg).toBe("var(--code-background)");
    const colors = tokens.flat().map((t) => t.color);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^var\(--code-/);
    expect(new Set(colors).size).toBeGreaterThan(1);
  });
});

const LATEX_SAMPLE = [
  "Plain words here $x_1^2$ and \\textbf{bold}",
  "$$\\sum_{i} w_i$$",
  "\\begin{equation}",
  "a = b",
  "\\end{equation}",
  "\\[ c \\]",
].join("\n");

describe("SUPPORTED_LANGUAGES", () => {
  it("every non-plain-text language really loads (loadLanguage throws for a language outside the bundle, so a typo in the list is a silent run-time failure)", async () => {
    const hl = await sharedHighlighter();
    for (const key of Object.keys(SUPPORTED_LANGUAGES)) {
      if (key === "text") continue;
      // The cast is part of the assertion: the list keys claim to be bundled language ids; one that cannot load turns red here.
      await expect(hl.loadLanguage(key as BundledLanguage), `語言 ${key} 載入失敗`).resolves.not.toThrow();
    }
  });

  it("text (plain text) is in the list and is the default language: BlockNote skips highlighting for text, which is the user's way out", () => {
    expect(SUPPORTED_LANGUAGES.text).toBeDefined();
    expect(CODE_BLOCK_OPTIONS.defaultLanguage).toBe("text");
  });

  it("common aliases map to the right language (both ``` fences and the language dropdown use this)", () => {
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "py")).toBe("python");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "ts")).toBe("typescript");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "js")).toBe("javascript");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "sh")).toBe("bash");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "yml")).toBe("yaml");
  });

  it("latex is a language with no tex alias (the editor would color tex with shiki's separate TeX grammar while a presentation used LaTeX); math is not a code language (a math fence is a formula block, not code)", () => {
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "latex")).toBe("latex");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "tex")).toBeUndefined();
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "math")).toBeUndefined();
  });

  const MATH = "var(--code-token-constant)";
  async function latexColorOf(text: string): Promise<string | undefined> {
    const hl = await sharedHighlighter();
    await hl.loadLanguage("latex");
    const { tokens } = hl.codeToTokens(LATEX_SAMPLE, { lang: "latex", theme: hl.getLoadedThemes()[0]!, tokenizeTimeLimit: 0 });
    const hit = tokens.flat().filter((t) => t.content.includes(text));
    expect(hit.length, `no token contains ${text}`).toBeGreaterThan(0);
    expect(new Set(hit.map((t) => t.color)).size, `${text} spans several colors`).toBe(1);
    return hit[0]!.color;
  }

  it("latex math content is tokenized in the constant color (real shiki, no mock)", async () => {
    expect(await latexColorOf("x_1^2")).toBe(MATH);
    expect(await latexColorOf("\\sum_{i} w_i")).toBe(MATH);
    expect(await latexColorOf("a = b")).toBe(MATH);
    expect(await latexColorOf(" c ")).toBe(MATH);
  });

  it("latex ordinary prose and a text command's argument are not colored as math", async () => {
    expect(await latexColorOf("Plain words here")).toBe("var(--code-foreground)");
    expect(await latexColorOf("{bold}")).toBe("var(--code-foreground)");
  });

  it("CODE_BLOCK_OPTIONS wires three things together: the language list, the default language, createHighlighter", () => {
    expect(CODE_BLOCK_OPTIONS.supportedLanguages).toBe(SUPPORTED_LANGUAGES);
    expect(CODE_BLOCK_OPTIONS.createHighlighter).toBe(createHighlighter);
  });
});
