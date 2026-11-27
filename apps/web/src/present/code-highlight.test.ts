import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHighlighter } from "@/lib/code-highlight";
import {
  applyHighlightTokens,
  cachedCodeTokens,
  CODE_HIGHLIGHT_CACHE_LIMIT,
  resetCodeHighlightForTests,
  resolveHighlightLanguage,
  tokenizeCode,
} from "./code-highlight";

vi.mock("@/lib/code-highlight", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/code-highlight")>();
  return { ...real, createHighlighter: vi.fn(real.createHighlighter) };
});

describe("resolveHighlightLanguage", () => {
  it("resolves canonical language names and aliases case-insensitively", () => {
    expect(resolveHighlightLanguage("typescript")).toBe("typescript");
    expect(resolveHighlightLanguage("ts")).toBe("typescript");
    expect(resolveHighlightLanguage("TS")).toBe("typescript");
    expect(resolveHighlightLanguage("py")).toBe("python");
    expect(resolveHighlightLanguage("sh")).toBe("bash");
    expect(resolveHighlightLanguage("yml")).toBe("yaml");
    expect(resolveHighlightLanguage("c++")).toBe("cpp");
    expect(resolveHighlightLanguage("c#")).toBe("csharp");
    expect(resolveHighlightLanguage("dockerfile")).toBe("docker");
    expect(resolveHighlightLanguage("latex")).toBe("latex");
    expect(resolveHighlightLanguage("LaTeX")).toBe("latex");
  });

  it("returns null for plain text, empty, or unsupported languages", () => {
    expect(resolveHighlightLanguage("text")).toBeNull();
    expect(resolveHighlightLanguage("txt")).toBeNull();
    expect(resolveHighlightLanguage("plaintext")).toBeNull();
    expect(resolveHighlightLanguage("")).toBeNull();
    expect(resolveHighlightLanguage("   ")).toBeNull();
    expect(resolveHighlightLanguage(null)).toBeNull();
    expect(resolveHighlightLanguage(undefined)).toBeNull();
    expect(resolveHighlightLanguage("mermaid")).toBeNull();
    expect(resolveHighlightLanguage("math")).toBeNull();
    expect(resolveHighlightLanguage("tex")).toBeNull();
    expect(resolveHighlightLanguage("nonexistent-lang")).toBeNull();
  });
});

describe("applyHighlightTokens", () => {
  it("builds spans with textContent and CSSOM styles, preserves newlines, and never interprets HTML", () => {
    const code = document.createElement("code");
    applyHighlightTokens(code, [
      [
        { content: "const ", color: "var(--code-token-keyword)", fontStyle: 0 },
        { content: "<img src=x onerror=alert(1)>", color: "var(--code-token-string)", fontStyle: 1 },
      ],
      [
        { content: "<script>alert(1)</script>", color: "var(--code-token-comment)", fontStyle: 2 | 4 | 8 },
      ],
      [
        { content: "plain", color: "var(--code-foreground)", fontStyle: -1 },
      ],
    ]);

    expect(code.querySelector("img, script")).toBeNull();
    expect(code.textContent).toBe("const <img src=x onerror=alert(1)>\n<script>alert(1)</script>\nplain");
    const spans = Array.from(code.querySelectorAll("span"));
    expect(spans).toHaveLength(4);
    expect(spans[0]!.style.color).toBe("var(--code-token-keyword)");
    expect(spans[0]!.style.fontStyle).toBe("");
    expect(spans[1]!.style.color).toBe("var(--code-token-string)");
    expect(spans[1]!.style.fontStyle).toBe("italic");
    expect(spans[2]!.style.fontWeight).toBe("bold");
    expect(spans[2]!.style.textDecoration).toBe("underline line-through");
    // TextMate FontStyle.NotSet (-1) must not trigger italic/bold bits.
    expect(spans[3]!.style.fontStyle).toBe("");
    expect(spans[3]!.style.fontWeight).toBe("");
    expect(spans[3]!.style.textDecoration).toBe("");
  });
});

describe("tokenizeCode & caching", () => {
  beforeEach(() => {
    resetCodeHighlightForTests();
    vi.mocked(createHighlighter).mockClear();
  });

  it("never loads shiki for plain text, unsupported languages, or blank code", async () => {
    expect(await tokenizeCode("text", "const x = 1;")).toBeNull();
    expect(await tokenizeCode("mermaid", "graph TD")).toBeNull();
    expect(await tokenizeCode("unknown", "abc")).toBeNull();
    expect(await tokenizeCode("typescript", "   \n  ")).toBeNull();
    expect(createHighlighter).not.toHaveBeenCalled();
  });

  it("tokenizes with the CSS-variables theme, shares one highlighter instance, and caches by canonical language + source", async () => {
    const first = await tokenizeCode("ts", 'const x = "hi";');
    expect(first).not.toBeNull();
    const colors = first!.flat().map((t) => t.color).filter(Boolean);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^var\(--code-/);
    expect(new Set(colors).size).toBeGreaterThan(1);

    // Alias and canonical id share one cache entry; synchronous cache lookup succeeds without re-running shiki.
    expect(cachedCodeTokens("typescript", 'const x = "hi";')).toEqual(first);
    expect(await tokenizeCode("typescript", 'const x = "hi";')).toEqual(first);
    expect(createHighlighter).toHaveBeenCalledTimes(1);

    // Second language reuses the same singleton highlighter.
    const py = await tokenizeCode("py", "def f():\n  return 1");
    expect(py).toHaveLength(2);
    expect(createHighlighter).toHaveBeenCalledTimes(1);
  });

  it("colors latex math in the constant color for the presentation and leaves plain prose in the foreground color", async () => {
    const lines = await tokenizeCode("latex", "Plain words $x_1^2$");
    expect(lines).not.toBeNull();
    const tokens = lines!.flat();
    expect(tokens.find((t) => t.content.includes("x_1^2"))?.color).toBe("var(--code-token-constant)");
    expect(tokens.find((t) => t.content.includes("Plain words"))?.color).toBe("var(--code-foreground)");
    expect(cachedCodeTokens("latex", "Plain words $x_1^2$")).toEqual(lines);
  });

  it("recovers after a transient highlighter load failure without caching the failure", async () => {
    vi.mocked(createHighlighter).mockRejectedValueOnce(new Error("chunk load failed"));
    expect(await tokenizeCode("ts", "const a = 1;")).toBeNull();
    expect(cachedCodeTokens("ts", "const a = 1;")).toBeNull();

    const recovered = await tokenizeCode("ts", "const a = 1;");
    expect(recovered).not.toBeNull();
    expect(createHighlighter).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry once the cache exceeds CODE_HIGHLIGHT_CACHE_LIMIT", async () => {
    const fakeHl = {
      getLoadedLanguages: () => ["typescript"],
      loadLanguage: vi.fn(async () => {}),
      getLoadedThemes: () => ["knotebook-code"],
      codeToTokens: vi.fn((code: string) => ({
        tokens: [[{ content: code, color: "var(--code-foreground)", fontStyle: 0 }]],
      })),
    };
    vi.mocked(createHighlighter).mockResolvedValueOnce(fakeHl as never);

    for (let i = 0; i < CODE_HIGHLIGHT_CACHE_LIMIT; i += 1) {
      await tokenizeCode("typescript", `const v${i} = ${i};`);
    }
    // Touch entry 0 so entry 1 becomes the oldest.
    expect(cachedCodeTokens("typescript", "const v0 = 0;")).not.toBeNull();

    await tokenizeCode("typescript", "const extra = 999;");
    expect(cachedCodeTokens("typescript", "const v0 = 0;")).not.toBeNull();
    expect(cachedCodeTokens("typescript", "const v1 = 1;")).toBeNull();
    expect(cachedCodeTokens("typescript", "const extra = 999;")).not.toBeNull();
  });
});
